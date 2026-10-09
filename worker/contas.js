// A conta Atos: e-mail e senha, a sessao em atos.dev.br e as paginas /entrar e
// /conta. A conta e o proprio e-mail da pessoa (nenhum endereco @atos.dev.br e
// criado).
//
// As contas sao as mesmas que o PAVLVS criava por e-mail e senha desde
// 07/10/2026: o KV CONTAS e o mesmo namespace do KV APOIOS do Worker do PAVLVS
// (paulus.ia.br) e a chave e a mesma ("id:conta:<email>" -> {sub, sal, hash,
// iteracoes, nome, criada}). Por isso quem ja tinha conta PAVLVS por senha ja
// tem conta Atos, com o mesmo sub - e a assinatura do PAVLVS continua dela.
// Enquanto os PAULUS instalados nao atualizarem, o Worker do PAVLVS ainda
// atende /api/id/* com as mesmas chaves; o formato tem de ficar igual nos dois.
//
//   POST /api/entrar     {email, senha}          abre a sessao
//   POST /api/cadastrar  {email, senha, nome?}   manda um codigo de 6 digitos ao e-mail
//   POST /api/confirmar  {email, codigo}         cria a conta e abre a sessao
//   POST /api/esqueci    {email}                 manda um codigo para trocar a senha
//   POST /api/redefinir  {email, codigo, senha}  troca a senha e abre a sessao
//   POST /api/sair                               fecha a sessao deste navegador
//   GET  /api/eu                                 {conta: {email, nome} | null}
//
// A sessao: um segredo aleatorio no cookie __Host-atos (HttpOnly, Secure,
// SameSite=Lax), e no KV so o SHA-256 dele ("atos:sessao:<hash>"), 30 dias.
// As respostas de cadastrar e esqueci sao sempre as mesmas, exista ou nao a
// conta. Errar a senha ou o codigo conta por e-mail: depois de TENTATIVAS,
// espera BLOQUEIO_S.
//
// O sub: se o mesmo e-mail ja entrou no PAVLVS com o Google (o indice
// "id:google:<email>", anotado pelo Worker do PAVLVS), a conta nova usa aquele
// sub - e a mesma conta. Senao, um sub novo "pv-<hex>" (o prefixo ficou do
// PAVLVS; trocar mudaria o sub de quem ja tem conta).

import { aleatorio, deHex, emailValido, hex, iguais, json, kv, lerJson, limparNome, normal, sha256 } from "./comum.js";
import { enviarEmail } from "./email.js";

const ITERACOES = 30000;
const MIN_SENHA = 10;
const CODIGO_S = 15 * 60;
const TENTATIVAS = 8;
const BLOQUEIO_S = 15 * 60;
export const SESSAO_S = 30 * 24 * 3600;
export const COOKIE = "__Host-atos";

const te = new TextEncoder();

async function resumoDaSenha(senha, sal, iteracoes = ITERACOES) {
  const chave = await crypto.subtle.importKey("raw", te.encode(String(senha)), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: deHex(sal), iterations: iteracoes }, chave, 256));
}

export function conferirSenha(senha) {
  const s = String(senha || "");
  if (s.length < MIN_SENHA) return "a senha precisa ter pelo menos " + MIN_SENHA + " caracteres";
  if (s.length > 200) return "a senha pode ter no máximo 200 caracteres";
  if (!/[a-zA-ZÀ-ÿ]/.test(s) || !/[0-9]/.test(s)) return "use letras e números na senha";
  return "";
}

const codigo6 = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0");
const novoSub = () => "pv-" + hex(crypto.getRandomValues(new Uint8Array(12)));

// ---------------------------------------------------------------- a sessao

function lerCookie(request, nome) {
  for (const parte of (request.headers.get("cookie") || "").split(";")) {
    const i = parte.indexOf("=");
    if (i > 0 && parte.slice(0, i).trim() === nome) return parte.slice(i + 1).trim();
  }
  return "";
}

