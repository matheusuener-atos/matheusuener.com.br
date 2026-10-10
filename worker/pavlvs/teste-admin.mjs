// Teste do painel admin (worker/admin.js), sem rede:
//   node worker/teste-admin.mjs
// O Cloudflare Access assina com uma chave gerada aqui; o GitHub, o Resend, o
// Mercado Pago e a API da Cloudflare (tuneis e a politica do Access) sao de
// mentira; o Durable Object roda aqui sobre um Map.
import { atenderAdmin, comPlanosDoPainel, ehRotaDoAdmin, enviarCampanhas, htmlDoEmail } from "./admin.js";
import { atenderIA, ContaIA } from "./ia.js";
import { atenderTunel, limparEscritorios, provisionar } from "./tunel.js";

let falhas = 0;
const checar = (ok, descricao, detalhe) => {
  console.log((ok ? "  ok   " : "  FALHA ") + descricao + (ok || detalhe === undefined ? "" : " -> " + JSON.stringify(detalhe)));
  if (!ok) falhas++;
};

// ------------------------------------------------------------ o KV
const guardados = new Map();
const kv = () => ({
  get: async (k) => guardados.get(k) || null,
  put: async (k, v) => { guardados.set(k, v); },
  delete: async (k) => { guardados.delete(k); },
  list: async ({ prefix }) => ({ list_complete: true, keys: [...guardados.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }),
});
const APOIOS = kv();

// ------------------------------------------------ o Durable Object aqui
let relogio = Date.parse("2026-10-03T15:00:00Z");
const objetos = new Map();
const CONTAS_IA = {
  idFromName: (n) => n,
  get: (n) => ({
    fetch: (url, init) => {
      if (!objetos.has(n)) {
        const dados = new Map();
        const o = new ContaIA({ storage: { get: async (k) => structuredClone(dados.get(k)), put: async (k, v) => { dados.set(k, structuredClone(v)); } } }, { APOIOS });
        o.agora = () => relogio;
        objetos.set(n, o);
      }
      return objetos.get(n).fetch(new Request(url, init));
    },
  }),
};

// ------------------------------------- Resend, Mercado Pago e a Cloudflare
const emails = [];
const mp = [];
// A API da Cloudflare: os tuneis e o DNS (worker/tunel.js) e a politica de
// permitir da aplicacao do Access do painel (o convite da equipe). A politica
// e reutilizavel (a de hoje: so muda pelo caminho da conta) ou, com
// reutilizavel = false, a antiga, presa a aplicacao.
const cf = {
  tuneis: new Map(), dns: new Map(), chamadas: [], seq: 0, recusar: "", reutilizavel: true,
  politica: { id: "pol1", name: "Equipe do painel", decision: "allow", include: [{ email: { email: "dono@paulus.ia.br" } }, { email: { email: "suporte@paulus.ia.br" } }],
    exclude: [], require: [], session_duration: "24h", mfa_config: { allowed_authenticators: ["totp"] } },
  apps: [],
};
const respCF = (result, ok = true, status = ok ? 200 : 400, msg = "falha de mentira") =>
  new Response(JSON.stringify({ success: ok, errors: ok ? [] : [{ message: msg }], result }), { status });
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u === "https://api.resend.com/emails") {
    emails.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ id: "e" + emails.length }), { status: 200 });
  }
  if (u.startsWith("https://api.cloudflare.com/client/v4/")) {
    const caminho = u.slice("https://api.cloudflare.com/client/v4".length);
    const metodo = (init.method || "GET").toUpperCase();
    const corpo = init.body ? JSON.parse(init.body) : null;
    cf.chamadas.push({ metodo, caminho, corpo, auth: (init.headers || {}).Authorization });
    if (cf.recusar && caminho.includes(cf.recusar)) return respCF(null, false);
    let m;
    if (metodo === "GET" && (m = caminho.match(/^\/accounts\/[^/]+\/access\/apps\?aud=(.*)$/))) {
      return respCF(structuredClone(cf.apps.filter((a) => a.aud === decodeURIComponent(m[1]))));
    }
    if ((m = caminho.match(/^\/accounts\/[^/]+\/access\/policies\/([^/]+)$/))) {
      if (!cf.reutilizavel || m[1] !== cf.politica.id) return respCF(null, false, 404, "access.api.error.not_found");
      if (metodo === "GET") return respCF(structuredClone(cf.politica));
      if (metodo === "PUT") { cf.politica = { ...corpo, id: cf.politica.id }; return respCF(cf.politica); }
    }
    if ((m = caminho.match(/^\/accounts\/[^/]+\/access\/apps\/([^/]+)\/policies\/([^/]+)$/))) {
      if (cf.reutilizavel && metodo === "PUT") return respCF(null, false, 400, "can not update reusable policies through this endpoint");
      if (m[2] !== cf.politica.id) return respCF(null, false, 404, "access.api.error.not_found");
      if (metodo === "GET") return respCF(structuredClone(cf.politica));
      if (metodo === "PUT") { cf.politica = { ...corpo, id: cf.politica.id }; return respCF(cf.politica); }
    }
    if (metodo === "POST" && /\/access\/organizations\/revoke_user$/.test(caminho)) return respCF(true);
    if (metodo === "POST" && /\/cfd_tunnel$/.test(caminho)) { const id = "tun-" + ++cf.seq; cf.tuneis.set(id, { status: "inactive" }); return respCF({ id }); }
    if (metodo === "PUT" && /\/cfd_tunnel\/[^/]+\/configurations$/.test(caminho)) return respCF({});
    if (metodo === "GET" && (m = caminho.match(/\/cfd_tunnel\/([^/]+)\/token$/))) return respCF("token-" + m[1]);
    if (metodo === "GET" && (m = caminho.match(/\/cfd_tunnel\/([^/]+)$/))) return cf.tuneis.has(m[1]) ? respCF({ id: m[1], status: cf.tuneis.get(m[1]).status }) : respCF(null, false);
    if (metodo === "DELETE" && /\/cfd_tunnel\/[^/]+(\/connections)?$/.test(caminho)) return respCF({});
    if (metodo === "POST" && /\/dns_records$/.test(caminho)) { const id = "dns-" + ++cf.seq; cf.dns.set(id, corpo); return respCF({ id }); }
    if ((metodo === "PUT" || metodo === "DELETE") && /\/dns_records\/[^/]+$/.test(caminho)) return respCF({});
    return respCF(null, false);
  }
  return new Response("{}", { status: 404 });
};
// Os pagamentos que o Mercado Pago conhece (a forma no extrato): id -> o /v1/payments/{id}.
const pagamentosMP = new Map();
async function chamarMP(env, caminho, metodo, corpo, extra = {}) {
  mp.push({ caminho, metodo, corpo, extra });
  // A cobranca da assinatura traz o pagamento dela (o reembolso da mensalidade).
  if (/^\/authorized_payments\//.test(caminho)) {
    const id = caminho.split("/").pop();
    return { ok: true, status: 200, dados: { id, payment: { id: pagamentosMP.has("cobranca:" + id) ? pagamentosMP.get("cobranca:" + id) : 555 } } };
  }
  const pg = metodo === "GET" && caminho.match(/^\/v1\/payments\/([^/]+)$/);
  if (pg && pagamentosMP.has(pg[1])) return { ok: true, status: 200, dados: pagamentosMP.get(pg[1]) };
  return { ok: true, status: 200, dados: {} };
}

// ------------------------------------------------ o Access de mentira
const TIME = "paulus.cloudflareaccess.com";
const AUD = "aud-do-painel";
const par = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const jwkPublica = { ...(await crypto.subtle.exportKey("jwk", par.publicKey)), kid: "k1" };
const b64url = (bytes) => Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function jwt(email, extra = {}) {
  const cab = b64url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", kid: "k1" })));
  const corpo = b64url(new TextEncoder().encode(JSON.stringify({ email, aud: [AUD], iss: "https://" + TIME, exp: relogio / 1000 + 3600, ...extra })));
  const ass = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", par.privateKey, new TextEncoder().encode(cab + "." + corpo));
  return cab + "." + corpo + "." + b64url(new Uint8Array(ass));
}

// ------------------------------------------------ o GitHub de mentira
let permissao = "write";
// A reversao de um commit antigo (a publicacao de um material, antes de 07/10):
// o commit abc1234 criou peca.md e mudou materiais.json; a main esta em cabeca000.
const GH = "https://api.github.com/repos/matheusuener-atos/coryphaeus";
const ghReversao = { conflito: false, chamadas: [] };
async function github(metodo, url, token, corpo) {
  if (url.includes("/login/oauth/access_token")) return { ok: true, status: 200, dados: corpo.code === "bom" ? { access_token: "gho_x" } : {} };
  if (url.endsWith("/user")) return { ok: true, status: 200, dados: { login: "matheus" } };
  if (url.includes("/collaborators/")) return { ok: true, status: 200, dados: { permission: permissao } };
  if (url.startsWith(GH + "/git/") || url.startsWith(GH + "/commits/") || url.startsWith(GH + "/contents/")) ghReversao.chamadas.push({ metodo, url, corpo, token });
  if (url === GH + "/git/ref/heads/main") return { ok: true, status: 200, dados: { object: { sha: "cabeca000" } } };
  if (url === GH + "/git/commits/cabeca000") return { ok: true, status: 200, dados: { tree: { sha: "arvore000" } } };
  if (url === GH + "/commits/abc1234") {
    return { ok: true, status: 200, dados: { sha: "abc1234ffff", parents: [{ sha: "pai000" }], files: [
      { filename: "site/materiais/peca.md", status: "added", sha: "blobMd" }, { filename: "site/dados/materiais.json", status: "modified", sha: "blobJson2" }] } };
  }
  if (url === GH + "/contents/site/dados/materiais.json?ref=pai000") return { ok: true, status: 200, dados: { sha: "blobJson1" } };
  if (url === GH + "/contents/site/materiais/peca.md?ref=cabeca000") return { ok: true, status: 200, dados: { sha: "blobMd" } };
  if (url === GH + "/contents/site/dados/materiais.json?ref=cabeca000") return { ok: true, status: 200, dados: { sha: ghReversao.conflito ? "blobJson3" : "blobJson2" } };
  if (metodo === "POST" && url === GH + "/git/trees") return { ok: true, status: 201, dados: { sha: "arvore001" } };
  if (metodo === "POST" && url === GH + "/git/commits") return { ok: true, status: 201, dados: { sha: "reverte0001112223334445556667778889990000" } };
  if (metodo === "PATCH" && url === GH + "/git/refs/heads/main") return { ok: true, status: 200, dados: {} };
  return { ok: false, status: 404, dados: null };
}

const env = {
  IA_ATIVA: "1", CONTAS_IA, APOIOS, ACCESS_TEAM: TIME, ACCESS_AUD: AUD,
  GITHUB_CLIENT_ID: "cid", GITHUB_CLIENT_SECRET: "csec", RESEND_API_KEY: "re_x", MP_ACCESS_TOKEN: "mp",
  IA_PLANO_TOKENS: "10000", IA_RECARGA_TOKENS: "5000",
  ADMIN_EQUIPE: JSON.stringify([{ email: "dono@paulus.ia.br", nome: "Matheus", papel: "dono" }, { email: "suporte@paulus.ia.br", nome: "Ana", papel: "suporte" }]),
  ASSETS: { fetch: async () => new Response(JSON.stringify({ versao: "0.9.22" }), { status: 200 }) },
};
const deps = { github, chamarMP, chavesDoAccess: async () => [jwkPublica], agora: () => relogio };

async function admin(metodo, caminho, { email = "dono@paulus.ia.br", corpo, cookie = "", semAccess = false, envUsado = env } = {}) {
  const headers = { "content-type": "application/json" };
  if (!semAccess) headers["cf-access-jwt-assertion"] = typeof email === "string" && email.includes(".") && email.split(".").length === 3 && !email.includes("@") ? email : await jwt(email);
  if (cookie) headers.cookie = "pv_admin=" + cookie;
  const req = new Request("https://paulus.ia.br" + caminho, { method: metodo, headers, body: corpo ? JSON.stringify(corpo) : undefined });
  return atenderAdmin(req, envUsado, new URL(req.url), { waitUntil() {} }, deps);
}

// ------------------------------------------------------------ as portas
console.log("portas");
let r = await admin("GET", "/api/admin/sessao", { semAccess: true });
let d = await r.json();
checar(r.status === 200 && !d.access.ok && !d.pronto, "sessao sem o Access: 200, nada liberado", d);
r = await admin("GET", "/api/admin/visao", { semAccess: true });
checar(r.status === 401, "visao sem o Access: 401");
r = await admin("GET", "/api/admin/visao", { envUsado: { ...env, ACCESS_AUD: "" } });
checar(r.status === 503, "sem ACCESS_AUD configurado o painel fica fechado");
const outroTime = await jwt("dono@paulus.ia.br", { iss: "https://outro.cloudflareaccess.com" });
r = await admin("GET", "/api/admin/visao", { email: outroTime });
checar(r.status === 401, "JWT de outro time do Access: 401");
const adulterado = (await jwt("dono@paulus.ia.br")).replace(/\.[^.]+$/, ".AAAA");
r = await admin("GET", "/api/admin/visao", { email: adulterado });
checar(r.status === 401, "JWT com a assinatura errada: 401");
r = await admin("GET", "/api/admin/visao", { email: "intruso@gmail.com" });
checar(r.status === 403, "e-mail fora da equipe: 403");
r = await admin("GET", "/api/admin/visao");
d = await r.json();
checar(r.status === 401 && d.passo === "sessao", "com o Access e sem a sessão: 401 passo sessao", d);
// A sessao nasce do Access, sem o GitHub.
r = await admin("GET", "/api/admin/sessao");
d = await r.json();
const soAccess = (r.headers.get("set-cookie") || "").match(/pv_admin=([0-9a-f]+)/)?.[1];
checar(r.status === 200 && d.pronto && d.access.ok && !d.github.ok && soAccess && /HttpOnly; Secure; SameSite=Lax/.test(r.headers.get("set-cookie")),
  "com o Access e o e-mail na equipe, a sessão nasce sem o GitHub", d);
r = await admin("GET", "/api/admin/sessao", { cookie: soAccess });
checar(!r.headers.get("set-cookie") && (await r.json()).pronto, "com o cookie, a mesma sessão (sem criar outra)");
r = await admin("GET", "/api/admin/visao", { cookie: soAccess });
checar(r.status === 200, "só com o Access, o painel abre");
r = await admin("POST", "/api/admin/publicar", { cookie: soAccess, corpo: { confirmacao: "comitar e pushar" } });
d = await r.json();
checar(r.status === 403 && d.passo === "github" && d.erro.includes("comitar e pushar"), "comitar e pushar sem o GitHub: 403 passo github", d);
r = await admin("POST", "/api/admin/retroagir", { cookie: soAccess, corpo: { commit: "abc1234", confirmacao: "retroagir" } });
d = await r.json();
checar(r.status === 403 && d.passo === "github" && d.erro.includes("retroagir"), "retroagir sem o GitHub: 403 passo github", d);
r = await admin("GET", "/api/admin/sessao", { semAccess: true, cookie: soAccess });
checar(!(await r.json()).pronto, "o cookie sozinho, sem o Access, não vale");

