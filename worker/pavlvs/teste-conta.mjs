// Teste da Minha conta (worker/conta.js) e do que ela muda na cobranca
// (worker/ia.js: troca de plano com a diferenca, ofertas, cancelamento,
// cartao, recarga e Pix mensal), sem rede:
//   node worker/teste-conta.mjs
// O Durable Object roda aqui sobre um Map; o Mercado Pago, o Google, a
// Cloudflare e o e-mail sao de mentira. O relogio e um so (Date.now tambem).
import worker from "./index.js";
import { ContaIA, PLANOS_DE_FABRICA, atenderIA, avisoDaIA, cronDaConta, ofertaDeVolta, ofertaParaFicar, orcarTrocaDePlano, pixDoMes, trocarPlanoAgora } from "./ia.js";
import { atenderConta, consumoDo } from "./conta.js";

let falhas = 0;
const checar = (ok, descricao, detalhe) => {
  console.log((ok ? "  ok   " : "  FALHA ") + descricao + (ok || detalhe === undefined ? "" : " -> " + JSON.stringify(detalhe)));
  if (!ok) falhas++;
};

let relogio = Date.parse("2026-10-07T15:00:00Z");
Date.now = () => relogio;
const DIA = 24 * 3600 * 1000;

// ------------------------------------------------ o Durable Object aqui
const objetos = new Map();
function objeto(nome) {
  if (!objetos.has(nome)) {
    const dados = new Map();
    const o = new ContaIA({ storage: { get: async (k) => structuredClone(dados.get(k)), put: async (k, v) => { dados.set(k, structuredClone(v)); } } }, {});
    o.agora = () => relogio;
    objetos.set(nome, { o, dados });
  }
  return objetos.get(nome);
}
const CONTAS_IA = { idFromName: (n) => n, get: (n) => ({ fetch: (url, init) => objeto(n).o.fetch(new Request(url, init)) }) };

// ------------------------------------------------ Mercado Pago e Cloudflare
const mpPedidos = [];
const mpPreapprovals = new Map();
const mpPagamentos = new Map();
const recusarPut = new Set();
const cf = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const metodo = init.method || "GET";
  const corpo = init.body ? JSON.parse(init.body) : null;
  if (u.startsWith("https://api.cloudflare.com/")) {
    cf.push({ u, metodo, corpo });
    return new Response(JSON.stringify({ success: true, result: { status: "healthy", id: "x" } }), { status: 200 });
  }
  if (!u.startsWith("https://api.mercadopago.com")) return new Response("{}", { status: 404 });
  const caminho = u.slice("https://api.mercadopago.com".length);
  mpPedidos.push({ caminho, metodo, corpo });
  if (caminho === "/preapproval" && metodo === "POST") {
    const id = "pre" + mpPreapprovals.size;
    mpPreapprovals.set(id, { id, status: "authorized", external_reference: corpo.external_reference, auto_recurring: { ...corpo.auto_recurring } });
    return new Response(JSON.stringify({ id, status: "authorized" }), { status: 201 });
  }
  let m = caminho.match(/^\/preapproval\/(.+)$/);
  if (m) {
    const p = mpPreapprovals.get(decodeURIComponent(m[1]));
    if (!p) return new Response("{}", { status: 404 });
    if (metodo === "PUT") {
      if (recusarPut.has(p.id)) return new Response("{}", { status: 500 });
      if (corpo.status) p.status = corpo.status;
      if (corpo.auto_recurring) p.auto_recurring = { ...p.auto_recurring, ...corpo.auto_recurring };
      if (corpo.card_token_id) p.card_token_id = corpo.card_token_id;
    }
    return new Response(JSON.stringify(p), { status: 200 });
  }
  m = caminho.match(/^\/v1\/card_tokens\/(.+)$/);
  if (m) return new Response(JSON.stringify({ id: m[1], last_four_digits: "4242", expiration_month: 3, expiration_year: 2031, cardholder: { name: "HELENA MOURA" } }), { status: 200 });
  if (caminho === "/v1/orders" && metodo === "POST") {
    return new Response(JSON.stringify({ id: "ORD1", transactions: { payments: [{ payment_method: { qr_code: "000201pix-recarga", qr_code_base64: "iVBORrec" } }] } }), { status: 201 });
  }
  if (caminho === "/v1/payments" && metodo === "POST") {
    const id = String(8000 + mpPagamentos.size);
    const pg = { id: Number(id), status: "pending", external_reference: corpo.external_reference, transaction_amount: corpo.transaction_amount, payment_method_id: corpo.payment_method_id,
      point_of_interaction: { transaction_data: { qr_code: "00020126pix-mes-" + id, qr_code_base64: "iVBORmes", ticket_url: "https://mp/ticket/" + id } } };
    mpPagamentos.set(id, pg);
    return new Response(JSON.stringify(pg), { status: 201 });
  }
  return new Response("{}", { status: 404 });
};
async function chamarMP(env, caminho, metodo, corpo, extra = {}) {
  const r = await fetch("https://api.mercadopago.com" + caminho, { method: metodo, headers: { ...extra }, body: corpo ? JSON.stringify(corpo) : undefined });
  let dados = null;
  try { dados = await r.json(); } catch { dados = null; }
  return { ok: r.ok, status: r.status, dados };
}

