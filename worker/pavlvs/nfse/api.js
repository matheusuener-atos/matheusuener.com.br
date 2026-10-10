// A API do emissor da nuvem, ligada ao painel admin em /api/admin/nfse/emissor/*
// (worker/admin.js, contrato em worker/admin-api.md, "Notas fiscais").
// atenderEmissor NÃO autentica nada sozinho: quem chama (admin.js) já passou
// pelo Cloudflare Access e pela sessão do GitHub e conferiu o papel (dono e
// financeiro emitem e configuram; suporte só lê, GET).
//
// Rotas (relativas ao prefixo):
//   GET  situacao                       configuração, certificado, município, pode_emitir, cloudflare
//   POST prestador {prestador}          grava uma versão nova da configuração
//   POST certificado {certPem, cadeiaPem, chavePkcs8, titular, documento, validoAte}
//                                       o .pfx aberto NO NAVEGADOR (nunca vem inteiro); guarda
//                                       cifrado no DO e cadastra o mTLS na Cloudflare (mtls.js)
//   POST cloudflare {token}             o token de API da Cloudflare (cifrado no KV; "" apaga)
//   POST testar                         certificado, conexão com a Sefin e convênio, com o tempo
//   GET  municipios?q=<nome>&uf=<UF>    até 12 {codigo, nome, uf}: sem acento, por começo de
//                                       palavra; 7 dígitos acham pelo código IBGE
//   GET  clientes                       os assinantes com o tomador e o que falta
//   POST clientes/:conta {tomador}      o ajuste do tomador
//   POST notas {conta?, pagamento?, tomador, valor | valor_centavos, descricao, competencia}
//   GET  notas?estado=&limite=          a lista
//   GET  notas/:id                      a nota, os passos e os eventos
//   GET  notas/:id/xml?tipo=nfse|dps    o XML (application/xml)
//   GET  notas/:id/pdf[?baixar=1]       o DANFSe (gera na hora se ainda não existe)
//   POST notas/:id/enviar               entrega ao app do cliente (e e-mail, com "mail" ligado)
//   POST notas/:id/tentar               de novo (consulta antes de reenviar)
//   POST notas/:id/descartar            rejeitada: devolve o número
//   POST notas/:id/cancelar {motivo, texto}
//   POST notas/:id/substituir {motivo, texto, ajustes: {tomador?, valor?, descricao?, competencia?}}
//   POST notas/:id/situacao             consulta os eventos da nota (cancelada por ofício...)
//   POST notas/:id/depois               PDF + e-mail em segundo plano (ctx.waitUntil), 202
//   POST fila                           processa a fila agora (o alarme do DO faz sozinho)
//   POST producao/liberar  /  POST producao/voltar
//
// O PDF e o e-mail ficam FORA do pedido que emite: o DANFSe (pdf-lib, ~1,5 ms
// quente, mais na 1ª chamada do isolate) somado à emissão passaria dos 10 ms
// do plano grátis. A tela
// chama POST notas/:id/depois logo depois de receber a nota emitida; o que
// sobrar (emissão automática, nota que saiu da fila) o Cron de cada minuto
// faz (depoisPendentes).

import { b64 } from "./assinatura.js";
import { deB64 } from "./cofre.js";
import { gerarDanfse } from "./danfse.js";
import { idNoCliente, K_DEPOIS } from "./emissor.js";
import { buscarMunicipios } from "./tabelas.js";
import { guardarTokenCf, instalarMtls, K_CADEIA, mtlsEhDeste, situacaoCf } from "./mtls.js";
import {
  clienteDaConta, faltasDoTomador, gravarTomador, listarClientes, listarPagamentos, mandarNotaPorEmail, marcarPagamento,
} from "../nfse-casa.js";
import { contasDaCasa } from "../admin.js";

export const PREFIXO = "/api/admin/nfse/emissor/";
const K_PDF = "admin:nfse-pdf:";

