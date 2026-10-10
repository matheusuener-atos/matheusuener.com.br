// Testes da Atos Cobranca (worker/cobranca/): o checkout, as assinaturas, as compras, os direitos e o
// aviso do Mercado Pago - com o Mercado Pago simulado (nada vai a internet) e o objeto do cliente de verdade.
//   node worker/cobranca/teste.mjs
import { createHmac } from "node:crypto";
import worker from "../index.js";
import { ClienteCobranca, idDoCliente, maisUmMes } from "./cliente.js";
import { conferirPerfil, cnpjValido, cpfValido } from "./api.js";
import { resolveOffer } from "./catalogo.js";
import { sha256 } from "../comum.js";
import { verificarEvento } from "./eventos.js";

let falhas = 0;
function checar(cond, texto, extra) {
  console.log((cond ? "  ok   " : "  FALHA ") + texto + (cond || extra === undefined ? "" : " -> " + JSON.stringify(extra)));
  if (!cond) falhas++;
}

// --- o ambiente: o KV, os objetos dos clientes (de verdade, com storage em memoria) e o Mercado Pago simulado
const kv = new Map();
const CONTAS = {
  async get(k, tipo) { const v = kv.get(k); return v === undefined ? null : tipo === "json" ? JSON.parse(v) : v; },
  async put(k, v) { kv.set(k, v); },
  async delete(k) { kv.delete(k); },
};
function storage() {
  const m = new Map();
  return {
    alarme: null,
    async get(k) { return m.has(k) ? structuredClone(m.get(k)) : undefined; },
    async put(k, v) { m.set(k, structuredClone(v)); },
    async list({ prefix = "" } = {}) { return new Map([...m].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v)])); },
    async setAlarm(t) { this.alarme = t; },
  };
}
const objetos = new Map();
const CLIENTES = {
  idFromName: (n) => n,
  get(id) {
    if (!objetos.has(id)) objetos.set(id, new ClienteCobranca({ storage: storage() }, env));
    return { fetch: (url, op) => objetos.get(id).fetch(new Request(url, op)) };
  },
};
const env = {
  CONTAS, CLIENTES, APP_URL: "https://atos.dev.br", MP_PUBLIC_KEY: "PUBLICA-DE-TESTE", MP_ACCESS_TOKEN: "segredo-mp",
  MP_WEBHOOK_SECRET: "segredo-do-aviso", PRODUTOS_ABERTOS: "pavlvs", EVENTOS_SEGREDO_PAVLVS: "segredo-dos-eventos",
  ASSETS: { fetch: async (req) => new Response(String(new URL(req.url).pathname).includes("assinar")
    ? '<html><script src="https://sdk.mercadopago.com/js/v2"></script><script>var x = 1;</script></html>' : "<p>pagina</p>",
    { headers: { "content-type": "text/html" } }) },
};

