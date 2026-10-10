// A conta PAVLVS por e-mail e senha (07/10/2026): a alternativa ao "Entrar com o
// Google" no site (assinatura, Minha conta) e no Paulus (assistente, trava da
// janela). Quem entra assim recebe um token assinado pelo proprio Worker, com
// o mesmo formato de resposta do id_token do Google ({sub, email}) - e por isso
// tudo o que hoje confere o dono (donoDoToken, em worker/tunel.js) aceita os
// dois sem mudar rota nenhuma.
//
//   POST /api/id/cadastrar  {email, senha, nome?}  manda um codigo de 6 digitos ao e-mail
//   POST /api/id/confirmar  {email, codigo}         cria a conta e devolve o token
//   POST /api/id/entrar     {email, senha}          devolve o token
//   POST /api/id/esqueci    {email}                 manda um codigo para trocar a senha
//   POST /api/id/redefinir  {email, codigo, senha}  troca a senha e devolve o token
//
// O e-mail e conferido pelo codigo antes de a conta existir. A senha fica so
// como PBKDF2-SHA256 (sal proprio, ITERACOES), no KV APOIOS ("id:conta:<email>").
// As respostas de cadastrar e esqueci sao sempre as mesmas, exista ou nao a
// conta: ninguem descobre por aqui quem tem conta. Errar a senha ou o codigo
// conta por e-mail: depois de TENTATIVAS, espera BLOQUEIO_S.
//
// O `sub`: se o mesmo e-mail ja entrou com o Google (o indice "id:google:<email>",
// anotado por donoDoToken), a conta por senha e a MESMA conta da nuvem (o mesmo
// sub). Senao, um sub novo "pv-<hex>". O e-mail confirmado pelo codigo e a prova
// de que a pessoa e dona dele - a mesma que o Google da.
//
// O token (HS256, chave ID_SEGREDO, segredo do Worker): {iss, aud, sub, email,
// name, iat, exp}, vale 1 hora, como o id_token do Google.

const ITERACOES = 30000;
const MIN_SENHA = 10;
const CODIGO_S = 15 * 60;
const TENTATIVAS = 8;
const BLOQUEIO_S = 15 * 60;
const TOKEN_S = 3600;
export const EMISSOR = "https://paulus.ia.br";
export const AUDIENCIA = "paulus";

export function ehRotaDaIdentidade(url) {
  return url.pathname.startsWith("/api/id/");
}