r = await admin("GET", "/api/admin/github/entrar");
const loc = new URL(r.headers.get("location"));
const state = loc.searchParams.get("state");
checar(r.status === 302 && loc.hostname === "github.com" && loc.searchParams.get("scope") === "public_repo read:user", "entrar com o GitHub: 302 com o escopo do repositorio");
r = await admin("GET", "/api/admin/github/retorno?code=bom&state=errado");
checar(r.status === 302 && r.headers.get("location").includes("erro="), "state errado volta com erro");
permissao = "read";
r = await admin("GET", "/api/admin/github/retorno?code=bom&state=" + state);
checar(r.headers.get("location").includes("escrita"), "conta sem escrita no repositorio nao entra", r.headers.get("location"));
permissao = "write";
r = await admin("GET", "/api/admin/github/entrar");
const state2 = new URL(r.headers.get("location")).searchParams.get("state");
r = await admin("GET", "/api/admin/github/retorno?code=bom&state=" + state2, { email: "suporte@paulus.ia.br" });
checar(r.headers.get("location").includes("erro="), "o state de uma pessoa nao serve para outra");
r = await admin("GET", "/api/admin/github/entrar");
const state3 = new URL(r.headers.get("location")).searchParams.get("state");
r = await admin("GET", "/api/admin/github/retorno?code=bom&state=" + state3);
const sessao = (r.headers.get("set-cookie") || "").match(/pv_admin=([0-9a-f]+)/)?.[1];
checar(r.status === 302 && r.headers.get("location") === "/admin/" && sessao && /HttpOnly; Secure; SameSite=Lax/.test(r.headers.get("set-cookie")), "login completo: cookie HttpOnly e volta ao painel");
r = await admin("GET", "/api/admin/visao", { email: "suporte@paulus.ia.br", cookie: sessao });
checar(r.status === 401, "o cookie de uma pessoa nao vale com o Access de outra");
r = await admin("GET", "/api/admin/sessao", { cookie: sessao });
d = await r.json();
checar(d.pronto && d.papel === "dono" && d.github.login === "matheus" && d.worker === "0.9.22" && d.config.nfse.ligado === false && d.config.nfse.falta.includes("EMISSOR_NFSE") && d.config.tuneis.ligado === false, "sessao pronta, papel e o que falta configurar (sem o DO, o emissor de NFS-e diz que falta)", d);
const como = (extra = {}) => ({ cookie: sessao, ...extra });

// ------------------------------------------------------------ as contas
console.log("contas");
const iaCtx = { waitUntil() {} };
async function ia(caminho, corpo) {
  const req = new Request("https://paulus.ia.br" + caminho, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(corpo) });
  return atenderIA(req, env, new URL(req.url), iaCtx, { chamarMP, donoDoToken: async (e, t) => ({ sub: t, email: t + "@escritorio.com.br" }) });
}
const segredos = {};
for (const quem of ["ana", "bruno"]) {
  const x = await (await ia("/api/ia/ativar", { id_token: quem, instalacao_id: "inst-" + quem + "-123", nome_escritorio: "Escritório " + quem })).json();
  segredos[quem] = x.segredo;
}
const idAna = segredos.ana.split("_")[1];
const idBruno = segredos.bruno.split("_")[1];
checar(guardados.has("admin:conta:" + idAna) && guardados.has("admin:conta:" + idBruno), "cada conta se anota no indice do painel");
await CONTAS_IA.get(idAna).fetch("https://conta-ia/creditar", { method: "POST", body: JSON.stringify({ acao: "creditar", pedido: "ORD1", valor: 50 }) });
r = await admin("GET", "/api/admin/contas", como());
d = await r.json();
checar(d.contas.length === 2 && d.contas.every((c) => c.email.endsWith("@escritorio.com.br") && !c._d), "lista as contas da nuvem (sem o detalhe cru)", d.contas);
r = await admin("GET", "/api/admin/contas/" + idAna, como());
d = await r.json();
checar(d.pagamentos.length === 1 && d.pagamentos[0].valor === 50 && d.instalacoes.length === 1 && d.instalacoes[0].hash8.length === 8, "detalhe da conta: pagamentos e instalacoes", d);
const hash8 = d.instalacoes[0].hash8;
r = await admin("GET", "/api/admin/visao", como());
d = await r.json();
checar(d.kpi.contas === 2 && d.kpi.receita_recargas === 50 && d.dias.length === 42, "visao geral: contas, receita do mes e 14 dias x 3 turnos", d.kpi);
r = await admin("GET", "/api/admin/busca?q=bruno", como());
d = await r.json();
checar(d.contas.length === 1 && d.contas[0].alvo === idBruno, "busca acha a conta pelo nome");
r = await admin("GET", "/api/admin/tokens?visao=conta&periodo=mes", como());
d = await r.json();
checar(d.linhas.length === 2 && d.kpis.receita === 50, "tokens por conta com a receita", d.kpis);

// ------------------------------------------------------------ a fila
console.log("fila");
r = await admin("POST", "/api/admin/alteracoes", como({ corpo: { tela: "contas", tipo: "conta.creditar", alvo: idBruno, dados: { id: idBruno, tokens: 1000 }, texto: "Creditei 1.000 tokens ao Bruno" } }));
checar(r.status === 200 && (await r.json()).pendentes.length === 1, "creditar entra na fila, nao acontece na hora");
let resumoBruno = await (await CONTAS_IA.get(idBruno).fetch("https://conta-ia/resumo", { method: "POST", body: JSON.stringify({ acao: "resumo" }) })).json();
checar(!resumoBruno.recargas.length, "antes de publicar, a conta nao mudou");
r = await admin("POST", "/api/admin/alteracoes", como({ corpo: { tipo: "conta.instalacao.apagar", dados: { id: idAna, hash8 }, texto: "Desvinculei a instalação da Ana" } }));
r = await admin("POST", "/api/admin/alteracoes", como({ corpo: { tipo: "plano.editar", dados: { id: "escritorio", valor: 320, valor_anual: 3200, tokens: 32 }, texto: "Escritório a R$ 320" } }));
r = await admin("POST", "/api/admin/alteracoes", como({ corpo: { tipo: "coisa.estranha", dados: {} } }));
checar(r.status === 400, "tipo desconhecido e recusado");
r = await admin("POST", "/api/admin/alteracoes", como({ corpo: { tipo: "cupom.criar", dados: { codigo: "PILOTO30", desconto: 30, meses: 3 } } }));
checar(r.status === 400, "o cupom saiu do sistema: criar cupom e alteracao desconhecida");
checar((await admin("GET", "/api/admin/cupons", como())).status === 404, "e a tela de cupons nao tem mais rota");
r = await admin("POST", "/api/admin/publicar", como({ corpo: { confirmacao: "commitar e pushar" } }));
checar(r.status === 400, "publicar com a frase errada nao publica");
r = await admin("POST", "/api/admin/publicar", como({ corpo: { confirmacao: "comitar e pushar" } }));
d = await r.json();
checar(d.ok && d.resultados.length === 3 && d.publicacao.n === 3, "publicar aplica as tres", d);
resumoBruno = await (await CONTAS_IA.get(idBruno).fetch("https://conta-ia/resumo", { method: "POST", body: JSON.stringify({ acao: "resumo" }) })).json();
checar(resumoBruno.recargas.length === 1 && resumoBruno.recargas[0].tokens === 1000, "depois de publicar, os tokens estao na conta");
const resumoAna = await (await CONTAS_IA.get(idAna).fetch("https://conta-ia/resumo", { method: "POST", body: JSON.stringify({ acao: "resumo" }) })).json();
checar(resumoAna.instalacoes === 0, "a instalacao da Ana saiu");
r = await (await fetch("https://nada")).status; // so para nao ficar fetch pendurado
const planosKV = JSON.parse(guardados.get("admin:planos"));
checar(planosKV.find((p) => p.id === "escritorio").valor === 320 && planosKV.find((p) => p.id === "escritorio").valor_anual === 3200 && planosKV.find((p) => p.id === "escritorio").tokens === 32e6, "plano editado no KV, com o valor do ano", planosKV);
r = await admin("GET", "/api/admin/alteracoes", como());
d = await r.json();
checar(!d.pendentes.length && d.publicacoes.length === 1, "fila vazia e a publicacao no historico");

// papel
r = await admin("GET", "/api/admin/github/entrar", { email: "suporte@paulus.ia.br" });
const st = new URL(r.headers.get("location")).searchParams.get("state");
r = await admin("GET", "/api/admin/github/retorno?code=bom&state=" + st, { email: "suporte@paulus.ia.br" });
const sessaoSuporte = (r.headers.get("set-cookie") || "").match(/pv_admin=([0-9a-f]+)/)?.[1];
r = await admin("POST", "/api/admin/alteracoes", { email: "suporte@paulus.ia.br", cookie: sessaoSuporte, corpo: { tipo: "conta.creditar", dados: { id: idAna, tokens: 5 } } });
checar(r.status === 403, "suporte nao credita tokens");
r = await admin("POST", "/api/admin/alteracoes", { email: "suporte@paulus.ia.br", cookie: sessaoSuporte, corpo: { tipo: "equipe.papel", dados: { email: "dono@paulus.ia.br", papel: "suporte" } } });
checar(r.status === 403, "suporte nao muda papeis");

// --------------------------------------------------------- e-mail e campanhas
console.log("e-mail");
r = await admin("POST", "/api/admin/campanhas/teste", como({ corpo: { campanha: { assunto: "Olá {nome}", titulo: "Novidade", texto: "Oi {nome}, tudo bem?" } } }));
checar(r.status === 200 && emails.length === 1 && emails[0].to[0] === "dono@paulus.ia.br" && !emails[0].subject.startsWith("[teste]"), "e-mail de teste vai para quem esta na sessao", emails[0]);
r = await admin("POST", "/api/admin/campanhas/teste", { ...como(), envUsado: { ...env, RESEND_API_KEY: "" }, corpo: { campanha: { assunto: "x", texto: "y" } } });
checar(r.status === 503 && (await r.json()).erro.includes("RESEND_API_KEY"), "sem o provedor de e-mail: 503 dizendo o que falta");
r = await admin("POST", "/api/admin/alteracoes", como({ corpo: { tipo: "campanha.disparar", dados: { nome: "Boas-vindas", publico: "todos", assunto: "Bem-vindo, {nome}", texto: "O PAULUS chegou.", botao: "Abrir", link: "https://paulus.ia.br/", quando: "agora" }, texto: "Disparei Boas-vindas" } }));
r = await admin("POST", "/api/admin/publicar", como({ corpo: { confirmacao: "comitar e pushar" } }));
checar((await r.json()).ok, "a campanha entra na fila de envio");
emails.length = 0;
const enviados = await enviarCampanhas(env, relogio);
checar(enviados.enviados === 2 && emails.length === 2 && emails.every((e) => e.html.includes("/api/e/")), "o Cron manda a leva com pixel e link rastreados", enviados);
const idCamp = [...guardados.keys()].find((k) => k.startsWith("admin:campanha:")).split(":")[2];
const campanha = JSON.parse(guardados.get("admin:campanha:" + idCamp));
checar(campanha.situacao === "enviada" && campanha.destinatarios.every((x) => !x.email), "terminado o envio, os e-mails saem do KV", campanha);
checar(JSON.parse(guardados.get("admin:campanhas:fila")).length === 0, "e a campanha sai do indice do Cron");
const t = campanha.destinatarios[0].t;
const ab = await admin("GET", "/api/e/" + idCamp + "/" + t + "/a.gif", { semAccess: true });
await admin("GET", "/api/e/" + idCamp + "/" + t + "/a.gif", { semAccess: true });
const cl = await admin("GET", "/api/e/" + idCamp + "/" + t + "/c", { semAccess: true });
const depois = JSON.parse(guardados.get("admin:campanha:" + idCamp));
checar(ab.headers.get("content-type") === "image/gif" && cl.status === 302 && cl.headers.get("location") === "https://paulus.ia.br/" && depois.abertos === 1 && depois.cliques === 1, "abertura conta uma vez; clique redireciona", depois);
checar(htmlDoEmail({ titulo: "<b>", texto: "a\n\nb" }).includes("&lt;b&gt;"), "o HTML do e-mail escapa o texto");

// --------------------------------------------------------- renovacoes
console.log("renovacoes");
await CONTAS_IA.get(idBruno).fetch("https://conta-ia/assinatura", { method: "POST", body: JSON.stringify({ acao: "assinatura", assinatura: { id: "pre1", situacao: "authorized", valor: 300 } }) });
relogio += 40 * 24 * 3600 * 1000;
r = await admin("GET", "/api/admin/renovacoes", como());
d = await r.json();
checar(d.abertas.length === 1 && d.abertas[0].id === idBruno && d.abertas[0].dias_vencido >= 1, "ciclo vencido aparece em nao renovacoes", d);
emails.length = 0;
r = await admin("POST", "/api/admin/renovacoes/" + idBruno + "/lembrete", como());
d = await r.json();
checar(emails.length === 1 && emails[0].to[0] === "bruno@escritorio.com.br" && d.abertas[0].lembrete_em, "lembrete enviado e anotado");
r = await admin("POST", "/api/admin/renovacoes/" + idBruno + "/tratar", como());
d = await r.json();
checar(!d.abertas.length && d.tratadas.length === 1, "marcar como tratada");

// --------------------------------------------------------- materiais
console.log("materiais (saíram)");
const semMateriais = await atenderAdmin(new Request("https://paulus.ia.br/api/materiais/enviar", { method: "POST", body: "{}" }), env, new URL("https://paulus.ia.br/api/materiais/enviar"), {}, deps);
checar(semMateriais.status !== 200 && !ehRotaDoAdmin(new URL("https://paulus.ia.br/api/materiais/enviar")), "o envio de material saiu do painel");
r = await admin("GET", "/api/admin/materiais", como());
checar(r.status === 404, "a fila de materiais saiu do painel", r.status);

// --------------------------------------------------------- NFS-e e equipe
console.log("nfse e equipe");
r = await admin("GET", "/api/admin/nfse", como());
d = await r.json();
checar(r.status === 200 && !d.emissor.ligado && d.emissor.falta.includes("EMISSOR_NFSE") && Array.isArray(d.notas) && Array.isArray(d.pagamentos) && d.pode.emitir === true,
  "sem o DO do emissor: a aba abre e diz o que falta (o resto em teste-nfse-admin.mjs)", d);
