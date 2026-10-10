// As notas do PAVLVS no app de cada cliente e o tomador de cada assinante
// (contrato em worker/admin-api.md, "Notas fiscais").
//
// Quem emite e o emissor da nuvem (worker/nfse/emissor.js, o Durable Object
// EmissorNFSe), pela aba Notas fiscais do painel (/api/admin/nfse/*). A antiga
// ponte com o PAULUS da casa (/api/nfse-casa/*) saiu em 03/10/2026; ficam aqui
// as funcoes que o emissor e o painel usam:
//   clienteDaConta / listarClientes   o tomador de cada assinante (cadastro + ajuste)
//   conferirTomador / gravarTomador   o ajuste do tomador (nfse:tomador:<conta>)
//   listarPagamentos                  a fila admin:nfse:<pagamento>
//   guardarNotaDoCliente              a nota no app do cliente (nfse:nota*)
//   avisarNotaCancelada               a nota cancelada (ou substituida) no app do cliente
//   mandarNotaPorEmail / mandarEmail  o e-mail da nota pelo Resend
//   marcarPagamento                   a marca da nota no pagamento
// O PAULUS de cada cliente busca as proprias notas em /api/ia/nfse
// (worker/ia.js, notasDoCliente, com o segredo da instalacao).
//
// No KV APOIOS:
//   nfse:tomador:<conta>          o que o painel corrigiu do tomador (vence o cadastro)
//   nfse:nota:<conta>:<id>        a meta da nota
//   nfse:nota-pdf:<conta>:<id>    o PDF (base64)
//   nfse:nota-xml:<conta>:<id>    o XML (base64)
//   admin:nfse:<pagamento>        a fila do painel; a nota emitida a marca
//
// O e-mail da nota vai pelo Resend (RESEND_API_KEY), ao e-mail do tomador
// corrigido no painel ou, sem ele, ao e-mail da conta. Falha no e-mail nao
// falha a nota.

import { contasDaCasa, enviarEmail } from "./admin.js";
import { cpfValido, cnpjValido } from "./ia.js";

const MAX_ARQUIVO = 2 * 1024 * 1024;
const RE_CONTA = /^[0-9a-f]{24}$/;
const RE_NOTA = /^[A-Za-z0-9_.-]{1,64}$/;
const UFS = "AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO".split(" ");
export const CAMPOS_TOMADOR = ["nome", "documento", "email", "telefone", "logradouro", "numero", "complemento", "bairro", "cep", "cmun", "uf", "inscricao_municipal"];
// O que a nota precisa do tomador (o resto e opcional).
const ROTULOS_TOMADOR = { nome: "nome", documento: "CPF/CNPJ", logradouro: "rua", numero: "número", bairro: "bairro", cep: "CEP", cmun: "município (IBGE)" };

/* O que falta no tomador para a nota: ["CEP", "bairro"...]. */
export function faltasDoTomador(t) {
  const x = t || {};
  const faltas = Object.keys(ROTULOS_TOMADOR).filter((k) => !String(x[k] || "").trim()).map((k) => ROTULOS_TOMADOR[k]);
  const doc = soDigitos(x.documento);
  if (doc && !(doc.length === 11 ? cpfValido(doc) : doc.length === 14 && cnpjValido(doc))) faltas.push("CPF/CNPJ válido");
  return faltas;
}

// ------------------------------------------------------------ clientes

export async function clienteDaConta(env, conta) {
  const d = conta._d || {};
  const cad = d.cadastro || {};
  // O endereco que o cliente deu em /cadastro (contas antigas nao tem).
  const end = cad.endereco || {};
  const base = {
    nome: cad.nome_escritorio || conta.nome || "", documento: soDigitos(cad.documento), email: conta.email || "",
    telefone: soDigitos(cad.telefone), logradouro: end.logradouro || "", numero: end.numero || "", complemento: end.complemento || "",
    bairro: end.bairro || "", cep: soDigitos(end.cep), cmun: soDigitos(end.cmun), uf: end.uf || "", inscricao_municipal: "",
  };
  const ajuste = (await kvJSON(env, "nfse:tomador:" + conta.id)) || {};
  const tomador = { ...base };
  for (const k of CAMPOS_TOMADOR) if (ajuste[k] !== undefined && ajuste[k] !== "") tomador[k] = ajuste[k];
  const plano = conta.plano ? { id: conta.plano.id, nome: conta.plano.nome, valor: conta.plano.valor } : null;
  return {
    id: conta.id, nome: conta.nome, email: conta.email, telefone: soDigitos(cad.telefone), oab: conta.oab || "",
    plano, situacao: conta.situacao, tomador, ajustado: Object.keys(ajuste).length > 0, faltas: faltasDoTomador(tomador),
  };
}

