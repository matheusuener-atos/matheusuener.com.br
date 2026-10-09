// O que as outras partes do Worker da Atos usam: respostas, base64url, hash,
// comparacao em tempo constante, o KV e o limite por endereco de internet.

export const EMISSOR = "https://atos.dev.br";

const te = new TextEncoder();
export const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
export const deHex = (s) => Uint8Array.from(String(s).match(/../g) || [], (x) => parseInt(x, 16));

export function b64url(bytes) {
  let s = "";
  for (const x of new Uint8Array(bytes)) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function deB64url(s) {
  const b = atob(String(s).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((String(s).length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}
export const b64urlTexto = (texto) => b64url(te.encode(texto));

export async function sha256(texto) {
  return hex(await crypto.subtle.digest("SHA-256", te.encode(texto)));
}

/* Um segredo aleatorio de `n` bytes, em base64url. */
export const aleatorio = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));

/* Comparacao em tempo constante de dois textos do mesmo tamanho. */
export function iguais(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export function json(dados, status = 200, extra = {}) {
  return new Response(JSON.stringify(dados), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });
}

export async function lerJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export async function kv(env, chave) {
  try {
    return await env.CONTAS.get(chave, "json");
  } catch {
    return null;
  }
}

export async function dentroDoLimite(request, env) {
  if (!env.LIMITE) return true;
  const { success } = await env.LIMITE.limit({ key: request.headers.get("cf-connecting-ip") || "sem-ip" });
  return success;
}

export function emailValido(e) {
  return /^[^\s@<>"]{1,64}@[^\s@<>"]{1,180}\.[a-z]{2,}$/i.test(String(e || ""));
}
export const normal = (e) => String(e || "").trim().toLowerCase();
export const limparNome = (n) => String(n || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 80);
