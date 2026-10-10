// A Minha conta do site (paulus.ia.br/minha-conta e /en/my-account): o
// titular da assinatura - e quem ele autorizar, como financeiro - cuida do
// plano, do consumo, das faturas, da forma de pagamento, do cadastro e do
// escritorio. A pagina e site/minha-conta (site/assets/minha-conta.js); as
// rotas sao /api/conta/*.
//
// Entrar: o botao do Google (o mesmo cliente web do cadastro) entrega o
// id_token; o Worker confere (donoDoToken) e abre uma sessao propria, num
// cookie HttpOnly de 12 horas ("conta:sessao:<resumo do cookie>" no KV
// APOIOS). A conta do titular e a da nuvem (sha256("conta-ia:" + sub)); o
// financeiro entra pelo convite do titular (link de 7 dias por e-mail), e o
// acesso dele e conferido no medidor a cada pedido - tirado pelo titular,
// acaba na hora.
//
// Papeis: o titular faz tudo; o financeiro ve o resumo, o consumo e as faturas
// e cuida do pagamento (forma, cartao, recarga). Cada rota confere o papel.
//
// Nada de dinheiro e decidido aqui: as mudancas na cobranca sao as funcoes do
// worker/ia.js (trocarPlanoAgora e orcarTrocaDePlano, ofertaParaFicar, cancelarPelaConta,
// cartaoNovo, pixDaRecarga, pagarNoPix), com as mesmas regras do resto da
// nuvem. Os POST so valem da propria origem (o cookie e SameSite=Lax e a
// origem e conferida).

import {
  OFERTA_FICAR, arquivoDoCliente, cancelarPelaConta, cartaoNovo, catalogo, conferirCadastro, medidor, modelosDoPlano,
  notasDoCliente, numeros, ofertaParaFicar, orcarTrocaDePlano, pagarNoPix, pixDaRecarga, prepago, recargasDe, trocarPlanoAgora,
} from "./ia.js";
import { alterarEndereco, disponibilidade, donoDoToken, escritorioDoDono } from "./tunel.js";
import { enviarEmail } from "./admin.js";

const SITE = "https://paulus.ia.br";
const COOKIE = "pv_conta";
const SESSAO_S = 12 * 3600;
const CONVITE_MS = 7 * 24 * 3600 * 1000;
const DIA_MS = 24 * 3600 * 1000;
// Os servicos do Google, pelo escopo (o mesmo nome do painel e do PAULUS).
const SERVICOS_G = [
  { id: "gmail", escopo: "mail.google.com", nome: "Gmail" },
  { id: "agenda", escopo: "calendar.events", nome: "Agenda" },
  { id: "drive_enviar", escopo: "drive.file", nome: "Drive · enviar" },
  { id: "drive_ler", escopo: "drive.readonly", nome: "Drive · ler" },
];

export function ehRotaDaConta(url) {
  return url.pathname === "/api/conta" || url.pathname.startsWith("/api/conta/");
}

