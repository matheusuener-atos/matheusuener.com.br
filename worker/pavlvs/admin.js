// O painel de administracao do PAVLVS (paulus.ia.br/admin; o contrato das
// rotas esta em worker/admin-api.md). A equipe ve as contas da nuvem, os
// tuneis do acesso externo (com o registro de enderecos), as nao renovacoes,
// as campanhas de e-mail, os tokens e a receita, os planos, as notas fiscais
// e a propria equipe.
//
// As notas fiscais (NFS-e do PAVLVS) sao emitidas daqui: /api/admin/nfse/emissor/*
// vai ao emissor da nuvem (worker/nfse/api.js, o Durable Object EmissorNFSe),
// atras do mesmo Access; dono e financeiro emitem e configuram, suporte
// so le. Essas acoes sao na hora (nao passam pela fila de alteracoes).
//
// Nenhuma senha:
//   1. Cloudflare Access na frente de /admin e /api/admin (e-mail da equipe,
//      codigo de uso unico). Aqui o Worker confere o JWT que o Access poe em
//      cada pedido - sem ele, nada passa (e sem ACCESS_TEAM/ACCESS_AUD
//      configurados o painel fica fechado).
//   2. A sessao (cookie pv_admin, 24 h, no KV APOIOS "admin:sessao:<id>")
//      nasce do Access, na primeira leitura de /api/admin/sessao. O login
//      social do GitHub (conta com escrita no repositorio) so e pedido para
//      "Comitar e pushar" e para retroagir: sem ele, essas duas rotas
//      respondem 403 com passo "github".
// O papel (dono, financeiro, suporte) vem de ADMIN_EQUIPE (JSON) ou, depois de
// publicado pelo painel, de "admin:equipe" no KV.
//
// O que muda o que esta no ar nao acontece na hora: entra na fila da pessoa
// ("admin:pendentes:<email>") e so e aplicado em "Commitar e pushar"
// (POST /api/admin/publicar, com a frase digitada). Comunicacao (lembrete,
// mensagem, aviso, e-mail de teste, reenviar convite) e marcacao (tratada)
// sao na hora. Cada publicacao guarda o retrato do que ela mudou
// ("admin:retrato:<id>", 30 dias): e com ele que o dono retroage
// (POST /api/admin/retroagir) o que da para desfazer.
//
// Fora do Access ficam so o rastreio dos e-mails (/api/e/*), a pagina do
// convite da equipe (/api/equipe/convite: quem foi convidado ainda nao esta
// na politica do Access) e os textos dos planos que a pagina de assinatura le
// (/api/planos/textos). Aceito o convite, o Worker poe o e-mail na politica
// de permitir da aplicacao do painel (a do ACCESS_AUD) pela API da Cloudflare
// (CF_ACCESS_TOKEN e CF_ACCOUNT_ID); sem eles, a pagina e o painel dizem que
// isso e a mao.
//
// Tudo no KV APOIOS com o prefixo "admin:". O envio de e-mail e pelo Resend
// (RESEND_API_KEY); sem a chave, as rotas de e-mail dizem que falta.

import {
  MODELOS, NIVEIS, PLANOS_DE_FABRICA, PLANO_PADRAO, TOLERANCIA_MS, conferirCadastro, devolverPagamento, medidor, modelosDoPlano, numeros, ofertaDeVolta,
  planoDe,
} from "./ia.js";
import { conferirTextos, guardarTextos, textosDoPlano, textosPadrao } from "./planos-textos.js";
import {
  listarParaAdmin, enderecosLivres, motivoDoEnderecoNovo, alterarEndereco, ativarEndereco, liberarEndereco,
  anotarHistorico, cfConfigurado, registroDeEnderecos,
} from "./tunel.js";
import { atenderEmissor, chamar as chamarEmissor, faltaDoEmissor, resumoParaPainel, PREFIXO as PREFIXO_EMISSOR } from "./nfse/api.js";
import { buscarMunicipios } from "./nfse/tabelas.js";

const REPO = "matheusuener-atos/coryphaeus";
const RAMO = "main";
const SITE = "https://paulus.ia.br";
const DE_EMAIL = "PAVLVS <naoresponda@paulus.ia.br>";
const SESSAO_S = 24 * 3600;
const DIA_MS = 24 * 3600 * 1000;
const CONFIRMACAO = "comitar e pushar";
const PAPEIS = ["dono", "financeiro", "suporte"];
const NOME_DO_PAPEL = { dono: "Dono", financeiro: "Financeiro", suporte: "Suporte" };
const TODOS = PAPEIS;
const RITMO_POR_MINUTO = 50;
// O convite da equipe vale 7 dias; reenviar troca o link e conta 7 de novo.
const CONVITE_MS = 7 * DIA_MS;
// O retrato do que uma publicacao mudou (para retroagir) vence em 30 dias.
const RETRATO_S = 30 * 24 * 3600;
const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Os planos pagos de uma vez (anual, mes no Pix): sem cobranca recorrente no Mercado Pago.
const prepago = (periodo) => periodo === "anual" || periodo === "avulso";

// Quem pode o que (o painel mostra a mesma matriz em Equipe).
const PODE = {
  "conta.creditar": ["dono", "financeiro"],
  "conta.instalacao.apagar": ["dono", "suporte"],
  "conta.cancelar": ["dono", "financeiro"],
  "conta.reembolsar": ["dono", "financeiro"],
  "conta.plano": ["dono", "financeiro"],
  "conta.pausar": ["dono", "financeiro"],
  "conta.cadastro": TODOS,
  "google.servicos": ["dono", "suporte"],
  "google.desvincular": ["dono", "suporte"],
  "tunel.apagar": ["dono", "suporte"],
  "tunel.endereco": ["dono", "suporte"],
  "tunel.ativo": ["dono", "suporte"],
  "campanha.disparar": TODOS,
  "renov.oferta": ["dono", "financeiro"],
  "campanha.cancelar": TODOS,
  "plano.editar": ["dono", "financeiro"],
  "plano.criar": ["dono", "financeiro"],
  "planos.json": ["dono", "financeiro"],
  "nfse.config": ["dono", "financeiro"],
  "equipe.papel": ["dono"],
  "equipe.membro": ["dono"],
};
// O emissor de NFS-e (/api/admin/nfse/emissor/*, na hora): quem emite,
// cancela, substitui e configura. Os outros papeis so leem (GET).
const PODE_NFSE = ["dono", "financeiro"];
export const MATRIZ = [
  ["Ver contas, tokens e receita", TODOS],
  ["Mandar e-mails e lembretes", TODOS],
  ["Editar o cadastro de uma conta", TODOS],
  ["Revogar o Google e desvincular instalações", ["dono", "suporte"]],
  ["Apagar e mudar túneis", ["dono", "suporte"]],
  ["Planos", ["dono", "financeiro"]],
  ["Cancelar assinatura, reembolsar pagamentos e creditar tokens", ["dono", "financeiro"]],
  ["Trocar o plano de uma conta, pausar a cobrança e oferecer a volta", ["dono", "financeiro"]],
  ["Ver as notas fiscais e baixar PDF e XML", TODOS],
  ["Emitir, cancelar e substituir notas fiscais; certificado e parâmetros", PODE_NFSE],
  ["Convidar, editar e tirar pessoas da equipe; mudar papéis", ["dono"]],
  ["Retroagir uma publicação", ["dono"]],
];

// ---------------------------------------------------------------- entrada

export function ehRotaDoAdmin(url) {
  return url.pathname.startsWith("/api/admin/") || url.pathname.startsWith("/api/e/") || url.pathname === "/api/equipe/convite" || url.pathname === "/api/planos/textos";
}

export async function atenderAdmin(request, env, url, ctx, deps = {}) {
  const p = url.pathname;
  const m = request.method;
  // Fora do Access: o rastreio dos e-mails, o convite da equipe e os textos dos planos (a pagina de assinatura).
  if (p.startsWith("/api/e/")) return rastreio(env, url);
  if (p === "/api/planos/textos") return m === "GET" ? textosDosPlanos(env) : json({ erro: "rota não existe" }, 404);
  if (!env.APOIOS) return json({ erro: "o painel precisa do KV APOIOS" }, 503);
  if (p === "/api/equipe/convite") return conviteDaEquipe(request, env, url, deps);

  const access = await conferirAccess(request, env, deps);
  if (p === "/api/admin/sessao" && m === "GET") return sessaoAtual(request, env, access);
  if (!access.ok) return json({ erro: access.erro, passo: "access" }, access.status || 401);
  const membro = await membroDaEquipe(env, access.email);
  if (!membro) return json({ erro: "o e-mail " + access.email + " não está na equipe do painel", passo: "access" }, 403);
  if (p === "/api/admin/github/entrar" && m === "GET") return githubEntrar(env, access, url);
  if (p === "/api/admin/github/retorno" && m === "GET") return githubRetorno(env, url, access, membro, deps);

  const sessao = await sessaoDoCookie(request, env, access);
  if (!sessao) return json({ erro: "a sessão do painel venceu: recarregue a página", passo: "sessao" }, 401);
  const quem = { email: access.email, nome: membro.nome || "", papel: membro.papel, login: sessao.login, token: sessao.token, sessao };
  if (p === "/api/admin/sair" && m === "POST") {
    await env.APOIOS.delete("admin:sessao:" + sessao.id);
    return json({ ok: true, logout: "/cdn-cgi/access/logout" }, 200, { "set-cookie": cookie("", 0) });
  }
  const c = { env, deps, quem, ctx, agora: (deps.agora || Date.now)() };
  try {
    return await rotear(c, request, url, p, m);
  } catch (e) {
    return json({ erro: String((e && e.message) || e).slice(0, 300) }, 500);
  }
}

async function rotear(c, request, url, p, m) {
  // O emissor de NFS-e: na hora, sem a fila. GET para todos; o resto, dono e financeiro.
  if (p.startsWith(PREFIXO_EMISSOR)) {
    if (m !== "GET" && !PODE_NFSE.includes(c.quem.papel)) {
      return json({ erro: "o papel " + c.quem.papel + " só vê as notas fiscais: emitir, cancelar e configurar são do dono e do financeiro" }, 403);
    }
    const falta = faltaDoEmissor(c.env);
    // A busca de município é só a tabela: funciona com o emissor desligado.
    if (falta && !(m === "GET" && p === PREFIXO_EMISSOR + "municipios")) return json({ erro: "o emissor de NFS-e ainda não está ligado: " + falta }, 503);
    return atenderEmissor(request, c.env, c.ctx, { quem: c.quem.email, prefixo: PREFIXO_EMISSOR });
  }
  if (m === "GET") {
    if (p === "/api/admin/visao") return json(await visao(c));
    if (p === "/api/admin/contas") return json(await contasParaTela(c));
    let r = p.match(/^\/api\/admin\/contas\/([0-9a-f]{24})$/);
    if (r) return json(await contaParaTela(c, r[1]));
    if (p === "/api/admin/tuneis") return json(await tuneisParaTela(c));
    if (p === "/api/admin/tuneis/disponivel") {
      const nome = String(url.searchParams.get("nome") || "").trim().toLowerCase();
      const motivo = await motivoDoEnderecoNovo(c.env, nome);
      return json({ ok: !motivo, motivo: motivo || "disponível · CNAME livre na zona" });
    }
    if (p === "/api/admin/renovacoes") return json(await renovacoes(c));
    if (p === "/api/admin/campanhas") return json(await campanhasParaTela(c));
    if (p === "/api/admin/tokens") {
      const visaoPedida = url.searchParams.get("visao") || "geral";
      if (!["geral", "modelo", "escritorio", "conta"].includes(visaoPedida)) return json({ erro: "visão desconhecida: " + visaoPedida }, 400);
      const per = periodoDosTokens(url.searchParams, c.agora);
      if (per.erro) return json({ erro: per.erro }, 400);
      return json(await tokens(c, visaoPedida, per));
    }
    if (p === "/api/admin/planos") return json(await planos(c));
    if (p === "/api/admin/nfse") return json(await nfse(c));
    if (p === "/api/admin/equipe") return json(await equipe(c));
    if (p === "/api/admin/busca") return json(await busca(c, url.searchParams.get("q") || ""));
    if (p === "/api/admin/alteracoes") return json(await alteracoes(c));
  }
  if (m === "POST") {
    const d = (await lerJSON(request)) || {};
    if (p === "/api/admin/alteracoes") return enfileirar(c, d);
    if ((p === "/api/admin/publicar" || p === "/api/admin/retroagir") && !c.quem.token) {
      return json({ erro: "para " + (p.endsWith("publicar") ? "comitar e pushar" : "retroagir") + ", entre com o GitHub (a conta precisa ter escrita no repositório)", passo: "github" }, 403);
    }
    if (p === "/api/admin/publicar") return publicar(c, d);
    if (p === "/api/admin/retroagir") return retroagir(c, d);
    if (p === "/api/admin/sessoes/encerrar") return encerrarSessoes(c.env, c.quem);
    let r = p.match(/^\/api\/admin\/tuneis\/([a-z0-9-]{3,24})\/avisar$/);
    if (r) return avisarTunel(c, r[1]);
    r = p.match(/^\/api\/admin\/renovacoes\/([0-9a-f]{24})\/(lembrete|tratar|reabrir)$/);
    if (r) return acaoDeRenovacao(c, r[1], r[2]);
    r = p.match(/^\/api\/admin\/renovacoes\/([0-9a-f]{24})\/mensagem$/);
    if (r) return mensagemDeRenovacao(c, r[1], d);
    if (p === "/api/admin/renovacoes/config") return configRenovacoes(c, d);
    if (p === "/api/admin/campanhas/teste") return campanhaTeste(c, d.campanha || d);
    r = p.match(/^\/api\/admin\/equipe\/convite\/([^/]{3,200})\/reenviar$/);
    if (r) return reenviarConvite(c, decodificar(r[1]).trim().toLowerCase());
  }
  if (m === "DELETE") {
    const r = p.match(/^\/api\/admin\/alteracoes\/([a-z0-9]{6,32})$/);
    if (r) return tirarDaFila(c, r[1]);
  }
  return json({ erro: "rota não existe" }, 404);
}

// ------------------------------------------------------------- utilidades

function json(dados, status = 200, extra = {}) {
  return new Response(JSON.stringify(dados), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });
}

