// Testes da conta Atos e do "Entrar com Atos".
//   node worker/teste.mjs
import worker from "./index.js";
import { conferirIdToken } from "./oidc.js";

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
};
const par = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const jwk = { ...(await crypto.subtle.exportKey("jwk", par.privateKey)), kid: "atos-teste" };
const emails = [];
globalThis.fetch = async (u, op) => {
  if (String(u).startsWith("https://api.resend.com")) { emails.push(JSON.parse(op.body)); return new Response("{}", { status: 200 }); }
  if (String(u) === "https://oauth2.googleapis.com/token") return googleResponde(op);
  throw new Error("fetch inesperado: " + u);
};
const env = { CONTAS, ATOS_CHAVE: JSON.stringify(jwk), RESEND_API_KEY: "re_teste", ASSETS: { fetch: async () => new Response("<p>pagina</p>", { headers: { "content-type": "text/html" } }) } };

const A = "https://atos.dev.br";
let cookie = "";
async function chamar(caminho, { metodo = "POST", corpo, origem = A, form, headers = {}, semCookie } = {}) {
  const h = { ...headers };
  if (origem) h.origin = origem;
  if (cookie && !semCookie) h.cookie = cookie;
  let body;
  if (form) { body = new URLSearchParams(form).toString(); h["content-type"] = "application/x-www-form-urlencoded"; }
  else if (corpo !== undefined) { body = JSON.stringify(corpo); h["content-type"] = "application/json"; }
  const r = await worker.fetch(new Request(A + caminho, { method: metodo, headers: h, body }), env);
  const sc = r.headers.get("set-cookie");
  if (sc && !semCookie) cookie = sc.split(";")[0].endsWith("=") ? "" : sc.split(";")[0];
  let d = null;
  try { d = await r.clone().json(); } catch { d = null; }
  return { status: r.status, d, r };
}
const codigoDe = (m) => (m.subject.match(/\b(\d{6})\b/) || [])[1];
const b64url = (b) => Buffer.from(b).toString("base64url");
async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const desafio = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, desafio };
}
function consulta(campos) {
  return new URLSearchParams({ client_id: "pavlvs-site", redirect_uri: "https://paulus.ia.br/entrar-atos/", response_type: "code",
    scope: "openid email profile", state: "estado-1", nonce: "n-1", code_challenge_method: "S256", ...campos }).toString();
}

console.log("redirecionamentos e cabecalhos");
let r = await worker.fetch(new Request("https://matheusuener.com.br/x?y=1"), env);
checar(r.status === 301 && r.headers.get("location") === A + "/x?y=1", "matheusuener.com.br volta para atos.dev.br");
r = await worker.fetch(new Request(A + "/entrar?client_id=x"), env);
checar(/frame-ancestors 'none'/.test(r.headers.get("content-security-policy")) && r.headers.get("x-frame-options") === "DENY", "/entrar nao pode ser emoldurada");

console.log("conta");
r = await chamar("/api/cadastrar", { corpo: { email: "Joao@Escritorio.adv.br", senha: "curta1" } });
checar(r.status === 400, "senha curta: recusada");
r = await chamar("/api/cadastrar", { corpo: { email: "joao@escritorio.adv.br", senha: "senhaforte123", nome: "João" }, origem: "https://mal.example" });
checar(r.status === 403, "POST de outra origem: recusado");
r = await chamar("/api/cadastrar", { corpo: { email: "Joao@Escritorio.adv.br", senha: "senhaforte123", nome: "João <b>" } });
const cod = codigoDe(emails[0]);
checar(r.status === 200 && emails[0].to[0] === "joao@escritorio.adv.br" && emails[0].from.includes("naoresponda@atos.dev.br") && cod, "cadastrar manda o codigo de naoresponda@atos.dev.br", emails[0]);
r = await chamar("/api/confirmar", { corpo: { email: "joao@escritorio.adv.br", codigo: "000000" === cod ? "111111" : "000000" } });
checar(r.status === 400, "codigo errado: recusado");
r = await chamar("/api/confirmar", { corpo: { email: "joao@escritorio.adv.br", codigo: cod } });
checar(r.status === 200 && cookie.startsWith("__Host-atos=") && r.d.conta.nome === "João b", "codigo certo: conta criada e sessao aberta (nome sem tags)", r.d);
const conta = JSON.parse(guardados.get("id:conta:joao@escritorio.adv.br"));
checar(/^pv-[0-9a-f]{24}$/.test(conta.sub) && !JSON.stringify(conta).includes("senhaforte"), "conta no formato do PAVLVS, sem a senha");
r = await chamar("/api/eu", { metodo: "GET" });
checar(r.d.conta && r.d.conta.email === "joao@escritorio.adv.br", "/api/eu reconhece a sessao");
r = await chamar("/api/sair", { corpo: {} });
r = await chamar("/api/eu", { metodo: "GET" });
checar(r.d.conta === null, "sair fecha a sessao");
r = await chamar("/api/entrar", { corpo: { email: "joao@escritorio.adv.br", senha: "errada12345" } });
checar(r.status === 401 && !cookie, "senha errada: recusada");
r = await chamar("/api/entrar", { corpo: { email: "joao@escritorio.adv.br", senha: "senhaforte123" } });
checar(r.status === 200 && cookie, "senha certa: entra");

