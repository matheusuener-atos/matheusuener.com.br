// O Worker do paulus.ia.br: o site (pasta site/), a nuvem do PAULUS, o
// acesso de fora e a calibracao dos modelos.
//
// O Access Token do Mercado Pago so existe aqui, como segredo do Worker
// (npx wrangler secret put MP_ACCESS_TOKEN) - nunca no programa que roda na
// maquina de cada usuario, onde qualquer um poderia le-lo. Ele serve so a
// nuvem do PAULUS (a assinatura do plano e a recarga, em worker/ia.js).
//
//   POST /api/mp/aviso        o webhook do Mercado Pago (assinatura conferida);
//                             o que ele confirma vai para avisoDaIA
//   POST /api/calibracao      medidas de maquina e modelo, de quem escolheu
//                             participar (so numeros; veja receberCalibracao)
//   GET  /api/calibracao      todas as medidas, para o programa estimar melhor
//
// Todo o resto e o site estatico.
//
// As notas fiscais (NFS-e do PAVLVS) sao emitidas pelo painel admin, em
// /api/admin/nfse/* (worker/admin.js -> worker/nfse/api.js -> o Durable Object
// EmissorNFSe). A antiga ponte com o PAULUS da casa (/api/nfse-casa/*) saiu.
//
// O acesso de fora (worker/tunel.js): /conectar e /api/tunel/*, que criam o
// caminho de cada escritorio ate o PAULUS dele. Desligado sem TUNEL_ATIVO.
//
// A nuvem do PAULUS (worker/ia.js): /api/ia/*, o portao ate os provedores dos
// modelos (DeepInfra, Mistral, Anthropic) com o medidor de creditos, a
// assinatura do plano (mensal ou anual) e a recarga. Desligada sem IA_ATIVA.
// O aviso do Mercado Pago e entregue a avisoDaIA, que reconhece a assinatura,
// o pagamento do ano e a recarga pela referencia; o resto e ignorado.
//
// O KV APOIOS guarda hoje so a calibracao (chave "calibracao:todas"). O nome
// vem do antigo "Apoiar o projeto", que saiu; o binding ficou com o nome para
// nao pedir configuracao nova no Cloudflare. As chaves antigas do apoio que
// ainda estiverem la ("pix:", "assinatura:", "cartao:") vencem sozinhas.

import { atenderTunel, ehRotaDoTunel, limparEscritorios } from "./tunel.js";
import { atenderIA, avisoDaIA, cronDaConta, ehRotaDaIA } from "./ia.js";
import { atenderConta, ehRotaDaConta } from "./conta.js";
import { atenderAdmin, ehRotaDoAdmin, comPlanosDoPainel, enviarCampanhas, enviarEmail } from "./admin.js";
import { depoisPendentes } from "./nfse/api.js";
import { atenderIdentidade, ehRotaDaIdentidade } from "./identidade.js";

// O medidor da nuvem do PAULUS (worker/ia.js): um Durable Object por conta.
export { ContaIA } from "./ia.js";
// O emissor de NFS-e da nuvem (worker/nfse/emissor.js): a classe do Durable
// Object (o binding EMISSOR_NFSE pede). As rotas ficam no painel admin.
export { EmissorNFSe } from "./nfse/emissor.js";

const MP = "https://api.mercadopago.com";
// O aviso do Mercado Pago mais velho que isto e recusado (repeticao).
const AVISO_VALIDADE_MS = 10 * 60 * 1000;