export async function listarClientes(env) {
  const contas = await contasDaCasa(env);
  return Promise.all(contas.map((c) => clienteDaConta(env, c)));
}

/* O tomador conferido, ou {erro}. So os campos enviados entram; "" apaga o
   ajuste daquele campo (volta o do cadastro). */
export function conferirTomador(t) {
  if (!t || typeof t !== "object") return { erro: "mande o tomador" };
  const limpo = (v, max) => String(v == null ? "" : v).replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  const saida = {};
  for (const k of CAMPOS_TOMADOR) {
    if (t[k] === undefined) continue;
    let v = limpo(t[k], k === "nome" ? 150 : k === "logradouro" ? 125 : 60);
    if (v === "") { saida[k] = ""; continue; }
    if (k === "documento") {
      v = soDigitos(v);
      if (!(v.length === 11 ? cpfValido(v) : cnpjValido(v))) return { erro: "o CPF ou CNPJ do tomador não confere" };
    } else if (k === "cep") {
      v = soDigitos(v);
      if (v.length !== 8) return { erro: "o CEP tem 8 dígitos" };
    } else if (k === "cmun") {
      v = soDigitos(v);
      if (v.length !== 7) return { erro: "o código do município (IBGE) tem 7 dígitos" };
    } else if (k === "uf") {
      v = v.toUpperCase();
      if (!UFS.includes(v)) return { erro: "a UF tem 2 letras (ex.: PA)" };
    } else if (k === "email") {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) || v.length > 120) return { erro: "o e-mail do tomador não confere" };
    } else if (k === "telefone") {
      v = soDigitos(v);
      if (v.length < 10 || v.length > 13) return { erro: "o telefone precisa do DDD" };
    } else if (k === "nome") {
      if (v.length < 2) return { erro: "o nome do tomador é curto demais" };
    }
    saida[k] = v;
  }
  return { tomador: saida };
}

/* O ajuste do tomador (o cadastro original da conta nao muda). {status, corpo}. */
export async function gravarTomador(env, id, tomador) {
  const c = conferirTomador(tomador);
  if (c.erro) return { status: 400, corpo: { erro: c.erro } };
  const conta = (await contasDaCasa(env)).find((x) => x.id === id);
  if (!conta) return { status: 404, corpo: { erro: "essa conta não existe" } };
  const antes = (await kvJSON(env, "nfse:tomador:" + id)) || {};
  const novo = { ...antes, ...c.tomador };
  for (const k of Object.keys(novo)) if (novo[k] === "") delete novo[k];
  if (Object.keys(novo).length) await env.APOIOS.put("nfse:tomador:" + id, JSON.stringify(novo));
  else await env.APOIOS.delete("nfse:tomador:" + id);
  return { status: 200, corpo: await clienteDaConta(env, conta) };
}

// ------------------------------------------------------------ pagamentos

export async function listarPagamentos(env) {
  const contas = await contasDaCasa(env);
  const porId = new Map(contas.map((x) => [x.id, x]));
  const lista = [];
  for (const k of await kvPor(env, "admin:nfse:")) {
    if (k === "admin:nfse:config") continue;
    const x = await kvJSON(env, k);
    if (!x) continue;
    const conta = porId.get(x.conta);
    lista.push({ id: x.id, conta: x.conta || "", cliente: conta ? conta.nome : "", tipo: x.tipo, valor: x.valor, quando: x.quando, nota: x.nota || "pendente",
      numero: x.numero || "", nota_id: x.nota_id || "", motivo: x.motivo || "", erro: x.erro || "" });
  }
  lista.sort((a, b) => String(b.quando).localeCompare(String(a.quando)));
  const config = { auto: false, email: false, mail: false, ...((await kvJSON(env, "admin:nfse:config")) || {}) };
  return { pagamentos: lista, config };
}

// ------------------------------------------------------------ notas

function bytesDoBase64(b64) {
  const s = String(b64 || "").replace(/\s+/g, "");
  if (!s) return { tamanho: 0, b64: "" };
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return { erro: true };
  const tamanho = Math.floor((s.length * 3) / 4) - (s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0);
  return { tamanho, b64: s };
}

/* A nota emitida no lugar onde o app do cliente a busca (nfse:nota*), com a
   meta, o PDF e o XML (base64). O emissor da nuvem (worker/nfse/emissor.js)
   grava por aqui. Devolve {status, corpo}. */