export async function atenderConta(request, env, url, ctx, deps = {}) {
  if (env.IA_ATIVA !== "1" || !env.CONTAS_IA || !env.APOIOS) return json({ erro: "a Minha conta ainda não está ligada" }, 503);
  const p = url.pathname;
  const m = request.method;
  if (m === "POST" && !mesmaOrigem(request, url)) return json({ erro: "pedido de outra origem" }, 403);
  if (p === "/api/conta/entrar" && m === "POST") return entrar(request, env, deps);
  if (p === "/api/conta/sair" && m === "POST") return sair(request, env);
  const s = await sessaoDe(request, env);
  if (!s) return json({ erro: "entre na sua conta", entrar: true }, 401, { "set-cookie": cookie("", 0) });
  if (s.papel !== "titular") {
    // O financeiro: o titular pode ter tirado o acesso desde que a sessao abriu.
    const r = await medidor(env, s.conta).pedir("pessoa_papel", { email: s.email });
    if (!r.ok) {
      await env.APOIOS.delete("conta:sessao:" + (await sha256(s.token)));
      return json({ erro: "o titular tirou o seu acesso a esta conta", entrar: true }, 401, { "set-cookie": cookie("", 0) });
    }
  }
  const mp = deps.chamarMP;
  const titular = s.papel === "titular";
  const soTitular = () => json({ erro: "só o titular da assinatura faz isso" }, 403);
  const limitado = async () => Boolean(deps.dentroDoLimite) && !(await deps.dentroDoLimite(request, env));
  const quem = "Minha conta (" + s.email + ")";
  const responder = (r) => json(r, r.ok === false ? r.status || 400 : 200);

  if (p === "/api/conta" && m === "GET") {
    const d = await montar(env, s, Date.now());
    return d ? json(d) : json({ erro: "a conta não foi encontrada", entrar: true }, 401);
  }
  if (p === "/api/conta/consumo" && m === "GET") {
    const r = await medidor(env, s.conta).pedir("minha_conta");
    return json(consumoDo(r, url.searchParams.get("ciclo") || "ciclo", Date.now()));
  }
  const nf = p.match(/^\/api\/conta\/nfse\/([A-Za-z0-9_.-]{1,64})\/(pdf|xml)$/);
  if (nf && m === "GET") return arquivoDoCliente(env, s.conta, nf[1], nf[2]);
  if (p === "/api/conta/nfse.zip" && m === "GET") return zipDoAno(env, s.conta, url.searchParams.get("ano"));

  // O pagamento: titular e financeiro.
  if (p === "/api/conta/recarga" && m === "POST") {
    if (await limitado()) return json({ erro: "muitas tentativas seguidas - espere um minuto" }, 429);
    const d = (await lerJSON(request)) || {};
    return responder(await pixDaRecarga(env, mp, s.conta, { pacote: String(d.pacote || "1"), email: s.email }));
  }
  if (p === "/api/conta/cartao" && m === "POST") {
    if (await limitado()) return json({ erro: "muitas tentativas seguidas - espere um minuto" }, 429);
    const d = (await lerJSON(request)) || {};
    return responder(await cartaoNovo(env, mp, s.conta, { token: String(d.token || ""), metodo: String(d.metodo || "") }));
  }
  if (p === "/api/conta/forma" && m === "POST") {
    const d = (await lerJSON(request)) || {};
    if (d.tipo === "pix") return responder(await pagarNoPix(env, mp, s.conta, { por: quem }));
    if (d.tipo !== "cartao") return json({ erro: "a forma é cartão ou Pix" }, 400);
    const r = await medidor(env, s.conta).pedir("minha_conta");
    if (!(r.forma && r.forma.tipo === "pix" && !r.forma.parado)) return json({ ok: true, ja: true });
    // Do Pix de volta ao cartao: a assinatura nova no cartao comeca quando o mes pago acabar (a pagina de pagamento confere).
    return json({ erro: "o mês pago no Pix vale até " + dataBR(r.pago_ate) + "; a assinatura no cartão começa depois dele, na página de pagamento",
      proximo: SITE + "/cadastro/pagamento/?plano=" + encodeURIComponent(r.plano.id) + "&periodo=mensal" }, 409);
  }
  if (!titular) return soTitular();

  // Daqui em diante, so o titular.
  if (p === "/api/conta/cadastro" && m === "POST") return salvarCadastro(request, env, s);
  if (p === "/api/conta/plano/orcar" && m === "GET") {
    const q = url.searchParams;
    return responder(await orcarTrocaDePlano(env, s.conta, { plano: String(q.get("plano") || ""), periodo: q.get("periodo") === "anual" ? "anual" : "mensal" }));
  }
  if (p === "/api/conta/plano" && m === "POST") {
    if (await limitado()) return json({ erro: "muitas tentativas seguidas - espere um minuto" }, 429);
    const d = (await lerJSON(request)) || {};
    return responder(await trocarPlanoAgora(env, mp, s.conta, { plano: String(d.plano || ""), periodo: d.periodo === "anual" ? "anual" : "mensal" }));
  }
  if (p === "/api/conta/oferta" && m === "POST") {
    const d = (await lerJSON(request)) || {};
    return responder(await ofertaParaFicar(env, mp, s.conta, { tipo: String(d.tipo || ""), motivo: String(d.motivo || ""), por: quem }));
  }
  if (p === "/api/conta/cancelar" && m === "POST") {
    const d = (await lerJSON(request)) || {};
    const motivo = ["preco", "uso", "falta", "outro"].includes(d.motivo) ? d.motivo : "outro";
    return responder(await cancelarPelaConta(env, mp, s.conta, { motivo, texto: String(d.texto || ""), por: quem }));
  }
  if (p === "/api/conta/endereco/disponivel" && m === "GET") {
    const r = await medidor(env, s.conta).pedir("minha_conta");
    const d = await disponibilidade(env, url.searchParams.get("slug") || "", "", r.dono);
    return json({ disponivel: Boolean(d.disponivel && !d.retomar), motivo: d.retomar ? "esse endereço já é desta conta" : d.motivo || "", sugestao: d.sugestao || "" });
  }
  if (p === "/api/conta/endereco" && m === "POST") return trocarEndereco(request, env, s);
  const inst = p.match(/^\/api\/conta\/instalacoes\/([A-Za-z0-9-]{8,64})\/remover$/);
  if (inst && m === "POST") return responder(await medidor(env, s.conta).pedir("remover_instalacao", { instalacao: inst[1] }));
  if (p === "/api/conta/google/servico" && m === "POST") return servicoDoGoogle(request, env, s);
  if (p === "/api/conta/google/desvincular" && m === "POST") {
    await medidor(env, s.conta).pedir("google_ordem", { ligados: [] });
    return json({ ok: true });
  }
  if (p === "/api/conta/pessoas" && m === "POST") return convidar(request, env, s, deps);
  const pes = p.match(/^\/api\/conta\/pessoas\/([^/]{3,120})\/remover$/);
  if (pes && m === "POST") return removerPessoa(env, s, decodeURIComponent(pes[1]).toLowerCase());
  return json({ erro: "rota não existe" }, 404);
}

