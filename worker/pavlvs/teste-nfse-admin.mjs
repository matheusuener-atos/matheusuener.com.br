// A aba Notas fiscais do painel com o emissor da nuvem ligado, sem rede:
//   node worker/teste-nfse-admin.mjs
//
// Passa pelo painel inteiro (worker/admin.js: Cloudflare Access de mentira +
// sessão do GitHub) até o Durable Object EmissorNFSe (SQLite de verdade, pelo
// node:sqlite) e a Sefin simulada atrás do SEFIN_MTLS. A API da Cloudflare é
// de mentira (nenhuma chamada sai daqui): o teste confere o corpo de cada
// chamada do cadastro do mTLS.
//   1. as portas: Access, GitHub e o papel (suporte só lê)
//   2. o certificado aberto no navegador: sem token (guarda e diz que falta),
//      com o token (POST mtls_certificates, PUT do auxiliar, DELETE do anterior),
//      e a publicação do auxiliar que falha
//   3. testar comunicação: certificado, Sefin e convênio, com o tempo
//   4. clientes, emitir pelo painel (com erro de conferência), PDF na hora,
//      depois, enviar ao cliente, XML
//   5. automático no pagamento (tomador completo e incompleto) e o Cron do PDF
//   6. cancelar, substituir e a produção
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { atenderAdmin } from "./admin.js";
import { avisoDaIA, ContaIA, devolverPagamento, numeros } from "./ia.js";
import { EmissorNFSe, K_DEPOIS } from "./nfse/emissor.js";
import { depoisPendentes } from "./nfse/api.js";
import { SefinSimulada } from "./nfse/sefin-simulada.js";
import { lerPfx } from "./nfse/pfx.js";
import { b64 } from "./nfse/assinatura.js";
import { decifrar } from "./nfse/cofre.js";
import { hojeBrasilia } from "./nfse/dps.js";
import { CODIGO_AUXILIAR } from "./nfse/mtls.js";

const AQUI = dirname(fileURLToPath(import.meta.url));
let falhas = 0;
const checar = (ok, descricao, detalhe) => {
  console.log((ok ? "  ok   " : "  FALHA ") + descricao + (ok || detalhe === undefined ? "" : " -> " + JSON.stringify(detalhe).slice(0, 1500)));
  if (!ok) falhas++;
};

// ------------------------------------------------------------ KV e contas
const kv = new Map();
const APOIOS = {
  get: async (k) => (kv.has(k) ? kv.get(k) : null),
  put: async (k, v) => { kv.set(k, v); },
  delete: async (k) => { kv.delete(k); },
  list: async ({ prefix }) => ({ list_complete: true, keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }),
};
const kvJson = (k) => (kv.has(k) ? JSON.parse(kv.get(k)) : null);
const objetos = new Map();
const CONTAS_IA = {
  idFromName: (n) => n,
  get: (n) => ({
    fetch: (url, init) => {
      if (!objetos.has(n)) {
        const dados = new Map();
        objetos.set(n, new ContaIA({ storage: { get: async (k) => structuredClone(dados.get(k)), put: async (k, v) => { dados.set(k, structuredClone(v)); } } }, { APOIOS }));
      }
      return objetos.get(n).fetch(new Request(url, init));
    },
  }),
};

// ------------------------------------------------------------ o DO do emissor
function storageSqlite() {
  const db = new DatabaseSync(":memory:");
  let alarme = null;
  return {
    db,
    sql: { exec(q, ...b) { const linhas = db.prepare(q).all(...b); return { toArray: () => linhas }; } },
    transactionSync(fn) {
      db.exec("BEGIN");
      try {
        const r = fn();
        db.exec("COMMIT");
        return r;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    getAlarm: async () => alarme,
    setAlarm: async (t) => { alarme = Number(t); },
    deleteAlarm: async () => { alarme = null; },
  };
}
const sim = new SefinSimulada("sucesso");
const storage = storageSqlite();
let instancia = null;
const EMISSOR_NFSE = {
  idFromName: (n) => n,
  get: (n) => ({ fetch: (url, init) => {
    if (n !== "pavlvs") throw new Error("instância errada");
    return instancia.fetch(new Request(url, init));
  } }),
};

// ------------------------------------------------------------ Cloudflare, Resend (de mentira)
const CF_CONTA = "54164f67b5d5eb33c0a1d325dfebb449";
const TOKEN_CF = "cfat_" + "x".repeat(40);
const cf = [];
let cfModo = "ok";
let cfSeq = 0;
const emails = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u === "https://api.resend.com/emails") {
    emails.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ id: "e" + emails.length }), { status: 200 });
  }
  if (u.startsWith("https://api.cloudflare.com/client/v4/")) {
    const caminho = u.slice("https://api.cloudflare.com/client/v4".length);
    const chamada = { metodo: init.method, caminho, auth: (init.headers || {}).Authorization };
    if (init.body instanceof FormData) {
      const fd = await new Request("https://x/", { method: "PUT", body: init.body }).formData();
      chamada.metadata = JSON.parse(await fd.get("metadata").text());
      chamada.script = await fd.get("index.js").text();
      chamada.tipoScript = fd.get("index.js").type;
    } else if (init.body) chamada.corpo = JSON.parse(init.body);
    cf.push(chamada);
    if (init.method === "POST" && caminho.endsWith("/mtls_certificates")) {
      return Response.json({ success: true, errors: [], result: { id: "mtls-" + ++cfSeq } });
    }
    if (init.method === "PUT" && caminho.includes("/workers/scripts/")) {
      if (cfModo === "put-falha") return Response.json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, { status: 403 });
      return Response.json({ success: true, errors: [], result: { id: "paulus-nfse-mtls" } });
    }
    if (init.method === "DELETE") return Response.json({ success: true, errors: [], result: {} });
    return Response.json({ success: false, errors: [{ message: "rota de mentira desconhecida" }] }, { status: 404 });
  }
  return new Response("{}", { status: 404 });
};
async function chamarMP() {
  return { ok: true, status: 200, dados: {} };
}