const mp = { pedidos: [], orders: new Map(), preapprovals: new Map(), authorized: new Map(), recusar: null };
// O produto (o PAVLVS) recebendo os eventos: o que chegou e o status que ele responde.
const produto = { recebidos: [], responde: 200 };
globalThis.fetch = async (url, op = {}) => {
  url = String(url);
  const corpo = op.body ? JSON.parse(op.body) : null;
  mp.pedidos.push({ url, metodo: op.method || "GET", corpo, headers: op.headers || {} });
  const resp = (d, s = 200) => new Response(JSON.stringify(d), { status: s });
  if (url === "https://api.mercadopago.com/preapproval" && op.method === "POST") {
    if (mp.recusar) return resp({ message: mp.recusar }, 400);
    const p = { id: "pre-" + mp.preapprovals.size, status: "authorized", external_reference: corpo.external_reference, next_payment_date: "2026-11-10T00:00:00Z" };
    mp.preapprovals.set(p.id, p);
    return resp(p, 201);
  }
  let m = /\/preapproval\/([^/?]+)$/.exec(url);
  if (m) {
    const p = mp.preapprovals.get(decodeURIComponent(m[1]));
    if (!p) return resp({ message: "not found" }, 404);
    if (op.method === "PUT") p.status = corpo.status;
    return resp(p);
  }
  if (url === "https://api.mercadopago.com/v1/orders" && op.method === "POST") {
    const pag = corpo.transactions.payments[0];
    const pix = pag.payment_method.id === "pix";
    const o = { id: "ORD" + mp.orders.size, external_reference: corpo.external_reference, status: pix ? "action_required" : (mp.recusar ? "failed" : "processed"),
      status_detail: pix ? "waiting_transfer" : (mp.recusar || "accredited"),
      transactions: { payments: [{ status_detail: mp.recusar || "", payment_method: pix ? { id: "pix", type: "bank_transfer", qr_code: "00020126...", qr_code_base64: "iVBOR", ticket_url: "https://mp/ticket" } : pag.payment_method }] } };
    mp.orders.set(o.id, o);
    return resp(o, 201);
  }
  m = /\/v1\/orders\/([^/?]+)$/.exec(url);
  if (m) return mp.orders.has(m[1]) ? resp(mp.orders.get(m[1])) : resp({}, 404);
  m = /\/authorized_payments\/([^/?]+)$/.exec(url);
  if (m) return mp.authorized.has(m[1]) ? resp(mp.authorized.get(m[1])) : resp({}, 404);
  if (url.startsWith("https://api.resend.com")) return resp({});
  if (url === "https://paulus.ia.br/api/atos/eventos") {
    produto.recebidos.push({ corpo: op.body, assinatura: op.headers["Atos-Assinatura"], id: op.headers["Atos-Evento"] });
    return new Response("{}", { status: produto.responde });
  }
  throw new Error("fetch inesperado: " + url);
};

// --- a pessoa: uma Conta Atos com a sessao aberta
const A = "https://atos.dev.br";
async function contaComSessao(email, sub) {
  kv.set("id:conta:" + email, JSON.stringify({ sub, nome: "Dona", sal: "00", hash: "00" }));
  const segredo = "segredo-da-sessao-" + sub;
  kv.set("atos:sessao:" + (await sha256(segredo)), JSON.stringify({ sub, email, auth_time: Math.floor(Date.now() / 1000) }));
  return "__Host-atos=" + segredo;
}
const cookie = await contaComSessao("dona@escritorio.adv.br", "pv-dona");
async function chamar(caminho, { metodo = "GET", corpo, origem = A, semCookie, headers = {} } = {}) {
  const h = { ...headers };
  if (!semCookie) h.cookie = cookie;
  if (metodo !== "GET" && origem) h.origin = origem;
  if (corpo !== undefined) h["content-type"] = "application/json";
  const r = await worker.fetch(new Request(A + caminho, { method: metodo, headers: h, body: corpo === undefined ? undefined : JSON.stringify(corpo) }), env, { waitUntil: () => {} });
  let d = null;
  try { d = await r.clone().json(); } catch { d = null; }
  return { status: r.status, d, r };
}
const PERFIL = { documento: "529.982.247-25", nome: "Dona Moura", endereco: { cep: "68380-000", logradouro: "Av. Paraná", numero: "1965", bairro: "União", cidade: "São Félix do Xingu", uf: "pa", ibge: "1507300" } };

console.log("o catalogo e os dados fiscais");
const o = resolveOffer("pavlvs.escritorio.mes");
checar(o && o.centavos === 129000 && o.valor === "1290.00" && o.periodo === "mes" && o.metadados.plano === "escritorio", "resolveOffer: o preco do catalogo, em centavos e com duas casas", o);
checar(resolveOffer("pavlvs.escritorio.gratis") === null && resolveOffer("outro.x.mes") === null, "preco que nao existe: nada");
checar(cpfValido("52998224725") && !cpfValido("52998224724") && !cpfValido("11111111111"), "CPF conferido pelos digitos");
checar(cnpjValido("11.222.333/0001-81") && !cnpjValido("11.222.333/0001-80"), "CNPJ conferido pelos digitos");
checar(conferirPerfil({ ...PERFIL, documento: "123" }, "x@y.com").erro, "perfil com documento errado: recusado");
let r = await chamar("/api/cobranca/v1/catalogo/pavlvs?volta=https://golpe.example/");
checar(r.status === 200 && r.d.aberto === true && r.d.precos.length === 9 && r.d.volta === "https://paulus.ia.br", "catalogo publico: 9 precos, e a volta que nao e do produto vira o site", { aberto: r.d.aberto, n: r.d.precos.length, volta: r.d.volta });

