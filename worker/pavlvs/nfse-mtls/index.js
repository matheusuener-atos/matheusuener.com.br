// O Worker auxiliar paulus-nfse-mtls (worker/nfse/MTLS.md). Só repassa à
// Sefin/ADN o pedido que o Worker principal manda pelo service binding
// SEFIN_MTLS, apresentando o certificado A1 do binding mtls_certificate SEFIN.
// Sem rota pública: nenhuma rota e o *.workers.dev desligado.
//
// O painel (/admin › Notas fiscais › certificado) republica este script pela
// API da Cloudflare a cada certificado novo, com o binding SEFIN apontando
// para o mTLS recém-cadastrado (worker/nfse/mtls.js, CODIGO_AUXILIAR: o texto
// de lá precisa ser igual a este arquivo; worker/teste-nfse-admin.mjs confere).
const HOSTS = ["sefin.producaorestrita.nfse.gov.br", "adn.producaorestrita.nfse.gov.br", "sefin.nfse.gov.br", "adn.nfse.gov.br"];

export default {
  async fetch(req, env) {
    let alvo = null;
    try {
      alvo = new URL(req.headers.get("x-nfse-url") || "");
    } catch {
      alvo = null;
    }
    // x-nfse-nao-chegou: o pedido certamente não saiu (o emissor põe na fila sem consultar).
    if (!alvo || alvo.protocol !== "https:" || !HOSTS.includes(alvo.hostname)) {
      return new Response("destino recusado", { status: 400, headers: { "x-nfse-nao-chegou": "1" } });
    }
    if (!env.SEFIN) return new Response("sem o certificado (binding SEFIN)", { status: 503, headers: { "x-nfse-nao-chegou": "1" } });
    const headers = { accept: "application/json" };
    const tipo = req.headers.get("content-type");
    if (tipo) headers["content-type"] = tipo;
    const agente = req.headers.get("user-agent");
    if (agente) headers["user-agent"] = agente;
    return env.SEFIN.fetch(alvo.toString(), { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : req.body });
  },
};
