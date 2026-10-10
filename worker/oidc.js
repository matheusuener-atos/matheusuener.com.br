// "Entrar com Atos": a Atos como provedor de identidade OpenID Connect, do
// mesmo jeito que o Google e para o "Entrar com o Google". O primeiro
// aplicativo e o PAVLVS (o site paulus.ia.br e o PAULUS instalado).
//
// O fluxo e o do codigo de autorizacao com PKCE (S256, obrigatorio), sem
// segredo de cliente - os dois clientes sao publicos (uma pagina e um
// programa instalado), como manda a RFC 8252:
//
//   1. o aplicativo abre  https://atos.dev.br/entrar?client_id=...&redirect_uri=...
//      &response_type=code&scope=openid email profile&state=...&nonce=...
//      &code_challenge=...&code_challenge_method=S256
//   2. a pagina /entrar pede POST /api/pedido: o Worker confere o aplicativo e
//      o endereco de volta e diz o que mostrar (entrar, consentimento ou nada);
//   3. a pessoa entra (contas.js) e, na primeira vez, permite: POST /api/autorizar;
//      a permissao fica guardada por aplicativo ("atos:apps:<sub>") e da segunda
//      vez em diante a pagina segue sozinha;
//   4. volta ao aplicativo com ?code=...&state=...&iss=https://atos.dev.br;
//   5. o aplicativo troca o codigo em POST /oauth/token (com o code_verifier)
//      pelo id_token (ES256, 1 hora) e um access_token (1 hora, para /oauth/userinfo).
//
// Endpoints: /.well-known/openid-configuration, /entrar (autorizacao),
// /oauth/token, /oauth/userinfo, /oauth/jwks, /oauth/revogar.
// A pessoa ve e revoga os aplicativos em /conta (GET /api/apps, POST /api/apps/revogar).
//
// A chave de assinatura e o segredo ATOS_CHAVE do Worker: a JWK privada P-256
// com "kid" (tools/gerar-chave.mjs a cria). ATOS_CHAVES_ANTIGAS (var, opcional)
// guarda as publicas que ainda valem durante uma troca de chave.
//
// O codigo vale 2 minutos e so uma vez. O KV nao e transacional: duas trocas
// do mesmo codigo no mesmo instante, em dois lugares do mundo, poderiam passar
// as duas - o PKCE garante que so quem comecou o pedido tem o verifier.

import { EMISSOR, aleatorio, b64url, b64urlTexto, deB64url, json, kv, lerJson, sha256 } from "./comum.js";
import { sessaoDe } from "./contas.js";
import { googleLigado } from "./google.js";

const CODIGO_S = 120;
const TOKEN_S = 3600;
const RECENTE_S = 300;

/* Os aplicativos que podem pedir "Entrar com Atos". Um aplicativo pode ter mais
   de um cliente (o site e o programa): a permissao e por aplicativo, entao
   quem permitiu no site nao precisa permitir de novo no programa. */
export const APPS = {
  pavlvs: {
    nome: "PAVLVS",
    descricao: "assistente jurídico para escritórios de advocacia",
    site: "https://paulus.ia.br",
    privacidade: "https://paulus.ia.br/politica-de-privacidade",
    termos: "https://paulus.ia.br/termos-de-uso",
    icone: "/assets/paulus-p.png",
    daAtos: true,
  },
};

export const CLIENTES = {
  // O site do PAVLVS (assinatura, Minha conta): a pagina de volta troca o codigo.
  "pavlvs-site": { app: "pavlvs", voltas: ["https://paulus.ia.br/entrar-atos/"], origens: ["https://paulus.ia.br"] },
  // O PAULUS instalado: volta a um endereco local da maquina (RFC 8252, porta qualquer).
  "pavlvs-app": { app: "pavlvs", loopback: true, origens: [] },
  // A equipe que entra de fora, pelo endereco do escritorio (<escritorio>.paulus.ia.br, o tunel ate o PAULUS
  // dele): volta direto ao escritorio, que troca o codigo do proprio servidor (sem CORS).
  "pavlvs-escritorio": { app: "pavlvs", padrao: /^https:\/\/(?!www\.|admin\.)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.paulus\.ia\.br\/api\/acesso\/atos\/retorno$/, origens: [] },
};