async function lerJSON(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function aleatorio(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function decodificar(s) {
  try {
    return decodeURIComponent(String(s || ""));
  } catch {
    return "";
  }
}

function iso(ms) {
  return new Date(ms).toISOString();
}

/* "dd/mm/aaaa" do instante, no horario de Brasilia. */
function dataBR(quando) {
  const ms = typeof quando === "number" ? quando : Date.parse(quando || "");
  return Number.isFinite(ms) ? diaBRT(ms).split("-").reverse().join("/") : "";
}

/* "dd/mm/aaaa às hh:mm", no horario de Brasilia. */
function dataHoraBR(ms) {
  return dataBR(ms) + " às " + new Date(ms - 3 * 3600 * 1000).toISOString().slice(11, 16);
}

/* "a, b e c". */
function juntar(lista) {
  return lista.length < 2 ? lista.join("") : lista.slice(0, -1).join(", ") + " e " + lista[lista.length - 1];
}

function primeiroNome(nome) {
  return String(nome || "").trim().split(/\s+/)[0] || "";
}

/* O nome de uma pessoa para o e-mail e a tela: sem controle nem < > ". */
function nomeLimpo(t, max = 80) {
  return String(t || "").replace(/[\u0000-\u001f<>"]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function semAcento(t) {
  return String(t || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
}

async function sha256Hex(texto) {
  const r = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(texto)));
  return [...new Uint8Array(r)].map((b) => b.toString(16).padStart(2, "0")).join("");
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

function cookie(valor, maxAge) {
  return "pv_admin=" + valor + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=" + maxAge;
}

function cookies(request) {
  const saida = {};
  for (const parte of String(request.headers.get("cookie") || "").split(";")) {
    const i = parte.indexOf("=");
    if (i > 0) saida[parte.slice(0, i).trim()] = parte.slice(i + 1).trim();
  }
  return saida;
}

function b64urlBytes(s) {
  const b = atob(String(s).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((String(s).length + 3) % 4));
  return Uint8Array.from(b, (ch) => ch.charCodeAt(0));
}

function mesBRT(ms) {
  return new Date(ms - 3 * 3600 * 1000).toISOString().slice(0, 7);
}

function diaBRT(ms) {
  return new Date(ms - 3 * 3600 * 1000).toISOString().slice(0, 10);
}

function brl(v) {
  return "R$ " + Number(v || 0).toLocaleString("pt-BR", { minimumFractionDigits: Number(v) % 1 ? 2 : 0, maximumFractionDigits: 2 });
}

function precos(env) {
  let p = {};
  try {
    p = JSON.parse(env.IA_PRECOS || "{}");
  } catch {
    p = {};
  }
  const n = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return { entrada: n(p.entrada, 0.23), saida: n(p.saida, 0.4), cambio: n(env.IA_CAMBIO || p.cambio, 5.6) };
}

/* O custo em dolar: pelo preco do modelo, quando se sabe qual (MODELOS, em
   worker/ia.js); sem modelo (o uso de antes do registro por modelo), pelo
   IA_PRECOS. */
function custoUSD(env, entrada, saida, modelo) {
  const m = modelo && MODELOS[modelo];
  const pr = m ? { entrada: m.usd[0], saida: m.usd[1] } : precos(env);
  return (entrada / 1e6) * pr.entrada + (saida / 1e6) * pr.saida;
}

/* O custo de um uso com o detalhe por modelo: cada modelo no preco dele, o resto no IA_PRECOS. */
function custoDoUso(env, uso) {
  let entrada = uso.entrada || 0;
  let saida = uso.saida || 0;
  let total = 0;
  for (const [nome, x] of Object.entries(uso.modelos || {})) {
    total += custoUSD(env, x.entrada || 0, x.saida || 0, nome);
    entrada -= x.entrada || 0;
    saida -= x.saida || 0;
  }
  return total + custoUSD(env, Math.max(0, entrada), Math.max(0, saida));
}

// ------------------------------------------------------------- as portas

/* O JWT do Cloudflare Access (RS256), conferido com as chaves do time. */
async function conferirAccess(request, env, deps) {
  if (!env.ACCESS_TEAM || !env.ACCESS_AUD) {
    return { ok: false, status: 503, erro: "o Cloudflare Access do painel ainda não foi configurado (ACCESS_TEAM e ACCESS_AUD)" };
  }
  const token = request.headers.get("cf-access-jwt-assertion") || cookies(request).CF_Authorization || "";
  const partes = token.split(".");
  if (partes.length !== 3) return { ok: false, erro: "entre pelo Cloudflare Access" };
  let cab, corpo;
  try {
    cab = JSON.parse(new TextDecoder().decode(b64urlBytes(partes[0])));
    corpo = JSON.parse(new TextDecoder().decode(b64urlBytes(partes[1])));
  } catch {
    return { ok: false, erro: "a sessão do Cloudflare Access não confere" };
  }
  const time = String(env.ACCESS_TEAM).replace(/^https?:\/\//, "").replace(/\/$/, "");
  const agora = (deps.agora || Date.now)() / 1000;
  const auds = Array.isArray(corpo.aud) ? corpo.aud : [corpo.aud];
  if (cab.alg !== "RS256" || !auds.includes(env.ACCESS_AUD) || corpo.iss !== "https://" + time || !(corpo.exp > agora) || !corpo.email) {
    return { ok: false, erro: "a sessão do Cloudflare Access venceu ou não é deste painel" };
  }
  const chaves = await (deps.chavesDoAccess || chavesDoAccess)(time);
  const jwk = (chaves || []).find((k) => k.kid === cab.kid);
  if (!jwk) return { ok: false, erro: "a sessão do Cloudflare Access não confere" };
  try {
    const chave = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", chave, b64urlBytes(partes[2]), new TextEncoder().encode(partes[0] + "." + partes[1]));
    if (!ok) return { ok: false, erro: "a sessão do Cloudflare Access não confere" };
  } catch {
    return { ok: false, erro: "a sessão do Cloudflare Access não confere" };
  }
  return { ok: true, email: String(corpo.email).toLowerCase() };
}

let CHAVES_CACHE = { quando: 0, time: "", chaves: null };
async function chavesDoAccess(time) {
  if (CHAVES_CACHE.chaves && CHAVES_CACHE.time === time && Date.now() - CHAVES_CACHE.quando < 3600 * 1000) return CHAVES_CACHE.chaves;
  const r = await fetch("https://" + time + "/cdn-cgi/access/certs");
  const d = r.ok ? await r.json() : {};
  CHAVES_CACHE = { quando: Date.now(), time, chaves: d.keys || [] };
  return CHAVES_CACHE.chaves;
}

export async function listaDaEquipe(env) {
  const doKV = await kvJSON(env, "admin:equipe", null);
  if (Array.isArray(doKV) && doKV.length) return doKV;
  try {
    const l = JSON.parse(env.ADMIN_EQUIPE || "[]");
    return Array.isArray(l) ? l : [];
  } catch {
    return [];
  }
}

async function membroDaEquipe(env, email) {
  const lista = await listaDaEquipe(env);
  const m = lista.find((x) => String(x.email || "").toLowerCase() === String(email || "").toLowerCase());
  if (!m || !PAPEIS.includes(m.papel)) return null;
  return { email: String(m.email).toLowerCase(), nome: m.nome || "", papel: m.papel };
}

async function sessaoDoCookie(request, env, access) {
  const id = cookies(request).pv_admin || "";
  if (!/^[0-9a-f]{48}$/.test(id)) return null;
  const s = await kvJSON(env, "admin:sessao:" + id, null);
  if (!s || s.email !== access.email) return null;
  return { ...s, id };
}

function configuracao(env) {
  const cfg = (ligado, falta) => ({ ligado: Boolean(ligado), falta: ligado ? "" : falta });
  return {
    access: cfg(env.ACCESS_TEAM && env.ACCESS_AUD, "falta ACCESS_TEAM e ACCESS_AUD"),
    github: cfg(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET, "falta o OAuth App do GitHub (GITHUB_CLIENT_ID e GITHUB_CLIENT_SECRET)"),
    email: cfg(env.RESEND_API_KEY, "o envio de e-mail ainda não está ligado: falta RESEND_API_KEY"),
    // O emissor de NFS-e da nuvem (worker/nfse/api.js): o DO e a chave mestra.
    nfse: cfg(!faltaDoEmissor(env), "o emissor de NFS-e ainda não está ligado: " + faltaDoEmissor(env)),
    tuneis: cfg(cfConfigurado(env), "falta a chave da Cloudflare (CF_API_TOKEN, CF_ACCOUNT_ID, CF_ZONE_ID)"),
    mercado_pago: cfg(env.MP_ACCESS_TOKEN, "falta MP_ACCESS_TOKEN"),
    nuvem: cfg(env.IA_ATIVA === "1" && env.CONTAS_IA, "a nuvem do Paulus está desligada (IA_ATIVA)"),
    // A liberacao do convidado no Cloudflare Access (a politica do painel, pela API).
    equipe: cfg(accessConfigurado(env), "a liberação no Cloudflare Access ainda é à mão: " + faltaDoAccess(env) +
      ". Quem aceitar o convite entra na equipe, mas o e-mail dela precisa ser incluído na política do Access do painel pelo dono."),
  };
}

// ------------------------------------------- o Cloudflare Access (a API)

/* O que falta para o Worker mexer na politica do Access do painel ("" se nada). A
   politica e achada pela aplicacao do painel (ACCESS_AUD); ACCESS_POLICY_ID so
   escolhe quando a aplicacao tem mais de uma politica de permitir. */
function faltaDoAccess(env) {
  const falta = ["CF_ACCESS_TOKEN", "CF_ACCOUNT_ID"].filter((k) => !env[k]);
  if (!env.ACCESS_POLICY_ID && !env.ACCESS_AUD) falta.push("ACCESS_AUD");
  return falta.length ? "falta " + juntar(falta) : "";
}

function accessConfigurado(env) {
  return !faltaDoAccess(env);
}

/* A API da Cloudflare com o token do Access (CF_ACCESS_TOKEN): o result, ou erro com a frase (e o status). */
async function chamarCloudflare(env, metodo, caminho, corpo) {
  const r = await fetch("https://api.cloudflare.com/client/v4" + caminho, {
    method: metodo,
    headers: { Authorization: "Bearer " + env.CF_ACCESS_TOKEN, "Content-Type": "application/json" },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  let d = {};
  try {
    d = await r.json();
  } catch {
    d = {};
  }
  if (!r.ok || d.success === false) {
    const msg = (d.errors && d.errors[0] && d.errors[0].message) || "HTTP " + r.status;
    const erro = new Error("a Cloudflare recusou (" + msg + ")");
    erro.status = r.status;
    throw erro;
  }
  return d.result;
}

// A politica de permitir do painel no Access. A que o painel da Cloudflare cria hoje e
// "reutilizavel": mora na conta (/access/policies/{id}), e a API recusa muda-la pelo
// caminho da aplicacao ("can not update reusable policies through this endpoint"). A
// antiga, presa a aplicacao, so muda por /access/apps/{app}/policies/{id}. Sem
// ACCESS_POLICY_ID, vale a unica politica de permitir da aplicacao do ACCESS_AUD.
async function politicaDoPainel(env) {
  const conta = "/accounts/" + env.CF_ACCOUNT_ID + "/access";
  const aplicacao = async () => {
    const lista = await chamarCloudflare(env, "GET", conta + "/apps?aud=" + encodeURIComponent(env.ACCESS_AUD || ""));
    const achada = (Array.isArray(lista) ? lista : []).find((a) => a && a.aud && a.aud === env.ACCESS_AUD);
    if (!achada) throw new Error("a aplicação do painel (ACCESS_AUD) não está no Cloudflare Access desta conta");
    return achada;
  };
  let app = env.ACCESS_APP_ID || "";
  let id = env.ACCESS_POLICY_ID || "";
  if (!id) {
    const painel = await aplicacao();
    app = app || painel.id;
    const permitir = (Array.isArray(painel.policies) ? painel.policies : []).filter((p) => p && p.decision === "allow");
    if (permitir.length !== 1) {
      throw new Error(permitir.length ? "a aplicação do painel tem " + permitir.length + " políticas de permitir no Access: diga qual em ACCESS_POLICY_ID"
        : "a aplicação do painel não tem política de permitir no Access");
    }
    id = permitir[0].id;
  }
  const reutilizavel = conta + "/policies/" + id;
  try {
    return { caminho: reutilizavel, antiga: false, atual: (await chamarCloudflare(env, "GET", reutilizavel)) || {} };
  } catch (e) {
    // A antiga nao existe no caminho da conta: tenta o da aplicacao.
    if (e.status !== 404 && e.status !== 400) throw e;
  }
  if (!app) app = (await aplicacao()).id;
  const caminho = conta + "/apps/" + app + "/policies/" + id;
  return { caminho, antiga: true, atual: (await chamarCloudflare(env, "GET", caminho)) || {} };
}

// PUT com a politica inteira: o e-mail entra (ou sai) do include como {email: {email}},
// e o resto fica como esta. A precedencia so existe na antiga (na reutilizavel, e de
// cada aplicacao que a usa).
const CAMPOS_DA_POLITICA = ["session_duration", "approval_required", "approval_groups", "isolation_required",
  "purpose_justification_required", "purpose_justification_prompt", "mfa_config", "connection_rules"];

/* Poe (por = true) ou tira o e-mail da politica: {feito, frase}. Nunca lanca. */
async function politicaDoAccess(env, email, por) {
  if (!accessConfigurado(env)) return { feito: false, frase: "a liberação no Cloudflare Access é à mão (" + faltaDoAccess(env) + ")" };
  const alvo = String(email || "").toLowerCase();
  try {
    const { caminho, antiga, atual } = await politicaDoPainel(env);
    const include = Array.isArray(atual.include) ? atual.include : [];
    const eDele = (regra) => Boolean(regra && regra.email && String(regra.email.email || "").toLowerCase() === alvo);
    if (include.some(eDele) === por) return { feito: true, frase: por ? "o e-mail já estava liberado no Access" : "o e-mail já não estava na política do Access" };
    const novo = por ? [...include, { email: { email: alvo } }] : include.filter((x) => !eDele(x));
    // Uma politica de "permitir" sem ninguem fecharia o painel para todos.
    if (!novo.length) return { feito: false, frase: "tirar esse e-mail deixaria a política do Access vazia: tire à mão no painel da Cloudflare" };
    const corpo = { name: atual.name, decision: atual.decision || "allow", include: novo, exclude: atual.exclude || [], require: atual.require || [] };
    for (const k of CAMPOS_DA_POLITICA) if (atual[k] !== undefined && atual[k] !== null) corpo[k] = atual[k];
    if (antiga && atual.precedence !== undefined && atual.precedence !== null) corpo.precedence = atual.precedence;
    await chamarCloudflare(env, "PUT", caminho, corpo);
    return { feito: true, frase: por ? "o e-mail foi liberado no Cloudflare Access" : "o e-mail saiu da política do Cloudflare Access" };
  } catch (e) {
    return { feito: false, frase: String((e && e.message) || e).slice(0, 200) };
  }
}

/* Derruba as sessoes do Access de um e-mail (todos os aparelhos): {feito, frase}. Nunca lanca.
   Pede a permissao "Access: Organizations, Identity Providers, and Groups" (Edit) no token. */
async function revogarNoAccess(env, email) {
  if (!env.CF_ACCESS_TOKEN || !env.CF_ACCOUNT_ID) {
    return { feito: false, frase: "as sessões do Cloudflare Access continuam até vencer: falta " + juntar(["CF_ACCESS_TOKEN", "CF_ACCOUNT_ID"].filter((k) => !env[k])) };
  }
  try {
    await chamarCloudflare(env, "POST", "/accounts/" + env.CF_ACCOUNT_ID + "/access/organizations/revoke_user", { email: String(email || "").toLowerCase() });
    return { feito: true, frase: "as sessões do Cloudflare Access também saíram" };
  } catch (e) {
    return { feito: false, frase: "as sessões do Cloudflare Access continuam até vencer: " + String((e && e.message) || e).slice(0, 160) };
  }
}

/* GET /api/admin/sessao: com o Access e o e-mail na equipe, a sessao nasce aqui (sem o GitHub). */
async function sessaoAtual(request, env, access) {
  const membro = access.ok ? await membroDaEquipe(env, access.email) : null;
  let sessao = access.ok && membro ? await sessaoDoCookie(request, env, access) : null;
  let novo = null;
  if (access.ok && membro && !sessao) {
    sessao = await criarSessao(env, access.email, {});
    novo = cookie(sessao.id, SESSAO_S);
  }
  return json({
    access: { ok: Boolean(access.ok && membro), email: access.ok ? access.email : "", erro: access.ok ? (membro ? "" : "esse e-mail não está na equipe do painel") : access.erro },
    github: { ok: Boolean(sessao && sessao.token), login: sessao && sessao.login ? sessao.login : "" },
    papel: membro ? membro.papel : "", nome: membro ? membro.nome : "",
    worker: await versaoDoSite(env), pronto: Boolean(sessao), config: configuracao(env),
  }, 200, novo ? { "set-cookie": novo } : {});
}

/* Uma sessao nova do painel (com o GitHub, extra traz login e token): {id, ...}. */
async function criarSessao(env, email, extra) {
  const id = aleatorio(24);
  const s = { email, login: "", token: "", ...extra, criada: new Date().toISOString() };
  await env.APOIOS.put("admin:sessao:" + id, JSON.stringify(s), { expirationTtl: SESSAO_S });
  await env.APOIOS.put("admin:acesso:" + email, JSON.stringify({ ultimo: s.criada, login: s.login }));
  // O indice das sessoes da pessoa: e por ele que "Encerrar todas as sessoes" acha as dos outros aparelhos.
  const chave = "admin:sessoes:" + email;
  const ids = ((await kvJSON(env, chave, [])) || []).filter((x) => /^[0-9a-f]{48}$/.test(x));
  await env.APOIOS.put(chave, JSON.stringify([...ids.slice(-19), id]), { expirationTtl: SESSAO_S });
  return { ...s, id };
}

async function versaoDoSite(env) {
  try {
    const r = await env.ASSETS.fetch(new Request(SITE + "/atualizacao.json"));
    return r.ok ? String((await r.json()).versao || "") : "";
  } catch {
    return "";
  }
}

async function githubEntrar(env, access, url) {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) return json({ erro: "falta o OAuth App do GitHub (GITHUB_CLIENT_ID e GITHUB_CLIENT_SECRET)" }, 503);
  const state = aleatorio(16);
  // A tela para onde voltar (#alteracoes etc.): so um nome simples, nunca um endereco.
  const volta = /^[a-z-]{1,30}$/.test(String(url.searchParams.get("volta") || "")) ? url.searchParams.get("volta") : "";
  await env.APOIOS.put("admin:gh:" + state, JSON.stringify({ email: access.email, volta }), { expirationTtl: 600 });
  const q = new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID, redirect_uri: SITE + "/api/admin/github/retorno", scope: "public_repo read:user", state, allow_signup: "false" });
  return new Response(null, { status: 302, headers: { location: "https://github.com/login/oauth/authorize?" + q.toString(), "cache-control": "no-store" } });
}

function voltarComErro(frase) {
  return new Response(null, { status: 302, headers: { location: "/admin/?erro=" + encodeURIComponent(frase), "cache-control": "no-store" } });
}

async function githubRetorno(env, url, access, membro, deps) {
  const state = url.searchParams.get("state") || "";
  const code = url.searchParams.get("code") || "";
  const guardado = /^[0-9a-f]{32}$/.test(state) ? await kvJSON(env, "admin:gh:" + state, null) : null;
  if (!guardado || guardado.email !== access.email || !code) return voltarComErro("o login do GitHub venceu; tente de novo");
  await env.APOIOS.delete("admin:gh:" + state);
  const gh = deps.github || chamarGitHub;
  const t = await gh("POST", "https://github.com/login/oauth/access_token", null, {
    client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: SITE + "/api/admin/github/retorno",
  });
  const token = t.ok && t.dados && t.dados.access_token;
  if (!token) return voltarComErro("o GitHub não confirmou o login");
  const u = await gh("GET", "https://api.github.com/user", token);
  const login = u.ok && u.dados && u.dados.login;
  if (!login) return voltarComErro("o GitHub não disse quem é a conta");
  const perm = await gh("GET", "https://api.github.com/repos/" + REPO + "/collaborators/" + encodeURIComponent(login) + "/permission", token);
  const nivel = perm.ok && perm.dados ? String(perm.dados.permission || "") : "";
  if (!["admin", "write", "maintain"].includes(nivel)) return voltarComErro("a conta " + login + " não tem escrita em " + REPO);
  const { id } = await criarSessao(env, access.email, { login, token });
  const destino = "/admin/" + (guardado.volta ? "?github=1#" + guardado.volta : "");
  return new Response(null, { status: 302, headers: { location: destino, "set-cookie": cookie(id, SESSAO_S), "cache-control": "no-store" } });
}

/* Apaga as sessoes do painel de um e-mail (as do KV): as do indice e, para as
   de antes dele, uma volta na lista. Devolve quantas. */
async function apagarSessoesDe(env, email, alem = []) {
  const ids = new Set([...alem, ...(((await kvJSON(env, "admin:sessoes:" + email, [])) || []))].filter((x) => /^[0-9a-f]{48}$/.test(x)));
  for (const k of await kvPor(env, "admin:sessao:")) {
    const id = k.slice("admin:sessao:".length);
    if (ids.has(id)) continue;
    const s = await kvJSON(env, k, null);
    if (s && s.email === email) ids.add(id);
  }
  let apagadas = 0;
  for (const id of ids) {
    const s = await kvJSON(env, "admin:sessao:" + id, null);
    if (!s || s.email !== email) continue;
    await env.APOIOS.delete("admin:sessao:" + id);
    apagadas++;
  }
  await env.APOIOS.delete("admin:sessoes:" + email);
  return apagadas;
}

/* "Encerrar todas as sessoes" (Minha conta): todas as sessoes do painel da pessoa,
   esta tambem; com a chave da API do Access, as sessoes do Access dela tambem. */
async function encerrarSessoes(env, quem) {
  const encerradas = await apagarSessoesDe(env, quem.email, [quem.sessao.id]);
  const access = await revogarNoAccess(env, quem.email);
  return json({ ok: true, encerradas, access, logout: "/cdn-cgi/access/logout" }, 200, { "set-cookie": cookie("", 0) });
}

async function chamarGitHub(metodo, url, token, corpo) {
  const headers = { "User-Agent": "PAVLVS-admin", Accept: url.includes("/login/oauth/") ? "application/json" : "application/vnd.github+json" };
  if (token) headers.Authorization = "Bearer " + token;
  if (corpo) headers["Content-Type"] = "application/json";
  const r = await fetch(url, { method: metodo, headers, body: corpo ? JSON.stringify(corpo) : undefined });
  let dados = null;
  try {
    dados = await r.json();
  } catch {
    dados = null;
  }
  return { ok: r.ok, status: r.status, dados };
}

// ---------------------------------------------------------- as contas

/* As contas como o painel as monta, com o detalhe cru em _d (para o tomador
   das notas fiscais, worker/nfse-casa.js). */
export async function contasDaCasa(env, agora = Date.now()) {
  return lerContas({ env, agora });
}

/* Todas as contas da nuvem, com o detalhe de cada uma (um pedido por medidor). */
async function lerContas(c) {
  if (c._contas) return c._contas;
  const { env } = c;
  if (env.IA_ATIVA !== "1" || !env.CONTAS_IA) return (c._contas = []);
  const ids = (await kvPor(env, "admin:conta:")).map((k) => k.slice("admin:conta:".length)).filter((x) => /^[0-9a-f]{24}$/.test(x));
  const lidas = await Promise.all(ids.map((id) => medidor(env, id).pedir("admin_detalhe").catch(() => null)));
  c._contas = lidas.filter((x) => x && x.id && x.ok !== false).map((d) => montarConta(c, d));
  return c._contas;
}

function situacaoDe(d, agora) {
  const a = d.assinatura || {};
  if (d.cortesia && d.plano_vigente) return "cortesia";
  if (a.situacao === "cancelled") return "cancelada";
  const fim = d.ciclo ? Date.parse(d.ciclo.fim) : 0;
  if (fim && fim < agora) return "vencida";
  if (a.situacao === "authorized" && d.plano_vigente) return "ativa";
  return "pendente";
}

function montarConta(c, d) {
  const cad = d.cadastro || {};
  const ultimoUso = (d.uso || []).filter((u) => u.tokens > 0).map((u) => u.dia).pop() || null;
  return {
    id: d.id, nome: cad.nome_escritorio || d.nome || (d.email || "").split("@")[0], email: d.email || "",
    escritorio: { nome: cad.nome_escritorio || d.nome || "", slug: "", documento: cad.documento || "" },
    oab: cad.oab || "", plano: d.plano || null, situacao: situacaoDe(d, c.agora),
    restantes: (d.tokens || {}).restantes || 0, usados: (d.ciclo || {}).usados || 0, extra: (d.tokens || {}).da_recarga || 0,
    ultimo_uso: ultimoUso, google: d.google || null,
    _d: d,
  };
}

function publica(conta) {
  const { _d, ...resto } = conta;
  return resto;
}

/* O escritorio de cada conta: o endereco do acesso de fora da mesma conta Google
   (pelo dono do tunel) e, para agrupar, o CNPJ ou o nome do cadastro. */
async function comEscritorios(c, contas) {
  const tuneis = await lerTuneis(c);
  for (const conta of contas) {
    const t = tuneis.find((x) => x.responsavel && x.responsavel.toLowerCase() === conta.email.toLowerCase());
    if (t) conta.escritorio.slug = t.slug;
  }
  const grupos = new Map();
  const mes = mesBRT(c.agora);
  for (const conta of contas) {
    const chave = conta.escritorio.documento || conta.escritorio.slug || conta.escritorio.nome || conta.id;
    if (!grupos.has(chave)) grupos.set(chave, { nome: conta.escritorio.nome || conta.nome, slug: conta.escritorio.slug, documento: conta.escritorio.documento, contas: [], tokens_mes: 0, receita_mes: 0 });
    const g = grupos.get(chave);
    g.contas.push(conta.id);
    const um = (conta._d.uso_mes || {})[mes] || {};
    g.tokens_mes += (um.entrada || 0) + (um.saida || 0);
    g.receita_mes += (conta._d.pagamentos || []).filter((p) => mesBRT(Date.parse(p.quando)) === mes).reduce((s, p) => s + (Number(p.valor) || 0), 0);
    if (!g.slug && conta.escritorio.slug) g.slug = conta.escritorio.slug;
  }
  return [...grupos.values()];
}

async function contasParaTela(c) {
  const contas = await lerContas(c);
  const escritorios = await comEscritorios(c, contas);
  return { contas: contas.map(publica), escritorios };
}

async function contaParaTela(c, id) {
  const contas = await lerContas(c);
  await comEscritorios(c, contas);
  const conta = contas.find((x) => x.id === id);
  if (!conta) return { erro: "conta não encontrada" };
  const d = conta._d;
  const cad = d.cadastro || null;
  const end = (cad && cad.endereco) || {};
  const notas = await notasDaConta(c, id);
  const formas = await formasDosPagamentos(c, d);
  return {
    ...publica(conta), criada: d.criada, ciclo: d.ciclo || null,
    // O endereco vem achatado (cep, logradouro...), como a ficha e o "Editar cadastro" leem.
    cadastro: cad ? { documento: cad.documento, telefone: cad.telefone, oab: cad.oab, termos: cad.termos, quando: cad.quando,
      cep: end.cep || "", logradouro: end.logradouro || "", numero: end.numero || "", complemento: end.complemento || "", bairro: end.bairro || "",
      cidade: end.cidade || "", uf: end.uf || "", cmun: end.cmun || "", ajustado: cad.ajustado || null } : null,
    consentimento: d.consentimento || null, assinatura: d.assinatura || null, plano_proximo: d.plano_proximo || null,
    instalacoes: d.instalacoes_lista || [],
    pagamentos: (d.pagamentos || []).map((p) => ({ ...p, situacao: p.reembolso ? "reembolsado" : "pago", ...formas.get(String(p.ref)), nfse: notaDoPagamento(notas, p.ref) })),
    // O pagamento de uma vez que ainda nao foi confirmado (o Pix gerado, o anual em analise).
    pendentes: d.anual_pendente ? [{ tipo: /^ia-mes-/.test(String(d.anual_pendente.ref || "")) ? "avulso" : "anual", ref: d.anual_pendente.ref, valor: Number(d.anual_pendente.valor) || 0, quando: null, situacao: "pendente",
      forma: null, forma_falta: "o pagamento ainda não foi confirmado pelo Mercado Pago", plano: d.anual_pendente.plano || "" }] : [],
    recargas: d.recargas || [],
    google_pendente: d.google_pendente || null, desvinculado: d.desvinculado || null, pago_ate: d.pago_ate || null, periodo: d.periodo || "mensal",
  };
}

// ------------------------------------------------- a forma de cada pagamento
//
// O medidor guarda de cada pagamento so o tipo, a referencia, o valor e a data.
// A forma sai do que e certo: a recarga e o mes no Pix sao Pix; a mensalidade
// e o cartao da assinatura (a bandeira e o final, do cartao guardado na conta,
// para as cobrancas depois que ele foi posto). O resto - o anual, que pode ser
// no cartao ou no Pix, e a mensalidade de antes do cartao de agora - o Mercado
// Pago diz (/v1/payments e /authorized_payments), ate 6 consultas por ficha; a
// resposta fica em "admin:forma:<pagamento>" (so o tipo, a bandeira, o final e
// as parcelas; 400 dias). O que nao da para saber vem com forma_falta.
const FORMA_S = 400 * 24 * 3600;
const CONSULTAS_POR_FICHA = 6;

function bandeiraDe(metodo) {
  const m = String(metodo || "").toLowerCase();
  if (m === "master" || m === "debmaster") return "mastercard";
  if (m === "visa" || m === "debvisa") return "visa";
  return m ? m.charAt(0).toUpperCase() + m.slice(1) : "";
}

/* A forma pelo pagamento do Mercado Pago (/v1/payments/{id}). */
function formaDoMP(pg) {
  if (!pg || (!pg.payment_method_id && !pg.payment_type_id)) return null;
  if (pg.payment_method_id === "pix" || pg.payment_type_id === "bank_transfer") return { tipo: "pix" };
  if (pg.payment_type_id === "credit_card" || pg.payment_type_id === "debit_card" || pg.card) {
    return { tipo: "cartao", bandeira: bandeiraDe(pg.payment_method_id), final: String((pg.card || {}).last_four_digits || "").slice(-4),
      parcelas: Number(pg.installments) || 1, ...(pg.payment_type_id === "debit_card" ? { debito: true } : {}) };
  }
  if (pg.payment_type_id === "account_money") return { tipo: "saldo" };
  return { tipo: String(pg.payment_type_id || "outro").slice(0, 20) };
}

/* {forma, forma_falta} de cada pagamento da conta (Map pela referencia). */
async function formasDosPagamentos(c, d) {
  const saida = new Map();
  const mp = c.deps.chamarMP;
  const ligado = Boolean(mp && c.env.MP_ACCESS_TOKEN);
  const cartao = d.cartao && d.cartao.final ? d.cartao : null;
  let consultas = 0;
  const doMP = async (p) => {
    const chave = "admin:forma:" + p.ref;
    const guardada = await kvJSON(c.env, chave, null);
    if (guardada && guardada.tipo) return { forma: guardada };
    if (!ligado) return null;
    const custo = p.tipo === "assinatura" ? 2 : 1;
    if (consultas + custo > CONSULTAS_POR_FICHA) return { espera: true };
    consultas += custo;
    let id = p.ref;
    if (p.tipo === "assinatura") {
      const ap = await mp(c.env, "/authorized_payments/" + encodeURIComponent(p.ref), "GET").catch(() => null);
      id = ap && ap.ok && ap.dados && ap.dados.payment && ap.dados.payment.id;
      if (!id) return null;
    }
    const r = await mp(c.env, "/v1/payments/" + encodeURIComponent(id), "GET").catch(() => null);
    const forma = r && r.ok ? formaDoMP(r.dados) : null;
    if (!forma) return null;
    await c.env.APOIOS.put(chave, JSON.stringify(forma), { expirationTtl: FORMA_S });
    return { forma };
  };
  // Os mais novos primeiro: a consulta ao Mercado Pago gasta o limite com eles.
  for (const p of (d.pagamentos || []).slice().sort((a, b) => String(b.quando).localeCompare(String(a.quando)))) {
    const ref = String(p.ref);
    if (p.tipo === "recarga" || p.tipo === "avulso") {
      saida.set(ref, { forma: { tipo: "pix" } });
      continue;
    }
    if (p.tipo === "assinatura" && cartao && cartao.quando && String(p.quando) >= String(cartao.quando)) {
      saida.set(ref, { forma: { tipo: "cartao", bandeira: bandeiraDe(cartao.bandeira), final: cartao.final } });
      continue;
    }
    const r = await doMP(p);
    if (r && r.forma) saida.set(ref, { forma: r.forma });
    else if (p.tipo === "assinatura") {
      saida.set(ref, { forma: { tipo: "cartao" }, forma_falta: r && r.espera ? "a bandeira e o final saem do Mercado Pago na próxima vez que a conta abrir"
        : ligado ? "o Mercado Pago não disse qual cartão pagou a mensalidade" : "a bandeira e o final saem do Mercado Pago, e ele não está ligado (falta MP_ACCESS_TOKEN)" });
    } else {
      saida.set(ref, { forma: null, forma_falta: r && r.espera ? "a forma sai do Mercado Pago na próxima vez que a conta abrir"
        : ligado ? "o Mercado Pago não disse a forma do anual (pode ser no cartão ou no Pix)" : "a forma do anual sai do Mercado Pago, e ele não está ligado (falta MP_ACCESS_TOKEN)" });
    }
  }
  return saida;
}

/* As NFS-e de uma conta no emissor da nuvem ([] sem o emissor ou se ele nao responde). */
async function notasDaConta(c, id) {
  if (faltaDoEmissor(c.env)) return [];
  try {
    const r = await chamarEmissor(c.env, "listar", { limite: 1000 });
    return r.status === 200 ? ((r.dados && r.dados.notas) || []).filter((n) => n && n.conta === id) : [];
  } catch {
    return [];
  }
}

/* A nota de um pagamento para o extrato: a emitida (a substituta, se houve
   substituicao); sem ela, a ultima cancelada ou substituida, com o estado.
   Os links sao as rotas do painel (atras do Access), as mesmas da aba Notas
   fiscais: GET /api/admin/nfse/emissor/notas/:id/pdf e /xml. */
function notaDoPagamento(notas, ref) {
  const doPagamento = notas.filter((n) => String(n.pagamento || "") === String(ref || "") && ["emitida", "cancelada", "substituida"].includes(n.estado));
  if (!doPagamento.length) return null;
  doPagamento.sort((a, b) => Number(b.id) - Number(a.id));
  const n = doPagamento.find((x) => x.estado === "emitida") || doPagamento[0];
  return { id: n.id, numero: n.numero || "", estado: n.estado, ambiente: n.ambiente || "", quando: n.quando || "",
    pdf: SITE + PREFIXO_EMISSOR + "notas/" + n.id + "/pdf?baixar=1", xml: SITE + PREFIXO_EMISSOR + "notas/" + n.id + "/xml" };
}

// ------------------------------------------------------------ os tuneis

async function lerTuneis(c) {
  if (c._tuneis) return c._tuneis;
  c._tuneis = c.env.ESCRITORIOS ? await listarParaAdmin(c.env, c.agora) : [];
  return c._tuneis;
}

async function tuneisParaTela(c) {
  return {
    tuneis: await lerTuneis(c), livres: c.env.ESCRITORIOS ? await enderecosLivres(c.env) : [],
    cf: configuracao(c.env).tuneis,
    // O registro de enderecos (worker/tunel.js, registrarEndereco): os eventos, do mais novo ao mais velho.
    registro: c.env.ESCRITORIOS ? await registroDeEnderecos(c.env) : [],
  };
}

async function avisarTunel(c, slug) {
  const t = (await lerTuneis(c)).find((x) => x.slug === slug);
  if (!t) return json({ erro: "esse endereço não existe mais" }, 404);
  if (!t.responsavel) return json({ erro: "esse endereço não tem responsável com e-mail" }, 409);
  const prazo = t.limpeza ? (t.limpeza.dias <= 0 ? "hoje" : "em " + t.limpeza.dias + (t.limpeza.dias === 1 ? " dia" : " dias")) : "";
  const r = await enviarEmail(c.env, {
    para: t.responsavel, assunto: "O acesso externo do Paulus está parado",
    titulo: "O endereço " + slug + ".paulus.ia.br está sem conexão",
    texto: "O Paulus do escritório não se conecta a este endereço há um tempo." + (prazo ? " Se continuar assim, a limpeza automática libera o endereço " + prazo + "." : "") +
      "\n\nPara manter, abra o Paulus no computador do escritório com a internet ligada. Se não usa mais o acesso externo, não precisa fazer nada.",
  });
  if (!r.ok) return json({ erro: r.erro }, r.status || 502);
  await anotarHistorico(c.env, slug, "Aviso enviado a " + t.responsavel + (prazo ? " · limpeza " + prazo : ""), c.agora);
  return json({ ok: true });
}

// ------------------------------------------------------------ o reembolso

/* O reembolso pelo painel (a fila): o mesmo de worker/ia.js, devolverPagamento,
   que tambem cuida da nota fiscal. */
async function reembolsar(c, d) {
  const mp = c.deps.chamarMP;
  if (!mp) throw new Error("sem o Mercado Pago");
  const r = await devolverPagamento(c.env, mp, d.id, String(d.pagamento), { por: c.quem.email, agora: c.agora });
  if (r.aviso) throw new Error(r.aviso);
  return r.conta;
}

// ------------------------------------------------------- a visao geral

async function visao(c) {
  const { env } = c;
  const contas = await lerContas(c);
  const mes = mesBRT(c.agora);
  let assinaturas = 0, recargas = 0, entrada = 0, saida = 0, hoje = 0;
  const dias = new Map();
  for (let i = 13; i >= 0; i--) dias.set(diaBRT(c.agora - i * DIA_MS), [[0, 0], [0, 0], [0, 0]]);
  for (const conta of contas) {
    const d = conta._d;
    for (const pg of d.pagamentos || []) {
      if (mesBRT(Date.parse(pg.quando)) !== mes) continue;
      if (pg.tipo === "recarga") recargas += Number(pg.valor) || 0;
      else assinaturas += Number(pg.valor) || 0;
    }
    const um = (d.uso_mes || {})[mes];
    if (um) {
      entrada += um.entrada || 0;
      saida += um.saida || 0;
    }
    for (const u of d.uso || []) {
      if (u.dia === diaBRT(c.agora)) hoje += u.tokens || 0;
      const slot = dias.get(u.dia);
      if (!slot) continue;
      const turnos = u.turnos || [0, u.tokens || 0, 0];
      const turnosSaida = u.turnos_saida || [0, u.saida || 0, 0];
      for (let t = 0; t < 3; t++) {
        slot[t][0] += turnos[t] || 0;
        slot[t][1] += turnosSaida[t] || 0;
      }
    }
  }
  const tuneis = await lerTuneis(c);
  const escritorios = await comEscritorios(c, contas);
  const listaDias = [];
  for (const [dia, turnos] of dias) turnos.forEach(([total, s], turno) => listaDias.push({ dia, turno, total, saida: s }));
  const pr = precos(env);
  const kpi = {
    receita_mes: assinaturas + recargas, receita_assinaturas: assinaturas, receita_recargas: recargas,
    custo_usd_mes: custoUSD(env, entrada, saida), cambio: pr.cambio, entrada_mes: entrada, saida_mes: saida,
    contas: contas.length, contas_ativas: contas.filter((x) => x.situacao === "ativa" || x.situacao === "cortesia").length,
    escritorios: escritorios.length, tokens_hoje: hoje,
  };
  return { agora: new Date(c.agora).toISOString(), kpi, dias: listaDias, pendencias: await pendencias(c, contas, tuneis), avisos: await avisos(c, contas) };
}

async function pendencias(c, contas, tuneis) {
  const lista = [];
  const ren = (await renovacoes(c)).abertas.length;
  if (ren) lista.push({ icone: "warning", titulo: ren + (ren === 1 ? " ciclo venceu sem cobrança" : " ciclos venceram sem cobrança"), sub: "tolerância de 5 dias correndo", tela: "renovacoes" });
  const parados = tuneis.filter((t) => t.limpeza).length;
  if (parados) lista.push({ icone: "dns", titulo: parados + (parados === 1 ? " túnel parado" : " túneis parados"), sub: "sem conexão ou nunca conectaram; a limpeza diária está contando", tela: "tuneis", filtro: "parados" });
  const semDoc = contas.filter((x) => (x.situacao === "ativa" || x.situacao === "vencida") && !x.escritorio.documento).length;
  if (semDoc) lista.push({ icone: "contacts", titulo: semDoc + (semDoc === 1 ? " cadastro sem CPF/CNPJ" : " cadastros sem CPF/CNPJ"), sub: "assinaram antes da página Assinar pedir o cadastro", tela: "contas" });
  return lista;
}

/* Os avisos do Mercado Pago que a nuvem tratou (worker/ia.js, avisoDaIA, anota). */
async function avisos(c, contas) {
  const lista = await kvJSON(c.env, "admin:avisos", []);
  const porId = new Map(contas.map((x) => [x.id, x]));
  return lista.slice(0, 12).map((a) => {
    const conta = porId.get(a.conta);
    const nome = conta ? conta.nome : "conta " + String(a.conta || "").slice(0, 6);
    const plano = conta && conta.plano ? " · " + conta.plano.nome : "";
    let texto = a.texto || "";
    if (a.tipo === "authorized_payment") texto = (a.status === "approved" ? "Cobrança mensal · " : "Cobrança recusada · ") + nome + plano;
    else if (a.tipo === "order · pix") texto = (a.status === "processed" ? "Recarga · " : "Pix " + a.status + " · ") + nome;
    else if (a.tipo === "reembolso") texto = "Reembolso pelo painel · " + nome + plano;
    else if (/^payment · /.test(a.tipo || "")) {
      const o_que = String(a.tipo).slice(10);
      texto = ({ approved: "Pagamento · ", refunded: "Reembolso · ", charged_back: "Contestação · " }[a.status] || "Pagamento " + a.status + " · ") + o_que + " · " + nome + plano;
    } else if (a.tipo === "preapproval") texto = ({ authorized: "Assinatura ativa · ", cancelled: "Assinatura cancelada · ", paused: "Assinatura pausada · ", pending: "Assinatura pendente · " }[a.status] || "Assinatura · ") + nome + plano;
    const tom = a.status === "approved" || a.status === "processed" || a.status === "authorized" ? "entrada" : a.status === "cancelled" || a.status === "refunded" || a.status === "charged_back" ? "cancelado" : a.status === "rejected" ? "recusado" : "neutro";
    return { quando: a.quando, tipo: a.tipo, texto, valor: Number(a.valor) || 0, tom };
  });
}

// ------------------------------------------------------ nao renovacoes

// Os motivos de quem cancela pela Minha conta (site/assets/minha-conta.js, MOTIVOS).
const MOTIVO_DO_CANCELAMENTO = { preco: "está caro para o escritório", uso: "não está usando o bastante", falta: "falta algo de que precisa", outro: "outro motivo" };

async function renovacoes(c) {
  if (c._renovacoes) return c._renovacoes;
  const contas = await lerContas(c);
  const abertas = [], tratadas = [];
  for (const conta of contas) {
    const d = conta._d;
    const a = d.assinatura || {};
    // Quem cancelou pela Minha conta deixou o motivo (worker/ia.js, cancelarPelaConta):
    // entra aqui quando o ciclo pago acaba. A cancelada sem motivo (no Mercado Pago, pelo painel) fica fora.
    const canc = d.cancelamento || null;
    if (!d.ciclo || conta.situacao === "cortesia" || (a.situacao === "cancelled" && !canc)) continue;
    const fim = Date.parse(d.ciclo.fim);
    if (!(fim < c.agora)) continue;
    const dias = Math.floor((c.agora - fim) / DIA_MS);
    const marca = await kvJSON(c.env, "admin:renov:" + conta.id, null);
    const motivo = canc ? "cancelou pela Minha conta: " + (MOTIVO_DO_CANCELAMENTO[canc.motivo] || MOTIVO_DO_CANCELAMENTO.outro) + (canc.texto ? " (“" + String(canc.texto).slice(0, 200) + "”)" : "")
      : { paused: "assinatura pausada no Mercado Pago", pending: "a assinatura está pendente: o cartão não foi confirmado", authorized: "a cobrança do mês não chegou do Mercado Pago (cartão recusado ou sem limite)" }[a.situacao] ||
      (a.situacao ? "assinatura " + a.situacao + " no Mercado Pago" : "sem assinatura no Mercado Pago");
    const r = {
      id: conta.id, nome: conta.nome, email: conta.email, plano: conta.plano ? { id: conta.plano.id, nome: conta.plano.nome, valor: conta.plano.valor } : null,
      fim: d.ciclo.fim, dias_vencido: dias, tolerancia_dias: a.situacao === "authorized" && !canc ? Math.round(TOLERANCIA_MS / DIA_MS) : 0,
      motivo, cancelamento: canc ? { quando: canc.quando || null, motivo: canc.motivo || "outro", texto: canc.texto || "" } : null,
      lembrete_em: marca && marca.fim === d.ciclo.fim ? marca.lembrete_em || null : null,
      mensagem_em: marca && marca.fim === d.ciclo.fim ? marca.mensagem_em || null : null,
      oferta: marca && marca.fim === d.ciclo.fim ? marca.oferta || null : null,
    };
    if (marca && marca.fim === d.ciclo.fim && marca.tratada) tratadas.push(r);
    else abertas.push(r);
  }
  abertas.sort((x, y) => y.dias_vencido - x.dias_vencido);
  const config = { email: true, resumo: true, whats: false, tol: false, ...((await kvJSON(c.env, "admin:renov:config", {})) || {}) };
  c._renovacoes = { abertas, tratadas, config };
  return c._renovacoes;
}

async function acaoDeRenovacao(c, id, acao) {
  const r = await renovacoes(c);
  const item = [...r.abertas, ...r.tratadas].find((x) => x.id === id);
  if (!item) return json({ erro: "essa conta não tem ciclo vencido" }, 404);
  const marca = { fim: item.fim, ...((await kvJSON(c.env, "admin:renov:" + id, {})) || {}) };
  if (marca.fim !== item.fim) Object.assign(marca, { fim: item.fim, tratada: false, lembrete_em: null });
  if (acao === "lembrete") {
    const e = await enviarEmail(c.env, {
      para: item.email, assunto: "Seu plano do Paulus não renovou",
      titulo: "O plano " + ((item.plano || {}).nome || "") + " não renovou",
      texto: "O ciclo do seu plano venceu em " + dataBR(item.fim) + " e o Mercado Pago não confirmou a cobrança do mês." +
        "\n\nEnquanto isso, o Paulus funciona sem a IA da nuvem. Para voltar, confira o cartão na sua conta do Mercado Pago ou assine de novo em paulus.ia.br/assinatura.",
      botao: "Abrir a página Assinar", link: SITE + "/assinatura/",
    });
    if (!e.ok) return json({ erro: e.erro }, e.status || 502);
    marca.lembrete_em = new Date(c.agora).toISOString();
  } else marca.tratada = acao === "tratar";
  await c.env.APOIOS.put("admin:renov:" + id, JSON.stringify(marca));
  c._renovacoes = null;
  return json(await renovacoes(c));
}

/* A marca da renovacao de uma conta (admin:renov:<id>), do ciclo vencido de agora. */
async function marcaDaRenovacao(c, item) {
  const marca = { fim: item.fim, ...((await kvJSON(c.env, "admin:renov:" + item.id, {})) || {}) };
  if (marca.fim !== item.fim) return { fim: item.fim, tratada: false, lembrete_em: null };
  return marca;
}

/* A mensagem do proprio punho (o detalhe aberto da nao renovacao): vai por
   e-mail para a conta, com o nome de quem escreveu, e fica anotada na marca
   (quando e quem; o texto nao fica guardado aqui). */
async function mensagemDeRenovacao(c, id, d) {
  const texto = String(d.texto || "").replace(/\r/g, "").replace(/[\u0000-\u0008\u000b-\u001f]/g, " ").trim();
  if (!texto) return json({ erro: "escreva a mensagem" }, 400);
  if (texto.length > 4000) return json({ erro: "a mensagem passou de 4.000 caracteres" }, 400);
  const r = await renovacoes(c);
  const item = [...r.abertas, ...r.tratadas].find((x) => x.id === id);
  if (!item) return json({ erro: "essa conta não tem ciclo vencido" }, 404);
  const nome = nomeLimpo(c.quem.nome, 60);
  // No remetente, so letras e espacos: virgula, parenteses e afins quebram o endereco.
  const noRemetente = nome.replace(/[,;:()[\]\\@.]/g, " ").replace(/\s+/g, " ").trim();
  const e = await enviarEmail(c.env, {
    para: item.email, assunto: "Sobre o seu plano do Paulus", titulo: "Uma mensagem da equipe do Paulus",
    texto: texto + "\n\n" + (nome ? nome + "\n" : "") + "Equipe PAVLVS",
    de: (noRemetente ? noRemetente + " (PAVLVS)" : "PAVLVS") + " <naoresponda@paulus.ia.br>",
    rodape: "PAVLVS · Mensagem escrita " + (nome ? "por " + nome + " " : "") + "no painel do PAVLVS. Para responder, escreva para contato@paulus.ia.br.",
  });
  if (!e.ok) return json({ erro: e.erro }, e.status || 502);
  const marca = await marcaDaRenovacao(c, item);
  marca.mensagem_em = iso(c.agora);
  marca.mensagens = [...(marca.mensagens || []), { quando: iso(c.agora), por: c.quem.email }].slice(-20);
  await c.env.APOIOS.put("admin:renov:" + id, JSON.stringify(marca));
  c._renovacoes = null;
  return json(await renovacoes(c));
}

async function configRenovacoes(c, d) {
  const atual = (await renovacoes(c)).config;
  const novo = {};
  for (const k of ["email", "resumo", "whats", "tol"]) novo[k] = k in d ? Boolean(d[k]) : atual[k];
  await c.env.APOIOS.put("admin:renov:config", JSON.stringify(novo));
  return json({ config: novo });
}

// -------------------------------------------------------- os e-mails

/* O e-mail no desenho do site: PAVLVS, o titulo, o texto, o botao e o rodape. */
export function htmlDoEmail({ titulo = "", texto = "", botao = "", link = "", pre = "", pixel = "", rodape = "" }) {
  const esc = (t) => String(t || "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
  const paragrafos = esc(texto).split(/\n{2,}/).map((p) => '<p style="margin:0 0 16px;font:400 15px/1.65 Arial,sans-serif;color:#44433f">' + p.replace(/\n/g, "<br>") + "</p>").join("");
  return '<!doctype html><html><body style="margin:0;background:#f6f5f1">' +
    (pre ? '<div style="display:none;max-height:0;overflow:hidden">' + esc(pre) + "</div>" : "") +
    '<div style="max-width:560px;margin:0 auto;padding:32px 24px">' +
    // A marca em EB Garamond (site/assets/pavlvs-marca.png): o e-mail não carrega fonte da internet.
    '<div style="margin-bottom:24px"><img src="https://paulus.ia.br/assets/pavlvs-marca.png?v=2" width="120" height="22" alt="PAVLVS" ' +
    'style="display:block;border:0;font:400 18px Georgia,serif;letter-spacing:.12em;color:#8a8982"></div>' +
    (titulo ? '<h1 style="margin:0 0 18px;font:400 26px/1.2 Georgia,serif;color:#1c1c1a">' + esc(titulo) + "</h1>" : "") + paragrafos +
    (botao && link ? '<p style="margin:24px 0"><a href="' + esc(link) + '" style="display:inline-block;padding:10px 22px;border-radius:8px;background:#2a2a27;color:#f2f1ec;font:500 14px Arial,sans-serif;text-decoration:none">' + esc(botao) + "</a></p>" : "") +
    '<p style="margin:32px 0 0;padding-top:14px;border-top:1px solid #e2e1db;font:400 12px Arial,sans-serif;color:#77766f">' +
    esc(rodape || "PAVLVS · Este e-mail é automático e não recebe respostas. Dúvidas ou para não receber mais avisos: contato@paulus.ia.br") + "</p>" +
    (pixel ? '<img src="' + esc(pixel) + '" width="1" height="1" alt="" style="display:block">' : "") +
    "</div></body></html>";
}

/* `anexos` (opcional): [{nome, b64}] -> attachments do Resend (content em base64). */
export async function enviarEmail(env, { para, assunto, titulo, texto, botao, link, pre, pixel, anexos, de, rodape }) {
  if (!env.RESEND_API_KEY) return { ok: false, status: 503, erro: "o envio de e-mail ainda não está ligado: falta RESEND_API_KEY" };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(para || ""))) return { ok: false, status: 400, erro: "e-mail do destinatário inválido" };
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ from: de || env.EMAIL_DE || DE_EMAIL, reply_to: "contato@paulus.ia.br", to: [para], subject: String(assunto || "").slice(0, 200),
        html: htmlDoEmail({ titulo, texto, botao, link, pre, pixel, rodape }), text: [titulo, texto, botao && link ? botao + ": " + link : ""].filter(Boolean).join("\n\n"),
        ...(anexos && anexos.length ? { attachments: anexos.map((x) => ({ filename: x.nome, content: x.b64 })) } : {}) }),
    });
    if (!r.ok) {
      let msg = "";
      try {
        msg = (await r.json()).message || "";
      } catch {
        msg = "";
      }
      return { ok: false, status: 502, erro: "o provedor de e-mail recusou" + (msg ? ": " + msg : "") };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, status: 502, erro: "o provedor de e-mail não respondeu" };
  }
}