export async function guardarNotaDoCliente(env, d) {
  const json = (corpo, status = 200) => ({ corpo, status });
  const id = String(d.id || "");
  const conta = String(d.conta || "");
  if (!RE_NOTA.test(id)) return json({ erro: "o id da nota vai com letras, números, ponto, _ ou - (até 64)" }, 400);
  if (!RE_CONTA.test(conta)) return json({ erro: "conta inválida" }, 400);
  if (!(await env.APOIOS.get("admin:conta:" + conta))) return json({ erro: "essa conta não existe" }, 404);
  const competencia = String(d.competencia || "");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(competencia)) return json({ erro: "a competência vai como AAAA-MM" }, 400);
  const valor = Number(d.valor);
  if (!Number.isFinite(valor) || valor < 0) return json({ erro: "o valor é um número em reais" }, 400);
  const ambiente = d.ambiente === "producao_restrita" ? "producao_restrita" : d.ambiente === "producao" ? "producao" : "";
  if (!ambiente) return json({ erro: "o ambiente é producao ou producao_restrita" }, 400);
  const pdf = bytesDoBase64(d.pdf_b64);
  const xml = bytesDoBase64(d.xml_b64);
  if (pdf.erro || xml.erro) return json({ erro: "o PDF e o XML vão em base64" }, 400);
  if (pdf.tamanho > MAX_ARQUIVO || xml.tamanho > MAX_ARQUIVO) return json({ erro: "cada arquivo pode ter até 2 MB" }, 413);
  const pagamento = d.pagamento ? String(d.pagamento).slice(0, 80) : "";
  const limpo = (v, max) => String(v == null ? "" : v).replace(/[\u0000-\u0009\u000b-\u001f]/g, " ").trim().slice(0, max);
  const base = conta + ":" + id;
  // Sem pdf_b64 no pedido, o PDF que ja estava fica (o emissor manda a nota
  // antes de o PDF existir e o PDF depois, em outro pedido).
  const manterPdf = d.pdf_b64 === undefined;
  const meta = {
    id, conta, pagamento, numero: limpo(d.numero, 30), chave: limpo(d.chave, 60), competencia, valor: Math.round(valor * 100) / 100,
    descricao: limpo(d.descricao, 2000), ambiente, emitida_em: limpo(d.emitida_em, 40) || new Date().toISOString(),
    tem_pdf: manterPdf ? Boolean(await env.APOIOS.get("nfse:nota-pdf:" + base)) : Boolean(pdf.b64), tem_xml: Boolean(xml.b64), cancelada: false,
    recebida: new Date().toISOString(),
  };
  if (!manterPdf && pdf.b64) await env.APOIOS.put("nfse:nota-pdf:" + base, pdf.b64);
  else if (!manterPdf) await env.APOIOS.delete("nfse:nota-pdf:" + base);
  if (xml.b64) await env.APOIOS.put("nfse:nota-xml:" + base, xml.b64);
  else await env.APOIOS.delete("nfse:nota-xml:" + base);
  await env.APOIOS.put("nfse:nota:" + base, JSON.stringify(meta));
  if (pagamento) await marcarPagamento(env, pagamento, { nota: "emitida", numero: meta.numero, nota_id: id, erro: "" });
  if (d.email !== true) return json({ ok: true });
  const email = await mandarNotaPorEmail(env, meta, pdf.b64, xml.b64);
  return json({ ok: true, email });
}

/* O e-mail "Sua NFS-e de ..." com o PDF e o XML (base64) anexos. Exportada
   para o emissor da nuvem (depoisDeEmitir). Nunca lanca (veja mandarEmail). */
export async function mandarNotaPorEmail(env, meta, pdfB64, xmlB64) {
  const anexos = [];
  const arquivo = "NFS-e " + String(meta.numero || meta.id).replace(/[^A-Za-z0-9_.-]/g, "");
  if (pdfB64) anexos.push({ nome: arquivo + ".pdf", b64: pdfB64 });
  if (xmlB64) anexos.push({ nome: arquivo + ".xml", b64: xmlB64 });
  const linhas = [
    "Segue a NFS-e da sua assinatura do PAVLVS, com o PDF e o XML anexos.",
    "Número: " + (meta.numero || "—") + "\nValor: " + brl(meta.valor) + "\nCompetência: " + mesAno(meta.competencia),
  ];
  if (meta.ambiente === "producao_restrita") linhas.push("Esta nota foi emitida no ambiente de testes, sem valor fiscal.");
  return mandarEmail(env, meta.conta, {
    assunto: "Sua NFS-e de " + mesAno(meta.competencia) + " — PAVLVS", titulo: "Sua NFS-e de " + mesAno(meta.competencia), texto: linhas.join("\n\n"), anexos,
  });
}

