// O certificado A1 da NFS-e na Cloudflare: o mTLS que a Sefin exige.
//
// O Worker principal não apresenta certificado de cliente; quem apresenta é o
// Worker auxiliar paulus-nfse-mtls, pelo binding mtls_certificate (MTLS.md).
// A cada certificado novo instalado no painel (/admin › Notas fiscais):
//   1. POST /accounts/{CF_ACCOUNT_ID}/mtls_certificates  {ca:false, certificates, private_key, name}
//   2. PUT  /accounts/{CF_ACCOUNT_ID}/workers/scripts/paulus-nfse-mtls  (multipart: metadata +
//      index.js) com o binding {type: "mtls_certificate", name: "SEFIN", certificate_id}
//   3. DELETE /accounts/{CF_ACCOUNT_ID}/mtls_certificates/{o anterior}
// O script do auxiliar é worker/nfse-mtls/index.js (CODIGO_AUXILIAR, abaixo,
// é o mesmo texto; o teste confere).
//
// O token de API da Cloudflare (permissões Account › SSL and Certificates ›
// Edit e Account › Workers Scripts › Edit) é colado em Notas fiscais ›
// Parâmetros e fica no KV CIFRADO com a NFSE_CHAVE_MESTRA (cofre.js). Sem o
// token, o certificado é guardado assim mesmo e a tela diz que falta o token.
//
// No KV APOIOS (fora do prefixo "admin:nfse:", que é a lista de pagamentos):
//   admin:nfse-cf:token    o token, cifrado ("v1.<iv>.<cifrado>")
//   admin:nfse-cf:mtls     o mTLS em uso: {id, nome, documento, valido_ate, quando, script}
//   admin:nfse-cf:cadeia   os certificados da AC que vieram no .pfx (públicos)

import { cifrar, decifrar } from "./cofre.js";

export const CF_API = "https://api.cloudflare.com/client/v4";
export const SCRIPT_AUXILIAR = "paulus-nfse-mtls";
export const COMPATIBILIDADE = "2026-09-25";
const K_TOKEN = "admin:nfse-cf:token";
const K_MTLS = "admin:nfse-cf:mtls";
export const K_CADEIA = "admin:nfse-cf:cadeia";

export const COMO_CRIAR_TOKEN = "Cloudflare › My Profile › API Tokens › Create Token › Custom token, com as permissões " +
  "Account › SSL and Certificates › Edit e Account › Workers Scripts › Edit, só para a conta do PAVLVS.";

// GERADO de worker/nfse-mtls/index.js (o teste confere que é o mesmo texto).
export const CODIGO_AUXILIAR = "// O Worker auxiliar paulus-nfse-mtls (worker/nfse/MTLS.md). Só repassa à\n// Sefin/ADN o pedido que o Worker principal manda pelo service binding\n// SEFIN_MTLS, apresentando o certificado A1 do binding mtls_certificate SEFIN.\n// Sem rota pública: nenhuma rota e o *.workers.dev desligado.\n//\n// O painel (/admin › Notas fiscais › certificado) republica este script pela\n// API da Cloudflare a cada certificado novo, com o binding SEFIN apontando\n// para o mTLS recém-cadastrado (worker/nfse/mtls.js, CODIGO_AUXILIAR: o texto\n// de lá precisa ser igual a este arquivo; worker/teste-nfse-admin.mjs confere).\nconst HOSTS = [\"sefin.producaorestrita.nfse.gov.br\", \"adn.producaorestrita.nfse.gov.br\", \"sefin.nfse.gov.br\", \"adn.nfse.gov.br\"];\n\nexport default {\n  async fetch(req, env) {\n    let alvo = null;\n    try {\n      alvo = new URL(req.headers.get(\"x-nfse-url\") || \"\");\n    } catch {\n      alvo = null;\n    }\n    // x-nfse-nao-chegou: o pedido certamente não saiu (o emissor põe na fila sem consultar).\n    if (!alvo || alvo.protocol !== \"https:\" || !HOSTS.includes(alvo.hostname)) {\n      return new Response(\"destino recusado\", { status: 400, headers: { \"x-nfse-nao-chegou\": \"1\" } });\n    }\n    if (!env.SEFIN) return new Response(\"sem o certificado (binding SEFIN)\", { status: 503, headers: { \"x-nfse-nao-chegou\": \"1\" } });\n    const headers = { accept: \"application/json\" };\n    const tipo = req.headers.get(\"content-type\");\n    if (tipo) headers[\"content-type\"] = tipo;\n    const agente = req.headers.get(\"user-agent\");\n    if (agente) headers[\"user-agent\"] = agente;\n    return env.SEFIN.fetch(alvo.toString(), { method: req.method, headers, body: [\"GET\", \"HEAD\"].includes(req.method) ? undefined : req.body });\n  },\n};\n";