console.log("a chave publica e a tela");
r = await chamar("/api/mp-config");
checar(r.status === 200 && r.d.publicKey === "PUBLICA-DE-TESTE" && /no-store/.test(r.r.headers.get("cache-control")), "/api/mp-config: a chave, sem cache");
const semChave = { ...env, MP_PUBLIC_KEY: "" };
r = { r: await worker.fetch(new Request(A + "/api/mp-config"), semChave, {}) };
checar(r.r.status === 500, "sem a chave: 500, dito");
r = await chamar("/pavlvs/assinar/");
const csp = r.r.headers.get("content-security-policy") || "";
checar(/script-src 'self' https:\/\/sdk\.mercadopago\.com/.test(csp) && /'sha256-[A-Za-z0-9+/=]+'/.test(csp) && !/script-src[^;]*unsafe-inline/.test(csp) && /frame-ancestors 'none'/.test(csp),
  "a tela do checkout: o SDK do Mercado Pago, o script dela pelo hash, sem unsafe-inline no script", csp);
{
  // O navegador que ja tem a pagina pergunta se mudou (If-None-Match): os assets responderiam 304 sem corpo, e a
  // CSP sairia sem hash, bloqueando o script da copia guardada. O checkout sempre manda a pagina inteira.
  const envCache = { ...env, ASSETS: { fetch: async (req) => req.headers.get("if-none-match")
    ? new Response(null, { status: 304, headers: { etag: '"v1"' } })
    : env.ASSETS.fetch(req) } };
  const w = await worker.fetch(new Request(A + "/pavlvs/assinar/", { headers: { "if-none-match": '"v1"' } }), envCache, {});
  const corpo = await w.text();
  checar(w.status === 200 && corpo.includes("<script") && /'sha256-/.test(w.headers.get("content-security-policy") || "") && !w.headers.get("etag"),
    "com If-None-Match: a pagina inteira (200), com o hash, e sem ETag para o proximo pedido", { status: w.status, etag: w.headers.get("etag") });
}

console.log("sem sessao, sem cobranca");
r = await chamar("/api/cobranca/v1/assinar", { metodo: "POST", corpo: { preco: "pavlvs.escritorio.mes", token: "x".repeat(32) }, semCookie: true });
checar(r.status === 401, "sem a Conta Atos: 401");
r = await chamar("/api/cobranca/v1/assinar", { metodo: "POST", corpo: { preco: "pavlvs.escritorio.mes", token: "x".repeat(32) }, origem: "https://golpe.example" });
checar(r.status === 403, "de outra origem: 403");
r = await chamar("/api/cobranca/v1/assinar", { metodo: "POST", corpo: { preco: "pavlvs.escritorio.mes", token: "x".repeat(32) } });
checar(r.status === 409 && r.d.codigo === "sem_perfil", "sem os dados fiscais: pede antes", r.d);
r = await chamar("/api/cobranca/v1/cliente", { metodo: "POST", corpo: PERFIL });
checar(r.status === 200 && r.d.perfil.tipo === "pf" && r.d.perfil.documento === "52998224725" && r.d.perfil.email === "dona@escritorio.adv.br" && r.d.perfil.endereco.uf === "PA",
  "dados fiscais salvos: CPF so com digitos, o e-mail e o da Conta Atos", r.d);
const fechado = { ...env, PRODUTOS_ABERTOS: "" };
r = { r: await worker.fetch(new Request(A + "/api/cobranca/v1/assinar", { method: "POST", headers: { cookie, origin: A, "content-type": "application/json" },
  body: JSON.stringify({ preco: "pavlvs.escritorio.mes", token: "x".repeat(32) }) }), fechado, {}) };