r = await admin("POST", "/api/admin/nfse/emissor/notas", como({ corpo: { valor: 1 } }));
d = await r.json();
checar(r.status === 503 && d.erro.includes("EMISSOR_NFSE"), "emitir sem o DO: 503 dizendo o que falta", d);
r = await admin("POST", "/api/admin/alteracoes", como({ corpo: { tipo: "nfse.config", dados: { auto: true, email: false, mail: true }, texto: "Liguei: mandar também por e-mail" } }));
r = await admin("POST", "/api/admin/publicar", como({ corpo: { confirmacao: "comitar e pushar" } }));
d = await r.json();
checar(d.ok && JSON.stringify(JSON.parse(guardados.get("admin:nfse:config"))) === JSON.stringify({ auto: true, email: false, mail: true }), "nfse.config grava os tres interruptores (auto, email, mail)", { d, cfg: guardados.get("admin:nfse:config") });
r = await admin("GET", "/api/admin/nfse", como());
d = await r.json();
checar(d.config.mail === true && d.config.auto === true, "e o painel le o mail de volta", d.config);
guardados.delete("admin:nfse:config");
r = await admin("POST", "/api/admin/alteracoes", como({ corpo: { tipo: "nfse.emitir", dados: { ids: ["x"] }, texto: "Emiti" } }));
checar(r.status === 400, "nfse.emitir saiu da fila: emitir e na hora, pelo emissor");
r = await admin("POST", "/api/admin/alteracoes", como({ corpo: { tipo: "equipe.papel", dados: { email: "dono@paulus.ia.br", papel: "suporte" }, texto: "Rebaixei o dono" } }));
r = await admin("POST", "/api/admin/publicar", como({ corpo: { confirmacao: "comitar e pushar" } }));
d = await r.json();
checar(!d.ok && d.resultados[0].erro.includes("pelo menos um dono"), "a equipe nao fica sem dono", d);
r = await admin("GET", "/api/admin/equipe", como());
d = await r.json();
checar(d.membros.length === 2 && d.matriz.length >= 6, "equipe e matriz de permissoes");

// ----------------------------------------------------------- reembolso
console.log("reembolso");
const contaDo = (id, acao, dados = {}) => CONTAS_IA.get(id).fetch("https://conta-ia/" + acao, { method: "POST", body: JSON.stringify({ acao, ...dados }) }).then((x) => x.json());
for (const quem of ["carla", "dani"]) await ia("/api/ia/ativar", { id_token: quem, instalacao_id: "inst-" + quem + "-123", nome_escritorio: "Escritório " + quem });
const idCarla = (await (await ia("/api/ia/ativar", { id_token: "carla", instalacao_id: "inst-carla-123" })).json()).segredo.split("_")[1];
const idDani = (await (await ia("/api/ia/ativar", { id_token: "dani", instalacao_id: "inst-dani-123" })).json()).segredo.split("_")[1];
// Carla: um mês no Pix e uma recarga; Dani: a assinatura mensal no cartão, com a primeira cobrança.
let rc = await contaDo(idCarla, "anual_pago", { pagamento: "PAYMES1", plano: "advogado", valor: 449, meses: 1 });
checar(rc.plano_vigente && rc.periodo === "avulso", "Carla com o mês no Pix", rc.periodo);
guardados.set("admin:nfse:PAYMES1", JSON.stringify({ id: "PAYMES1", conta: idCarla, tipo: "mês avulso", valor: 449, quando: new Date(relogio).toISOString(), nota: "pendente" }));
rc = await contaDo(idCarla, "creditar", { pedido: "ORD9", valor: 120, plano: "advogado" });
const extraAntes = (await contaDo(idCarla, "admin_detalhe")).extra;
await contaDo(idDani, "assinatura", { plano: "advogado", assinatura: { id: "preDani", situacao: "authorized", valor: 449 } });
let rd = await contaDo(idDani, "renovar", { cobranca: "COB1", valor: 449, quando: new Date(relogio).toISOString() });
checar(rd.plano_vigente, "Dani com a mensalidade paga", rd.ciclo);
const fila = async () => (await (await admin("GET", "/api/admin/alteracoes", como())).json()).pendentes;
for (const x of await fila()) await admin("DELETE", "/api/admin/alteracoes/" + x.id, como());
const reemb = (id, pagamento) => admin("POST", "/api/admin/alteracoes", como({ corpo: { tela: "contas", tipo: "conta.reembolsar", alvo: id + ":" + pagamento, dados: { id, pagamento }, texto: "Reembolsei " + pagamento } }));
checar((await reemb(idCarla, "NAOEXISTE")).status === 400, "reembolsar pagamento que não é da conta: recusado na fila");
checar((await reemb(idCarla, "PAYMES1")).status === 200 && (await reemb(idCarla, "ORD9")).status === 200 && (await reemb(idDani, "COB1")).status === 200, "três reembolsos na fila");
let antesMP = mp.length;
checar(!(await contaDo(idCarla, "resumo")).pagamentos, "na fila, nada mudou ainda");
r = await admin("POST", "/api/admin/publicar", como({ corpo: { confirmacao: "comitar e pushar" } }));
d = await r.json();
checar(d.ok && d.resultados.length === 3, "publicar aplica os três", d);
const feitos = mp.slice(antesMP);
checar(feitos.some((x) => x.caminho === "/v1/payments/PAYMES1/refunds" && x.metodo === "POST" && x.extra["X-Idempotency-Key"] === "reembolso-PAYMES1"),
  "o mês no Pix volta pelo /v1/payments/<id>/refunds, com a chave de idempotência do pagamento", feitos);
checar(feitos.some((x) => x.caminho === "/v1/orders/ORD9/refund"), "a recarga volta pelo /v1/orders/<id>/refund", feitos);
checar(feitos.some((x) => x.caminho === "/authorized_payments/COB1") && feitos.some((x) => x.caminho === "/v1/payments/555/refunds")
  && feitos.some((x) => x.caminho === "/preapproval/preDani" && x.corpo.status === "cancelled"), "a mensalidade: acha o pagamento da cobrança, devolve e cancela a assinatura", feitos);
const dc = await contaDo(idCarla, "admin_detalhe");
checar(!dc.plano_vigente && dc.assinatura.situacao === "refunded" && dc.pagamentos.find((x) => x.ref === "PAYMES1").reembolso.por === "dono@paulus.ia.br",
  "Carla: o mês acaba na hora e o pagamento fica marcado com quem devolveu", dc.assinatura);
checar(extraAntes > 0 && dc.extra === 0 && dc.pagamentos.find((x) => x.ref === "ORD9").tokens_tirados === extraAntes, "a recarga devolvida sai dos créditos", { antes: extraAntes, depois: dc.extra, pg: dc.pagamentos.find((x) => x.ref === "ORD9") });
checar(JSON.parse(guardados.get("admin:nfse:PAYMES1")).nota === "reembolsado", "a fila de notas não pede nota do pagamento devolvido");
const dd = await contaDo(idDani, "admin_detalhe");
checar(!dd.plano_vigente && dd.assinatura.situacao === "cancelled", "Dani: a assinatura cancelada e o ciclo pago fechado", { a: dd.assinatura, c: dd.ciclo });
checar((await reemb(idCarla, "PAYMES1")).status === 400, "reembolsar de novo: recusado");
// O aviso do estorno, que o Mercado Pago manda depois, não mexe de novo.
const estornoDepois = await contaDo(idCarla, "anual_estornado", { pagamento: "PAYMES1" });
checar(estornoDepois.assinatura.situacao === "refunded", "o aviso do estorno depois do painel não muda nada");
d = await (await admin("GET", "/api/admin/visao", como())).json();
checar((d.avisos || []).some((x) => x.tipo === "reembolso" && x.texto.startsWith("Reembolso pelo painel")), "o reembolso aparece nos avisos da visão geral", d.avisos);
// O suporte não reembolsa.
r = await admin("POST", "/api/admin/alteracoes", { email: "suporte@paulus.ia.br", corpo: { tipo: "conta.reembolsar", dados: { id: idCarla, pagamento: "ORD9" } } });
checar(r.status === 401 || r.status === 403, "o suporte não reembolsa", r.status);

// ================================================ etapa 6: o que o painel pedia ao servidor
const DIA = 24 * 3600 * 1000;
const publicarFila = async (extra = {}) => (await admin("POST", "/api/admin/publicar", como({ ...extra, corpo: { confirmacao: "comitar e pushar" } }))).json();
const pedir = (tipo, dados, texto = tipo, extra = {}) => admin("POST", "/api/admin/alteracoes", como({ ...extra, corpo: { tela: "teste", tipo, alvo: String(dados.id || dados.slug || dados.email || ""), dados, texto } }));
const comoSuporte = (extra = {}) => ({ email: "suporte@paulus.ia.br", cookie: sessaoSuporte, ...extra });
const limparFila = async () => { for (const x of await fila()) await admin("DELETE", "/api/admin/alteracoes/" + x.id, como()); };
async function novaConta(nome) {
  const x = await (await ia("/api/ia/ativar", { id_token: nome, instalacao_id: "inst-" + nome + "-123", nome_escritorio: "Escritório " + nome })).json();
  return x.segredo.split("_")[1];
}
// Mexe direto no que o medidor guarda (o uso de meses atras, um ciclo que ja venceu).
async function mexerNaConta(id, f) {
  const st = objetos.get(id).state.storage;
  const conta = await st.get("conta");
  f(conta);
  await st.put("conta", conta);
}
const retroagir = (corpo, extra = {}) => admin("POST", "/api/admin/retroagir", como({ ...extra, corpo: { confirmacao: "retroagir", ...corpo } }));
let antesMP2, det;

// ---------------------------------------------- conta: plano, cadastro e pausa
console.log("conta: plano, cadastro e pausa");
await limparFila();
const idEva = await novaConta("eva");
await contaDo(idEva, "assinatura", { plano: "advogado", assinatura: { id: "preEva", situacao: "authorized", valor: 449 } });
antesMP2 = mp.length;
r = await pedir("conta.plano", { id: idEva, plano: "escritorio" }, "Troquei o plano da Eva: Advogado → Escritório na renovação");
d = await r.json();
checar(r.status === 200, "trocar o plano entra na fila", d);
d = await publicarFila();
const putEva = mp.slice(antesMP2).find((x) => x.caminho === "/preapproval/preEva" && x.metodo === "PUT");
// O valor do Escritorio e o de agora no painel (R$ 320, editado na fila acima), nao o de fabrica.
checar(d.ok && putEva && putEva.corpo.auto_recurring.transaction_amount === 320 && putEva.corpo.reason === "Paulus - plano Escritório",
  "publicado: o Mercado Pago passa a cobrar o valor do Escritório", { d, putEva });
det = await (await admin("GET", "/api/admin/contas/" + idEva, como())).json();
checar(det.plano.id === "advogado" && det.plano_proximo && det.plano_proximo.id === "escritorio", "o ciclo de agora fica no Advogado; o Escritório vale na renovação",
  { plano: det.plano && det.plano.id, prox: det.plano_proximo });
r = await pedir("conta.plano", { id: idEva, plano: "nao-existe" });
checar(r.status === 400, "plano que não existe: recusado");
const idFabi = await novaConta("fabi");
await contaDo(idFabi, "anual_pago", { pagamento: "PAYANO1", plano: "advogado", valor: 3990, meses: 12 });
r = await pedir("conta.plano", { id: idFabi, plano: "escritorio" });
d = await r.json();
checar(r.status === 400 && d.erro.includes("pago de uma vez"), "no anual, a troca é na renovação: recusado com o porquê", d);
r = await pedir("conta.plano", { id: idEva, plano: "plus" }, "x", comoSuporte());
checar(r.status === 403, "o suporte não troca plano");
await mexerNaConta(idEva, (x) => { x.ajuste = { motivo: "o preço especial da volta", cobrancas: [99], valor_cheio: 449, atual: 99 }; });
r = await pedir("conta.plano", { id: idEva, plano: "advogado" });
d = await r.json();
checar(r.status === 400 && d.erro.includes("valor ajustado"), "com uma cobrança de valor ajustado em curso: recusado", d);
await mexerNaConta(idEva, (x) => { delete x.ajuste; });

const cadEva = { nome_escritorio: "Eva Advocacia", documento: "52998224725", telefone: "91988887777", oab: "PA 12345", termos: "2026-10-03", quando: "2026-10-01T12:00:00.000Z",
  endereco: { cep: "66010000", logradouro: "Rua A", numero: "10", complemento: "", bairro: "Centro", cidade: "Belém", uf: "PA", cmun: "1501402" } };
await contaDo(idEva, "cadastro", { cadastro: cadEva });
det = await (await admin("GET", "/api/admin/contas/" + idEva, como())).json();
checar(det.cadastro.cep === "66010000" && det.cadastro.cidade === "Belém" && det.cadastro.logradouro === "Rua A" && det.cadastro.cmun === "1501402" && det.cadastro.documento === "52998224725",
  "a ficha traz o endereço do cadastro achatado (CEP, rua, cidade...), como o Editar cadastro lê", det.cadastro);
r = await pedir("conta.cadastro", { id: idEva, documento: "123" });
d = await r.json();
checar(r.status === 400 && d.erro.includes("CPF ou CNPJ"), "cadastro com CPF que não confere: recusado na fila", d);
r = await pedir("conta.cadastro", { id: idEva, telefone: "(91) 3222-1111", cidade: "Ananindeua" }, "Editei o cadastro da Eva (2 campos)", comoSuporte());
checar(r.status === 200, "o suporte também edita cadastro (pela fila dele)");
d = await (await admin("POST", "/api/admin/publicar", comoSuporte({ corpo: { confirmacao: "comitar e pushar" } }))).json();
const pubCadastro = d.publicacao;
const cadDepois = (await contaDo(idEva, "admin_detalhe")).cadastro;
checar(d.ok && cadDepois.telefone === "9132221111" && cadDepois.endereco.cidade === "Ananindeua" && cadDepois.endereco.cmun === "1500800" && cadDepois.endereco.logradouro === "Rua A"
  && cadDepois.termos === "2026-10-03" && cadDepois.quando === "2026-10-01T12:00:00.000Z" && cadDepois.ajustado.por === "suporte@paulus.ia.br",
  "publicado: telefone e cidade novos com o código IBGE da cidade; o aceite dos termos continua o da pessoa", cadDepois);