export default {
  async fetch(request, envOriginal, ctx) {
    const url = new URL(request.url);
    // Os planos publicados pelo painel admin (KV) valem no lugar de IA_PLANOS.
    const env = url.pathname.startsWith("/api/") ? await comPlanosDoPainel(envOriginal) : envOriginal;
    // O Worker nunca atende <escritorio>.paulus.ia.br: esse trafego e do tunel
    // de cada escritorio, direto da Cloudflare ao computador dele. Se uma rota
    // curinga um dia apontar para ca por engano, nada passa por aqui.
    if (url.hostname.endsWith(".paulus.ia.br") && url.hostname !== "www.paulus.ia.br") {
      return new Response("não encontrado", { status: 404 });
    }
    if (ehRotaDoTunel(url)) {
      try {
        return await atenderTunel(request, env, url, { dentroDoLimite });
      } catch (erro) {
        return json({ erro: "falha no servidor do acesso externo" }, 500);
      }
    }
    if (ehRotaDoAdmin(url)) {
      try {
        return await atenderAdmin(request, env, url, ctx, { dentroDoLimite, chamarMP });
      } catch (erro) {
        return json({ erro: "falha no servidor do painel" }, 500);
      }
    }
    if (ehRotaDaIA(url)) {
      try {
        return await atenderIA(request, env, url, ctx, { dentroDoLimite, chamarMP });
      } catch (erro) {
        return json({ erro: "falha no servidor da nuvem" }, 500);
      }
    }
    // A conta PAVLVS por e-mail e senha (worker/identidade.js): a alternativa ao Google.
    if (ehRotaDaIdentidade(url)) {
      try {
        return await atenderIdentidade(request, env, url, { dentroDoLimite, enviarEmail });
      } catch (erro) {
        return json({ erro: "falha no servidor da conta" }, 500);
      }
    }
    // A Minha conta (worker/conta.js): a sessao do site, o plano, o pagamento e o escritorio.
    if (ehRotaDaConta(url)) {
      try {
        return await atenderConta(request, env, url, ctx, { dentroDoLimite, chamarMP });
      } catch (erro) {
        return json({ erro: "falha no servidor da Minha conta" }, 500);
      }
    }
    if (url.pathname === "/cadastro" || url.pathname.startsWith("/cadastro/")) return comCSP(await env.ASSETS.fetch(request));
    // A Minha conta tem o cartao (os campos seguros do Mercado Pago) : a mesma CSP do cadastro (a entrada e a Conta Atos, que abre em outra janela).
    if (/^\/(minha-conta|en\/my-account)(\/|$)/.test(url.pathname)) return comCSP(await env.ASSETS.fetch(request));
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    try {
      if (url.pathname === "/api/mp/aviso" && request.method === "POST") return await receberAviso(request, url, env, ctx);
      if (url.pathname === "/api/calibracao" && request.method === "POST") {
        if (!(await dentroDoLimite(request, env))) return json({ erro: "muitas tentativas seguidas - espere um minuto" }, 429);
        return await receberCalibracao(request, env);
      }
      if (url.pathname === "/api/calibracao" && request.method === "GET") return await entregarCalibracao(env);
      return json({ erro: "rota não existe" }, 404);
    } catch (erro) {
      return json({ erro: "falha no servidor" }, 500);
    }
  },

  // O Cron Trigger diario (wrangler.jsonc): libera os enderecos do acesso de
  // fora que nunca conectaram em 7 dias ou estao parados ha mais de 180.
  // Sem TUNEL_ATIVO e sem o KV, nao faz nada.
  // O Cron de cada minuto manda a proxima leva das campanhas do painel admin
  // (50 por minuto; sem RESEND_API_KEY, nada) e faz o PDF (e o e-mail) de uma
  // NFS-e emitida que ainda nao tem (worker/nfse/api.js, depoisPendentes; sem
  // nota esperando, uma leitura do KV).
  async scheduled(controller, envOriginal, ctx) {
    const env = await comPlanosDoPainel(envOriginal);
    if (controller && controller.cron === "* * * * *") {
      ctx.waitUntil(enviarCampanhas(env));
      ctx.waitUntil(depoisPendentes(env).catch(() => null));
    } else {
      ctx.waitUntil(limparEscritorios(env));
      // A Minha conta: o Pix do mes de quem paga no Pix (3 dias antes) e os
      // valores de assinatura que o Mercado Pago recusou voltar (worker/ia.js).
      ctx.waitUntil(cronDaConta(env, chamarMP, enviarEmail).catch(() => null));
    }
  },
};

/* A pagina de assinar e pagar (site/cadastro): o cartao e digitado nela, nos
   campos seguros do Mercado Pago. So rodam scripts do proprio site e do Mercado Pago;
   um script injetado (o golpe dos campos falsos por cima do
   formulario) e bloqueado pelo navegador. Nenhum script inline roda: o do
   tema, nessas paginas, e o assets/tema-cedo.js. O MercadoPago.js injeta um script inline de telemetria (sendCookies /
   setDeprecationLab), diferente a cada carga: ele fica bloqueado de proposito
   - libera-lo pediria 'unsafe-inline' - e o formulario do cartao funciona sem
   ele (conferido no Edge com a chave de teste, 03/10/2026). */