checar(r.r.status === 409, "produto que ainda nao vende pela Atos: 409");

console.log("a assinatura mensal no cartao");
{
  // O cartao que o Mercado Pago nao aceita para recorrencia: recusada, sem evento (o retrato do produto nao mudou).
  const eventosDa = async () => (await (await CLIENTES.get(await idDoCliente("pv-dona")).fetch("https://cliente/", { method: "POST", body: JSON.stringify({ op: "eventos" }) })).json()).eventos;
  const antes = (await eventosDa()).length;
  mp.recusar = "Unsupported_credit_card_for_recurring_payment";
  r = await chamar("/api/cobranca/v1/assinar", { metodo: "POST", corpo: { preco: "pavlvs.escritorio.mes", token: "tok".repeat(8) } });
  mp.recusar = null;
  checar(r.status === 402 && r.d.codigo === "recusada" && /cobrança mensal automática/.test(r.d.erro), "o cartao que nao aceita recorrencia: 402, dizendo isso", r.d);
  checar((await eventosDa()).length === antes, "a tentativa recusada nao vira evento para o produto", (await eventosDa()).length - antes);
}
mp.pedidos.length = 0;
r = await chamar("/api/cobranca/v1/assinar", { metodo: "POST", corpo: { preco: "pavlvs.escritorio.mes", token: "tok".repeat(8), valor: 1, transaction_amount: 1 } });
const criou = mp.pedidos.find((x) => x.url === "https://api.mercadopago.com/preapproval");
checar(r.status === 200 && r.d.status === "authorized" && /^atos-[0-9a-f]{32}-assinatura-[0-9a-f]{16}$/.test(r.d.id), "assinatura autorizada", r.d);
checar(criou && criou.corpo.auto_recurring.transaction_amount === 1290 && criou.corpo.auto_recurring.frequency === 1 && criou.corpo.auto_recurring.frequency_type === "months"
  && criou.corpo.auto_recurring.currency_id === "BRL" && criou.corpo.status === "authorized" && criou.corpo.payer_email === "dona@escritorio.adv.br"
  && criou.corpo.external_reference === r.d.id && criou.corpo.back_url === "https://atos.dev.br/conta/assinaturas" && criou.headers.Authorization === "Bearer segredo-mp",
  "o Mercado Pago recebe o valor do catalogo (o do navegador e ignorado), a ref e o e-mail da conta", criou && criou.corpo);
const assinatura = r.d.id;
r = await chamar("/api/cobranca/v1/assinar", { metodo: "POST", corpo: { preco: "pavlvs.plus.mes", token: "tok".repeat(8) } });
checar(r.status === 409 && r.d.codigo === "ja_assina", "uma assinatura viva por produto: a segunda e recusada");
r = await chamar("/api/subscriptions/" + assinatura);
checar(r.status === 200 && r.d.status === "authorized" && r.d.plano === "escritorio", "GET /api/subscriptions/:id: conferida no Mercado Pago", r.d);
r = await chamar("/api/subscriptions/" + assinatura + "/pause", { metodo: "POST", corpo: {} });
checar(r.status === 200 && r.d.status === "paused", "pausar", r.d);
r = await chamar("/api/subscriptions/" + assinatura + "/reactivate", { metodo: "POST", corpo: {} });
checar(r.status === 200 && r.d.status === "authorized", "reativar");
r = await chamar("/api/subscriptions/" + assinatura + "/apagar", { metodo: "POST", corpo: {} });
checar(r.status === 404, "acao fora da lista: nao existe");
const outra = await contaComSessao("outro@x.com", "pv-outro");
r = { r: await worker.fetch(new Request(A + "/api/subscriptions/" + assinatura, { headers: { cookie: outra } }), env, {}) };
checar(r.r.status === 404, "a assinatura de outra pessoa: nao aparece");