const idGil = await novaConta("gil");
await contaDo(idGil, "assinatura", { plano: "advogado", assinatura: { id: "preGil", situacao: "authorized", valor: 449 } });
r = await pedir("conta.pausar", { id: idFabi });
d = await r.json();
checar(r.status === 400 && d.erro.includes("não há o que pausar"), "o pago de uma vez não pausa, e a resposta diz por quê", d);
antesMP2 = mp.length;
await pedir("conta.pausar", { id: idGil }, "Pausei a cobrança do Gil");
d = await publicarFila();
checar(d.ok && mp.slice(antesMP2).some((x) => x.caminho === "/preapproval/preGil" && x.corpo.status === "paused") && (await contaDo(idGil, "resumo")).assinatura.situacao === "paused",
  "pausar: PUT status paused no Mercado Pago, e a conta fica pausada", d);
r = await pedir("conta.pausar", { id: idGil });
d = await r.json();
checar(r.status === 400 && d.erro.includes("só a assinatura ativa pausa"), "pausar de novo: recusado", d);
antesMP2 = mp.length;
await pedir("conta.pausar", { id: idGil, retomar: true }, "Retomei a cobrança do Gil");
d = await publicarFila();
checar(d.ok && mp.slice(antesMP2).some((x) => x.caminho === "/preapproval/preGil" && x.corpo.status === "authorized") && (await contaDo(idGil, "resumo")).assinatura.situacao === "authorized",
  "retomar: PUT status authorized", d);
await pedir("conta.pausar", { id: idGil }, "Pausei a cobrança do Gil de novo");
d = await publicarFila();
const pubPausa = d.publicacao;

// ---------------------------------------------- o registro de enderecos
console.log("registro de endereços");
const escritorios = new Map();
const metadados = new Map();
const ESCRITORIOS = {
  get: async (k) => (escritorios.has(k) ? escritorios.get(k) : null),
  put: async (k, v, o = {}) => { escritorios.set(k, v); if (o.metadata) metadados.set(k, o.metadata); },
  delete: async (k) => { escritorios.delete(k); metadados.delete(k); },
  list: async ({ prefix }) => ({ list_complete: true, keys: [...escritorios.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name, metadata: metadados.get(name) })) }),
};
const envT = { ...env, ESCRITORIOS, TUNEL_ATIVO: "1", CF_API_TOKEN: "cf-tuneis", CF_ACCOUNT_ID: "conta1", CF_ZONE_ID: "zona1" };
const umMinuto = () => { relogio += 60 * 1000; };
await provisionar(envT, "moura", { nome: "Moura Advocacia", porta: 47123, instalacao_id: "inst-moura-0001", dono: { sub: "111", email: "titular@moura.adv.br" } }, () => relogio);
umMinuto();
for (const [tipo, dados] of [["tunel.endereco", { slug: "moura", novo: "moura-adv" }], ["tunel.ativo", { slug: "moura-adv", ativo: false }], ["tunel.ativo", { slug: "moura-adv", ativo: true }], ["tunel.apagar", { slug: "moura-adv" }]]) {
  r = await pedir(tipo, dados, tipo, { envUsado: envT });
  d = await publicarFila({ envUsado: envT });
  if (!d.ok) checar(false, "publicar " + tipo, d);
  umMinuto();
}
const silva = await provisionar(envT, "silva", { nome: "Silva", porta: 47124, instalacao_id: "inst-silva-0001", dono: { sub: "222", email: "titular@silva.adv.br" } }, () => relogio);
umMinuto();
const pedidoRemover = new Request("https://paulus.ia.br/api/tunel/remover", { method: "POST", headers: { authorization: "Bearer " + silva.entrega.segredo_instalacao } });
r = await atenderTunel(pedidoRemover, envT, new URL(pedidoRemover.url), { agora: () => relogio });
checar(r.status === 200, "o escritório remove o próprio endereço");
umMinuto();
await provisionar(envT, "retomado", { nome: "Retomado", porta: 47125, instalacao_id: "inst-reto-0001", dono: { sub: "333", email: "titular@retomado.adv.br" }, retomar: true }, () => relogio);
umMinuto();
const oitoDiasAtras = relogio - 8 * DIA;
await provisionar(envT, "parado", { nome: "Parado", porta: 47126, instalacao_id: "inst-parado-01", dono: null }, () => oitoDiasAtras);
const limpeza = await limparEscritorios(envT, () => relogio);
checar(limpeza.removidos.length === 1 && limpeza.removidos[0].slug === "parado", "a limpeza diária libera o que nunca conectou", limpeza);
r = await admin("GET", "/api/admin/tuneis", como({ envUsado: envT }));
d = await r.json();
const reg = d.registro || [];
const ev = (slug, evento) => reg.find((x) => x.slug === slug && x.evento === evento) || {};
checar(reg.length === 10, "dez eventos no registro (cada mudança de endereço registra sozinha)", reg);
checar(reg[0].evento === "liberado" && reg[0].slug === "parado" && reg[0].quem === "limpeza automática" && reg[0].motivo === "nunca conectou em 7 dias" && reg[0].estado === "livre",
  "do mais novo ao mais velho: a limpeza automática liberou parado", reg[0]);
checar(ev("moura", "criado").quem === "titular@moura.adv.br" && ev("moura", "criado").estado === "ativo", "criado: quem conectou (o dono do endereço)", ev("moura", "criado"));
checar(ev("moura-adv", "alterado").de === "moura" && ev("moura-adv", "alterado").quem === "dono@paulus.ia.br" && ev("moura-adv", "alterado").estado === "ativo",
  "alterado: o endereço novo, o de antes e quem trocou pelo painel", ev("moura-adv", "alterado"));
checar(ev("moura-adv", "desativado").estado === "desativado" && ev("moura-adv", "reativado").estado === "ativo" && ev("moura-adv", "desativado").quem === "dono@paulus.ia.br",
  "desativado e reativado, com quem e o estado");
checar(ev("moura-adv", "liberado").quem === "dono@paulus.ia.br" && ev("moura-adv", "liberado").motivo === "apagado pelo painel" && ev("moura-adv", "liberado").estado === "livre",
  "liberado pelo painel", ev("moura-adv", "liberado"));
checar(ev("silva", "liberado").quem === "titular@silva.adv.br" && ev("silva", "liberado").motivo === "removido pelo escritório", "liberado pelo próprio escritório", ev("silva", "liberado"));
checar(String(ev("retomado", "criado").motivo).includes("retomado") && !ev("retomado", "liberado").evento, "a retomada é um criado só, com o motivo", ev("retomado", "criado"));
checar(ev("parado", "criado").quem === "o escritório" && ev("parado", "criado").quando === new Date(oitoDiasAtras).toISOString(), "sem dono: \"o escritório\"; o criado fica com a hora em que nasceu");
checar([...metadados.keys()].filter((k) => k.startsWith("evento:")).length === 10 && reg.every((x) => !JSON.stringify(x).includes("segredo")),
  "cada evento é uma chave com os metadados (a lista lê sem um get por evento), sem segredo nenhum");

// ---------------------------------------------- a mensagem da nao renovacao
console.log("mensagem na não renovação");
emails.length = 0;
r = await admin("POST", "/api/admin/renovacoes/" + idBruno + "/mensagem", como({ corpo: { texto: "Oi, Bruno. Vi que o cartão recusou: quer ajuda?" } }));
d = await r.json();
const msgBruno = emails[0];
checar(r.status === 200 && msgBruno && msgBruno.to[0] === "bruno@escritorio.com.br" && msgBruno.from === "Matheus (PAVLVS) <naoresponda@paulus.ia.br>" && msgBruno.text.includes("quer ajuda?")
  && msgBruno.text.includes("Equipe PAVLVS") && msgBruno.reply_to === "contato@paulus.ia.br", "a mensagem vai para a conta, com o nome de quem escreveu", msgBruno);
const itemBruno = [...d.abertas, ...d.tratadas].find((x) => x.id === idBruno);
checar(itemBruno && itemBruno.mensagem_em && !guardados.get("admin:renov:" + idBruno).includes("quer ajuda"), "fica anotada na renovação (quando e quem; o texto não fica guardado)", itemBruno);
r = await admin("POST", "/api/admin/renovacoes/" + idBruno + "/mensagem", como({ corpo: { texto: "   " } }));
checar(r.status === 400, "mensagem vazia: recusada");
r = await admin("POST", "/api/admin/renovacoes/" + idBruno + "/mensagem", { ...como(), envUsado: { ...env, RESEND_API_KEY: "" }, corpo: { texto: "Oi" } });
checar(r.status === 503 && (await r.json()).erro.includes("RESEND_API_KEY"), "sem o provedor de e-mail: 503 dizendo o que falta");
r = await admin("POST", "/api/admin/renovacoes/" + "0".repeat(24) + "/mensagem", como({ corpo: { texto: "Oi" } }));
checar(r.status === 404, "conta sem ciclo vencido: 404");

// ---------------------------------------------- tokens: por modelo e outro periodo
console.log("tokens: por modelo e outro período");
relogio = Math.max(relogio, Date.parse("2026-11-12T18:00:00Z"));
const LLAMA = "meta-llama/Llama-3.3-70B-Instruct";
const SONNET = "claude-sonnet-5-5";
const MISTRAL = "mistral-large-latest";
const idTok = await novaConta("toka");
await mexerNaConta(idTok, (x) => {
  x.uso = [
    { dia: "2026-10-20", tokens: 5000, entrada: 3000, saida: 2000, modelos: { [MISTRAL]: { entrada: 3000, saida: 2000 } } },
    { dia: "2026-11-10", tokens: 1500, entrada: 1000, saida: 500, modelos: { [LLAMA]: { entrada: 1000, saida: 500 } } },
    { dia: "2026-11-11", tokens: 3000, entrada: 2000, saida: 1000, modelos: { [SONNET]: { entrada: 2000, saida: 1000 } } },
  ];
  // Outubro inteiro tem mais que o dia 20: os dias de antes ja nao estao guardados.
  x.uso_mes = { "2026-10": { entrada: 8000, saida: 3000, modelos: { [MISTRAL]: { entrada: 8000, saida: 3000 } } },
    "2026-11": { entrada: 3000, saida: 1500, modelos: { [LLAMA]: { entrada: 1000, saida: 500 }, [SONNET]: { entrada: 2000, saida: 1000 } } } };
  x.pagamentos = [{ tipo: "assinatura", ref: "TOK1", valor: 300, quando: "2026-11-05T15:00:00.000Z" }];
});
const tok = async (q) => { const x = await admin("GET", "/api/admin/tokens?" + q, como()); return { status: x.status, d: await x.json() }; };
const daToka = (t) => (t.d.linhas || []).find((l) => l.nome.startsWith("Escritório toka")) || {};
let t1 = await tok("visao=conta&periodo=mes");
checar(t1.status === 200 && daToka(t1).entrada === 3000 && daToka(t1).saida === 1500 && !t1.d.incompleto && t1.d.periodo.de === "2026-11-01" && t1.d.periodo.ate === "2026-11-12",
  "este mês: o mês inteiro do medidor", { linha: daToka(t1), p: t1.d.periodo });
t1 = await tok("visao=conta&periodo=30");
checar(daToka(t1).entrada === 6000 && daToka(t1).saida === 3500 && t1.d.incompleto && t1.d.desde === "2026-10-20" && t1.d.aviso.includes("20/10/2026"),
  "30 dias: o pedaço de outubro pelos dias guardados, e a resposta diz que antes de 20/10 o medidor não guarda", { linha: daToka(t1), t: { inc: t1.d.incompleto, desde: t1.d.desde, aviso: t1.d.aviso } });
t1 = await tok("visao=conta&periodo=custom&de=2026-10-25&ate=2026-11-10");
checar(t1.status === 200 && daToka(t1).entrada === 1000 && daToka(t1).saida === 500 && !t1.d.incompleto && t1.d.periodo.de === "2026-10-25" && t1.d.periodo.ate === "2026-11-10",
  "outro período (de a ate): só os dias dele, sem faltar nada", { linha: daToka(t1), p: t1.d.periodo, inc: t1.d.incompleto });
t1 = await tok("visao=conta&periodo=90");
checar(t1.d.periodo.de === "2026-08-15" && daToka(t1).receita === 300, "90 dias: de 15/08 a hoje, com o arrecadado", t1.d.periodo);
for (const q of ["periodo=custom&de=2026-11-10&ate=2026-10-25", "periodo=custom&de=2026-02-30&ate=2026-03-01", "periodo=custom", "periodo=semana", "visao=cliente"]) {
  t1 = await tok(q);
  if (t1.status !== 400) checar(false, "período ou visão inválidos: 400 (" + q + ")", t1);
}
checar(true, "período ao contrário, dia que não existe, sem as datas e visão desconhecida: 400");
t1 = await tok("visao=modelo&periodo=mes");
const lSonnet = t1.d.linhas.find((l) => l.modelo === SONNET) || {};
const lLlama = t1.d.linhas.find((l) => l.modelo === LLAMA) || {};
checar(lSonnet.nome === "Claude Sonnet 5.5" && lSonnet.fabricante === "Anthropic" && lSonnet.planos.includes("Escritório Plus") && lSonnet.sub.includes("Anthropic")
  && lSonnet.preco[0] === 2 && lSonnet.preco[1] === 10 && lSonnet.entrada === 2000 && lSonnet.saida === 1000 && Math.abs(lSonnet.receita - 200) < 1e-9
  && Math.abs(lSonnet.custo_usd - ((2000 / 1e6) * 2 + (1000 / 1e6) * 10)) < 1e-12,
  "por modelo: fabricante, planos, preço por milhão, uso, custo e o arrecadado da conta dividido pelo uso de cada modelo", lSonnet);
checar(lLlama.fabricante === "Meta" && lLlama.planos.includes("Advogado") && lLlama.receita >= 100 && !t1.d.linhas.some((l) => l.modelo === MISTRAL),
  "o Llama com o que a Toka pagou pelo uso dele (e o das contas do Advogado sem uso no mês); o Mistral não usou no mês", lLlama);
checar(Math.abs(t1.d.linhas.reduce((s, l) => s + l.receita, 0) - t1.d.kpis.receita) < 1e-6, "a soma do arrecadado por modelo é o arrecadado do período");
t1 = await tok("visao=modelo&periodo=custom&de=2026-10-01&ate=2026-10-31");
const lMistral = t1.d.linhas.find((l) => l.modelo === MISTRAL) || {};
checar(lMistral.entrada === 8000 && lMistral.saida === 3000 && lMistral.planos.includes("Escritório") && !t1.d.incompleto, "outubro inteiro sai do total do mês (nada falta)", lMistral);