console.log("conta que ja existia no PAVLVS (mesmas chaves)");
guardados.set("id:google:maria@gmail.com", JSON.stringify({ sub: "1122334455" }));
await chamar("/api/esqueci", { corpo: { email: "maria@gmail.com" }, semCookie: true });
const codM = codigoDe(emails.at(-1));
r = await chamar("/api/redefinir", { corpo: { email: "maria@gmail.com", codigo: codM, senha: "outrasenha99" }, semCookie: true });
checar(r.status === 200 && JSON.parse(guardados.get("id:conta:maria@gmail.com")).sub === "1122334455", "quem entrou com o Google cria a senha e fica com o mesmo sub");

console.log("pedido de autorizacao");
const { verifier, desafio } = await pkce();
r = await chamar("/api/pedido", { corpo: { consulta: consulta({ client_id: "desconhecido", code_challenge: desafio }) } });
checar(r.status === 400 && r.d.erro && !r.d.ir, "aplicativo desconhecido: erro sem voltar");
r = await chamar("/api/pedido", { corpo: { consulta: consulta({ redirect_uri: "https://mal.example/", code_challenge: desafio }) } });
checar(r.status === 400 && !r.d.ir, "endereco de volta de fora: erro sem voltar");
r = await chamar("/api/pedido", { corpo: { consulta: consulta({ code_challenge_method: "plain", code_challenge: desafio }) } });
checar(r.d.ir && r.d.ir.includes("error=invalid_request"), "sem PKCE S256: volta com erro");
r = await chamar("/api/pedido", { corpo: { consulta: consulta({ code_challenge: desafio, prompt: "none" }) } });
checar(r.d.ir && r.d.ir.includes("error=consent_required"), "prompt=none sem permissao: consent_required");
r = await chamar("/api/pedido", { corpo: { consulta: consulta({ code_challenge: desafio }) } });
checar(r.d.app && r.d.app.nome === "PAVLVS" && r.d.entrar === false && r.d.permitido === false && r.d.escopos.length === 3, "pede a permissao na primeira vez", r.d);
r = await chamar("/api/autorizar", { corpo: { consulta: consulta({ code_challenge: desafio }), permitir: false } });
checar(r.d.ir && r.d.ir.includes("error=access_denied") && r.d.ir.includes("state=estado-1"), "nao permitir volta com access_denied");
r = await chamar("/api/autorizar", { corpo: { consulta: consulta({ code_challenge: desafio }), permitir: true }, origem: "https://paulus.ia.br" });
checar(r.status === 403, "autorizar de outra origem: recusado");
r = await chamar("/api/autorizar", { corpo: { consulta: consulta({ code_challenge: desafio }), permitir: true } });
const ida = new URL(r.d.ir);
const code = ida.searchParams.get("code");
checar(ida.origin + ida.pathname === "https://paulus.ia.br/entrar-atos/" && code && ida.searchParams.get("state") === "estado-1" && ida.searchParams.get("iss") === A, "permitir volta com o codigo, o state e o iss", r.d);