// ---------------------------------------------------------------- entrar

async function entrar(request, env, deps) {
  if (deps.dentroDoLimite && !(await deps.dentroDoLimite(request, env))) return json({ erro: "muitas tentativas seguidas - espere um minuto" }, 429);
  const d = (await lerJSON(request)) || {};
  // O link de entrada que o Paulus pediu (POST /api/ia/minha-conta/link): uma vez, 2 minutos.
  if (d.link) {
    if (!/^[0-9a-f]{64}$/.test(String(d.link))) return json({ erro: "este link não abre: abra de novo pelo Paulus" }, 400);
    const chave = "conta:link:" + (await sha256(d.link));
    const l = await kvJSON(env, chave);
    if (!l) return json({ erro: "este link já foi usado ou venceu: abra de novo pelo Paulus, ou entre aqui", entrar: true }, 410);
    await env.APOIOS.delete(chave);
    const token = aleatorio(32);
    const ate = new Date(Date.now() + SESSAO_S * 1000).toISOString();
    await env.APOIOS.put("conta:sessao:" + (await sha256(token)), JSON.stringify({ conta: l.conta, papel: l.papel, email: l.email, sub: l.sub, nome: l.nome, ate }), { expirationTtl: SESSAO_S });
    return json({ ok: true, papel: l.papel }, 200, { "set-cookie": cookie(token, SESSAO_S) });
  }
  const credencial = String(d.credential || d.id_token || "");
  const dono = await (deps.donoDoToken || donoDoToken)(env, credencial);
  if (!dono) return json({ erro: "a sua entrada venceu: entre de novo" }, 401);
  const nome = nomeDoToken(credencial);
  let alvo = null;
  // O convite (link de 7 dias, mandado pelo titular): o e-mail do Google tem de ser o convidado.
  const convite = String(d.convite || "");
  if (convite) {
    if (!/^[0-9a-f]{48}$/.test(convite)) return json({ erro: "este convite não abre: peça outro ao titular" }, 400);
    const h = await sha256(convite);
    const c = await kvJSON(env, "conta:convite:" + h);
    if (!c) return json({ erro: "este convite venceu ou já foi usado: peça outro ao titular" }, 410);
    if (c.email !== dono.email) return json({ erro: "este convite é para " + mascarar(c.email) + ": entre com esse e-mail" }, 403);
    const r = await medidor(env, c.conta).pedir("pessoa_aceitar", { email: dono.email, hash: h, nome });
    if (!r.ok) return json({ erro: r.erro }, r.status || 410);
    await env.APOIOS.delete("conta:convite:" + h);
    await env.APOIOS.put("conta:pessoa:" + dono.email, JSON.stringify({ conta: c.conta }));
    alvo = { conta: c.conta, papel: r.papel || "financeiro" };
  }
  if (!alvo) {
    const id = (await sha256("conta-ia:" + dono.sub)).slice(0, 24);
    const r = await medidor(env, id).pedir("minha_conta");
    if (r.ok && (r.assinatura || r.cadastro || r.cortesia)) alvo = { conta: id, papel: "titular" };
  }
  if (!alvo) {
    const idx = await kvJSON(env, "conta:pessoa:" + dono.email);
    if (idx && idx.conta) {
      const r = await medidor(env, idx.conta).pedir("pessoa_papel", { email: dono.email });
      if (r.ok) alvo = { conta: idx.conta, papel: r.papel || "financeiro" };
    }
  }
  if (!alvo) {
    return json({ erro: "esta conta não tem assinatura do Paulus: assine em paulus.ia.br/assinatura, ou peça um convite ao titular", sem_conta: true }, 404);
  }
  const token = aleatorio(32);
  const ate = new Date(Date.now() + SESSAO_S * 1000).toISOString();
  await env.APOIOS.put("conta:sessao:" + (await sha256(token)), JSON.stringify({ ...alvo, email: dono.email, sub: dono.sub, nome, ate }), { expirationTtl: SESSAO_S });
  return json({ ok: true, papel: alvo.papel }, 200, { "set-cookie": cookie(token, SESSAO_S) });
}