function preencher(texto, campos) {
  return String(texto || "").replace(/\{(nome|escritorio|plano|vence_em)\}/g, (_, k) => campos[k] || "");
}

function camposDe(conta) {
  const fim = conta._d && conta._d.ciclo ? dataBR(conta._d.ciclo.fim) : "";
  return { nome: String(conta.nome || "").split(" ")[0], escritorio: conta.escritorio.nome || conta.nome, plano: conta.plano ? conta.plano.nome : "", vence_em: fim };
}

function publicosDe(contas, extra) {
  const lista = [
    ["todos", "Todas as contas", contas],
    ["ativos", "Assinaturas ativas", contas.filter((x) => x.situacao === "ativa")],
    ["vencidos", "Vencidas e pendentes", contas.filter((x) => x.situacao === "vencida" || x.situacao === "pendente")],
    ["plus", "Plano Escritório Plus", contas.filter((x) => x.plano && x.plano.id === "plus")],
    ["semgoogle", "Sem Google ligado", contas.filter((x) => !x.google)],
  ];
  if (extra && extra.startsWith("conta:")) {
    const conta = contas.find((x) => x.id === extra.slice(6));
    if (conta) lista.unshift([extra, "Só " + conta.nome, [conta]]);
  }
  return lista;
}

async function campanhasParaTela(c) {
  const contas = await lerContas(c);
  const campanhas = [];
  for (const k of await kvPor(c.env, "admin:campanha:")) {
    const x = await kvJSON(c.env, k, null);
    if (x) campanhas.push({ id: x.id, nome: x.nome, situacao: x.situacao, publico: x.publico, enviados: x.enviados || 0, abertos: x.abertos || 0, cliques: x.cliques || 0, devolvidos: x.devolvidos || 0, quando: x.quando });
  }
  campanhas.sort((a, b) => String(b.quando).localeCompare(String(a.quando)));
  const enviadas = campanhas.filter((x) => x.enviados);
  const soma = (k) => enviadas.reduce((s, x) => s + (x[k] || 0), 0);
  const env = soma("enviados");
  const cfg = configuracao(c.env).email;
  return {
    campanhas, publicos: publicosDe(contas).map(([id, label, cs]) => ({ id, label, n: cs.length, gmail: cs.filter((x) => /@gmail\.com$/i.test(x.email)).length })),
    stats: { enviados: env, abertura: env ? Math.round((soma("abertos") / env) * 100) : 0, cliques: env ? Math.round((soma("cliques") / env) * 100) : 0, devolvidos: soma("devolvidos") },
    envio: { ligado: cfg.ligado, falta: cfg.falta, de: "naoresponda@paulus.ia.br", ritmo: RITMO_POR_MINUTO },
  };
}

