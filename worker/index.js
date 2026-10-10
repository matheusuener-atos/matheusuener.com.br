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
import { atenderCobrancaV1, ehRotaDaCobrancaV1 } from "./cobranca/api.js";

// O registro de cada cliente da Atos Cobranca (docs/COBRANCA.md): o Durable Object precisa sair do modulo principal.
export { ClienteCobranca } from "./cobranca/cliente.js";

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

// O checkout (/pavlvs/assinar e os de outros produtos): os campos seguros do Mercado Pago (o SDK, os
// iframes do cartao e a telemetria dele) e o CEP pela ViaCEP. O script da propria pagina roda pelo
// hash dele (CSP_CHECKOUT recebe os 'sha256-...'), nunca por 'unsafe-inline'. O MercadoPago.js poe
// estilos inline nos campos: so o estilo tem 'unsafe-inline'.
const MP_ORIGENS = "https://*.mercadopago.com https://*.mercadolibre.com https://*.mercadolivre.com https://*.mlstatic.com";
const CSP_CHECKOUT = (hashes) => [
  "default-src 'self'",
  `script-src 'self' https://sdk.mercadopago.com ${MP_ORIGENS} ${hashes.join(" ")}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  `connect-src 'self' ${MP_ORIGENS} https://viacep.com.br`,
  `frame-src ${MP_ORIGENS}`,
  "form-action 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
].join("; ");

async function comCspDoCheckout(resposta) {
  const html = await resposta.text();
  const hashes = [];
  for (const m of html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
    const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(m[1]));
    hashes.push("'sha256-" + btoa(String.fromCharCode(...new Uint8Array(h))) + "'");
  }
  const r = new Response(html, resposta);
  r.headers.set("content-security-policy", CSP_CHECKOUT(hashes));
  r.headers.set("x-frame-options", "DENY");
  r.headers.set("referrer-policy", "strict-origin-when-cross-origin");
  r.headers.set("cache-control", "no-store");
  r.headers.set("x-content-type-options", "nosniff");
  r.headers.set("strict-transport-security", "max-age=31536000");
  return r;
}

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
      // A Atos Cobranca: o aviso do Mercado Pago chega de fora (sem Origin; quem garante e a assinatura
      // HMAC); o resto e da propria pagina.
      if (ehRotaDaCobrancaV1(url)) {
        if (url.pathname !== "/api/mp/aviso" && !mesmaOrigem(request, url)) return json({ erro: "origem não permitida" }, 403);
        return comCabecalhos(await atenderCobrancaV1(request, env, url, { ctx }));
      }
      if (ehRotaDoGoogle(url)) return comCabecalhos(await atenderGoogle(request, env, url));
      if (ehRotaDoOIDC(url)) {
        if (url.pathname.startsWith("/api/") && !mesmaOrigem(request, url)) return json({ erro: "origem não permitida" }, 403);
        return comCabecalhos(await atenderOIDC(request, env, url, { dentroDoLimite }));
      }
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
    // O checkout de cada produto (public/<produto>/assinar/).
    if (/^\/[a-z0-9-]+\/assinar\/?$/.test(url.pathname)) {
      const r = await env.ASSETS.fetch(request);
      return (r.headers.get("content-type") || "").includes("text/html") ? comCspDoCheckout(r) : comCabecalhos(r);
    }
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