async function sair(request, env) {
  const t = cookieDe(request, COOKIE);
  if (/^[0-9a-f]{64}$/.test(t)) await env.APOIOS.delete("conta:sessao:" + (await sha256(t)));
  return json({ ok: true }, 200, { "set-cookie": cookie("", 0) });
}

async function sessaoDe(request, env) {
  const t = cookieDe(request, COOKIE);
  if (!/^[0-9a-f]{64}$/.test(t)) return null;
  const s = await kvJSON(env, "conta:sessao:" + (await sha256(t)));
  if (!s || !(Date.parse(s.ate) > Date.now())) return null;
  return { ...s, token: t };
}

// ---------------------------------------------------------- o que a tela le

/* GET /api/conta: tudo o que as abas mostram, de uma vez. */
async function montar(env, s, agora) {
  const r = await medidor(env, s.conta).pedir("minha_conta");
  if (!r.ok) return null;
  const n = numeros(env);
  const plano = r.plano;
  const c = r.ciclo_completo;
  const a = r.assinatura || {};
  const pix = Boolean(r.forma && r.forma.tipo === "pix" && !r.forma.parado);
  const periodo = r.periodo === "anual" ? "anual" : "mensal";
  const proxima = prepago(r.periodo) ? r.pago_ate || "" : c ? c.fim : "";
  const valorPlano = periodo === "anual" ? plano.valor_anual : plano.valor;
  const valorProx = (r.ajuste && r.ajuste.cobrancas && r.ajuste.cobrancas[0]) || Number(a.valor) || valorPlano;
  const recargasNoCiclo = c ? (r.recargas || []).filter((x) => x.quando >= c.inicio && x.quando < c.fim).reduce((t, x) => t + (x.tokens || 0), 0) : 0;
  const escritorio = r.dono ? await escritorioDoDono(env, r.dono, agora) : null;
  const instalacoes = (r.instalacoes_lista || []).map((x, i) => ({
    id: x.instalacao, nome: "Computador " + (i + 1), versao: x.versao || "—", ultimo: x.visto ? dataHoraBR(x.visto) : "—",
    principal: Boolean(escritorio && escritorio.instalacao_id && escritorio.instalacao_id === x.instalacao),
  }));
  const titularPessoa = { email: (r.dono || {}).email || r.email, nome: s.papel === "titular" ? s.nome || "" : "", papel: "titular" };
  return {
    perfil: { papel: s.papel, email: s.email, nome: s.nome || "" },
    assinatura: {
      plano: plano.id, nome: plano.nome, periodo, situacao: situacaoDa(r, agora), forma: pix ? "pix" : "cartao",
      valor: valorProx, valor_plano: valorPlano, proxima: String(proxima).slice(0, 10), desde: String(a.desde || r.criada || "").slice(0, 10),
      ajuste: r.ajuste, plano_proximo: r.plano_proximo ? { id: r.plano_proximo.id, nome: r.plano_proximo.nome } : null,
      cortesia: Boolean(r.cortesia), cancelamento: r.cancelamento ? { quando: r.cancelamento.quando } : null,
      ciclo: { de: c ? c.inicio.slice(0, 10) : "", ate: c ? c.fim.slice(0, 10) : "", tokens: c ? c.tokens : 0, usados: c ? c.usados : 0,
        recargas: recargasNoCiclo, extra: (r.tokens || {}).da_recarga || 0 },
    },
    pagamento: {
      tipo: pix ? "pix" : "cartao",
      cartao: r.cartao && r.cartao.final ? { bandeira: r.cartao.bandeira, final: r.cartao.final, validade: r.cartao.validade, titular: r.cartao.titular } : null,
      pix: pixPode(env, r, pix),
      pix_ate: pix ? String(r.pago_ate || "").slice(0, 10) : "",
    },
    recarga: { valor: plano.recarga.valor, tokens: plano.recarga.tokens, pacotes: recargasDe(plano) },
    faturas: await faturas(env, s.conta, r),
    consumo: consumoDo(r, "ciclo", agora),
    cadastro: cadastroParaTela(r),
    escritorio: escritorio ? { slug: escritorio.slug, nome: escritorio.nome, online: escritorio.online, ativo: escritorio.ativo } : null,
    instalacoes,
    google: googleParaTela(r),
    pessoas: [titularPessoa, ...(r.pessoas || [])],
    planos: n.planos.map((x) => ({ id: x.id, nome: x.nome, valor: x.valor, valor_anual: x.valor_anual, tokens: x.tokens, pessoas: x.pessoas,
      modelos_info: catalogo(modelosDoPlano(x)) })),
    oferta_ficar: { ...r.oferta_ficar, creditos: OFERTA_FICAR.creditos, desconto: OFERTA_FICAR.desconto, cobrancas: OFERTA_FICAR.cobrancas,
      desconto_pode: Boolean(a.id && a.situacao === "authorized" && !prepago(r.periodo) && !r.ajuste) },
    email_ligado: Boolean(env.RESEND_API_KEY),
    mp_public_key: env.MP_PUBLIC_KEY || "",
  };
}

