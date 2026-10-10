// O acesso de fora (acesso-remoto/v0, R5): o Worker cria, na conta Cloudflare
// do Atos, o caminho de cada escritorio ate o PAULUS dele - tunel e DNS em
// <slug>.paulus.ia.br. O advogado nao cria conta, nao mexe em DNS e nao abre
// o painel da Cloudflare. SEM Cloudflare Access, em parte nenhuma: a
// seguranca de quem entra fica toda no PAULUS (Turnstile, senha e TOTP), e
// nenhuma vaga do Zero Trust e gasta por escritorio.
//
// O Worker cria o CAMINHO, nunca o conteudo: ele nao faz proxy de
// *.paulus.ia.br (esse trafego vai direto da Cloudflare ao tunel do
// escritorio) e nao ve documento nenhum. O unico dado que passa por aqui
// depois de conectado e o token do Turnstile do login, para ser conferido.
//
// O titular escolhe o nome, e a confirmacao e a de autorizacao de dispositivo:
//
//   GET  /api/tunel/disponivel?nome=  o nome esta livre? senao, uma sugestao
//   POST /api/tunel/iniciar           o PAULUS pede com o nome escolhido;
//                                     o nome fica reservado 15 min; volta um
//                                     codigo secreto e um codigo XXXX-XXXX
//   GET  /conectar?c=XXXX-XXXX        o titular confere o codigo e passa pelo
//                                     Turnstile - a barreira contra robo
//   POST /conectar                    confirma: tunel, ingress, DNS, token
//   POST /api/tunel/estado            o PAULUS pergunta a cada 3 s; recebe o
//                                     token do tunel UMA vez
//
// Depois, com o segredo da instalacao (Authorization: Bearer):
//
//   POST /api/tunel/turnstile  confere o token do Turnstile de um login
//   POST /api/tunel/porta      a porta do PAULUS mudou
//   GET  /api/tunel/situacao   o tunel esta conectado?
//   POST /api/tunel/remover    apaga DNS, tunel e registro; o nome fica livre
//   POST /api/tunel/dono       de que conta Google e este escritorio (id_token)
//   POST /api/tunel/cliente-email  o e-mail da Area do cliente (convite, codigo,
//                              mensagem nova): o texto e daqui, o PAULUS so
//                              manda o tipo e os campos
//
// O endereco e da conta Google que vinculou o PAULUS: POST /api/tunel/meus
// (com o id_token) lista os dela, e conectar com o mesmo id_token retoma um
// deles em outra instalacao.
//
// E, uma vez por dia (Cron Trigger), a limpeza: endereco que nunca conectou
// em 7 dias, ou parado ha mais de 180, e removido.
//
// Toda mudanca de endereco (criado, alterado, desativado, reativado,
// liberado) entra no registro de enderecos, que o painel admin mostra
// (registrarEndereco, mais abaixo): cada funcao que muda registra sozinha.
//
// Tudo atras de TUNEL_ATIVO === "1" e do KV ESCRITORIOS: sem os dois, as
// rotas respondem 404 e a limpeza nao faz nada. E isso que deixa este codigo
// ir ao ar no deploy de cada push sem ligar nada.
//
// Caminhos da API conferidos na documentacao da Cloudflare em 28/09/2026
// (docs/PROGRESSO-IMPLEMENTACAO.md, R5).

import { anotarGoogle, donoDoTokenDaAtos, donoDoTokenProprio, ehTokenDaAtos, ehTokenProprio } from "./identidade.js";
import { enviarEmail } from "./admin.js";

const API = "https://api.cloudflare.com/client/v4";
const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const DOMINIO = "paulus.ia.br";
const PEDIDO_TTL_S = 15 * 60;
const DIA_MS = 24 * 3600 * 1000;
const NUNCA_CONECTOU_DIAS = 7;
const PARADO_DIAS = 180;
// O que foi removido fica lembrado por mais de um ano: e assim que o PAULUS
// sabe dizer "o endereco foi liberado por falta de uso", e nao "segredo errado".
const LEMBRAR_REMOVIDO_S = 400 * 24 * 3600;
const RE_CODIGO_USUARIO = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;
const LETRAS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const RESERVADOS = new Set(["www", "api", "conectar", "admin", "suporte", "paulus", "atos", "app", "mail",
  "email", "smtp", "imap", "pop", "ftp", "ns1", "ns2", "contato", "status", "blog", "dev", "teste", "testes",
  "staging", "cdn", "static", "assets", "login", "entrar", "conta", "contas", "painel", "ajuda", "site",
  "oficial", "seguranca", "pagamento", "apoio", "apoiar", "loja"]);

// --------------------------------------------------------------- entrada

export function ehRotaDoTunel(url) {
  return url.pathname === "/conectar" || url.pathname.startsWith("/api/tunel/") || url.pathname === "/oauth/google";
}

export async function atenderTunel(request, env, url, { dentroDoLimite, agora = () => Date.now() } = {}) {
  if (env.TUNEL_ATIVO !== "1" || !env.ESCRITORIOS) return texto("rota não existe", 404);
  const p = url.pathname;
  const m = request.method;
  const limitado = async () => Boolean(dentroDoLimite) && !(await dentroDoLimite(request, env));
  if (p === "/api/tunel/disponivel" && m === "GET") {
    if (await limitado()) return json({ erro: "muitas tentativas seguidas - espere um minuto" }, 429);
    const dono = await donoDoToken(env, request.headers.get("x-paulus-google"), agora);
    return json(await disponibilidade(env, url.searchParams.get("nome"), url.searchParams.get("instalacao") || "", dono));
  }
  if (p === "/api/tunel/meus" && m === "POST") {
    if (await limitado()) return json({ erro: "muitas tentativas seguidas - espere um minuto" }, 429);
    return meus(request, env, agora);
  }
  if (p === "/api/tunel/iniciar" && m === "POST") {
    if (await limitado()) return json({ erro: "muitas tentativas seguidas - espere um minuto" }, 429);
    return iniciar(request, env, agora);
  }
  if (p === "/oauth/google" && m === "GET") return retornoDoGoogle(env, url);
  if (p === "/conectar" && m === "GET") return paginaConectar(env, url);
  if (p === "/conectar" && m === "POST") return confirmar(request, env, agora);
  if (p === "/api/tunel/estado" && m === "POST") return estadoDoPedido(request, env);
  if (p === "/api/tunel/turnstile" && m === "POST") return comSegredo(request, env, (e, d) => conferirTurnstile(env, e, d, agora));
  if (p === "/api/tunel/porta" && m === "POST") return comSegredo(request, env, (e, d) => trocarPorta(env, e, d));
  if (p === "/api/tunel/dono" && m === "POST") return comSegredo(request, env, (e, d) => definirDono(env, e, d, agora));
  if (p === "/api/tunel/cliente-email" && m === "POST") return comSegredo(request, env, (e, d) => emailDoCliente(env, e, d, agora));
  if (p === "/api/tunel/situacao" && m === "GET") return comSegredo(request, env, (e) => situacao(env, e, agora), false);
  if (p === "/api/tunel/remover" && m === "POST") return comSegredo(request, env, (e) => remover(env, e, "removido pelo escritório", { quando: agora }), false);
  return json({ erro: "rota não existe" }, 404);
}

// ------------------------------------------------------------- utilidades