function json(dados, status = 200) {
  return new Response(JSON.stringify(dados), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

const te = new TextEncoder();
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const deHex = (s) => Uint8Array.from(String(s).match(/../g) || [], (x) => parseInt(x, 16));
function b64url(bytes) {
  let s = "";
  for (const x of new Uint8Array(bytes)) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function deB64url(s) {
  const b = atob(String(s).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((String(s).length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

export function emailValido(e) {
  return /^[^\s@<>"]{1,64}@[^\s@<>"]{1,180}\.[a-z]{2,}$/i.test(String(e || ""));
}
const normal = (e) => String(e || "").trim().toLowerCase();

async function sha256(texto) {
  return hex(await crypto.subtle.digest("SHA-256", te.encode(texto)));
}

async function resumoDaSenha(senha, sal, iteracoes = ITERACOES) {
  const chave = await crypto.subtle.importKey("raw", te.encode(String(senha)), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: deHex(sal), iterations: iteracoes }, chave, 256));
}

/* Comparacao em tempo constante de dois hex do mesmo tamanho. */
function iguais(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export function conferirSenha(senha) {
  const s = String(senha || "");
  if (s.length < MIN_SENHA) return "a senha precisa ter pelo menos " + MIN_SENHA + " caracteres";
  if (s.length > 200) return "a senha pode ter no máximo 200 caracteres";
  if (!/[a-zA-ZÀ-ÿ]/.test(s) || !/[0-9]/.test(s)) return "use letras e números na senha";
  return "";
}

const codigo6 = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0");

async function kv(env, chave) {
  try {
    return await env.APOIOS.get(chave, "json");
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ o token

async function chaveHMAC(env) {
  return crypto.subtle.importKey("raw", te.encode(String(env.ID_SEGREDO)), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function emitirToken(env, { sub, email, nome }, agora = Date.now()) {
  const cab = b64url(te.encode(JSON.stringify({ alg: "HS256", typ: "JWT", kid: "pv1" })));
  const s = Math.floor(agora / 1000);
  const corpo = b64url(te.encode(JSON.stringify({ iss: EMISSOR, aud: AUDIENCIA, sub, email, name: nome || "", email_verified: true, iat: s, exp: s + TOKEN_S })));
  const assinatura = await crypto.subtle.sign("HMAC", await chaveHMAC(env), te.encode(cab + "." + corpo));
  return cab + "." + corpo + "." + b64url(assinatura);
}

/* {sub, email, nome} de um token do PAVLVS valido; ou null. */
export async function donoDoTokenProprio(env, token, agora = Date.now()) {
  if (!env.ID_SEGREDO) return null;
  const partes = String(token || "").split(".");
  if (partes.length !== 3) return null;
  try {
    const cab = JSON.parse(new TextDecoder().decode(deB64url(partes[0])));
    if (cab.alg !== "HS256" || cab.kid !== "pv1") return null;
    const ok = await crypto.subtle.verify("HMAC", await chaveHMAC(env), deB64url(partes[2]), te.encode(partes[0] + "." + partes[1]));
    if (!ok) return null;
    const info = JSON.parse(new TextDecoder().decode(deB64url(partes[1])));
    if (info.iss !== EMISSOR || info.aud !== AUDIENCIA || !(Number(info.exp) * 1000 > agora) || !info.sub || !info.email) return null;
    return { sub: String(info.sub), email: normal(info.email), nome: String(info.name || "") };
  } catch {
    return null;
  }
}

/* O token e nosso (HS256 do PAVLVS)? Sem conferir a assinatura: so para escolher o caminho. */
export function ehTokenProprio(token) {
  try {
    const cab = JSON.parse(new TextDecoder().decode(deB64url(String(token).split(".")[0])));
    return cab.alg === "HS256" && cab.kid === "pv1";
  } catch {
    return false;
  }
}

// ------------------------------------------------ o id_token da conta Atos
//
// Desde 09/10/2026 a conta por e-mail e senha e a conta Atos: o site e o Paulus
// entram por "Entrar com Atos" (OpenID Connect em https://atos.dev.br, repo
// matheusuener-atos/matheusuener.com.br, worker/oidc.js) e recebem um id_token
// ES256. As contas sao as mesmas chaves "id:conta:<email>" deste KV, entao o
// sub e o mesmo que o token HS256 acima dava. A chave publica fica na var
// ATOS_JWKS (a lista de JWK que o tools/gerar-chave.mjs de la imprime): conferir
// nao pede nada a atos.dev.br.

export const ATOS_EMISSOR = "https://atos.dev.br";
export const ATOS_CLIENTES = ["pavlvs-site", "pavlvs-app"];

/* O token e da Atos (ES256 com kid)? Sem conferir a assinatura: so para escolher o caminho. */
export function ehTokenDaAtos(token) {
  try {
    const cab = JSON.parse(new TextDecoder().decode(deB64url(String(token).split(".")[0])));
    return cab.alg === "ES256" && typeof cab.kid === "string";
  } catch {
    return false;
  }
}

/* {sub, email, nome} de um id_token da Atos valido para o PAVLVS; ou null. */
export async function donoDoTokenDaAtos(env, token, agora = Date.now()) {
  const partes = String(token || "").split(".");
  if (partes.length !== 3 || String(token).length > 4096) return null;
  try {
    const cab = JSON.parse(new TextDecoder().decode(deB64url(partes[0])));
    const jwk = JSON.parse(env.ATOS_JWKS || "[]").find((k) => k && k.kid === cab.kid);
    if (cab.alg !== "ES256" || !jwk) return null;
    const chave = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    if (!(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, chave, deB64url(partes[2]), te.encode(partes[0] + "." + partes[1])))) return null;
    const info = JSON.parse(new TextDecoder().decode(deB64url(partes[1])));
    if (info.iss !== ATOS_EMISSOR || !ATOS_CLIENTES.includes(info.aud) || !(Number(info.exp) * 1000 > agora)) return null;
    if (info.email_verified !== true || !info.sub || !info.email) return null;
    return { sub: String(info.sub), email: normal(info.email), nome: String(info.name || "") };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------- as tentativas

async function bloqueado(env, email) {
  const e = await kv(env, "id:erros:" + email);
  return Boolean(e && e.n >= TENTATIVAS);
}
async function errou(env, email) {
  const e = (await kv(env, "id:erros:" + email)) || { n: 0 };
  await env.APOIOS.put("id:erros:" + email, JSON.stringify({ n: e.n + 1 }), { expirationTtl: BLOQUEIO_S });
}
const BLOQUEADO = "muitas tentativas erradas com este e-mail: espere 15 minutos e tente de novo";

// ---------------------------------------------------------------- as rotas

export async function atenderIdentidade(request, env, url, deps = {}) {
  if (request.method !== "POST") return json({ erro: "use POST" }, 405);
  if (!env.ID_SEGREDO || !env.APOIOS) return json({ erro: "a entrada com e-mail e senha ainda não está ligada" }, 503);
  if (deps.dentroDoLimite && !(await deps.dentroDoLimite(request, env))) return json({ erro: "muitas tentativas seguidas - espere um minuto" }, 429);
  const o = request.headers.get("origin");
  if (o && o !== url.origin && o !== EMISSOR) return json({ erro: "origem não permitida" }, 403);
  let d;
  try {
    d = await request.json();
  } catch {
    return json({ erro: "pedido inválido" }, 400);
  }
  const email = normal(d && d.email);
  if (!emailValido(email)) return json({ erro: "confira o e-mail" }, 400);
  const agora = (deps.agora || Date.now)();
  const mandar = deps.enviarEmail;
  const p = url.pathname;

  if (p === "/api/id/entrar") {
    if (await bloqueado(env, email)) return json({ erro: BLOQUEADO }, 429);
    const c = await kv(env, "id:conta:" + email);
    // Sem conta, o mesmo trabalho de conferir (o tempo nao entrega quem existe).
    const resumo = await resumoDaSenha(String(d.senha || ""), c ? c.sal : "00".repeat(16), c ? c.iteracoes : ITERACOES);
    if (!c || !iguais(resumo, c.hash)) {
      await errou(env, email);
      return json({ erro: "e-mail ou senha não conferem" }, 401);
    }
    await env.APOIOS.delete("id:erros:" + email);
    return json({ ok: true, token: await emitirToken(env, { sub: c.sub, email, nome: c.nome }, agora), email, nome: c.nome || "" });
  }

  if (p === "/api/id/cadastrar") {
    const falha = conferirSenha(d.senha);
    if (falha) return json({ erro: falha }, 400);
    if (await bloqueado(env, email)) return json({ erro: BLOQUEADO }, 429);
    const nome = String(d.nome || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 80);
    const existe = await kv(env, "id:conta:" + email);
    if (existe) {
      // Ja tem conta: avisa no e-mail (so o dono do e-mail le), e a resposta e a mesma.
      if (mandar) await mandar(env, { para: email, assunto: "Você já tem conta no PAVLVS", titulo: "Você já tem conta",
        texto: "Alguém tentou criar uma conta no PAVLVS com este e-mail, que já tem conta. Se foi você, entre com a sua senha ou use \"Esqueci a senha\". Se não foi, ignore este e-mail: nada mudou." });
      return json({ ok: true, enviado: true });
    }
    const sal = hex(crypto.getRandomValues(new Uint8Array(16)));
    const cod = codigo6();
    await env.APOIOS.put("id:pend:" + email, JSON.stringify({ sal, hash: await resumoDaSenha(d.senha, sal), iteracoes: ITERACOES, nome,
      codigo: await sha256("cod:" + email + ":" + cod), criado: new Date(agora).toISOString() }), { expirationTtl: CODIGO_S });
    if (!mandar) return json({ erro: "o envio de e-mail não está ligado" }, 503);
    const e = await mandar(env, { para: email, assunto: "Seu código do PAVLVS: " + cod, titulo: "Confirme o seu e-mail",
      texto: "O seu código para criar a conta no PAVLVS é " + cod + ". Ele vale 15 minutos.\n\nSe você não pediu, ignore este e-mail.", pre: "Código " + cod });
    if (e && e.ok === false) return json({ erro: e.erro || "o e-mail não saiu" }, 502);
    return json({ ok: true, enviado: true });
  }

  if (p === "/api/id/confirmar") {
    if (await bloqueado(env, email)) return json({ erro: BLOQUEADO }, 429);
    const pend = await kv(env, "id:pend:" + email);
    if (!pend || !iguais(await sha256("cod:" + email + ":" + String(d.codigo || "").trim()), pend.codigo)) {
      await errou(env, email);
      return json({ erro: pend ? "o código não confere" : "o código venceu: peça outro" }, 400);
    }
    // O mesmo e-mail ja entrou com o Google: a mesma conta da nuvem.
    const google = await kv(env, "id:google:" + email);
    const sub = google && google.sub ? String(google.sub) : "pv-" + hex(crypto.getRandomValues(new Uint8Array(12)));
    const conta = { sub, sal: pend.sal, hash: pend.hash, iteracoes: pend.iteracoes, nome: pend.nome, criada: new Date(agora).toISOString() };
    await env.APOIOS.put("id:conta:" + email, JSON.stringify(conta));
    await env.APOIOS.delete("id:pend:" + email);
    await env.APOIOS.delete("id:erros:" + email);
    return json({ ok: true, token: await emitirToken(env, { sub, email, nome: conta.nome }, agora), email, nome: conta.nome || "" });
  }

  if (p === "/api/id/esqueci") {
    const c = await kv(env, "id:conta:" + email);
    const google = c ? null : await kv(env, "id:google:" + email);
    if ((c || google) && mandar) {
      const cod = codigo6();
      await env.APOIOS.put("id:rec:" + email, JSON.stringify({ codigo: await sha256("rec:" + email + ":" + cod) }), { expirationTtl: CODIGO_S });
      await mandar(env, { para: email, assunto: "Código para trocar a senha do PAVLVS: " + cod, titulo: c ? "Trocar a senha" : "Criar uma senha",
        texto: "O seu código para " + (c ? "trocar a senha" : "criar uma senha para") + " da sua Conta Atos é " + cod + ". Ele vale 15 minutos.\n\nSe você não pediu, ignore este e-mail: a senha atual continua valendo.",
        pre: "Código " + cod });
    }
    return json({ ok: true, enviado: true });
  }

  if (p === "/api/id/redefinir") {
    const falha = conferirSenha(d.senha);
    if (falha) return json({ erro: falha }, 400);
    if (await bloqueado(env, email)) return json({ erro: BLOQUEADO }, 429);
    const rec = await kv(env, "id:rec:" + email);
    if (!rec || !iguais(await sha256("rec:" + email + ":" + String(d.codigo || "").trim()), rec.codigo)) {
      await errou(env, email);
      return json({ erro: rec ? "o código não confere" : "o código venceu: peça outro" }, 400);
    }
    const antes = await kv(env, "id:conta:" + email);
    const google = antes ? null : await kv(env, "id:google:" + email);
    const sub = antes ? antes.sub : google && google.sub ? String(google.sub) : "pv-" + hex(crypto.getRandomValues(new Uint8Array(12)));
    const sal = hex(crypto.getRandomValues(new Uint8Array(16)));
    const conta = { ...(antes || { criada: new Date(agora).toISOString(), nome: "" }), sub, sal, hash: await resumoDaSenha(d.senha, sal), iteracoes: ITERACOES, trocada: new Date(agora).toISOString() };
    await env.APOIOS.put("id:conta:" + email, JSON.stringify(conta));
    await env.APOIOS.delete("id:rec:" + email);
    await env.APOIOS.delete("id:erros:" + email);
    return json({ ok: true, token: await emitirToken(env, { sub, email, nome: conta.nome }, agora), email, nome: conta.nome || "" });
  }

  return json({ erro: "rota não existe" }, 404);
}

/* Anota o sub do Google de um e-mail (so na primeira vez): e por ele que a conta
   por senha com o mesmo e-mail cai na mesma conta da nuvem. */
export async function anotarGoogle(env, dono) {
  if (!env || !env.APOIOS || !dono || !dono.email) return;
  const chave = "id:google:" + dono.email;
  const ja = await kv(env, chave);
  if (!ja || ja.sub !== dono.sub) await env.APOIOS.put(chave, JSON.stringify({ sub: dono.sub }));
}