const utf8 = new TextEncoder();

function kvJSON(texto) {
  try {
    return texto ? JSON.parse(texto) : null;
  } catch {
    return null;
  }
}

/** Grava (ou, com "", apaga) o token. Devolve {ok} ou {erro}. */
export async function guardarTokenCf(env, token) {
  const t = String(token == null ? "" : token).trim();
  if (!t) {
    await env.APOIOS.delete(K_TOKEN);
    return { ok: true, token: false };
  }
  if (!/^[A-Za-z0-9_-]{30,120}$/.test(t)) return { erro: "isso não parece um token de API da Cloudflare (letras, números, _ e -, sem espaços)" };
  await env.APOIOS.put(K_TOKEN, await cifrar(env, utf8.encode(t), "token-cloudflare"));
  return { ok: true, token: true };
}

export async function tokenCf(env) {
  const guardado = env.APOIOS ? await env.APOIOS.get(K_TOKEN) : null;
  if (!guardado) return "";
  return new TextDecoder().decode(await decifrar(env, guardado, "token-cloudflare"));
}

/** O que a tela mostra: {token, conta, mtls, auxiliar, falta}. Nunca o token. */
export async function situacaoCf(env) {
  const token = Boolean(env.APOIOS && (await env.APOIOS.get(K_TOKEN)));
  const mtls = env.APOIOS ? kvJSON(await env.APOIOS.get(K_MTLS)) : null;
  let falta = "";
  if (!env.CF_ACCOUNT_ID) falta = "falta CF_ACCOUNT_ID no wrangler.jsonc";
  else if (!token) falta = "falta o token da Cloudflare (Parâmetros › Token da Cloudflare)";
  else if (!env.SEFIN_MTLS) falta = "falta o service binding SEFIN_MTLS (o Worker auxiliar paulus-nfse-mtls)";
  return { token, conta: env.CF_ACCOUNT_ID || "", mtls, auxiliar: SCRIPT_AUXILIAR, ligado_ao_auxiliar: Boolean(env.SEFIN_MTLS), falta, como_criar_token: COMO_CRIAR_TOKEN };
}

export function pemDaChave(pkcs8B64) {
  const limpo = String(pkcs8B64 || "").replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  return "-----BEGIN PRIVATE KEY-----\n" + limpo.replace(/(.{64})/g, "$1\n").replace(/\n$/, "") + "\n-----END PRIVATE KEY-----\n";
}

function juntarPem(...partes) {
  return partes.flat().filter(Boolean).map((p) => String(p).trim()).filter(Boolean).join("\n") + "\n";
}

async function chamarCf(f, token, metodo, caminho, corpo) {
  const init = { method: metodo, headers: { Authorization: "Bearer " + token } };
  if (corpo instanceof FormData) init.body = corpo;
  else if (corpo !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(corpo);
  }
  let r;
  try {
    r = await f(CF_API + caminho, init);
  } catch (e) {
    return { ok: false, status: 0, erro: "a API da Cloudflare não respondeu" };
  }
  let dados = null;
  try {
    dados = await r.json();
  } catch {
    dados = null;
  }
  const ok = r.ok && dados && dados.success !== false;
  const msg = dados && Array.isArray(dados.errors) && dados.errors.length ? dados.errors.map((e) => (e.code ? e.code + " " : "") + (e.message || "")).join("; ") : "";
  return { ok, status: r.status, dados, erro: ok ? "" : (msg || "HTTP " + r.status) };
}

