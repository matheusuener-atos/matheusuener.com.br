// O Worker de atos.dev.br: a pagina da Atos (pasta public/), a conta Atos
// (contas.js) e o "Entrar com Atos" (oidc.js).
//
// matheusuener.com.br e www.* voltam para https://atos.dev.br com 301.
// Toda pagina sai com cabecalhos de seguranca; as da conta (/entrar, /conta)
// com uma CSP sem nada de fora - nelas a pessoa digita a senha e permite
// aplicativos, entao nada de outro site roda nem as emoldura.

import { EMISSOR, dentroDoLimite, json } from "./comum.js";
import { atenderConta, ehRotaDaConta } from "./contas.js";
import { atenderOIDC, ehRotaDoOIDC } from "./oidc.js";
import { atenderGoogle, ehRotaDoGoogle } from "./google.js";
import { atenderCobranca, ehRotaDaCobranca } from "./cobranca.js";
import { atenderCobrancaPavlvs, ehRotaDaCobrancaPavlvs } from "./cobranca-pavlvs.js";

const CSP_CONTA = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
].join("; ");

const CSP_SITE = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
].join("; ");

function comCabecalhos(resposta, conta) {
  const r = new Response(resposta.body, resposta);
  if ((r.headers.get("content-type") || "").includes("text/html")) {
    r.headers.set("content-security-policy", conta ? CSP_CONTA : CSP_SITE);
    r.headers.set("x-frame-options", "DENY");
    r.headers.set("referrer-policy", conta ? "no-referrer" : "strict-origin-when-cross-origin");
    if (conta) r.headers.set("cache-control", "no-store");
  }
  r.headers.set("x-content-type-options", "nosniff");
  r.headers.set("strict-transport-security", "max-age=31536000");
  return r;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.hostname !== "atos.dev.br" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      return Response.redirect(EMISSOR + url.pathname + url.search, 301);
    }
    try {
      if (ehRotaDoGoogle(url)) return comCabecalhos(await atenderGoogle(request, env, url));
      if (ehRotaDoOIDC(url)) {
        if (url.pathname.startsWith("/api/") && !mesmaOrigem(request, url)) return json({ erro: "origem não permitida" }, 403);
        return comCabecalhos(await atenderOIDC(request, env, url, { dentroDoLimite }));
      }
      // A cobranca do PAVLVS (o motor de worker/pavlvs/, docs/MIGRACAO-COBRANCA.md): as rotas e as
      // protecoes sao as dele (a origem, a sessao pv_conta, a assinatura do aviso do Mercado Pago).
      if (ehRotaDaCobrancaPavlvs(url)) return await atenderCobrancaPavlvs(request, env, ctx);
      if (ehRotaDaCobranca(url)) {
        if (!mesmaOrigem(request, url)) return json({ erro: "origem não permitida" }, 403);
        return comCabecalhos(await atenderCobranca(request, env, url));
      }
      if (ehRotaDaConta(url)) {
        if (!mesmaOrigem(request, url)) return json({ erro: "origem não permitida" }, 403);
        return comCabecalhos(await atenderConta(request, env, url, { dentroDoLimite }));
      }
    } catch (erro) {
      return json({ erro: "falha no servidor da conta" }, 500);
    }
    if (url.pathname.startsWith("/api/")) return json({ erro: "rota não existe" }, 404);
    const conta = /^\/(entrar|conta)(\/|$)/.test(url.pathname);
    // Cada secao da Minha conta tem o proprio endereco; a pagina e uma so.
    if (/^\/conta\/(dados|assinaturas|faturamento|carteira)\/?$/.test(url.pathname)) {
      return comCabecalhos(await env.ASSETS.fetch(new Request(new URL("/conta/", url), request)), true);
    }
    return comCabecalhos(await env.ASSETS.fetch(request), conta);
  },
};

/* POST so da propria pagina (o navegador sempre manda Origin num POST de fetch). */
function mesmaOrigem(request, url) {
  if (request.method === "GET" || request.method === "HEAD") return true;
  return request.headers.get("origin") === url.origin;
}