console.log("troca do codigo");
r = await chamar("/oauth/token", { form: { grant_type: "authorization_code", code, redirect_uri: "https://paulus.ia.br/entrar-atos/", client_id: "pavlvs-site", code_verifier: "x".repeat(43) }, origem: "https://paulus.ia.br" });
checar(r.status === 400 && r.d.error === "invalid_grant", "verifier errado: recusado (e o codigo morre)");
r = await chamar("/api/autorizar", { corpo: { consulta: consulta({ code_challenge: desafio }), permitir: true } });
const code2 = new URL(r.d.ir).searchParams.get("code");
r = await chamar("/oauth/token", { form: { grant_type: "authorization_code", code: code2, redirect_uri: "https://paulus.ia.br/entrar-atos/", client_id: "pavlvs-site", code_verifier: verifier }, origem: "https://paulus.ia.br" });
checar(r.status === 200 && r.d.id_token && r.d.access_token && r.r.headers.get("access-control-allow-origin") === "https://paulus.ia.br", "verifier certo: tokens, com CORS para paulus.ia.br", r.d);
const info = await conferirIdToken(env, r.d.id_token);
checar(info && info.iss === A && info.aud === "pavlvs-site" && info.sub === conta.sub && info.email === "joao@escritorio.adv.br" && info.email_verified === true && info.name === "João b" && info.nonce === "n-1" && info.exp - info.iat === 3600, "id_token ES256 assinado com as reivindicacoes", info);
const acesso = r.d.access_token;
r = await chamar("/oauth/token", { form: { grant_type: "authorization_code", code: code2, redirect_uri: "https://paulus.ia.br/entrar-atos/", client_id: "pavlvs-site", code_verifier: verifier } });
checar(r.status === 400, "o mesmo codigo nao vale duas vezes");
r = await chamar("/oauth/userinfo", { metodo: "GET", headers: { authorization: "Bearer " + acesso }, semCookie: true });
checar(r.status === 200 && r.d.email === "joao@escritorio.adv.br" && r.d.sub === conta.sub, "userinfo com o access_token");
r = await chamar("/oauth/jwks", { metodo: "GET" });
checar(r.d.keys.length === 1 && r.d.keys[0].kid === "atos-teste" && !r.d.keys[0].d, "jwks publica so a parte publica");
r = await chamar("/.well-known/openid-configuration", { metodo: "GET" });
checar(r.d.issuer === A && r.d.authorization_endpoint === A + "/entrar" && r.d.code_challenge_methods_supported[0] === "S256", "descoberta");

console.log("segunda vez e o programa instalado");
const p2 = await pkce();
r = await chamar("/api/pedido", { corpo: { consulta: consulta({ client_id: "pavlvs-app", redirect_uri: "http://127.0.0.1:53111/atos", code_challenge: p2.desafio }) } });
checar(r.d.permitido === true && r.d.entrar === false, "o programa do mesmo aplicativo ja esta permitido", r.d);
r = await chamar("/api/pedido", { corpo: { consulta: consulta({ client_id: "pavlvs-app", redirect_uri: "http://127.0.0.1:53111/atos", code_challenge: p2.desafio, prompt: "none" }) } });
checar(r.d.ir && r.d.ir.startsWith("http://127.0.0.1:53111/atos?code="), "prompt=none ja permitido: volta direto com o codigo");
r = await chamar("/api/pedido", { corpo: { consulta: consulta({ client_id: "pavlvs-app", redirect_uri: "http://evil.example:53111/atos", code_challenge: p2.desafio }) } });
checar(r.status === 400, "programa: so volta para 127.0.0.1");
r = await chamar("/api/pedido", { corpo: { consulta: consulta({ client_id: "pavlvs-escritorio", redirect_uri: "https://moura.paulus.ia.br/api/acesso/atos/retorno", code_challenge: p2.desafio }) } });
checar(r.d.permitido === true && r.d.app.nome === "PAVLVS", "a equipe de fora (pavlvs-escritorio) volta ao endereco do escritorio, com a mesma permissao do PAVLVS", r.d);
for (const fora of ["https://www.paulus.ia.br/api/acesso/atos/retorno", "https://moura.paulus.ia.br.golpe.com/api/acesso/atos/retorno", "https://moura.paulus.ia.br/outra"]) {
  r = await chamar("/api/pedido", { corpo: { consulta: consulta({ client_id: "pavlvs-escritorio", redirect_uri: fora, code_challenge: p2.desafio }) } });
  checar(r.status === 400, "escritorio: recusa " + fora);
}
r = await chamar("/api/pedido", { corpo: { consulta: consulta({ code_challenge: p2.desafio, prompt: "consent" }) } });
checar(r.d.permitido === false, "prompt=consent pede de novo");