// Entrar com o Google, na equipe de um escritorio (PAULUS, E3a): o Google
// so aceita enderecos de retorno cadastrados um a um, e cada escritorio tem o
// seu <slug>.paulus.ia.br. O retorno cadastrado e este; o `state` que o PAULUS
// mandou comeca pelo slug, e daqui a volta segue para o escritorio - com o
// mesmo codigo e o mesmo state, sem guardar nada. O codigo sozinho nao vale:
// a troca pede o verificador PKCE e o segredo, que ficam no PAULUS.
async function retornoDoGoogle(env, url) {
  const state = url.searchParams.get("state") || "";
  const slug = state.split("~")[0];
  if (!slug || motivoDoFormato(slug) || !(await env.ESCRITORIOS.get("escritorio:" + slug))) {
    return texto("este login não é de um escritório conectado ao Paulus", 400);
  }
  const destino = new URL("https://" + slug + "." + DOMINIO + "/api/acesso/google/retorno");
  for (const chave of ["code", "state", "error"]) {
    const v = url.searchParams.get(chave);
    if (v) destino.searchParams.set(chave, v);
  }
  return new Response(null, {
    status: 302, headers: { location: destino.toString(), "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
}

function json(dados, status = 200) {
  return new Response(JSON.stringify(dados), {
    status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function texto(t, status) {
  return new Response(t, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

function aleatorio(n) {
  return [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function resumo(valor) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(valor)));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function codigoUsuario() {
  const b = crypto.getRandomValues(new Uint8Array(8));
  const c = [...b].map((x) => LETRAS[x % LETRAS.length]).join("");
  return c.slice(0, 4) + "-" + c.slice(4);
}

function igual(a, b) {
  a = String(a || ""); b = String(b || "");
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function lerJSON(request) {
  try { return await request.json(); } catch (e) { return null; }
}

async function kvGet(env, chave) {
  const bruto = await env.ESCRITORIOS.get(chave);
  if (!bruto) return null;
  try { return JSON.parse(bruto); } catch (e) { return null; }
}

async function kvPut(env, chave, valor, ttl) {
  await env.ESCRITORIOS.put(chave, JSON.stringify(valor), ttl ? { expirationTtl: ttl } : undefined);
}

async function chamarCF(env, metodo, caminho, corpo) {
  const r = await fetch(API + caminho, {
    method: metodo,
    headers: { Authorization: "Bearer " + env.CF_API_TOKEN, "Content-Type": "application/json" },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  let dados = {};
  try { dados = await r.json(); } catch (e) { dados = {}; }
  if (!r.ok || dados.success === false) {
    const msg = (dados.errors && dados.errors[0] && dados.errors[0].message) || ("HTTP " + r.status);
    throw new Error(metodo + " " + caminho.replace(/\/accounts\/[^/]+|\/zones\/[^/]+/g, "") + ": " + msg);
  }
  return dados.result;
}

// ---------------------------------------------------------------- o nome

// O motivo, em linguagem de gente, de um nome nao servir - ou "" se serve.
export function motivoDoFormato(slug) {
  const s = String(slug || "");
  if (s.length < 3) return "use pelo menos 3 letras";
  if (s.length > 24) return "use no máximo 24 letras";
  if (!/^[a-z0-9-]+$/.test(s)) return "use só letras minúsculas sem acento, números e hífen";
  if (s.startsWith("-") || s.endsWith("-")) return "não comece nem termine com hífen";
  if (RESERVADOS.has(s)) return "esse nome é reservado";
  return "";
}

function limpar(bruto) {
  return String(bruto || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24).replace(/-+$/g, "");
}

// Tomado por um escritorio conectado, ou reservado por OUTRA instalacao que
// esta no meio da conexao.
async function tomado(env, slug, instalacao) {
  if (await env.ESCRITORIOS.get("escritorio:" + slug)) return true;
  const reserva = await kvGet(env, "reserva:" + slug);
  return Boolean(reserva && reserva.instalacao_id !== instalacao);
}

async function sugestao(env, slug, instalacao) {
  const base = (slug.replace(/-\d+$/, "").slice(0, 21).replace(/-+$/, "")) || "escritorio";
  for (let n = 2; n < 100; n++) {
    const s = base + "-" + n;
    if (!motivoDoFormato(s) && !(await tomado(env, s, instalacao))) return s;
  }
  return "";
}

export async function disponibilidade(env, nome, instalacao = "", dono = null) {
  const slug = String(nome || "").trim().toLowerCase();
  const motivo = motivoDoFormato(slug);
  if (motivo) {
    const limpo = limpar(slug);
    let alternativa = "";
    if (limpo.length >= 3 && !motivoDoFormato(limpo) && !(await tomado(env, limpo, instalacao))) alternativa = limpo;
    else alternativa = await sugestao(env, limpo.length >= 3 ? limpo : "escritorio", instalacao);
    return { disponivel: false, motivo, sugestao: alternativa };
  }
  if (dono && mesmoDono(await kvGet(env, "escritorio:" + slug), dono)) {
    // O endereco e desta conta Google, de outra instalacao (ou de antes de
    // reinstalar): conectar de novo o retoma - o PAULUS antigo e desligado.
    return { disponivel: true, retomar: true, motivo: "", sugestao: "" };
  }
  if (await tomado(env, slug, instalacao)) {
    return { disponivel: false, motivo: "esse endereço já está em uso", sugestao: await sugestao(env, slug, instalacao),
      em_uso: true };
  }
  return { disponivel: true, motivo: "", sugestao: "" };
}

// ------------------------------------------------------------- iniciar

async function iniciar(request, env, agora) {
  const d = await lerJSON(request);
  if (!d) return json({ erro: "pedido inválido" }, 400);
  const nome = String(d.nome_escritorio || "").trim().replace(/\s+/g, " ");
  const slug = String(d.slug || "").trim().toLowerCase();
  const instalacao = String(d.instalacao_id || "");
  const porta = Number(d.porta);
  if (nome.length < 2 || nome.length > 80) return json({ erro: "diga o nome do escritório (2 a 80 letras)" }, 400);
  if (!/^[A-Za-z0-9-]{8,64}$/.test(instalacao)) return json({ erro: "instalação inválida" }, 400);
  if (!Number.isInteger(porta) || porta < 1024 || porta > 65535) return json({ erro: "porta inválida" }, 400);
  // A conta Google de quem conecta (o PAULUS manda o id_token do vinculo).
  // Sem ele, o endereco nasce sem dono - o PAULUS de antes desta versao.
  const dono = d.id_token ? await donoDoToken(env, d.id_token, agora) : null;
  if (d.id_token && !dono) return json({ erro: "a confirmação do Google venceu: entre com o Google de novo" }, 401);
  const disp = await disponibilidade(env, slug, instalacao, dono);
  if (!disp.disponivel) return json({ erro: disp.motivo, sugestao: disp.sugestao }, 409);
  if (await env.ESCRITORIOS.get("instalacao:" + instalacao)) {
    return json({ erro: "esta instalação do Paulus já tem acesso externo: remova antes de conectar de novo" }, 409);
  }
  const limite = Number(env.MAX_ESCRITORIOS || 0);
  if (limite && !disp.retomar && (await contarEscritorios(env)) >= limite) {
    return json({ erro: "o acesso externo chegou ao limite de escritórios desta fase. Escreva para contato@paulus.ia.br para entrar na lista." }, 503);
  }

  const dispositivo = aleatorio(32);
  let usuario = codigoUsuario();
  for (let i = 0; i < 5 && (await env.ESCRITORIOS.get("usuario:" + usuario)); i++) usuario = codigoUsuario();
  const h = await resumo(dispositivo);
  const expira = agora() + PEDIDO_TTL_S * 1000;
  // O nome fica guardado para esta instalacao enquanto o pedido vale: outro
  // escritorio que escolher o mesmo nome nesses 15 minutos ve "em uso".
  await kvPut(env, "reserva:" + slug, { instalacao_id: instalacao, expira }, PEDIDO_TTL_S);
  await kvPut(env, "pedido:" + h, { estado: "pendente", codigo_usuario: usuario, slug, nome, instalacao_id: instalacao, porta, expira,
    dono, retomar: Boolean(disp.retomar) }, PEDIDO_TTL_S);
  await kvPut(env, "usuario:" + usuario, { pedido: h }, PEDIDO_TTL_S);
  return json({
    codigo_dispositivo: dispositivo,
    codigo_usuario: usuario,
    retomar: Boolean(disp.retomar),
    url: "https://" + DOMINIO + "/conectar?c=" + usuario,
    expira_em: new Date(expira).toISOString(),
  });
}

async function contarEscritorios(env) {
  let total = 0, cursor;
  do {
    const lista = await env.ESCRITORIOS.list({ prefix: "escritorio:", cursor });
    total += lista.keys.length;
    cursor = lista.list_complete ? undefined : lista.cursor;
  } while (cursor);
  return total;
}

// ------------------------------------------------------------ Turnstile

// Confere um token do Turnstile na Cloudflare. `hostname` e onde o desafio
// tem de ter sido resolvido: paulus.ia.br, na pagina de conectar; o endereco
// do escritorio, no login de cada PAULUS - um token resolvido no endereco de
// outro escritorio nao vale. Um token so vale uma vez e por 5 minutos.
// Um widget so, com paulus.ia.br na lista de hostnames, vale para todos os
// subdominios (documentacao do Turnstile, 28/09/2026).
export async function turnstileValido(env, token, hostname, ip) {
  const t = String(token || "");
  if (!t || t.length > 2048 || !env.TURNSTILE_SECRET) return false;
  const corpo = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: t });
  if (ip) corpo.set("remoteip", String(ip));
  try {
    const r = await fetch(SITEVERIFY, { method: "POST", body: corpo });
    const d = await r.json();
    return Boolean(d && d.success === true && String(d.hostname || "").toLowerCase() === hostname);
  } catch (e) {
    return false;
  }
}

// ------------------------------------------------ o dono (a conta Google)

// O endereco pertence a conta Google que vinculou o PAULUS (E5), e nao so a
// instalacao: reinstalou, trocou de computador, perdeu os dados - a mesma
// conta retoma o mesmo endereco. A prova e o id_token do Google, assinado por
// ele, que o PAULUS recebe no login do vinculo (vale 1 hora). Daqui so fica
// o `sub` (o numero da conta no Google) e o e-mail.
const GOOGLE_CERTS = "https://www.googleapis.com/oauth2/v3/certs";
let chavesDoGoogle = { em: 0, chaves: null };

function b64url(s) {
  const b = atob(String(s).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((String(s).length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

async function chaveDoGoogle(kid, agora) {
  if (!chavesDoGoogle.chaves || agora() - chavesDoGoogle.em > 3600 * 1000 || !chavesDoGoogle.chaves.some((k) => k.kid === kid)) {
    const r = await fetch(GOOGLE_CERTS);
    const d = await r.json();
    chavesDoGoogle = { em: agora(), chaves: Array.isArray(d.keys) ? d.keys : [] };
  }
  return chavesDoGoogle.chaves.find((k) => k.kid === kid) || null;
}

// { sub, email } de um id_token valido para um dos clientes do PAULUS; ou null.
// Vale tambem o token da conta PAVLVS por e-mail e senha (worker/identidade.js),
// assinado pelo proprio Worker. O sub do Google fica anotado pelo e-mail, para
// a conta por senha com o mesmo e-mail cair na mesma conta da nuvem.
export async function donoDoToken(env, token, agora = () => Date.now()) {
  const t = String(token || "");
  if (ehTokenProprio(t)) {
    const d = await donoDoTokenProprio(env, t, agora());
    return d ? { sub: d.sub, email: d.email } : null;
  }
  if (ehTokenDaAtos(t)) {
    const d = await donoDoTokenDaAtos(env, t, agora());
    return d ? { sub: d.sub, email: d.email } : null;
  }
  const dono = await donoDoGoogle(env, t, agora);
  if (dono) {
    try {
      await anotarGoogle(env, dono);
    } catch {
      // o indice e so uma ajuda: sem ele, a conta por senha nasce com um sub proprio
    }
  }
  return dono;
}

async function donoDoGoogle(env, t, agora) {
  const partes = t.split(".");
  if (partes.length !== 3 || t.length > 4096) return null;
  try {
    const cab = JSON.parse(new TextDecoder().decode(b64url(partes[0])));
    const info = JSON.parse(new TextDecoder().decode(b64url(partes[1])));
    if (cab.alg !== "RS256") return null;
    const jwk = await chaveDoGoogle(cab.kid, agora);
    if (!jwk) return null;
    const chave = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", chave, b64url(partes[2]),
      new TextEncoder().encode(partes[0] + "." + partes[1]));
    if (!ok) return null;
    const clientes = String(env.GOOGLE_CLIENT_IDS || "").split(",").map((x) => x.trim()).filter(Boolean);
    if (!["accounts.google.com", "https://accounts.google.com"].includes(info.iss)) return null;
    if (!clientes.includes(info.aud)) return null;
    if (!(Number(info.exp) * 1000 > agora())) return null;
    if (info.email_verified !== true && info.email_verified !== "true") return null;
    if (!info.sub || !info.email) return null;
    return { sub: String(info.sub), email: String(info.email).toLowerCase() };
  } catch (e) {
    return null;
  }
}

function mesmoDono(registro, dono) {
  return Boolean(dono && registro && registro.dono && registro.dono.sub === dono.sub);
}

async function enderecosDoDono(env, dono) {
  if (!dono) return [];
  const indice = (await kvGet(env, "dono:" + dono.sub)) || { slugs: [] };
  const lista = [];
  for (const slug of indice.slugs || []) {
    const r = await kvGet(env, "escritorio:" + slug);
    if (mesmoDono(r, dono)) lista.push({ slug, nome: r.nome || "", ultima_conexao: r.ultima_conexao || null });
  }
  return lista;
}

async function anotarDono(env, slug, dono) {
  if (!dono) return;
  const indice = (await kvGet(env, "dono:" + dono.sub)) || { slugs: [] };
  if (!indice.slugs.includes(slug)) await kvPut(env, "dono:" + dono.sub, { slugs: [...indice.slugs, slug] });
}

async function esquecerDono(env, registro) {
  if (!registro || !registro.dono) return;
  const indice = await kvGet(env, "dono:" + registro.dono.sub);
  if (!indice) return;
  const slugs = (indice.slugs || []).filter((s) => s !== registro.slug);
  if (slugs.length) await kvPut(env, "dono:" + registro.dono.sub, { slugs });
  else await env.ESCRITORIOS.delete("dono:" + registro.dono.sub);
}

// Os enderecos desta conta Google (o PAULUS mostra "retomar").
async function meus(request, env, agora) {
  const d = await lerJSON(request);
  const dono = await donoDoToken(env, d && d.id_token, agora);
  if (!dono) return json({ erro: "confirme a conta Google de novo" }, 401);
  return json({ email: dono.email, enderecos: await enderecosDoDono(env, dono) });
}

// Um PAULUS ja conectado diz de que conta Google ele e (os conectados antes
// disso, e a cada vinculo novo).
async function definirDono(env, registro, dados, agora) {
  const dono = await donoDoToken(env, dados.id_token, agora);
  if (!dono) return json({ erro: "confirme a conta Google de novo" }, 401);
  if (registro.dono && registro.dono.sub !== dono.sub) await esquecerDono(env, registro);
  await kvPut(env, "escritorio:" + registro.slug, { ...registro, dono });
  await anotarDono(env, registro.slug, dono);
  return json({ ok: true, email: dono.email });
}

// ---------------------------------------------------------- conectar

async function pedidoDoCodigo(env, codigo) {
  const c = String(codigo || "").trim().toUpperCase();
  if (!RE_CODIGO_USUARIO.test(c)) return null;
  const u = await kvGet(env, "usuario:" + c);
  if (!u) return null;
  const pedido = await kvGet(env, "pedido:" + u.pedido);
  return pedido ? { hash: u.pedido, pedido } : null;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// As paginas do Worker nos desenhos "Tunel - 01" a "08" (telas revisadas,
// 07/10/2026): o layout do assistente de configuracao - a topbar do site, o
// texto a esquerda e o painel de 440 px a direita, centralizados, sem rolagem
// - e as acoes num rodape de fio recuado (a dica a esquerda, o botao a
// direita), montado aqui no servidor. Escuro por padrao; o botao do canto
// troca e lembra (o mesmo "paulus.tema" do programa). As fontes sao as do site.

// O script da pagina: o tema e, com o Turnstile, o selo proprio da Cloudflare
// (verificando, sucesso, de novo) no lugar do widget, que so aparece se pedir
// interacao ("interaction-only"); o Confirmar so destrava com o token. Vai na
// CSP pelo hash - nenhum outro script inline roda.
const SCRIPT_PAGINA = `(function(){var d=document.documentElement,t="escuro";try{var g=localStorage.getItem("paulus.tema");if(g==="claro"||g==="escuro")t=g}catch(e){}d.dataset.tema=t;
var SOL='<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M12 17q-2.08 0-3.54-1.46Q7 14.08 7 12t1.46-3.54Q9.92 7 12 7t3.54 1.46Q17 9.92 17 12t-1.46 3.54Q14.08 17 12 17ZM2 13v-2h3v2H2Zm17 0v-2h3v2h-3ZM11 5V2h2v3h-2Zm0 17v-3h2v3h-2ZM6.35 7.75 4.5 5.9l1.4-1.4 1.85 1.85-1.4 1.4Zm11.75 11.75-1.85-1.85 1.4-1.4 1.85 1.85-1.4 1.4Zm-1.85-13.15L18.1 4.5l1.4 1.4-1.85 1.85-1.4-1.4ZM4.5 18.1l1.85-1.85 1.4 1.4L5.9 19.5l-1.4-1.4Z"/></svg>';
var LUA='<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M12 21q-3.75 0-6.37-2.63Q3 15.75 3 12t2.63-6.37Q8.25 3 12 3q.35 0 .69.02.34.03.66.08-1.03.72-1.64 1.89Q11.1 6.15 11.1 7.5q0 2.25 1.58 3.83Q14.25 12.9 16.5 12.9q1.38 0 2.53-.61 1.16-.61 1.87-1.64.05.33.08.66Q21 11.65 21 12q0 3.75-2.63 6.37Q15.75 21 12 21Z"/></svg>';
function selo(estado,texto){var s=document.getElementById("cf-badge"),t=document.getElementById("cf-texto"),b=document.getElementById("confirmar");if(s)s.dataset.estado=estado;if(t)t.textContent=texto;if(b)b.disabled=estado!=="ok"}
var robo=null;function desenharRobo(){var el=document.getElementById("robo");if(!window.turnstile)return;if(!el){if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",desenharRobo,{once:true});return}if(robo!==null){window.turnstile.remove(robo)}
selo("verificando","Verificando…");
robo=window.turnstile.render(el,{sitekey:el.dataset.sitekey,language:"pt-br",appearance:"interaction-only",theme:d.dataset.tema==="escuro"?"dark":"light",
callback:function(){selo("ok","Sucesso!")},"error-callback":function(){selo("erro","Tente de novo")},"expired-callback":function(){selo("verificando","Verificando…");desenharRobo()}})}
document.addEventListener("DOMContentLoaded",function(){var s=document.getElementById("cf-badge");if(!s)return;s.addEventListener("click",function(e){if(s.dataset.estado!=="erro"||e.target.closest("a"))return;desenharRobo()})});
window.paulusRobo=desenharRobo;
document.addEventListener("DOMContentLoaded",function(){var b=document.getElementById("tema");if(!b)return;
var pintar=function(){b.innerHTML=d.dataset.tema==="escuro"?SOL:LUA};pintar();
b.addEventListener("click",function(){d.dataset.tema=d.dataset.tema==="escuro"?"claro":"escuro";try{localStorage.setItem("paulus.tema",d.dataset.tema)}catch(e){}pintar();desenharRobo()})})})();`;
let hashDoScript = "";

async function hashScript() {
  if (!hashDoScript) {
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(SCRIPT_PAGINA));
    hashDoScript = "'sha256-" + btoa(String.fromCharCode(...new Uint8Array(d))) + "'";
  }
  return hashDoScript;
}

// A tabela do painel: rotulo e valor, uma linha cada.
function linhas(pares) {
  return '<div class="linhas">' + pares.map(([r, v]) => `<div class="linha"><span class="r">${r}</span><span>${v}</span></div>`).join("") + "</div>";
}

// O selo da verificacao contra robos, no lugar do widget do Turnstile: o
// estado (verificando, sucesso, tente de novo), a marca e os links da Cloudflare.
const SELO = '<div class="cf-badge" id="cf-badge" data-estado="verificando" role="status" aria-live="polite"><span class="cf-esq"><span class="cf-icone">' +
  '<svg class="cf-v" viewBox="0 0 24 24" aria-hidden="true"><path d="m9.55 18-5.7-5.7 1.43-1.42 4.27 4.27 9.17-9.18 1.43 1.43Z"></path></svg>' +
  '<svg class="cf-x" viewBox="0 0 24 24" aria-hidden="true"><path d="M6.4 19 5 17.6 10.6 12 5 6.4 6.4 5l5.6 5.6L17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6Z"></path></svg>' +
  '</span><span id="cf-texto">Verificando…</span></span><span class="cf-dir"><span class="cf-marca">CLOUDFLARE</span><span class="cf-links">' +
  '<a href="https://www.cloudflare.com/privacypolicy/" target="_blank" rel="noopener">Privacidade</a> · ' +
  '<a href="https://www.cloudflare.com/website-terms/" target="_blank" rel="noopener">Termos</a></span></span></div>';

// O botao principal (o trilho e, dentro, a pastilha) como link.
const link = (texto, href) => `<a class="principal" href="${esc(href)}"><span>${texto}</span></a>`;

// A moldura de toda pagina: a topbar do site (a marca e o tema), o texto a
// esquerda, o painel a direita e o rodape com a dica e o botao (`acao`). Sem
// painel, o texto fica sozinho na coluna da esquerda; sem dica nem botao, sem rodape.
async function pagina(titulo, { rotulo, h1, texto = "", nota = "", painel = "", dica = "", acao = "" }, status = 200, comTurnstile = false) {
  const pe = dica || acao
    ? `<footer class="pe">${dica ? `<span class="pe-dica">${dica}</span>` : ""}${acao ? `<span class="pe-acoes">${acao}</span>` : ""}</footer>`
    : "";
  const html = `<!doctype html><html lang="pt-BR" data-tema="escuro"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(titulo)} — PAVLVS</title><link rel="icon" href="/favicon.ico" sizes="any"><link rel="icon" type="image/png" href="/assets/favicon-32.png">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,400;0,500;1,400&family=Manrope:wght@400;500;600&family=Fira+Code:wght@400;500&display=swap">
<script>${SCRIPT_PAGINA}</script>
${comTurnstile ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=paulusRobo" async defer></script>' : ""}<style>
[data-tema="claro"]{--bg:#f6f5f1;--panel:#efeee9;--pill:#e2e1db;--pill-h:#dad9d2;--ink:#1c1c1a;--ink2:#55544f;--ink3:#77766f;--line:rgba(28,28,26,.12);--line2:rgba(28,28,26,.25);color-scheme:light}
[data-tema="escuro"]{--bg:#131312;--panel:#1a1a18;--pill:#2a2a27;--pill-h:#303030;--ink:#f2f1ec;--ink2:#a8a69e;--ink3:#6f6e68;--line:rgba(242,241,236,.1);--line2:rgba(242,241,236,.2);color-scheme:dark}
*{box-sizing:border-box}html,body{margin:0;min-height:100%}
body{height:100vh;height:100dvh;display:flex;flex-direction:column;overflow:auto;background:var(--bg);color:var(--ink);font-family:Manrope,system-ui,-apple-system,"Segoe UI",sans-serif;
font-size:16px;line-height:1.6;-webkit-font-smoothing:antialiased}
a{color:inherit}.mono{font-family:"Fira Code",ui-monospace,monospace}.serif{font-family:"EB Garamond",Georgia,serif}
header{flex:none;padding:0 28px;min-height:56px;display:flex;align-items:center;justify-content:space-between;gap:12px 24px;border-bottom:1px solid var(--line)}
.marca{font-size:20px;letter-spacing:.12em;font-weight:400;line-height:1;text-decoration:none}
.topo{display:flex;align-items:center;gap:18px}
.tema{width:32px;height:32px;margin-right:-8px;border:0;border-radius:8px;background:transparent;color:var(--ink3);display:flex;align-items:center;justify-content:center;cursor:pointer;padding:0}
.tema:hover{color:var(--ink)}
/* O miolo cresce ate o rodape e nunca encolhe abaixo do conteudo: na tela
   pequena a pagina rola, e o rodape vem depois dele, sem ficar por cima. */
main{flex:1 0 auto;width:100%;padding:32px clamp(24px,5vw,64px) 48px;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:clamp(28px,5vw,72px);align-items:center}
.texto{min-width:0;display:grid;gap:18px;align-content:center;max-width:580px}
.rotulo{display:flex;align-items:center;font:400 12px "Fira Code",ui-monospace,monospace;letter-spacing:.18em;text-transform:uppercase;color:var(--ink3)}
h1{margin:0;font-weight:400;font-size:clamp(32px,3.6vw,46px);line-height:1.05;text-wrap:balance}
.texto p{margin:0;font-size:14px;line-height:1.6;color:var(--ink2);text-wrap:pretty;max-width:560px}
.texto p b{color:var(--ink);font-weight:600}
.nota{font-size:13px;line-height:1.55;color:var(--ink3)}
.painel{width:100%;max-width:440px;justify-self:center;min-width:0;display:grid;gap:14px}
form{display:grid;gap:14px;margin:0}
.linhas{display:grid;border:1px solid var(--line);border-radius:12px;background:var(--panel);overflow:hidden}
.linha{display:grid;grid-template-columns:110px minmax(0,1fr);gap:12px;align-items:baseline;padding:10px 12px;border-top:1px solid var(--line);font-size:14px}
.linha:first-child{border-top:0}
.linha .r{font:400 12px "Fira Code",ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase;color:var(--ink3)}.linha b{font-weight:500}
.linha .end{font-family:"Fira Code",ui-monospace,monospace;font-size:13px;word-break:break-all}
.bloco{display:grid;gap:8px;padding:12px 14px;border:1px solid var(--line);border-radius:12px;background:var(--panel)}
.etiqueta{font:400 12px "Fira Code",ui-monospace,monospace;letter-spacing:.18em;text-transform:uppercase;color:var(--ink3)}
.codigo{font:400 32px/1.1 "Fira Code",ui-monospace,monospace;letter-spacing:.18em}
.ajuda{margin:0;font-size:14px;line-height:1.6;color:var(--ink2);text-wrap:pretty}
.detalhe{font-family:"Fira Code",ui-monospace,monospace;font-size:13px;color:var(--ink2);word-break:break-all}
/* O widget do Turnstile fica escondido (interaction-only): so aparece aqui se pedir interacao. */
.robo{display:flex;justify-content:center}
.cf-badge{display:flex;align-items:center;justify-content:space-between;height:52px;padding:0 14px;border-radius:12px;background:var(--bg);border:1px solid var(--line)}
.cf-esq{display:flex;align-items:center;gap:10px;font:500 14px Manrope,system-ui,sans-serif;color:var(--ink)}
.cf-icone{width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex:none;transition:background .24s,transform .24s cubic-bezier(.2,.8,.2,1)}
.cf-icone svg{width:15px;height:15px;fill:#fff;opacity:0;transition:opacity .2s .12s}
.cf-dir{display:grid;justify-items:end;gap:2px;text-align:right}
.cf-marca{font:700 12px Manrope,system-ui,sans-serif;letter-spacing:.12em;color:var(--ink)}
.cf-links{font:400 12px Manrope,system-ui,sans-serif;color:var(--ink3)}.cf-links a{color:inherit;text-decoration:none}
.cf-badge[data-estado="verificando"] .cf-icone{border:2px solid var(--line);border-top-color:var(--ink);animation:cf-gira .9s linear infinite}
.cf-badge[data-estado="ok"] .cf-icone{background:#2f9e5b;animation:cf-surge .24s cubic-bezier(.2,.8,.2,1)}
.cf-badge[data-estado="erro"]{cursor:pointer}.cf-badge[data-estado="erro"] .cf-icone{background:#b84a3c}
.cf-badge:is([data-estado="ok"],[data-estado="erro"]) .cf-icone svg{opacity:1}
.cf-badge .cf-x{display:none}.cf-badge[data-estado="erro"] .cf-x{display:block}.cf-badge[data-estado="erro"] .cf-v{display:none}
@keyframes cf-gira{to{transform:rotate(360deg)}}@keyframes cf-surge{from{transform:scale(.6)}to{transform:scale(1)}}
@media (prefers-reduced-motion:reduce){.cf-icone{animation:none!important}}
.pe{flex:none;display:flex;align-items:center;justify-content:space-between;gap:14px;margin:0 clamp(24px,5vw,64px);padding:18px 0 28px;border-top:1px solid var(--line)}
.pe-dica{font-size:12px;color:var(--ink3)}.pe-acoes{display:flex;align-items:center;gap:18px;margin-left:auto}
/* O botao de moldura dupla (padrao de 07/10, o .g-trilho/.g-pastilha de Entrar):
   32 px no total - 1 px de fio, 1 px de trilho e a pastilha de 28 px. */
.principal{display:inline-flex;padding:1px;border:1px solid var(--line);border-radius:12px;background:var(--panel);color:var(--ink);font:500 13px Manrope,system-ui,sans-serif;
letter-spacing:.01em;text-decoration:none;cursor:pointer;white-space:nowrap}
.principal>span{flex:1;height:28px;padding:0 22px;display:flex;align-items:center;justify-content:center;gap:8px;border-radius:8px;background:var(--pill);transition:background .12s}
.principal:hover{border-color:var(--line2)}.principal:hover>span{background:var(--pill-h)}
.principal:focus-visible{outline:2px solid var(--ink3);outline-offset:2px}
.principal:disabled{opacity:.5;cursor:default;pointer-events:none}
@media (max-width:1000px){main{grid-template-columns:minmax(0,1fr);align-items:start;padding-top:40px}.painel{max-width:none}}
</style></head><body>
<header><a class="marca serif" href="/">PAVLVS</a><div class="topo"><button type="button" class="tema" id="tema" aria-label="Alternar tema"></button></div></header>
<main><section class="texto"><span class="rotulo mono">${esc(rotulo)}</span><h1 class="serif">${h1}</h1>${texto}
${nota ? `<span class="nota">${nota}</span>` : ""}</section>
${painel ? `<section class="painel">${painel}</section>` : ""}</main>
${pe}
</body></html>`;
  const csp = "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" +
    "; script-src " + (await hashScript()) + (comTurnstile ? " https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src https://challenges.cloudflare.com" : "");
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
    "x-frame-options": "DENY", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "content-security-policy": csp } });
}

const VOLTE = "Volte ao Paulus do escritório: ele mostra o próximo passo.";

function vencido() {
  return pagina("Código vencido", { rotulo: "Código vencido", h1: "Este código expirou.",
    texto: "<p>Ele vale por 15 minutos. Comece de novo no Paulus do escritório — o nome escolhido continua lá.</p>",
    nota: "Nada foi criado.", dica: VOLTE }, 410);
}

function jaConectado() {
  return pagina("Já conectado", { rotulo: "Conectado", h1: "Este pedido já foi confirmado.",
    texto: "<p>O endereço já existe e o Paulus do escritório já o recebeu.</p>", nota: "Já pode fechar esta página.",
    dica: "Nada para fazer aqui." });
}

function linhasDoPedido(pedido, endereco) {
  return linhas([
    ["Escritório", `<b>${esc(pedido.nome)}</b>`],
    ["Endereço", `<span class="end">${esc(endereco)}</span>`],
    ...(pedido.retomar && pedido.dono ? [["Conta Google", esc(pedido.dono.email)]] : []),
    ["Entrada", "conta Google e código do celular"],
  ]);
}

async function paginaConectar(env, url) {
  const achado = await pedidoDoCodigo(env, url.searchParams.get("c"));
  if (!achado) return vencido();
  const { pedido } = achado;
  if (pedido.estado !== "pendente") return jaConectado();
  const endereco = "https://" + pedido.slug + "." + DOMINIO;
  // O botao fica no rodape, fora do <form>: o atributo form="conectar" e que
  // o liga ao envio. Nasce travado; o selo o destrava quando o Turnstile passa.
  return pagina("Conectar", {
    rotulo: pedido.retomar ? "Endereço da sua conta" : "Novo endereço",
    h1: pedido.retomar ? "Retomar o endereço do escritório?" : "Conectar o Paulus do escritório?",
    texto: pedido.retomar
      ? `<p>Este endereço já é da conta Google <b>${esc(pedido.dono.email)}</b>. Confirmando, ele passa para o Paulus de <b>${esc(pedido.nome)}</b> neste computador, e o de antes deixa de atender por ele.</p>`
      : `<p>O Paulus de <b>${esc(pedido.nome)}</b> passa a atender neste endereço pelo túnel da Cloudflare. Quem entrar por ele passa por uma verificação contra robôs, pela conta Google e pelo código do celular de cada pessoa.</p>`,
    nota: "Você pode desligar o acesso externo quando quiser.",
    painel: linhasDoPedido(pedido, endereco) + `<form method="post" action="/conectar" id="conectar"><input type="hidden" name="c" value="${esc(pedido.codigo_usuario)}">
<div class="bloco"><span class="etiqueta mono">Código no Paulus</span><span class="codigo">${esc(pedido.codigo_usuario)}</span>
<span class="ajuda">Confira se é o mesmo código que aparece na tela do Paulus.</span></div>
<div class="robo" aria-label="Verificação contra robôs"><div id="robo" data-sitekey="${esc(env.TURNSTILE_SITEKEY || "")}"></div></div>
${SELO}</form>`,
    dica: "Código diferente? Feche esta página.",
    acao: `<button class="principal" type="submit" form="conectar" id="confirmar" disabled><span>${pedido.retomar ? "Retomar" : "Confirmar"}</span></button>`,
  }, 200, true);
}

async function confirmar(request, env, agora) {
  let codigo = "", token = "";
  try {
    const f = await request.formData();
    codigo = String(f.get("c") || "");
    token = String(f.get("cf-turnstile-response") || "");
  } catch (e) { /* formulario torto: cai no "codigo vencido" */ }
  const achado = await pedidoDoCodigo(env, codigo);
  if (!achado) return vencido();
  const { hash, pedido } = achado;
  if (pedido.estado !== "pendente") return jaConectado();
  const tentar = link("Tentar de novo", "/conectar?c=" + pedido.codigo_usuario);
  // A barreira contra criacao de enderecos em massa: nada e criado sem o
  // Turnstile resolvido nesta pagina.
  if (!(await turnstileValido(env, token, DOMINIO, request.headers.get("cf-connecting-ip")))) {
    return pagina("Verificação", { rotulo: "Verificação", h1: "Não foi possível confirmar.",
      texto: "<p>A verificação contra robôs não passou ou venceu.</p>", nota: "Nada foi criado.", acao: tentar }, 403);
  }
  const antigo = await kvGet(env, "escritorio:" + pedido.slug);
  if (antigo && pedido.retomar && mesmoDono(antigo, pedido.dono)) {
    // O mesmo dono: o tunel, o DNS e o segredo antigos saem (o nome do tunel
    // e o DNS nao podem existir duas vezes); o PAULUS antigo, se ainda
    // existir, ouve "endereço removido" na proxima conversa. No registro de
    // enderecos isto e um evento so, o "criado" de provisionar (com o motivo):
    // o nome nao fica livre em momento nenhum.
    await remover(env, antigo, "retomado pela mesma conta Google em outra instalação", { registrar: false });
  } else if (antigo) {
    return pagina("Nome em uso", { rotulo: "Nome em uso", h1: "Esse endereço acabou de ser usado.",
      texto: "<p>Outro escritório ficou com ele há pouco. Volte ao Paulus do escritório e escolha outro nome.</p>",
      nota: "Nada foi criado.", dica: VOLTE }, 409);
  }
  let criado;
  try {
    criado = await provisionar(env, pedido.slug, pedido, agora);
  } catch (e) {
    return pagina("Não deu certo", { rotulo: "Não deu certo", h1: "Não consegui criar o endereço.",
      texto: "<p>O que tinha sido criado foi desfeito. Tente de novo em alguns minutos.</p>", nota: "Nada ficou pela metade.",
      painel: `<div class="bloco"><span class="etiqueta mono">Detalhe</span><span class="detalhe">${esc(e.message)}</span></div>`, acao: tentar }, 502);
  }
  await env.ESCRITORIOS.delete("reserva:" + pedido.slug);
  await kvPut(env, "pedido:" + hash, { ...pedido, estado: "pronto", entrega: criado.entrega }, PEDIDO_TTL_S);
  return pagina("Conectado", {
    rotulo: "Conectado", h1: "Endereço conectado.",
    texto: "<p>O Paulus do escritório já recebeu o endereço e liga o túnel sozinho. A partir de agora, a equipe pode entrar de fora com a própria conta.</p>",
    nota: "Já pode fechar esta página.",
    painel: linhasDoPedido(pedido, criado.entrega.endereco),
    dica: "Ou feche esta página.", acao: link("Abrir o endereço", criado.entrega.endereco),
  });
}

// Os passos, na ordem do contrato. Falha em qualquer um desfaz os anteriores:
// escritorio pela metade na conta do Atos e lixo que ninguem ve.
export async function provisionar(env, slug, pedido, agora = () => Date.now()) {
  const a = "/accounts/" + env.CF_ACCOUNT_ID;
  const host = slug + "." + DOMINIO;
  const feito = [];
  const desfazer = async () => {
    for (const passo of feito.reverse()) {
      try { await passo(); } catch (e) { /* o resto do desfazer continua */ }
    }
  };
  try {
    const tunel = await chamarCF(env, "POST", a + "/cfd_tunnel", { name: "paulus-" + slug, config_src: "cloudflare" });
    feito.push(async () => {
      await chamarCF(env, "DELETE", a + "/cfd_tunnel/" + tunel.id + "/connections");
      await chamarCF(env, "DELETE", a + "/cfd_tunnel/" + tunel.id);
    });
    await chamarCF(env, "PUT", a + "/cfd_tunnel/" + tunel.id + "/configurations", ingress(host, pedido.porta));
    const dns = await chamarCF(env, "POST", "/zones/" + env.CF_ZONE_ID + "/dns_records",
      { type: "CNAME", name: host, content: tunel.id + ".cfargotunnel.com", proxied: true, ttl: 1, comment: "Paulus: acesso externo de " + slug });
    feito.push(() => chamarCF(env, "DELETE", "/zones/" + env.CF_ZONE_ID + "/dns_records/" + dns.id));
    const token = await chamarCF(env, "GET", a + "/cfd_tunnel/" + tunel.id + "/token");
    const segredo = aleatorio(32);
    const registro = {
      slug, tunnel_id: tunel.id, dns_id: dns.id, instalacao_id: pedido.instalacao_id, nome: pedido.nome,
      hash_segredo: await resumo(segredo), porta: pedido.porta, criado_em: new Date(agora()).toISOString(), ultima_conexao: null,
      dono: pedido.dono || null, ativo: true,
      // O que aconteceu com o endereco (o painel admin mostra; worker/admin.js).
      historico: [{ quando: new Date(agora()).toISOString(), texto: "Túnel criado · CNAME " + host + " → cfargotunnel.com · porta " + pedido.porta }],
    };
    await kvPut(env, "escritorio:" + slug, registro);
    feito.push(() => env.ESCRITORIOS.delete("escritorio:" + slug));
    await kvPut(env, "segredo:" + registro.hash_segredo, { slug });
    await kvPut(env, "instalacao:" + pedido.instalacao_id, { slug });
    await anotarDono(env, slug, registro.dono);
    await registrarEndereco(env, { slug, evento: "criado", quem: (registro.dono && registro.dono.email) || "o escritório", estado: "ativo",
      motivo: pedido.retomar ? "retomado pela mesma conta Google em outra instalação" : "" }, agora);
    return {
      registro,
      entrega: { endereco: "https://" + host, hostname: host, tunnel_token: token, turnstile_sitekey: env.TURNSTILE_SITEKEY || "",
        segredo_instalacao: segredo },
    };
  } catch (e) {
    await desfazer();
    throw e;
  }
}

function ingress(host, porta) {
  return { config: { ingress: [{ hostname: host, service: "http://127.0.0.1:" + porta, originRequest: {} }, { service: "http_status:404" }] } };
}

// ----------------------------------------------------------- estado

async function estadoDoPedido(request, env) {
  const d = await lerJSON(request);
  const codigo = String((d && d.codigo_dispositivo) || "");
  if (!/^[0-9a-f]{64}$/.test(codigo)) return json({ estado: "expirado" });
  const h = await resumo(codigo);
  const pedido = await kvGet(env, "pedido:" + h);
  if (!pedido) return json({ estado: "expirado" });
  if (pedido.estado !== "pronto" || !pedido.entrega) return json({ estado: "pendente" });
  // Uma vez so: o token do tunel sai daqui e o pedido deixa de existir.
  await env.ESCRITORIOS.delete("pedido:" + h);
  await env.ESCRITORIOS.delete("usuario:" + pedido.codigo_usuario);
  return json({ estado: "pronto", ...pedido.entrega });
}

// ------------------------------------------------- com o segredo da instalacao

async function comSegredo(request, env, fazer, comCorpo = true) {
  const cab = request.headers.get("authorization") || "";
  const segredo = cab.startsWith("Bearer ") ? cab.slice(7).trim() : "";
  if (!/^[0-9a-f]{64}$/.test(segredo)) return json({ erro: "não autorizado" }, 401);
  const h = await resumo(segredo);
  const indice = await kvGet(env, "segredo:" + h);
  const registro = indice ? await kvGet(env, "escritorio:" + indice.slug) : null;
  if (!registro || !igual(registro.hash_segredo, h)) {
    // O endereco foi removido (pelo escritorio ou pela limpeza): o PAULUS
    // precisa saber, para desligar e avisar - e nao ficar tentando.
    const removido = await kvGet(env, "removido:" + h);
    if (removido) return json({ erro: "endereço removido", removido: true, motivo: removido.motivo }, 410);
    return json({ erro: "não autorizado" }, 401);
  }
  const dados = comCorpo ? await lerJSON(request) : null;
  if (comCorpo && !dados) return json({ erro: "pedido inválido" }, 400);
  try {
    return await fazer(registro, dados);
  } catch (e) {
    return json({ erro: e.message }, 502);
  }
}

async function marcarConexao(env, registro, quando) {
  const novo = { ...registro, ultima_conexao: new Date(quando).toISOString() };
  if (!registro.ultima_conexao) novo.historico = comEvento(registro, "Primeira conexão do PAULUS", quando);
  await kvPut(env, "escritorio:" + registro.slug, novo);
}

// O historico de um endereco: os ultimos 40 eventos.
function comEvento(registro, texto, quando = Date.now()) {
  return [...(registro.historico || []), { quando: new Date(quando).toISOString(), texto }].slice(-40);
}

// So o token do Turnstile passa por aqui - nunca conteudo. O segredo do
// Turnstile fica no Worker e nunca vai para o PAULUS instalado.
async function conferirTurnstile(env, registro, dados, agora) {
  const host = registro.slug + "." + DOMINIO;
  const ok = await turnstileValido(env, dados.token, host, dados.ip);
  await marcarConexao(env, registro, agora());
  return json({ ok });
}

async function trocarPorta(env, registro, dados) {
  const porta = Number(dados.porta);
  if (!Number.isInteger(porta) || porta < 1024 || porta > 65535) return json({ erro: "porta inválida" }, 400);
  await chamarCF(env, "PUT", "/accounts/" + env.CF_ACCOUNT_ID + "/cfd_tunnel/" + registro.tunnel_id + "/configurations",
    ingress(registro.slug + "." + DOMINIO, porta));
  await kvPut(env, "escritorio:" + registro.slug, { ...registro, porta });
  return json({ ok: true, porta });
}

async function situacao(env, registro, agora) {
  const t = await chamarCF(env, "GET", "/accounts/" + env.CF_ACCOUNT_ID + "/cfd_tunnel/" + registro.tunnel_id);
  const conectado = t.status === "healthy" || t.status === "degraded";
  await marcarConexao(env, registro, agora());
  return json({ hostname: registro.slug + "." + DOMINIO, status: t.status || "desconhecido", conectado, porta: registro.porta });
}

/* Apaga DNS, tunel e registro; o nome fica livre. `quem` vai para o registro
   de enderecos (sem ele, o dono do endereco ou "o escritório"); `registrar`
   false so na retomada, que e o "criado" de provisionar. */
async function remover(env, registro, motivo, { quem, registrar = true, quando } = {}) {
  const a = "/accounts/" + env.CF_ACCOUNT_ID;
  const erros = [];
  const tentar = async (f) => { try { await f(); } catch (e) { erros.push(e.message); } };
  await tentar(() => chamarCF(env, "DELETE", "/zones/" + env.CF_ZONE_ID + "/dns_records/" + registro.dns_id));
  await tentar(() => chamarCF(env, "DELETE", a + "/cfd_tunnel/" + registro.tunnel_id + "/connections"));
  await tentar(() => chamarCF(env, "DELETE", a + "/cfd_tunnel/" + registro.tunnel_id));
  await env.ESCRITORIOS.delete("escritorio:" + registro.slug);
  await env.ESCRITORIOS.delete("segredo:" + registro.hash_segredo);
  await env.ESCRITORIOS.delete("instalacao:" + registro.instalacao_id);
  await esquecerDono(env, registro);
  await kvPut(env, "removido:" + registro.hash_segredo, { slug: registro.slug, motivo, quando: new Date().toISOString() }, LEMBRAR_REMOVIDO_S);
  if (registrar) {
    await registrarEndereco(env, { slug: registro.slug, evento: "liberado", estado: "livre", motivo,
      quem: quem !== undefined ? quem : (registro.dono && registro.dono.email) || "o escritório" }, quando);
  }
  return json({ ok: true, avisos: erros });
}

// ------------------------------------------------------------ limpeza

// Roda uma vez por dia (Cron Trigger, worker/index.js). Endereco que nunca
// conectou em 7 dias e o que ficou parado mais de 180 sao removidos, e o
// nome volta a ficar livre. A "ultima conexao" e a mais nova entre o que o
// PAULUS contou (turnstile, situacao) e o que a Cloudflare sabe do tunel.
export async function limparEscritorios(env, agora = () => Date.now()) {
  const feito = { removidos: [], mantidos: 0 };
  if (env.TUNEL_ATIVO !== "1" || !env.ESCRITORIOS) return feito;
  let cursor;
  do {
    const lista = await env.ESCRITORIOS.list({ prefix: "escritorio:", cursor });
    for (const { name } of lista.keys) {
      const registro = await kvGet(env, name);
      if (!registro) continue;
      const antes = registro.ultima_conexao ? Date.parse(registro.ultima_conexao) || 0 : 0;
      let ultima = antes;
      let conectadoAgora = false;
      try {
        const t = await chamarCF(env, "GET", "/accounts/" + env.CF_ACCOUNT_ID + "/cfd_tunnel/" + registro.tunnel_id);
        conectadoAgora = t.status === "healthy" || t.status === "degraded";
        if (conectadoAgora) ultima = agora();
        else if (t.conns_inactive_at) ultima = Math.max(ultima, Date.parse(t.conns_inactive_at) || 0);
      } catch (e) {
        // Sem resposta da API, nada e removido hoje: remover por engano um
        // escritorio que funciona e muito pior que esperar um dia.
        feito.mantidos++;
        continue;
      }
      const criado = Date.parse(registro.criado_em) || agora();
      let motivo = "";
      if (!conectadoAgora && !ultima && agora() - criado > NUNCA_CONECTOU_DIAS * DIA_MS) motivo = "nunca conectou em 7 dias";
      else if (!conectadoAgora && ultima && agora() - ultima > PARADO_DIAS * DIA_MS) motivo = "parado há mais de 180 dias";
      if (motivo) {
        await remover(env, registro, motivo, { quem: "limpeza automática", quando: agora });
        feito.removidos.push({ slug: registro.slug, motivo });
      } else {
        if (ultima !== antes) await marcarConexao(env, registro, ultima);
        feito.mantidos++;
      }
    }
    cursor = lista.list_complete ? undefined : lista.cursor;
  } while (cursor);
  return feito;
}

// ------------------------------------------------------- o painel admin
//
// O que o painel (worker/admin.js) faz com os enderecos: listar com o estado
// do tunel na Cloudflare e o quanto falta para a limpeza, trocar o endereco,
// desativar (o CNAME sai, o tunel fica) e liberar (o mesmo "remover" do
// escritorio). Tudo grava um evento no historico do registro.

export const LIMPEZA = { NUNCA_CONECTOU_DIAS, PARADO_DIAS };

// ------------------------------------------------- o registro de enderecos
//
// Cada mudanca de endereco vira um evento: criado (provisionar, tambem na
// retomada, com o motivo), alterado (alterarEndereco), desativado e reativado
// (ativarEndereco) e liberado (remover: pelo escritorio, pela limpeza diaria
// ou pelo painel). Quem muda o endereco registra sozinho - nenhum chamador
// precisa lembrar. O painel le em GET /api/admin/tuneis (o "registro").
//
// No KV ESCRITORIOS, uma chave por evento, "evento:<instante ISO>:<sorteio>"
// (sem disputa entre dois eventos ao mesmo tempo), com o evento nos metadados:
// a lista do painel le tudo numa listagem so, sem um get por evento. Vence em
// 400 dias, como o "removido:". So o endereco, o que aconteceu, quem fez (o
// e-mail de quem mexeu, "o escritório" ou "limpeza automática") e o motivo.
const EVENTOS_DE_ENDERECO = { criado: "ativo", alterado: "ativo", reativado: "ativo", desativado: "desativado", liberado: "livre" };
const REGISTRO_MAX = 2000;

/* Anota um evento no registro de enderecos. {slug, para?, de?}: o endereco
   depois do evento e o de antes (na troca, slug/de = o antigo e para = o novo).
   Nunca derruba a mudanca: sem o KV, ou com erro, so nao anota. */
export async function registrarEndereco(env, { slug, evento, quem, de, para, estado, motivo } = {}, quando = Date.now()) {
  if (!env || !env.ESCRITORIOS || !(evento in EVENTOS_DE_ENDERECO)) return null;
  const ms = typeof quando === "function" ? quando() : Number(quando) || Date.now();
  const corta = (t, n) => String(t || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n);
  const atual = corta(para || slug, 24);
  const antes = corta(de || (para && slug !== para ? slug : ""), 24);
  const ev = {
    quando: new Date(ms).toISOString(), slug: atual, de: antes !== atual ? antes : "", evento, quem: corta(quem, 120),
    estado: ["ativo", "desativado", "livre"].includes(estado) ? estado : EVENTOS_DE_ENDERECO[evento], motivo: corta(motivo, 160),
  };
  try {
    await env.ESCRITORIOS.put("evento:" + ev.quando + ":" + aleatorio(3), JSON.stringify(ev), { expirationTtl: LEMBRAR_REMOVIDO_S, metadata: ev });
    return ev;
  } catch (e) {
    return null;
  }
}

/* O registro de enderecos, do mais novo ao mais velho (os ultimos REGISTRO_MAX). */
export async function registroDeEnderecos(env, limite = REGISTRO_MAX) {
  if (!env.ESCRITORIOS) return [];
  const eventos = [];
  let cursor;
  do {
    const lista = await env.ESCRITORIOS.list({ prefix: "evento:", cursor });
    for (const k of lista.keys) {
      // Os metadados trazem o evento; sem eles (um KV que nao os devolve), o valor.
      const ev = k.metadata && k.metadata.evento ? k.metadata : await kvGet(env, k.name);
      if (ev && ev.evento && ev.quando) eventos.push(ev);
    }
    cursor = lista.list_complete ? undefined : lista.cursor;
  } while (cursor);
  return eventos.sort((a, b) => String(b.quando).localeCompare(String(a.quando))).slice(0, limite);
}

/* Quantos dias faltam para a limpeza diaria apagar o endereco, e por que - ou null. */
export function previsaoDaLimpeza(registro, conectadoAgora, agora = Date.now()) {
  if (conectadoAgora) return null;
  const ultima = registro.ultima_conexao ? Date.parse(registro.ultima_conexao) || 0 : 0;
  const criado = Date.parse(registro.criado_em) || agora;
  if (!ultima) {
    const dias = Math.ceil((criado + NUNCA_CONECTOU_DIAS * DIA_MS - agora) / DIA_MS);
    return { dias: Math.max(0, dias), motivo: "nunca conectou" };
  }
  const dias = Math.ceil((ultima + PARADO_DIAS * DIA_MS - agora) / DIA_MS);
  return { dias: Math.max(0, dias), motivo: "parado" };
}

export function cfConfigurado(env) {
  return Boolean(env.CF_API_TOKEN && env.CF_ACCOUNT_ID && env.CF_ZONE_ID);
}

/* Todos os enderecos, com o estado do tunel na Cloudflare (sem a API, "desconhecido"). */
export async function listarParaAdmin(env, agora = Date.now()) {
  const saida = [];
  if (!env.ESCRITORIOS) return saida;
  let cursor;
  do {
    const lista = await env.ESCRITORIOS.list({ prefix: "escritorio:", cursor });
    for (const { name } of lista.keys) {
      const r = await kvGet(env, name);
      if (!r) continue;
      let estado = "desconhecido";
      if (r.ativo === false) estado = "desativado";
      if (cfConfigurado(env)) {
        try {
          const t = await chamarCF(env, "GET", "/accounts/" + env.CF_ACCOUNT_ID + "/cfd_tunnel/" + r.tunnel_id);
          if (r.ativo !== false) estado = t.status || "desconhecido";
          else estado = "desativado";
          if ((t.status === "healthy" || t.status === "degraded") && r.ativo !== false) r.ultima_conexao = new Date(agora).toISOString();
        } catch (e) {
          // sem resposta da API: fica o que o KV sabe
        }
      }
      const conectado = estado === "healthy" || estado === "degraded";
      saida.push({
        slug: r.slug, nome: r.nome || "", responsavel: (r.dono && r.dono.email) || "", estado,
        ultima_conexao: r.ultima_conexao || null, criado_em: r.criado_em || null, tunnel_id: r.tunnel_id || "",
        porta: r.porta || 0, ativo: r.ativo !== false, limpeza: previsaoDaLimpeza(r, conectado, agora),
        historico: (r.historico || []).slice().reverse(),
      });
    }
    cursor = lista.list_complete ? undefined : lista.cursor;
  } while (cursor);
  return saida;
}

/* Os enderecos liberados ha pouco (removidos pelo escritorio, pela limpeza ou pelo painel). */
export async function enderecosLivres(env, limite = 12) {
  if (!env.ESCRITORIOS) return [];
  const lista = await env.ESCRITORIOS.list({ prefix: "removido:" });
  const livres = [];
  for (const { name } of lista.keys.slice(0, 60)) {
    const r = await kvGet(env, name);
    if (r && r.slug && !livres.includes(r.slug) && !(await env.ESCRITORIOS.get("escritorio:" + r.slug))) livres.push(r.slug);
    if (livres.length >= limite) break;
  }
  return livres;
}

/* O motivo de um nome nao servir para o painel ("" se serve): formato, reservado ou em uso. */
export async function motivoDoEnderecoNovo(env, nome) {
  const motivo = motivoDoFormato(nome);
  if (motivo) return motivo;
  if (await env.ESCRITORIOS.get("escritorio:" + nome)) return "já em uso";
  if (await env.ESCRITORIOS.get("reserva:" + nome)) return "reservado por um pedido em andamento";
  return "";
}

export async function anotarHistorico(env, slug, texto, agora = Date.now()) {
  const r = await kvGet(env, "escritorio:" + slug);
  if (!r) return false;
  await kvPut(env, "escritorio:" + slug, { ...r, historico: comEvento(r, texto, agora) });
  return true;
}

/* Troca o endereco: o CNAME passa a ter o nome novo (no mesmo tunel), o ingress
   do tunel aponta para ele, e o registro e os indices mudam de chave. `quem`
   (o e-mail de quem pediu) vai para o registro de enderecos. */
export async function alterarEndereco(env, slug, novo, agora = Date.now(), quem = "") {
  const r = await kvGet(env, "escritorio:" + slug);
  if (!r) throw new Error("esse endereço não existe mais");
  const motivo = await motivoDoEnderecoNovo(env, novo);
  if (motivo) throw new Error(novo + ": " + motivo);
  const host = novo + "." + DOMINIO;
  if (r.ativo !== false && r.dns_id) {
    await chamarCF(env, "PUT", "/zones/" + env.CF_ZONE_ID + "/dns_records/" + r.dns_id,
      { type: "CNAME", name: host, content: r.tunnel_id + ".cfargotunnel.com", proxied: true, ttl: 1, comment: "Paulus: acesso externo de " + novo });
  }
  await chamarCF(env, "PUT", "/accounts/" + env.CF_ACCOUNT_ID + "/cfd_tunnel/" + r.tunnel_id + "/configurations", ingress(host, r.porta));
  const registro = { ...r, slug: novo, historico: comEvento(r, "Endereço alterado de " + slug + " para " + novo + " · CNAME recriado", agora) };
  await kvPut(env, "escritorio:" + novo, registro);
  await env.ESCRITORIOS.delete("escritorio:" + slug);
  await kvPut(env, "segredo:" + r.hash_segredo, { slug: novo });
  if (r.instalacao_id) await kvPut(env, "instalacao:" + r.instalacao_id, { slug: novo });
  if (r.dono) {
    const indice = (await kvGet(env, "dono:" + r.dono.sub)) || { slugs: [] };
    await kvPut(env, "dono:" + r.dono.sub, { slugs: [...(indice.slugs || []).filter((s) => s !== slug), novo] });
  }
  await registrarEndereco(env, { slug, para: novo, evento: "alterado", quem, estado: r.ativo !== false ? "ativo" : "desativado" }, agora);
  return registro;
}

/* Desativar tira o CNAME (o endereco deixa de responder) e mantem o tunel;
   ativar cria o CNAME de novo. `quem`, como em alterarEndereco. */
export async function ativarEndereco(env, slug, ativo, agora = Date.now(), quem = "") {
  const r = await kvGet(env, "escritorio:" + slug);
  if (!r) throw new Error("esse endereço não existe mais");
  if (Boolean(ativo) === (r.ativo !== false)) return r;
  const host = slug + "." + DOMINIO;
  let dnsId = r.dns_id;
  if (!ativo) {
    if (r.dns_id) await chamarCF(env, "DELETE", "/zones/" + env.CF_ZONE_ID + "/dns_records/" + r.dns_id);
    dnsId = null;
  } else {
    const dns = await chamarCF(env, "POST", "/zones/" + env.CF_ZONE_ID + "/dns_records",
      { type: "CNAME", name: host, content: r.tunnel_id + ".cfargotunnel.com", proxied: true, ttl: 1, comment: "Paulus: acesso externo de " + slug });
    dnsId = dns.id;
  }
  const registro = { ...r, ativo: Boolean(ativo), dns_id: dnsId,
    historico: comEvento(r, ativo ? "Acesso reativado · CNAME de volta" : "Acesso desativado · CNAME tirado, o túnel fica", agora) };
  await kvPut(env, "escritorio:" + slug, registro);
  await registrarEndereco(env, { slug, evento: ativo ? "reativado" : "desativado", quem }, agora);
  return registro;
}

/* Liberar: o mesmo remover do escritorio - conexoes, tunel, CNAME e registro.
   `quem`, como em alterarEndereco. */
export async function liberarEndereco(env, slug, motivo = "liberado pelo painel", quem = "") {
  const r = await kvGet(env, "escritorio:" + slug);
  if (!r) throw new Error("esse endereço não existe mais");
  if (r.ativo === false) r.dns_id = r.dns_id || "";
  const resposta = await remover(env, { ...r, dns_id: r.dns_id || "sem-dns" }, motivo, { quem });
  return resposta.json();
}

// ------------------------------------------------------ area do cliente

// A Area do cliente (PAULUS, docs/PLANO-AREA-CLIENTE.md): o escritorio
// compartilha a pasta de um servico, e o cliente entra pelo endereco do
// escritorio com um codigo que chega no e-mail. Quem manda o e-mail e o
// Worker, pelo Resend, como "Escritorio Tal (via PAVLVS)".
//
// O PAULUS nao escreve o e-mail: manda o TIPO e os campos, e o texto sai
// daqui. Assim o segredo da instalacao nao vira um jeito de mandar qualquer
// coisa a qualquer pessoa - o link tem de ser do endereco do proprio
// escritorio, e ha teto por dia e por destinatario.
export const CLIENTE_EMAIL_POR_DIA = 300;
export const CLIENTE_EMAIL_POR_HORA = 12;

function limpo(t, max) {
  return String(t || "").replace(/[\r\n<>"]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

async function emailDoCliente(env, registro, dados, agora) {
  const tipo = String(dados.tipo || "");
  // "senha" (07/10/2026): o codigo do "Esqueci a senha" de quem entra no PAULUS de fora.
  if (!["convite", "codigo", "mensagem", "senha"].includes(tipo)) return json({ erro: "tipo de e-mail desconhecido" }, 400);
  const para = String(dados.para || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(para) || para.length > 200) return json({ erro: "e-mail do destinatário inválido" }, 400);
  const host = registro.slug + "." + DOMINIO;
  const link = String(dados.link || "");
  if (!link.startsWith("https://" + host + (tipo === "senha" ? "/" : "/cliente/"))) return json({ erro: "o link precisa ser do endereço deste escritório" }, 400);
  const escritorio = limpo(dados.escritorio || registro.nome, 60) || "Seu escritório";
  const advogado = limpo(dados.advogado, 60) || escritorio;
  const pasta = limpo(dados.pasta, 80);
  const pessoa = limpo(dados.nome, 60);

  const dia = new Date(agora()).toISOString().slice(0, 10);
  const hora = new Date(agora()).toISOString().slice(0, 13);
  const chaveDia = "cliemail:" + registro.slug + ":" + dia;
  const chaveHora = "cliemail:" + registro.slug + ":" + para + ":" + hora;
  const noDia = (await kvGet(env, chaveDia)) || 0;
  const naHora = (await kvGet(env, chaveHora)) || 0;
  if (noDia >= CLIENTE_EMAIL_POR_DIA) return json({ erro: "o escritório chegou ao limite de e-mails de hoje" }, 429);
  if (naHora >= CLIENTE_EMAIL_POR_HORA) return json({ erro: "muitos e-mails para esta pessoa na última hora — espere um pouco" }, 429);

  let carta;
  if (tipo === "senha") {
    const codigo = String(dados.codigo || "");
    if (!/^\d{6}$/.test(codigo)) return json({ erro: "código inválido" }, 400);
    carta = {
      assunto: "Código para trocar a senha: " + codigo, titulo: "Seu código: " + codigo, pre: "Trocar a senha de entrada no Paulus do " + escritorio,
      texto: (pessoa ? "Olá, " + pessoa.split(" ")[0] + ".\n\n" : "") + "Use este código para trocar a sua senha de entrada no Paulus do " + escritorio + ". Ele vale por 10 minutos. " +
        "Depois da senha nova, a entrada continua pedindo o código do autenticador do celular.\n\n" +
        "Se não foi você que pediu, ignore este e-mail: a senha atual continua valendo.",
    };
  } else if (tipo === "codigo") {
    const codigo = String(dados.codigo || "");
    if (!/^\d{6}$/.test(codigo)) return json({ erro: "código inválido" }, 400);
    carta = {
      assunto: "Seu código de acesso: " + codigo, titulo: "Seu código: " + codigo, pre: "Código de acesso à sua pasta no " + escritorio,
      texto: "Use este código para entrar na área do cliente do " + escritorio + ". Ele vale por 10 minutos.\n\n" +
        "Se não foi você que pediu, ignore este e-mail: sem o código, ninguém entra.",
    };
  } else if (tipo === "convite") {
    carta = {
      assunto: advogado + " compartilhou uma pasta com você", titulo: "Sua pasta no " + escritorio,
      pre: "Acompanhe " + (pasta ? "“" + pasta + "”" : "o seu serviço") + " pela internet",
      texto: (pessoa ? "Olá, " + pessoa.split(" ")[0] + ".\n\n" : "") + advogado + " compartilhou com você " +
        (pasta ? "a pasta “" + pasta + "”" : "uma pasta") + ". Por ela você acompanha o andamento, as próximas datas e os documentos que o escritório separar para você.\n\n" +
        "Para entrar, abra o link e digite este e-mail: um código de acesso chega aqui na hora.",
      botao: "Abrir a pasta", link,
    };
  } else {
    carta = {
      assunto: advogado + " te mandou uma mensagem", titulo: "Mensagem nova",
      pre: "Há uma mensagem nova" + (pasta ? " sobre “" + pasta + "”" : ""),
      texto: "Há uma mensagem nova" + (pasta ? " sobre “" + pasta + "”" : "") + ". Abra a pasta para ler e responder.",
      botao: "Abrir a pasta", link,
    };
  }
  const r = await enviarEmail(env, {
    para, ...carta, de: escritorio + " (via PAVLVS) <naoresponda@paulus.ia.br>",
    rodape: "Enviado pelo PAVLVS a pedido do " + escritorio + ". Este e-mail é automático e não recebe respostas: fale com o escritório pela própria pasta.",
  });
  if (!r.ok) return json({ erro: r.erro }, r.status || 502);
  await kvPut(env, chaveDia, noDia + 1, 2 * 24 * 3600);
  await kvPut(env, chaveHora, naHora + 1, 2 * 3600);
  return json({ ok: true });
}

// ------------------------------------------------------- a Minha conta

/* O escritorio de uma conta Google (o endereco mais novo dela), para a Minha
   conta (worker/conta.js): o nome, o endereco, se o tunel esta no ar e de que
   instalacao ele e. No ar = a Cloudflare diz healthy/degraded; sem a API
   configurada, a ultima conexao dos ultimos 15 minutos. null sem endereco. */
export async function escritorioDoDono(env, dono, agora = Date.now()) {
  if (!env.ESCRITORIOS || !dono) return null;
  const indice = (await kvGet(env, "dono:" + dono.sub)) || { slugs: [] };
  let achado = null;
  for (const slug of indice.slugs || []) {
    const r = await kvGet(env, "escritorio:" + slug);
    if (mesmoDono(r, dono) && (!achado || String(r.criado_em || "") > String(achado.criado_em || ""))) achado = r;
  }
  if (!achado) return null;
  let online = Date.parse(achado.ultima_conexao || "") > agora - 15 * 60 * 1000;
  if (cfConfigurado(env) && achado.tunnel_id) {
    try {
      const t = await chamarCF(env, "GET", "/accounts/" + env.CF_ACCOUNT_ID + "/cfd_tunnel/" + achado.tunnel_id);
      online = (t.status === "healthy" || t.status === "degraded") && achado.ativo !== false;
    } catch (e) {
      // sem resposta da API: fica a ultima conexao
    }
  }
  return { slug: achado.slug, nome: achado.nome || "", online: Boolean(online && achado.ativo !== false), ativo: achado.ativo !== false,
    ultima_conexao: achado.ultima_conexao || null, instalacao_id: achado.instalacao_id || "" };
}