function situacaoDa(r, agora) {
  const a = r.assinatura || {};
  const c = r.ciclo_completo;
  if (r.cortesia && r.plano_vigente) return "cortesia";
  if (a.situacao === "cancelled") return c && Date.parse(c.fim) > agora ? "cancelada" : "vencida";
  if (r.forma && r.forma.parado && r.plano_vigente) return "cancelada";
  if (a.situacao === "paused") return "pausada";
  if (a.situacao === "pending") return "pendente";
  if (!r.plano_vigente) return "vencida";
  return "ativa";
}

function pixPode(env, r, pix) {
  if (pix) return { pode: true, motivo: "" };
  const a = r.assinatura || {};
  if (!env.RESEND_API_KEY) return { pode: false, motivo: "o Pix mensal manda o QR por e-mail, e o e-mail do Paulus ainda não está ligado" };
  if (prepago(r.periodo)) return { pode: false, motivo: "o plano pago de uma vez não tem cobrança mensal" };
  if (!a.id || a.situacao !== "authorized") return { pode: false, motivo: "é preciso a assinatura mensal ativa" };
  if (!r.cadastro || !r.cadastro.documento) return { pode: false, motivo: "o Pix pede o CPF ou CNPJ do cadastro" };
  if (r.ajuste) return { pode: false, motivo: "há uma cobrança com valor ajustado em curso" };
  return { pode: true, motivo: "" };
}

const DESCRICAO = { assinatura: "Mensalidade do plano", anual: "Plano anual", avulso: "Um mês no Pix", recarga: "Recarga de créditos" };

/* As faturas: os pagamentos da conta, do mais novo, com a NFS-e de cada um
   (o painel marca o pagamento quando a nota sai: "admin:nfse:<pagamento>"). */
async function faturas(env, conta, r) {
  const linhas = [];
  for (const pg of (r.pagamentos || []).slice().reverse().slice(0, 60)) {
    const marca = await kvJSON(env, "admin:nfse:" + pg.ref);
    const nota = marca && marca.nota === "emitida" && marca.nota_id ? marca : null;
    const base = nota ? "/api/conta/nfse/" + encodeURIComponent(nota.nota_id) + "/" : "";
    const forma = pg.tipo === "recarga" || pg.tipo === "avulso" ? { tipo: "pix" }
      : pg.tipo === "assinatura" ? (r.cartao && r.cartao.final ? { tipo: "cartao", bandeira: r.cartao.bandeira, final: r.cartao.final } : { tipo: "cartao", bandeira: "Cartão", final: "" })
        : null;
    linhas.push({ data: String(pg.quando || "").slice(0, 10), descricao: DESCRICAO[pg.tipo] || "Pagamento", forma, valor: Number(pg.valor) || 0,
      situacao: pg.reembolso ? "estornada" : "paga", nfse: nota ? String(nota.numero || "") : "", pdf: nota ? base + "pdf" : "", xml: nota ? base + "xml" : "" });
  }
  if (r.anual_pendente) {
    linhas.unshift({ data: brt(Date.parse(r.agora) || Date.now()).slice(0, 10), descricao: r.anual_pendente.meses === 1 || r.forma ? DESCRICAO.avulso : DESCRICAO.anual,
      forma: { tipo: "pix" }, valor: Number(r.anual_pendente.valor) || 0, situacao: "pendente", nfse: "", pdf: "", xml: "" });
  }
  return linhas;
}

/* O consumo por dia de um ciclo: o atual ("ciclo"), o anterior ou o que
   comecou num mes ("AAAA-MM"). Por pessoa, o PAULUS do escritorio e quem sabe
   (a nuvem nao recebe quem perguntou): a lista vem vazia. */