// ------------------------------------------------ o ambiente
const kv = () => {
  const m = new Map();
  return {
    m,
    get: async (k) => (m.has(k) ? m.get(k) : null),
    put: async (k, v) => { m.set(k, v); },
    delete: async (k) => { m.delete(k); },
    list: async ({ prefix }) => ({ list_complete: true, keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }),
  };
};
const APOIOS = kv();
const ESCRITORIOS = kv();
const env = {
  IA_ATIVA: "1", CONTAS_IA, APOIOS, ESCRITORIOS, RESEND_API_KEY: "re_teste", MP_PUBLIC_KEY: "APP_USR-publica",
  IA_PLANOS: JSON.stringify([
    { id: "advogado", nome: "Advogado", valor: 449, valor_anual: 3990, tokens: 30000000 },
    { id: "escritorio", nome: "Escritório", valor: 1290, valor_anual: 11490, tokens: 60000000 },
    { id: "plus", nome: "Escritório Plus", valor: 3490, valor_anual: 30990, tokens: 40000000 },
  ]),
  ASSETS: { fetch: async () => new Response("<!doctype html><title>site</title>", { status: 200, headers: { "content-type": "text/html" } }) },
};
const donos = {
  "tk-helena": { sub: "111", email: "helena@moura.adv.br" },
  "tk-bruno": { sub: "222", email: "bruno@moura.adv.br" },
  "tk-sem": { sub: "333", email: "ninguem@x.com" },
  "tk-ana": { sub: "444", email: "ana@silva.adv.br" },
  "tk-dora": { sub: "555", email: "dora@lima.adv.br" },
};
const emails = [];
const enviar = async (e, carta) => { emails.push(carta); return { ok: true }; };
const deps = { chamarMP, donoDoToken: async (e, t) => donos[t] || null, enviarEmail: enviar };

async function ia(caminho, corpo) {
  const req = new Request("https://paulus.ia.br" + caminho, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(corpo) });
  return atenderIA(req, env, new URL(req.url), { waitUntil: () => null }, deps);
}
async function conta(metodo, caminho, corpo, cookie, origem = "https://paulus.ia.br") {
  const headers = { "content-type": "application/json", origin: origem };
  if (cookie) headers.cookie = "pv_conta=" + cookie;
  const req = new Request("https://paulus.ia.br" + caminho, { method: metodo, headers, body: corpo ? JSON.stringify(corpo) : undefined });
  const r = await atenderConta(req, env, new URL(req.url), { waitUntil: () => null }, deps);
  let d = null;
  try { d = await r.clone().json(); } catch { d = null; }
  return { r, d, status: r.status };
}
const cookieDe = (r) => ((r.headers.get("set-cookie") || "").match(/pv_conta=([0-9a-f]*)/) || [])[1];
async function idDe(sub) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("conta-ia:" + sub));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("").slice(0, 24);
}
const CADASTRO = { nome_escritorio: "Moura Advogados", documento: "529.982.247-25", telefone: "(91) 98888-7777", oab: "OAB/PA 12.345", aceite: true,
  endereco: { cep: "66010-000", logradouro: "Av. Presidente Vargas", numero: "100", complemento: "", bairro: "Campina", cidade: "Belém", uf: "PA", cmun: "1501402" } };
const cartao = (token) => ({ token, payment_method_id: "master", issuer_id: "24", installments: 1, payer: { email: "x@x.com", identification: { type: "CPF", number: "529.982.247-25" } } });
async function assinar(tk, plano) {
  await ia("/api/ia/site/cadastro", { ...CADASTRO, id_token: tk });
  return (await ia("/api/ia/site/pagar", { id_token: tk, plano, periodo: "mensal", cartao: cartao("tok" + tk.replace(/\W/g, "") + "00000000000000") })).json();
}
// A cobranca do mes, como o Mercado Pago avisa (authorized_payment).
async function cobranca(preapproval, valor, id) {
  return avisoDaIA(env, "cobranca", { id, preapproval_id: preapproval, payment: { status: "approved" }, transaction_amount: valor, debit_date: new Date(relogio).toISOString() }, async (e, c, m, corpo) => {
    if (c.startsWith("/preapproval/") && m === "GET") return { ok: true, dados: mpPreapprovals.get(c.slice(13)) };
    return chamarMP(e, c, m, corpo);
  });
}
const resumoDe = async (id) => (await CONTAS_IA.get(id).fetch("https://x/minha_conta", { method: "POST", body: JSON.stringify({ acao: "minha_conta" }) })).json();
const preDe = (id) => [...mpPreapprovals.values()].find((p) => p.external_reference === "ia-assinatura-" + id);

