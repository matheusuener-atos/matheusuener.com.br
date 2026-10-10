// Teste do cadastro da conta para o assistente de configuracao do PAULUS
// (GET /api/ia/cadastro, worker/ia.js), sem rede:
//   node worker/teste-cadastro.mjs
// A conta e a da nuvem, pela conta Google: cada instalacao le so o cadastro
// da conta dona do segredo dela. O Durable Object roda aqui, com a mesma
// classe, sobre um Map; o Google do login e de mentira.
import worker from "./index.js";
import { ContaIA, atenderIA } from "./ia.js";

let falhas = 0;
const checar = (ok, descricao, detalhe) => {
  console.log((ok ? "  ok   " : "  FALHA ") + descricao + (ok || detalhe === undefined ? "" : " -> " + JSON.stringify(detalhe)));
  if (!ok) falhas++;
};

// ------------------------------------------------ o Durable Object aqui
const relogio = Date.parse("2026-10-07T12:00:00Z");
const objetos = new Map();
function objeto(nome) {
  if (!objetos.has(nome)) {
    const dados = new Map();
    const o = new ContaIA({ storage: { get: async (k) => structuredClone(dados.get(k)), put: async (k, v) => { dados.set(k, structuredClone(v)); } } }, {});
    o.agora = () => relogio;
    objetos.set(nome, { o, dados });
  }
  return objetos.get(nome);
}
const CONTAS_IA = { idFromName: (n) => n, get: (n) => ({ fetch: (url, init) => objeto(n).o.fetch(new Request(url, init)) }) };
const guardados = new Map();
const env = {
  IA_ATIVA: "1",
  CONTAS_IA,
  ASSETS: { fetch: async () => new Response("site", { status: 200 }) },
  APOIOS: {
    get: async (k) => guardados.get(k) || null,
    getWithMetadata: async (k) => ({ value: guardados.get(k) || null, metadata: null }),
    put: async (k, v) => { guardados.set(k, v); },
    list: async ({ prefix }) => ({ list_complete: true, keys: [...guardados.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }),
  },
};
globalThis.fetch = async () => new Response("{}", { status: 404 });
const donos = {
  "token-helena": { sub: "111", email: "helena@moura.adv.br" },
  "token-caio": { sub: "222", email: "caio@silva.adv.br" },
};
const deps = { donoDoToken: async (e, t) => donos[t] || null };
const ctx = { waitUntil: () => null };

async function ia(metodo, caminho, corpo, segredo) {
  const headers = { "content-type": "application/json" };
  if (segredo) headers.authorization = "Bearer " + segredo;
  const req = new Request("https://paulus.ia.br" + caminho, { method: metodo, headers, body: corpo ? JSON.stringify(corpo) : undefined });
  const r = await atenderIA(req, env, new URL(req.url), ctx, deps);
  let d = null;
  try { d = await r.json(); } catch { d = null; }
  return { status: r.status, d };
}
const CADASTRO = { nome_escritorio: "Moura Advogados", documento: "529.982.247-25", telefone: "(91) 98888-7777", oab: "OAB/PA 12.345", aceite: true,
  endereco: { cep: "66.010-000", logradouro: "Av. Presidente Vargas", numero: "100", complemento: "sala 2", bairro: "Campina", cidade: "Belém", uf: "PA", cmun: "1501402" } };

const helena = (await ia("POST", "/api/ia/ativar", { id_token: "token-helena", instalacao_id: "inst-helena-0001" })).d.segredo;
const caio = (await ia("POST", "/api/ia/ativar", { id_token: "token-caio", instalacao_id: "inst-caio-00001" })).d.segredo;
checar(/^pia_/.test(helena) && /^pia_/.test(caio) && helena !== caio, "duas contas da nuvem, cada uma com o segredo da sua instalação");

console.log("\nsem o segredo");
{
  checar((await ia("GET", "/api/ia/cadastro")).status === 401, "sem o segredo: 401");
  checar((await ia("GET", "/api/ia/cadastro", null, "pia_" + "0".repeat(24) + "_" + "1".repeat(64))).status === 401, "segredo inventado: 401");
  const w = await worker.fetch(new Request("https://paulus.ia.br/api/ia/cadastro"), env, ctx);
  checar(w.status === 401, "pelo Worker inteiro a rota é da nuvem (ia.js), e sem o segredo dá 401");
}

console.log("\no cadastro da própria conta");
{
  const antes = await ia("GET", "/api/ia/cadastro", null, helena);
  checar(antes.status === 200 && antes.d.ok && antes.d.cadastro === null && antes.d.email === "helena@moura.adv.br",
    "antes do cadastro no site: nenhum, com o e-mail da conta", antes.d);
  const s = await ia("POST", "/api/ia/site/cadastro", { ...CADASTRO, id_token: "token-helena" });
  checar(s.status === 200 && s.d.cadastro, "o cadastro feito no site (pela conta Google)", s.d);
  const r = await ia("GET", "/api/ia/cadastro", null, helena);
  const c = r.d.cadastro || {};
  checar(r.status === 200 && c.nome_escritorio === "Moura Advogados" && c.documento === "52998224725" && c.oab === "PA 12345"
    && c.telefone === "91988887777" && c.endereco && c.endereco.cidade === "Belém" && c.endereco.complemento === "sala 2",
    "a instalação lê o escritório, o documento, a OAB, o telefone e o endereço", c);
  checar(!("termos" in c) && !("quando" in c) && !("email_cobranca" in c), "só os campos de \"Seus dados\": sem os termos aceitos nem a data", Object.keys(c));
}

console.log("\nde outra conta, nada");
{
  const r = await ia("GET", "/api/ia/cadastro", null, caio);
  checar(r.status === 200 && r.d.cadastro === null && r.d.email === "caio@silva.adv.br", "o segredo de outra conta lê o cadastro dela (vazio), e não o da Helena", r.d);
  checar((await ia("POST", "/api/ia/cadastro", {}, helena)).status === 404, "só GET");
}

console.log(falhas ? "\n  cadastro: " + falhas + " falha(s)" : "\n  cadastro: todos os testes passaram");
process.exit(falhas ? 1 : 0);
