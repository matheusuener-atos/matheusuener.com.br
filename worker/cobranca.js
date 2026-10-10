// A cobranca na Minha conta da Atos (Assinaturas, Faturamento, Carteira e os
// Dados da nota): quem guarda e o Worker do PAVLVS (paulus.ia.br), no objeto
// da conta dele, e nao o KV que a Atos le. Aqui so se busca la e se mostra.
//
// Como: com a sessao Atos aberta, a Atos assina um id_token para o cliente
// "pavlvs-site" (o mesmo que o site do PAVLVS recebe no "Entrar com Atos") e
// entra na Minha conta do PAVLVS pelo servidor (POST /api/conta/entrar). O
// cookie pv_conta que volta fica guardado so no KV ("atos:pv:<sub>", 11 horas;
// a sessao la vale 12) - nunca chega ao navegador. Nenhuma mudanca no PAVLVS.
//
//   GET  /api/cobranca                       assinatura, cartao, faturas e cadastro (ou {sem_conta})
//   GET  /api/cobranca/nfse/<id>/(pdf|xml)   o arquivo da NFS-e
//   POST /api/cobranca/cadastro              salva os dados da nota (so o titular, regras do PAVLVS)
//
// Trocar de plano, trocar o cartao e cancelar continuam na Minha conta do
// PAVLVS (paulus.ia.br/minha-conta), que tem o pagamento: a tela leva la.

import { EMISSOR, json, kv, lerJson } from "./comum.js";
import { sessaoDe } from "./contas.js";
import { assinarJWT } from "./oidc.js";

export const PAVLVS = "https://paulus.ia.br";
const GUARDA_S = 11 * 3600;

export function ehRotaDaCobranca(url) {
  return url.pathname === "/api/cobranca" || url.pathname.startsWith("/api/cobranca/");
}

/* O token que o PAVLVS aceita (donoDoToken: iss da Atos, aud pavlvs-site, ES256), 5 minutos. */
async function tokenParaPavlvs(env, s) {
  const agora = Math.floor(Date.now() / 1000);
  return assinarJWT(env, { iss: EMISSOR, aud: "pavlvs-site", azp: "pavlvs-site", sub: s.sub, email: s.email, email_verified: true, name: s.nome || "", iat: agora, exp: agora + 300 });
}

/* O cookie pv_conta do PAVLVS para esta conta: o guardado, ou entra de novo. {cookie} | {sem_conta} | {erro} */
async function entrarNoPavlvs(env, s, buscar, novo) {
  const chave = "atos:pv:" + s.sub;
  if (!novo) {
    const g = await kv(env, chave);
    if (g && g.cookie) return { cookie: g.cookie };
  }
  let r;
  try {
    r = await buscar(PAVLVS + "/api/conta/entrar", {
      method: "POST", headers: { "content-type": "application/json", origin: PAVLVS }, body: JSON.stringify({ id_token: await tokenParaPavlvs(env, s) }),
    });
  } catch {
    return { erro: "o PAVLVS não respondeu: tente de novo daqui a pouco" };
  }
  const d = await r.json().catch(() => ({}));
  if (r.status === 404 && d.sem_conta) return { sem_conta: true };
  const m = /pv_conta=([0-9a-f]{64})/.exec(r.headers.get("set-cookie") || "");
  if (!r.ok || !m) return { erro: d.erro || "não deu para abrir a cobrança no PAVLVS" };
  await env.CONTAS.put(chave, JSON.stringify({ cookie: m[1] }), { expirationTtl: GUARDA_S });
  return { cookie: m[1] };
}

/* Um pedido a Minha conta do PAVLVS, entrando de novo uma vez se a sessao de la caiu. */
async function pedir(env, s, buscar, caminho, op = {}) {
  for (const novo of [false, true]) {
    const e = await entrarNoPavlvs(env, s, buscar, novo);
    if (!e.cookie) return e;
    const r = await buscar(PAVLVS + caminho, { ...op, headers: { ...(op.headers || {}), cookie: "pv_conta=" + e.cookie, origin: PAVLVS } });
    if (r.status !== 401 || novo) return { resposta: r };
    await env.CONTAS.delete("atos:pv:" + s.sub);
  }
  return { erro: "não deu para abrir a cobrança no PAVLVS" };
}