// ---------------------------------------------- campanha agendada
console.log("campanha agendada");
await limparFila();
emails.length = 0;
r = await pedir("campanha.disparar", { nome: "Novidade", publico: "todos", assunto: "Oi", texto: "Novidade no Paulus", quando: "agendado", de: "2026-11-20" });
checar(r.status === 400 && (await r.json()).erro.includes("hora"), "agendada sem a hora: recusada");
r = await pedir("campanha.disparar", { nome: "Novidade", publico: "todos", assunto: "Oi", texto: "Novidade", quando: "agendado", de: "2026-11-01", hora: "10:00" });
checar(r.status === 400 && (await r.json()).erro.includes("já passou"), "agendada para trás: recusada");
r = await pedir("campanha.disparar", { nome: "Novidade", publico: "escolhidas", contas: [], assunto: "Oi", texto: "Novidade", quando: "agora" });
checar(r.status === 400, "escolher contas sem nenhuma conta: recusada");
r = await pedir("campanha.disparar", { nome: "Novidade", publico: "escolhidas", contas: [idAna, idEva], assunto: "Oi, {nome}", texto: "Novidade", quando: "agendado", de: "2026-11-20", hora: "14:30" },
  "Pedi o disparo \"Novidade\" para 2 contas (20/11 às 14:30)");
checar(r.status === 200, "agendada para 20/11 às 14:30 (Brasília), para duas contas escolhidas");
d = await publicarFila();
let camps = (await (await admin("GET", "/api/admin/campanhas", como())).json()).campanhas;
const novidade = camps.find((x) => x.nome === "Novidade") || {};
checar(d.ok && novidade.situacao === "agendada" && novidade.quando === "2026-11-20T17:30:00.000Z" && novidade.publico.id === "escolhidas" && novidade.publico.label === "2 contas escolhidas",
  "fica guardada para 17:30 UTC (14:30 em Brasília), e a tela vê a hora", novidade);
let envio = await enviarCampanhas(env, Date.parse("2026-11-20T17:29:00Z"));
checar(envio.enviados === 0 && emails.length === 0, "o Cron de um minuto antes não manda nada", envio);
envio = await enviarCampanhas(env, Date.parse("2026-11-20T17:30:00Z"));
checar(envio.enviados === 2 && emails.map((e) => e.to[0]).sort().join() === "ana@escritorio.com.br,eva@escritorio.com.br" && emails.some((e) => e.subject === "Oi, Eva"),
  "na hora marcada, o Cron manda para as duas escolhidas", emails.map((e) => e.to[0] + " · " + e.subject));
const daqui = new Date(relogio + 3 * 60 * 1000 - 3 * 3600 * 1000).toISOString();
r = await pedir("campanha.disparar", { nome: "Atrasada", publico: "todos", assunto: "x", texto: "y", quando: "agendado", de: daqui.slice(0, 10), hora: daqui.slice(11, 16) });
checar(r.status === 200, "agendada para daqui a três minutos");
relogio += 10 * 60 * 1000;
d = await publicarFila();
checar(!d.ok && d.resultados[0].erro.includes("passou antes de publicar"), "publicada depois da hora: não sai atrasada sozinha, volta para a fila com o porquê", d);
await limparFila();

// ---------------------------------------------- equipe: convite, Access e reenviar
console.log("equipe: convite, Access e reenviar");
let eq = await (await admin("GET", "/api/admin/equipe", como())).json();
checar(eq.liberacao && eq.liberacao.ligado === false && eq.liberacao.falta.includes("CF_ACCESS_TOKEN") && eq.matriz.some((x) => x.acao.startsWith("Convidar")),
  "sem a API do Access, a equipe diz que a liberação é à mão", eq.liberacao);
d = await (await admin("GET", "/api/admin/sessao", como())).json();
checar(d.config.equipe && d.config.equipe.ligado === false, "a sessão também diz (config.equipe)");
emails.length = 0;
r = await pedir("equipe.membro", { acao: "criar", nome: "Bia Souza", email: "Bia@paulus.ia.br", papel: "financeiro" }, "Convidei a Bia");
checar(r.status === 200, "convidar entra na fila");
r = await pedir("equipe.membro", { acao: "criar", nome: "Ana", email: "suporte@paulus.ia.br", papel: "suporte" });
checar(r.status === 400, "convidar quem já está na equipe: recusado");
r = await pedir("equipe.membro", { acao: "criar", nome: "Xavier", email: "x@paulus.ia.br", papel: "dono" }, "x", comoSuporte());
checar(r.status === 403, "o suporte não convida");
r = await admin("POST", "/api/admin/alteracoes", { ...como(), envUsado: { ...env, RESEND_API_KEY: "" }, corpo: { tipo: "equipe.membro", dados: { acao: "criar", nome: "Zé", email: "ze@paulus.ia.br", papel: "suporte" } } });
checar(r.status === 400 && (await r.json()).erro.includes("RESEND_API_KEY"), "sem o e-mail ligado, o convite nem entra na fila");
d = await publicarFila();
const conviteBia = emails.find((e) => e.to[0] === "bia@paulus.ia.br");
const tokenBia = ((conviteBia && conviteBia.html.match(/convite\?t=([0-9a-f]{64})/)) || [])[1];
checar(d.ok && conviteBia && tokenBia && conviteBia.text.includes("Financeiro") && conviteBia.text.includes("à mão") && conviteBia.subject === "Convite para o painel do Paulus",
  "o convite vai por e-mail, com o link e o papel, e diz que o Access ainda é à mão", conviteBia && conviteBia.text);
const kvConvites = JSON.parse(guardados.get("admin:convites"));
checar(!guardados.get("admin:convites").includes(tokenBia) && kvConvites[0].nome === "Bia Souza" && kvConvites[0].email === "bia@paulus.ia.br"
  && Object.keys(kvConvites[0]).sort().join() === "criado,email,h,nome,papel,por,por_nome,vence", "o KV guarda o resumo do link, nunca o link; e só nome, e-mail e papel da pessoa", kvConvites[0]);
eq = await (await admin("GET", "/api/admin/equipe", como())).json();
const mBia = eq.membros.find((x) => x.email === "bia@paulus.ia.br") || {};
checar(mBia.convite && mBia.convite.vence === new Date(relogio + 7 * DIA).toISOString() && mBia.papel === "financeiro" && !mBia.convite.vencido, "a equipe mostra o convite e quando vence (7 dias)", mBia);
const convite = (metodo, token, envUsado = env) => {
  const req = metodo === "GET" ? new Request("https://paulus.ia.br/api/equipe/convite?t=" + token)
    : new Request("https://paulus.ia.br/api/equipe/convite", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "t=" + token });
  return atenderAdmin(req, envUsado, new URL(req.url), { waitUntil() {} }, deps);
};
checar(ehRotaDoAdmin(new URL("https://paulus.ia.br/api/equipe/convite")), "o convite é rota do painel, fora do /api/admin (e do Access)");
r = await convite("GET", tokenBia);
let pagina = await r.text();
checar(r.status === 200 && pagina.includes("Bia Souza") && pagina.includes("Aceitar o convite") && pagina.includes("feita à mão") && !pagina.includes("PAULUS")
  && r.headers.get("content-security-policy").includes("form-action 'self'") && r.headers.get("referrer-policy") === "no-referrer",
  "o link abre a página do convite sem o Access, e não promete a liberação automática");
checar(!guardados.get("admin:equipe") || !guardados.get("admin:equipe").includes("bia@"), "abrir o link não aceita sozinho (quem lê links no e-mail não aceita pela pessoa)");
r = await convite("GET", "f".repeat(64));
checar(r.status === 410, "link que não existe: 410");
r = await convite("POST", tokenBia);
pagina = await r.text();
checar(r.status === 200 && pagina.includes("Pronto, Bia.") && pagina.includes("à mão") && !pagina.includes("Abrir o painel"), "aceito: a página diz o passo que ainda é à mão (e não oferece o painel)");
checar(JSON.parse(guardados.get("admin:equipe")).some((x) => x.email === "bia@paulus.ia.br" && x.papel === "financeiro") && !guardados.has("admin:convites"), "a Bia está na equipe e o convite saiu");
r = await convite("POST", tokenBia);
checar(r.status === 410, "o link não vale duas vezes");
d = await (await admin("GET", "/api/admin/sessao", { email: "bia@paulus.ia.br" })).json();
checar(d.access.ok && d.papel === "financeiro", "com o Access dela, o painel a reconhece como financeiro", d.access);

emails.length = 0;
await pedir("equipe.membro", { acao: "criar", nome: "Caio", email: "caio@paulus.ia.br", papel: "suporte" }, "Convidei o Caio");
d = await publicarFila();
const tokenCaio1 = emails[0].html.match(/convite\?t=([0-9a-f]{64})/)[1];
relogio += 2 * DIA;
r = await admin("POST", "/api/admin/equipe/convite/" + encodeURIComponent("caio@paulus.ia.br") + "/reenviar", comoSuporte());
checar(r.status === 403, "o suporte não reenvia convite");
r = await admin("POST", "/api/admin/equipe/convite/" + encodeURIComponent("caio@paulus.ia.br") + "/reenviar", como());
d = await r.json();
const tokenCaio2 = emails[emails.length - 1].html.match(/convite\?t=([0-9a-f]{64})/)[1];
const mCaio = d.membros.find((x) => x.email === "caio@paulus.ia.br") || {};
checar(r.status === 200 && tokenCaio2 !== tokenCaio1 && mCaio.convite.vence === new Date(relogio + 7 * DIA).toISOString(), "reenviar: link novo, mais 7 dias", mCaio);
checar((await convite("GET", tokenCaio1)).status === 410 && (await convite("GET", tokenCaio2)).status === 200, "o link antigo para de valer; o novo abre");
r = await admin("POST", "/api/admin/equipe/convite/" + encodeURIComponent("ninguem@paulus.ia.br") + "/reenviar", como());
checar(r.status === 404, "reenviar sem convite: 404");
relogio += 8 * DIA;
r = await convite("GET", tokenCaio2);
checar(r.status === 410 && (await r.text()).includes("venceu"), "depois dos 7 dias, o convite venceu");
eq = await (await admin("GET", "/api/admin/equipe", como())).json();
checar((eq.membros.find((x) => x.email === "caio@paulus.ia.br") || {}).convite.vencido === true, "e a equipe mostra o convite vencido");
await pedir("equipe.membro", { acao: "cancelar_convite", email: "caio@paulus.ia.br" }, "Cancelei o convite do Caio");
d = await publicarFila();
checar(d.ok && !guardados.has("admin:convites"), "cancelar o convite tira o link");

r = await pedir("equipe.membro", { acao: "excluir", email: "dono@paulus.ia.br" });
checar(r.status === 400 && (await r.json()).erro.includes("pelo menos um dono"), "tirar o único dono: recusado");
r = await pedir("equipe.membro", { acao: "editar", de: "suporte@paulus.ia.br", email: "suporte@paulus.ia.br", nome: "Ana Lima", papel: "suporte" }, "Editei a Ana");
d = await publicarFila();
checar(d.ok && JSON.parse(guardados.get("admin:equipe")).find((x) => x.email === "suporte@paulus.ia.br").nome === "Ana Lima", "editar o nome, com o mesmo e-mail");
await pedir("equipe.membro", { acao: "excluir", email: "bia@paulus.ia.br" }, "Tirei a Bia");
d = await publicarFila();
checar(d.ok && !JSON.parse(guardados.get("admin:equipe")).some((x) => x.email === "bia@paulus.ia.br") && String(d.resultados[0].aviso).includes("Access")
  && String(d.resultados[0].aviso).includes("CF_ACCESS_TOKEN") && !/ACCESS_APP_ID|ACCESS_POLICY_ID/.test(String(d.resultados[0].aviso)),
  "tirar da equipe: sai da lista; sem a API, o aviso diz que o Access é à mão e só pede o token (a política é achada sozinha)", d.resultados);
checar((await admin("GET", "/api/admin/visao", { email: "bia@paulus.ia.br" })).status === 403, "e ela não passa mais do painel");

// So o token e a conta: a politica e a de permitir da aplicacao do ACCESS_AUD.
const envAcc = { ...env, CF_ACCESS_TOKEN: "cfat_teste", CF_ACCOUNT_ID: "conta1" };
cf.apps = [{ id: "app0", aud: "outra-aplicacao", policies: [{ id: "pol0", decision: "allow" }] },
  { id: "app1", aud: AUD, policies: [{ id: "pol9", decision: "deny" }, { id: "pol1", decision: "allow" }] }];
const POLITICA = "/accounts/conta1/access/policies/pol1";
const POLITICA_ANTIGA = "/accounts/conta1/access/apps/app1/policies/pol1";
const naPolitica = (email) => cf.politica.include.some((x) => x.email && x.email.email === email);
emails.length = 0;
cf.chamadas.length = 0;
await pedir("equipe.membro", { acao: "criar", nome: "Duda Lima", email: "duda@paulus.ia.br", papel: "suporte" }, "Convidei a Duda", { envUsado: envAcc });
d = await publicarFila({ envUsado: envAcc });
const tokenDuda = emails[0].html.match(/convite\?t=([0-9a-f]{64})/)[1];
checar(d.ok && emails[0].text.includes("é liberado no Cloudflare Access") && !emails[0].text.includes("à mão"), "com a API do Access, o convite diz que a liberação é sozinha");
cf.recusar = "/policies/";
r = await convite("POST", tokenDuda, envAcc);
pagina = await r.text();
checar(r.status === 502 && pagina.includes("Quase lá") && JSON.parse(guardados.get("admin:equipe")).some((x) => x.email === "duda@paulus.ia.br") && guardados.has("admin:convites"),
  "o Access recusou: ela entra na equipe e o link continua valendo para tentar de novo");
cf.recusar = "";
r = await convite("POST", tokenDuda, envAcc);
pagina = await r.text();
const putPol = cf.chamadas.filter((x) => x.metodo === "PUT" && x.caminho === POLITICA).pop();
checar(r.status === 200 && pagina.includes("Abrir o painel") && naPolitica("duda@paulus.ia.br") && naPolitica("dono@paulus.ia.br") && putPol && putPol.corpo.name === "Equipe do painel"
  && putPol.corpo.decision === "allow" && putPol.corpo.session_duration === "24h" && putPol.corpo.mfa_config.allowed_authenticators[0] === "totp" && !("precedence" in putPol.corpo)
  && putPol.auth === "Bearer cfat_teste" && !guardados.has("admin:convites"),
  "aceito: o e-mail entra na política reutilizável do painel (achada pela aplicação do ACCESS_AUD), que guarda o resto (nome, decisão, duração, MFA)", putPol);
checar(!cf.chamadas.some((x) => x.metodo === "PUT" && x.caminho.includes("/apps/")), "e nada vai pelo caminho da aplicação, que a Cloudflare recusa para a política reutilizável",
  cf.chamadas.map((x) => x.metodo + " " + x.caminho));