const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
function mesAno(competencia) {
  const [a, m] = String(competencia || "").split("-");
  return MESES[Number(m) - 1] ? MESES[Number(m) - 1] + "/" + a : String(competencia || "");
}
function brl(v) {
  return "R$ " + Number(v || 0).toFixed(2).replace(".", ",").replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

/* Manda o e-mail da nota ao e-mail do tomador (o ajuste da casa) ou, sem ele,
   ao da conta. Devolve "enviado" | "sem RESEND_API_KEY" | "sem e-mail do
   cliente" | "falhou: <motivo>"; nunca lanca. */
export async function mandarEmail(env, contaId, { assunto, titulo, texto, anexos }) {
  if (!env.RESEND_API_KEY) return "sem RESEND_API_KEY";
  try {
    const ajuste = (await kvJSON(env, "nfse:tomador:" + contaId)) || {};
    let para = ajuste.email || "";
    if (!para) {
      const conta = (await contasDaCasa(env)).find((x) => x.id === contaId);
      para = (conta && conta.email) || "";
    }
    if (!para) return "sem e-mail do cliente";
    const r = await enviarEmail(env, { para, assunto, titulo, texto, anexos });
    return r.ok ? "enviado" : "falhou: " + (r.erro || "o provedor de e-mail recusou");
  } catch (e) {
    return "falhou: " + String((e && e.message) || e).slice(0, 200);
  }
}

export async function marcarPagamento(env, pagamento, campos) {
  const chave = "admin:nfse:" + pagamento;
  const x = await kvJSON(env, chave);
  if (!x) return;
  await env.APOIOS.put(chave, JSON.stringify({ ...x, ...campos }));
}

/* A nota cancelada (ou substituida) no app do cliente. Usada pelo emissor da
   nuvem. d: {conta, email?, substituta?: {numero}}. Devolve {status, corpo}. */
export async function avisarNotaCancelada(env, id, d) {
  const json = (corpo, status = 200) => ({ corpo, status });
  const conta = String(d.conta || "");
  if (!RE_CONTA.test(conta)) return json({ erro: "conta inválida" }, 400);
  const chave = "nfse:nota:" + conta + ":" + id;
  const meta = await kvJSON(env, chave);
  if (!meta) return json({ erro: "essa nota não existe" }, 404);
  meta.cancelada = true;
  meta.cancelada_em = new Date().toISOString();
  await env.APOIOS.put(chave, JSON.stringify(meta));
  if (meta.pagamento) await marcarPagamento(env, meta.pagamento, { nota: "cancelada" });
  const substituta = d.substituta && typeof d.substituta === "object" ? String(d.substituta.numero || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 30) : "";
  if (substituta) {
    meta.substituta = substituta;
    await env.APOIOS.put(chave, JSON.stringify(meta));
  }
  if (d.email !== true) return json({ ok: true });
  const linhas = [
    "A NFS-e nº " + (meta.numero || id) + " (" + mesAno(meta.competencia) + ", " + brl(meta.valor) + ") da sua assinatura do PAVLVS foi cancelada.",
  ];
  if (substituta) linhas.push("Ela foi substituída pela nota nº " + substituta + ", que você recebe à parte.");
  if (meta.ambiente === "producao_restrita") linhas.push("Esta nota era do ambiente de testes, sem valor fiscal.");
  const email = await mandarEmail(env, conta, {
    assunto: "NFS-e nº " + (meta.numero || id) + " cancelada — PAVLVS", titulo: "NFS-e cancelada", texto: linhas.join("\n\n"),
  });
  return json({ ok: true, email });
}

// ------------------------------------------------------------ utilidades

function soDigitos(t) {
  return String(t || "").replace(/\D/g, "");
}

async function kvJSON(env, chave, padrao = null) {
  try {
    const v = await env.APOIOS.get(chave);
    return v ? JSON.parse(v) : padrao;
  } catch {
    return padrao;
  }
}

async function kvPor(env, prefixo) {
  const saida = [];
  let cursor;
  do {
    const lista = await env.APOIOS.list({ prefix: prefixo, cursor });
    for (const k of lista.keys) saida.push(k.name);
    cursor = lista.list_complete ? undefined : lista.cursor;
  } while (cursor);
  return saida;
}