export const ESCOPOS = {
  openid: "Saber que é você (um identificador da sua conta Atos)",
  email: "Ver o seu endereço de e-mail",
  profile: "Ver o seu nome",
};

const lista = (s) => String(s || "").split(/\s+/).filter(Boolean);

function voltaPermitida(cliente, volta) {
  if (!volta || volta.length > 500) return false;
  if (cliente.voltas && cliente.voltas.includes(volta)) return true;
  if (cliente.padrao && cliente.padrao.test(volta)) return true;
  if (cliente.loopback) {
    try {
      const u = new URL(volta);
      return u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "[::1]") && !u.username && !u.password && !u.hash;
    } catch {
      return false;
    }
  }
  return false;
}

function voltar(volta, campos) {
  const u = new URL(volta);
  for (const [k, v] of Object.entries(campos)) if (v !== undefined && v !== "") u.searchParams.set(k, v);
  return u.toString();
}

/* O pedido de autorizacao, conferido. {fatal} quando nao da para voltar ao
   aplicativo (cliente ou endereco desconhecido); {ir} quando o erro volta a ele;
   senao {pedido}. */
export function lerPedido(consulta) {
  const q = new URLSearchParams(String(consulta || "").replace(/^\?/, ""));
  const clienteId = q.get("client_id") || "";
  const cliente = Object.prototype.hasOwnProperty.call(CLIENTES, clienteId) ? CLIENTES[clienteId] : null;
  if (!cliente) return { fatal: "Este aplicativo não está registrado na Atos." };
  const volta = q.get("redirect_uri") || "";
  if (!voltaPermitida(cliente, volta)) return { fatal: "O endereço de volta não pertence a este aplicativo." };
  const state = (q.get("state") || "").slice(0, 500);
  const erro = (error, error_description) => ({ ir: voltar(volta, { error, error_description, state, iss: EMISSOR }) });
  if (q.get("response_type") !== "code") return erro("unsupported_response_type", "só response_type=code");
  if ((q.get("response_mode") || "query") !== "query") return erro("invalid_request", "só response_mode=query");
  const desafio = q.get("code_challenge") || "";
  if (q.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(desafio)) return erro("invalid_request", "PKCE com S256 é obrigatório");
  const escopos = lista(q.get("scope")).filter((s) => ESCOPOS[s]);
  if (!escopos.includes("openid")) return erro("invalid_scope", "o escopo openid é obrigatório");
  const prompt = lista(q.get("prompt"));
  if (prompt.includes("none") && prompt.length > 1) return erro("invalid_request", "prompt=none não combina com outro");
  const maxAge = q.has("max_age") ? Math.max(0, parseInt(q.get("max_age"), 10) || 0) : null;
  return {
    pedido: {
      clienteId, app: cliente.app, volta, state, escopos: [...new Set(escopos)], desafio,
      nonce: (q.get("nonce") || "").slice(0, 200), prompt, maxAge, dica: (q.get("login_hint") || "").slice(0, 200),
    },
  };
}

function precisaEntrar(pedido, sessao, agora) {
  if (!sessao) return true;
  const idade = agora / 1000 - sessao.auth_time;
  if (pedido.prompt.includes("login") && idade > RECENTE_S) return true;
  if (pedido.maxAge !== null && idade > pedido.maxAge) return true;
  return false;
}

async function appsDe(env, sub) {
  return (await kv(env, "atos:apps:" + sub)) || {};
}

function jaPermitiu(apps, pedido) {
  const a = apps[pedido.app];
  return Boolean(a && pedido.escopos.every((s) => (a.escopos || []).includes(s)));
}

async function emitirCodigo(env, pedido, sessao) {
  const codigo = aleatorio(32);
  await env.CONTAS.put("atos:codigo:" + (await sha256(codigo)), JSON.stringify({
    clienteId: pedido.clienteId, volta: pedido.volta, desafio: pedido.desafio, nonce: pedido.nonce, escopos: pedido.escopos,
    sub: sessao.sub, email: sessao.email, auth_time: sessao.auth_time,
  }), { expirationTtl: CODIGO_S });
  return voltar(pedido.volta, { code: codigo, state: pedido.state, iss: EMISSOR });
}