// ------------------------------------------------------------ Access e GitHub de mentira
const TIME = "paulus.cloudflareaccess.com";
const AUD = "aud-do-painel";
const par = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const jwkPublica = { ...(await crypto.subtle.exportKey("jwk", par.publicKey)), kid: "k1" };
const b64url = (bytes) => Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function jwt(email) {
  const cab = b64url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", kid: "k1" })));
  const corpo = b64url(new TextEncoder().encode(JSON.stringify({ email, aud: [AUD], iss: "https://" + TIME, exp: Date.now() / 1000 + 3600 })));
  const ass = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", par.privateKey, new TextEncoder().encode(cab + "." + corpo));
  return cab + "." + corpo + "." + b64url(new Uint8Array(ass));
}
async function github(metodo, url, token, corpo) {
  if (url.includes("/login/oauth/access_token")) return { ok: true, status: 200, dados: { access_token: "gho_" + corpo.code } };
  if (url.endsWith("/user")) return { ok: true, status: 200, dados: { login: "gh-" + token.slice(4) } };
  if (url.includes("/collaborators/")) return { ok: true, status: 200, dados: { permission: "write" } };
  return { ok: false, status: 404, dados: null };
}

const mestra = b64(crypto.getRandomValues(new Uint8Array(32)));
const env = {
  IA_ATIVA: "1", CONTAS_IA, APOIOS, ACCESS_TEAM: TIME, ACCESS_AUD: AUD, GITHUB_CLIENT_ID: "cid", GITHUB_CLIENT_SECRET: "csec",
  RESEND_API_KEY: "re_x", MP_ACCESS_TOKEN: "mp", EMISSOR_NFSE, NFSE_CHAVE_MESTRA: mestra, SEFIN_MTLS: { fetch: sim.fetch }, CF_ACCOUNT_ID: CF_CONTA,
  ADMIN_EQUIPE: JSON.stringify([
    { email: "dono@paulus.ia.br", nome: "Matheus", papel: "dono" },
    { email: "fin@paulus.ia.br", nome: "Fátima", papel: "financeiro" },
    { email: "sup@paulus.ia.br", nome: "Sérgio", papel: "suporte" },
  ]),
  ASSETS: { fetch: async () => new Response(JSON.stringify({ versao: "0.9.22" }), { status: 200 }) },
};
instancia = new EmissorNFSe({ storage }, env);
const deps = { github, chamarMP, chavesDoAccess: async () => [jwkPublica] };
const esperando = [];
const ctx = { waitUntil: (p) => esperando.push(p) };