export function emissorDe(env) {
  if (!env.EMISSOR_NFSE) throw new Error("falta o Durable Object EMISSOR_NFSE");
  return env.EMISSOR_NFSE.get(env.EMISSOR_NFSE.idFromName("pavlvs"));
}

/** O que falta para o emissor funcionar ("" quando está tudo). */
export function faltaDoEmissor(env) {
  if (!env.APOIOS) return "falta o KV APOIOS";
  if (!env.EMISSOR_NFSE) return "falta o Durable Object EMISSOR_NFSE";
  // Na Atos (09/10/2026) o EmissorNFSe ainda e do Worker "paulus" (binding com script_name): quem decifra o
  // certificado e ele, com a NFSE_CHAVE_MESTRA de la. EMISSOR_NO_PAVLVS "1" diz isso, e a chave nao e pedida aqui.
  if (!env.NFSE_CHAVE_MESTRA && env.EMISSOR_NO_PAVLVS !== "1") return "falta o segredo NFSE_CHAVE_MESTRA (npx wrangler secret put NFSE_CHAVE_MESTRA; gere com openssl rand -base64 32)";
  return "";
}

/** Chama uma ação do DO: {status, dados}. */
export async function chamar(env, acao, dados = {}) {
  const r = await emissorDe(env).fetch("https://emissor-nfse/" + acao, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ acao, dados }),
  });
  return { status: r.status, dados: await r.json() };
}