function publicoDoApp(id) {
  const a = APPS[id];
  return { id, nome: a.nome, descricao: a.descricao, site: a.site, privacidade: a.privacidade, termos: a.termos, icone: a.icone, daAtos: Boolean(a.daAtos) };
}

// ---------------------------------------------------------- a assinatura

let chaveCache = { texto: "", chave: null, publica: null };

async function chaveDeAssinar(env) {
  const texto = String(env.ATOS_CHAVE || "");
  if (!texto) return null;
  if (chaveCache.texto !== texto) {
    const jwk = JSON.parse(texto);
    const chave = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d, ext: true },
      { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    chaveCache = { texto, chave, publica: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, kid: jwk.kid, alg: "ES256", use: "sig" } };
  }
  return chaveCache;
}

export async function jwks(env) {
  const chaves = [];
  const atual = await chaveDeAssinar(env);
  if (atual) chaves.push(atual.publica);
  try {
    for (const k of JSON.parse(env.ATOS_CHAVES_ANTIGAS || "[]")) if (k && k.kid && k.x && k.y) chaves.push({ kty: "EC", crv: "P-256", x: k.x, y: k.y, kid: k.kid, alg: "ES256", use: "sig" });
  } catch {
    // var malformada: so a chave atual
  }
  return { keys: chaves };
}

export async function assinarJWT(env, corpo) {
  const k = await chaveDeAssinar(env);
  const cab = b64urlTexto(JSON.stringify({ alg: "ES256", typ: "JWT", kid: k.publica.kid }));
  const c = b64urlTexto(JSON.stringify(corpo));
  const assinatura = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, k.chave, new TextEncoder().encode(cab + "." + c));
  return cab + "." + c + "." + b64url(assinatura);
}

function reivindicacoes(escopos, conta) {
  const r = { sub: conta.sub };
  if (escopos.includes("email")) Object.assign(r, { email: conta.email, email_verified: true });
  if (escopos.includes("profile")) r.name = conta.nome || "";
  return r;
}

// ---------------------------------------------------------------- as rotas

export function ehRotaDoOIDC(url) {
  return url.pathname === "/.well-known/openid-configuration" || url.pathname.startsWith("/oauth/") ||
    ["/api/pedido", "/api/autorizar", "/api/apps", "/api/apps/revogar"].includes(url.pathname);
}