// ================================================= a cobranca (worker/ia.js)
const helena = await idDe("111");
console.log("a troca de plano com a diferença");
{
  await assinar("tk-helena", "advogado");
  const pre = preDe(helena);
  checar(pre && pre.auto_recurring.transaction_amount === 449, "a assinatura do Advogado no cartão", pre);
  let r = await resumoDe(helena);
  checar(r.cartao && r.cartao.final === "4242" && r.cartao.bandeira === "master" && r.cartao.validade === "03/31", "o cartão da assinatura nova fica com a bandeira e o final", r.cartao);
  await cobranca(pre.id, 449, "cob1");
  // Metade do ciclo depois: para o Escritorio, a diferenca e metade de (1290 - 449).
  relogio += 15 * DIA;
  const antes = (await resumoDe(helena)).ciclo_completo;
  const orc = await orcarTrocaDePlano(env, helena, { plano: "escritorio", periodo: "mensal" });
  const t = await trocarPlanoAgora(env, chamarMP, helena, { plano: "escritorio", periodo: "mensal" });
  checar(orc.ok && orc.tipo === "agora" && orc.diferenca === t.diferenca && orc.proxima === t.proxima && orc.vale_em === antes.fim, "o orçamento mostra antes a mesma diferença da troca", { orc, t });
  r = await resumoDe(helena);
  const total = Date.parse(antes.fim) - Date.parse(antes.inicio);
  const f = (Date.parse(antes.fim) - relogio) / total;
  const esperada = Math.round((1290 - 449) * f * 100) / 100;
  checar(t.ok && t.agora && Math.abs(t.diferenca - esperada) < 0.01 && t.proxima === Math.round((1290 + esperada) * 100) / 100, "mais caro: vale agora, a diferença dos dias que faltam", { t, esperada });
  checar(pre.auto_recurring.transaction_amount === t.proxima, "o Mercado Pago passa a cobrar o plano novo mais a diferença", pre.auto_recurring);
  checar(r.plano.id === "escritorio" && r.ciclo_completo.tokens === Math.round(30000000 + 30000000 * f), "o plano muda agora, com a cota proporcional neste ciclo", r.ciclo_completo.tokens);
  checar(r.ajuste && r.ajuste.cobrancas[0] === t.proxima && r.ajuste.valor_cheio === 1290, "a próxima cobrança fica marcada", r.ajuste);
  const outra = await trocarPlanoAgora(env, chamarMP, helena, { plano: "plus", periodo: "mensal" });
  checar(!outra.ok && outra.status === 409, "com uma cobrança ajustada em curso, outra troca espera", outra);
  relogio += 16 * DIA;
  await cobranca(pre.id, t.proxima, "cob2");
  r = await resumoDe(helena);
  checar(pre.auto_recurring.transaction_amount === 1290 && !r.ajuste, "paga a cobrança com a diferença, volta ao valor do plano", { valor: pre.auto_recurring.transaction_amount, ajuste: r.ajuste });
  const orcDesce = await orcarTrocaDePlano(env, helena, { plano: "advogado", periodo: "mensal" });
  checar(orcDesce.ok && orcDesce.tipo === "proxima" && orcDesce.valor === 449 && orcDesce.vale_em && pre.auto_recurring.transaction_amount === 1290, "orçar não muda nada: mais barato vale na próxima", orcDesce);
  const desce = await trocarPlanoAgora(env, chamarMP, helena, { plano: "advogado", periodo: "mensal" });
  r = await resumoDe(helena);
  checar(desce.ok && !desce.agora && r.plano.id === "escritorio" && r.plano_proximo && r.plano_proximo.id === "advogado" && pre.auto_recurring.transaction_amount === 449,
    "mais barato: vale na próxima cobrança, o ciclo pago fica no plano dele", { desce, prox: r.plano_proximo });
  const orcDesfaz = await orcarTrocaDePlano(env, helena, { plano: "escritorio", periodo: "mensal" });
  checar(orcDesfaz.ok && orcDesfaz.tipo === "desfazer" && orcDesfaz.marcado === "Advogado", "o plano de agora, com troca marcada: orçar diz que desfaz", orcDesfaz);
  const desfaz = await trocarPlanoAgora(env, chamarMP, helena, { plano: "escritorio", periodo: "mensal" });
  checar(desfaz.ok && desfaz.desfeita && !(await resumoDe(helena)).plano_proximo && pre.auto_recurring.transaction_amount === 1290, "pedir o plano de agora desfaz a troca marcada", desfaz);
  const ano = await trocarPlanoAgora(env, chamarMP, helena, { plano: "plus", periodo: "anual" });
  checar(ano.ok && ano.proximo === "https://paulus.ia.br/cadastro/pagamento/?plano=plus&periodo=anual", "para o anual: a página de pagamento", ano);
}

console.log("\nas ofertas para ficar");
{
  const o1 = await ofertaParaFicar(env, chamarMP, helena, { tipo: "creditos", motivo: "uso", por: "teste" });
  const r = await resumoDe(helena);
  checar(o1.ok && r.tokens.da_recarga === 20000000 && r.recargas.some((x) => x.cortesia && x.tokens === 20000000), "créditos: 20 M entram agora", { ok: o1.ok, extra: r.tokens.da_recarga });
  const o2 = await ofertaParaFicar(env, chamarMP, helena, { tipo: "desconto", motivo: "preco" });
  checar(!o2.ok && o2.status === 409 && /12 meses/.test(o2.erro), "uma oferta a cada 12 meses", o2);
  // Outra conta: o desconto de 30% nas duas proximas cobrancas.
  const bruno = await idDe("222");
  await assinar("tk-bruno", "escritorio");
  const pre = preDe(bruno);
  await cobranca(pre.id, 1290, "cobB1");
  const d = await ofertaParaFicar(env, chamarMP, bruno, { tipo: "desconto", motivo: "preco" });
  checar(d.ok && pre.auto_recurring.transaction_amount === 903, "desconto: o Mercado Pago passa a cobrar 70%", pre.auto_recurring);
  relogio += 31 * DIA;
  await cobranca(pre.id, 903, "cobB2");
  checar(pre.auto_recurring.transaction_amount === 903, "a primeira com desconto foi paga: a segunda continua com ele");
  relogio += 31 * DIA;
  await cobranca(pre.id, 903, "cobB3");
  checar(pre.auto_recurring.transaction_amount === 1290 && !(await resumoDe(bruno)).ajuste, "depois da segunda, volta ao valor cheio");
}