/* {sub, email, nome, auth_time} de quem esta com a sessao aberta neste navegador; ou null. */
export async function sessaoDe(request, env) {
  const segredo = lerCookie(request, COOKIE);
  if (!segredo || segredo.length > 100) return null;
  const s = await kv(env, "atos:sessao:" + (await sha256(segredo)));
  if (!s || !s.sub || !s.email) return null;
  // A conta pode ter trocado de nome; o sub e o e-mail nao mudam.
  const c = await kv(env, "id:conta:" + s.email);
  if (!c || c.sub !== s.sub) return null;
  // Senha trocada depois de a sessao abrir: a sessao cai (a troca fecha as outras).
  if (c.trocada && s.auth_time * 1000 < Date.parse(c.trocada) - 1000) return null;
  return { sub: s.sub, email: s.email, nome: c.nome || "", auth_time: s.auth_time };
}

async function abrirSessao(env, conta, agora) {
  const segredo = aleatorio(32);
  const auth_time = Math.floor(agora / 1000);
  await env.CONTAS.put("atos:sessao:" + (await sha256(segredo)), JSON.stringify({ sub: conta.sub, email: conta.email, auth_time }), { expirationTtl: SESSAO_S });
  return COOKIE + "=" + segredo + "; Path=/; Max-Age=" + SESSAO_S + "; HttpOnly; Secure; SameSite=Lax";
}

const cookieApagado = COOKIE + "=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax";

function comSessao(dados, cookie) {
  return json(dados, 200, { "set-cookie": cookie });
}

// ---------------------------------------------------------- as tentativas

async function bloqueado(env, email) {
  const e = await kv(env, "id:erros:" + email);
  return Boolean(e && e.n >= TENTATIVAS);
}
async function errou(env, email) {
  const e = (await kv(env, "id:erros:" + email)) || { n: 0 };
  await env.CONTAS.put("id:erros:" + email, JSON.stringify({ n: e.n + 1 }), { expirationTtl: BLOQUEIO_S });
}
const BLOQUEADO = "muitas tentativas erradas com este e-mail: espere 15 minutos e tente de novo";

// ---------------------------------------------------------------- as rotas

export function ehRotaDaConta(url) {
  return ["/api/entrar", "/api/cadastrar", "/api/confirmar", "/api/esqueci", "/api/redefinir", "/api/sair", "/api/eu"].includes(url.pathname);
}