eq = await (await admin("GET", "/api/admin/equipe", como({ envUsado: envAcc }))).json();
checar(eq.liberacao.ligado === true, "e a equipe diz que a liberação está ligada");
emails.length = 0;
await pedir("equipe.membro", { acao: "editar", de: "duda@paulus.ia.br", email: "maria.eduarda@paulus.ia.br", nome: "Maria Eduarda", papel: "suporte" }, "Troquei o e-mail da Duda", { envUsado: envAcc });
d = await publicarFila({ envUsado: envAcc });
checar(d.ok && emails[0].to[0] === "maria.eduarda@paulus.ia.br" && !naPolitica("duda@paulus.ia.br") && !JSON.parse(guardados.get("admin:equipe")).some((x) => x.email === "duda@paulus.ia.br")
  && JSON.parse(guardados.get("admin:convites"))[0].email === "maria.eduarda@paulus.ia.br", "trocar o e-mail: o novo recebe convite, o antigo sai da equipe e do Access", d);
await pedir("equipe.membro", { acao: "cancelar_convite", email: "maria.eduarda@paulus.ia.br" }, "Cancelei", { envUsado: envAcc });
await publicarFila({ envUsado: envAcc });
cf.politica.include.push({ email: { email: "bia@paulus.ia.br" } });
guardados.set("admin:equipe", JSON.stringify([...JSON.parse(guardados.get("admin:equipe")), { email: "bia@paulus.ia.br", nome: "Bia Souza", papel: "financeiro" }]));
cf.chamadas.length = 0;
await pedir("equipe.membro", { acao: "excluir", email: "bia@paulus.ia.br" }, "Tirei a Bia", { envUsado: envAcc });
d = await publicarFila({ envUsado: envAcc });
checar(d.ok && !d.resultados[0].aviso && !naPolitica("bia@paulus.ia.br") && cf.chamadas.some((x) => x.caminho === "/accounts/conta1/access/organizations/revoke_user" && x.corpo.email === "bia@paulus.ia.br"),
  "tirar da equipe com a API: sai da política do Access e as sessões dela no Access caem", cf.chamadas.map((x) => x.metodo + " " + x.caminho));

// Volta a Bia (a equipe e a politica) para tirar de novo em outro cenario.
const voltaBia = () => {
  cf.politica.include.push({ email: { email: "bia@paulus.ia.br" } });
  guardados.set("admin:equipe", JSON.stringify([...JSON.parse(guardados.get("admin:equipe")), { email: "bia@paulus.ia.br", nome: "Bia Souza", papel: "financeiro" }]));
  cf.chamadas.length = 0;
};
// A politica antiga, presa a aplicacao: o caminho da conta nao a conhece, e o da aplicacao muda (com a precedencia).
cf.reutilizavel = false;
cf.politica.precedence = 3;
voltaBia();
await pedir("equipe.membro", { acao: "excluir", email: "bia@paulus.ia.br" }, "Tirei a Bia", { envUsado: envAcc });
d = await publicarFila({ envUsado: envAcc });
const putAntiga = cf.chamadas.filter((x) => x.metodo === "PUT" && x.caminho === POLITICA_ANTIGA).pop();
checar(d.ok && !d.resultados[0].aviso && !naPolitica("bia@paulus.ia.br") && putAntiga && putAntiga.corpo.precedence === 3 && putAntiga.corpo.name === "Equipe do painel",
  "a política antiga, presa à aplicação: muda pelo caminho da aplicação, com a precedência dela", cf.chamadas.map((x) => x.metodo + " " + x.caminho));
cf.reutilizavel = true;
delete cf.politica.precedence;
// Duas politicas de permitir na aplicacao: o Worker nao escolhe sozinho; ACCESS_POLICY_ID escolhe.
cf.apps[1].policies.push({ id: "pol2", decision: "allow" });
voltaBia();
await pedir("equipe.membro", { acao: "excluir", email: "bia@paulus.ia.br" }, "Tirei a Bia", { envUsado: envAcc });
d = await publicarFila({ envUsado: envAcc });
checar(d.ok && String(d.resultados[0].aviso).includes("ACCESS_POLICY_ID") && naPolitica("bia@paulus.ia.br") && !cf.chamadas.some((x) => x.metodo === "PUT"),
  "duas políticas de permitir: não mexe em nenhuma, e o aviso pede o ACCESS_POLICY_ID", d.resultados);
cf.politica.include = cf.politica.include.filter((x) => !(x.email && x.email.email === "bia@paulus.ia.br"));
voltaBia();
await pedir("equipe.membro", { acao: "excluir", email: "bia@paulus.ia.br" }, "Tirei a Bia", { envUsado: { ...envAcc, ACCESS_POLICY_ID: "pol1" } });
d = await publicarFila({ envUsado: { ...envAcc, ACCESS_POLICY_ID: "pol1" } });
checar(d.ok && !d.resultados[0].aviso && !naPolitica("bia@paulus.ia.br") && cf.chamadas.some((x) => x.metodo === "PUT" && x.caminho === POLITICA),
  "com o ACCESS_POLICY_ID, muda a política escolhida", cf.chamadas.map((x) => x.metodo + " " + x.caminho));
cf.apps[1].policies.pop();

// ---------------------------------------------- o extrato com as NFS-e
console.log("extrato com as NFS-e");
const notasFalsas = [
  { id: 7, conta: idAna, pagamento: "ORD1", estado: "substituida", numero: "10", ambiente: "producao_restrita" },
  { id: 9, conta: idAna, pagamento: "ORD1", estado: "emitida", numero: "12", ambiente: "producao_restrita" },
  { id: 11, conta: idBruno, pagamento: "ORD1", estado: "emitida", numero: "13" },
];
const EMISSOR_NFSE = { idFromName: (n) => n, get: () => ({ fetch: async (url, init) => {
  const { acao, dados } = JSON.parse(init.body);
  if (acao === "listar") return Response.json({ notas: notasFalsas });
  if (acao === "nota") return Response.json({ nota: notasFalsas.find((x) => x.id === dados.id) || {} });
  if (acao === "xml") return Response.json({ xml: "<NFSe>12</NFSe>", nome: "NFS-e 12.xml" });
  return Response.json({ erro: "ação de mentira" }, { status: 400 });
} }) };
const envNf = { ...env, EMISSOR_NFSE, NFSE_CHAVE_MESTRA: "chave-de-teste" };
det = await (await admin("GET", "/api/admin/contas/" + idAna, como({ envUsado: envNf }))).json();
const pgOrd1 = (det.pagamentos || []).find((x) => x.ref === "ORD1") || {};
checar(pgOrd1.nfse && pgOrd1.nfse.id === 9 && pgOrd1.nfse.numero === "12" && pgOrd1.nfse.estado === "emitida"
  && pgOrd1.nfse.pdf === "https://paulus.ia.br/api/admin/nfse/emissor/notas/9/pdf?baixar=1" && pgOrd1.nfse.xml === "https://paulus.ia.br/api/admin/nfse/emissor/notas/9/xml",
  "cada pagamento traz a NFS-e (a substituta, não a substituída; a de outra conta não entra) e os links do painel", pgOrd1);
det = await (await admin("GET", "/api/admin/contas/" + idAna, como())).json();
checar(det.pagamentos.every((x) => x.nfse === null), "sem o emissor, o extrato não inventa nota");
guardados.set("admin:nfse-pdf:9", Buffer.from("%PDF-1.4 teste").toString("base64"));
r = await admin("GET", "/api/admin/nfse/emissor/notas/9/pdf?baixar=1", comoSuporte({ envUsado: envNf }));
checar(r.status === 200 && r.headers.get("content-type") === "application/pdf" && r.headers.get("content-disposition").startsWith("attachment") && (await r.text()).startsWith("%PDF"),
  "o link do PDF baixa pelo painel (o suporte também baixa)");
r = await admin("GET", "/api/admin/nfse/emissor/notas/9/xml", comoSuporte({ envUsado: envNf }));
checar(r.status === 200 && r.headers.get("content-type").startsWith("application/xml") && (await r.text()).includes("<NFSe>"), "e o do XML");
r = await admin("GET", "/api/admin/nfse/emissor/notas/9/xml", { semAccess: true, envUsado: envNf });
checar(r.status === 401, "sem o Cloudflare Access, os links não abrem");

// ---------------------------------------------- a oferta para voltar (sem cupom)
console.log("oferta para voltar (sem cupom)");
await limparFila();
r = await pedir("renov.oferta", { id: idBruno, tipo: "creditos", tokens: 50 });
checar(r.status === 400, "créditos de menos: recusado");
r = await pedir("renov.oferta", { id: idBruno, tipo: "creditos", tokens: 10e6 }, "x", comoSuporte());
checar(r.status === 403, "o suporte não faz oferta");
r = await pedir("renov.oferta", { id: idEva, tipo: "creditos", tokens: 10e6 });
checar(r.status === 400 && (await r.json()).erro.includes("Não renovações"), "conta fora de Não renovações: recusada");
r = await pedir("renov.oferta", { id: idBruno, tipo: "preco", valor: 2000, plano: "escritorio" });
checar(r.status === 400 && (await r.json()).erro.includes("valor do plano"), "preço especial acima do plano: recusado");
emails.length = 0;
await pedir("renov.oferta", { id: idBruno, tipo: "creditos", tokens: 10e6 }, "Ofereci 10M tokens para Bruno voltar (entram quando voltar a pagar)");
d = await publicarFila();
const ofCred = emails.find((e) => e.to[0] === "bruno@escritorio.com.br");
const resBruno = await contaDo(idBruno, "resumo");
checar(d.ok && ofCred && ofCred.subject.includes("Créditos extras") && ofCred.text.includes("10 milhões") && ofCred.text.includes("próximo pagamento confirmado") && !/cupom/i.test(ofCred.text + ofCred.html),
  "créditos: a pessoa recebe o e-mail, sem cupom: entram com o próximo pagamento", ofCred && ofCred.text);
checar(resBruno.oferta_volta && resBruno.oferta_volta.tipo === "creditos" && resBruno.oferta_volta.tokens === 10e6, "e a conta guarda a oferta (worker/ia.js, ofertaDeVolta)", resBruno.oferta_volta);
d = await (await admin("GET", "/api/admin/renovacoes", como())).json();
checar(([...d.abertas, ...d.tratadas].find((x) => x.id === idBruno) || {}).oferta.tipo === "creditos", "a não renovação mostra a oferta feita");
antesMP2 = mp.length;
emails.length = 0;
await pedir("renov.oferta", { id: idBruno, tipo: "preco", valor: 99, plano: "escritorio" }, "Ofereci a Bruno o próximo mês por R$ 99");
d = await publicarFila();
const ofPreco = emails.find((e) => e.to[0] === "bruno@escritorio.com.br") || {};
checar(d.ok && mp.slice(antesMP2).some((x) => x.caminho === "/preapproval/pre1" && x.corpo.auto_recurring.transaction_amount === 99) && String(ofPreco.subject).includes("preço especial")
  && String(ofPreco.text).includes("R$ 99") && String(ofPreco.text).includes("Depois dele, volta ao valor do plano"),
  "preço especial: a assinatura que ainda existe passa a cobrar o valor, e o e-mail conta", { d, texto: ofPreco.text });

// ---------------------------------------------- quem cancelou pela Minha conta
console.log("não renovações: quem cancelou pela Minha conta");
const idIvo = await novaConta("ivo");
await contaDo(idIvo, "assinatura", { plano: "advogado", assinatura: { id: "preIvo", situacao: "authorized", valor: 449 } });
await contaDo(idIvo, "assinatura", { assinatura: { id: "preIvo", situacao: "cancelled" } });
await contaDo(idIvo, "cancelamento", { motivo: "preco", texto: "ficou caro", por: "ivo@escritorio.com.br" });
const idJoe = await novaConta("joe");
await contaDo(idJoe, "assinatura", { plano: "advogado", assinatura: { id: "preJoe", situacao: "authorized", valor: 449 } });
await contaDo(idJoe, "assinatura", { assinatura: { id: "preJoe", situacao: "cancelled" } });
for (const id of [idIvo, idJoe]) await mexerNaConta(id, (x) => { x.ciclo.fim = new Date(relogio - 2 * DIA).toISOString(); });
d = await (await admin("GET", "/api/admin/renovacoes", como())).json();
const rIvo = d.abertas.find((x) => x.id === idIvo) || {};
checar(String(rIvo.motivo).startsWith("cancelou pela Minha conta: está caro para o escritório") && rIvo.motivo.includes("ficou caro") && rIvo.cancelamento.motivo === "preco"
  && rIvo.tolerancia_dias === 0 && rIvo.plano.id === "advogado", "quem cancelou pela Minha conta aparece, com o motivo e o plano", rIvo);
checar(!d.abertas.some((x) => x.id === idJoe), "a cancelada sem motivo (no Mercado Pago ou pelo painel) continua fora");

// ---------------------------------------------- retroagir
console.log("retroagir");
await limparFila();
guardados.set("admin:nfse:config", JSON.stringify({ auto: false, email: true, mail: false }));
await pedir("nfse.config", { auto: true, email: true, mail: true }, "Liguei tudo nas notas");
d = await publicarFila();
const pubNf = d.publicacao;
checar(d.ok && pubNf.id && pubNf.retroagivel && !("retrato" in pubNf) && guardados.has("admin:retrato:" + pubNf.id), "cada publicação guarda o retrato (fora da lista que a tela lê)", pubNf);
r = await retroagir({ publicacao: pubNf.id, confirmacao: "retroagi" });
checar(r.status === 400, "sem a palavra certa: 400");
r = await admin("POST", "/api/admin/retroagir", comoSuporte({ corpo: { publicacao: pubNf.id, confirmacao: "retroagir" } }));
checar(r.status === 403, "o suporte não retroage");
r = await retroagir({ commit: pubNf.commit });
d = await r.json();
checar(r.status === 200 && d.ok && d.commit.startsWith("kv-") && d.publicacao.revertida && JSON.parse(guardados.get("admin:nfse:config")).mail === false
  && JSON.parse(guardados.get("admin:nfse:config")).auto === false, "retroagir pelo commit (como a tela manda): os interruptores voltam ao que eram", d);
r = await retroagir({ commit: pubNf.commit });
checar(r.status === 409, "de novo: já foi retroagida");
d = await (await admin("GET", "/api/admin/alteracoes", como())).json();
checar(d.publicacoes.find((x) => x.id === pubNf.id).revertida.por === "matheus", "o histórico mostra a publicação retroagida");