console.log("\ncancelar com o motivo, e a oferta de volta do painel");
{
  const bruno = await idDe("222");
  const pre = preDe(bruno);
  const c = await (await import("./ia.js")).cancelarPelaConta(env, chamarMP, bruno, { motivo: "preco", texto: "ficou caro neste semestre", por: "Minha conta (bruno@moura.adv.br)" });
  const det = await (await CONTAS_IA.get(bruno).fetch("https://x/admin_detalhe", { method: "POST", body: JSON.stringify({ acao: "admin_detalhe" }) })).json();
  checar(c.ok && pre.status === "cancelled" && det.cancelamento && det.cancelamento.motivo === "preco" && det.cancelamento.texto.includes("caro"),
    "cancelar tira a assinatura do Mercado Pago e o motivo vai para o painel", det.cancelamento);
  const v = await ofertaDeVolta(env, chamarMP, bruno, { tipo: "preco", valor: 900, plano: "escritorio" }, "painel");
  checar(v.ok && !v.na_assinatura, "preço especial com a assinatura cancelada: vale quando assinar de novo", v);
  const of = await (await ia("/api/ia/site/oferta", { id_token: "tk-bruno", plano: "escritorio", periodo: "mensal" })).json();
  checar(of.valor === 900, "a página de pagamento mostra o preço especial", of);
  await ia("/api/ia/site/pagar", { id_token: "tk-bruno", plano: "escritorio", periodo: "mensal", cartao: cartao("tokvolta00000000000000") });
  const nova = [...mpPreapprovals.values()].filter((p) => p.external_reference === "ia-assinatura-" + bruno).at(-1);
  checar(nova.auto_recurring.transaction_amount === 900 && (await resumoDe(bruno)).ajuste.valor_cheio === 1290, "a assinatura nova nasce no preço especial, marcada para voltar", nova.auto_recurring);
  await cobranca(nova.id, 900, "cobB4");
  checar(nova.auto_recurring.transaction_amount === 1290, "paga a primeira, volta ao valor do plano", nova.auto_recurring);
  const cred = await ofertaDeVolta(env, chamarMP, bruno, { tipo: "creditos", tokens: 15000000 }, "painel");
  checar(cred.ok, "créditos de volta: anotados", cred);
  relogio += 31 * DIA;
  const r0 = (await resumoDe(bruno)).tokens.da_recarga;
  await cobranca(nova.id, 1290, "cobB5");
  checar((await resumoDe(bruno)).tokens.da_recarga === r0 + 15000000, "e entram com o próximo pagamento confirmado");
  checar(!(await ofertaDeVolta(env, chamarMP, bruno, { tipo: "cupom" })).ok, "oferta desconhecida é recusada (cupom não existe)");
}

console.log("\no valor que o Mercado Pago recusou voltar");
{
  const bruno = await idDe("222");
  const nova = [...mpPreapprovals.values()].filter((p) => p.external_reference === "ia-assinatura-" + bruno).at(-1);
  await ofertaDeVolta(env, chamarMP, bruno, { tipo: "preco", valor: 1000, plano: "escritorio" }, "painel");
  recusarPut.add(nova.id);
  relogio += 31 * DIA;
  await cobranca(nova.id, 1000, "cobB6");
  checar(APOIOS.m.has("conta:restaurar:" + bruno) && (await resumoDe(bruno)).valor_a_restaurar.valor === 1290, "recusado: fica anotado para o Cron");
  recusarPut.delete(nova.id);
  const cron = await cronDaConta(env, chamarMP, enviar, relogio);
  checar(cron.restaurados === 1 && nova.auto_recurring.transaction_amount === 1290 && !APOIOS.m.has("conta:restaurar:" + bruno), "o Cron do dia tenta de novo e volta ao valor cheio", cron);
}