export function consumoDo(r, qual, agora) {
  const c = r && r.ciclo_completo;
  if (!c) return { de: "", ate: "", dias: [], pessoas: [], total: 0 };
  let ini = Date.parse(c.inicio);
  let fim = Date.parse(c.fim);
  if (qual === "anterior") {
    fim = ini;
    ini = menosUmMes(ini);
  } else if (/^\d{4}-\d{2}$/.test(qual)) {
    let passos = 0;
    while (brt(ini).slice(0, 7) > qual && passos < 36) {
      fim = ini;
      ini = menosUmMes(ini);
      passos++;
    }
  }
  const porDia = new Map((r.uso || []).map((u) => [u.dia, Number(u.tokens) || 0]));
  const hoje = brt(agora).slice(0, 10);
  const dias = [];
  let total = 0;
  let comDado = false;
  for (let t = ini; t < fim && dias.length < 40; t += DIA_MS) {
    const dia = brt(t).slice(0, 10);
    if (dias.length && dias[dias.length - 1].data === dia) continue;
    const tokens = porDia.get(dia) || 0;
    if (porDia.has(dia)) comDado = true;
    total += tokens;
    dias.push({ data: dia, tokens, futuro: dia > hoje });
  }
  const mes = brt(ini).slice(0, 7);
  const doMes = (r.uso_mes || {})[mes];
  const primeiroDia = (r.uso || [])[0];
  const semDias = !comDado && Boolean(doMes) && (!primeiroDia || primeiroDia.dia > brt(ini).slice(0, 10));
  return { de: brt(ini).slice(0, 10), ate: brt(fim - 1).slice(0, 10), dias, pessoas: [], total,
    ...(semDias ? { sem_dias: true, total_do_mes: (doMes.entrada || 0) + (doMes.saida || 0) } : {}) };
}

function cadastroParaTela(r) {
  const cad = r.cadastro || {};
  const e = cad.endereco || {};
  return { nome: cad.nome_escritorio || r.nome || "", documento: docParaTela(cad.documento), oab: cad.oab || "", telefone: telParaTela(cad.telefone),
    email_cobranca: cad.email_cobranca || r.email || "", cep: e.cep ? e.cep.slice(0, 5) + "-" + e.cep.slice(5) : "", logradouro: e.logradouro || "",
    numero: e.numero || "", complemento: e.complemento || "", bairro: e.bairro || "", cidade: e.cidade || "", uf: e.uf || "", cmun: e.cmun || "" };
}

/* As permissoes do Google como o PAULUS do escritorio contou (google_relatar)
   e a ordem que ainda nao foi cumprida. */
function googleParaTela(r) {
  const g = r.google;
  const escopos = (g && g.escopos) || [];
  const pend = r.google_pendente;
  return {
    conta: (r.dono || {}).email || r.email || "",
    informado: Boolean(g),
    conferido: g ? g.conferido || "" : "",
    pendente: pend ? { quando: pend.quando, ligados: pend.ligados } : null,
    servicos: SERVICOS_G.map((x) => ({ id: x.id, nome: x.nome, ligado: escopos.some((e) => String(e).includes(x.escopo)) })),
  };
}

// --------------------------------------------------------------- as acoes

async function salvarCadastro(request, env, s) {
  const d = (await lerJSON(request)) || {};
  const atual = await medidor(env, s.conta).pedir("minha_conta");
  const antigo = atual.cadastro || {};
  const cepNovo = String(d.cep || "").replace(/\D/g, "");
  const cmunAntigo = antigo.endereco && antigo.endereco.cep === cepNovo ? antigo.endereco.cmun : "";
  const c = conferirCadastro({
    nome_escritorio: d.nome, documento: d.documento, telefone: d.telefone, oab: d.oab, aceite: true,
    endereco: { cep: d.cep, logradouro: d.logradouro, numero: d.numero, complemento: d.complemento, bairro: d.bairro, cidade: d.cidade, uf: d.uf,
      cmun: /^\d{7}$/.test(String(d.cmun || "")) ? d.cmun : cmunAntigo },
  }, { exigirEndereco: true });
  if (c.erro) return json({ erro: c.erro }, 400);
  const email = String(d.email_cobranca || "").trim().toLowerCase();
  if (email && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 120)) return json({ erro: "o e-mail das faturas não confere" }, 400);
  // O aceite dos termos e o do cadastro (a versao que a pessoa aceitou), e nao o desta edicao.
  const cadastro = { ...c.cadastro, termos: antigo.termos || c.cadastro.termos, ...(email ? { email_cobranca: email } : {}), quando: new Date().toISOString() };
  await medidor(env, s.conta).pedir("cadastro", { cadastro });
  return json({ ok: true, cadastro: cadastroParaTela({ ...atual, cadastro }) });
}

async function trocarEndereco(request, env, s) {
  const d = (await lerJSON(request)) || {};
  const novo = String(d.slug || "").trim().toLowerCase();
  const r = await medidor(env, s.conta).pedir("minha_conta");
  const esc = r.dono ? await escritorioDoDono(env, r.dono) : null;
  if (!esc) return json({ erro: "este escritório ainda não tem endereço: ele nasce no Paulus do escritório, em Configurações › Acesso externo" }, 409);
  const disp = await disponibilidade(env, novo, "", r.dono);
  if (!disp.disponivel || disp.retomar) return json({ erro: disp.retomar ? "esse endereço já é desta conta" : disp.motivo || "esse endereço não está livre" }, 409);
  try {
    await alterarEndereco(env, esc.slug, novo, Date.now(), "Minha conta (" + s.email + ")");
  } catch (e) {
    return json({ erro: "não foi possível trocar o endereço agora: " + String((e && e.message) || e) }, 502);
  }
  return json({ ok: true, slug: novo });
}