function json(dados, status = 200) {
  return new Response(JSON.stringify(dados), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

async function kvJSON(env, chave, padrao = null) {
  try {
    const v = await env.APOIOS.get(chave);
    return v ? JSON.parse(v) : padrao;
  } catch {
    return padrao;
  }
}

export async function configNfse(env) {
  const c = (await kvJSON(env, "admin:nfse:config", {})) || {};
  return { auto: Boolean(c.auto), email: Boolean(c.email), mail: Boolean(c.mail) };
}

const nomeArquivo = (t) => String(t || "").replace(/[^A-Za-z0-9 ._-]/g, "");

/**
 * request: o pedido HTTP; opcoes.quem: o e-mail de quem pede (vem da
 * autenticação do painel); opcoes.prefixo.
 */
export async function atenderEmissor(request, env, ctx, { quem = "PAVLVS", prefixo = PREFIXO } = {}) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(prefixo)) return json({ erro: "rota não existe" }, 404);
  const p = url.pathname.slice(prefixo.length).replace(/\/+$/, "");
  const m = request.method;
  let corpo = {};
  if (m === "POST") {
    try {
      const t = await request.text();
      corpo = t ? JSON.parse(t) : {};
    } catch {
      return json({ erro: "pedido inválido" }, 400);
    }
    if (!corpo || typeof corpo !== "object" || Array.isArray(corpo)) return json({ erro: "pedido inválido" }, 400);
  }
  const via = async (acao, dados) => {
    const r = await chamar(env, acao, dados);
    return json(r.dados, r.status);
  };
  try {
    if (m === "GET" && p === "situacao") {
      const r = await chamar(env, "situacao", {});
      if (r.status !== 200) return json(r.dados, r.status);
      return json({ ...r.dados, cloudflare: await situacaoCf(env), config: await configNfse(env) });
    }
    if (m === "POST" && p === "prestador") return via("configurar", { prestador: corpo.prestador, quem, motivo: corpo.motivo || "" });
    if (m === "POST" && p === "certificado") return json(...(await receberCertificado(env, corpo, quem)));
    if (m === "POST" && p === "cloudflare") return json(...(await receberTokenCf(env, corpo)));
    if (m === "POST" && p === "testar") return json(await testar(env));
    if (m === "GET" && p === "municipios") {
      const q = String(url.searchParams.get("q") || "").slice(0, 80);
      return json({ municipios: buscarMunicipios(q, String(url.searchParams.get("uf") || "").slice(0, 2), 12) });
    }
    if (m === "GET" && p === "clientes") return json({ clientes: await listarClientes(env) });
    let r = p.match(/^clientes\/([0-9a-f]{24})$/);
    if (r && m === "POST") {
      const g = await gravarTomador(env, r[1], corpo.tomador);
      return json(g.corpo, g.status);
    }
    if (m === "POST" && p === "notas") return via("emitir", { ...corpo, quem });
    if (m === "GET" && p === "notas") return via("listar", { estado: url.searchParams.get("estado") || "", limite: url.searchParams.get("limite") || 300 });
    if (m === "POST" && p === "fila") return via("fila", { quem });
    if (m === "POST" && p === "producao/liberar") return via("liberar_producao", { quem });
    if (m === "POST" && p === "producao/voltar") return via("voltar_testes", { quem });
    r = p.match(/^notas\/(\d{1,12})(?:\/([a-z]+))?$/);
    if (r) {
      const id = Number(r[1]);
      const sub = r[2] || "";
      if (m === "GET" && !sub) return via("nota", { id });
      if (m === "GET" && sub === "xml") {
        const x = await chamar(env, "xml", { id, tipo: url.searchParams.get("tipo") === "dps" ? "dps" : "nfse" });
        if (x.status !== 200) return json(x.dados, x.status);
        return new Response(x.dados.xml, { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "no-store",
          "content-disposition": `attachment; filename="${nomeArquivo(x.dados.nome)}"` } });
      }
      if (m === "GET" && sub === "pdf") {
        const pdf = await pdfDaNota(env, id);
        if (pdf.erro) return json({ erro: pdf.erro }, pdf.status || 409);
        return new Response(deB64(pdf.b64), { headers: { "content-type": "application/pdf", "cache-control": "no-store",
          "content-disposition": `${url.searchParams.get("baixar") ? "attachment" : "inline"}; filename="${nomeArquivo("NFS-e " + (pdf.numero || id))}.pdf"` } });
      }
      if (m === "POST" && sub === "enviar") return json(...(await enviarAoCliente(env, id, quem)));
      if (m === "POST" && sub === "tentar") return via("tentar", { id, quem });
      if (m === "POST" && sub === "descartar") return via("descartar", { id, quem });
      if (m === "POST" && sub === "cancelar") return via("cancelar", { id, motivo: corpo.motivo, texto: corpo.texto, quem });
      if (m === "POST" && sub === "substituir") return via("substituir", { id, motivo: corpo.motivo, texto: corpo.texto, ajustes: corpo.ajustes || {}, quem });
      if (m === "POST" && sub === "situacao") return via("atualizar_situacao", { id, quem });
      if (m === "POST" && sub === "depois") {
        const trabalho = depoisDeEmitir(env, id);
        if (ctx && ctx.waitUntil) ctx.waitUntil(trabalho.catch(() => {}));
        else await trabalho;
        return json({ ok: true, agendado: true }, 202);
      }
    }
    return json({ erro: "rota não existe" }, 404);
  } catch (e) {
    return json({ erro: String((e && e.message) || e).slice(0, 300) }, 500);
  }
}

// ------------------------------------------------------------ certificado

/**
 * O .pfx foi aberto no navegador (site/assets/nfse-pfx.js): chegam o
 * certificado (PEM), a cadeia, a chave (PKCS#8 em base64), o titular, o
 * documento e a validade. 1) o DO confere o par e guarda cifrado; 2) com o
 * token da Cloudflare, o mTLS é cadastrado e o auxiliar republicado.
 * Devolve [corpo, status].
 */