/**
 * Cadastra o certificado na Cloudflare e republica o auxiliar com ele.
 * par: {certPem, cadeiaPem: [pem] | pem, chavePkcs8 (base64 do DER) | chavePem, documento, validoAte}
 * Devolve {ok, certificate_id, etapa?, erro?}. Não lança.
 */
export async function instalarMtls(env, par, { fetch: f = (...a) => fetch(...a), agora = () => new Date() } = {}) {
  if (!env.CF_ACCOUNT_ID) return { ok: false, etapa: "configuração", erro: "falta CF_ACCOUNT_ID no wrangler.jsonc" };
  let token;
  try {
    token = await tokenCf(env);
  } catch (e) {
    return { ok: false, etapa: "token", erro: e.message };
  }
  if (!token) return { ok: false, etapa: "token", falta_token: true, erro: "falta o token da Cloudflare (Parâmetros › Token da Cloudflare)" };
  const conta = encodeURIComponent(env.CF_ACCOUNT_ID);
  const doc = String(par.documento || "").replace(/\D/g, "");
  const quando = agora().toISOString();
  const nome = "nfse-" + (doc || "pavlvs") + "-" + quando.slice(0, 16).replace(/\D/g, "");
  const chavePem = par.chavePem || pemDaChave(par.chavePkcs8);
  // 1. o certificado (folha + cadeia) com a chave
  const up = await chamarCf(f, token, "POST", `/accounts/${conta}/mtls_certificates`,
    { ca: false, certificates: juntarPem(par.certPem, par.cadeiaPem || []), private_key: chavePem, name: nome });
  const id = up.ok && up.dados && up.dados.result && up.dados.result.id;
  if (!id) return { ok: false, etapa: "cadastrar o certificado na Cloudflare", erro: up.erro || "a Cloudflare não devolveu o id do certificado" };
  // 2. o auxiliar com o binding novo
  const fd = new FormData();
  const metadata = { main_module: "index.js", compatibility_date: COMPATIBILIDADE, bindings: [{ type: "mtls_certificate", name: "SEFIN", certificate_id: id }] };
  fd.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }), "metadata.json");
  fd.append("index.js", new Blob([CODIGO_AUXILIAR], { type: "application/javascript+module" }), "index.js");
  const pub = await chamarCf(f, token, "PUT", `/accounts/${conta}/workers/scripts/${SCRIPT_AUXILIAR}`, fd);
  if (!pub.ok) {
    // O certificado novo ficou órfão na Cloudflare: tira, para não acumular.
    await chamarCf(f, token, "DELETE", `/accounts/${conta}/mtls_certificates/${encodeURIComponent(id)}`);
    return { ok: false, etapa: "publicar o Worker auxiliar " + SCRIPT_AUXILIAR, erro: pub.erro };
  }
  // 3. o anterior sai (já não está em nenhum binding)
  const antes = kvJSON(await env.APOIOS.get(K_MTLS));
  let aviso = "";
  if (antes && antes.id && antes.id !== id) {
    const del = await chamarCf(f, token, "DELETE", `/accounts/${conta}/mtls_certificates/${encodeURIComponent(antes.id)}`);
    if (!del.ok && del.status !== 404) aviso = "o certificado anterior (" + antes.id + ") não saiu da Cloudflare: " + del.erro;
  }
  const estado = { id, nome, documento: doc, valido_ate: par.validoAte || "", quando, script: SCRIPT_AUXILIAR };
  await env.APOIOS.put(K_MTLS, JSON.stringify(estado));
  return { ok: true, certificate_id: id, aviso, mtls: estado };
}

/** O mTLS em uso é o deste certificado? (documento e validade iguais) */
export async function mtlsEhDeste(env, cert) {
  const m = kvJSON(await env.APOIOS.get(K_MTLS));
  return Boolean(m && cert && m.documento === String(cert.documento || "") && String(m.valido_ate || "").slice(0, 19) === String(cert.valido_ate || "").slice(0, 19));
}