function cors(request, clienteId) {
  const origem = request.headers.get("origin") || "";
  const permitidas = clienteId ? (CLIENTES[clienteId] || {}).origens || [] : Object.values(CLIENTES).flatMap((c) => c.origens || []);
  if (!origem || !permitidas.includes(origem)) return {};
  return { "access-control-allow-origin": origem, "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "authorization, content-type", "access-control-max-age": "600", vary: "origin" };
}

const erroOAuth = (error, error_description, status = 400, extra = {}) => json({ error, error_description }, status, extra);

export async function atenderOIDC(request, env, url, deps = {}) {
  const p = url.pathname;
  const agora = (deps.agora || Date.now)();

  if (p === "/.well-known/openid-configuration") {
    return new Response(JSON.stringify({
      issuer: EMISSOR,
      authorization_endpoint: EMISSOR + "/entrar",
      token_endpoint: EMISSOR + "/oauth/token",
      userinfo_endpoint: EMISSOR + "/oauth/userinfo",
      jwks_uri: EMISSOR + "/oauth/jwks",
      revocation_endpoint: EMISSOR + "/oauth/revogar",
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["ES256"],
      scopes_supported: Object.keys(ESCOPOS),
      claims_supported: ["sub", "email", "email_verified", "name", "auth_time", "nonce"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      prompt_values_supported: ["none", "login", "consent"],
      authorization_response_iss_parameter_supported: true,
      ui_locales_supported: ["pt-BR"],
    }, null, 2), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=3600", "access-control-allow-origin": "*" } });
  }

  if (p === "/oauth/jwks") {
    return new Response(JSON.stringify(await jwks(env)), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=3600", "access-control-allow-origin": "*" } });
  }

  if (request.method === "OPTIONS" && p.startsWith("/oauth/")) return new Response(null, { status: 204, headers: cors(request) });

  if (p === "/oauth/token") {
    if (request.method !== "POST") return erroOAuth("invalid_request", "use POST", 405);
    if (deps.dentroDoLimite && !(await deps.dentroDoLimite(request, env))) return erroOAuth("slow_down", "muitos pedidos seguidos", 429);
    let f;
    try {
      f = new URLSearchParams(await request.text());
    } catch {
      return erroOAuth("invalid_request", "corpo inválido");
    }
    const clienteId = f.get("client_id") || "";
    const extra = cors(request, clienteId);
    if (f.get("grant_type") !== "authorization_code") return erroOAuth("unsupported_grant_type", "só authorization_code", 400, extra);
    if (!CLIENTES[clienteId]) return erroOAuth("invalid_client", "aplicativo desconhecido", 401, extra);
    if (!env.ATOS_CHAVE) return erroOAuth("temporarily_unavailable", "a assinatura de tokens ainda não está ligada", 503, extra);
    const codigo = f.get("code") || "";
    if (!codigo || codigo.length > 100) return erroOAuth("invalid_grant", "código inválido", 400, extra);
    const chave = "atos:codigo:" + (await sha256(codigo));
    const c = await kv(env, chave);
    if (!c) return erroOAuth("invalid_grant", "o código venceu ou já foi usado", 400, extra);
    await env.CONTAS.delete(chave);
    if (c.clienteId !== clienteId || c.volta !== (f.get("redirect_uri") || "")) return erroOAuth("invalid_grant", "o código é de outro aplicativo ou endereço", 400, extra);
    const verifier = f.get("code_verifier") || "";
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))) !== c.desafio) {
      return erroOAuth("invalid_grant", "o code_verifier não confere", 400, extra);
    }
    // A conta ainda existe (e com o mesmo sub), e a permissao nao foi revogada no meio.
    const conta = await kv(env, "id:conta:" + c.email);
    if (!conta || conta.sub !== c.sub) return erroOAuth("invalid_grant", "a conta não existe mais", 400, extra);
    const apps = await appsDe(env, c.sub);
    if (!jaPermitiu(apps, { app: CLIENTES[clienteId].app, escopos: c.escopos })) return erroOAuth("invalid_grant", "a permissão foi revogada", 400, extra);
    const dados = { sub: c.sub, email: c.email, nome: conta.nome || "" };
    const s = Math.floor(agora / 1000);
    const idToken = await assinarJWT(env, {
      iss: EMISSOR, aud: clienteId, azp: clienteId, iat: s, exp: s + TOKEN_S, auth_time: c.auth_time,
      ...(c.nonce ? { nonce: c.nonce } : {}), ...reivindicacoes(c.escopos, dados),
    });
    const acesso = aleatorio(32);
    await env.CONTAS.put("atos:acesso:" + (await sha256(acesso)), JSON.stringify({ sub: c.sub, email: c.email, clienteId, escopos: c.escopos }), { expirationTtl: TOKEN_S });
    // Anota quando o aplicativo entrou pela ultima vez (a pagina /conta mostra).
    apps[CLIENTES[clienteId].app] = { ...apps[CLIENTES[clienteId].app], ultimo: new Date(agora).toISOString() };
    await env.CONTAS.put("atos:apps:" + c.sub, JSON.stringify(apps));
    return json({ access_token: acesso, token_type: "Bearer", expires_in: TOKEN_S, id_token: idToken, scope: c.escopos.join(" ") }, 200, { ...extra, pragma: "no-cache" });
  }

  if (p === "/oauth/userinfo") {
    const extra = cors(request);
    const m = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") || "");
    const a = m ? await kv(env, "atos:acesso:" + (await sha256(m[1]))) : null;
    if (!a) return json({ error: "invalid_token" }, 401, { ...extra, "www-authenticate": 'Bearer error="invalid_token"' });
    const conta = await kv(env, "id:conta:" + a.email);
    if (!conta || conta.sub !== a.sub) return json({ error: "invalid_token" }, 401, extra);
    return json(reivindicacoes(a.escopos, { sub: a.sub, email: a.email, nome: conta.nome || "" }), 200, extra);
  }

  if (p === "/oauth/revogar") {
    if (request.method !== "POST") return erroOAuth("invalid_request", "use POST", 405);
    let f;
    try {
      f = new URLSearchParams(await request.text());
    } catch {
      f = new URLSearchParams();
    }
    const token = f.get("token") || "";
    if (token && token.length <= 100) await env.CONTAS.delete("atos:acesso:" + (await sha256(token)));
    return new Response(null, { status: 200, headers: cors(request) });
  }

  // ------------------------------------------- as da pagina /entrar e /conta
  // So da propria atos.dev.br (contas.js tem a sessao no cookie SameSite=Lax;
  // aqui ainda se confere a origem, e o corpo e JSON - um formulario de outro
  // site nao consegue mandar).
  const sessao = await sessaoDe(request, env);

  if (p === "/api/apps") {
    if (!sessao) return json({ erro: "entre na sua conta" }, 401);
    const apps = await appsDe(env, sessao.sub);
    return json({
      apps: Object.entries(apps).filter(([id]) => APPS[id]).map(([id, a]) => ({
        ...publicoDoApp(id), escopos: (a.escopos || []).map((s) => ESCOPOS[s] || s), quando: a.quando || null, ultimo: a.ultimo || null,
      })),
    });
  }
  if (request.method !== "POST") return json({ erro: "use POST" }, 405);
  const d = (await lerJson(request)) || {};

  if (p === "/api/apps/revogar") {
    if (!sessao) return json({ erro: "entre na sua conta" }, 401);
    const apps = await appsDe(env, sessao.sub);
    delete apps[String(d.app || "")];
    await env.CONTAS.put("atos:apps:" + sessao.sub, JSON.stringify(apps));
    return json({ ok: true });
  }

  const lido = lerPedido(d.consulta);
  if (lido.fatal) return json({ erro: lido.fatal }, 400);
  if (lido.ir) return json({ ir: lido.ir });
  const pedido = lido.pedido;
  const entrar = precisaEntrar(pedido, sessao, agora);
  const apps = sessao ? await appsDe(env, sessao.sub) : {};
  const permitido = Boolean(sessao) && jaPermitiu(apps, pedido) && !pedido.prompt.includes("consent");

  if (p === "/api/pedido") {
    if (pedido.prompt.includes("none")) {
      if (entrar) return json({ ir: voltar(pedido.volta, { error: "login_required", state: pedido.state, iss: EMISSOR }) });
      if (!permitido) return json({ ir: voltar(pedido.volta, { error: "consent_required", state: pedido.state, iss: EMISSOR }) });
      return json({ ir: await emitirCodigo(env, pedido, sessao) });
    }
    return json({
      app: publicoDoApp(pedido.app),
      escopos: pedido.escopos.map((s) => ({ id: s, texto: ESCOPOS[s] })),
      conta: sessao ? { email: sessao.email, nome: sessao.nome } : null,
      entrar, permitido, dica: pedido.dica, google: googleLigado(env),
    });
  }

  if (p === "/api/autorizar") {
    if (d.permitir !== true) return json({ ir: voltar(pedido.volta, { error: "access_denied", error_description: "a pessoa não permitiu", state: pedido.state, iss: EMISSOR }) });
    if (!sessao || entrar) return json({ erro: "entre na sua conta de novo" }, 401);
    if (!jaPermitiu(apps, pedido) || pedido.prompt.includes("consent")) {
      const antes = apps[pedido.app] || {};
      apps[pedido.app] = { ...antes, escopos: [...new Set([...(antes.escopos || []), ...pedido.escopos])], quando: new Date(agora).toISOString() };
      await env.CONTAS.put("atos:apps:" + sessao.sub, JSON.stringify(apps));
    }
    return json({ ir: await emitirCodigo(env, pedido, sessao) });
  }

  return json({ erro: "rota não existe" }, 404);
}

// Para os testes: conferir um id_token com a chave publica.
export async function conferirIdToken(env, token) {
  const [cab, corpo, ass] = String(token).split(".");
  const k = await chaveDeAssinar(env);
  const pub = await crypto.subtle.importKey("jwk", { ...k.publica, ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, deB64url(ass), new TextEncoder().encode(cab + "." + corpo));
  return ok ? JSON.parse(new TextDecoder().decode(deB64url(corpo))) : null;
}