await pedir("conta.creditar", { id: idAna, tokens: 1000 }, "Creditei 1.000 tokens à Ana");
await pedir("nfse.config", { auto: true, email: false, mail: false }, "Liguei o automático");
d = await publicarFila();
r = await retroagir({ publicacao: d.publicacao.id });
const naoVolta = await r.json();
checar(r.status === 409 && naoVolta.erro.includes("créditos já estão na conta") && JSON.parse(guardados.get("admin:nfse:config")).auto === true,
  "com uma alteração que não volta, nada volta (tudo ou nada), e a resposta diz qual e por quê", naoVolta);

const idHana = await novaConta("hana");
await contaDo(idHana, "assinatura", { plano: "advogado", assinatura: { id: "preHana", situacao: "authorized", valor: 449 } });
const planosAntesA = guardados.get("admin:planos");
await pedir("plano.editar", { id: "advogado", valor: 459, valor_anual: 4090, tokens: 30 }, "Advogado a R$ 459");
const pA = (await publicarFila()).publicacao;
await pedir("plano.editar", { id: "advogado", valor: 469, valor_anual: 4190, tokens: 30 }, "Advogado a R$ 469");
const pB = (await publicarFila()).publicacao;
checar(mp.some((x) => x.caminho === "/preapproval/preHana" && x.corpo.auto_recurring && x.corpo.auto_recurring.transaction_amount === 469)
  && !mp.some((x) => x.caminho === "/preapproval/preEva" && x.corpo.auto_recurring && [459, 469].includes(x.corpo.auto_recurring.transaction_amount)),
  "o valor novo do plano vai para quem o Advogado cobra na renovação (a Eva, que troca para o Escritório, fica de fora)");
r = await retroagir({ publicacao: pA.id });
checar(r.status === 409 && (await r.json()).erro.includes("mudaram depois"), "retroagir a mais velha com uma mais nova por cima: recusado");
antesMP2 = mp.length;
r = await retroagir({ publicacao: pB.id });
checar(r.status === 200 && JSON.parse(guardados.get("admin:planos")).find((p) => p.id === "advogado").valor === 459
  && mp.slice(antesMP2).some((x) => x.caminho === "/preapproval/preHana" && x.corpo.auto_recurring.transaction_amount === 459), "a mais nova volta primeiro, e quem assina volta a pagar o valor de antes");
r = await retroagir({ publicacao: pA.id });
checar(r.status === 200 && guardados.get("admin:planos") === planosAntesA, "depois, a mais velha: os planos ficam como eram antes das duas");

antesMP2 = mp.length;
r = await retroagir({ publicacao: pubPausa.id });
checar(r.status === 200 && mp.slice(antesMP2).some((x) => x.caminho === "/preapproval/preGil" && x.corpo.status === "authorized") && (await contaDo(idGil, "resumo")).assinatura.situacao === "authorized",
  "a pausa volta: a assinatura é retomada no Mercado Pago", await r.clone().json());
r = await admin("POST", "/api/admin/retroagir", comoSuporte({ corpo: { publicacao: pubCadastro.id, confirmacao: "retroagir" } }));
checar(r.status === 403, "nem a publicação do próprio suporte: só o dono retroage");
r = await retroagir({ publicacao: pubCadastro.id });
const cadVolta = (await contaDo(idEva, "admin_detalhe")).cadastro;
checar(r.status === 200 && cadVolta.telefone === "91988887777" && cadVolta.endereco.cidade === "Belém" && !cadVolta.ajustado, "o cadastro editado volta ao que era", cadVolta);

const daqui2 = new Date(relogio + 2 * DIA - 3 * 3600 * 1000).toISOString();
await pedir("campanha.disparar", { nome: "Volta", publico: "todos", assunto: "x", texto: "y", quando: "agendado", de: daqui2.slice(0, 10), hora: daqui2.slice(11, 16) }, "Agendei Volta");
const pCamp = (await publicarFila()).publicacao;
const idVolta = (await (await admin("GET", "/api/admin/campanhas", como())).json()).campanhas.find((x) => x.nome === "Volta").id;
r = await retroagir({ publicacao: pCamp.id });
const volta = JSON.parse(guardados.get("admin:campanha:" + idVolta));
checar(r.status === 200 && volta.situacao === "cancelada" && !JSON.parse(guardados.get("admin:campanhas:fila")).includes(idVolta) && volta.destinatarios.every((x) => !x.email),
  "a campanha agendada que ainda não saiu é cancelada", volta.situacao);

const pubs0 = JSON.parse(guardados.get("admin:publicacoes"));
pubs0.push({ quando: "2026-10-01T12:00:00.000Z", commit: "kv-0a1b2", resumo: "Antiga", n: 1, por: "matheus" });
pubs0.push({ quando: "2026-09-30T12:00:00.000Z", commit: "abc1234", resumo: "Publiquei a peça", n: 2, por: "matheus" });
guardados.set("admin:publicacoes", JSON.stringify(pubs0));
r = await retroagir({ commit: "kv-0a1b2" });
checar(r.status === 409 && (await r.json()).erro.includes("antes do retrato"), "publicação de antes do retrato: não dá para retroagir, e a resposta diz");
ghReversao.conflito = true;
r = await retroagir({ commit: "abc1234" });
checar(r.status === 502 && (await r.json()).erro.includes("mudou depois"), "commit cujo arquivo mudou depois na main: não reverte");
ghReversao.conflito = false;
ghReversao.chamadas.length = 0;
r = await retroagir({ commit: "abc1234" });
d = await r.json();
const arvore = ghReversao.chamadas.find((x) => x.metodo === "POST" && x.url === GH + "/git/trees") || {};
const commitNovo = ghReversao.chamadas.find((x) => x.metodo === "POST" && x.url === GH + "/git/commits") || {};
const mover = ghReversao.chamadas.find((x) => x.metodo === "PATCH") || {};
checar(r.status === 200 && d.commit === "reverte" && arvore.corpo.base_tree === "arvore000" && arvore.corpo.tree.find((x) => x.path === "site/materiais/peca.md").sha === null
  && arvore.corpo.tree.find((x) => x.path === "site/dados/materiais.json").sha === "blobJson1" && commitNovo.corpo.parents[0] === "cabeca000" && commitNovo.corpo.tree === "arvore001"
  && mover.corpo.sha.startsWith("reverte") && mover.corpo.force === false && arvore.token === "gho_x",
  "commit no GitHub: um commit de reversão na main (o arquivo criado sai, o mudado volta), com o token de quem está logado", { d, arvore: arvore.corpo, commitNovo: commitNovo.corpo });
r = await retroagir({ publicacao: "naoexiste" });
checar(r.status === 404, "publicação que não está no histórico: 404");

// ================================================ etapa 6, segunda volta: o que a tela ainda pedia
// ---------------------------------------------- planos: os textos da pagina, o .JSON e as versoes
console.log("planos: textos da página, .JSON e versões");
await limparFila();
let pl = await (await admin("GET", "/api/admin/planos", como())).json();
const plAdv = pl.planos.find((p) => p.id === "advogado") || {};
checar(plAdv.para === "Para quem advoga sozinho." && plAdv.heranca === null && plAdv.textos && !plAdv.textos.itens && plAdv.itens[0].titulo.startsWith("IA Llama")
  && plAdv.itens.some((x) => x.titulo === "Biblioteca jurídica"), "cada plano traz os textos da página (os padrão, montados com os números do plano)", plAdv.itens && plAdv.itens.slice(0, 2));
const plEsc = pl.planos.find((p) => p.id === "escritorio") || {};
checar(plAdv.textos_padrao && plAdv.textos_padrao.heranca === "" && plAdv.textos_padrao.para === "Para quem advoga sozinho."
  && plEsc.textos_padrao && plEsc.textos_padrao.heranca === "Tudo do plano Advogado, e mais",
  "e o padrão da frase e do texto antes dos itens (o que vale com o campo vazio)", [plAdv.textos_padrao, plEsc.textos_padrao]);
checar(Array.isArray(pl.versoes) && pl.versoes.length >= 2 && pl.versoes[0].quem === "antes do histórico" && pl.versoes[0].resumo.includes("fábrica")
  && pl.versoes.every((v, i) => !i || v.n === pl.versoes[i - 1].n + 1) && pl.versoes[1].resumo === "Escritório a R$ 320",
  "o histórico: a versão de antes (os planos de fábrica) e uma por publicação, com quem e o resumo", pl.versoes.map((v) => [v.n, v.quem, v.resumo]));
// Como o worker/index.js: os planos do painel (o cache de 60 s do IA_PLANOS) no env de cada pedido.
const publico = async (caminho) => atenderAdmin(new Request("https://paulus.ia.br" + caminho), await comPlanosDoPainel(env), new URL("https://paulus.ia.br" + caminho), { waitUntil() {} }, deps);
checar(ehRotaDoAdmin(new URL("https://paulus.ia.br/api/planos/textos")), "os textos dos planos são rota do Worker, fora do /api/admin (e do Access)");
r = await publico("/api/planos/textos");
let txt = await r.json();
checar(r.status === 200 && /public, max-age=60/.test(r.headers.get("cache-control")) && JSON.stringify(txt.planos.find((p) => p.id === "advogado").itens) === JSON.stringify(plAdv.itens),
  "a página de assinatura lê os mesmos textos, sem o Access (60 s de cache)");
r = await atenderAdmin(new Request("https://paulus.ia.br/api/planos/textos", { method: "POST", body: "{}" }), env, new URL("https://paulus.ia.br/api/planos/textos"), {}, deps);
checar(r.status === 404, "só GET");
// A aba Edicao manda tudo: numeros, pessoas, recarga e os textos (aqui, os de agora).
const edicao = (extra) => ({ id: "advogado", nome: plAdv.nome, para: plAdv.para, heranca: null, valor: plAdv.valor, valor_anual: plAdv.valor_anual, tokens: plAdv.tokens,
  pessoas: plAdv.pessoas, recarga: plAdv.recarga, itens: plAdv.itens, ...extra });
r = await pedir("plano.editar", edicao({ pessoas: 0 }));
checar(r.status === 400 && (await r.json()).erro.includes("pessoas"), "pessoas fora de 1 a 500: recusado");
r = await pedir("plano.editar", edicao({ recarga: { valor: 60, tokens: 0 } }));
checar(r.status === 400 && (await r.json()).erro.includes("recarga"), "recarga sem créditos: recusada");
r = await pedir("plano.editar", edicao({ itens: [{ titulo: "", descricao: "x" }] }));
checar(r.status === 400 && (await r.json()).erro.includes("sem título"), "item sem título: recusado");
await pedir("plano.editar", edicao({ pessoas: 2, recarga: { valor: 60, tokens: 12e6 } }), "Advogado com 2 pessoas e recarga de R$ 60");
d = await publicarFila();
let advKV = JSON.parse(guardados.get("admin:planos")).find((p) => p.id === "advogado");
checar(d.ok && advKV.pessoas === 2 && advKV.recarga.valor === 60 && advKV.recarga.tokens === 12e6 && !("itens" in advKV) && !("para" in advKV) && !("heranca" in advKV),
  "pessoas e recarga entram no plano; os textos iguais aos padrão não são guardados (continuam acompanhando os números)", advKV);
pl = await (await admin("GET", "/api/admin/planos", como())).json();
const advDepois = pl.planos.find((p) => p.id === "advogado");
checar(advDepois.pessoas === 2 && advDepois.recarga.valor === 60 && advDepois.recarga.tokens === 12e6 && advDepois.textos.itens === false,
  "o painel lê o plano com as pessoas e a recarga novas, e os itens continuam os padrão", { pessoas: advDepois.pessoas, recarga: advDepois.recarga });
const itensProprios = [{ titulo: "IA para o dia a dia", descricao: "Perguntas, peças e prazos (em breve: mais)." }, { titulo: "Suporte por e-mail", descricao: "Em até um dia útil." }];
await pedir("plano.editar", edicao({ pessoas: 2, recarga: { valor: 60, tokens: 12e6 }, para: "Para quem trabalha sozinho.", heranca: "Comece por aqui", itens: itensProprios }), "Textos novos no Advogado");
d = await publicarFila();
advKV = JSON.parse(guardados.get("admin:planos")).find((p) => p.id === "advogado");
txt = await (await publico("/api/planos/textos")).json();
const txtAdv = txt.planos.find((p) => p.id === "advogado");
checar(d.ok && advKV.para === "Para quem trabalha sozinho." && advKV.heranca === "Comece por aqui" && advKV.itens.length === 2 && txtAdv.para === "Para quem trabalha sozinho."
  && txtAdv.heranca === "Comece por aqui" && JSON.stringify(txtAdv.itens) === JSON.stringify(itensProprios), "os textos próprios valem na página de assinatura", txtAdv);
pl = await (await admin("GET", "/api/admin/planos", como())).json();
checar(pl.planos.find((p) => p.id === "advogado").textos.itens === true, "e o painel diz que os itens são escritos no painel");
await pedir("plano.editar", edicao({ pessoas: 2, recarga: { valor: 60, tokens: 12e6 }, para: "", heranca: "", itens: [] }), "Textos do Advogado de volta ao padrão");
d = await publicarFila();
advKV = JSON.parse(guardados.get("admin:planos")).find((p) => p.id === "advogado");
txt = await (await publico("/api/planos/textos")).json();
checar(d.ok && !("itens" in advKV) && !("para" in advKV) && txt.planos.find((p) => p.id === "advogado").para === "Para quem advoga sozinho.", "vazio volta ao padrão");

const atuais = JSON.parse(pl.json);
const comMudanca = (f) => { const l = structuredClone(atuais); f(l); return l; };
for (const [lista, frase, descricao] of [
  [comMudanca((l) => l.splice(l.findIndex((p) => p.id === "escritorio"), 1)), "plano escritorio", "sem o plano padrão"],
  [comMudanca((l) => { l[0].preco = 10; }), "não é campo", "campo que não é de plano"],
  [comMudanca((l) => { l[0].modelos = { padrao: "gpt-9" }; }), "não está no catálogo", "modelo fora do catálogo"],
  [comMudanca((l) => { l[0].recursos = { teletransporte: true }; }), "não existe", "recurso que não existe"],
  [comMudanca((l) => { l[0].tokens = "30M"; }), "tokens", "tokens que não é número inteiro"],
  [comMudanca((l) => l.splice(l.findIndex((p) => p.id === "advogado"), 1)), "contas estão nele", "tirar um plano com contas"],
]) {
  r = await pedir("planos.json", { planos: lista });
  const e = await r.json();
  if (!(r.status === 400 && String(e.erro).includes(frase))) checar(false, "o .JSON recusa " + descricao, e);
}
checar(true, "o .JSON recusa: sem o plano padrão, campo de fora, modelo fora do catálogo, recurso que não existe, tokens que não é número e tirar um plano com contas (com o porquê)");
// O que a aba .JSON manda sem mexer (site/assets/admin.js, planosAtuais): os campos do plano como o GET devolve,
// com os textos que valem (os padrão inclusive) e heranca null. Entra, e os padrão não vão para o KV.
const CAMPOS_DA_ABA = ["id", "nome", "para", "valor", "valor_anual", "tokens", "pessoas", "modelos", "recarga", "recursos", "heranca", "itens"];
pl = await (await admin("GET", "/api/admin/planos", como())).json();
const comoAba = pl.planos.map((p) => Object.fromEntries(CAMPOS_DA_ABA.filter((k) => p[k] !== undefined).map((k) => [k, p[k]])));
r = await pedir("planos.json", { planos: comoAba }, "Atualizei o IA_PLANOS (como a aba manda)");
const rAba = await r.json();
d = await publicarFila();
const kvAba = JSON.parse(guardados.get("admin:planos"));
checar(r.status === 200 && d.ok && kvAba.every((p) => !("itens" in p) && !("para" in p) && !("heranca" in p)),
  "a lista como a aba .JSON manda (textos padrão, heranca null) entra, e os textos padrão não são guardados", rAba.erro || kvAba.map((p) => Object.keys(p)));