console.log("\nretomar a assinatura pausada");
{
  // Pausada depois do fim do ciclo, retomada: o ciclo novo (a cota) vem com a cobranca, nao antes dela.
  const t0 = relogio;
  const dora = await idDe("555");
  await assinar("tk-dora", "advogado");
  const pre = preDe(dora);
  await cobranca(pre.id, 449, "cobD1");
  const antes = (await resumoDe(dora)).ciclo_completo;
  relogio = Date.parse(antes.fim) + 5 * DIA;
  const pedir = (d) => CONTAS_IA.get(dora).fetch("https://x/assinatura", { method: "POST", body: JSON.stringify({ acao: "assinatura", ...d }) });
  await pedir({ assinatura: { ...(await resumoDe(dora)).assinatura, situacao: "paused" } });
  await pedir({ assinatura: { ...(await resumoDe(dora)).assinatura, situacao: "authorized" } });
  let r = await resumoDe(dora);
  checar(r.ciclo_completo.inicio === antes.inicio && !r.plano_vigente, "retomada: nenhum ciclo novo antes da cobrança", { ciclo: r.ciclo_completo, vigente: r.plano_vigente });
  await cobranca(pre.id, 449, "cobD2");
  r = await resumoDe(dora);
  checar(r.ciclo_completo.inicio !== antes.inicio && r.plano_vigente && r.ciclo_completo.usados === 0, "a cobrança da retomada abre o ciclo novo", r.ciclo_completo);

  // O painel edita o preco do plano no meio de um ajuste: no fim dele, quem pagava o preco do plano passa ao preco novo.
  const o = await ofertaParaFicar(env, chamarMP, dora, { tipo: "desconto", motivo: "preco" });
  checar(o.ok && pre.auto_recurring.transaction_amount === 314.3, "o desconto para ficar: 70% do Advogado", pre.auto_recurring);
  env.IA_PLANOS = JSON.stringify(PLANOS_DE_FABRICA.map((x) => (x.id === "advogado" ? { ...x, valor: 499 } : x)));
  relogio += 31 * DIA;
  await cobranca(pre.id, 314.3, "cobD3");
  relogio += 31 * DIA;
  await cobranca(pre.id, 314.3, "cobD4");
  checar(pre.auto_recurring.transaction_amount === 499 && !(await resumoDe(dora)).ajuste, "no fim do ajuste, o preço novo do plano (e não o de antes da edição)", pre.auto_recurring);
  delete env.IA_PLANOS;
  relogio = t0;
}

// ================================================= a Minha conta (worker/conta.js)
console.log("\nentrar");
let ck;
{
  checar((await conta("GET", "/api/conta")).status === 401, "sem sessão: 401 (a tela de entrar)");
  checar((await conta("POST", "/api/conta/entrar", { credential: "falso" })).status === 401, "id_token que não confere: 401");
  const sem = await conta("POST", "/api/conta/entrar", { credential: "tk-sem" });
  checar(sem.status === 404 && sem.d.sem_conta, "conta Google sem assinatura nem convite: diz como assinar", sem.d);
  checar((await conta("POST", "/api/conta/entrar", { credential: "tk-helena" }, null, "https://outro.site")).status === 403, "POST de outra origem é recusado");
  const e = await conta("POST", "/api/conta/entrar", { credential: "tk-helena" });
  ck = cookieDe(e.r);
  checar(e.status === 200 && e.d.papel === "titular" && /^[0-9a-f]{64}$/.test(ck) && /HttpOnly/.test(e.r.headers.get("set-cookie")) && /SameSite=Lax/.test(e.r.headers.get("set-cookie")),
    "o titular entra: cookie HttpOnly, SameSite", e.r.headers.get("set-cookie"));
  checar(![...APOIOS.m.keys()].some((k) => k.includes(ck)), "o KV guarda só o resumo do cookie");
}

console.log("\no que a tela lê");
{
  // A Helena ficou sem cobrar enquanto o relogio andava nos testes de cima: a do mes chega agora.
  await cobranca(preDe(helena).id, 1290, "cobH-" + relogio);
  const { d, status } = await conta("GET", "/api/conta", null, ck);
  checar(status === 200 && d.perfil.papel === "titular" && d.perfil.email === "helena@moura.adv.br", "o perfil", d && d.perfil);
  checar(d.assinatura.nome === "Escritório" && d.assinatura.situacao === "ativa" && d.assinatura.periodo === "mensal" && d.assinatura.ciclo.tokens > 0, "a assinatura e o ciclo", d.assinatura);
  checar(d.pagamento.tipo === "cartao" && d.pagamento.cartao.final === "4242", "o pagamento: o cartão com o final", d.pagamento);
  checar(d.faturas.length >= 2 && d.faturas.every((f) => f.situacao === "paga" && f.data), "as faturas: os pagamentos da conta", d.faturas.length);
  checar(d.cadastro.nome === "Moura Advogados" && d.cadastro.documento === "529.982.247-25" && d.cadastro.cidade === "Belém", "o cadastro", d.cadastro);
  checar(d.planos.length === 3 && d.planos[0].modelos_info, "os planos para trocar");
  checar(d.recarga.pacotes.length === 3 && d.recarga.pacotes[1].valor > 0, "os pacotes de recarga do plano", d.recarga);
  checar(d.escritorio === null && Array.isArray(d.instalacoes) && d.google.informado === false, "sem endereço, sem instalação, o Google não informado");
  checar(Array.isArray(d.consumo.dias) && d.consumo.dias.length >= 28 && d.consumo.pessoas.length === 0, "o consumo por dia (por pessoa, no PAULUS do escritório)", d.consumo.dias.length);
}