async function campanhaTeste(c, camp) {
  const contas = await lerContas(c);
  const ex = contas[0] || { nome: c.quem.nome || "Teste", escritorio: { nome: "Escritório de teste" }, plano: { nome: "Escritório" }, _d: {} };
  const campos = camposDe(ex);
  const r = await enviarEmail(c.env, {
    para: c.quem.email, assunto: preencher(camp.assunto, campos), titulo: preencher(camp.titulo, campos),
    texto: preencher(camp.texto, campos), botao: camp.botao, link: camp.link, pre: preencher(camp.pre, campos),
  });
  if (!r.ok) return json({ erro: r.erro }, r.status || 502);
  return json({ ok: true, para: c.quem.email });
}

/* O Cron de cada minuto: a proxima leva de cada campanha na hora. */
export async function enviarCampanhas(env, agora = Date.now()) {
  if (!env.APOIOS || !env.RESEND_API_KEY) return { enviados: 0 };
  // Uma leitura por minuto: so o indice das que faltam enviar (listar o KV a
  // cada minuto passaria do limite diario de listagens do plano gratis).
  const fila = (await kvJSON(env, "admin:campanhas:fila", [])) || [];
  if (!fila.length) return { enviados: 0 };
  let enviados = 0;
  const restam = [];
  for (const id of fila) {
    const k = "admin:campanha:" + id;
    const camp = await kvJSON(env, k, null);
    if (!camp || !["na fila", "agendada", "enviando"].includes(camp.situacao)) continue;
    restam.push(id);
    if (camp.situacao === "agendada" && Date.parse(camp.envio_em) > agora) continue;
    const leva = (camp.destinatarios || []).slice(camp.cursor || 0, (camp.cursor || 0) + RITMO_POR_MINUTO);
    for (const dest of leva) {
      const base = SITE + "/api/e/" + camp.id + "/" + dest.t;
      const r = await enviarEmail(env, {
        para: dest.email, assunto: preencher(camp.assunto, dest), titulo: preencher(camp.titulo, dest), texto: preencher(camp.texto, dest),
        botao: camp.botao, link: camp.link ? base + "/c" : "", pre: preencher(camp.pre, dest), pixel: base + "/a.gif",
      });
      if (r.ok) camp.enviados = (camp.enviados || 0) + 1;
      else camp.devolvidos = (camp.devolvidos || 0) + 1;
      enviados++;
    }
    camp.cursor = (camp.cursor || 0) + leva.length;
    camp.situacao = camp.cursor >= (camp.destinatarios || []).length ? "enviada" : "enviando";
    // Terminou: a lista de e-mails sai do KV; ficam so os numeros.
    if (camp.situacao === "enviada") {
      camp.destinatarios = (camp.destinatarios || []).map((x) => ({ t: x.t }));
      restam.pop();
    }
    await env.APOIOS.put(k, JSON.stringify(camp));
  }
  if (restam.length !== fila.length) await env.APOIOS.put("admin:campanhas:fila", JSON.stringify(restam));
  return { enviados };
}

/* Abertura (pixel) e clique (redirecionador) de um e-mail de campanha. */
async function rastreio(env, url) {
  const m = url.pathname.match(/^\/api\/e\/([a-z0-9]{8,32})\/([a-z0-9]{8,32})\/(a\.gif|c)$/);
  const pixel = new Uint8Array([71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 128, 0, 0, 0, 0, 0, 255, 255, 255, 33, 249, 4, 1, 0, 0, 0, 0, 44, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 68, 1, 0, 59]);
  if (!m || !env.APOIOS) return new Response(pixel, { headers: { "content-type": "image/gif", "cache-control": "no-store" } });
  const camp = await kvJSON(env, "admin:campanha:" + m[1], null);
  if (camp && (camp.destinatarios || []).some((x) => x.t === m[2])) {
    const marca = "admin:e:" + m[1] + ":" + m[2] + ":" + (m[3] === "c" ? "c" : "a");
    if (!(await env.APOIOS.get(marca))) {
      await env.APOIOS.put(marca, "1", { expirationTtl: 180 * 24 * 3600 });
      if (m[3] === "c") camp.cliques = (camp.cliques || 0) + 1;
      else camp.abertos = (camp.abertos || 0) + 1;
      await env.APOIOS.put("admin:campanha:" + m[1], JSON.stringify(camp));
    }
  }
  if (m[3] === "c") {
    const destino = camp && /^https:\/\//.test(String(camp.link || "")) ? camp.link : SITE + "/";
    return new Response(null, { status: 302, headers: { location: destino, "cache-control": "no-store" } });
  }
  return new Response(pixel, { headers: { "content-type": "image/gif", "cache-control": "no-store" } });
}

// ---------------------------------------------- tokens, custos e receita

// O medidor guarda o uso de cada dia ("uso": 400 dias desde 07/10/2026; antes,
// so os ultimos 62 dias com uso) e o de cada mes inteiro ("uso_mes", sem
// prazo). Um periodo e [de, ate] em dias de Brasilia: o mes que cabe inteiro
// nele (ate hoje, no mes corrente) vem do uso_mes; o pedaco de mes, dos dias.
// Quando os dias guardados de um mes somam menos que o mes inteiro, faltam os
// mais velhos: se o pedaco do periodo comeca antes do primeiro dia guardado,
// o numero sai menor que o real, e a resposta diz (incompleto, desde, aviso).

/* O periodo pedido: {nome, de, ate} (AAAA-MM-DD, no horario de Brasilia) ou {erro}. */
function periodoDosTokens(busca, agora) {
  const nome = String(busca.get("periodo") || "mes");
  const hoje = diaBRT(agora);
  if (nome === "mes") return { nome, de: hoje.slice(0, 8) + "01", ate: hoje };
  if (nome === "30" || nome === "90") return { nome, de: diaBRT(agora - (Number(nome) - 1) * DIA_MS), ate: hoje };
  if (nome === "ano") return { nome, de: hoje.slice(0, 5) + "01-01", ate: hoje };
  if (nome !== "custom") return { erro: "período desconhecido: " + nome };
  const de = String(busca.get("de") || ""), ate = String(busca.get("ate") || "");
  const valido = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && new Date(d + "T12:00:00Z").toISOString().slice(0, 10) === d;
  if (!valido(de) || !valido(ate)) return { erro: "diga o período com de e ate (AAAA-MM-DD)" };
  if (de > ate) return { erro: "o início do período vem depois do fim" };
  return { nome, de, ate };
}

/* Os meses (AAAA-MM) de um periodo. */
function mesesDe(de, ate) {
  const saida = [];
  let [a, m] = de.slice(0, 7).split("-").map(Number);
  const fim = ate.slice(0, 7);
  for (let i = 0; i < 1200; i++) {
    const mes = a + "-" + String(m).padStart(2, "0");
    if (mes > fim) break;
    saida.push(mes);
    m += 1;
    if (m > 12) { m = 1; a += 1; }
  }
  return saida;
}

function ultimoDia(mes) {
  const [a, m] = mes.split("-").map(Number);
  return mes + "-" + String(new Date(Date.UTC(a, m, 0)).getUTCDate()).padStart(2, "0");
}

/* O uso de uma conta num periodo: {entrada, saida, modelos, guardado_desde}.
   guardado_desde: quando falta uso do periodo, o primeiro dia que o medidor
   ainda guarda ("" se nada falta). */
function usoNoPeriodo(d, per, hoje) {
  const t = { entrada: 0, saida: 0, modelos: {}, guardado_desde: "" };
  const somar = (u) => {
    if (!u) return;
    t.entrada += u.entrada !== undefined ? Number(u.entrada) || 0 : Number(u.tokens) || 0;
    t.saida += Number(u.saida) || 0;
    for (const [nome, x] of Object.entries(u.modelos || {})) {
      t.modelos[nome] = t.modelos[nome] || { entrada: 0, saida: 0 };
      t.modelos[nome].entrada += Number(x.entrada) || 0;
      t.modelos[nome].saida += Number(x.saida) || 0;
    }
  };
  const dias = d.uso || [];
  const meses = d.uso_mes || {};
  const temMeses = Object.keys(meses).length > 0;
  const primeiroGuardado = dias.length ? String(dias[0].dia || "") : "";
  const tokensDe = (u) => (u.entrada !== undefined ? Number(u.entrada) || 0 : Number(u.tokens) || 0) + (Number(u.saida) || 0);
  for (const mes of mesesDe(per.de, per.ate)) {
    const ini = mes + "-01";
    const fimDoMes = ultimoDia(mes);
    // O mes inteiro dentro do periodo (o corrente, ate hoje): o total do mes.
    if (temMeses && per.de <= ini && per.ate >= (fimDoMes < hoje ? fimDoMes : hoje)) {
      somar(meses[mes]);
      continue;
    }
    const a = per.de > ini ? per.de : ini;
    const b = per.ate < fimDoMes ? per.ate : fimDoMes;
    for (const u of dias) if (u.dia >= a && u.dia <= b) somar(u);
    // Os dias guardados do mes somam menos que o mes inteiro: faltam os mais velhos.
    const doMes = dias.filter((u) => u.dia >= ini && u.dia <= fimDoMes).reduce((s, u) => s + tokensDe(u), 0);
    const mesInteiro = meses[mes] ? (Number(meses[mes].entrada) || 0) + (Number(meses[mes].saida) || 0) : 0;
    if (mesInteiro > doMes && (!primeiroGuardado || primeiroGuardado > a)) t.guardado_desde = primeiroGuardado || b;
  }
  return t;
}

/* O que a conta pagou no periodo (pela data do pagamento, em Brasilia). */
function receitaNoPeriodo(d, per) {
  return (d.pagamentos || []).filter((p) => {
    const dia = diaBRT(Date.parse(p.quando));
    return dia >= per.de && dia <= per.ate;
  }).reduce((s, p) => s + (Number(p.valor) || 0), 0);
}

const NOME_DO_NIVEL = { estagiario: "Estagiário", bacharel: "Bacharel", advogado: "Advogado", juiz: "Juiz", ministro: "Ministro" };

/* Os planos que usam um modelo: "Escritório", "Escritório Plus (Ministro)". */
function planosDoModelo(n, id) {
  const saida = [];
  for (const p of n.planos) {
    if (!modelosDoPlano(p).includes(id)) continue;
    const niveis = Object.entries(p.modelos || {}).filter(([, m]) => m === id).map(([nivel]) => nivel);
    saida.push(niveis.includes("padrao") ? p.nome : p.nome + " (" + niveis.map((x) => NOME_DO_NIVEL[x] || x).join(", ") + ")");
  }
  return saida;
}

async function tokens(c, visaoEscolhida, per) {
  const contas = await lerContas(c);
  const escritorios = await comEscritorios(c, contas);
  const hoje = diaBRT(c.agora);
  const porConta = contas.map((x) => ({ conta: x, uso: usoNoPeriodo(x._d, per, hoje), receita: receitaNoPeriodo(x._d, per) }));
  const linha = (nome, itens) => {
    const entrada = itens.reduce((s, i) => s + i.uso.entrada, 0);
    const saida = itens.reduce((s, i) => s + i.uso.saida, 0);
    return { nome, entrada, saida, custo_usd: itens.reduce((s, i) => s + custoDoUso(c.env, i.uso), 0), receita: itens.reduce((s, i) => s + i.receita, 0) };
  };
  let linhas;
  if (visaoEscolhida === "conta") linhas = porConta.map((i) => linha(i.conta.nome + (i.conta.escritorio.nome && i.conta.escritorio.nome !== i.conta.nome ? " · " + i.conta.escritorio.nome : ""), [i]));
  else if (visaoEscolhida === "escritorio") linhas = escritorios.map((e) => linha(e.nome, porConta.filter((i) => e.contas.includes(i.conta.id))));
  else if (visaoEscolhida === "modelo") linhas = linhasPorModelo(c, porConta);
  else {
    // Geral: um por modelo (a receita das contas pagas dividida pelo uso de cada modelo) e as cortesias.
    const pagas = porConta.filter((i) => i.conta.situacao !== "cortesia");
    const receitaPaga = pagas.reduce((s, i) => s + i.receita, 0);
    const modelos = {};
    for (const i of pagas) {
      for (const [nome, x] of Object.entries(i.uso.modelos)) {
        modelos[nome] = modelos[nome] || { entrada: 0, saida: 0 };
        modelos[nome].entrada += x.entrada;
        modelos[nome].saida += x.saida;
      }
    }
    const totalPago = pagas.reduce((s, i) => s + i.uso.entrada + i.uso.saida, 0) || 1;
    const semModelo = { entrada: pagas.reduce((s, i) => s + i.uso.entrada, 0), saida: pagas.reduce((s, i) => s + i.uso.saida, 0) };
    linhas = Object.entries(modelos).map(([nome, x]) => {
      semModelo.entrada -= x.entrada;
      semModelo.saida -= x.saida;
      const m = MODELOS[nome];
      return { nome: m ? m.nome + " · " + m.empresa : nome.split("/").pop(), entrada: x.entrada, saida: x.saida, custo_usd: custoUSD(c.env, x.entrada, x.saida, nome),
        receita: receitaPaga * ((x.entrada + x.saida) / totalPago) };
    });
    if (semModelo.entrada + semModelo.saida > 0) {
      linhas.push({ nome: "Antes do registro por modelo", entrada: semModelo.entrada, saida: semModelo.saida, custo_usd: custoUSD(c.env, semModelo.entrada, semModelo.saida),
        receita: receitaPaga * ((semModelo.entrada + semModelo.saida) / totalPago) });
    }
    const cortesias = porConta.filter((i) => i.conta.situacao === "cortesia");
    if (cortesias.length) linhas.push({ ...linha("Cortesias (sem receita)", cortesias), receita: 0 });
  }
  linhas.sort((a, b) => b.entrada + b.saida - (a.entrada + a.saida));
  const tot = linha("total", porConta);
  // O que o medidor ja nao guarda (o uso por dia de antes de 07/10/2026 ficava so 62 dias).
  const guardados = porConta.map((i) => i.uso.guardado_desde).filter(Boolean).sort();
  const desde = guardados.length ? guardados[guardados.length - 1] : "";
  return {
    kpis: { entrada: tot.entrada, saida: tot.saida, custo_usd: tot.custo_usd, receita: tot.receita, contas: contas.length }, linhas, precos: precos(c.env),
    periodo: { nome: per.nome, de: per.de, ate: per.ate }, incompleto: Boolean(desde), desde,
    aviso: desde ? "nem todas as contas têm o uso por dia de antes de " + dataBR(Date.parse(desde + "T12:00:00Z")) + ": o começo do período pode sair menor que o real" : "",
  };
}

/* Por modelo: o uso de cada modelo em todas as contas, o preco dele por milhao
   (em dolar), os planos que o usam e o arrecadado - o que cada conta paga
   pagou no periodo, dividido pelo uso dela em cada modelo (sem uso no
   periodo, vai para o modelo principal do plano dela). O uso de antes do
   registro por modelo fica numa linha propria, no preco do IA_PRECOS. */
function linhasPorModelo(c, porConta) {
  const n = numeros(c.env);
  const pr = precos(c.env);
  const soma = {};
  const acumular = (nome, entrada, saida, receita) => {
    const x = (soma[nome] = soma[nome] || { entrada: 0, saida: 0, receita: 0 });
    x.entrada += entrada;
    x.saida += saida;
    x.receita += receita;
  };
  for (const i of porConta) {
    const paga = i.conta.situacao !== "cortesia";
    const total = i.uso.entrada + i.uso.saida;
    const parte = (e, s) => (paga && total > 0 ? i.receita * ((e + s) / total) : 0);
    let restoE = i.uso.entrada, restoS = i.uso.saida;
    for (const [nome, x] of Object.entries(i.uso.modelos)) {
      acumular(nome, x.entrada, x.saida, parte(x.entrada, x.saida));
      restoE -= x.entrada;
      restoS -= x.saida;
    }
    if (restoE + restoS > 0) acumular("", Math.max(0, restoE), Math.max(0, restoS), parte(Math.max(0, restoE), Math.max(0, restoS)));
    if (paga && !total && i.receita) acumular(planoDe(n, (i.conta.plano || {}).id).modelos.padrao, 0, 0, i.receita);
  }
  return Object.entries(soma).map(([nome, x]) => {
    const m = MODELOS[nome];
    if (!nome) {
      return { nome: "Antes do registro por modelo", sub: "uso sem o modelo anotado · preço médio do IA_PRECOS", preco: [pr.entrada, pr.saida],
        entrada: x.entrada, saida: x.saida, custo_usd: custoUSD(c.env, x.entrada, x.saida), receita: x.receita };
    }
    const planos_ = planosDoModelo(n, nome);
    return {
      nome: m ? m.nome : nome.split("/").pop(), modelo: nome, fabricante: m ? m.empresa : "",
      planos: planos_, sub: [m ? m.empresa : "fora do catálogo", planos_.length ? "plano " + planos_.join(", ") : "nenhum plano usa hoje"].join(" · "),
      preco: m ? m.usd : [pr.entrada, pr.saida], entrada: x.entrada, saida: x.saida, custo_usd: custoUSD(c.env, x.entrada, x.saida, nome), receita: x.receita,
    };
  });
}

// ------------------------------------------------------------ planos
//
// Os planos que valem sao os de "admin:planos" (o IA_PLANOS do painel: cada
// plano com os numeros e, quando o painel trocou, os textos da pagina de
// assinatura - worker/planos-textos.js) ou, sem ele, os de fabrica
// (worker/ia.js, numeros). O Worker cobra, abre os ciclos e monta as recargas
// por eles; o Paulus instalado le as pessoas e os recursos; a pagina de
// assinatura le os numeros (/api/ia/planos) e os textos (/api/planos/textos).
// Cada publicacao que muda os planos guarda uma versao
// ("admin:planos:versoes", as 30 ultimas), que a aba Historico mostra.