async function servicoDoGoogle(request, env, s) {
  const d = (await lerJSON(request)) || {};
  const alvo = SERVICOS_G.find((x) => x.id === d.id);
  if (!alvo) return json({ erro: "esse serviço não existe" }, 400);
  const r = await medidor(env, s.conta).pedir("minha_conta");
  // Parte da ordem pendente (se houver) ou do que o PAULUS contou.
  const base = r.google_pendente ? r.google_pendente.ligados : ((r.google && r.google.escopos) || []);
  const ligados = new Set(SERVICOS_G.filter((x) => base.some((e) => String(e).includes(x.escopo))).map((x) => x.escopo));
  if (d.ligado) ligados.add(alvo.escopo);
  else ligados.delete(alvo.escopo);
  await medidor(env, s.conta).pedir("google_ordem", { ligados: [...ligados] });
  return json({ ok: true, ligados: [...ligados] });
}

async function convidar(request, env, s, deps) {
  const d = (await lerJSON(request)) || {};
  const email = String(d.email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 120) return json({ erro: "o e-mail não confere" }, 400);
  if (email === s.email) return json({ erro: "esse é o e-mail do titular" }, 400);
  if (!env.RESEND_API_KEY) return json({ erro: "o convite vai por e-mail, e o e-mail do Paulus ainda não está ligado" }, 503);
  const token = aleatorio(24);
  const h = await sha256(token);
  const ate = new Date(Date.now() + CONVITE_MS).toISOString();
  const r = await medidor(env, s.conta).pedir("pessoa_convidar", { email, hash: h, ate, por: s.email });
  if (!r.ok) return json({ erro: r.erro }, r.status || 409);
  await env.APOIOS.put("conta:convite:" + h, JSON.stringify({ conta: s.conta, email }), { expirationTtl: Math.round(CONVITE_MS / 1000) });
  const atual = await medidor(env, s.conta).pedir("minha_conta");
  const escritorio = (atual.cadastro && atual.cadastro.nome_escritorio) || atual.nome || "o escritório";
  const e = await (deps.enviarEmail || enviarEmail)(env, {
    para: email, assunto: "Convite para a Minha conta do Paulus", titulo: "Você foi convidado para a conta de " + escritorio,
    texto: s.email + " convidou você para acompanhar a assinatura do Paulus de " + escritorio + " como financeiro: o resumo, o consumo, as faturas e a forma de pagamento." +
      "\n\nEntre com este e-mail, pelo Google ou com e-mail e senha. O link vale por 7 dias.",
    botao: "Abrir a Minha conta", link: SITE + "/minha-conta/#convite=" + token,
  });
  if (!e.ok) {
    await medidor(env, s.conta).pedir("pessoa_remover", { email });
    await env.APOIOS.delete("conta:convite:" + h);
    return json({ erro: e.erro || "o e-mail do convite não saiu" }, e.status || 502);
  }
  return json({ ok: true, email, ate });
}

async function removerPessoa(env, s, email) {
  const r = await medidor(env, s.conta).pedir("pessoa_remover", { email });
  if (!r.ok) return json({ erro: r.erro }, r.status || 404);
  const idx = await kvJSON(env, "conta:pessoa:" + email);
  if (idx && idx.conta === s.conta) await env.APOIOS.delete("conta:pessoa:" + email);
  return json({ ok: true });
}

/* As NFS-e do ano num .zip (PDF e XML de cada uma), sem compressao. */
async function zipDoAno(env, conta, anoTexto) {
  const ano = /^\d{4}$/.test(String(anoTexto || "")) ? String(anoTexto) : String(new Date().getUTCFullYear());
  const notas = (await notasDoCliente(env, conta)).filter((x) => String(x.competencia || x.emitida_em || "").startsWith(ano));
  const arquivos = [];
  for (const x of notas) {
    for (const tipo of ["pdf", "xml"]) {
      const b64 = await env.APOIOS.get("nfse:nota-" + tipo + ":" + conta + ":" + x.id);
      if (b64) arquivos.push({ nome: "NFS-e " + (x.numero || x.id) + "." + tipo, bytes: deB64(b64) });
    }
  }
  if (!arquivos.length) return json({ erro: "não há NFS-e de " + ano + " nesta conta" }, 404);
  return new Response(zip(arquivos), { status: 200, headers: { "content-type": "application/zip",
    "content-disposition": 'attachment; filename="NFS-e PAVLVS ' + ano + '.zip"', "cache-control": "no-store" } });
}

