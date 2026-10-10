// Entrada SÓ da prova (não é a do site: wrangler.jsonc continua com
// worker/index.js). Serve para duas medições sem mexer no Worker publicado:
//
//   tamanho do pacote com o emissor dentro:
//     npx wrangler deploy worker/nfse/entrada-prova.js --dry-run --outdir <pasta>
//   o emissor rodando no workerd de verdade (local, nada sobe):
//     npx wrangler dev worker/nfse/entrada-prova.js --port 8799
//     node worker/teste-nfse-prova.mjs --workerd http://127.0.0.1:8799
//
// POST /api/nfse-prova {pfx_b64, senha, xml_b64, id, algoritmo, nfse_b64?} devolve
// (com nfse_b64, o XML de uma NFS-e, gera também o DANFSe)
// {assinado_b64, gzip_b64, volta_ok, pdf_bytes, documento, titular}.
// Qualquer outro caminho vai para o Worker do site, como sempre.

import site from "../index.js";
export { ContaIA, EmissorNFSe } from "../index.js";
import { lerPfx } from "./pfx.js";
import { assinar, b64, importarChave } from "./assinatura.js";
import { deGzipB64, gzipB64 } from "./gzip.js";
import { gerarDanfse } from "./danfse.js";

function deB64(t) {
  const bin = atob(t);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname !== "/api/nfse-prova") return site.fetch(request, env, ctx);
    if (request.method !== "POST") return new Response("só POST", { status: 405 });
    try {
      const e = await request.json();
      const cert = lerPfx(deB64(e.pfx_b64), e.senha);
      const chave = await importarChave(cert.chavePkcs8, e.algoritmo || "sha1");
      const assinado = await assinar(deB64(e.xml_b64), chave, cert.certDer, e.id, e.algoritmo || "sha1");
      const bytes = new TextEncoder().encode(assinado);
      const gz = await gzipB64(bytes);
      const volta = await deGzipB64(gz);
      const pdf = e.nfse_b64 ? await gerarDanfse(deB64(e.nfse_b64)) : new Uint8Array(0);
      return Response.json({
        assinado_b64: b64(bytes), gzip_b64: gz, volta_ok: b64(volta) === b64(bytes),
        pdf_bytes: pdf.length, documento: cert.documento, titular: cert.titular,
      });
    } catch (exc) {
      return Response.json({ erro: String(exc && exc.message || exc) }, { status: 400 });
    }
  },
};