const CAMPOS_DO_PLANO = ["id", "nome", "para", "valor", "valor_anual", "tokens", "pessoas", "modelos", "recarga", "recursos", "heranca", "itens"];
const VERSOES_MAX = 30;
const centavos = (v) => Math.round(Number(v) * 100) / 100;

/* Os planos de agora, sempre do KV (nao do cache de 60 s): {guardados (a lista
   crua de admin:planos, ou null), n (numeros com eles)}. */
async function planosAgora(c) {
  let guardados = null;
  try {
    guardados = JSON.parse((await c.env.APOIOS.get("admin:planos")) || "null");
  } catch {
    guardados = null;
  }
  const lista = Array.isArray(guardados) ? guardados : null;
  return { guardados: lista, n: numeros(lista ? { ...c.env, IA_PLANOS: JSON.stringify(lista) } : c.env) };
}

/* O env com os planos de agora (do KV, nao do cache de 60 s), para o que
   cobra ou confere valor de plano (worker/ia.js le os planos do env). */
async function envComPlanos(c) {
  const raw = await c.env.APOIOS.get("admin:planos");
  return raw ? { ...c.env, IA_PLANOS: raw } : c.env;
}

/* A lista para guardar: os numeros completos de cada plano e os textos
   proprios que ele ja tinha (os padrao nao vao). */
function listaParaGuardar(n, guardados) {
  const porId = new Map((guardados || []).filter(Boolean).map((x) => [x.id, x]));
  return n.planos.map((p) => {
    const g = porId.get(p.id) || {};
    const o = { id: p.id, nome: p.nome, valor: p.valor, valor_anual: p.valor_anual, tokens: p.tokens, pessoas: p.pessoas,
      modelos: { ...p.modelos }, recarga: { ...p.recarga }, recursos: { ...p.recursos } };
    if (g.para) o.para = g.para;
    if (g.heranca) o.heranca = g.heranca;
    if (Array.isArray(g.itens) && g.itens.length) o.itens = g.itens;
    return o;
  });
}

async function planos(c) {
  const { guardados, n } = await planosAgora(c);
  const porId = new Map((guardados || []).filter(Boolean).map((x) => [x.id, x]));
  const contas = await lerContas(c);
  const versoes = ((await kvJSON(c.env, "admin:planos:versoes", [])) || []).filter((v) => v && v.n);
  return {
    planos: n.planos.map((p) => {
      const t = textosDoPlano(p, porId.get(p.id)), tp = textosPadrao(p);
      return { ...p, para: t.para, heranca: t.heranca || null, itens: t.itens, textos: t.proprios, textos_padrao: { para: tp.para, heranca: tp.heranca },
        assinantes: contas.filter((x) => x.plano && x.plano.id === p.id && x.situacao === "ativa").length,
        modelo_nome: (MODELOS[p.modelos.padrao] || {}).nome || p.modelos.padrao, custo_modelo: (MODELOS[p.modelos.padrao] || {}).usd || null };
    }),
    padrao: PLANO_PADRAO, recarga: { valor: n.recargaValor, tokens: n.recargaTokens }, precos: precos(c.env),
    json: JSON.stringify(listaParaGuardar(n, guardados), null, 2),
    versoes, publicado: Boolean(guardados),
  };
}

/* Guarda a lista em admin:planos e anota a versao. */
async function guardarPlanos(c, lista, resumo) {
  const { guardados, n } = await planosAgora(c);
  await c.env.APOIOS.put("admin:planos", JSON.stringify(lista));
  PLANOS_CACHE = { quando: 0, valor: null };
  await anotarVersaoDosPlanos(c, { lista: listaParaGuardar(n, guardados), doPainel: Boolean(guardados) }, lista, resumo);
}

/* Uma versao no historico dos planos (admin:planos:versoes, as 30 ultimas). Na
   primeira, entra antes a de antes da mudanca (`antes`: {lista, doPainel}). */
async function anotarVersaoDosPlanos(c, antes, lista, resumo) {
  const versoes = ((await kvJSON(c.env, "admin:planos:versoes", [])) || []).filter((v) => v && v.n);
  if (!versoes.length) {
    versoes.push({ n: 1, quando: iso(c.agora), quem: "antes do histórico", planos: antes.lista,
      resumo: antes.doPainel ? "Os planos que o painel tinha publicado antes do histórico" : "Os planos de fábrica (worker/ia.js)" });
  }
  versoes.push({ n: versoes[versoes.length - 1].n + 1, quando: iso(c.agora), quem: c.quem.login || c.quem.email, resumo: String(resumo || "").slice(0, 200), planos: lista });
  await c.env.APOIOS.put("admin:planos:versoes", JSON.stringify(versoes.slice(-VERSOES_MAX)));
}

/* As contas que estao num plano (ou com a troca marcada para ele). */
function contasNoPlano(contas, id) {
  return contas.filter((x) => x._d.plano_id === id || (x._d.plano_proximo && x._d.plano_proximo.id === id));
}

/* Confere a lista inteira de planos do editor .JSON ("" se serve). As regras
   sao as do Worker (worker/ia.js, lerPlanos): sem elas, ele ignoraria a lista
   inteira e voltaria aos planos de fabrica sem ninguem ver. */
async function conferirListaDePlanos(c, lista) {
  if (!Array.isArray(lista) || !lista.length) return "mande a lista de planos: [ { … }, … ]";
  if (lista.length > 12) return "no máximo 12 planos";
  const ids = new Set();
  const niveis = ["padrao", ...NIVEIS];
  const recursosQueExistem = Object.keys(PLANOS_DE_FABRICA.find((p) => p.id === PLANO_PADRAO).recursos);
  for (const [i, p] of lista.entries()) {
    const qual = "o plano " + (i + 1) + (p && p.nome ? " (" + p.nome + ")" : "");
    if (!p || typeof p !== "object" || Array.isArray(p)) return qual + " não é um objeto";
    const fora = Object.keys(p).filter((k) => !CAMPOS_DO_PLANO.includes(k));
    if (fora.length) return qual + ": " + fora.join(", ") + (fora.length === 1 ? " não é campo" : " não são campos") + " de plano (os campos: " + CAMPOS_DO_PLANO.join(", ") + ")";
    if (!/^[a-z0-9-]{2,24}$/.test(String(p.id || ""))) return qual + ": o id tem de 2 a 24 letras minúsculas, números e hífen";
    if (ids.has(p.id)) return "há dois planos com o id " + p.id;
    ids.add(p.id);
    const nome = String(p.nome || "").trim();
    if (nome.length < 2 || nome.length > 40) return qual + ": o nome tem de 2 a 40 letras";
    for (const k of ["valor", "valor_anual"]) if (!(Number(p[k]) > 0 && Number(p[k]) <= 1e6)) return qual + ": " + k + " precisa ser um número maior que zero";
    if (!(Number.isInteger(p.tokens) && p.tokens > 0 && p.tokens <= 1e10)) return qual + ": tokens são os créditos do mês, um número inteiro maior que zero (60000000 são 60 milhões)";
    if (p.pessoas !== undefined && !(Number.isInteger(p.pessoas) && p.pessoas >= 1 && p.pessoas <= 500)) return qual + ": pessoas é um número inteiro de 1 a 500";
    if (p.modelos !== undefined) {
      if (!p.modelos || typeof p.modelos !== "object" || Array.isArray(p.modelos)) return qual + ": modelos é um objeto {nível: modelo}";
      for (const [nivel, m] of Object.entries(p.modelos)) {
        if (!niveis.includes(nivel)) return qual + ": o nível " + nivel + " não existe (os níveis: " + niveis.join(", ") + ")";
        if (!MODELOS[m]) return qual + ": o modelo " + m + " não está no catálogo (" + Object.keys(MODELOS).join(", ") + ")";
      }
    }
    if (p.recarga !== undefined && !(p.recarga && Number(p.recarga.valor) > 0 && Number.isInteger(p.recarga.tokens) && p.recarga.tokens > 0)) {
      return qual + ": a recarga é {valor, tokens}, os dois maiores que zero (tokens inteiros)";
    }
    if (p.recursos !== undefined) {
      if (!p.recursos || typeof p.recursos !== "object" || Array.isArray(p.recursos)) return qual + ": recursos é um objeto";
      for (const [k, v] of Object.entries(p.recursos)) {
        if (!recursosQueExistem.includes(k)) return qual + ": o recurso " + k + " não existe (os recursos: " + recursosQueExistem.join(", ") + ")";
        if (k === "profundidade" ? !NIVEIS.includes(v) : !(v === null || typeof v === "boolean" || (typeof v === "number" && v >= 0))) {
          return qual + ": o valor de " + k + " não serve (" + (k === "profundidade" ? NIVEIS.join(", ") : "true, false, um número ou null, que é sem limite") + ")";
        }
      }
    }
    const t = conferirTextos(p);
    if (t.erro) return qual + ": " + t.erro;
  }
  if (!ids.has(PLANO_PADRAO)) return "a lista precisa do plano " + PLANO_PADRAO + " (o padrão: sem ele, o Worker volta aos planos de fábrica)";
  const contas = await lerContas(c);
  for (const id of new Set(contas.map((x) => x._d.plano_id).concat(contas.map((x) => (x._d.plano_proximo || {}).id)).filter(Boolean))) {
    if (ids.has(id)) continue;
    const n = contasNoPlano(contas, id).length;
    if (n) return "o plano " + id + " saiu da lista, mas " + n + (n === 1 ? " conta está nele" : " contas estão nele") + " (ou com a troca marcada para ele): troque o plano delas antes";
  }
  return "";
}

/* plano.criar e plano.editar. No editar vem so o que a tela manda: os numeros,
   e da aba Edicao tambem o nome, as pessoas, a recarga, a frase, o texto antes
   dos itens e os itens. */
async function aplicarPlano(c, tipo, d, resumo) {
  const { guardados, n } = await planosAgora(c);
  const lista = listaParaGuardar(n, guardados);
  const valor = centavos(d.valor);
  const tokensDoPlano = Math.round(Number(d.tokens) < 10000 ? Number(d.tokens) * 1e6 : Number(d.tokens));
  if (tipo === "plano.criar") {
    if (lista.some((p) => p.id === d.id)) throw new Error("esse id já existe");
    lista.push({ id: String(d.id), nome: String(d.nome).trim().slice(0, 40), valor, valor_anual: centavos(d.valor_anual), tokens: tokensDoPlano });
  } else {
    const p = lista.find((x) => x.id === d.id);
    if (!p) throw new Error("esse plano não existe");
    const t = conferirTextos(d);
    if (t.erro) throw new Error(t.erro);
    const antes = n.planos.find((x) => x.id === d.id);
    p.valor = valor;
    p.tokens = tokensDoPlano;
    if (d.valor_anual !== undefined) p.valor_anual = centavos(d.valor_anual);
    if (d.nome !== undefined && String(d.nome).trim()) p.nome = String(d.nome).trim().slice(0, 40);
    if (d.pessoas !== undefined && d.pessoas !== null) p.pessoas = Math.round(Number(d.pessoas));
    if (d.recarga) p.recarga = { valor: centavos(d.recarga.valor), tokens: Math.round(Number(d.recarga.tokens)) };
    const depois = numeros({ ...c.env, IA_PLANOS: JSON.stringify(lista) }).planos.find((x) => x.id === d.id);
    guardarTextos(p, t.textos, [antes, depois].filter(Boolean).map(textosPadrao));
  }
  await guardarPlanos(c, lista, resumo);
  if (tipo !== "plano.editar") return {};
  // Quem ja assina passa a pagar o valor novo a partir da proxima cobranca
  // (o Mercado Pago cobra o que o preapproval disser); o ciclo pago fica.
  return valorNasAssinaturas(c, d.id, valor, "o plano mudou, mas o Mercado Pago recusou o valor novo de: ");
}

/* planos.json (a aba .JSON): a lista inteira, conferida, no lugar da de agora.
   Os textos iguais aos padrao nao sao guardados; quem assina um plano cujo
   valor mudou passa a pagar o novo na proxima cobranca. */
async function aplicarPlanosJson(c, d, resumo) {
  const erro = await conferirListaDePlanos(c, d.planos);
  if (erro) throw new Error(erro);
  const { n } = await planosAgora(c);
  const nova = d.planos.map((p) => {
    const o = { id: p.id, nome: String(p.nome).trim(), valor: centavos(p.valor), valor_anual: centavos(p.valor_anual), tokens: p.tokens };
    if (p.pessoas !== undefined) o.pessoas = p.pessoas;
    if (p.modelos !== undefined) o.modelos = { ...p.modelos };
    if (p.recarga !== undefined) o.recarga = { valor: centavos(p.recarga.valor), tokens: p.recarga.tokens };
    if (p.recursos !== undefined) o.recursos = { ...p.recursos };
    return o;
  });
  const nNova = numeros({ ...c.env, IA_PLANOS: JSON.stringify(nova) });
  // A mesma conferencia do Worker: se ele nao aceitasse a lista, voltaria aos de fabrica.
  if (nNova.planos.length !== nova.length || nNova.planos.some((p, i) => p.id !== nova[i].id || p.valor !== nova[i].valor)) {
    throw new Error("o Worker não aceitaria essa lista (voltaria aos planos de fábrica): confira valor, valor_anual e tokens de cada plano");
  }
  d.planos.forEach((p, i) => {
    const padroes = [nNova.planos[i], n.planos.find((x) => x.id === p.id)].filter(Boolean).map(textosPadrao);
    guardarTextos(nova[i], conferirTextos(p).textos, padroes);
  });
  await guardarPlanos(c, nova, resumo);
  const avisos = [];
  const erros = [];
  for (const p of nNova.planos) {
    const antes = n.planos.find((x) => x.id === p.id);
    if (!antes || Math.abs(antes.valor - p.valor) < 0.005) continue;
    try {
      const r = await valorNasAssinaturas(c, p.id, p.valor, "");
      if (r.aviso) avisos.push(p.nome + ": " + r.aviso);
    } catch (e) {
      erros.push(p.nome + ": " + String((e && e.message) || e));
    }
  }
  if (erros.length) throw new Error("os planos mudaram, mas o Mercado Pago recusou o valor novo de " + erros.join("; "));
  return avisos.length ? { aviso: avisos.join("; ") } : {};
}

/* GET /api/planos/textos (publico, fora do Access): os textos de cada plano na
   pagina de assinatura - os proprios do painel ou os padrao. Os numeros a
   pagina le de /api/ia/planos. */
function textosDosPlanos(env) {
  let guardados = null;
  try {
    guardados = JSON.parse(env.IA_PLANOS || "null");
  } catch {
    guardados = null;
  }
  const porId = new Map((Array.isArray(guardados) ? guardados : []).filter(Boolean).map((x) => [x.id, x]));
  const planos = numeros(env).planos.map((p) => {
    const t = textosDoPlano(p, porId.get(p.id));
    return { id: p.id, para: t.para, heranca: t.heranca, itens: t.itens };
  });
  return new Response(JSON.stringify({ planos }), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=60" },
  });
}

/* Os planos publicados pelo painel ficam no KV e valem no lugar de IA_PLANOS.
   O index.js chama isto antes de atender (cache de 60 s por isolado). */
let PLANOS_CACHE = { quando: 0, valor: null };
export async function comPlanosDoPainel(env) {
  if (!env.APOIOS) return env;
  if (Date.now() - PLANOS_CACHE.quando > 60 * 1000) {
    let v = null;
    try {
      v = await env.APOIOS.get("admin:planos");
    } catch {
      v = null;
    }
    PLANOS_CACHE = { quando: Date.now(), valor: v };
  }
  return PLANOS_CACHE.valor ? { ...env, IA_PLANOS: PLANOS_CACHE.valor } : env;
}

// ------------------------------------------------------------- NFS-e

/* A aba Notas fiscais: o emissor da nuvem (situacao, notas, pagamentos sem
   nota, Cloudflare) e o que o papel pode (worker/nfse/api.js, resumoParaPainel). */
async function nfse(c) {
  const r = await resumoParaPainel(c.env);
  return { ...r, pode: { emitir: PODE_NFSE.includes(c.quem.papel) } };
}

// ------------------------------------------------------------- equipe
//
// A equipe e "admin:equipe" (ou, antes da primeira mudanca, o ADMIN_EQUIPE).
// Os convites pendentes ficam em "admin:convites": nome, e-mail e papel - nem
// documento nem endereco -, o resumo SHA-256 do link, quem convidou e ate
// quando vale (7 dias). O link (/api/equipe/convite?t=...) fica fora do
// Access: por ele a pessoa aceita, entra na equipe e, com a API do Access
// configurada, o Worker poe o e-mail dela na politica do painel.

async function convitesPendentes(env) {
  const l = await kvJSON(env, "admin:convites", []);
  return Array.isArray(l) ? l.filter((x) => x && x.email && x.h) : [];
}

async function guardarConvites(env, lista) {
  if (lista.length) await env.APOIOS.put("admin:convites", JSON.stringify(lista.slice(-50)));
  else await env.APOIOS.delete("admin:convites");
}

async function guardarEquipe(env, lista) {
  await env.APOIOS.put("admin:equipe", JSON.stringify(lista.map((x) => ({ email: String(x.email).toLowerCase(), nome: x.nome || "", papel: x.papel }))));
}

async function equipe(c) {
  const lista = await listaDaEquipe(c.env);
  const membros = [];
  for (const m of lista) {
    const ac = await kvJSON(c.env, "admin:acesso:" + String(m.email).toLowerCase(), null);
    membros.push({ email: String(m.email).toLowerCase(), nome: m.nome || "", papel: m.papel, ultimo: ac ? ac.ultimo : null });
  }
  // Os convites pendentes: a pessoa ainda nao aceitou (a tela mostra reenviar e cancelar).
  for (const cv of await convitesPendentes(c.env)) {
    if (membros.some((x) => x.email === cv.email)) continue;
    membros.push({ email: cv.email, nome: cv.nome || "", papel: cv.papel, ultimo: null,
      convite: { criado: cv.criado, vence: cv.vence, por: cv.por || "", vencido: !(Date.parse(cv.vence) > c.agora) } });
  }
  return {
    membros, matriz: MATRIZ.map(([acao, papeis]) => ({ acao, dono: papeis.includes("dono"), financeiro: papeis.includes("financeiro"), suporte: papeis.includes("suporte") })),
    liberacao: configuracao(c.env).equipe,
  };
}

/* O que um equipe.membro pede faz sentido agora? "" se sim; senao, o motivo. */
async function conferirMembro(c, d) {
  const acao = String(d.acao || "");
  if (!["criar", "editar", "excluir", "cancelar_convite"].includes(acao)) return "o que fazer com essa pessoa? (criar, editar, excluir ou cancelar_convite)";
  const email = String(d.email || "").trim().toLowerCase();
  if (!RE_EMAIL.test(email) || email.length > 120) return "e-mail inválido";
  const lista = await listaDaEquipe(c.env);
  const naEquipe = (e) => lista.some((x) => String(x.email).toLowerCase() === e);
  const pendentes = await convitesPendentes(c.env);
  const convidado = (e) => pendentes.some((x) => x.email === e);
  const comDono = (l) => l.some((x) => x.papel === "dono");
  if (acao === "criar" || acao === "editar") {
    if (nomeLimpo(d.nome).length < 2) return "diga o nome da pessoa";
    if (!PAPEIS.includes(d.papel)) return "papel inválido";
  }
  if (acao === "criar") {
    if (naEquipe(email)) return email + " já está na equipe";
    if (convidado(email)) return "já há um convite para " + email + ": reenvie ou cancele";
    if (!c.env.RESEND_API_KEY) return "o convite vai por e-mail, e o envio ainda não está ligado: falta RESEND_API_KEY";
  }
  if (acao === "editar") {
    const de = String(d.de || "").trim().toLowerCase();
    if (!naEquipe(de)) return (de || "essa pessoa") + " não está na equipe";
    if (de === email) {
      if (!comDono(lista.map((x) => (String(x.email).toLowerCase() === de ? { ...x, papel: d.papel } : x)))) return "a equipe precisa de pelo menos um dono";
    } else {
      if (naEquipe(email) || convidado(email)) return email + " já está na equipe ou tem convite";
      if (!c.env.RESEND_API_KEY) return "trocar o e-mail manda um convite para o novo, e o envio ainda não está ligado: falta RESEND_API_KEY";
      // O e-mail novo so entra quando aceitar: ate la, o antigo ja saiu.
      if (!comDono(lista.filter((x) => String(x.email).toLowerCase() !== de))) return "a equipe precisa de pelo menos um dono: o e-mail novo só entra quando aceitar o convite. Convide-o como dono antes de trocar este";
    }
  }
  if (acao === "excluir") {
    if (!naEquipe(email)) return email + " não está na equipe";
    if (!comDono(lista.filter((x) => String(x.email).toLowerCase() !== email))) return "a equipe precisa de pelo menos um dono";
  }
  if (acao === "cancelar_convite" && !convidado(email)) return "não há convite pendente para " + email;
  return "";
}

/* equipe.membro na publicacao: convida, edita, tira da equipe ou cancela o convite. */
async function aplicarMembro(c, d) {
  const erro = await conferirMembro(c, d);
  if (erro) throw new Error(erro);
  const { env } = c;
  const email = String(d.email).trim().toLowerCase();
  const nome = nomeLimpo(d.nome);
  if (d.acao === "criar") return convidar(c, { email, nome, papel: d.papel });
  if (d.acao === "cancelar_convite") {
    await guardarConvites(env, (await convitesPendentes(env)).filter((x) => x.email !== email));
    return {};
  }
  const lista = await listaDaEquipe(env);
  if (d.acao === "excluir") return tirarDaEquipe(env, lista, email);
  // editar
  const de = String(d.de).trim().toLowerCase();
  if (de === email) {
    await guardarEquipe(env, lista.map((x) => (String(x.email).toLowerCase() === de ? { ...x, nome, papel: d.papel } : x)));
    return {};
  }
  // O e-mail mudou: o novo recebe o convite (se o e-mail nao sai, nada muda) e o antigo sai.
  const r = await convidar(c, { email, nome, papel: d.papel });
  const fora = await tirarDaEquipe(env, lista, de);
  return { ...r, ...fora };
}