pl = await (await admin("GET", "/api/admin/planos", como())).json();
const idPlus = await novaConta("plusa");
await contaDo(idPlus, "assinatura", { plano: "plus", assinatura: { id: "prePlus", situacao: "authorized", valor: 3490 } });
const novaLista = comMudanca((l) => {
  l.find((p) => p.id === "plus").valor = 3590;
  l.push({ id: "socio", nome: "Sócio", valor: 990, valor_anual: 9900, tokens: 20000000, pessoas: 3, itens: [{ titulo: "Para dois sócios", descricao: "Com a IA do Escritório." }] });
});
const planosAntesJson = guardados.get("admin:planos");
pl = await (await admin("GET", "/api/admin/planos", como())).json();
const versoesAntes = pl.versoes.length;
antesMP2 = mp.length;
r = await pedir("planos.json", { planos: novaLista }, "Atualizei o IA_PLANOS (4 planos)");
checar(r.status === 200, "a lista inteira entra na fila");
d = await publicarFila();
const pubJson = d.publicacao;
const kvJson = JSON.parse(guardados.get("admin:planos"));
pl = await (await admin("GET", "/api/admin/planos", como())).json();
checar(d.ok && kvJson.length === 4 && kvJson.find((p) => p.id === "socio").itens.length === 1 && !("itens" in kvJson.find((p) => p.id === "plus"))
  && mp.slice(antesMP2).some((x) => x.caminho === "/preapproval/prePlus" && x.corpo.auto_recurring.transaction_amount === 3590),
  "publicado: o plano novo com os itens dele, os textos padrão não guardados, e quem assina o Plus passa a pagar o valor novo", kvJson.map((p) => p.id));
checar(pl.versoes.length === versoesAntes + 1 && pl.versoes[pl.versoes.length - 1].resumo === "Atualizei o IA_PLANOS (4 planos)" && pl.versoes[pl.versoes.length - 1].quem === "matheus"
  && pl.versoes[pl.versoes.length - 1].planos.length === 4, "e entra uma versão nova no histórico, com a lista guardada");
txt = await (await publico("/api/planos/textos")).json();
checar(JSON.stringify((txt.planos.find((p) => p.id === "socio") || {}).itens) === JSON.stringify([{ titulo: "Para dois sócios", descricao: "Com a IA do Escritório." }]),
  "o plano novo chega à página de assinatura com os itens dele");
antesMP2 = mp.length;
r = await retroagir({ publicacao: pubJson.id });
d = await r.json();
pl = await (await admin("GET", "/api/admin/planos", como())).json();
checar(r.status === 200 && guardados.get("admin:planos") === planosAntesJson && mp.slice(antesMP2).some((x) => x.caminho === "/preapproval/prePlus" && x.corpo.auto_recurring.transaction_amount === 3490)
  && pl.versoes[pl.versoes.length - 1].resumo === "Retroagi: Atualizei o IA_PLANOS (4 planos)", "retroagir o .JSON: a lista de antes volta, o Plus volta ao valor dele, e o histórico anota", d);

// ---------------------------------------------- cancelar a campanha agendada
console.log("cancelar a campanha agendada");
await limparFila();
const daqui3 = new Date(relogio + 2 * DIA - 3 * 3600 * 1000).toISOString();
await pedir("campanha.disparar", { nome: "Lançamento", publico: "todos", assunto: "Novidade", texto: "Texto", quando: "agendado", de: daqui3.slice(0, 10), hora: daqui3.slice(11, 16) }, "Agendei Lançamento");
await publicarFila();
camps = (await (await admin("GET", "/api/admin/campanhas", como())).json()).campanhas;
const lanc = camps.find((x) => x.nome === "Lançamento");
r = await pedir("campanha.cancelar", { id: "c123" });
checar(r.status === 400, "campanha inválida: recusada");
r = await admin("POST", "/api/admin/alteracoes", comoSuporte({ corpo: { tela: "emails", tipo: "campanha.cancelar", alvo: lanc.id, dados: { id: lanc.id }, texto: "Cancelei o envio de Lançamento" } }));
checar(r.status === 200, "o cancelamento entra na fila (qualquer papel que dispara também cancela)");
d = await (await admin("POST", "/api/admin/publicar", comoSuporte({ corpo: { confirmacao: "comitar e pushar" } }))).json();
const lancKV = JSON.parse(guardados.get("admin:campanha:" + lanc.id));
checar(d.ok && lancKV.situacao === "cancelada" && lancKV.cancelada.por === "suporte@paulus.ia.br" && !JSON.parse(guardados.get("admin:campanhas:fila")).includes(lanc.id)
  && lancKV.destinatarios.every((x) => !x.email), "publicado: a campanha fica cancelada, sai da fila do Cron e a lista de e-mails some", lancKV.situacao);
emails.length = 0;
envio = await enviarCampanhas(env, relogio + 3 * DIA);
checar(!emails.some((e) => e.subject === "Novidade"), "e o Cron não manda nada dela na hora marcada");
r = await pedir("campanha.cancelar", { id: lanc.id });
checar(r.status === 400 && (await r.json()).erro.includes("já foi cancelada"), "cancelar de novo: recusado");
const enviada = camps.find((x) => x.situacao === "enviada");
r = await pedir("campanha.cancelar", { id: enviada.id });
checar(r.status === 400 && (await r.json()).erro.includes("saiu inteira"), "a que já saiu inteira não cancela: os e-mails não voltam");

// ---------------------------------------------- a forma e a situacao no extrato
console.log("forma e situação no extrato");
const idLia = await novaConta("lia");
const quandoIso = (ms) => new Date(ms).toISOString();
await contaDo(idLia, "assinatura", { plano: "advogado", assinatura: { id: "preLia", situacao: "authorized", valor: 449 } });
await contaDo(idLia, "renovar", { cobranca: "COBL0", valor: 449, quando: quandoIso(relogio - 40 * DIA) });
await contaDo(idLia, "cartao", { bandeira: "master", final: "4242", validade: "12/30", titular: "LIA" });
await contaDo(idLia, "renovar", { cobranca: "COBL1", valor: 449, quando: quandoIso(relogio + 60 * 1000) });
await contaDo(idLia, "creditar", { pedido: "ORDL1", valor: 50, plano: "advogado" });
await contaDo(idLia, "anual_pago", { pagamento: "PAYL2", plano: "advogado", valor: 3990, meses: 12, quando: quandoIso(relogio) });
await contaDo(idLia, "anual_pendente", { ref: "ia-mes-" + idLia + "-advogado-ab12", plano: "advogado", valor: 449, meses: 1 });
pagamentosMP.set("cobranca:COBL0", 777);
pagamentosMP.set("777", { id: 777, status: "approved", payment_method_id: "visa", payment_type_id: "credit_card", card: { last_four_digits: "1111" }, installments: 1 });
pagamentosMP.set("PAYL2", { id: "PAYL2", status: "approved", payment_method_id: "pix", payment_type_id: "bank_transfer" });
antesMP2 = mp.length;
det = await (await admin("GET", "/api/admin/contas/" + idLia, como())).json();
const pgLia = (ref) => (det.pagamentos || []).find((x) => x.ref === ref) || {};
checar(pgLia("COBL1").forma.tipo === "cartao" && pgLia("COBL1").forma.bandeira === "mastercard" && pgLia("COBL1").forma.final === "4242" && !pgLia("COBL1").forma_falta,
  "mensalidade depois do cartão guardado: a bandeira e o final dele", pgLia("COBL1"));
checar(pgLia("COBL0").forma.bandeira === "visa" && pgLia("COBL0").forma.final === "1111" && mp.slice(antesMP2).some((x) => x.caminho === "/authorized_payments/COBL0")
  && mp.slice(antesMP2).some((x) => x.caminho === "/v1/payments/777"), "mensalidade de antes do cartão de agora: o cartão que o Mercado Pago diz", pgLia("COBL0"));
checar(pgLia("ORDL1").forma.tipo === "pix" && pgLia("PAYL2").forma.tipo === "pix" && pgLia("PAYL2").situacao === "pago" && pgLia("ORDL1").situacao === "pago",
  "a recarga é Pix; o anual, o que o Mercado Pago diz (aqui, Pix); a situação de cada um", { r: pgLia("ORDL1"), a: pgLia("PAYL2") });
checar(det.pendentes.length === 1 && det.pendentes[0].situacao === "pendente" && det.pendentes[0].tipo === "avulso" && det.pendentes[0].valor === 449 && det.pendentes[0].forma_falta,
  "o mês no Pix que ainda espera a confirmação aparece como pendente", det.pendentes);
checar(JSON.parse(guardados.get("admin:forma:COBL0")).final === "1111" && JSON.parse(guardados.get("admin:forma:PAYL2")).tipo === "pix", "o que o Mercado Pago disse fica guardado (só a forma)");
antesMP2 = mp.length;
det = await (await admin("GET", "/api/admin/contas/" + idLia, como())).json();
checar(mp.length === antesMP2 && pgLia("COBL0").forma.final === "1111", "na próxima vez, sem perguntar de novo ao Mercado Pago");
await contaDo(idLia, "anual_pago", { pagamento: "PAYL3", plano: "advogado", valor: 3990, meses: 12, quando: quandoIso(relogio + 2 * 60 * 1000) });
det = await (await admin("GET", "/api/admin/contas/" + idLia, { ...como(), envUsado: { ...env, MP_ACCESS_TOKEN: "" } })).json();
checar(pgLia("PAYL3").forma === null && pgLia("PAYL3").forma_falta.includes("MP_ACCESS_TOKEN"), "sem o Mercado Pago, o anual fica sem a forma e diz o que falta", pgLia("PAYL3"));
// Muitas mensalidades antigas: o Mercado Pago responde ate 6 consultas por ficha; o resto fica para a proxima vez.
for (let i = 0; i < 4; i++) await contaDo(idLia, "renovar", { cobranca: "COBV" + i, valor: 449, quando: quandoIso(relogio - (80 + i) * DIA) });
det = await (await admin("GET", "/api/admin/contas/" + idLia, como())).json();
const semAgora = det.pagamentos.filter((x) => /^COBV/.test(x.ref) && x.forma_falta && x.forma_falta.includes("próxima vez"));
checar(semAgora.length >= 1 && det.pagamentos.filter((x) => /^COBV/.test(x.ref)).every((x) => x.forma && x.forma.tipo === "cartao"),
  "com muitas a conferir, o resto espera a próxima vez, e diz", semAgora.map((x) => x.ref));

// --------------------------------------------------------- privacidade
const pessoais = [...guardados.entries()].filter(([k]) => !k.startsWith("admin:"));
checar(!pessoais.length, "o painel so grava chaves admin: no APOIOS", pessoais.map(([k]) => k));

r = await admin("POST", "/api/admin/sair", como());
checar(r.status === 200 && /Max-Age=0/.test(r.headers.get("set-cookie")) && !guardados.has("admin:sessao:" + sessao), "sair apaga a sessao");

// --------------------------------------------------------- encerrar todas as sessoes
console.log("encerrar todas as sessões");
async function entrar(email) {
  let x = await admin("GET", "/api/admin/github/entrar", { email });
  const st_ = new URL(x.headers.get("location")).searchParams.get("state");
  x = await admin("GET", "/api/admin/github/retorno?code=bom&state=" + st_, { email });
  return (x.headers.get("set-cookie") || "").match(/pv_admin=([0-9a-f]+)/)[1];
}
const s1 = await entrar("dono@paulus.ia.br");
const s2 = await entrar("dono@paulus.ia.br");
const sOutra = await entrar("suporte@paulus.ia.br");
// Uma sessao de antes do indice (que o indice nao conhece).
guardados.set("admin:sessao:" + "a".repeat(48), JSON.stringify({ email: "dono@paulus.ia.br", login: "matheus", token: "gho_x" }));
r = await admin("POST", "/api/admin/sessoes/encerrar", { cookie: s1 });
d = await r.json();
// 4: as duas do GitHub, a de antes do indice e a so do Access, do comeco.
checar(r.status === 200 && d.encerradas === 4 && !guardados.has("admin:sessao:" + soAccess) && /Max-Age=0/.test(r.headers.get("set-cookie")) && !guardados.has("admin:sessao:" + s1) && !guardados.has("admin:sessao:" + s2)
  && !guardados.has("admin:sessao:" + "a".repeat(48)) && guardados.has("admin:sessao:" + sOutra) && !guardados.has("admin:sessoes:dono@paulus.ia.br"),
  "encerra todas as sessões do painel da pessoa (esta também, e as de antes do índice), e só as dela", d);
checar(d.access.feito === false && d.access.frase.includes("CF_ACCESS_TOKEN"), "sem a API do Access, diz que as sessões do Access ficam até vencer", d.access);
checar((await admin("GET", "/api/admin/visao", { cookie: s2 })).status === 401, "a sessão do outro aparelho não vale mais");
const s3 = await entrar("dono@paulus.ia.br");
cf.chamadas.length = 0;
r = await admin("POST", "/api/admin/sessoes/encerrar", { cookie: s3, envUsado: { ...env, CF_ACCESS_TOKEN: "cfat_teste", CF_ACCOUNT_ID: "conta1" } });
d = await r.json();
checar(d.ok && d.access.feito && cf.chamadas.some((x) => x.caminho === "/accounts/conta1/access/organizations/revoke_user" && x.corpo.email === "dono@paulus.ia.br"),
  "com a API do Access, as sessões do Access dela caem também", d);

console.log(falhas ? `\n  ${falhas} falha(s)` : "\n  painel admin: todos os testes passaram");
process.exit(falhas ? 1 : 0);
