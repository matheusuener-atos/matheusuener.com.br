// "Continuar com Google" na conta Atos (09/10/2026): o Google e so mais um
// jeito de entrar na conta Atos. O PAVLVS (e quem mais usar "Entrar com Atos")
// nunca fala com o Google para saber quem e a pessoa - so a Atos fala.
//
//   GET /oauth/google?consulta=<o pedido OIDC de /entrar, ou vazio>
//       guarda o pedido e vai ao Google (codigo + PKCE, openid email profile)
//   GET /oauth/google/volta?code&state
//       troca o codigo no Google, acha ou cria a conta Atos, abre a sessao e
//       volta a /entrar (que segue o pedido do aplicativo) ou a /conta
//
// Cliente "Aplicativo da Web" do projeto "Atos" no Google Cloud: GOOGLE_CLIENT_ID
// (var, nao e segredo) e GOOGLE_CLIENT_SECRET (segredo). Sem os dois, o botao
// nao aparece e as rotas respondem que nao esta ligado.
//
// A conta: a mesma do e-mail confirmado pelo Google ("id:conta:<email>").
//   - ja existe (com senha ou nao): entra nela, com o sub dela, e anota o
//     Google nela ("google": sub do Google);
//   - nao existe: nasce sem senha. O sub e o que o PAVLVS ja usava para esse
//     e-mail quando a pessoa entrava direto com o Google ("id:google:<email>",
//     que e o proprio sub do Google) - assim a assinatura, o endereco do acesso
//     de fora e a nuvem continuam dela. Sem esse indice, o sub do Google.
// Conta sem senha cria uma em "Esqueci a senha", se quiser.
//
// O id_token do Google vem direto do endpoint de token (TLS, em resposta a um
// pedido nosso com o segredo): e lido sem conferir a assinatura, como a
// especificacao permite; confere-se emissor, aud, validade, nonce e e-mail
// verificado.

import { EMISSOR, aleatorio, b64url, deB64url, kv, normal, sha256 } from "./comum.js";
import { abrirSessao } from "./contas.js";

const AUTORIZAR = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const VOLTA = EMISSOR + "/oauth/google/volta";
const PEDIDO_S = 10 * 60;

export const googleLigado = (env) => Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);

export function ehRotaDoGoogle(url) {
  return url.pathname === "/oauth/google" || url.pathname === "/oauth/google/volta";
}

function ir(local, cookie) {
  const h = { location: local, "cache-control": "no-store" };
  if (cookie) h["set-cookie"] = cookie;
  return new Response(null, { status: 302, headers: h });
}

/* De volta a /entrar com o pedido do aplicativo (se havia) e, se deu errado, a frase. */
function aEntrar(consulta, erro) {
  const q = new URLSearchParams(consulta || "");
  if (erro) q.set("erro_google", erro);
  const s = q.toString();
  return EMISSOR + "/entrar/" + (s ? "?" + s : "");
}

export async function atenderGoogle(request, env, url, deps = {}) {
  const agora = (deps.agora || Date.now)();
  const buscar = deps.fetch || fetch;

  if (url.pathname === "/oauth/google") {
    const consulta = (url.searchParams.get("consulta") || "").slice(0, 2000);
    if (!googleLigado(env)) return ir(aEntrar(consulta, "a entrada com o Google ainda não está ligada"));
    const state = aleatorio(24);
    const verifier = aleatorio(48);
    const nonce = aleatorio(16);
    await env.CONTAS.put("atos:google:" + (await sha256(state)), JSON.stringify({ consulta, verifier, nonce }), { expirationTtl: PEDIDO_S });
    const desafio = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    const q = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID, redirect_uri: VOLTA, response_type: "code", scope: "openid email profile",
      state, nonce, code_challenge: desafio, code_challenge_method: "S256", prompt: "select_account",
    });
    // A dica do e-mail do pedido do aplicativo (destravar o PAULUS de alguem), quando ha.
    const dica = new URLSearchParams(consulta).get("login_hint");
    if (dica) q.set("login_hint", dica);
    return ir(AUTORIZAR + "?" + q.toString());
  }

  // a volta
  const state = url.searchParams.get("state") || "";
  const chave = "atos:google:" + (await sha256(state));
  const p = state && state.length < 100 ? await kv(env, chave) : null;
  if (!p) return ir(aEntrar("", "a entrada com o Google venceu: tente de novo"));
  await env.CONTAS.delete(chave);
  if (url.searchParams.get("error")) {
    return ir(aEntrar(p.consulta, url.searchParams.get("error") === "access_denied" ? "" : "o Google não confirmou a entrada"));
  }
  if (!googleLigado(env)) return ir(aEntrar(p.consulta, "a entrada com o Google ainda não está ligada"));
  let tokens;
  try {
    const r = await buscar(TOKEN, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code", code: url.searchParams.get("code") || "", redirect_uri: VOLTA,
        client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, code_verifier: p.verifier,
      }).toString(),
    });
    tokens = await r.json();
    if (!r.ok) tokens = null;
  } catch {
    tokens = null;
  }
  const info = lerIdToken(tokens && tokens.id_token);
  const valido = info && ["accounts.google.com", "https://accounts.google.com"].includes(info.iss) && info.aud === env.GOOGLE_CLIENT_ID &&
    Number(info.exp) * 1000 > agora && info.nonce === p.nonce && info.sub && info.email &&
    (info.email_verified === true || info.email_verified === "true");
  if (!valido) return ir(aEntrar(p.consulta, "o Google não confirmou a entrada: tente de novo"));

  const email = normal(info.email);
  const gsub = String(info.sub);
  const nome = String(info.name || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 80);
  let conta = await kv(env, "id:conta:" + email);
  if (conta) {
    if (conta.google !== gsub || (!conta.nome && nome)) {
      conta = { ...conta, google: gsub, nome: conta.nome || nome };
      await env.CONTAS.put("id:conta:" + email, JSON.stringify(conta));
    }
  } else {
    const indice = await kv(env, "id:google:" + email);
    conta = { sub: indice && indice.sub ? String(indice.sub) : gsub, google: gsub, nome, criada: new Date(agora).toISOString(), por: "google" };
    await env.CONTAS.put("id:conta:" + email, JSON.stringify(conta));
    if (!indice) await env.CONTAS.put("id:google:" + email, JSON.stringify({ sub: gsub }));
  }
  const cookie = await abrirSessao(env, { sub: conta.sub, email }, agora);
  return ir(p.consulta ? aEntrar(p.consulta) : EMISSOR + "/conta/", cookie);
}

function lerIdToken(token) {
  try {
    return JSON.parse(new TextDecoder().decode(deB64url(String(token).split(".")[1])));
  } catch {
    return null;
  }
}