/* Tira da equipe: a lista, a politica do Access (se a API estiver ligada), as sessoes do painel e as do Access. */
async function tirarDaEquipe(env, lista, email) {
  await guardarEquipe(env, lista.filter((x) => String(x.email).toLowerCase() !== email));
  const access = accessConfigurado(env) ? await politicaDoAccess(env, email, false) : { feito: false, frase: "tire " + email + " da política do Cloudflare Access à mão (" + faltaDoAccess(env) + ")" };
  await apagarSessoesDe(env, email);
  if (accessConfigurado(env)) await revogarNoAccess(env, email);
  return { access, ...(access.feito ? {} : { aviso: email + " saiu da equipe, mas não do Access: " + access.frase }) };
}

/* Um convite novo (ou o mesmo e-mail de novo): guarda e manda o e-mail. Se o e-mail nao sai, o convite tambem nao fica. */
async function convidar(c, { email, nome, papel }) {
  const token = aleatorio(32);
  const cv = { email, nome, papel, h: await sha256Hex("convite:" + token), criado: iso(c.agora), vence: iso(c.agora + CONVITE_MS),
    por: c.quem.email, por_nome: nomeLimpo(c.quem.nome, 60) };
  const antes = await convitesPendentes(c.env);
  await guardarConvites(c.env, [...antes.filter((x) => x.email !== email), cv]);
  const e = await emailDoConvite(c.env, cv, token);
  if (!e.ok) {
    await guardarConvites(c.env, antes);
    throw new Error(e.erro);
  }
  return { convite: email, vence: cv.vence };
}

function emailDoConvite(env, cv, token) {
  const auto = accessConfigurado(env);
  const quem = cv.por_nome || cv.por || "A equipe do Paulus";
  return enviarEmail(env, {
    para: cv.email, assunto: "Convite para o painel do Paulus", titulo: "Você foi convidado para a equipe do Paulus",
    pre: "O link vale até " + dataBR(cv.vence),
    texto: (cv.nome ? "Olá, " + primeiroNome(cv.nome) + ".\n\n" : "") +
      quem + " convidou você para o painel de administração do Paulus, com o papel " + (NOME_DO_PAPEL[cv.papel] || cv.papel) + ". O link abaixo vale até " + dataBR(cv.vence) + ".\n\n" +
      (auto ? "Ao aceitar, o seu e-mail é liberado no Cloudflare Access do painel."
        : "Depois de aceitar, avise quem convidou: a liberação do seu e-mail no Cloudflare Access do painel ainda é feita à mão.") +
      " Para entrar, o Access manda um código para este e-mail. A conta do GitHub (com escrita no repositório do PAVLVS) só é pedida para comitar e pushar ou retroagir." +
      "\n\nSe não esperava este convite, ignore este e-mail.",
    botao: "Abrir o convite", link: SITE + "/api/equipe/convite?t=" + token,
  });
}

/* POST /api/admin/equipe/convite/:email/reenviar (na hora, so o dono): um link novo
   (o anterior para de valer), mais 7 dias. */
async function reenviarConvite(c, email) {
  if (c.quem.papel !== "dono") return json({ erro: "o papel " + c.quem.papel + " não convida: convites são do dono" }, 403);
  const lista = await convitesPendentes(c.env);
  const cv = lista.find((x) => x.email === email);
  if (!cv) return json({ erro: "não há convite pendente para " + (email || "esse e-mail") }, 404);
  const token = aleatorio(32);
  const novo = { ...cv, h: await sha256Hex("convite:" + token), vence: iso(c.agora + CONVITE_MS), reenviado: iso(c.agora), por: c.quem.email, por_nome: nomeLimpo(c.quem.nome, 60) };
  await guardarConvites(c.env, lista.map((x) => (x.email === email ? novo : x)));
  const e = await emailDoConvite(c.env, novo, token);
  if (!e.ok) {
    await guardarConvites(c.env, lista);
    return json({ erro: e.erro }, e.status || 502);
  }
  return json(await equipe(c));
}

/* A pagina do convite (GET mostra, POST aceita), fora do Access. Aceitar poe a
   pessoa na equipe e, com a API do Access configurada, o e-mail na politica
   do painel; sem ela, a pagina diz que essa parte e a mao. */
async function conviteDaEquipe(request, env, url, deps) {
  const m = request.method;
  if (m !== "GET" && m !== "POST") return paginaDoConvite(405, { titulo: "Abra o link do convite", paragrafos: ["Este endereço só abre o convite que chegou por e-mail."] });
  if (deps.dentroDoLimite && !(await deps.dentroDoLimite(request, env))) {
    return paginaDoConvite(429, { titulo: "Muitas tentativas seguidas", paragrafos: ["Espere um minuto e abra o link de novo."] });
  }
  const agora = (deps.agora || Date.now)();
  let token = "";
  if (m === "POST") {
    try {
      token = String((await request.formData()).get("t") || "");
    } catch {
      token = "";
    }
  } else token = String(url.searchParams.get("t") || "");
  const h = /^[0-9a-f]{64}$/.test(token) ? await sha256Hex("convite:" + token) : "";
  const cv = h ? (await convitesPendentes(env)).find((x) => x.h === h) : null;
  if (!cv) {
    return paginaDoConvite(410, { titulo: "Este convite não vale mais",
      paragrafos: ["O link foi cancelado, trocado por um novo ou já foi usado. Peça a quem convidou para reenviar o convite."] });
  }
  if (!(Date.parse(cv.vence) > agora)) {
    return paginaDoConvite(410, { titulo: "Este convite venceu",
      paragrafos: ["Ele valia até " + dataBR(cv.vence) + ". Peça a quem convidou para reenviar: o link novo vale por mais 7 dias."] });
  }
  const auto = accessConfigurado(env);
  const papel = NOME_DO_PAPEL[cv.papel] || cv.papel;
  const linhas = [["Nome", cv.nome || "—"], ["E-mail", cv.email], ["Papel", papel], ["Vale até", dataBR(cv.vence)]];
  const github = "A conta do GitHub (com escrita no repositório do PAVLVS) só é pedida para comitar e pushar ou retroagir.";
  if (m === "GET") {
    return paginaDoConvite(200, {
      titulo: "Entrar na equipe do Paulus?", linhas, form: token, botao: "Aceitar o convite",
      paragrafos: [(cv.por_nome || cv.por || "A equipe do Paulus") + " convidou você para o painel de administração do Paulus.",
        auto ? "Ao aceitar, o seu e-mail é liberado no Cloudflare Access do painel. Para entrar, o Access manda um código para " + cv.email + ". " + github
          : "Ao aceitar, você entra na equipe do painel. A liberação do seu e-mail no Cloudflare Access ainda é feita à mão por quem convidou: avise depois de aceitar. Com ela, o Access manda um código para " + cv.email + ". " + github],
    });
  }
  // Aceitar. A equipe primeiro: com o Access liberado depois (a mao ou de novo pelo link), a pessoa ja tem o papel.
  const equipeAtual = await listaDaEquipe(env);
  if (!equipeAtual.some((x) => String(x.email).toLowerCase() === cv.email)) {
    await guardarEquipe(env, [...equipeAtual, { email: cv.email, nome: cv.nome, papel: cv.papel }]);
  }
  if (auto) {
    const lib = await politicaDoAccess(env, cv.email, true);
    if (!lib.feito) {
      // O convite continua valendo: abrir o link de novo tenta o Access outra vez.
      return paginaDoConvite(502, { titulo: "Quase lá", linhas, paragrafos: ["Você entrou na equipe, mas o Cloudflare Access não liberou o seu e-mail agora: " + lib.frase + ".",
        "Abra o link de novo em alguns minutos: ele continua valendo até " + dataBR(cv.vence) + ". Se não der, avise quem convidou."] });
    }
  }
  await guardarConvites(env, (await convitesPendentes(env)).filter((x) => x.h !== h));
  return paginaDoConvite(200, auto ? {
    titulo: cv.nome ? "Pronto, " + primeiroNome(cv.nome) + "." : "Pronto.", linhas, botao: "Abrir o painel", link: "/admin/",
    paragrafos: ["Você entrou na equipe, com o papel " + papel + ", e o seu e-mail foi liberado no Cloudflare Access do painel.",
      "Para entrar: abra o painel, digite " + cv.email + " no Access e use o código que chega nesse e-mail. " + github],
  } : {
    titulo: cv.nome ? "Pronto, " + primeiroNome(cv.nome) + "." : "Pronto.", linhas,
    paragrafos: ["Você entrou na equipe, com o papel " + papel + ".",
      "Falta um passo, que ainda é feito à mão: quem convidou precisa incluir " + cv.email + " na política do Cloudflare Access do painel. Avise essa pessoa; depois disso, o Access manda um código para esse e-mail quando você abrir paulus.ia.br/admin. " + github],
  });
}

/* A pagina do convite, no desenho das paginas do Worker (claro ou escuro, pelo sistema). Sem script. */
function paginaDoConvite(status, { rotulo = "Convite", titulo = "", paragrafos = [], linhas = [], form = "", botao = "", link = "" }) {
  const esc = (t) => String(t == null ? "" : t).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  const tabela = linhas.length ? '<div class="linhas">' + linhas.map(([r, v]) => '<div class="linha"><span class="r">' + esc(r) + "</span><span>" + esc(v) + "</span></div>").join("") + "</div>" : "";
  const acao = form
    ? '<form method="post" action="/api/equipe/convite"><input type="hidden" name="t" value="' + esc(form) + '"><button class="principal" type="submit"><span>' + esc(botao) + "</span></button></form>"
    : botao && link ? '<a class="principal" href="' + esc(link) + '"><span>' + esc(botao) + "</span></a>" : "";
  const html = '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    "<title>" + esc(titulo) + ' — PAVLVS</title><meta name="robots" content="noindex"><link rel="icon" href="/favicon.ico" sizes="any">' +
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=EB+Garamond:wght@400;500&family=Manrope:wght@400;500;600&family=Fira+Code:wght@400&display=swap"><style>' +
    ":root{--bg:#f6f5f1;--panel:#efeee9;--pill:#e2e1db;--pill-h:#dad9d2;--ink:#1c1c1a;--ink2:#55544f;--ink3:#77766f;--line:rgba(28,28,26,.12);--line2:rgba(28,28,26,.25);color-scheme:light}" +
    "@media (prefers-color-scheme:dark){:root{--bg:#131312;--panel:#1a1a18;--pill:#2a2a27;--pill-h:#303030;--ink:#f2f1ec;--ink2:#a8a69e;--ink3:#6f6e68;--line:rgba(242,241,236,.1);--line2:rgba(242,241,236,.2);color-scheme:dark}}" +
    "*{box-sizing:border-box}html,body{margin:0}" +
    'body{min-height:100vh;display:flex;flex-direction:column;background:var(--bg);color:var(--ink);font:400 16px/1.6 Manrope,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}' +
    "header{padding:0 28px;min-height:56px;display:flex;align-items:center;border-bottom:1px solid var(--line)}" +
    '.marca{font:400 20px/1 "EB Garamond",Georgia,serif;letter-spacing:.12em;color:inherit;text-decoration:none}' +
    "main{flex:1;width:100%;max-width:560px;margin:0 auto;padding:48px 16px;display:grid;gap:18px;align-content:center}" +
    '.rotulo{font:400 12px "Fira Code",ui-monospace,monospace;letter-spacing:.18em;text-transform:uppercase;color:var(--ink3)}' +
    'h1{margin:0;font:400 clamp(30px,6vw,40px)/1.1 "EB Garamond",Georgia,serif;text-wrap:balance}' +
    "p{margin:0;font-size:14px;line-height:1.6;color:var(--ink2);text-wrap:pretty}" +
    ".linhas{display:grid;border:1px solid var(--line);border-radius:12px;background:var(--panel);overflow:hidden}" +
    ".linha{display:grid;grid-template-columns:96px minmax(0,1fr);gap:12px;align-items:baseline;padding:10px 12px;border-top:1px solid var(--line);font-size:14px;overflow-wrap:anywhere}" +
    '.linha:first-child{border-top:0}.linha .r{font:400 12px "Fira Code",ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase;color:var(--ink3)}' +
    "form{margin:0}" +
    ".principal{display:inline-flex;padding:1px;border:1px solid var(--line);border-radius:12px;background:var(--panel);color:var(--ink);font:500 13px Manrope,system-ui,sans-serif;text-decoration:none;cursor:pointer}" +
    ".principal>span{height:28px;padding:0 22px;display:flex;align-items:center;border-radius:8px;background:var(--pill)}" +
    ".principal:hover{border-color:var(--line2)}.principal:hover>span{background:var(--pill-h)}.principal:focus-visible{outline:2px solid var(--ink3);outline-offset:2px}" +
    '</style></head><body><header><a class="marca" href="/">PAVLVS</a></header><main><span class="rotulo">' + esc(rotulo) + "</span><h1>" + esc(titulo) + "</h1>" +
    paragrafos.map((t) => "<p>" + esc(t) + "</p>").join("") + tabela + (acao ? "<div>" + acao + "</div>" : "") + "</main></body></html>";
  return new Response(html, {
    status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" },
  });
}

// -------------------------------------------------------------- busca