// ------------------------------------------------------------ o .zip

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* Um .zip "store" (sem compressao): os cabecalhos locais, o diretorio central e o fim. */
export function zip(arquivos) {
  const partes = [];
  const central = [];
  let pos = 0;
  for (const a of arquivos) {
    const nome = new TextEncoder().encode(a.nome);
    const crc = crc32(a.bytes);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // nomes em UTF-8
    local.setUint32(14, crc, true);
    local.setUint32(18, a.bytes.length, true);
    local.setUint32(22, a.bytes.length, true);
    local.setUint16(26, nome.length, true);
    partes.push(new Uint8Array(local.buffer), nome, a.bytes);
    const cab = new DataView(new ArrayBuffer(46));
    cab.setUint32(0, 0x02014b50, true);
    cab.setUint16(4, 20, true);
    cab.setUint16(6, 20, true);
    cab.setUint16(8, 0x0800, true);
    cab.setUint32(16, crc, true);
    cab.setUint32(20, a.bytes.length, true);
    cab.setUint32(24, a.bytes.length, true);
    cab.setUint16(28, nome.length, true);
    cab.setUint32(42, pos, true);
    central.push(new Uint8Array(cab.buffer), nome);
    pos += 30 + nome.length + a.bytes.length;
  }
  const tamCentral = central.reduce((t, x) => t + x.length, 0);
  const fim = new DataView(new ArrayBuffer(22));
  fim.setUint32(0, 0x06054b50, true);
  fim.setUint16(8, arquivos.length, true);
  fim.setUint16(10, arquivos.length, true);
  fim.setUint32(12, tamCentral, true);
  fim.setUint32(16, pos, true);
  const tudo = [...partes, ...central, new Uint8Array(fim.buffer)];
  const saida = new Uint8Array(tudo.reduce((t, x) => t + x.length, 0));
  let i = 0;
  for (const x of tudo) {
    saida.set(x, i);
    i += x.length;
  }
  return saida;
}

// ------------------------------------------------------------ utilidades

function json(dados, status = 200, extra = {}) {
  return new Response(JSON.stringify(dados), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra } });
}

async function lerJSON(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function kvJSON(env, chave) {
  const t = await env.APOIOS.get(chave);
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

async function sha256(texto) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function aleatorio(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function cookie(valor, maxAge) {
  return COOKIE + "=" + valor + "; Path=/; Max-Age=" + maxAge + "; HttpOnly; Secure; SameSite=Lax";
}

function cookieDe(request, nome) {
  const bruto = request.headers.get("cookie") || "";
  for (const parte of bruto.split(";")) {
    const [k, ...v] = parte.trim().split("=");
    if (k === nome) return v.join("=");
  }
  return "";
}

/* Os POST da Minha conta so valem da propria pagina: a origem do pedido e a do site. */
function mesmaOrigem(request, url) {
  const o = request.headers.get("origin");
  return !o || o === url.origin || o === SITE;
}

/* O nome que o Google pos no id_token (ja conferido por donoDoToken). */
function nomeDoToken(token) {
  try {
    const p = String(token).split(".")[1];
    const info = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(p.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((p.length + 3) % 4)), (c) => c.charCodeAt(0))));
    return String(info.name || "").replace(/[\u0000-\u001f<>]/g, "").slice(0, 80);
  } catch {
    return "";
  }
}

function mascarar(email) {
  const [u, d] = String(email).split("@");
  return (u || "").slice(0, 2) + "…@" + (d || "");
}

function brt(t) {
  return new Date(t - 3 * 3600 * 1000).toISOString();
}

function dataBR(iso) {
  const t = Date.parse(iso || "");
  return Number.isFinite(t) ? brt(t).slice(0, 10).split("-").reverse().join("/") : "";
}

function dataHoraBR(iso) {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) return "—";
  const b = brt(t);
  return b.slice(8, 10) + "/" + b.slice(5, 7) + " " + b.slice(11, 16);
}

function menosUmMes(ms) {
  const d = new Date(ms);
  const dia = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() - 1);
  if (d.getUTCDate() < dia) d.setUTCDate(0);
  return d.getTime();
}

function docParaTela(d) {
  const x = String(d || "");
  if (x.length === 11) return x.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
  if (x.length === 14) return x.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5");
  return x;
}

function telParaTela(t) {
  const x = String(t || "");
  if (x.length === 11) return x.replace(/(\d{2})(\d{5})(\d{4})/, "($1) $2-$3");
  if (x.length === 10) return x.replace(/(\d{2})(\d{4})(\d{4})/, "($1) $2-$3");
  return x;
}

function deB64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