/* So o que as telas da Atos mostram. */
function resumir(d) {
  const a = d.assinatura || {};
  const pg = d.pagamento || {};
  return {
    papel: (d.perfil || {}).papel || "",
    assinatura: a.plano ? {
      nome: a.nome || "", periodo: a.periodo || "", situacao: a.situacao || "", forma: a.forma || "", valor: Number(a.valor) || 0,
      proxima: a.proxima || "", desde: a.desde || "", cortesia: Boolean(a.cortesia),
    } : null,
    cartao: pg.cartao ? { bandeira: String(pg.cartao.bandeira || ""), final: String(pg.cartao.final || ""), validade: String(pg.cartao.validade || "") } : null,
    pix_ate: pg.pix_ate || "",
    faturas: (d.faturas || []).map((f) => ({
      data: f.data || "", descricao: f.descricao || "", valor: Number(f.valor) || 0, situacao: f.situacao || "", nfse: f.nfse || "",
      // /api/conta/nfse/<id>/pdf no PAVLVS vira /api/cobranca/nfse/<id>/pdf aqui
      pdf: String(f.pdf || "").replace(/^\/api\/conta\//, "/api/cobranca/"), xml: String(f.xml || "").replace(/^\/api\/conta\//, "/api/cobranca/"),
    })),
    cadastro: d.cadastro || null,
  };
}

export async function atenderCobranca(request, env, url, deps = {}) {
  const buscar = deps.fetch || fetch;
  const s = await sessaoDe(request, env);
  if (!s) return json({ erro: "entre na sua conta" }, 401);
  const p = url.pathname;
  const m = request.method;

  if (p === "/api/cobranca" && m === "GET") {
    const r = await pedir(env, s, buscar, "/api/conta");
    if (r.sem_conta) return json({ sem_conta: true });
    if (!r.resposta) return json({ erro: r.erro }, 502);
    const d = await r.resposta.json().catch(() => ({}));
    if (!r.resposta.ok) return json({ erro: d.erro || "não deu para ler a cobrança" }, 502);
    return json(resumir(d));
  }

  const nf = p.match(/^\/api\/cobranca\/nfse\/([A-Za-z0-9_.-]{1,64})\/(pdf|xml)$/);
  if (nf && m === "GET") {
    const r = await pedir(env, s, buscar, "/api/conta/nfse/" + nf[1] + "/" + nf[2]);
    if (!r.resposta || !r.resposta.ok) return json({ erro: (r && r.erro) || "o arquivo não foi encontrado" }, 404);
    const h = new Headers();
    for (const k of ["content-type", "content-disposition"]) if (r.resposta.headers.get(k)) h.set(k, r.resposta.headers.get(k));
    h.set("cache-control", "no-store");
    return new Response(r.resposta.body, { status: 200, headers: h });
  }

  if (p === "/api/cobranca/cadastro" && m === "POST") {
    const d = (await lerJson(request)) || {};
    const campos = ["nome", "documento", "oab", "telefone", "email_cobranca", "cep", "logradouro", "numero", "complemento", "bairro", "cidade", "uf"];
    const corpo = {};
    for (const k of campos) corpo[k] = String(d[k] || "").slice(0, 200);
    const r = await pedir(env, s, buscar, "/api/conta/cadastro", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(corpo) });
    if (r.sem_conta) return json({ erro: "os dados da nota ficam na assinatura do PAVLVS: assine primeiro, em paulus.ia.br/assinatura" }, 409);
    if (!r.resposta) return json({ erro: r.erro }, 502);
    const v = await r.resposta.json().catch(() => ({}));
    if (!r.resposta.ok) return json({ erro: v.erro || "não deu para salvar" }, r.resposta.status === 403 ? 403 : 400);
    return json({ ok: true, cadastro: v.cadastro || null });
  }

  return json({ erro: "rota não existe" }, 404);
}