export const CSP_CADASTRO = [
  "default-src 'self'",
  "script-src 'self' https://sdk.mercadopago.com https://*.mercadopago.com https://*.mlstatic.com https://*.mercadolibre.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: https:",
  "connect-src 'self' https://*.mercadopago.com https://*.mercadolibre.com https://*.mlstatic.com https://viacep.com.br https://brasilapi.com.br",
  "frame-src https://*.mercadopago.com https://*.mercadolibre.com https://*.mercadolivre.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

function comCSP(resposta) {
  const r = new Response(resposta.body, resposta);
  if ((r.headers.get("content-type") || "").includes("text/html")) {
    r.headers.set("content-security-policy", CSP_CADASTRO);
    r.headers.set("referrer-policy", "strict-origin-when-cross-origin");
    r.headers.set("x-content-type-options", "nosniff");
  }
  return r;
}

function json(dados, status = 200) {
  return new Response(JSON.stringify(dados), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function dentroDoLimite(request, env) {
  if (!env.LIMITE) return true;
  const chave = request.headers.get("cf-connecting-ip") || "sem-ip";
  const { success } = await env.LIMITE.limit({ key: chave });
  return success;
}

async function lerPedido(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/* `extra`: cabecalhos a mais; a cobranca com cartao manda a sua X-Idempotency-Key
   (a mesma numa nova tentativa do mesmo pagamento nao cobra duas vezes). */
async function chamarMP(env, caminho, metodo, corpo, extra = {}) {
  const headers = { Authorization: `Bearer ${env.MP_ACCESS_TOKEN}`, "Content-Type": "application/json" };
  if (metodo === "POST") headers["X-Idempotency-Key"] = crypto.randomUUID();
  Object.assign(headers, extra);
  const resposta = await fetch(MP + caminho, { method: metodo, headers, body: corpo ? JSON.stringify(corpo) : undefined });
  let dados = null;
  try {
    dados = await resposta.json();
  } catch {
    dados = null;
  }
  return { ok: resposta.ok, status: resposta.status, dados };
}

// ---------------------------------------------------------------- aviso

/* O que o aviso diz, conferido na fonte: o aviso so traz o id - a situacao
   vem do Mercado Pago, com o token, e so entao vai para a nuvem
   (avisoDaIA), que sabe se a referencia e dela. */
async function registrarAviso(tipo, id, env) {
  if (!id) return;
  if (tipo === "order") {
    const r = await chamarMP(env, "/v1/orders/" + encodeURIComponent(id), "GET");
    if (r.ok) await avisoDaIA(env, "order", r.dados, chamarMP);
  } else if (tipo === "subscription_preapproval" || tipo === "preapproval") {
    const r = await chamarMP(env, "/preapproval/" + encodeURIComponent(id), "GET");
    if (r.ok) await avisoDaIA(env, "preapproval", r.dados, chamarMP);
  } else if (tipo === "payment") {
    // O pagamento do plano anual (Checkout Pro): aprovado, estornado.
    const r = await chamarMP(env, "/v1/payments/" + encodeURIComponent(id), "GET");
    if (r.ok) await avisoDaIA(env, "pagamento", r.dados, chamarMP);
  } else if (tipo === "subscription_authorized_payment") {
    // Cada cobranca mensal da assinatura.
    const r = await chamarMP(env, "/authorized_payments/" + encodeURIComponent(id), "GET");
    if (r.ok) await avisoDaIA(env, "cobranca", r.dados, chamarMP);
  }
}

/* O webhook: so aceita aviso com a assinatura do Mercado Pago certa
   (HMAC-SHA256 do "manifest" com a chave secreta do webhook). Aceito, a
   situacao e buscada no Mercado Pago e entregue a nuvem - depois da
   resposta, para o Mercado Pago nao esperar. */
async function receberAviso(request, url, env, ctx) {
  const assinatura = request.headers.get("x-signature") || "";
  const requestId = request.headers.get("x-request-id") || "";
  const partes = Object.fromEntries(assinatura.split(",").map((p) => p.trim().split("=")).filter((p) => p.length === 2));
  const ts = partes.ts || "";
  const v1 = (partes.v1 || "").toLowerCase();
  if (!ts || !v1 || !env.MP_WEBHOOK_SECRET) return json({ erro: "aviso sem assinatura" }, 401);

  const dataId = url.searchParams.get("data.id") || "";
  // O id alfanumerico entra no manifest em minusculas; o numerico, como veio.
  const candidatos = [...new Set([dataId, dataId.toLowerCase()])];
  let valido = false;
  for (const id of candidatos) {
    const manifest = (id ? `id:${id};` : "") + (requestId ? `request-id:${requestId};` : "") + `ts:${ts};`;
    if (igual(await hmacHex(env.MP_WEBHOOK_SECRET, manifest), v1)) valido = true;
  }
  if (!valido) return json({ erro: "assinatura não confere" }, 401);

  const quando = Number(ts) < 1e12 ? Number(ts) * 1000 : Number(ts);
  if (Math.abs(Date.now() - quando) > AVISO_VALIDADE_MS) return json({ erro: "aviso velho" }, 401);
  const tipo = url.searchParams.get("type") || url.searchParams.get("topic") || "";
  const trabalho = registrarAviso(tipo, dataId, env).catch(() => null);
  if (ctx && ctx.waitUntil) ctx.waitUntil(trabalho);
  else await trabalho;
  return json({ recebido: true });
}

async function hmacHex(segredo, mensagem) {
  const chave = await crypto.subtle.importKey("raw", new TextEncoder().encode(segredo), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const assinado = await crypto.subtle.sign("HMAC", chave, new TextEncoder().encode(mensagem));
  return [...new Uint8Array(assinado)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* Comparacao em tempo constante: nao revela em que letra a assinatura errou. */
function igual(a, b) {
  if (a.length !== b.length) return false;
  let diferenca = 0;
  for (let i = 0; i < a.length; i++) diferenca |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diferenca === 0;
}

// ------------------------------------------------------------ calibracao
//
// A estimativa de quanto cada modelo de IA demora numa maquina
// (paulus/legal/src/maquina.py) melhora com medidas de muitas maquinas. Quem
// escolhe participar, no programa, manda as medidas da maquina dele e recebe
// as de todos. So numeros da maquina e do modelo: processador, memoria, as
// duas velocidades medidas, o modelo e as palavras por segundo dele. Nada do
// escritorio, nada de pessoa. Cada amostra e conferida campo a campo; o que
// nao cabe no formato e jogado fora.
//
// Tudo numa chave so do KV APOIOS (prefixo "calibracao:"), para nao pedir
// configuracao nova no Cloudflare. Uma amostra por maquina e modelo: medir de
// novo troca a antiga. Guarda as 5000 mais recentes.

const CAL_CHAVE = "calibracao:todas";
const CAL_MAXIMO = 5000;
const CAL_POR_PEDIDO = 50;

function calNumero(v, min, max) {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
}

function calTexto(v, max, re) {
  return typeof v === "string" && v.length <= max && (!re || re.test(v));
}

function limparAmostra(a) {
  if (!a || typeof a !== "object") return null;
  const m = a.maquina || {};
  const ok =
    calTexto(m.id, 32, /^[0-9a-f]{6,32}$/) && calNumero(m.versao, 1, 99) &&
    calTexto(m.processador, 120, /^[\x20-\x7EÀ-ſ]*$/) && calNumero(m.nucleos, 1, 512) &&
    calNumero(m.ram_total_gb, 0.5, 4096) && calNumero(m.banda_gbs, 0.1, 2000) && calNumero(m.gflops, 0.1, 100000) &&
    calTexto(a.modelo, 120, /^[a-z0-9][a-z0-9._:\/-]*$/i) && calNumero(a.tamanho_gb, 0.01, 500) &&
    calNumero(a.parametros_b, 0.01, 2000) && calTexto(a.quantizacao || "", 20, /^[A-Za-z0-9_]*$/) &&
    calNumero(a.escrita_tps, 0.01, 10000) && calNumero(a.leitura_tps || 0, 0, 100000);
  if (!ok) return null;
  return {
    maquina: {
      id: m.id, versao: m.versao, processador: m.processador, nucleos: m.nucleos, ram_total_gb: m.ram_total_gb,
      avx2: m.avx2 === true ? true : m.avx2 === false ? false : null, banda_gbs: m.banda_gbs, gflops: m.gflops,
      na_bateria: m.na_bateria === true ? true : m.na_bateria === false ? false : null,
    },
    gpu: a.gpu === true,
    modelo: a.modelo, tamanho_gb: a.tamanho_gb, parametros_b: a.parametros_b, quantizacao: a.quantizacao || "",
    escrita_tps: a.escrita_tps, leitura_tps: a.leitura_tps || 0,
    quando: new Date().toISOString().slice(0, 16).replace("T", " "),
  };
}

async function receberCalibracao(request, env) {
  if (!env.APOIOS) return json({ erro: "armazenamento indisponível" }, 503);
  const corpo = await lerPedido(request);
  const lista = Array.isArray(corpo && corpo.amostras) ? corpo.amostras.slice(0, CAL_POR_PEDIDO) : [];
  const limpas = lista.map(limparAmostra).filter(Boolean);
  if (!limpas.length) return json({ erro: "nenhuma amostra válida" }, 400);
  let todas = [];
  try {
    todas = JSON.parse((await env.APOIOS.get(CAL_CHAVE)) || "[]");
  } catch {
    todas = [];
  }
  for (const a of limpas) {
    const i = todas.findIndex((x) => x.maquina.id === a.maquina.id && x.modelo === a.modelo);
    if (i >= 0) todas.splice(i, 1);
    todas.push(a);
  }
  todas = todas.slice(-CAL_MAXIMO);
  await env.APOIOS.put(CAL_CHAVE, JSON.stringify(todas));
  return json({ recebidas: limpas.length, total: todas.length });
}

async function entregarCalibracao(env) {
  const bruto = env.APOIOS ? await env.APOIOS.get(CAL_CHAVE) : null;
  let amostras = [];
  try {
    amostras = bruto ? JSON.parse(bruto) : [];
  } catch {
    amostras = [];
  }
  return new Response(JSON.stringify({ versao: 1, amostras }), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=3600" },
  });
}