console.log("a mensalidade cobrada (o aviso do Mercado Pago)");
const cid = await idDoCliente("pv-dona");
mp.authorized.set("ap-1", { id: "ap-1", preapproval_id: "pre-0", payment: { id: 991, status: "approved" } });
async function aviso(tipo, id, { segredo = "segredo-do-aviso", ts = String(Math.floor(Date.now() / 1000)) } = {}) {
  const requestId = "req-" + id;
  const v1 = createHmac("sha256", segredo).update(`id:${id};request-id:${requestId};ts:${ts};`).digest("hex");
  return worker.fetch(new Request(A + `/api/mp/aviso?data.id=${encodeURIComponent(id)}&type=${tipo}`, { method: "POST",
    headers: { "x-signature": `ts=${ts},v1=${v1}`, "x-request-id": requestId, "content-type": "application/json" }, body: JSON.stringify({ type: tipo, data: { id } }) }), env, {});
}
let rr = await aviso("subscription_authorized_payment", "ap-1", { segredo: "outro" });
checar(rr.status === 401, "aviso com a assinatura errada: 401");
rr = await aviso("subscription_authorized_payment", "ap-1", { ts: String(Math.floor(Date.now() / 1000) - 3600) });
checar(rr.status === 401, "aviso velho: 401");
rr = await aviso("subscription_authorized_payment", "ap-1");
let dir = (await chamar("/api/cobranca/v1/minhas")).d.direitos.find((x) => x.produto === "pavlvs");
const umMes = dir && (Date.parse(dir.ate) - Date.now()) / 86400000;
checar(rr.status === 200 && dir && dir.plano === "escritorio" && umMes > 27 && umMes < 32, "mensalidade aprovada: o PAVLVS fica pago por um mes", dir);
await aviso("subscription_authorized_payment", "ap-1");
dir = (await chamar("/api/cobranca/v1/minhas")).d.direitos.find((x) => x.produto === "pavlvs");
checar(Math.abs((Date.parse(dir.ate) - Date.now()) / 86400000 - umMes) < 0.01, "o mesmo aviso de novo: estende uma vez so");

console.log("a recarga e o ano no Pix");
r = await chamar("/api/cobranca/v1/pagar", { metodo: "POST", corpo: { preco: "pavlvs.escritorio.recarga", forma: "pix" } });
checar(r.status === 200 && r.d.status === "aguardando" && r.d.pix.qr_code && r.d.pix.qr_code_base64, "recarga no Pix (tem o PAVLVS em dia): o QR e o copia e cola", r.d);
const pedidoPix = mp.pedidos.filter((x) => x.url === "https://api.mercadopago.com/v1/orders").pop();
checar(pedidoPix.corpo.total_amount === "120.00" && pedidoPix.corpo.transactions.payments[0].amount === "120.00" && pedidoPix.corpo.transactions.payments[0].payment_method.type === "bank_transfer"
  && pedidoPix.headers["X-Idempotency-Key"] === pedidoPix.corpo.external_reference && pedidoPix.corpo.payer.identification.type === "CPF",
  "Orders API: valor com duas casas, Pix como bank_transfer, a idempotencia e a ref, o CPF dos dados fiscais", pedidoPix.corpo);