async function admin(metodo, caminho, { email = "dono@paulus.ia.br", corpo, cookie, semAccess = false } = {}) {
  const headers = { "content-type": "application/json" };
  if (!semAccess) headers["cf-access-jwt-assertion"] = await jwt(email);
  if (cookie) headers.cookie = "pv_admin=" + cookie;
  const req = new Request("https://paulus.ia.br" + caminho, { method: metodo, headers, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
  return atenderAdmin(req, env, new URL(req.url), ctx, deps);
}
async function entrar(email) {
  let r = await admin("GET", "/api/admin/github/entrar", { email });
  const state = new URL(r.headers.get("location")).searchParams.get("state");
  r = await admin("GET", "/api/admin/github/retorno?code=" + email.split("@")[0] + "&state=" + state, { email });
  return (r.headers.get("set-cookie") || "").match(/pv_admin=([0-9a-f]+)/)[1];
}
const SESSOES = {};
for (const e of ["dono@paulus.ia.br", "fin@paulus.ia.br", "sup@paulus.ia.br"]) SESSOES[e] = await entrar(e);
/** Pedido ao emissor pelo painel: {status, dados, r}. */
async function nf(metodo, caminho, corpo, email = "dono@paulus.ia.br") {
  const r = await admin(metodo, "/api/admin/nfse/emissor/" + caminho, { email, corpo, cookie: SESSOES[email] });
  const tipo = r.headers.get("content-type") || "";
  return { status: r.status, r, dados: tipo.includes("json") ? await r.json() : tipo.includes("pdf") ? new Uint8Array(await r.arrayBuffer()) : await r.text() };
}
async function painel(email = "dono@paulus.ia.br") {
  const r = await admin("GET", "/api/admin/nfse", { email, cookie: SESSOES[email] });
  return r.json();
}

// As contas: Ana com o cadastro completo (endereço), Bruno sem endereço.
async function doDe(id, acao, dados = {}) {
  const r = await CONTAS_IA.get(id).fetch("https://conta-ia/" + acao, { method: "POST", body: JSON.stringify({ acao, ...dados, numeros: numeros({}) }) });
  return r.json();
}
const ANA = "a".repeat(24);
const BRUNO = "b".repeat(24);
for (const [id, nome] of [[ANA, "ana"], [BRUNO, "bruno"]]) {
  await doDe(id, "ativar", { id, dono: { sub: nome, email: nome + "@escritorio.com.br" }, nome: "Escritório " + nome, instalacao: "inst-" + nome + "-123", hash: "h-" + nome });
}
await doDe(ANA, "cadastro", { cadastro: { nome_escritorio: "Ana Advocacia", documento: "52998224725", telefone: "91988887777", oab: "PA 12345", termos: "x",
  endereco: { cep: "66010000", logradouro: "Rua dos Mundurucus", numero: "1500", complemento: "Sala 3", bairro: "Batista Campos", cidade: "Belém", uf: "PA", cmun: "1501402" } } });
const HOJE = hojeBrasilia();
kv.set("admin:nfse:PAY1", JSON.stringify({ id: "PAY1", conta: ANA, tipo: "mensalidade", valor: 300, quando: HOJE + "T10:00:00Z", nota: "pendente" }));

const PRESTADOR = {
  documento: "11222333000181", razao_social: "PAVLVS Tecnologia", inscricao_municipal: "7788990", municipio: "1501402",
  opcao_simples: "1", regime_especial: "0",
  servico: { ctribnac: "010301", nbs: "115062100", descricao: "Assinatura do PAULUS", aliquota_iss_bp: 200 },
  retencoes: Object.fromEntries(["iss", "irrf", "pis", "cofins", "csll", "cp"].map((k) => [k, { quando: "nunca" }])),
  ibscbs: { enviar: true, cst: "000", cclasstrib: "000001", cindop: "100301", indfinal: "1" },
  total_tributos: { modo: "percentual", federal_bp: 1345, municipal_bp: 200 },
};
const senha = "segredo-de-teste";
const pfx = lerPfx(readFileSync(join(AQUI, "nfse", "fixtures", "a1-cn.pfx")), senha);
// O que o navegador manda: o .pfx aberto por site/assets/nfse-pfx.js (com o
// forge de site/assets/vendor), rodado aqui num contexto de "janela".
const janela = {};
vm.runInNewContext(readFileSync(join(AQUI, "nfse", "fixtures", "navegador", "forge.min.js"), "utf8"), { self: janela, globalThis: janela, window: janela });
vm.runInNewContext(readFileSync(join(AQUI, "nfse", "fixtures", "navegador", "nfse-pfx.js"), "utf8"), { window: janela, Uint8Array, String, Error });
const doNavegador = janela.PavlvsPfx.ler(readFileSync(join(AQUI, "nfse", "fixtures", "a1-cn.pfx")), senha);

// ------------------------------------------------------------ 0. o .pfx no navegador
console.log("0. o .pfx aberto no navegador");
checar(doNavegador.certPem === pfx.certPem && doNavegador.chavePkcs8 === b64(pfx.chavePkcs8) && doNavegador.titular === pfx.titular && doNavegador.documento === "11222333000181"
  && doNavegador.validoAte === pfx.validoAte && JSON.stringify(doNavegador.cadeiaPem) === JSON.stringify(pfx.cadeiaPem),
  "site/assets/nfse-pfx.js dá o mesmo que worker/nfse/pfx.js (certificado, cadeia, chave, titular, CNPJ, validade)", { ...doNavegador, chavePkcs8: "..." });
let senhaErrada = "";
try {
  janela.PavlvsPfx.ler(readFileSync(join(AQUI, "nfse", "fixtures", "a1-cn.pfx")), "errada");
} catch (e) {
  senhaErrada = e.message;
}
checar(/senha do certificado incorreta/.test(senhaErrada), "senha errada: a frase para a tela", senhaErrada);
const ecpf = janela.PavlvsPfx.ler(readFileSync(join(AQUI, "nfse", "fixtures", "a1-ecpf.pfx")), senha);
checar(ecpf.documento === lerPfx(readFileSync(join(AQUI, "nfse", "fixtures", "a1-ecpf.pfx")), senha).documento && ecpf.documento.length === 11, "e-CPF: o CPF do otherName", ecpf.documento);

// ------------------------------------------------------------ 1. portas
console.log("1. as portas do painel");
let r = await admin("GET", "/api/admin/nfse/emissor/situacao", { semAccess: true });
checar(r.status === 401, "sem o Cloudflare Access: 401");
r = await admin("GET", "/api/admin/nfse/emissor/situacao");
checar(r.status === 401 && (await r.json()).passo === "sessao", "com o Access e sem a sessão do painel: 401 passo sessao");
r = await admin("GET", "/api/admin/nfse/emissor/situacao", { email: "intruso@gmail.com", cookie: SESSOES["dono@paulus.ia.br"] });
checar(r.status === 403, "e-mail fora da equipe: 403");
r = await admin("GET", "/api/admin/nfse/emissor/situacao", { email: "sup@paulus.ia.br", cookie: SESSOES["dono@paulus.ia.br"] });
checar(r.status === 401, "o cookie do dono não vale com o Access do suporte");
let x = await nf("GET", "situacao", undefined, "sup@paulus.ia.br");
checar(x.status === 200 && x.dados.pode_emitir === false && x.dados.cloudflare && x.dados.cloudflare.token === false && x.dados.opcoes.motivos_cancelamento["1"],
  "o suporte lê a situação (com as opções da tela e a Cloudflare sem token)", x.dados);
for (const [rota, corpo] of [["notas", { valor: 1 }], ["certificado", doNavegador], ["prestador", { prestador: PRESTADOR }], ["cloudflare", { token: TOKEN_CF }], ["producao/liberar", {}]]) {
  x = await nf("POST", rota, corpo, "sup@paulus.ia.br");
  checar(x.status === 403 && /só vê as notas fiscais/.test(x.dados.erro), "suporte: POST " + rota + " é recusado (403)", x.dados);
}
// a busca de município pelo nome (Emitir, Clientes e Parâmetros)
x = await nf("GET", "municipios?q=goi", undefined, "sup@paulus.ia.br");
checar(x.status === 200 && x.dados.municipios.length === 12 && x.dados.municipios.some((m) => m.codigo === "5208707" && m.nome === "Goiânia" && m.uf === "GO")
  && x.dados.municipios.every((m) => /^\d{7}$/.test(m.codigo) && m.nome && m.uf), "municípios: \"goi\" acha Goiânia/GO (até 12; o suporte também busca)", x.dados);
x = await nf("GET", "municipios?q=" + encodeURIComponent("SAO PAULO"));
checar(x.dados.municipios[0].codigo === "3550308", "sem acento e sem caixa: \"SAO PAULO\" -> São Paulo primeiro", x.dados.municipios[0]);
x = await nf("GET", "municipios?q=paulo&uf=sp");
checar(x.dados.municipios.length > 0 && x.dados.municipios.every((m) => m.uf === "SP") && x.dados.municipios.some((m) => m.codigo === "3550308"),
  "por começo de palavra (\"paulo\" acha São Paulo) e só da UF pedida", x.dados.municipios);
x = await nf("GET", "municipios?q=5208707");
checar(x.dados.municipios.length === 1 && x.dados.municipios[0].nome === "Goiânia", "os 7 dígitos do código IBGE acham o município", x.dados);
x = await nf("GET", "municipios?q=" + encodeURIComponent("xyzw"));
const vazio = await nf("GET", "municipios?q=");
checar(x.status === 200 && x.dados.municipios.length === 0 && vazio.dados.municipios.length === 0, "nada que bata (ou busca vazia): lista vazia");
r = await admin("GET", "/api/admin/nfse/emissor/municipios?q=goi");
checar(r.status === 401, "a busca de município pede a mesma autenticação do painel");
r = await admin("POST", "/api/admin/nfse/emissor/prestador", { email: "fin@paulus.ia.br", cookie: SESSOES["fin@paulus.ia.br"], corpo: { prestador: PRESTADOR } });
let d = await r.json();
checar(r.status === 200 && d.versao === 1 && d.faltas.length === 0, "o financeiro grava os parâmetros (na hora, sem a fila)", d);
checar(!kv.has("admin:pendentes:fin@paulus.ia.br") || JSON.parse(kv.get("admin:pendentes:fin@paulus.ia.br")).length === 0, "nada entrou na fila de alterações");
const passoPrest = storage.db.prepare("SELECT criado_por FROM prestador ORDER BY id DESC LIMIT 1").get();
checar(passoPrest.criado_por === "fin@paulus.ia.br", "a versão da configuração registra quem gravou (o e-mail do Access)", passoPrest);

// ------------------------------------------------------------ 2. certificado
console.log("2. o certificado e o mTLS");
x = await nf("POST", "certificado", { ...doNavegador, chavePkcs8: "" });
checar(x.status === 400, "sem a chave: 400");
x = await nf("POST", "certificado", doNavegador);
checar(x.status === 200 && x.dados.certificado.instalado && x.dados.certificado.documento === "11222333000181" && x.dados.certificado.dias_restantes > 300,
  "sem o token: o certificado é guardado (cartão com CNPJ e dias restantes)", x.dados.certificado);
checar(x.dados.conexao.ok === false && x.dados.conexao.falta_token && /falta o token da Cloudflare/.test(x.dados.conexao.frase) && cf.length === 0,
  "e a tela diz claramente que falta o token para a conexão com a Sefin; nenhuma chamada à Cloudflare", x.dados.conexao);
const linha = storage.db.prepare("SELECT * FROM certificado WHERE ativo = 1").get();
checar(linha.chave_cifrada.startsWith("v1.") && !linha.chave_cifrada.includes(b64(pfx.chavePkcs8).slice(20, 60)), "a chave fica cifrada no DO");
checar(JSON.parse(kv.get("admin:nfse-cf:cadeia")).length === pfx.cadeiaPem.length, "a cadeia (pública) fica no KV para o mTLS");
x = await nf("POST", "cloudflare", { token: "não é token" });
checar(x.status === 400, "token com espaço: 400");
x = await nf("POST", "cloudflare", { token: TOKEN_CF });
checar(x.status === 200 && x.dados.cloudflare.token === true && x.dados.conexao && x.dados.conexao.ok === true && x.dados.conexao.certificate_id === "mtls-1",
  "com o token: grava e já cadastra o mTLS do certificado guardado", x.dados);
const tokCifrado = kv.get("admin:nfse-cf:token");
checar(tokCifrado.startsWith("v1.") && !tokCifrado.includes("cfat_") && new TextDecoder().decode(await decifrar(env, tokCifrado, "token-cloudflare")) === TOKEN_CF,
  "o token fica cifrado no KV (abre só com a NFSE_CHAVE_MESTRA)");
checar(!JSON.stringify(x.dados).includes(TOKEN_CF) && !JSON.stringify(await nf("GET", "situacao")).includes(TOKEN_CF), "o token nunca volta à tela");
let [c1, c2] = cf;
checar(cf.length === 2 && c1.metodo === "POST" && c1.caminho === `/accounts/${CF_CONTA}/mtls_certificates` && c1.auth === "Bearer " + TOKEN_CF,
  "1ª chamada: POST /accounts/{CF_ACCOUNT_ID}/mtls_certificates com o token", cf.map((c) => c.metodo + " " + c.caminho));
checar(c1.corpo.ca === false && c1.corpo.certificates.startsWith("-----BEGIN CERTIFICATE-----") && (c1.corpo.certificates.match(/BEGIN CERTIFICATE/g) || []).length === 1 + pfx.cadeiaPem.length
  && /^-----BEGIN PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+\n-----END PRIVATE KEY-----\n$/.test(c1.corpo.private_key) && /^nfse-11222333000181-\d{12}$/.test(c1.corpo.name),
  "o corpo: ca false, certificado + cadeia em PEM, a chave PKCS#8 em PEM e o nome com o CNPJ", { ...c1.corpo, private_key: c1.corpo.private_key.slice(0, 40) });
checar(c2.metodo === "PUT" && c2.caminho === `/accounts/${CF_CONTA}/workers/scripts/paulus-nfse-mtls` && c2.metadata.main_module === "index.js"
  && JSON.stringify(c2.metadata.bindings) === JSON.stringify([{ type: "mtls_certificate", name: "SEFIN", certificate_id: "mtls-1" }]),
  "2ª chamada: PUT do auxiliar paulus-nfse-mtls com o binding mtls_certificate SEFIN -> o certificado novo", c2.metadata);
checar(c2.script === readFileSync(join(AQUI, "nfse-mtls", "index.js"), "utf8").replace(/\r\n/g, "\n") && c2.script === CODIGO_AUXILIAR && c2.tipoScript.startsWith("application/javascript+module"),
  "o script publicado é o de worker/nfse-mtls/index.js (módulo)");
checar(kvJson("admin:nfse-cf:mtls").id === "mtls-1" && kvJson("admin:nfse-cf:mtls").documento === "11222333000181", "o mTLS em uso fica anotado");
x = await nf("POST", "cloudflare", { token: TOKEN_CF });
checar(x.dados.conexao === null && cf.length === 2, "gravar o token de novo, com o mTLS já deste certificado: não cadastra de novo");
// Certificado novo (renovação): cadastra, republica e apaga o anterior.
cf.length = 0;
x = await nf("POST", "certificado", doNavegador, "fin@paulus.ia.br");
checar(x.status === 200 && x.dados.conexao.ok && x.dados.conexao.certificate_id === "mtls-2", "certificado novo com o token: cadastrado na hora", x.dados.conexao);
checar(cf.map((c) => c.metodo).join(",") === "POST,PUT,DELETE" && cf[1].metadata.bindings[0].certificate_id === "mtls-2" && cf[2].caminho === `/accounts/${CF_CONTA}/mtls_certificates/mtls-1`,
  "POST do novo, PUT do auxiliar com ele e DELETE do anterior (mtls-1)", cf.map((c) => c.metodo + " " + c.caminho));
// A publicação do auxiliar falha: o certificado novo sai da Cloudflare e o anterior continua.
cf.length = 0;
cfModo = "put-falha";
x = await nf("POST", "certificado", doNavegador);
checar(x.status === 200 && x.dados.certificado.instalado && x.dados.conexao.ok === false && /publicar o Worker auxiliar/.test(x.dados.conexao.frase) && /Authentication error/.test(x.dados.conexao.frase),
  "o PUT do auxiliar falha: o certificado fica guardado e a frase diz o que falhou", x.dados.conexao);
checar(cf.map((c) => c.metodo).join(",") === "POST,PUT,DELETE" && cf[2].caminho.endsWith("/mtls-3") && kvJson("admin:nfse-cf:mtls").id === "mtls-2",
  "o certificado órfão (mtls-3) é apagado; o mTLS em uso continua o mtls-2", cf.map((c) => c.metodo + " " + c.caminho));
cfModo = "ok";

// ------------------------------------------------------------ 3. testar
console.log("3. testar comunicação");
x = await nf("POST", "testar");
const et = x.dados.etapas || [];
checar(x.status === 200 && x.dados.ok && et.length === 3 && et.map((e) => e.titulo).join("|") === "Certificado|Conexão com a Sefin|Convênio do município" && et.every((e) => e.ok),
  "três etapas, todas ok", x.dados);
checar(typeof et[1].ms === "number" && /respondeu HTTP 200 em \d+ ms \(produção restrita\)/.test(et[1].detalhe) && /convênio ativo/.test(et[2].detalhe), "com o tempo e a frase do convênio", et);
x = await nf("GET", "situacao");
checar(x.dados.pode_emitir === true && x.dados.municipio.situacao === "conveniado", "agora pode emitir", x.dados.motivos);

// ------------------------------------------------------------ 4. clientes e emitir
console.log("4. clientes e emitir pelo painel");
x = await nf("GET", "clientes", undefined, "sup@paulus.ia.br");
const cAna = x.dados.clientes.find((c) => c.id === ANA);
const cBruno = x.dados.clientes.find((c) => c.id === BRUNO);
checar(x.status === 200 && cAna.faltas.length === 0 && cAna.tomador.cmun === "1501402" && cBruno.faltas.includes("CEP"), "clientes: o tomador de cada um e o que falta", x.dados);
x = await nf("POST", "clientes/" + ANA, { tomador: { cep: "123" } });
checar(x.status === 400, "ajuste com CEP errado: 400");
x = await nf("POST", "clientes/" + ANA, { tomador: { email: "fiscal@ana.adv.br" } }, "sup@paulus.ia.br");
checar(x.status === 403, "o suporte não edita cliente");
x = await nf("POST", "clientes/" + ANA, { tomador: { email: "fiscal@ana.adv.br" } });
checar(x.status === 200 && x.dados.tomador.email === "fiscal@ana.adv.br" && x.dados.ajustado, "o dono salva o ajuste do tomador", x.dados);
kv.set("admin:nfse:config", JSON.stringify({ auto: false, email: false, mail: false }));
const competencia = HOJE.slice(0, 7);
x = await nf("POST", "notas", { conta: ANA, pagamento: "PAY1", tomador: { ...cAna.tomador, documento: "52998224726" }, valor: "300,00", descricao: "Assinatura do PAULUS — plano mensal", competencia });
checar(x.status === 400 && /não passou na conferência|CPF/.test(x.dados.erro), "erro de conferência volta com a frase (o pop-up mostra)", x.dados);
x = await nf("POST", "notas", { conta: ANA, pagamento: "PAY1", tomador: cAna.tomador, valor: "300,00", descricao: "Assinatura do PAULUS — plano mensal", competencia }, "fin@paulus.ia.br");
const n1 = x.dados;
checar(x.status === 200 && n1.estado === "emitida" && n1.numero && n1.competencia === competencia && n1.centavos === 30000 && n1.pagamento === "PAY1", "emitida pelo painel", n1);
checar(!kv.has("nfse:nota:" + ANA + ":nuvem-" + n1.id), "com \"entregar ao app\" desligado, a nota não vai ao app do cliente");
checar(kvJson("admin:nfse:PAY1").nota === "emitida" && kvJson("admin:nfse:PAY1").numero === n1.numero, "o pagamento fica marcado emitida");
checar(JSON.parse(kv.get(K_DEPOIS)).some((y) => y.id === n1.id), "a nota entra na lista do depois (PDF)");
const passos = (await nf("GET", "notas/" + n1.id)).dados.passos;
checar(passos[0].quem === "fin@paulus.ia.br" && passos.some((p) => /Enviar ao cliente/.test(p.detalhe)), "os passos dizem quem emitiu e que a entrega ficou para o botão", passos.map((p) => p.quem + ": " + p.detalhe));
d = await painel();
checar(d.emissor.ligado && d.notas.some((n) => n.id === n1.id) && !d.pagamentos.some((p) => p.id === "PAY1") && d.situacao.pode_emitir && d.pode.emitir,
  "GET /api/admin/nfse: a nota na lista e o pagamento fora dos sem nota", { pag: d.pagamentos, notas: d.notas.length });
checar((await painel("sup@paulus.ia.br")).pode.emitir === false, "para o suporte, a aba diz que ele não emite");
// PDF na hora (ainda não existe)
checar(!kv.has("admin:nfse-pdf:" + n1.id), "o PDF ainda não existe");
x = await nf("GET", "notas/" + n1.id + "/pdf", undefined, "sup@paulus.ia.br");
checar(x.status === 200 && x.r.headers.get("content-type") === "application/pdf" && Buffer.from(x.dados.subarray(0, 5)).toString() === "%PDF-" && /^inline; filename="NFS-e \d+\.pdf"$/.test(x.r.headers.get("content-disposition")),
  "PDF: gerado na hora num pedido próprio (o suporte também baixa)", x.r.headers.get("content-disposition"));
checar(kv.has("admin:nfse-pdf:" + n1.id), "e guardado para a próxima vez");
x = await nf("GET", "notas/" + n1.id + "/pdf?baixar=1");
checar(/^attachment;/.test(x.r.headers.get("content-disposition")), "?baixar=1: attachment");
x = await nf("GET", "notas/" + n1.id + "/xml");
checar(x.status === 200 && x.r.headers.get("content-type").startsWith("application/xml") && x.dados.includes("<NFSe"), "XML da nota");
// depois (PDF + e-mail) pelo painel
x = await nf("POST", "notas/" + n1.id + "/depois");
checar(x.status === 202 && esperando.length === 1, "POST depois: 202, em ctx.waitUntil");
await Promise.all(esperando.splice(0));
checar(instancia.obter(n1.id).pdf_em !== "" && !JSON.parse(kv.get(K_DEPOIS)).some((y) => y.id === n1.id), "o PDF marcado na nota; fora da lista do depois");
// enviar ao cliente, com "mail" ligado
kv.set("admin:nfse:config", JSON.stringify({ auto: false, email: false, mail: true }));
x = await nf("POST", "notas/" + n1.id + "/enviar", undefined, "sup@paulus.ia.br");
checar(x.status === 403, "o suporte não envia ao cliente");
const antesEmails = emails.length;
x = await nf("POST", "notas/" + n1.id + "/enviar");
const base1 = ANA + ":nuvem-" + n1.id;
checar(x.status === 200 && x.dados.ok && x.dados.pdf && kvJson("nfse:nota:" + base1).tem_pdf === true && kv.get("nfse:nota-pdf:" + base1) === kv.get("admin:nfse-pdf:" + n1.id),
  "Enviar ao cliente: a nota, o XML e o PDF no app dele", x.dados);
const em = emails.at(-1);
checar(x.dados.email === "enviado" && emails.length === antesEmails + 1 && em.to[0] === "fiscal@ana.adv.br" && em.attachments.length === 2 && /Sua NFS-e de/.test(em.subject),
  "com \"mandar também por e-mail\" ligado, o e-mail vai ao e-mail fiscal do tomador, com PDF e XML", em && { to: em.to, subject: em.subject });
x = await nf("POST", "notas/999/enviar");
checar(x.status === 404, "enviar nota que não existe: 404");

// ------------------------------------------------------------ 5. automático
console.log("5. automático no pagamento");
kv.set("admin:nfse:config", JSON.stringify({ auto: true, email: true, mail: true }));
const antesAuto = emails.length;
await avisoDaIA(env, "order", { id: "ORD-ANA", external_reference: "ia-recarga-" + ANA + "-1", status: "processed", total_amount: 50 }, chamarMP);
const auto = instancia.listar({}).find((n) => n.pagamento === "ORD-ANA");
checar(auto && auto.estado === "emitida" && auto.centavos === 5000 && auto.conta === ANA && /Recarga/.test(auto.descricao), "o Pix confirmado com o auto ligado emite sozinho (tomador completo)", auto);
const baseA = ANA + ":nuvem-" + auto.id;
checar(kvJson("nfse:nota:" + baseA) && kvJson("admin:nfse:ORD-ANA").nota === "emitida" && !kvJson("admin:nfse:ORD-ANA").motivo,
  "\"entregar ao app\" ligado: a nota vai ao app do cliente logo depois de emitir; o pagamento marcado", kvJson("admin:nfse:ORD-ANA"));
checar(JSON.parse(kv.get(K_DEPOIS)).some((y) => y.id === auto.id) && emails.length === antesAuto, "o PDF e o e-mail ficam para outro pedido (a lista do depois)");
let feitas = await depoisPendentes(env, Date.now());
checar(feitas.feitas === 0, "o Cron espera 1 min antes de pegar (a tela pede logo depois de emitir)");
feitas = await depoisPendentes(env, Date.now() + 2 * 60 * 1000);
checar(feitas.feitas === 1 && kvJson("nfse:nota:" + baseA).tem_pdf === true && emails.length === antesAuto + 1 && instancia.obter(auto.id).email === "enviado",
  "o Cron de cada minuto faz o PDF e manda o e-mail", { feitas, emails: emails.length - antesAuto, email: instancia.obter(auto.id).email });
checar((await depoisPendentes(env, Date.now() + 3 * 60 * 1000)).feitas === 0, "sem nota esperando, nada a fazer");
await avisoDaIA(env, "order", { id: "ORD-BRUNO", external_reference: "ia-recarga-" + BRUNO + "-1", status: "processed", total_amount: 50 }, chamarMP);
const pagB = kvJson("admin:nfse:ORD-BRUNO");
checar(pagB.nota === "pendente" && /emissão automática parada: falta .*CEP/.test(pagB.motivo) && !instancia.listar({}).some((n) => n.pagamento === "ORD-BRUNO"),
  "tomador incompleto: nada é emitido e o motivo fica no pagamento", pagB);
d = await painel();
checar(d.pagamentos.some((p) => p.id === "ORD-BRUNO" && /falta/.test(p.motivo)), "a lista de pagamentos sem nota mostra o motivo", d.pagamentos);
kv.set("admin:nfse:config", JSON.stringify({ auto: false, email: true, mail: false }));
await avisoDaIA(env, "order", { id: "ORD-ANA-2", external_reference: "ia-recarga-" + ANA + "-2", status: "processed", total_amount: 50 }, chamarMP);
checar(!instancia.listar({}).some((n) => n.pagamento === "ORD-ANA-2") && (await painel()).pagamentos.some((p) => p.id === "ORD-ANA-2"), "com o auto desligado, o pagamento só entra na lista");
// Emitir pelo pop-up a partir do pagamento: o valor, a descrição e a competência vêm dele.
x = await nf("POST", "notas", { conta: ANA, pagamento: "ORD-ANA-2", tomador: cAna.tomador });
checar(x.status === 200 && x.dados.estado === "emitida" && x.dados.centavos === 5000 && x.dados.competencia === HOJE.slice(0, 7), "emitir a partir do pagamento: valor e competência do pagamento", x.dados);

// ------------------------------------------------------------ 6. cancelar, substituir, produção
console.log("6. cancelar, substituir e produção");
x = await nf("POST", "notas/" + auto.id + "/cancelar", { motivo: "1", texto: "Erro na emissão: valor errado na nota" }, "sup@paulus.ia.br");
checar(x.status === 403, "o suporte não cancela");
x = await nf("POST", "notas/" + auto.id + "/cancelar", { motivo: "1", texto: "Erro na emissão: valor errado na nota" });
checar(x.status === 200 && x.dados.nota.estado === "cancelada" && kvJson("nfse:nota:" + baseA).cancelada === true && kvJson("admin:nfse:ORD-ANA").nota === "cancelada",
  "cancelada: o app do cliente e o pagamento ficam sabendo", x.dados.nota);
x = await nf("POST", "notas/" + n1.id + "/substituir", { motivo: "99", texto: "Valor digitado errado na nota anterior", ajustes: { valor: "299,90" } });
checar(x.status === 200 && x.dados.nota.estado === "emitida" && x.dados.nota.centavos === 29990 && x.dados.original.estado === "substituida",
  "substituta emitida pelo painel; a original fica substituída", x.dados);
checar(kvJson("nfse:nota:" + base1).cancelada === true && kvJson("nfse:nota:" + base1).substituta === x.dados.nota.numero, "o app do cliente vê a original cancelada com o número da substituta");
// O reembolso: a nota do pagamento devolvido sai sozinha.
let rb = await devolverPagamento(env, chamarMP, ANA, "ORD-ANA-2", { por: "dono@paulus.ia.br" });
const notaRb = instancia.listar({}).find((n) => n.pagamento === "ORD-ANA-2");
checar(rb.nota.acao === "cancelada" && notaRb.estado === "cancelada" && !rb.aviso && kvJson("admin:nfse:ORD-ANA-2").reembolso,
  "reembolso no prazo do município: a nota do pagamento é cancelada (motivo 9, o texto da desistência)", { nota: rb.nota, estado: notaRb.estado });
const evRb = instancia.todos("SELECT tipo, motivo, texto FROM eventos WHERE nota_id = ? ORDER BY id DESC", notaRb.id)[0];
checar(evRb.tipo === "101101" && evRb.motivo === "9" && /arrependimento/.test(evRb.texto), "o evento de cancelamento com o motivo 9 e o texto", evRb);
await avisoDaIA(env, "order", { id: "ORD-ANA-3", external_reference: "ia-recarga-" + ANA + "-3", status: "processed", total_amount: 50 }, chamarMP);
x = await nf("POST", "notas", { conta: ANA, pagamento: "ORD-ANA-3", tomador: cAna.tomador });
const notaFora = x.dados;
sim.usar("fora_do_prazo");
rb = await devolverPagamento(env, chamarMP, ANA, "ORD-ANA-3", { por: "dono@paulus.ia.br" });
sim.usar("sucesso");
const evFora = instancia.todos("SELECT tipo, estado FROM eventos WHERE nota_id = ? ORDER BY id", notaFora.id);
checar(rb.nota.acao === "analise_fiscal" && instancia.obter(notaFora.id).estado === "emitida" && evFora.some((e) => e.tipo === "101103" && e.estado === "registrado"),
  "fora do prazo (a Sefin diz E0822): a análise fiscal é pedida ao município (e101103) e a nota continua emitida", { nota: rb.nota, evFora });
const pedidoAnalise = instancia.todos("SELECT xml_pedido FROM eventos WHERE nota_id = ? AND tipo = '101103'", notaFora.id)[0].xml_pedido;
checar(/<e101103><xDesc>Solicitação de Análise Fiscal para Cancelamento de NFS-e<\/xDesc><cMotivo>9<\/cMotivo><xMotivo>/.test(pedidoAnalise), "o pedido da análise com o xDesc do XSD e o motivo 9");
checar(/análise fiscal/.test(kvJson("admin:nfse:ORD-ANA-3").reembolso.nota), "o pagamento guarda o que aconteceu com a nota", kvJson("admin:nfse:ORD-ANA-3").reembolso);
// O município defere: a consulta da situação vê o e105104 e a nota fica cancelada.
await sim.registrarEvento(instancia.obter(notaFora.id).chave, "<evento><infEvento><e105104><xDesc>Cancelamento de NFS-e Deferido por Análise Fiscal</xDesc></e105104></infEvento></evento>", "105104");
await instancia.atualizarSituacao(notaFora.id, "teste");
checar(instancia.obter(notaFora.id).estado === "cancelada", "deferida a análise, a consulta da situação cancela a nota");
x = await nf("POST", "producao/liberar", {}, "fin@paulus.ia.br");
checar(x.status === 200 && x.dados.ambiente === "producao" && x.dados.producao_liberada, "Mudar para produção (já há nota emitida em testes)", x.dados.ambiente);
x = await nf("POST", "producao/voltar");
checar(x.status === 200 && x.dados.ambiente === "producao_restrita" && !x.dados.producao_liberada, "Voltar para testes");

// ------------------------------------------------------------ sem o emissor
console.log("7. sem o emissor ligado");
const semMestra = { ...env, NFSE_CHAVE_MESTRA: "" };
r = await atenderAdmin(new Request("https://paulus.ia.br/api/admin/nfse/emissor/situacao", { headers: { "cf-access-jwt-assertion": await jwt("dono@paulus.ia.br"), cookie: "pv_admin=" + SESSOES["dono@paulus.ia.br"] } }),
  semMestra, new URL("https://paulus.ia.br/api/admin/nfse/emissor/situacao"), ctx, deps);
d = await r.json();
checar(r.status === 503 && /NFSE_CHAVE_MESTRA/.test(d.erro), "sem a NFSE_CHAVE_MESTRA: 503 dizendo o que falta", d);
r = await atenderAdmin(new Request("https://paulus.ia.br/api/admin/nfse/emissor/municipios?q=bel", { headers: { "cf-access-jwt-assertion": await jwt("dono@paulus.ia.br"), cookie: "pv_admin=" + SESSOES["dono@paulus.ia.br"] } }),
  semMestra, new URL("https://paulus.ia.br/api/admin/nfse/emissor/municipios?q=bel"), ctx, deps);
d = await r.json();
checar(r.status === 200 && d.municipios.some((m) => m.codigo === "1501402"), "a busca de município não depende do emissor ligado (é só a tabela)", d);

console.log(falhas ? `\n  ${falhas} falha(s)` : "\n  notas fiscais no painel: todos os testes passaram");
process.exit(falhas ? 1 : 0);
