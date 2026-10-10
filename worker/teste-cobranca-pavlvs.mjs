// A cobranca do PAVLVS dentro do Worker da Atos (worker/cobranca-pavlvs.js): so as rotas de
// cobranca chegam ao motor de worker/pavlvs/, com o KV CONTAS no lugar do APOIOS de la.
//   node worker/teste-cobranca-pavlvs.mjs
// O motor em si tem os testes dele em worker/pavlvs/teste-*.mjs.
import worker from "./index.js";

let falhas = 0;
function checar(cond, texto, extra) {
  console.log((cond ? "  ok   " : "  FALHA ") + texto + (cond || extra === undefined ? "" : " -> " + JSON.stringify(extra)));
  if (!cond) falhas++;
}

const guardados = new Map();
const CONTAS = {
  async get(k, tipo) { const v = guardados.get(k); return v === undefined ? null : tipo === "json" ? JSON.parse(v) : v; },
  async put(k, v) { guardados.set(k, v); },
  async delete(k) { guardados.delete(k); },
  async list({ prefix = "" } = {}) { return { keys: [...guardados.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; },
};
const pedidosAoDO = [];
const CONTAS_IA = {
  idFromName: (n) => n,
  get: (id) => ({ fetch: async (url, op) => { pedidosAoDO.push({ id, corpo: JSON.parse(op.body) }); return new Response(JSON.stringify({ ok: false, erro: "conta não existe" }), { status: 404 }); } }),
};
const env = {
  CONTAS, CONTAS_IA, IA_ATIVA: "1", MP_PUBLIC_KEY: "APP_USR-teste",
  ASSETS: { fetch: async () => new Response("<p>pagina</p>", { headers: { "content-type": "text/html" } }) },
};
const A = "https://atos.dev.br";
async function chamar(caminho, op = {}) {
  const r = await worker.fetch(new Request(A + caminho, op), env, { waitUntil: () => {} });
  let d = null;
  try { d = await r.clone().json(); } catch { d = null; }
  return { status: r.status, d };
}

console.log("as rotas de cobranca vao ao motor do PAVLVS");
let r = await chamar("/api/ia/planos");
checar(r.status === 200 && Array.isArray(r.d.planos) && r.d.planos.length >= 3, "/api/ia/planos: os planos do PAVLVS", r.d);
r = await chamar("/api/ia/mp-config");
checar(r.status === 200 && r.d.publicKey === "APP_USR-teste", "/api/ia/mp-config: a chave publica do Mercado Pago", r.d);
r = await chamar("/api/mp/aviso?data.id=1&type=payment", { method: "POST", body: "{}" });
checar(r.status === 401, "/api/mp/aviso sem a assinatura do Mercado Pago: 401", r);
r = await chamar("/api/conta");
checar(r.status === 401, "/api/conta sem a sessao da Minha conta: 401", r);
r = await chamar("/api/conta/entrar", { method: "POST", headers: { origin: A, "content-type": "application/json" }, body: JSON.stringify({ id_token: "x.y.z" }) });
checar(r.status === 401, "/api/conta/entrar com um token que nao vale: 401", r);
guardados.set("conta:link:" + "0".repeat(64), "{}");
r = await chamar("/api/conta/entrar", { method: "POST", headers: { origin: "https://golpe.example", "content-type": "application/json" }, body: "{}" });
checar(r.status === 403, "/api/conta de outra origem: 403", r);

console.log("o resto do PAVLVS nao entra aqui");
for (const c of ["/api/ia/v1/chat/completions", "/api/ia/ativar", "/api/ia/modelos", "/api/tunel/conectar", "/api/admin/visao", "/api/id/entrar"]) {
  r = await chamar(c, { method: "POST", body: "{}" });
  checar(r.status === 404 && pedidosAoDO.length === 0, c + ": 404 na Atos", r);
}

console.log(falhas ? "\n" + falhas + " falha(s)" : "\ntudo certo");
process.exit(falhas ? 1 : 0);