export async function atenderConta(request, env, url, deps = {}) {
  const p = url.pathname;
  const agora = (deps.agora || Date.now)();
  const mandar = deps.enviarEmail || enviarEmail;

  if (p === "/api/eu") {
    const s = await sessaoDe(request, env);
    return json({ conta: s ? { email: s.email, nome: s.nome } : null });
  }
  if (request.method !== "POST") return json({ erro: "use POST" }, 405);

  if (p === "/api/sair") {
    const segredo = lerCookie(request, COOKIE);
    if (segredo) await env.CONTAS.delete("atos:sessao:" + (await sha256(segredo)));
    return json({ ok: true }, 200, { "set-cookie": cookieApagado });
  }

  if (deps.dentroDoLimite && !(await deps.dentroDoLimite(request, env))) return json({ erro: "muitas tentativas seguidas - espere um minuto" }, 429);
  const d = await lerJson(request);
  if (!d) return json({ erro: "pedido inválido" }, 400);
  const email = normal(d.email);
  if (!emailValido(email)) return json({ erro: "confira o e-mail" }, 400);

  if (p === "/api/entrar") {
    if (await bloqueado(env, email)) return json({ erro: BLOQUEADO }, 429);
    const c = await kv(env, "id:conta:" + email);
    // Sem conta, o mesmo trabalho de conferir (o tempo nao entrega quem existe).
    const resumo = await resumoDaSenha(String(d.senha || ""), c ? c.sal : "00".repeat(16), c ? c.iteracoes : ITERACOES);
    if (!c || !iguais(resumo, c.hash)) {
      await errou(env, email);
      return json({ erro: "e-mail ou senha não conferem" }, 401);
    }
    await env.CONTAS.delete("id:erros:" + email);
    return comSessao({ ok: true, conta: { email, nome: c.nome || "" } }, await abrirSessao(env, { sub: c.sub, email }, agora));
  }

  if (p === "/api/cadastrar") {
    const falha = conferirSenha(d.senha);
    if (falha) return json({ erro: falha }, 400);
    if (await bloqueado(env, email)) return json({ erro: BLOQUEADO }, 429);
    const nome = limparNome(d.nome);
    if (await kv(env, "id:conta:" + email)) {
      // Ja tem conta: avisa no e-mail (so o dono do e-mail le), e a resposta e a mesma.
      await mandar(env, { para: email, assunto: "Você já tem conta Atos", titulo: "Você já tem conta",
        texto: "Alguém tentou criar uma conta Atos com este e-mail, que já tem conta. Se foi você, entre com a sua senha ou use \"Esqueci a senha\" em atos.dev.br/entrar. Se não foi, ignore este e-mail: nada mudou." });
      return json({ ok: true, enviado: true });
    }
    const sal = hex(crypto.getRandomValues(new Uint8Array(16)));
    const cod = codigo6();
    await env.CONTAS.put("id:pend:" + email, JSON.stringify({ sal, hash: await resumoDaSenha(d.senha, sal), iteracoes: ITERACOES, nome,
      codigo: await sha256("cod:" + email + ":" + cod), criado: new Date(agora).toISOString() }), { expirationTtl: CODIGO_S });
    const e = await mandar(env, { para: email, assunto: "Seu código da Atos: " + cod, titulo: "Confirme o seu e-mail",
      texto: "O seu código para criar a conta Atos é " + cod + ". Ele vale 15 minutos.\n\nSe você não pediu, ignore este e-mail.", pre: "Código " + cod });
    if (e && e.ok === false) return json({ erro: e.erro || "o e-mail não saiu" }, 502);
    return json({ ok: true, enviado: true });
  }

  if (p === "/api/confirmar") {
    if (await bloqueado(env, email)) return json({ erro: BLOQUEADO }, 429);
    const pend = await kv(env, "id:pend:" + email);
    if (!pend || !iguais(await sha256("cod:" + email + ":" + String(d.codigo || "").trim()), pend.codigo)) {
      await errou(env, email);
      return json({ erro: pend ? "o código não confere" : "o código venceu: peça outro" }, 400);
    }
    // Criada por outro caminho enquanto o codigo andava (o PAVLVS antigo): entra nela.
    const ja = await kv(env, "id:conta:" + email);
    const google = ja ? null : await kv(env, "id:google:" + email);
    const conta = ja || { sub: google && google.sub ? String(google.sub) : novoSub(), sal: pend.sal, hash: pend.hash, iteracoes: pend.iteracoes, nome: pend.nome, criada: new Date(agora).toISOString() };
    if (!ja) await env.CONTAS.put("id:conta:" + email, JSON.stringify(conta));
    await env.CONTAS.delete("id:pend:" + email);
    await env.CONTAS.delete("id:erros:" + email);
    return comSessao({ ok: true, conta: { email, nome: conta.nome || "" } }, await abrirSessao(env, { sub: conta.sub, email }, agora));
  }

  if (p === "/api/esqueci") {
    const c = await kv(env, "id:conta:" + email);
    const google = c ? null : await kv(env, "id:google:" + email);
    if (c || google) {
      const cod = codigo6();
      await env.CONTAS.put("id:rec:" + email, JSON.stringify({ codigo: await sha256("rec:" + email + ":" + cod) }), { expirationTtl: CODIGO_S });
      await mandar(env, { para: email, assunto: "Código para " + (c ? "trocar a senha" : "criar a senha") + " da conta Atos: " + cod, titulo: c ? "Trocar a senha" : "Criar uma senha",
        texto: "O seu código para " + (c ? "trocar a senha" : "criar uma senha para") + " da conta Atos é " + cod + ". Ele vale 15 minutos.\n\nSe você não pediu, ignore este e-mail: a senha atual continua valendo.",
        pre: "Código " + cod });
    }
    return json({ ok: true, enviado: true });
  }

  if (p === "/api/redefinir") {
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
    const sub = antes ? antes.sub : google && google.sub ? String(google.sub) : novoSub();
    const sal = hex(crypto.getRandomValues(new Uint8Array(16)));
    const conta = { ...(antes || { criada: new Date(agora).toISOString(), nome: "" }), sub, sal, hash: await resumoDaSenha(d.senha, sal), iteracoes: ITERACOES, trocada: new Date(agora).toISOString() };
    await env.CONTAS.put("id:conta:" + email, JSON.stringify(conta));
    await env.CONTAS.delete("id:rec:" + email);
    await env.CONTAS.delete("id:erros:" + email);
    // A troca fecha as outras sessoes (sessaoDe confere "trocada"); esta abre agora.
    return comSessao({ ok: true, conta: { email, nome: conta.nome || "" } }, await abrirSessao(env, { sub, email }, agora));
  }

  return json({ erro: "rota não existe" }, 404);
}