const recarga = r.d.id;
mp.orders.get("ORD0").status = "processed";
r = await chamar("/api/cobranca/v1/compras/" + recarga);
dir = (await chamar("/api/cobranca/v1/minhas")).d.direitos.find((x) => x.produto === "pavlvs");
checar(r.d.status === "paga" && dir.creditos.length === 1 && dir.creditos[0].preco === "pavlvs.escritorio.recarga", "a tela consulta, o Pix pago vira credito", { status: r.d.status, creditos: dir.creditos });
rr = await aviso("order", "ORD0");
dir = (await chamar("/api/cobranca/v1/minhas")).d.direitos.find((x) => x.produto === "pavlvs");
checar(rr.status === 200 && dir.creditos.length === 1, "o aviso da mesma order depois: nao credita de novo");
const outraConta = await contaComSessao("nova@x.com", "pv-nova");
await worker.fetch(new Request(A + "/api/cobranca/v1/cliente", { method: "POST", headers: { cookie: outraConta, origin: A, "content-type": "application/json" }, body: JSON.stringify({ ...PERFIL, documento: "11.222.333/0001-81", nome: "Escritório Moura Ltda" }) }), env, {});
r = { r: await worker.fetch(new Request(A + "/api/cobranca/v1/pagar", { method: "POST", headers: { cookie: outraConta, origin: A, "content-type": "application/json" }, body: JSON.stringify({ preco: "pavlvs.advogado.recarga", forma: "pix" }) }), env, {}) };
checar(r.r.status === 409, "recarga sem o produto em dia: recusada");
r = { r: await worker.fetch(new Request(A + "/api/cobranca/v1/pagar", { method: "POST", headers: { cookie: outraConta, origin: A, "content-type": "application/json" }, body: JSON.stringify({ preco: "pavlvs.advogado.ano", forma: "pix" }) }), env, {}) };
const anoPix = await r.r.json();
checar(anoPix.status === "aguardando" && mp.pedidos.filter((x) => x.url.endsWith("/v1/orders")).pop().corpo.payer.identification.type === "CNPJ", "o ano no Pix, para um CNPJ", anoPix);
mp.orders.get("ORD" + (mp.orders.size - 1)).status = "processed";
await aviso("order", "ORD" + (mp.orders.size - 1));
r = { r: await worker.fetch(new Request(A + "/api/cobranca/v1/minhas", { headers: { cookie: outraConta } }), env, {}) };
const dirNova = (await r.r.json()).direitos.find((x) => x.produto === "pavlvs");
const meses = dirNova && (Date.parse(dirNova.ate) - Date.now()) / 86400000;
checar(dirNova && dirNova.plano === "advogado" && meses > 360 && meses < 370, "o aviso do Pix pago: o PAVLVS fica pago por um ano", dirNova);

console.log("nunca cobrar em dobro");
r = await chamar("/api/cobranca/v1/pagar", { metodo: "POST", corpo: { preco: "pavlvs.plus.ano", forma: "pix" } });
checar(r.status === 409 && r.d.codigo === "ja_assina", "com a assinatura viva, o ano a parte e recusado (o plano se troca pela assinatura)", r.d);
async function comoNova(caminho, corpo) {
  const x = await worker.fetch(new Request(A + caminho, { method: "POST", headers: { cookie: outraConta, origin: A, "content-type": "application/json" }, body: JSON.stringify(corpo) }), env, {});
  return { status: x.status, d: await x.json() };
}
r = await comoNova("/api/cobranca/v1/assinar", { preco: "pavlvs.advogado.mes", token: "tok".repeat(8) });
checar(r.status === 409 && r.d.codigo === "pago_ate", "com o ano pago, a assinatura no cartao so depois do vencimento", r.d);
r = await comoNova("/api/cobranca/v1/pagar", { preco: "pavlvs.plus.ano", forma: "pix" });
checar(r.status === 409 && r.d.codigo === "troca_de_plano", "com o ano pago num plano, comprar outro plano e recusado", r.d);

console.log("o ano no cartao, recusado e aprovado");
mp.recusar = "cc_rejected_insufficient_amount";
r = await comoNova("/api/cobranca/v1/pagar", { preco: "pavlvs.advogado.ano", forma: "cartao", token: "tok".repeat(8), paymentMethodId: "visa" });
checar(r.status === 402 && /limite/.test(r.d.erro), "cartao recusado: a frase do motivo", r.d);
mp.recusar = null;
r = await comoNova("/api/cobranca/v1/pagar", { preco: "pavlvs.advogado.ano", forma: "cartao", token: "tok".repeat(8), paymentMethodId: "visa" });
const cartao = mp.pedidos.filter((x) => x.url.endsWith("/v1/orders")).pop().corpo.transactions.payments[0].payment_method;
checar(r.status === 200 && r.d.status === "paga" && cartao.installments === 1 && cartao.type === "credit_card" && !("issuer_id" in cartao), "ano no cartao: uma parcela, sem issuer_id", { status: r.d.status, cartao });
const doisAnos = (await (await worker.fetch(new Request(A + "/api/cobranca/v1/minhas", { headers: { cookie: outraConta } }), env, {})).json()).direitos.find((x) => x.produto === "pavlvs");
const dias = (Date.parse(doisAnos.ate) - Date.now()) / 86400000;
checar(dias > 725 && dias < 735, "mais um ano no mesmo plano: soma ao que ja estava pago", { ate: doisAnos.ate });
r = await chamar("/api/cobranca/v1/pagar", { metodo: "POST", corpo: { preco: "pavlvs.plus.mes", forma: "cartao", token: "tok".repeat(8) } });
checar(r.status === 400, "a mensalidade no cartao nao e pagamento unico (e assinatura)");