async function receberCertificado(env, corpo, quem) {
  const certificado = corpo.certPem || corpo.certificado;
  const chave = corpo.chavePkcs8 || corpo.chave;
  if (!certificado || !chave) return [{ erro: "mande o certificado e a chave (o .pfx é aberto no navegador)" }, 400];
  const g = await chamar(env, "certificado", { certificado, chave, titular: corpo.titular || "", documento: corpo.documento || "",
    algoritmo: corpo.algoritmo || "sha1", quem });
  if (g.status !== 200) return [g.dados, g.status];
  const cadeia = (Array.isArray(corpo.cadeiaPem) ? corpo.cadeiaPem : [corpo.cadeiaPem]).filter((x) => typeof x === "string" && x.includes("BEGIN CERTIFICATE")).slice(0, 5);
  await env.APOIOS.put(K_CADEIA, JSON.stringify(cadeia));
  const cert = g.dados;
  const conexao = await ligarMtls(env, { certPem: certificado, cadeiaPem: cadeia, chavePkcs8: String(chave), documento: cert.documento, validoAte: cert.valido_ate });
  return [{ certificado: cert, conexao, cloudflare: await situacaoCf(env) }, 200];
}

async function ligarMtls(env, par) {
  const r = await instalarMtls(env, par);
  if (r.ok) return { ok: true, certificate_id: r.certificate_id, aviso: r.aviso || "", frase: "Certificado cadastrado na Cloudflare: a conexão com a Sefin usa este certificado." };
  if (r.falta_token) {
    return { ok: false, falta_token: true, frase: "O certificado foi guardado, mas a conexão com a Sefin ainda não usa ele: falta o token da Cloudflare (Parâmetros › Token da Cloudflare). Com o token gravado, o cadastro sai sozinho." };
  }
  if (r.etapa === "configuração" || r.etapa === "token") return { ok: false, etapa: r.etapa, erro: r.erro, frase: "O certificado foi guardado, mas a conexão com a Sefin ainda não usa ele: " + r.erro + "." };
  return { ok: false, etapa: r.etapa, erro: r.erro, frase: "O certificado foi guardado, mas não consegui " + r.etapa + ": " + r.erro + "." };
}

/** O token da Cloudflare; com ele, cadastra o mTLS do certificado que já está guardado. */
async function receberTokenCf(env, corpo) {
  if (!("token" in corpo)) return [{ erro: "mande o token" }, 400];
  const g = await guardarTokenCf(env, corpo.token);
  if (g.erro) return [{ erro: g.erro }, 400];
  let conexao = null;
  if (g.token) {
    const s = await chamar(env, "situacao", {});
    const cert = s.status === 200 ? s.dados.certificado : null;
    if (cert && cert.instalado && !(await mtlsEhDeste(env, cert))) {
      const par = await chamar(env, "par_para_mtls", {});
      if (par.status === 200) {
        const cadeia = (await kvJSON(env, K_CADEIA, [])) || [];
        conexao = await ligarMtls(env, { certPem: par.dados.certPem, chavePem: par.dados.chavePem, cadeiaPem: cadeia,
          documento: par.dados.documento, validoAte: par.dados.valido_ate });
      }
    }
  }
  return [{ cloudflare: await situacaoCf(env), conexao }, 200];
}

// ------------------------------------------------------------ testar