console.log("revogar");
r = await chamar("/api/apps", { metodo: "GET" });
checar(r.d.apps.length === 1 && r.d.apps[0].nome === "PAVLVS" && r.d.apps[0].ultimo, "a conta lista o PAVLVS", r.d);
r = await chamar("/api/autorizar", { corpo: { consulta: consulta({ code_challenge: p2.desafio }), permitir: true } });
const code3 = new URL(r.d.ir).searchParams.get("code");
await chamar("/api/apps/revogar", { corpo: { app: "pavlvs" } });
r = await chamar("/oauth/token", { form: { grant_type: "authorization_code", code: code3, redirect_uri: "https://paulus.ia.br/entrar-atos/", client_id: "pavlvs-site", code_verifier: p2.verifier } });
checar(r.status === 400 && /revogada/.test(r.d.error_description), "revogar no meio: o codigo nao vale mais");
r = await chamar("/api/pedido", { corpo: { consulta: consulta({ code_challenge: p2.desafio }) } });
checar(r.d.permitido === false, "depois de revogar, pede a permissao de novo");

console.log("troca de senha fecha as outras sessoes");
const sessaoVelha = cookie;
await chamar("/api/esqueci", { corpo: { email: "joao@escritorio.adv.br" }, semCookie: true });
const codJ = codigoDe(emails.at(-1));
const antes = Date.now;
Date.now = () => antes() + 5000;
r = await chamar("/api/redefinir", { corpo: { email: "joao@escritorio.adv.br", codigo: codJ, senha: "senhanova777" }, semCookie: true });
Date.now = antes;
cookie = sessaoVelha;
r = await chamar("/api/eu", { metodo: "GET" });
checar(r.d.conta === null, "a sessao de antes da troca caiu");