console.log("cancelar");
r = await chamar("/api/subscriptions/" + assinatura + "/cancel", { metodo: "POST", corpo: {} });
checar(r.status === 200 && r.d.status === "canceled" && mp.preapprovals.get("pre-0").status === "cancelled", "cancelar: canceled na Atos (cancelled no Mercado Pago)", r.d);

console.log("os eventos para o produto");
const objDona = objetos.get(cid);
produto.recebidos.length = 0;
await objDona.alarm();
const recebidos = produto.recebidos.map((x) => ({ ...x, ev: JSON.parse(x.corpo) }));
const assinados = await Promise.all(produto.recebidos.map((x) => verificarEvento("segredo-dos-eventos", x.corpo, x.assinatura)));
checar(recebidos.length > 0 && assinados.every(Boolean) && recebidos.every((x) => x.id === x.ev.id), "o alarme entrega a fila ao PAVLVS, cada evento assinado (HMAC) e com o id no cabecalho", recebidos.length);
const direitosEv = recebidos.filter((x) => x.ev.tipo === "direito.atualizado").map((x) => x.ev);
const versoes = direitosEv.map((e) => e.dados.versao);
checar(direitosEv.length >= 3 && versoes.every((v, i) => i === 0 || v > versoes[i - 1]), "direito.atualizado com a versao sempre crescendo", versoes);
const ultimo = direitosEv[direitosEv.length - 1];
checar(ultimo.conta.sub === "pv-dona" && ultimo.conta.email === "dona@escritorio.adv.br" && ultimo.produto === "pavlvs" && ultimo.dados.assinatura.status === "canceled"
  && ultimo.dados.plano === "escritorio" && ultimo.dados.metadados.tokens_por_ciclo === 60000000 && ultimo.dados.ate && ["mes", "ano"].includes(ultimo.dados.periodo),
  "o ultimo retrato: de quem e, o plano com os metadados, ate quando, o periodo que pagou, a assinatura cancelada", ultimo);
const credito = recebidos.find((x) => x.ev.tipo === "credito.adicionado");
checar(credito && credito.ev.dados.origem === "order:ORD0" && credito.ev.dados.metadados.tokens === 10000000, "credito.adicionado: a recarga com a origem e os tokens", credito && credito.ev.dados);
checar(!(await verificarEvento("segredo-dos-eventos", produto.recebidos[0].corpo.replace("pavlvs", "outro"), produto.recebidos[0].assinatura))
  && !(await verificarEvento("outro-segredo", produto.recebidos[0].corpo, produto.recebidos[0].assinatura)),
  "verificarEvento recusa corpo mexido e outro segredo");
produto.recebidos.length = 0;
await objDona.alarm();
checar(produto.recebidos.length === 0, "o que ja foi entregue nao vai de novo");

console.log("o produto fora do ar: a Atos tenta de novo");
produto.responde = 503;
await chamar("/api/subscriptions/" + assinatura + "/reactivate", { metodo: "POST", corpo: {} });
await objDona.alarm();
let fila = (await chamar("/api/cobranca/v1/minhas")).d;
let evs = (await (await CLIENTES.get(cid).fetch("https://cliente/", { method: "POST", body: JSON.stringify({ op: "eventos" }) })).json()).eventos;
let pendente = evs.find((e) => e.estado === "pendente");
checar(pendente && pendente.tentativas === 1 && pendente.ultimo.status === 503 && pendente.proxima > Date.now() + 50000 && objDona.ctx.storage.alarme === pendente.proxima,
  "503: fica pendente, com a proxima tentativa em 1 minuto e o alarme marcado", pendente);