/** Três etapas, cada uma com ok, detalhe e o tempo: certificado, conexão com a Sefin, convênio. */
async function testar(env) {
  const etapas = [];
  const s = await chamar(env, "situacao", {});
  const cert = s.status === 200 ? s.dados.certificado || {} : {};
  if (!cert.instalado) etapas.push({ titulo: "Certificado", ok: false, detalhe: "nenhum certificado instalado" });
  else if (cert.vencido) etapas.push({ titulo: "Certificado", ok: false, detalhe: "venceu em " + String(cert.valido_ate).slice(0, 10).split("-").reverse().join("/") });
  else etapas.push({ titulo: "Certificado", ok: true, detalhe: (cert.titular || "") + " · vence em " + cert.dias_restantes + " dias" });
  const inicio = Date.now();
  const t = await chamar(env, "testar", {});
  const ms = Date.now() - inicio;
  if (t.status !== 200) {
    etapas.push({ titulo: "Conexão com a Sefin", ok: false, detalhe: t.dados.erro || "HTTP " + t.status, ms });
    etapas.push({ titulo: "Convênio do município", ok: false, detalhe: "não consultado" });
  } else {
    const mun = t.dados.municipio || {};
    const respondeu = t.dados.status > 0;
    const tempo = t.dados.ms != null ? t.dados.ms : ms;
    const cf = respondeu ? null : await situacaoCf(env);
    etapas.push({ titulo: "Conexão com a Sefin", ok: respondeu, ms: tempo,
      detalhe: respondeu ? "respondeu HTTP " + t.dados.status + " em " + tempo + " ms (" + (t.dados.ambiente === "producao" ? "produção" : "produção restrita") + ")"
        : (mun.detalhes || "sem resposta") + (cf && cf.falta ? " · " + cf.falta : "") });
    etapas.push({ titulo: "Convênio do município", ok: mun.situacao === "conveniado", detalhe: mun.frase || "" });
  }
  return { ok: etapas.every((e) => e.ok), etapas, municipio: t.status === 200 ? t.dados.municipio : null, quando: new Date().toISOString() };
}

// ------------------------------------------------------------ PDF, envio e e-mail

/** Monta o DANFSe da nota emitida: {b64, nota, xml} ou {erro, status}. */
async function montarPdf(env, id) {
  const r = await chamar(env, "para_pdf", { id });
  if (r.status !== 200) return { erro: r.dados.erro, status: r.status };
  const { nota, xml_nfse: xml } = r.dados;
  if (!["emitida", "cancelada", "substituida"].includes(nota.estado)) return { erro: "a nota ainda não foi emitida", status: 409 };
  if (!xml) return { erro: "a nota não tem o XML da NFS-e", status: 409 };
  // O DANFSe no leiaute da NT 008, tirado só do XML (danfse.js, porte do PAULUS).
  const pdf = await gerarDanfse(xml);
  return { b64: b64(pdf), bytes: pdf.length, nota, xml };
}

/** O PDF guardado (admin:nfse-pdf:<id>) ou, se ainda não existe, gerado agora. */
export async function pdfDaNota(env, id) {
  const guardado = await env.APOIOS.get(K_PDF + id);
  if (guardado) {
    const n = await chamar(env, "nota", { id });
    return { b64: guardado, numero: n.status === 200 ? n.dados.nota.numero : "" };
  }
  const p = await montarPdf(env, id);
  if (p.erro) return p;
  await env.APOIOS.put(K_PDF + id, p.b64);
  return { b64: p.b64, numero: p.nota.numero, gerado: true };
}

function metaDoEmail(nota) {
  return { id: idNoCliente(nota.id), conta: nota.conta, numero: nota.numero, valor: Number(nota.centavos || 0) / 100,
    competencia: nota.competencia, ambiente: nota.ambiente };
}

/**
 * Depois de emitida, num pedido SEPARADO: o DANFSe vai para
 * admin:nfse-pdf:<id> e, se a nota já está no app do cliente, para
 * nfse:nota-pdf:<conta>:nuvem-<id> (a meta passa a dizer tem_pdf); com
 * "mandar também por e-mail" ligado (admin:nfse:config.mail), o e-mail com
 * PDF e XML vai ao cliente. Marca na nota (pdf_em, email). Uma vez por nota
 * (forcar refaz). Devolve {ok, pdf_bytes, email}. Chamável por ctx.waitUntil.
 */