async function busca(c, q) {
  const nq = String(q || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
  const vazio = { contas: [], escritorios: [], tuneis: [], planos: [] };
  if (nq.length < 2) return vazio;
  const bate = (...t) => t.join(" ").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").includes(nq);
  const contas = await lerContas(c);
  const escritorios = await comEscritorios(c, contas);
  const tuneis = await lerTuneis(c);
  return {
    contas: contas.filter((x) => bate(x.nome, x.email, x.oab, x.escritorio.nome)).slice(0, 6).map((x) => ({ titulo: x.nome, desc: x.email + (x.plano ? " · " + x.plano.nome : "") + " · " + x.situacao, tela: "contas", alvo: x.id })),
    escritorios: escritorios.filter((e) => bate(e.nome, e.slug, e.documento)).slice(0, 6).map((e) => ({ titulo: e.nome, desc: e.contas.length + (e.contas.length === 1 ? " conta" : " contas") + (e.slug ? " · " + e.slug + ".paulus.ia.br" : ""), tela: "contas", alvo: e.nome })),
    tuneis: tuneis.filter((t) => bate(t.slug, t.nome, t.responsavel)).slice(0, 6).map((t) => ({ titulo: t.slug + ".paulus.ia.br", desc: t.nome + " · " + t.estado, tela: "tuneis", alvo: t.slug })),
    planos: numeros(c.env).planos.filter((p) => bate(p.nome, p.id)).slice(0, 6).map((p) => ({ titulo: p.nome, desc: brl(p.valor) + "/mês · " + brl(p.valor_anual) + "/ano · " + Math.round(p.tokens / 1e6) + "M créditos", tela: "planos", alvo: p.id })),
  };
}

// ----------------------------------------------------------- a fila

function chaveDaFila(c) {
  return "admin:pendentes:" + c.quem.email;
}

async function alteracoes(c) {
  const pubs = (await kvJSON(c.env, "admin:publicacoes", [])) || [];
  return { pendentes: (await kvJSON(c.env, chaveDaFila(c), [])) || [], publicacoes: pubs.map(publicacaoParaTela) };
}

/* A publicacao como a tela le: sem o que so o servidor usa (os commits inteiros, o retrato). */
function publicacaoParaTela(p) {
  return { id: p.id || "", quando: p.quando, commit: p.commit, resumo: p.resumo, n: p.n, por: p.por, revertida: p.revertida || null,
    retroagivel: Boolean(p.retrato || (p.commits && p.commits.length) || /^[0-9a-f]{7,40}$/.test(String(p.commit || ""))) };
}

async function enfileirar(c, d) {
  const tipo = String(d.tipo || "");
  if (!PODE[tipo]) return json({ erro: "alteração desconhecida: " + tipo }, 400);
  if (!PODE[tipo].includes(c.quem.papel)) return json({ erro: "o papel " + c.quem.papel + " não pode fazer isso" }, 403);
  const erro = await conferirAlteracao(c, tipo, d.dados || {});
  if (erro) return json({ erro }, 400);
  const lista = (await kvJSON(c.env, chaveDaFila(c), [])) || [];
  lista.push({ id: aleatorio(6), quando: new Date(c.agora).toISOString(), tela: String(d.tela || "").slice(0, 40), tipo, alvo: String(d.alvo || "").slice(0, 120),
    dados: d.dados || {}, texto: String(d.texto || tipo).slice(0, 300) });
  await c.env.APOIOS.put(chaveDaFila(c), JSON.stringify(lista));
  return json({ pendentes: lista });
}

async function tirarDaFila(c, id) {
  const lista = ((await kvJSON(c.env, chaveDaFila(c), [])) || []).filter((x) => x.id !== id);
  await c.env.APOIOS.put(chaveDaFila(c), JSON.stringify(lista));
  return json({ pendentes: lista });
}

/* O que da para conferir antes de entrar na fila (formato, existencia). */
async function conferirAlteracao(c, tipo, d) {
  if (tipo.startsWith("conta.") || tipo.startsWith("google.") || tipo === "renov.oferta") {
    if (!/^[0-9a-f]{24}$/.test(String(d.id || ""))) return "conta inválida";
  }
  if (tipo === "conta.plano") {
    if (!(await planosAgora(c)).n.planos.some((p) => p.id === String(d.plano || ""))) return "esse plano não existe";
    return motivoContraTrocaDePlano(c, d.id, String(d.plano));
  }
  if (tipo === "planos.json") return conferirListaDePlanos(c, d.planos);
  if (tipo === "campanha.cancelar") return motivoContraCancelar(c, d);
  if (tipo === "conta.cadastro") {
    const r = await cadastroEditado(c, d);
    return r.erro || "";
  }
  if (tipo === "conta.pausar") return motivoContraPausa(c, d);
  if (tipo === "equipe.membro") return conferirMembro(c, d);
  if (tipo === "renov.oferta") return conferirOferta(c, d);
  if (tipo === "conta.creditar" && !(Number(d.tokens) > 0 && Number(d.tokens) <= 1e9)) return "quantos tokens?";
  if (tipo === "conta.reembolsar") {
    if (!/^[A-Za-z0-9-]{3,40}$/.test(String(d.pagamento || ""))) return "qual pagamento?";
    const det = await medidor(c.env, d.id).pedir("admin_detalhe");
    const p = (det.pagamentos || []).find((x) => String(x.ref) === String(d.pagamento));
    if (!p) return "esse pagamento não está na conta";
    if (p.reembolso) return "esse pagamento já foi reembolsado";
  }
  if (tipo.startsWith("tunel.") && !/^[a-z0-9-]{3,24}$/.test(String(d.slug || ""))) return "endereço inválido";
  if (tipo === "tunel.endereco") {
    const motivo = await motivoDoEnderecoNovo(c.env, String(d.novo || ""));
    if (motivo) return d.novo + ": " + motivo;
  }
  if (tipo === "plano.criar") {
    if (!/^[a-z0-9-]{2,24}$/.test(String(d.id || ""))) return "o id tem de 2 a 24 letras minúsculas, números e hífen";
    if ((await planosAgora(c)).n.planos.some((p) => p.id === d.id)) return "esse id já existe";
    if (!String(d.nome || "").trim()) return "dê um nome ao plano";
  }
  if (tipo === "plano.editar") {
    if (!(await planosAgora(c)).n.planos.some((p) => p.id === d.id)) return "esse plano não existe";
    const nome = d.nome === undefined || d.nome === null ? null : String(d.nome).trim();
    if (nome !== null && (nome.length < 2 || nome.length > 40)) return "o nome do plano tem de 2 a 40 letras";
    if (d.pessoas !== undefined && d.pessoas !== null && !(Number.isInteger(Number(d.pessoas)) && Number(d.pessoas) >= 1 && Number(d.pessoas) <= 500)) return "pessoas é um número inteiro de 1 a 500";
    if (d.recarga !== undefined && d.recarga !== null && !(d.recarga && Number(d.recarga.valor) > 0 && Math.round(Number(d.recarga.tokens)) > 0)) {
      return "a recarga precisa de valor e de créditos maiores que zero (sem recarga, o plano fica com a de agora)";
    }
    const t = conferirTextos(d);
    if (t.erro) return t.erro;
  }
  if ((tipo === "plano.criar" || tipo === "plano.editar") && !(Number(d.valor) > 0 && Number(d.tokens) > 0)) return "valor e tokens precisam ser maiores que zero";
  if (tipo === "plano.criar" && !(Number(d.valor_anual) > 0)) return "diga o valor do ano";
  if (tipo === "plano.editar" && d.valor_anual !== undefined && !(Number(d.valor_anual) > 0)) return "o valor do ano precisa ser maior que zero";
  if (tipo === "equipe.papel" && !PAPEIS.includes(d.papel)) return "papel inválido";
  if (tipo === "campanha.disparar") {
    if (!String(d.assunto || "").trim() || !String(d.texto || "").trim()) return "a campanha precisa de assunto e texto";
    if (d.quando !== undefined && !["agora", "amanha", "segunda", "agendado"].includes(d.quando)) return "quando enviar? (agora, amanha, segunda ou agendado)";
    if (d.quando === "agendado") {
      const ms = horaMarcada(d);
      if (!Number.isFinite(ms)) return "diga o dia (de: AAAA-MM-DD) e a hora (hora: HH:MM, horário de Brasília) do envio";
      if (ms <= c.agora + 60 * 1000) return "a hora marcada (" + dataHoraBR(ms) + ") já passou: escolha outra";
      if (ms > c.agora + 366 * DIA_MS) return "agende para no máximo um ano a partir de hoje";
    }
    if (d.publico === "escolhidas") {
      const ids = Array.isArray(d.contas) ? d.contas.map(String) : [];
      if (!ids.length) return "escolha as contas que recebem";
      if (ids.length > 2000 || ids.some((x) => !/^[0-9a-f]{24}$/.test(x))) return "a lista de contas escolhidas não confere";
    }
  }
  return "";
}

/* O dia e a hora de uma campanha agendada ({de: "AAAA-MM-DD", hora: "HH:MM"}, em
   Brasilia, UTC-3) em milissegundos; NaN se nao conferem. */
function horaMarcada(d) {
  const dia = String(d.de || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const hora = String(d.hora || "").match(/^(\d{2}):(\d{2})$/);
  if (!dia || !hora || Number(hora[1]) > 23 || Number(hora[2]) > 59) return NaN;
  const ms = Date.UTC(Number(dia[1]), Number(dia[2]) - 1, Number(dia[3]), Number(hora[1]) + 3, Number(hora[2]));
  // 31/02 nao existe: o Date.UTC passaria para marco.
  return diaBRT(ms) === dia[0] ? ms : NaN;
}

/* Publicar: aplica a fila na ordem. Uma que falha nao desfaz as outras. Cada
   publicacao guarda o retrato do que mudou ("admin:retrato:<id>", 30 dias),
   que e o que o dono usa para retroagir. */
async function publicar(c, d) {
  if (String(d.confirmacao || "").trim().toLowerCase() !== CONFIRMACAO) return json({ erro: "digite exatamente: " + CONFIRMACAO }, 400);
  const lista = (await kvJSON(c.env, chaveDaFila(c), [])) || [];
  if (!lista.length) return json({ erro: "nada para publicar" }, 409);
  const resultados = [];
  const commits = [];
  const retratos = [];
  for (const alt of lista) {
    if (!PODE[alt.tipo] || !PODE[alt.tipo].includes(c.quem.papel)) {
      resultados.push({ id: alt.id, ok: false, erro: "o papel " + c.quem.papel + " não pode" });
      continue;
    }
    try {
      const item = { id: alt.id, tipo: alt.tipo, texto: alt.texto };
      const r = await aplicarComRetrato(c, alt, item);
      if (r && r.commit) commits.push(r.commit);
      retratos.push(item);
      resultados.push({ id: alt.id, ok: true, ...(r && r.aviso ? { aviso: String(r.aviso).slice(0, 300) } : {}) });
    } catch (e) {
      resultados.push({ id: alt.id, ok: false, erro: String((e && e.message) || e).slice(0, 200) });
    }
  }
  const falharam = lista.filter((alt) => resultados.find((r) => r.id === alt.id && !r.ok));
  await c.env.APOIOS.put(chaveDaFila(c), JSON.stringify(falharam));
  const feitas = lista.length - falharam.length;
  const id = aleatorio(6);
  const publicacao = {
    id, quando: new Date(c.agora).toISOString(), commit: commits.length ? commits[commits.length - 1].slice(0, 7) : "kv-" + id.slice(0, 5),
    resumo: lista.filter((a) => !falharam.includes(a)).map((a) => a.texto).slice(0, 3).join(" · ") + (feitas > 3 ? " · +" + (feitas - 3) : ""),
    n: feitas, por: c.quem.login || c.quem.email,
  };
  if (feitas) {
    if (commits.length) publicacao.commits = commits;
    await c.env.APOIOS.put("admin:retrato:" + id, JSON.stringify({ quando: publicacao.quando, itens: retratos }), { expirationTtl: RETRATO_S });
    publicacao.retrato = true;
    const pubs = (await kvJSON(c.env, "admin:publicacoes", [])) || [];
    pubs.unshift(publicacao);
    await c.env.APOIOS.put("admin:publicacoes", JSON.stringify(pubs.slice(0, 30)));
  }
  return json({ ok: !falharam.length, resultados, publicacao: publicacaoParaTela(publicacao) });
}

// ------------------------------------------------------------ o retrato
//
// O que cada alteracao mudou, para retroagir (POST /api/admin/retroagir).
// Volta: o que so mudou o KV do painel (planos, interruptores das notas,
// papeis), com o valor de antes e o de depois - se mudou de novo depois, nao
// volta sem desfazer o mais novo; o cadastro editado (o de antes, se havia);
// a campanha que ainda nao saiu inteira (o resto e cancelado; o que saiu
// continua); e a pausa da cobranca (o Mercado Pago volta a situacao de antes).
// O resto mudou fora do painel e e desfeito pela propria tela.

const KV_DA_ALTERACAO = { "plano.criar": ["admin:planos"], "plano.editar": ["admin:planos"], "planos.json": ["admin:planos"], "nfse.config": ["admin:nfse:config"], "equipe.papel": ["admin:equipe"] };
const ROTULO_DO_KV = { "admin:planos": "os planos", "admin:nfse:config": "os interruptores das notas fiscais", "admin:equipe": "a equipe" };
const NAO_VOLTA = {
  "conta.creditar": "os créditos já estão na conta (o medidor não tira créditos pelo painel)",
  "conta.instalacao.apagar": "a instalação desvinculada só volta ativando o Paulus de novo nela",
  "conta.cancelar": "a assinatura cancelada no Mercado Pago não volta: a pessoa assina de novo",
  "conta.reembolsar": "o dinheiro já voltou pelo Mercado Pago",
  "conta.plano": "para voltar, troque o plano de novo em Contas › Plano",
  "google.servicos": "o que o Google revogou só volta com o consentimento da pessoa no Paulus",
  "google.desvincular": "a conta Google desvinculada não volta pelo painel",
  "tunel.apagar": "o túnel e o DNS apagados não voltam: o escritório conecta de novo",
  "tunel.endereco": "para voltar, altere o endereço de novo em Túneis",
  "tunel.ativo": "para voltar, use Ativar ou Desativar acesso em Túneis",
  "equipe.membro": "convites e acessos voltam pela tela Equipe (convidar de novo ou excluir)",
  "renov.oferta": "a oferta já foi mandada para a pessoa",
  "campanha.cancelar": "a campanha cancelada não volta: dispare de novo",
};

async function aplicarComRetrato(c, alt, item) {
  const { env } = c;
  const d = alt.dados || {};
  const chaves = KV_DA_ALTERACAO[alt.tipo];
  if (chaves) {
    const antes = [];
    for (const k of chaves) antes.push(await env.APOIOS.get(k));
    const r = await aplicar(c, alt);
    item.kv = [];
    for (let i = 0; i < chaves.length; i++) item.kv.push({ chave: chaves[i], antes: antes[i], depois: await env.APOIOS.get(chaves[i]) });
    return r;
  }
  if (alt.tipo === "conta.cadastro") {
    const antes = ((await medidor(env, d.id).pedir("admin_detalhe")) || {}).cadastro || null;
    const r = await aplicar(c, alt);
    if (antes) item.cadastro = { conta: d.id, antes, depois: (r && r.cadastro) || null };
    else item.nao_volta = "a conta não tinha cadastro antes";
    return r;
  }
  const r = await aplicar(c, alt);
  if (alt.tipo === "campanha.disparar") item.campanha = r && r.id;
  else if (alt.tipo === "conta.pausar") item.pausa = { conta: d.id, assinatura: r.assinatura, de: r.de, para: r.para };
  else item.nao_volta = NAO_VOLTA[alt.tipo] || "mudou fora do painel";
  return r;
}

/* Por que um item do retrato nao volta agora ("" se volta). */
async function conflitoDoRetrato(c, x, contas) {
  if (x.desfeito) return "";
  if (x.nao_volta) return x.nao_volta;
  if (x.kv) {
    for (const k of x.kv) {
      if ((await c.env.APOIOS.get(k.chave)) !== k.depois) return (ROTULO_DO_KV[k.chave] || k.chave) + " mudaram depois dessa publicação: retroaja a mais nova antes";
    }
    // Plano que a publicacao criou e que ja tem conta: voltar a lista o tiraria debaixo dela.
    const kvPlanos = x.kv.find((k) => k.chave === "admin:planos");
    if (kvPlanos) {
      const ids = (t) => numeros({ ...c.env, IA_PLANOS: t || "" }).planos.map((p) => p.id);
      const antes = ids(kvPlanos.antes);
      for (const id of ids(kvPlanos.depois).filter((y) => !antes.includes(y))) {
        const n = contasNoPlano(contas, id).length;
        if (n) return n + (n === 1 ? " conta já usa" : " contas já usam") + " o plano " + id;
      }
    }
  }
  if (x.cadastro) {
    const atual = ((await medidor(c.env, x.cadastro.conta).pedir("admin_detalhe")) || {}).cadastro || null;
    if (JSON.stringify(atual) !== JSON.stringify(x.cadastro.depois)) return "o cadastro da conta mudou depois dessa publicação";
  }
  if (x.pausa) {
    const a = ((await medidor(c.env, x.pausa.conta).pedir("resumo")) || {}).assinatura || {};
    if (a.id !== x.pausa.assinatura || a.situacao !== x.pausa.para) return "a assinatura mudou depois (agora: " + (a.situacao || "sem assinatura") + ")";
  }
  return "";
}

/* Desfaz um item do retrato (ja conferido). Devolve um aviso, ou "". */
async function desfazerDoRetrato(c, x) {
  const { env } = c;
  if (x.kv) {
    const kvPlanos = x.kv.find((k) => k.chave === "admin:planos");
    const antesDosPlanos = kvPlanos ? await planosAgora(c) : null;
    for (const k of x.kv) {
      if (k.antes === null || k.antes === undefined) await env.APOIOS.delete(k.chave);
      else await env.APOIOS.put(k.chave, k.antes);
      if (k.chave === "admin:planos") PLANOS_CACHE = { quando: 0, valor: null };
    }
    if (!kvPlanos) return "";
    // Os planos voltaram: entra uma versao no historico, e quem assina um plano
    // cujo valor voltou passa a pagar o de antes (como a publicacao fez com o novo).
    const voltou = numeros({ ...env, IA_PLANOS: kvPlanos.antes || "" });
    const tinha = numeros({ ...env, IA_PLANOS: kvPlanos.depois || "" });
    let lista;
    try {
      lista = kvPlanos.antes ? JSON.parse(kvPlanos.antes) : listaParaGuardar(voltou, null);
    } catch {
      lista = listaParaGuardar(voltou, null);
    }
    await anotarVersaoDosPlanos(c, { lista: listaParaGuardar(antesDosPlanos.n, antesDosPlanos.guardados), doPainel: Boolean(antesDosPlanos.guardados) }, lista,
      "Retroagi: " + x.texto);
    const avisos = [];
    for (const p of voltou.planos) {
      const q = tinha.planos.find((y) => y.id === p.id);
      if (!q || Math.abs(q.valor - p.valor) < 0.005) continue;
      try {
        const r = await valorNasAssinaturas(c, p.id, p.valor, "o Mercado Pago recusou o valor de antes de: ");
        if (r.aviso) avisos.push(r.aviso);
      } catch (e) {
        avisos.push("o plano voltou, mas " + String((e && e.message) || e));
      }
    }
    return avisos.join("; ");
  }
  if (x.cadastro) {
    await medidor(env, x.cadastro.conta).pedir("cadastro", { cadastro: x.cadastro.antes });
    return "";
  }
  if (x.pausa) {
    const mp = c.deps.chamarMP;
    if (!mp) throw new Error("sem o Mercado Pago");
    const res = await mp(env, "/preapproval/" + encodeURIComponent(x.pausa.assinatura), "PUT", { status: x.pausa.de });
    if (!res.ok) throw new Error("o Mercado Pago recusou voltar a assinatura para " + x.pausa.de + " (HTTP " + res.status + ")");
    await medidor(env, x.pausa.conta).pedir("assinatura", { assinatura: { id: x.pausa.assinatura, situacao: x.pausa.de } });
    return "";
  }
  if (x.campanha) return cancelarCampanha(env, x.campanha);
  return "";
}

/* O resto de uma campanha sai da fila do Cron (o que ja saiu continua). Devolve o aviso. */
async function cancelarCampanha(env, id) {
  const k = "admin:campanha:" + id;
  const camp = await kvJSON(env, k, null);
  if (!camp) return "";
  if (!["na fila", "agendada", "enviando"].includes(camp.situacao)) {
    return camp.situacao === "enviada" ? "os e-mails da campanha “" + camp.nome + "” já tinham saído e continuam valendo" : "";
  }
  const saiu = camp.enviados || 0;
  camp.situacao = "cancelada";
  camp.destinatarios = (camp.destinatarios || []).map((y) => ({ t: y.t }));
  await env.APOIOS.put(k, JSON.stringify(camp));
  const fila = (await kvJSON(env, "admin:campanhas:fila", [])) || [];
  await env.APOIOS.put("admin:campanhas:fila", JSON.stringify(fila.filter((y) => y !== id)));
  return saiu ? saiu + (saiu === 1 ? " e-mail" : " e-mails") + " da campanha “" + camp.nome + "” já tinham saído e continuam valendo; o resto foi cancelado" : "";
}

/* campanha.cancelar {id}: por que nao da ("" se da). A agendada (e a que ainda
   esta saindo) cancela; a que ja saiu inteira, nao. */
async function motivoContraCancelar(c, d) {
  if (!/^c[0-9a-f]{14}$/.test(String(d.id || ""))) return "campanha inválida";
  const camp = await kvJSON(c.env, "admin:campanha:" + d.id, null);
  if (!camp) return "essa campanha não existe";
  if (camp.situacao === "cancelada") return "essa campanha já foi cancelada";
  if (camp.situacao === "enviada") return "essa campanha já saiu inteira: os e-mails não voltam";
  return "";
}

/* Na publicacao: o que falta sair nao sai mais (o que ja saiu continua). */
async function cancelarCampanhaPelaFila(c, d) {
  const motivo = await motivoContraCancelar(c, d);
  if (motivo) throw new Error(motivo);
  const aviso = await cancelarCampanha(c.env, d.id);
  const k = "admin:campanha:" + d.id;
  const camp = await kvJSON(c.env, k, null);
  if (camp) await c.env.APOIOS.put(k, JSON.stringify({ ...camp, cancelada: { quando: iso(c.agora), por: c.quem.email } }));
  return aviso ? { aviso } : {};
}

/* POST /api/admin/retroagir {publicacao | commit, confirmacao: "retroagir"} - so o dono.
   Tudo ou nada: se um item nao volta (mudou fora do painel, ou de novo depois),
   nada muda e a resposta diz qual e por que. O que mudou commits no GitHub
   volta num commit de reversao na main, com o token do GitHub de quem esta logado. */
async function retroagir(c, d) {
  if (c.quem.papel !== "dono") return json({ erro: "só o papel dono retroage uma publicação" }, 403);
  if (String(d.confirmacao || "").trim().toLowerCase() !== "retroagir") return json({ erro: "digite exatamente: retroagir" }, 400);
  const pubs = (await kvJSON(c.env, "admin:publicacoes", [])) || [];
  const i = d.publicacao ? pubs.findIndex((p) => p.id === String(d.publicacao)) : pubs.findIndex((p) => d.commit && String(p.commit) === String(d.commit));
  if (i < 0) return json({ erro: "essa publicação não está no histórico" }, 404);
  const pub = pubs[i];
  if (pub.revertida) return json({ erro: "essa publicação já foi retroagida em " + dataHoraBR(Date.parse(pub.revertida.quando)) }, 409);
  const doGit = pub.commits && pub.commits.length ? pub.commits : /^[0-9a-f]{7,40}$/.test(String(pub.commit || "")) ? [String(pub.commit)] : [];
  if (!pub.retrato && !doGit.length) {
    return json({ erro: "essa publicação é de antes do retrato (o painel guarda o valor anterior desde 07/10/2026): não dá para retroagir; desfaça à mão, pela tela de cada alteração" }, 409);
  }
  const retrato = pub.retrato ? await kvJSON(c.env, "admin:retrato:" + pub.id, null) : null;
  if (pub.retrato && !retrato) return json({ erro: "o retrato dessa publicação venceu (vale 30 dias): não dá para retroagir; desfaça à mão" }, 409);
  const itens = retrato ? retrato.itens || [] : [];
  const contas = itens.some((x) => x.kv && x.kv.some((k) => k.chave === "admin:planos")) ? await lerContas(c) : [];
  const motivos = [];
  for (const x of itens) {
    const m = await conflitoDoRetrato(c, x, contas);
    if (m) motivos.push("“" + x.texto + "”: " + m);
  }
  if (motivos.length) return json({ erro: "não dá para retroagir esta publicação: " + motivos.join("; "), itens: motivos }, 409);
  let commit = pub.git_revertido || "";
  if (doGit.length && !commit) {
    try {
      commit = await reverterNoGitHub(c, doGit, "Painel admin: retroage a publicação de " + dataHoraBR(Date.parse(pub.quando)) + " (" + (pub.resumo || pub.commit) + "), por " + (c.quem.login || c.quem.email));
    } catch (e) {
      return json({ erro: "o GitHub não aceitou a reversão: " + String((e && e.message) || e).slice(0, 240) }, 502);
    }
    // Anotado ja: se algo do KV parar no meio, tentar de novo nao reverte o GitHub duas vezes.
    pub.git_revertido = commit;
    pubs[i] = pub;
    await c.env.APOIOS.put("admin:publicacoes", JSON.stringify(pubs));
  }
  // Da ultima para a primeira; cada uma desfeita fica marcada no retrato (de novo, nao se desfaz duas vezes).
  const avisos = [];
  for (const x of [...itens].reverse()) {
    if (x.desfeito) continue;
    try {
      const a = await desfazerDoRetrato(c, x);
      if (a) avisos.push(a);
      x.desfeito = true;
      await c.env.APOIOS.put("admin:retrato:" + pub.id, JSON.stringify(retrato), { expirationTtl: RETRATO_S });
    } catch (e) {
      return json({ erro: "parei em “" + x.texto + "”: " + String((e && e.message) || e).slice(0, 200) + ". O que veio antes dela na lista já voltou; tente de novo para terminar", avisos }, 502);
    }
  }
  pub.revertida = { quando: iso(c.agora), por: c.quem.login || c.quem.email, commit: commit ? commit.slice(0, 7) : "kv-" + aleatorio(3).slice(0, 5) };
  pubs[i] = pub;
  await c.env.APOIOS.put("admin:publicacoes", JSON.stringify(pubs));
  return json({ ok: true, commit: pub.revertida.commit, publicacao: publicacaoParaTela(pub), avisos });
}

/* A reversao, na main, dos commits de uma publicacao (o mais novo por ultimo),
   pela API do GitHub com o token de quem esta logado: cada arquivo que eles
   mexeram volta ao que era antes do primeiro (o que eles criaram sai). Se um
   desses arquivos mudou depois, nao reverte (o git faria um conflito).
   Devolve o sha do commit de reversao. */
async function reverterNoGitHub(c, shas, mensagem) {
  const gh = c.deps.github || chamarGitHub;
  const token = c.quem.token;
  if (!token) throw new Error("entre com o GitHub de novo");
  const api = "https://api.github.com/repos/" + REPO;
  const caminhoUrl = (p) => String(p).split("/").map(encodeURIComponent).join("/");
  const ref = await gh("GET", api + "/git/ref/heads/" + RAMO, token);
  const cabeca = ref.ok && ref.dados && ref.dados.object && ref.dados.object.sha;
  if (!cabeca) throw new Error("não consegui ler a ponta da " + RAMO + " (HTTP " + ref.status + ")");
  const topo = await gh("GET", api + "/git/commits/" + cabeca, token);
  const arvore = topo.ok && topo.dados && topo.dados.tree && topo.dados.tree.sha;
  if (!arvore) throw new Error("não consegui ler o último commit da " + RAMO);
  const voltar = new Map(); // caminho -> o blob de antes (null: o arquivo sai)
  const depois = new Map(); // caminho -> o blob que o commit mais novo deixou (null: apagado)
  for (const sha of [...shas].reverse()) {
    const cm = await gh("GET", api + "/commits/" + encodeURIComponent(sha), token);
    if (!cm.ok || !cm.dados) throw new Error("não achei o commit " + sha + " (HTTP " + cm.status + ")");
    const pais = cm.dados.parents || [];
    if (pais.length !== 1) throw new Error("o commit " + sha + " não é um commit simples: retroaja pelo git");
    const lerAntes = async (caminho) => {
      const r = await gh("GET", api + "/contents/" + caminhoUrl(caminho) + "?ref=" + pais[0].sha, token);
      if (r.status === 404) return null;
      if (!r.ok || !r.dados || !r.dados.sha) throw new Error("não consegui ler " + caminho + " de antes do commit");
      return r.dados.sha;
    };
    for (const f of cm.dados.files || []) {
      if (!depois.has(f.filename)) depois.set(f.filename, f.status === "removed" ? null : f.sha || null);
      if (f.status === "renamed" && f.previous_filename) {
        voltar.set(f.previous_filename, await lerAntes(f.previous_filename));
        if (!depois.has(f.previous_filename)) depois.set(f.previous_filename, null);
        voltar.set(f.filename, null);
      } else voltar.set(f.filename, f.status === "added" ? null : await lerAntes(f.filename));
    }
  }
  if (!voltar.size) throw new Error("os commits não mexeram em arquivo nenhum");
  for (const [caminho, blob] of depois) {
    const r = await gh("GET", api + "/contents/" + caminhoUrl(caminho) + "?ref=" + cabeca, token);
    const agora = r.status === 404 ? null : r.ok && r.dados ? r.dados.sha : undefined;
    if (agora === undefined) throw new Error("não consegui ler " + caminho + " na " + RAMO);
    if (agora !== blob) throw new Error(caminho + " mudou depois dessa publicação: retroaja pelo git");
  }
  const tree = [...voltar].map(([path, sha]) => ({ path, mode: "100644", type: "blob", sha }));
  const nova = await gh("POST", api + "/git/trees", token, { base_tree: arvore, tree });
  if (!nova.ok || !nova.dados || !nova.dados.sha) throw new Error("o GitHub recusou montar a árvore da reversão (HTTP " + nova.status + ")");
  const commit = await gh("POST", api + "/git/commits", token, { message: mensagem, tree: nova.dados.sha, parents: [cabeca] });
  if (!commit.ok || !commit.dados || !commit.dados.sha) throw new Error("o GitHub recusou o commit de reversão (HTTP " + commit.status + ")");
  const mover = await gh("PATCH", api + "/git/refs/heads/" + RAMO, token, { sha: commit.dados.sha, force: false });
  if (!mover.ok) throw new Error("a " + RAMO + " mudou enquanto eu retroagia: tente de novo");
  return commit.dados.sha;
}

async function aplicar(c, alt) {
  const { env } = c;
  const d = alt.dados || {};
  const mp = c.deps.chamarMP;
  switch (alt.tipo) {
    case "conta.creditar":
      return medidor(env, d.id).pedir("admin_creditar", { tokens: Number(d.tokens), por: c.quem.email });
    case "conta.instalacao.apagar": {
      const r = await medidor(env, d.id).pedir("admin_apagar_segredo", { hash8: d.hash8 });
      if (!r.apagados) throw new Error("essa instalação já não estava na conta");
      return r;
    }
    case "conta.reembolsar":
      return reembolsar(c, d);
    case "conta.cancelar": {
      const r = await medidor(env, d.id).pedir("resumo");
      const a = r.assinatura;
      if (!a || !a.id || a.situacao === "cancelled") throw new Error("não há assinatura ativa");
      if (a.periodo === "anual" || a.periodo === "avulso") throw new Error("o plano pago de uma vez não renova sozinho: não há o que cancelar (para devolver o dinheiro, use Reembolsar)");
      if (!mp) throw new Error("sem o Mercado Pago");
      const res = await mp(env, "/preapproval/" + encodeURIComponent(a.id), "PUT", { status: "cancelled" });
      if (!res.ok) throw new Error("o Mercado Pago recusou cancelar (HTTP " + res.status + ")");
      return medidor(env, d.id).pedir("admin_assinatura_cancelada");
    }
    case "conta.plano":
      return aplicarContaPlano(c, d);
    case "conta.cadastro": {
      const r = await cadastroEditado(c, d);
      if (r.erro) throw new Error(r.erro);
      return medidor(env, d.id).pedir("cadastro", { cadastro: r.cadastro });
    }
    case "conta.pausar":
      return aplicarPausa(c, d);
    case "google.servicos":
      return medidor(env, d.id).pedir("admin_google", { ligados: d.ligados || [] });
    case "google.desvincular":
      return medidor(env, d.id).pedir("admin_desvincular", { por: c.quem.email });
    case "tunel.apagar":
      return liberarEndereco(env, d.slug, "apagado pelo painel", c.quem.email);
    case "tunel.endereco":
      return alterarEndereco(env, d.slug, String(d.novo), c.agora, c.quem.email);
    case "tunel.ativo":
      return ativarEndereco(env, d.slug, Boolean(d.ativo), c.agora, c.quem.email);
    case "campanha.disparar":
      return dispararCampanha(c, d);
    case "renov.oferta":
      return aplicarOferta(c, d);
    case "equipe.membro":
      return aplicarMembro(c, d);
    case "plano.criar":
    case "plano.editar":
      return aplicarPlano(c, alt.tipo, d, alt.texto);
    case "planos.json":
      return aplicarPlanosJson(c, d, alt.texto);
    case "campanha.cancelar":
      return cancelarCampanhaPelaFila(c, d);
    case "nfse.config":
      await env.APOIOS.put("admin:nfse:config", JSON.stringify({ auto: Boolean(d.auto), email: Boolean(d.email), mail: Boolean(d.mail) }));
      return {};
    case "equipe.papel": {
      const lista = await listaDaEquipe(env);
      const m = lista.find((x) => String(x.email).toLowerCase() === String(d.email).toLowerCase());
      if (!m) throw new Error("essa pessoa não está na equipe");
      m.papel = d.papel;
      if (!lista.some((x) => x.papel === "dono")) throw new Error("a equipe precisa de pelo menos um dono");
      await env.APOIOS.put("admin:equipe", JSON.stringify(lista));
      return {};
    }
    default:
      throw new Error("alteração desconhecida");
  }
}

// ------------------------------------------------- a conta: plano, cadastro, pausa

/* Por que trocar o plano desta conta pelo painel nao da ("" se da). A troca pelo
   painel vale na proxima cobranca (a tela promete isso): o ciclo de agora fica
   no plano em que foi pago. Mais caro agora, com a diferenca, e pela Minha conta. */
async function motivoContraTrocaDePlano(c, id, plano) {
  const det = await medidor(c.env, id).pedir("admin_detalhe");
  if (!det || det.ok === false) return "conta não encontrada";
  const a = det.assinatura || null;
  if (det.cortesia && (!a || !a.id)) return "a conta de cortesia não tem assinatura: o plano dela não muda pelo painel";
  if (!a || !a.id || a.situacao !== "authorized") return "a troca é para quem tem a assinatura mensal ativa; sem ela, a pessoa escolhe o plano ao assinar";
  if (prepago(det.periodo) || prepago(a.periodo)) {
    return "no plano pago de uma vez (anual ou mês no Pix), o plano é o que foi pago" + (det.pago_ate ? " (até " + dataBR(det.pago_ate) + ")" : "") + ": a troca é na renovação, quando a pessoa escolhe o plano ao pagar";
  }
  if (det.ajuste) return "há uma cobrança com valor ajustado em curso (uma oferta ou a troca anterior): a troca fica para depois dela";
  const atual = (det.plano || {}).id;
  if (plano === atual && !det.plano_proximo) return "esse já é o plano da conta";
  return "";
}

/* conta.plano: o Mercado Pago passa a cobrar o valor do plano novo na proxima
   cobranca, e a conta marca a troca (plano_proximo; o ciclo pago fica no
   plano dele). O plano de agora de novo desfaz a troca marcada. */
async function aplicarContaPlano(c, d) {
  const env = await envComPlanos(c);
  const motivo = await motivoContraTrocaDePlano(c, d.id, String(d.plano));
  if (motivo) throw new Error(motivo);
  const mp = c.deps.chamarMP;
  if (!mp) throw new Error("sem o Mercado Pago");
  const novo = planoDe(numeros(env), String(d.plano));
  const a = (await medidor(env, d.id).pedir("resumo")).assinatura;
  // O mesmo "reason" das assinaturas que o worker/ia.js cria.
  const r = await mp(env, "/preapproval/" + encodeURIComponent(a.id), "PUT", {
    reason: "Paulus - plano " + novo.nome, auto_recurring: { transaction_amount: novo.valor, currency_id: "BRL" } });
  if (!r.ok) throw new Error("o Mercado Pago recusou mudar o valor da assinatura (HTTP " + r.status + ")");
  return medidor(env, d.id).pedir("plano_proximo", { plano: novo.id, valor: novo.valor });
}

const CAMPOS_DO_ENDERECO = ["cep", "logradouro", "numero", "complemento", "bairro", "cidade", "uf"];

/* O codigo IBGE da cidade (a mesma tabela da NFS-e), ou "" se o nome nao bate exato. */
function cmunDe(cidade, uf) {
  const alvo = semAcento(cidade);
  if (!alvo || !/^[A-Z]{2}$/.test(String(uf || "").toUpperCase())) return "";
  const m = buscarMunicipios(String(cidade), String(uf).toUpperCase(), 5).find((x) => semAcento(x.nome) === alvo);
  return m ? m.codigo : "";
}

/* conta.cadastro: o cadastro de agora com os campos que o painel mudou
   ({escritorio, documento, telefone, oab, cep, logradouro, numero, complemento,
   bairro, cidade, uf}), conferido como o do site (conferirCadastro). O aceite
   dos termos fica o que a pessoa deu (versao e data); a edicao fica anotada
   em "ajustado". Cidade ou UF novas trazem o codigo IBGE da tabela. -> {cadastro} ou {erro}. */
async function cadastroEditado(c, d) {
  const det = await medidor(c.env, d.id).pedir("admin_detalhe");
  if (!det || det.ok === false) return { erro: "conta não encontrada" };
  const antes = det.cadastro || null;
  const end0 = (antes && antes.endereco) || {};
  const veio = (k) => d[k] !== undefined && d[k] !== null;
  const mudou = ["escritorio", "documento", "telefone", "oab", ...CAMPOS_DO_ENDERECO].filter(veio);
  if (!mudou.length) return { erro: "nada mudou no cadastro" };
  const pedido = {
    nome_escritorio: veio("escritorio") ? d.escritorio : (antes && antes.nome_escritorio) || det.nome || "",
    documento: veio("documento") ? d.documento : (antes && antes.documento) || "",
    telefone: veio("telefone") ? d.telefone : (antes && antes.telefone) || "",
    oab: veio("oab") ? d.oab : (antes && antes.oab) || "",
    aceite: true,
  };
  const mexeuNoEndereco = CAMPOS_DO_ENDERECO.some(veio);
  if ((antes && antes.endereco) || mexeuNoEndereco) {
    const e = {};
    for (const k of CAMPOS_DO_ENDERECO) e[k] = veio(k) ? d[k] : end0[k] || "";
    e.cmun = veio("cidade") || veio("uf") ? cmunDe(e.cidade, e.uf) : end0.cmun || "";
    pedido.endereco = e;
  }
  const r = conferirCadastro(pedido, { exigirEndereco: Boolean((antes && antes.endereco) || mexeuNoEndereco) });
  if (r.erro) return { erro: r.erro };
  const cadastro = { ...(antes || {}), ...r.cadastro, ajustado: { quando: iso(c.agora), por: c.quem.email, campos: mudou } };
  // Quem aceitou os termos foi a pessoa, na versao dela: a edicao do painel nao aceita nada por ela.
  if (antes && antes.termos) cadastro.termos = antes.termos;
  else delete cadastro.termos;
  if (antes && antes.quando) cadastro.quando = antes.quando;
  if (!r.cadastro.endereco && !(antes && antes.endereco)) delete cadastro.endereco;
  return { cadastro };
}

/* Por que pausar (ou retomar, com retomar: true) nao da ("" se da). */
async function motivoContraPausa(c, d) {
  const det = await medidor(c.env, d.id).pedir("admin_detalhe");
  if (!det || det.ok === false) return "conta não encontrada";
  const a = det.assinatura || null;
  if (det.forma && det.forma.tipo === "pix") return "no Pix mensal não há cobrança automática no Mercado Pago para pausar: o Pix de cada mês vai por e-mail, e a pessoa paga se quiser";
  if (!a || !a.id) return "a conta não tem assinatura no Mercado Pago";
  if (prepago(det.periodo) || prepago(a.periodo)) {
    return "o plano pago de uma vez (anual ou mês no Pix) não tem cobrança mensal no Mercado Pago: não há o que pausar" + (det.pago_ate ? "; ele vale até " + dataBR(det.pago_ate) : "");
  }
  if (d.retomar) return a.situacao === "paused" ? "" : "a assinatura não está pausada (está " + (a.situacao || "sem situação") + ")";
  return a.situacao === "authorized" ? "" : "só a assinatura ativa pausa (esta está " + (a.situacao || "sem situação") + ")";
}

/* conta.pausar: PUT /preapproval/{id} {status: "paused"} (ou "authorized" para
   retomar) e a conta anota a situacao nova. -> {assinatura, de, para} (o retrato usa). */
async function aplicarPausa(c, d) {
  const { env } = c;
  const motivo = await motivoContraPausa(c, d);
  if (motivo) throw new Error(motivo);
  const mp = c.deps.chamarMP;
  if (!mp) throw new Error("sem o Mercado Pago");
  const a = (await medidor(env, d.id).pedir("resumo")).assinatura;
  const para = d.retomar ? "authorized" : "paused";
  const r = await mp(env, "/preapproval/" + encodeURIComponent(a.id), "PUT", { status: para });
  if (!r.ok) throw new Error("o Mercado Pago recusou " + (d.retomar ? "retomar" : "pausar") + " a assinatura (HTTP " + r.status + ")");
  await medidor(env, d.id).pedir("assinatura", { assinatura: { id: a.id, situacao: para } });
  return { assinatura: a.id, de: a.situacao, para };
}

// ------------------------------------------------- a oferta para voltar (Nao renovacoes)

/* renov.oferta {id, tipo: "creditos", tokens} | {id, tipo: "preco", valor, plano}:
   sem cupom. A conta guarda a oferta (worker/ia.js, ofertaDeVolta): os creditos
   entram com o proximo pagamento confirmado; o preco especial vale no proximo
   pagamento do plano - na assinatura que ainda existe, ou na nova pelo site.
   Vale 60 dias. A pessoa recebe um e-mail contando. */
async function conferirOferta(c, d) {
  if (d.tipo === "creditos") {
    const t = Math.round(Number(d.tokens) || 0);
    if (!(t >= 1e5 && t <= 5e8)) return "os créditos vão de 0,1 M a 500 M";
  } else if (d.tipo === "preco") {
    const n = numeros(await envComPlanos(c));
    if (!n.planos.some((p) => p.id === String(d.plano || ""))) return "esse plano não existe";
    const plano = planoDe(n, String(d.plano));
    const v = Math.round(Number(d.valor) * 100) / 100;
    if (!(v > 0 && v < plano.valor)) return "o preço especial fica entre zero e o valor do plano (" + brl(plano.valor) + ")";
  } else return "qual oferta? (créditos ou preço especial)";
  if (!c.env.RESEND_API_KEY) return "a oferta vai por e-mail para a pessoa, e o envio ainda não está ligado: falta RESEND_API_KEY";
  const r = await renovacoes(c);
  if (![...r.abertas, ...r.tratadas].some((x) => x.id === d.id)) return "essa conta não está em Não renovações";
  return "";
}

async function aplicarOferta(c, d) {
  const env = await envComPlanos(c);
  const erro = await conferirOferta(c, d);
  if (erro) throw new Error(erro);
  const oferta = d.tipo === "creditos" ? { tipo: "creditos", tokens: Math.round(Number(d.tokens)) }
    : { tipo: "preco", valor: Math.round(Number(d.valor) * 100) / 100, plano: String(d.plano) };
  const r = await ofertaDeVolta(env, c.deps.chamarMP, d.id, oferta, c.quem.email);
  if (!r || r.ok === false) throw new Error((r && r.erro) || "a oferta não foi guardada na conta");
  const o = r.oferta_volta || {};
  const ren = await renovacoes(c);
  const item = [...ren.abertas, ...ren.tratadas].find((x) => x.id === d.id);
  // A marca da renovacao guarda a oferta (a tela ve em "oferta").
  if (item) {
    const marca = await marcaDaRenovacao(c, item);
    marca.oferta = { ...oferta, ate: o.ate || "", quando: iso(c.agora), por: c.quem.email, na_assinatura: Boolean(r.na_assinatura) };
    await env.APOIOS.put("admin:renov:" + d.id, JSON.stringify(marca));
    c._renovacoes = null;
  }
  const email = (item && item.email) || r.email || "";
  const e = await enviarEmail(env, emailDaOferta(item, oferta, r, numeros(env)));
  if (!e.ok) return { ...r, aviso: "a oferta ficou guardada na conta, mas o e-mail para " + (email || "a pessoa") + " não saiu: " + e.erro };
  return r;
}

function emailDaOferta(item, oferta, r, n) {
  const o = r.oferta_volta || {};
  const ate = o.ate ? dataBR(o.ate) : "";
  const ola = item && item.nome ? "Olá, " + primeiroNome(item.nome) + ".\n\n" : "";
  const planoDele = item && item.plano ? "O seu plano " + item.plano.nome + " não renovou." : "O seu plano do Paulus não renovou.";
  if (oferta.tipo === "creditos") {
    const m = Number(oferta.tokens) / 1e6;
    const quanto = (Number.isInteger(m) ? String(m) : m.toLocaleString("pt-BR", { maximumFractionDigits: 1 })) + (m === 1 ? " milhão" : " milhões");
    return {
      para: (item && item.email) || r.email, assunto: "Créditos extras para você voltar ao Paulus", titulo: quanto + " de créditos para você voltar",
      texto: ola + planoDele + " Para você voltar, deixamos " + quanto + " de créditos extras na sua conta: eles entram sozinhos com o próximo pagamento confirmado, além dos créditos do plano" +
        (ate ? ". A oferta vale até " + ate : "") + ".\n\nPara voltar, confira o cartão na sua conta do Mercado Pago ou assine de novo em paulus.ia.br/assinatura.",
      botao: "Voltar ao Paulus", link: SITE + "/assinatura/",
    };
  }
  const plano = planoDe(n, oferta.plano);
  if (r.na_assinatura) {
    return {
      para: (item && item.email) || r.email, assunto: "Um preço especial para você voltar ao Paulus", titulo: "O próximo mês por " + brl(oferta.valor),
      texto: ola + planoDele + " Para você voltar, a sua assinatura no Mercado Pago passa a cobrar " + brl(oferta.valor) + " no próximo pagamento do plano " + plano.nome +
        ", no lugar de " + brl(plano.valor) + ". Depois dele, volta ao valor do plano.\n\nPara voltar, confira o cartão na sua conta do Mercado Pago ou em paulus.ia.br/minha-conta.",
      botao: "Abrir a Minha conta", link: SITE + "/minha-conta/",
    };
  }
  return {
    para: (item && item.email) || r.email, assunto: "Um preço especial para você voltar ao Paulus", titulo: "O primeiro mês por " + brl(oferta.valor),
    texto: ola + planoDele + " Para você voltar: assinando o plano " + plano.nome + " de novo pelo site" + (ate ? " até " + ate : "") + ", o primeiro mês sai por " + brl(oferta.valor) +
      ", no lugar de " + brl(plano.valor) + " (no cartão ou no Pix). Depois dele, volta ao valor do plano.",
    botao: "Assinar de novo", link: SITE + "/assinatura/",
  };
}

/* As assinaturas mensais que o Mercado Pago cobra no proximo mes pelo plano
   `id` (o plano marcado para a renovacao, se houver, senao o de agora) passam
   a cobrar `valor`. O pago de uma vez (anual, mes no Pix) nao tem
   preapproval; quem esta com uma cobranca de valor ajustado (oferta,
   diferenca de troca) fica com o ajuste e passa ao preco do plano quando ele
   acabar; o aviso diz quem. */
async function valorNasAssinaturas(c, id, valor, frase) {
  const { env } = c;
  const mp = c.deps.chamarMP;
  if (!mp) return {};
  c._contas = null;
  const contas = (await lerContas(c)).filter((x) => {
    const a = x._d.assinatura || {};
    const proximo = x._d.plano_proximo ? x._d.plano_proximo.id : (x.plano || {}).id;
    return proximo === id && a.situacao === "authorized" && a.id && !prepago(a.periodo) && !prepago(x._d.periodo);
  });
  const erros = [];
  const ajustadas = [];
  for (const conta of contas) {
    if (conta._d.ajuste) {
      ajustadas.push(conta.nome);
      continue;
    }
    const r = await mp(env, "/preapproval/" + encodeURIComponent(conta._d.assinatura.id), "PUT", { auto_recurring: { transaction_amount: valor, currency_id: "BRL" } });
    if (!r.ok) erros.push(conta.nome);
  }
  if (erros.length) throw new Error(frase + erros.join(", "));
  // No fim do ajuste, quem pagava o preco do plano passa ao preco dele de entao (worker/ia.js, avancarAjuste).
  return ajustadas.length ? { aviso: "com uma cobrança de valor ajustado em curso, passam ao preço do plano quando o ajuste acabar: " + ajustadas.join(", ") } : {};
}

/* O disparo de uma campanha: a lista de quem recebe fica no KV ate o fim do
   envio (o Cron manda 50 por minuto) e sai depois; ficam so os numeros.
   quando: "agora", "amanha" e "segunda" (9 h de Brasilia) ou "agendado", com
   de (AAAA-MM-DD) e hora (HH:MM) de Brasilia: fica guardada e o Cron de cada
   minuto dispara na hora marcada. publico "escolhidas": as contas de `contas`. */
async function dispararCampanha(c, d) {
  const contas = await lerContas(c);
  let pub;
  if (d.publico === "escolhidas") {
    const ids = new Set((Array.isArray(d.contas) ? d.contas : []).map(String));
    const cs = contas.filter((x) => ids.has(x.id));
    if (!cs.length) throw new Error("nenhuma das contas escolhidas existe mais");
    pub = ["escolhidas", cs.length === 1 ? "Só " + cs[0].nome : cs.length + " contas escolhidas", cs];
  } else pub = publicosDe(contas, d.publico).find((x) => x[0] === d.publico);
  if (!pub) throw new Error("esse público não existe mais");
  const id = "c" + aleatorio(7);
  const agora = c.agora;
  // As 9 h de Brasilia (12 h UTC) de amanha ou da proxima segunda.
  const proxima = (diaSemana) => {
    const hoje = new Date(agora - 3 * 3600 * 1000);
    const base = Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate(), 12);
    const dias = diaSemana === undefined ? 1 : ((diaSemana - hoje.getUTCDay() + 7) % 7) || 7;
    return new Date(base + dias * DIA_MS).toISOString();
  };
  let envioEm = new Date(agora).toISOString();
  if (d.quando === "amanha") envioEm = proxima();
  else if (d.quando === "segunda") envioEm = proxima(1);
  else if (d.quando === "agendado") {
    const ms = horaMarcada(d);
    if (!Number.isFinite(ms)) throw new Error("a campanha agendada precisa do dia e da hora");
    // Publicada depois da hora marcada: nao sai sozinha atrasada.
    if (ms <= agora) throw new Error("a hora marcada (" + dataHoraBR(ms) + ") passou antes de publicar: agende de novo");
    envioEm = new Date(ms).toISOString();
  }
  const camp = {
    id, nome: String(d.nome || d.assunto || "Campanha").slice(0, 80), publico: { id: pub[0], label: pub[1] },
    assunto: String(d.assunto).slice(0, 200), pre: String(d.pre || "").slice(0, 200), titulo: String(d.titulo || "").slice(0, 160),
    texto: String(d.texto).slice(0, 8000), botao: String(d.botao || "").slice(0, 40), link: /^https:\/\//.test(String(d.link || "")) ? String(d.link) : "",
    situacao: d.quando === "agora" || !d.quando ? "na fila" : "agendada", envio_em: envioEm, quando: envioEm, por: c.quem.email,
    destinatarios: pub[2].filter((x) => x.email).map((x) => ({ t: aleatorio(6), email: x.email, ...camposDe(x) })), cursor: 0, enviados: 0, abertos: 0, cliques: 0, devolvidos: 0,
  };
  await c.env.APOIOS.put("admin:campanha:" + id, JSON.stringify(camp));
  const fila = (await kvJSON(c.env, "admin:campanhas:fila", [])) || [];
  await c.env.APOIOS.put("admin:campanhas:fila", JSON.stringify([...fila, id]));
  return { id };
}