console.log("continuar com Google");
let googleDiz = {};
let googleRecebeu = null;
function googleResponde(op) {
  googleRecebeu = Object.fromEntries(new URLSearchParams(op.body));
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const corpo = { iss: "https://accounts.google.com", aud: "cliente-atos", exp: Math.floor(Date.now() / 1000) + 3600, email_verified: true, ...googleDiz };
  return new Response(JSON.stringify({ access_token: "g", id_token: enc({ alg: "RS256" }) + "." + enc(corpo) + ".x" }), { status: 200 });
}
async function irAoGoogle(consulta, envUsado) {
  const r = await worker.fetch(new Request(A + "/oauth/google?consulta=" + encodeURIComponent(consulta || "")), envUsado);
  const destino = new URL(r.headers.get("location"));
  return { r, destino, state: destino.searchParams.get("state") };
}
async function voltarDoGoogle(state, envUsado, extra = "") {
  const r = await worker.fetch(new Request(A + "/oauth/google/volta?code=c1&state=" + encodeURIComponent(state) + extra), envUsado);
  const sc = r.headers.get("set-cookie") || "";
  return { r, local: r.headers.get("location") || "", cookie: sc ? sc.split(";")[0] : "" };
}
const nonceDe = () => {
  const k = [...guardados.keys()].find((x) => x.startsWith("atos:google:"));
  return k ? JSON.parse(guardados.get(k)).nonce : "";
};
{
  let g = await irAoGoogle("", env);
  checar(g.r.status === 302 && g.destino.pathname === "/entrar/" && g.destino.searchParams.get("erro_google"), "sem o cliente do Google: volta a /entrar dizendo que nao esta ligado");
  r = await chamar("/api/eu", { metodo: "GET", semCookie: true });
  checar(r.d.google === false, "e o botao nao aparece (/api/eu google: false)");

  const envG = { ...env, GOOGLE_CLIENT_ID: "cliente-atos", GOOGLE_CLIENT_SECRET: "segredo" };
  const Q = consulta({ code_challenge: p2.desafio });
  g = await irAoGoogle(Q, envG);
  checar(g.destino.origin === "https://accounts.google.com" && g.destino.searchParams.get("client_id") === "cliente-atos"
    && g.destino.searchParams.get("redirect_uri") === A + "/oauth/google/volta" && g.destino.searchParams.get("code_challenge_method") === "S256"
    && g.destino.searchParams.get("scope") === "openid email profile", "vai ao Google com o cliente da Atos, PKCE e so a identidade", g.destino.toString());
  googleDiz = { sub: "g-joao", email: "Joao@Escritorio.adv.br", name: "João Google", nonce: nonceDe() };
  let v = await voltarDoGoogle(g.state, envG);
  const contaJ = JSON.parse(guardados.get("id:conta:joao@escritorio.adv.br"));
  checar(v.r.status === 302 && v.local.startsWith(A + "/entrar/?") && new URL(v.local).searchParams.get("client_id") === "pavlvs-site" && v.cookie.startsWith("__Host-atos="),
    "a volta abre a sessao e segue o pedido do aplicativo", v.local);
  checar(contaJ.sub === conta.sub && contaJ.google === "g-joao" && contaJ.hash, "e-mail que ja tem conta com senha: a mesma conta (o mesmo sub), com o Google anotado", contaJ);
  checar(googleRecebeu && googleRecebeu.client_secret === "segredo" && googleRecebeu.code_verifier && googleRecebeu.redirect_uri === A + "/oauth/google/volta",
    "a troca no Google leva o segredo, o verifier e o mesmo endereco de volta");
  v = await voltarDoGoogle(g.state, envG);
  checar(v.local.includes("erro_google") && !v.cookie, "o mesmo state nao vale duas vezes");

  guardados.set("id:google:dora@gmail.com", JSON.stringify({ sub: "111-do-paulus" }));
  g = await irAoGoogle("", envG);
  googleDiz = { sub: "111-do-paulus", email: "dora@gmail.com", name: "Dora", nonce: nonceDe() };
  v = await voltarDoGoogle(g.state, envG);
  const contaD = JSON.parse(guardados.get("id:conta:dora@gmail.com"));
  checar(v.local === A + "/conta/" && contaD.sub === "111-do-paulus" && !contaD.hash && contaD.nome === "Dora",
    "quem ja entrava no PAVLVS com o Google: a conta Atos nasce sem senha, com o mesmo sub de la", contaD);
  r = await chamar("/api/entrar", { corpo: { email: "dora@gmail.com", senha: "qualquercoisa1" }, semCookie: true });
  checar(r.status === 401, "conta so com o Google nao entra por senha");

  g = await irAoGoogle("", envG);
  googleDiz = { sub: "g-novo", email: "novo@gmail.com", name: "Novo", nonce: "outro" };
  v = await voltarDoGoogle(g.state, envG);
  checar(v.local.includes("erro_google") && !guardados.has("id:conta:novo@gmail.com"), "nonce que nao confere: recusado, nada criado");
  g = await irAoGoogle("", envG);
  googleDiz = { sub: "g-novo", email: "novo@gmail.com", name: "Novo", nonce: nonceDe(), email_verified: false };
  v = await voltarDoGoogle(g.state, envG);
  checar(v.local.includes("erro_google") && !guardados.has("id:conta:novo@gmail.com"), "e-mail nao verificado pelo Google: recusado");
  g = await irAoGoogle("", envG);
  googleDiz = { sub: "g-novo", email: "novo@gmail.com", name: "Novo", nonce: nonceDe() };
  v = await voltarDoGoogle(g.state, envG);
  checar(JSON.parse(guardados.get("id:conta:novo@gmail.com")).sub === "g-novo" && JSON.parse(guardados.get("id:google:novo@gmail.com")).sub === "g-novo",
    "e-mail novo: a conta nasce com o sub do Google, e o indice fica anotado");
  g = await irAoGoogle(Q, envG);
  v = await voltarDoGoogle(g.state, envG, "&error=access_denied");
  checar(v.local.startsWith(A + "/entrar/?") && !v.local.includes("erro_google") && !v.cookie, "cancelar no Google volta ao pedido, sem erro");
}

console.log(falhas ? "\n" + falhas + " falha(s)" : "\ntudo certo");
process.exit(falhas ? 1 : 0);