export async function depoisDeEmitir(env, id, { forcar = false } = {}) {
  await tirarDeDepois(env, id);
  const n = await chamar(env, "nota", { id });
  if (n.status !== 200) return { ok: false, erro: n.dados.erro };
  if (n.dados.nota.pdf_em && !forcar) return { ok: true, ja: true };
  const p = await montarPdf(env, id);
  if (p.erro) return { ok: false, erro: p.erro };
  const nota = p.nota;
  if (nota.estado !== "emitida") return { ok: false, erro: "a nota não está emitida" };
  await env.APOIOS.put(K_PDF + id, p.b64);
  let email = "";
  if (nota.conta) {
    const base = nota.conta + ":" + idNoCliente(nota.id);
    const metaTexto = await env.APOIOS.get("nfse:nota:" + base);
    if (metaTexto) {
      await env.APOIOS.put("nfse:nota-pdf:" + base, p.b64);
      await env.APOIOS.put("nfse:nota:" + base, JSON.stringify({ ...JSON.parse(metaTexto), tem_pdf: true }));
    }
    if ((await configNfse(env)).mail) email = await mandarNotaPorEmail(env, metaDoEmail(nota), p.b64, b64(new TextEncoder().encode(p.xml)));
  }
  await chamar(env, "marcar_depois", { id, pdf_em: new Date().toISOString(), email });
  return { ok: true, pdf_bytes: p.bytes, email };
}

/** Enviar ao cliente: a nota (meta, XML e PDF) no app dele e, com "mail" ligado, o e-mail. [corpo, status] */
async function enviarAoCliente(env, id, quem) {
  const r = await chamar(env, "enviar_cliente", { id, quem });
  if (r.status !== 200) return [r.dados, r.status];
  const nota = r.dados;
  const pdf = await pdfDaNota(env, id);
  const base = nota.conta + ":" + idNoCliente(nota.id);
  if (pdf.b64) {
    await env.APOIOS.put("nfse:nota-pdf:" + base, pdf.b64);
    const meta = await kvJSON(env, "nfse:nota:" + base, null);
    if (meta) await env.APOIOS.put("nfse:nota:" + base, JSON.stringify({ ...meta, tem_pdf: true }));
  }
  let email = "";
  if ((await configNfse(env)).mail) {
    const x = await chamar(env, "xml", { id, tipo: "nfse" });
    email = await mandarNotaPorEmail(env, metaDoEmail(nota), pdf.b64 || "", x.status === 200 ? b64(new TextEncoder().encode(x.dados.xml)) : "");
    await chamar(env, "anotar_email", { id, email });
  }
  return [{ ok: true, nota, email, pdf: Boolean(pdf.b64) }, 200];
}

async function tirarDeDepois(env, id) {
  const lista = (await kvJSON(env, K_DEPOIS, [])) || [];
  if (!Array.isArray(lista) || !lista.some((x) => x && x.id === id)) return;
  await env.APOIOS.put(K_DEPOIS, JSON.stringify(lista.filter((x) => x && x.id !== id)));
}

/**
 * O Cron de cada minuto (index.js): o PDF (e o e-mail) das notas emitidas
 * que ninguém pediu ainda, uma por vez, as que estão na lista há mais de
 * 1 min (a tela pede logo depois de emitir). Sem nada na lista, uma leitura do KV.
 */
export async function depoisPendentes(env, agora = Date.now()) {
  if (!env.APOIOS || !env.EMISSOR_NFSE) return { feitas: 0 };
  const lista = (await kvJSON(env, K_DEPOIS, [])) || [];
  if (!Array.isArray(lista) || !lista.length) return { feitas: 0 };
  const pronta = lista.find((x) => x && agora - Date.parse(x.quando) >= 60 * 1000);
  if (!pronta) return { feitas: 0 };
  try {
    await depoisDeEmitir(env, pronta.id);
  } catch {
    await tirarDeDepois(env, pronta.id);
  }
  return { feitas: 1 };
}

// ------------------------------------------------------------ automático

