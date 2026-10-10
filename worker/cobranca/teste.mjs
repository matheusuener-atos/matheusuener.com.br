// Testes da Atos Cobranca (worker/cobranca/): o checkout, as assinaturas, as compras, os direitos e o
// aviso do Mercado Pago - com o Mercado Pago simulado (nada vai a internet) e o objeto do cliente de verdade.
//   node worker/cobranca/teste.mjs
import { createHmac } from "node:crypto";
import worker from "../index.js";
import { ClienteCobranca, idDoCliente } from "./cliente.js";
import { conferirPerfil, cnpjValido, cpfValido } from "./api.js";
import { resolveOffer } from "./catalogo.js";
import { sha256 } from "../comum.js";

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
    async get(k) { return m.has(k) ? structuredClone(m.get(k)) : undefined; },
    async put(k, v) { m.set(k, structuredClone(v)); },
    async list({ prefix = "" } = {}) { return new Map([...m].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v)])); },
  };
}
const objetos = new Map();
const CLIENTES = {
  idFromName: (n) => n,
  get(id) {
    if (!objetos.has(id)) objetos.set(id, new ClienteCobranca({ storage: storage() }, {}));
    return { fetch: (url, op) => objetos.get(id).fetch(new Request(url, op)) };
  },
};
const env = {
  CONTAS, CLIENTES, APP_URL: "https://atos.dev.br", MP_PUBLIC_KEY: "PUBLICA-DE-TESTE", MP_ACCESS_TOKEN: "segredo-mp",
  MP_WEBHOOK_SECRET: "segredo-do-aviso", PRODUTOS_ABERTOS: "pavlvs",
  ASSETS: { fetch: async (req) => new Response(String(new URL(req.url).pathname).includes("assinar")
    ? '<html><script src="https://sdk.mercadopago.com/js/v2"></script><script>var x = 1;</script></html>' : "<p>pagina</p>",
    { headers: { "content-type": "text/html" } }) },
};

const mp = { pedidos: [], orders: new Map(), preapprovals: new Map(), authorized: new Map(), recusar: null };
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

console.log("o ano no cartao, recusado e aprovado");
mp.recusar = "cc_rejected_insufficient_amount";
r = await chamar("/api/cobranca/v1/pagar", { metodo: "POST", corpo: { preco: "pavlvs.plus.ano", forma: "cartao", token: "tok".repeat(8), paymentMethodId: "visa" } });
checar(r.status === 402 && /limite/.test(r.d.erro), "cartao recusado: a frase do motivo", r.d);
mp.recusar = null;
r = await chamar("/api/cobranca/v1/pagar", { metodo: "POST", corpo: { preco: "pavlvs.plus.ano", forma: "cartao", token: "tok".repeat(8), paymentMethodId: "visa" } });
const cartao = mp.pedidos.filter((x) => x.url.endsWith("/v1/orders")).pop().corpo.transactions.payments[0].payment_method;
checar(r.status === 200 && r.d.status === "paga" && cartao.installments === 1 && cartao.type === "credit_card" && !("issuer_id" in cartao), "ano no cartao: uma parcela, sem issuer_id", { status: r.d.status, cartao });
r = await chamar("/api/cobranca/v1/pagar", { metodo: "POST", corpo: { preco: "pavlvs.plus.mes", forma: "cartao", token: "tok".repeat(8) } });
checar(r.status === 400, "a mensalidade no cartao nao e pagamento unico (e assinatura)");

console.log("cancelar");
r = await chamar("/api/subscriptions/" + assinatura + "/cancel", { metodo: "POST", corpo: {} });
checar(r.status === 200 && r.d.status === "canceled" && mp.preapprovals.get("pre-0").status === "cancelled", "cancelar: canceled na Atos (cancelled no Mercado Pago)", r.d);

console.log(falhas ? "\n" + falhas + " falha(s)" : "\ntudo certo");
process.exit(falhas ? 1 : 0);