const agoraReal = Date.now;
for (let i = 0; i < 5; i++) {
  Date.now = () => agoraReal() + 2 * 86400000 * (i + 1);
  await objDona.alarm();
}
Date.now = agoraReal;
evs = (await (await CLIENTES.get(cid).fetch("https://cliente/", { method: "POST", body: JSON.stringify({ op: "eventos" }) })).json()).eventos;
const falhou = evs.find((e) => e.evento.id === pendente.evento.id);
checar(falhou.estado === "falhou" && falhou.tentativas === 6, "esgotadas as 5 reentregas: falhou (o painel mostra)", { estado: falhou.estado, tentativas: falhou.tentativas });
produto.responde = 200;

console.log("a reserva: o produto pergunta os direitos");
r = await chamar("/api/cobranca/v1/direitos?produto=pavlvs&sub=pv-dona", { semCookie: true, headers: { authorization: "Bearer segredo-dos-eventos" } });
checar(r.status === 200 && r.d.sub === "pv-dona" && r.d.plano === "escritorio" && r.d.versao >= versoes[versoes.length - 1] && r.d.assinatura.status === "authorized",
  "com o segredo do produto: o retrato de agora", r.d);
r = await chamar("/api/cobranca/v1/direitos?produto=pavlvs&sub=pv-dona", { semCookie: true, headers: { authorization: "Bearer outro" } });
checar(r.status === 401, "sem o segredo certo: 401");
r = await chamar("/api/cobranca/v1/direitos?produto=pavlvs&sub=pv-dona", { headers: { authorization: "" } });
checar(r.status === 401, "a sessao da pessoa nao abre os direitos de produto: 401");

console.log("o mes da Atos e o do produto");
{
  const em = (iso) => new Date(maisUmMes(Date.parse(iso))).toISOString().slice(0, 10);
  checar(em("2027-01-31T12:00:00Z") === "2027-02-28" && em("2028-01-31T12:00:00Z") === "2028-02-29" && em("2027-03-15T12:00:00Z") === "2027-04-15",
    "31/01 mais um mes e 28/02 (29 no bissexto); o dia que existe fica");
}

console.log("o Worker de teste (wrangler --env teste)");
{
  const T = "https://atos-teste.conta1.workers.dev";
  let w = await worker.fetch(new Request(T + "/pavlvs/assinar/"), env, { waitUntil: () => {} });
  checar(w.status === 301 && w.headers.get("location") === "https://atos.dev.br/pavlvs/assinar/", "em producao, o endereco de teste volta a atos.dev.br", w.status);
  const envTeste = { ...env, AMBIENTE: "teste" };
  w = await worker.fetch(new Request(T + "/api/cobranca/v1/catalogo/pavlvs"), envTeste, { waitUntil: () => {} });
  checar(w.status === 200, "no Worker de teste, o proprio endereco atende", w.status);
  w = await worker.fetch(new Request("https://atos-teste.evil.example/"), envTeste, { waitUntil: () => {} });
  checar(w.status === 301, "e so ele: outro endereco volta a atos.dev.br", w.status);
  // Os eventos: no teste, o receptor interno confere a assinatura; nada sai para o produto de verdade.
  const { entregar } = await import("./eventos.js");
  let saiu = 0;
  const ev = { id: "ev-t", tipo: "direito.atualizado", produto: "pavlvs", conta: { sub: "x", email: "x@y" }, dados: {} };
  const rt = await entregar(envTeste, ev, { buscar: async () => { saiu++; return new Response("{}"); } });
  checar(rt.ok && rt.status === 200 && saiu === 0, "no teste, o evento vai ao receptor interno, assinado e conferido, e nao ao paulus.ia.br", { rt, saiu });
  r = await chamar("/api/teste/eventos");
  checar(r.status === 404, "em producao, /api/teste/eventos nao existe", r.status);
}

console.log(falhas ? "\n" + falhas + " falha(s)" : "\ntudo certo");
process.exit(falhas ? 1 : 0);