/**
 * O pagamento confirmado (worker/ia.js, anotarPagamento) com o interruptor
 * "auto" ligado: emite no DO se o tomador do cliente estiver completo; senão
 * o motivo fica no pagamento (a lista do painel mostra) e a nota fica
 * pendente. Nunca lança. Devolve {feito, motivo?, nota?}.
 */
export async function emitirAutomatico(env, pagamentoId) {
  try {
    if (!env.APOIOS || faltaDoEmissor(env)) return { feito: false, motivo: "emissor desligado" };
    if (!(await configNfse(env)).auto) return { feito: false, motivo: "emissão automática desligada" };
    const pag = await kvJSON(env, "admin:nfse:" + pagamentoId, null);
    if (!pag) return { feito: false, motivo: "pagamento não encontrado" };
    const conta = (await contasDaCasa(env)).find((x) => x.id === pag.conta);
    if (!conta) {
      await marcarPagamento(env, pagamentoId, { motivo: "emissão automática parada: a conta do pagamento não foi encontrada" });
      return { feito: false, motivo: "conta não encontrada" };
    }
    const cliente = await clienteDaConta(env, conta);
    const faltas = faltasDoTomador(cliente.tomador);
    if (faltas.length) {
      const motivo = "emissão automática parada: falta " + faltas.join(", ") + " do cliente (Notas fiscais › Clientes)";
      await marcarPagamento(env, pagamentoId, { motivo });
      return { feito: false, motivo };
    }
    const r = await chamar(env, "emitir", { conta: conta.id, pagamento: pagamentoId, tomador: cliente.tomador, quem: "automático" });
    if (r.status !== 200) {
      const motivo = "a emissão automática falhou: " + (r.dados.erro || "HTTP " + r.status);
      await marcarPagamento(env, pagamentoId, { motivo });
      return { feito: false, motivo };
    }
    if (r.dados.estado !== "emitida") {
      await marcarPagamento(env, pagamentoId, { motivo: "nota " + String(r.dados.estado_rotulo || r.dados.estado).toLowerCase() + (r.dados.erro ? ": " + r.dados.erro : "") });
    }
    return { feito: true, nota: r.dados };
  } catch (e) {
    try {
      await marcarPagamento(env, pagamentoId, { motivo: "a emissão automática falhou: " + String((e && e.message) || e).slice(0, 200) });
    } catch {
      // nada
    }
    return { feito: false, motivo: String((e && e.message) || e) };
  }
}

// ------------------------------------------------------------ o painel

/**
 * GET /api/admin/nfse: tudo o que a aba Notas fiscais mostra de uma vez.
 * {config, emissor: {ligado, falta}, situacao | null, notas: [nota],
 *  pagamentos: [os sem nota], cloudflare, erro}
 */
export async function resumoParaPainel(env) {
  const config = await configNfse(env);
  const falta = faltaDoEmissor(env);
  const { pagamentos } = env.APOIOS ? await listarPagamentos(env) : { pagamentos: [] };
  const base = { config, emissor: { ligado: !falta, falta }, situacao: null, notas: [], cloudflare: env.APOIOS ? await situacaoCf(env) : null, erro: "" };
  if (falta) return { ...base, pagamentos: pagamentos.filter((x) => x.nota !== "emitida" && x.nota !== "cancelada" && x.nota !== "reembolsado") };
  const [s, l] = await Promise.all([chamar(env, "situacao", {}), chamar(env, "listar", { limite: 300 })]);
  const notas = l.status === 200 ? l.dados.notas : [];
  const comNota = new Set(notas.filter((n) => n.pagamento && n.estado !== "descartada").map((n) => n.pagamento));
  const semNota = pagamentos.filter((x) => !comNota.has(x.id) && x.nota !== "emitida" && x.nota !== "cancelada" && x.nota !== "reembolsado");
  return { ...base, situacao: s.status === 200 ? s.dados : null, notas, pagamentos: semNota,
    erro: s.status !== 200 ? s.dados.erro : l.status !== 200 ? l.dados.erro : "" };
}