console.log("\no cadastro e o plano");
{
  const ruim = await conta("POST", "/api/conta/cadastro", { nome: "Moura", documento: "111.111.111-11", telefone: "91988887777", oab: "OAB/PA 1", cep: "66010000", logradouro: "Rua", numero: "1", bairro: "B", cidade: "Belém", uf: "PA" }, ck);
  checar(ruim.status === 400 && /CPF ou CNPJ/.test(ruim.d.erro), "o CPF/CNPJ é conferido", ruim.d);
  const ok = await conta("POST", "/api/conta/cadastro", { nome: "Moura e Souza Advogados", documento: "529.982.247-25", telefone: "(91) 98888-7777", oab: "OAB/PA 12.345",
    email_cobranca: "financeiro@moura.adv.br", cep: "66010-000", logradouro: "Av. Presidente Vargas", numero: "200", complemento: "sala 3", bairro: "Campina", cidade: "Belém", uf: "PA" }, ck);
  const r = await resumoDe(helena);
  checar(ok.status === 200 && r.cadastro.nome_escritorio === "Moura e Souza Advogados" && r.cadastro.email_cobranca === "financeiro@moura.adv.br"
    && r.cadastro.endereco.cmun === "1501402", "salvo; o mesmo CEP mantém o código do município", r.cadastro);
}

