// O certificado e a chave da NFS-e guardados CIFRADOS no Durable Object.
//
// AES-256-GCM com a chave mestra do segredo NFSE_CHAVE_MESTRA (32 bytes em
// base64; `npx wrangler secret put NFSE_CHAVE_MESTRA`, gerada uma vez com
// `openssl rand -base64 32`). O rótulo ("chave", "certificado") entra como
// dado associado: um cifrado não serve no lugar do outro. Sem a mestra, nada
// abre - e o banco do DO sozinho não revela a chave privada.
//
// Formato: "v1." + base64(iv de 12 bytes) + "." + base64(cifrado + tag).

import { b64 } from "./assinatura.js";

export class ErroCofre extends Error {}

export function deB64(texto) {
  const bin = atob(String(texto).replace(/\s+/g, ""));
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

const utf8 = new TextEncoder();
const chaves = new Map();

async function mestra(env) {
  const bruta = env && env.NFSE_CHAVE_MESTRA;
  if (!bruta) throw new ErroCofre("falta o segredo NFSE_CHAVE_MESTRA no Worker");
  if (chaves.has(bruta)) return chaves.get(bruta);
  let bytes;
  try {
    bytes = deB64(bruta);
  } catch {
    throw new ErroCofre("NFSE_CHAVE_MESTRA não é base64");
  }
  if (bytes.length !== 32) throw new ErroCofre("NFSE_CHAVE_MESTRA precisa de 32 bytes (openssl rand -base64 32)");
  const k = await crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  chaves.set(bruta, k);
  return k;
}

export async function cifrar(env, bytes, rotulo) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const c = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8.encode("nfse:" + rotulo) }, await mestra(env), bytes);
  return `v1.${b64(iv)}.${b64(c)}`;
}

export async function decifrar(env, texto, rotulo) {
  const partes = String(texto || "").split(".");
  if (partes.length !== 3 || partes[0] !== "v1") throw new ErroCofre("cifrado em formato desconhecido");
  try {
    const p = await crypto.subtle.decrypt({ name: "AES-GCM", iv: deB64(partes[1]), additionalData: utf8.encode("nfse:" + rotulo) },
      await mestra(env), deB64(partes[2]));
    return new Uint8Array(p);
  } catch {
    throw new ErroCofre("não consegui abrir o " + rotulo + " guardado (a NFSE_CHAVE_MESTRA mudou?)");
  }
}

/** PEM (ou base64 puro do DER) -> DER. `tipos`: os rótulos BEGIN aceitos. */
export function derDoPem(texto, tipos) {
  const t = String(texto || "").trim();
  const m = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/.exec(t);
  if (m) {
    if (!tipos.includes(m[1])) throw new ErroCofre(`esperava ${tipos.join(" ou ")}, veio ${m[1]}`);
    return deB64(m[2]);
  }
  if (!/^[A-Za-z0-9+/=\s]+$/.test(t)) throw new ErroCofre("o conteúdo não é PEM nem base64");
  return deB64(t);
}