console.log("\npessoas: o financeiro");
let ckBruno;
{
  const c = await conta("POST", "/api/conta/pessoas", { email: "bruno@moura.adv.br", papel: "financeiro" }, ck);
  const link = (emails.at(-1) || {}).link || "";
  const token = (link.match(/#convite=([0-9a-f]+)/) || [])[1];
  checar(c.status === 200 && token && emails.at(-1).para === "bruno@moura.adv.br", "o convite vai por e-mail, com o link de 7 dias", c.d);
  const errado = await conta("POST", "/api/conta/entrar", { credential: "tk-ana", convite: token });
  checar(errado.status === 403, "o convite só abre com a conta Google convidada");
  const e = await conta("POST", "/api/conta/entrar", { credential: "tk-bruno", convite: token });
  ckBruno = cookieDe(e.r);
  checar(e.status === 200 && e.d.papel === "financeiro", "o convidado entra como financeiro", e.d);
  checar((await conta("POST", "/api/conta/entrar", { credential: "tk-bruno", convite: token })).status === 410, "o link vale uma vez");
  const v = await conta("GET", "/api/conta", null, ckBruno);
  checar(v.status === 200 && v.d.perfil.papel === "financeiro" && v.d.assinatura.nome === "Escritório", "o financeiro vê a conta do titular", v.d && v.d.perfil);
  checar((await conta("POST", "/api/conta/plano", { plano: "plus" }, ckBruno)).status === 403, "trocar de plano é só do titular");
  checar((await conta("GET", "/api/conta/plano/orcar?plano=plus", null, ckBruno)).status === 403, "orçar a troca também é só do titular");
  const orc = await conta("GET", "/api/conta/plano/orcar?plano=plus&periodo=anual", null, ck);
  checar(orc.status === 200 && orc.d.tipo === "anual" && orc.d.valor > 0, "o titular orça a troca pela Minha conta", orc.d);
  checar((await conta("POST", "/api/conta/cancelar", { motivo: "preco" }, ckBruno)).status === 403, "cancelar é só do titular");
  const lista = (await conta("GET", "/api/conta", null, ck)).d.pessoas;
  checar(lista.length === 2 && lista[1].email === "bruno@moura.adv.br" && lista[1].papel === "financeiro" && !lista[1].convite, "a lista de pessoas", lista);
  await conta("POST", "/api/conta/pessoas/" + encodeURIComponent("bruno@moura.adv.br") + "/remover", {}, ck);
  checar((await conta("GET", "/api/conta", null, ckBruno)).status === 401, "tirado pelo titular: a sessão dele acaba na hora");
}

console.log("\no pagamento pela Minha conta");
{
  const cartaoNovo = await conta("POST", "/api/conta/cartao", { token: "tokcartaonovo00000000", metodo: "visa" }, ck);
  const pre = preDe(helena);
  checar(cartaoNovo.status === 200 && pre.card_token_id === "tokcartaonovo00000000" && cartaoNovo.d.cartao.final === "4242", "o cartão novo vai à assinatura; fica só o final", cartaoNovo.d);
  const rec = await conta("POST", "/api/conta/recarga", { pacote: "1" }, ck);
  checar(rec.status === 200 && rec.d.copia === "000201pix-recarga" && rec.d.qr_code_base64, "a recarga: o Pix com o QR e o copia e cola", rec.d);
  checar((await conta("POST", "/api/conta/recarga", { pacote: "9" }, ck)).status === 400, "pacote que não existe é recusado");
}

console.log("\no Pix mensal");
{
  const ana = await idDe("444");
  await assinar("tk-ana", "advogado");
  const pre = preDe(ana);
  await cobranca(pre.id, 449, "cobA1");
  const ea = await conta("POST", "/api/conta/entrar", { credential: "tk-ana" });
  const ckAna = cookieDe(ea.r);
  const sem = await conta("POST", "/api/conta/forma", { tipo: "pix" }, ckAna);
  const r = await resumoDe(ana);
  checar(sem.status === 200 && pre.status === "cancelled" && r.forma.tipo === "pix" && r.periodo === "avulso" && APOIOS.m.has("conta:pix:" + ana),
    "no Pix: o cartão sai, o ciclo pago vira o mês pago", { forma: r.forma, periodo: r.periodo });
  const cedo = await pixDoMes(env, chamarMP, ana, { enviar, agora: relogio });
  checar(!cedo.ok && cedo.motivo === "ainda não é hora", "longe do fim do mês: nada", cedo);
  relogio = Date.parse(r.pago_ate) - 2 * DIA;
  const n0 = emails.length;
  const cron = await cronDaConta(env, chamarMP, enviar, relogio);
  const carta = emails.at(-1);
  checar(cron.pix === 1 && emails.length === n0 + 1 && carta.para === "ana@silva.adv.br" && /00020126pix-mes/.test(carta.texto) && carta.anexos.length === 1,
    "3 dias antes, o Cron manda o Pix do mês por e-mail (QR no anexo)", { cron, para: carta && carta.para });
  checar((await pixDoMes(env, chamarMP, ana, { enviar, agora: relogio })).motivo === "já mandado para este mês", "uma vez por mês");
  const pg = [...mpPagamentos.values()].at(-1);
  checar(/^ia-mes-[0-9a-f]{24}-advogado-[0-9a-f]+$/.test(pg.external_reference) && pg.transaction_amount === 449, "o Pix é o mês avulso do plano", pg.external_reference);
  pg.status = "approved";
  pg.id = Number(pg.id);
  const antes = (await resumoDe(ana)).pago_ate;
  await avisoDaIA(env, "pagamento", { ...pg }, chamarMP);
  const depois = (await resumoDe(ana)).pago_ate;
  checar(Date.parse(depois) > Date.parse(antes) + 27 * DIA, "pago, o mês seguinte entra", { antes, depois });
  checar((await conta("GET", "/api/conta", null, ckAna)).status === 401, "a sessão vence em 12 horas");
  const ckAna2 = cookieDe((await conta("POST", "/api/conta/entrar", { credential: "tk-ana" })).r);
  const tela = await conta("GET", "/api/conta", null, ckAna2);
  checar(tela.d.pagamento.tipo === "pix" && tela.d.assinatura.forma === "pix", "a tela mostra o Pix como forma", tela.d.pagamento);
  const volta = await conta("POST", "/api/conta/forma", { tipo: "cartao" }, ckAna2);
  checar(volta.status === 409 && /página de pagamento/.test(volta.d.erro) && volta.d.proximo.includes("/cadastro/pagamento/"), "do Pix ao cartão: pela página de pagamento, quando o mês acabar", volta.d);
}

console.log("\nescritório, instalações, Google e notas");
{
  await ESCRITORIOS.put("escritorio:moura", JSON.stringify({ slug: "moura", nome: "Moura Advogados", tunnel_id: "t1", dns_id: "d1", porta: 8000, hash_segredo: "h1",
    instalacao_id: "inst-0001-abcd", dono: { sub: "111", email: "helena@moura.adv.br" }, ultima_conexao: new Date(relogio).toISOString(), criado_em: "2026-10-01T00:00:00Z" }));
  await ESCRITORIOS.put("dono:111", JSON.stringify({ slugs: ["moura"] }));
  await ESCRITORIOS.put("escritorio:ocupado", JSON.stringify({ slug: "ocupado", dono: { sub: "999", email: "x@x.com" } }));
  env.CF_ACCOUNT_ID = "acc";
  env.CF_ZONE_ID = "zona";
  env.CF_API_TOKEN = "cf";
  env.TUNEL_ATIVO = "1";
  const ativa = await (await ia("/api/ia/ativar", { id_token: "tk-helena", instalacao_id: "inst-0001-abcd" })).json();
  // O link de entrada que o Paulus pede ("edite no site", "Fazer upgrade"): abre a Minha conta ja com a sessao.
  const pedirLink = async (corpo, segredo) => {
    const req = new Request("https://paulus.ia.br/api/ia/minha-conta/link", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + segredo }, body: JSON.stringify(corpo) });
    const r = await atenderIA(req, env, new URL(req.url), { waitUntil: () => null }, deps);
    return { status: r.status, d: await r.json() };
  };
  const lk = await pedirLink({ aba: "cadastro" }, ativa.segredo);
  const codigoLink = ((lk.d.url || "").match(/\?entrar=([0-9a-f]{64})#cadastro$/) || [])[1];
  checar(lk.status === 200 && lk.d.url.startsWith("https://paulus.ia.br/minha-conta/?entrar=") && codigoLink, "o Paulus pede o link da Minha conta, na aba Cadastro", lk.d);
  checar((await pedirLink({ aba: "plano" }, "pia_" + "0".repeat(24) + "_" + "0".repeat(64))).status === 401, "sem o segredo da instalação: 401");
  const porLink = await conta("POST", "/api/conta/entrar", { link: codigoLink });
  const ckLink = cookieDe(porLink.r);
  const dLink = ckLink && (await conta("GET", "/api/conta", null, ckLink)).d;
  checar(porLink.status === 200 && porLink.d.papel === "titular" && dLink && !dLink.entrar, "o link abre a sessão do titular, sem pedir login", [porLink.status, porLink.d, dLink && Object.keys(dLink)]);
  checar((await conta("POST", "/api/conta/entrar", { link: codigoLink })).status === 410, "o link vale uma vez");
  // O relogio andou semanas no Pix mensal: a sessao de 12 horas venceu.
  ck = cookieDe((await conta("POST", "/api/conta/entrar", { credential: "tk-helena" })).r);
  const d = (await conta("GET", "/api/conta", null, ck)).d;
  checar(d.escritorio && d.escritorio.slug === "moura" && d.escritorio.online, "o endereço do escritório, no ar", d.escritorio);
  checar(d.instalacoes.length === 1 && d.instalacoes[0].principal, "a instalação do túnel é a principal", d.instalacoes);
  checar((await conta("GET", "/api/conta/endereco/disponivel?slug=ocupado", null, ck)).d.disponivel === false, "endereço em uso: não");
  checar((await conta("GET", "/api/conta/endereco/disponivel?slug=moura-souza", null, ck)).d.disponivel === true, "endereço livre: sim");
  const troca = await conta("POST", "/api/conta/endereco", { slug: "moura-souza" }, ck);
  checar(troca.status === 200 && JSON.parse(await ESCRITORIOS.get("escritorio:moura-souza")).slug === "moura-souza" && !(await ESCRITORIOS.get("escritorio:moura")),
    "trocar o endereço move o registro do túnel", troca.d);
  const evs = [];
  for (const [k, v] of ESCRITORIOS.m) if (k.startsWith("evento:")) evs.push(JSON.parse(v));
  checar(evs.some((e) => e.evento === "alterado" && e.slug === "moura-souza" && e.de === "moura" && e.quem === "Minha conta (helena@moura.adv.br)"),
    "o registro de endereços do painel diz que foi pela Minha conta, e de quem", evs);
  const g = await conta("POST", "/api/conta/google/servico", { id: "gmail", ligado: true }, ck);
  const g2 = await conta("POST", "/api/conta/google/servico", { id: "agenda", ligado: true }, ck);
  const g3 = await conta("POST", "/api/conta/google/servico", { id: "gmail", ligado: false }, ck);
  checar(g.status === 200 && g3.d.ligados.length === 1 && g3.d.ligados[0] === "calendar.events" && (await resumoDe(helena)).google_pendente.ligados[0] === "calendar.events",
    "os serviços do Google viram a ordem para o PAULUS do escritório", g3.d);
  await conta("POST", "/api/conta/google/desvincular", {}, ck);
  checar((await resumoDe(helena)).google_pendente.ligados.length === 0, "desvincular: nenhum serviço fica");
  // As notas da conta, como o emissor grava.
  await APOIOS.put("nfse:nota:" + helena + ":nuvem-1", JSON.stringify({ id: "nuvem-1", conta: helena, numero: "41", competencia: "2026-10", valor: 1290 }));
  await APOIOS.put("nfse:nota-pdf:" + helena + ":nuvem-1", btoa("%PDF-1.4 nota"));
  await APOIOS.put("nfse:nota-xml:" + helena + ":nuvem-1", btoa("<NFSe/>"));
  const z = await conta("GET", "/api/conta/nfse.zip?ano=2026", null, ck);
  const bytes = new Uint8Array(await z.r.arrayBuffer());
  checar(z.status === 200 && bytes[0] === 0x50 && bytes[1] === 0x4b && new TextDecoder().decode(bytes).includes("NFS-e 41.pdf"), "as NFS-e do ano num .zip", bytes.length);
  checar((await conta("GET", "/api/conta/nfse/nuvem-1/xml", null, ck)).status === 200, "o XML de uma nota");
  checar((await conta("GET", "/api/conta/nfse.zip?ano=2019", null, ck)).status === 404, "ano sem notas: 404");
  const rm = await conta("POST", "/api/conta/instalacoes/inst-0001-abcd/remover", {}, ck);
  checar(rm.status === 200 && (await resumoDe(helena)).instalacoes_lista.length === 0, "tirar o computador apaga o segredo dele");
}

console.log("\no consumo de outro ciclo e o sair");
{
  const r = await resumoDe(helena);
  const ant = consumoDo(r, "anterior", relogio);
  checar(ant.dias.length >= 28 && ant.de < ant.ate, "o ciclo anterior, dia a dia", { de: ant.de, ate: ant.ate });
  const sai = await conta("POST", "/api/conta/sair", {}, ck);
  checar(/Max-Age=0/.test(sai.r.headers.get("set-cookie")) && (await conta("GET", "/api/conta", null, ck)).status === 401, "sair apaga a sessão");
}

console.log("\npelo Worker inteiro");
{
  const w = await worker.fetch(new Request("https://paulus.ia.br/api/conta"), env, { waitUntil: () => null });
  checar(w.status === 401, "/api/conta vai à Minha conta");
  const p = await worker.fetch(new Request("https://paulus.ia.br/minha-conta/"), env, { waitUntil: () => null });
  checar(/sdk\.mercadopago\.com/.test(p.headers.get("content-security-policy") || ""), "a página tem a CSP do cadastro (o cartão e o Google)");
}

console.log(falhas ? "\n  Minha conta: " + falhas + " falha(s)" : "\n  Minha conta: todos os testes passaram");
process.exit(falhas ? 1 : 0);
