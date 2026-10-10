// Teste da nuvem do PAULUS no Worker (worker/ia.js), sem rede:
//   node worker/teste-ia.mjs
// O DeepInfra e o Mercado Pago sao de mentira; o Durable Object roda aqui,
// com a mesma classe, sobre um Map.
import { createHmac } from "node:crypto";
import worker from "./index.js";
import { atenderIA, ContaIA, usoDoFim } from "./ia.js";

let falhas = 0;
const checar = (ok, descricao, detalhe) => {
  console.log((ok ? "  ok   " : "  FALHA ") + descricao + (ok || detalhe === undefined ? "" : " -> " + JSON.stringify(detalhe)));
  if (!ok) falhas++;
};

// ------------------------------------------------ o Durable Object aqui
let relogio = Date.parse("2026-10-01T12:00:00Z");
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
const CONTAS_IA = {
  idFromName: (n) => n,
  get: (n) => ({ fetch: (url, init) => objeto(n).o.fetch(new Request(url, init)) }),
};

// ------------------------------------------------ DeepInfra e Mercado Pago
const deepinfra = [];
let respostaDoModelo = "padrao";
function sse(pedacos, uso) {
  const linhas = pedacos.map((t) => "data: " + JSON.stringify({ choices: [{ delta: { content: t } }] }) + "\n\n");
  if (uso) linhas.push("data: " + JSON.stringify({ choices: [], usage: uso }) + "\n\n");
  linhas.push("data: [DONE]\n\n");
  return new ReadableStream({
    start(c) {
      for (const l of linhas) c.enqueue(new TextEncoder().encode(l));
      c.close();
    },
  });
}
const claude = [];
const mistral = [];
let respostaDoClaude = "padrao";
const mpPagamentos = new Map();
const mpPedidos = [];
const mpOrders = new Map();
const mpPreapprovals = new Map();
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith("https://api.deepinfra.com/")) {
    const corpo = JSON.parse(init.body);
    deepinfra.push({ corpo, auth: init.headers.Authorization });
    if (respostaDoModelo === "erro") return new Response(JSON.stringify({ error: { message: "model overloaded" } }), { status: 503 });
    if (!corpo.stream) {
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 120, completion_tokens: 30 } }), { status: 200 });
    }
    const uso = respostaDoModelo === "sem-uso" ? null : { prompt_tokens: 1000, completion_tokens: 200 };
    return new Response(sse(["O contrato ", "vence em ", "10/10."], uso), { status: 200, headers: { "content-type": "text/event-stream" } });
  }
  if (u.startsWith("https://api.anthropic.com/")) {
    const corpo = JSON.parse(init.body);
    claude.push({ corpo, headers: init.headers });
    if (respostaDoClaude === "recusa" && !corpo.stream) {
      return new Response(JSON.stringify({ id: "msg_r", model: corpo.model, content: [], stop_reason: "refusal", usage: { input_tokens: 50, output_tokens: 0 } }), { status: 200 });
    }
    if (!corpo.stream) {
      return new Response(JSON.stringify({ id: "msg_1", model: corpo.model, content: [{ type: "thinking", thinking: "" }, { type: "text", text: '{"ok":true}' }],
        stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 20 } }), { status: 200 });
    }
    const ev = (o) => "event: " + o.type + "\ndata: " + JSON.stringify(o) + "\n\n";
    const partes = [
      ev({ type: "message_start", message: { id: "msg_2", model: corpo.model, usage: { input_tokens: 900, cache_read_input_tokens: 100, output_tokens: 1 } } }),
      ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Prazo de " } }),
      ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "15 dias." } }),
      ev({ type: "content_block_stop", index: 0 }),
      ev({ type: "message_delta", delta: { stop_reason: respostaDoClaude === "recusa" ? "refusal" : "end_turn" }, usage: { output_tokens: 50 } }),
      ev({ type: "message_stop" }),
    ].join("");
    // Partido no meio de uma linha, como a rede entrega.
    const bytes = new TextEncoder().encode(partes);
    return new Response(new ReadableStream({ start(c) { c.enqueue(bytes.slice(0, 137)); c.enqueue(bytes.slice(137)); c.close(); } }),
      { status: 200, headers: { "content-type": "text/event-stream" } });
  }
  if (u.startsWith("https://api.mistral.ai/")) {
    const corpo = JSON.parse(init.body);
    mistral.push({ corpo, auth: init.headers.Authorization });
    return new Response(sse(["Mistral ", "responde."], { prompt_tokens: 500, completion_tokens: 100 }), { status: 200, headers: { "content-type": "text/event-stream" } });
  }
  if (u.startsWith("https://api.mercadopago.com")) {
    const caminho = u.slice("https://api.mercadopago.com".length);
    const metodo = init.method || "GET";
    const corpo = init.body ? JSON.parse(init.body) : null;
    mpPedidos.push({ caminho, metodo, corpo, headers: init.headers || {} });
    if (caminho === "/preapproval" && metodo === "POST") {
      // Com o token do cartao, a assinatura ja nasce autorizada; o token "tokrecusa..." e recusado.
      if (String(corpo.card_token_id || "").startsWith("tokrecusa")) return new Response(JSON.stringify({ message: "Card token invalid" }), { status: 400 });
      const id = "pre" + mpPreapprovals.size + "abc";
      const status = corpo.card_token_id ? "authorized" : "pending";
      mpPreapprovals.set(id, { id, status, external_reference: corpo.external_reference, auto_recurring: corpo.auto_recurring });
      return new Response(JSON.stringify({ id, status, ...(status === "pending" ? { init_point: "https://www.mercadopago.com.br/subscriptions/checkout?preapproval_id=" + id } : {}) }), { status: 201 });
    }
    if (caminho === "/checkout/preferences" && metodo === "POST") {
      const id = "PREF" + mpPedidos.length;
      return new Response(JSON.stringify({ id, init_point: "https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=" + id }), { status: 201 });
    }
    if (caminho === "/v1/payments" && metodo === "POST") {
      // O pagamento do cartao: "tokrecusa..." sem limite, "tokanalise..." em analise, o resto aprovado.
      const id = String(7000 + mpPagamentos.size);
      const t = String(corpo.token || "");
      const pix = corpo.payment_method_id === "pix";
      const status = pix ? "pending" : t.startsWith("tokrecusa") ? "rejected" : t.startsWith("tokanalise") ? "in_process" : "approved";
      const pg = { id: Number(id), status, status_detail: status === "rejected" ? "cc_rejected_insufficient_amount" : status === "approved" ? "accredited" : "pending_contingency",
        external_reference: corpo.external_reference, transaction_amount: corpo.transaction_amount, date_approved: status === "approved" ? new Date(relogio).toISOString() : null,
        payment_method_id: corpo.payment_method_id,
        ...(pix ? { point_of_interaction: { transaction_data: { qr_code: "00020126pix" + id, qr_code_base64: "iVBORpix", ticket_url: "https://www.mercadopago.com.br/payments/" + id + "/ticket" } } } : {}) };
      mpPagamentos.set(id, pg);
      return new Response(JSON.stringify(pg), { status: 201 });
    }
    let m = caminho.match(/^\/preapproval\/(.+)$/);
    if (m) {
      const p = mpPreapprovals.get(decodeURIComponent(m[1]));
      if (!p) return new Response("{}", { status: 404 });
      if (metodo === "PUT") Object.assign(p, corpo);
      return new Response(JSON.stringify(p), { status: 200 });
    }
    if (caminho === "/v1/orders" && metodo === "POST") {
      const id = "ORD" + (mpOrders.size + 1) + "XYZ";
      mpOrders.set(id, { id, status: "action_required", external_reference: corpo.external_reference, total_amount: corpo.total_amount });
      return new Response(JSON.stringify({ id, status: "action_required",
        transactions: { payments: [{ payment_method: { qr_code: "000201pix", qr_code_base64: "iVBOR" } }] } }), { status: 201 });
    }
    m = caminho.match(/^\/v1\/orders\/(.+)$/);
    if (m) {
      const o = mpOrders.get(decodeURIComponent(m[1]));
      return o ? new Response(JSON.stringify(o), { status: 200 }) : new Response("{}", { status: 404 });
    }
    m = caminho.match(/^\/v1\/payments\/(\w+)\/refunds$/);
    if (m && metodo === "POST") {
      const pg = mpPagamentos.get(m[1]);
      if (!pg) return new Response("{}", { status: 404 });
      pg.status = "refunded";
      return new Response(JSON.stringify({ id: 9000 + mpPagamentos.size, payment_id: pg.id, status: "approved", amount: pg.transaction_amount }), { status: 201 });
    }
    m = caminho.match(/^\/v1\/payments\/search\?external_reference=([^&]+)/);
    if (m) {
      const ref = decodeURIComponent(m[1]);
      return new Response(JSON.stringify({ results: [...mpPagamentos.values()].filter((x) => x.external_reference === ref) }), { status: 200 });
    }
    m = caminho.match(/^\/v1\/payments\/(\w+)$/);
    if (m) {
      const pg = mpPagamentos.get(m[1]);
      return pg ? new Response(JSON.stringify(pg), { status: 200 }) : new Response("{}", { status: 404 });
    }
    m = caminho.match(/^\/authorized_payments\/(.+)$/);
    if (m) {
      return new Response(JSON.stringify({ id: m[1], preapproval_id: "pre0abc", payment: { status: "approved" }, transaction_amount: 300,
        debit_date: new Date(relogio).toISOString() }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }
  return new Response("{}", { status: 404 });
};

async function chamarMP(env, caminho, metodo, corpo, extra = {}) {
  const r = await fetch("https://api.mercadopago.com" + caminho, { method: metodo, headers: { ...extra }, body: corpo ? JSON.stringify(corpo) : undefined });
  let dados = null;
  try { dados = await r.json(); } catch { dados = null; }
  return { ok: r.ok, status: r.status, dados };
}

const guardados = new Map();
const env = {
  IA_ATIVA: "1",
  CONTAS_IA,
  DEEPINFRA_KEY: "chave-do-deepinfra-so-no-worker",
  IA_PLANOS: JSON.stringify([
    { id: "advogado", nome: "Advogado", valor: 150, valor_anual: 1500, tokens: 12000000, recarga: { valor: 50, tokens: 5000 } },
    { id: "escritorio", nome: "Escritório", valor: 300, valor_anual: 3000, tokens: 30000, recarga: { valor: 50, tokens: 5000 },
      modelos: { padrao: "meta-llama/Llama-3.3-70B-Instruct" } },
    { id: "plus", nome: "Escritório Plus", valor: 550, valor_anual: 5500, tokens: 60000000, recarga: { valor: 50, tokens: 5000 } },
  ]),
  IA_POR_MINUTO: "100",
  MP_WEBHOOK_SECRET: "segredo-de-teste",
  MP_ACCESS_TOKEN: "sem-token",
  ASSETS: { fetch: async () => new Response("site", { status: 200 }) },
  APOIOS: {
    get: async (k) => guardados.get(k) || null,
    getWithMetadata: async (k) => ({ value: guardados.get(k) || null, metadata: null }),
    put: async (k, v) => { guardados.set(k, v); },
    list: async ({ prefix }) => ({ list_complete: true, keys: [...guardados.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }),
  },
};
// O painel admin (worker/admin.js) guarda no APOIOS so chaves "admin:" e
// nenhum dado pessoal: o indice das contas e a fila de notas fiscais (conta,
// tipo, valor). Nada com e-mail ou nome.
const soAdminSemPessoa = () => [...guardados.entries()].every(([k, v]) => k.startsWith("admin:") && !/@|dono|escritorio\.com/i.test(String(v)));
const donos = { "token-do-dono": { sub: "1234567890", email: "dono@escritorio.com.br" }, "token-cortesia": { sub: "999", email: "fundador@paulus.ia.br" } };
const deps = { chamarMP, donoDoToken: async (e, t) => donos[t] || null };
const pendentes = [];
const ctx = { waitUntil: (p) => pendentes.push(p) };

async function ia(metodo, caminho, corpo, segredo) {
  const headers = { "content-type": "application/json" };
  if (segredo) headers.authorization = "Bearer " + segredo;
  const req = new Request("https://paulus.ia.br" + caminho, { method: metodo, headers, body: corpo ? JSON.stringify(corpo) : undefined });
  return atenderIA(req, env, new URL(req.url), ctx, deps);
}
const corpoDe = async (r) => r.json();
// O que o bloco de cartao do Mercado Pago entrega no onSubmit (o token e de mentira).
const cartao = (token = "tokaprovado00000000001", extra = {}) => ({ token, payment_method_id: "master", issuer_id: "24", installments: 1,
  transaction_amount: 1, payer: { email: "qualquer@x.com", identification: { type: "CPF", number: "529.982.247-25" } }, ...extra });
// Os dados do escritorio (a pagina de cadastro), sem o id_token.
const CADASTRO = { nome_escritorio: "Moura Advogados", documento: "529.982.247-25", telefone: "(91) 98888-7777", oab: "OAB/PA 12.345", aceite: true,
  endereco: { cep: "66.010-000", logradouro: "Av. Presidente Vargas", numero: "100", complemento: "", bairro: "Campina", cidade: "Belém", uf: "PA", cmun: "1501402" } };

// ------------------------------------------------ desligada
{
  const r = await atenderIA(new Request("https://paulus.ia.br/api/ia/conta"), { ...env, IA_ATIVA: "0" }, new URL("https://paulus.ia.br/api/ia/conta"), ctx, deps);
  checar(r.status === 404, "sem IA_ATIVA as rotas não existem");
  const w = await worker.fetch(new Request("https://paulus.ia.br/api/ia/conta"), { ...env, IA_ATIVA: "0" }, ctx);
  checar(w.status === 404, "pelo Worker inteiro também (rota /api/ia/* vai a ia.js)");
}

// ------------------------------------------------ ativar
let segredo;
{
  const r0 = await ia("POST", "/api/ia/ativar", { id_token: "falso", instalacao_id: "inst-0001-abcd" });
  checar(r0.status === 401, "ativar com id_token que não confere é recusado");
  const r = await ia("POST", "/api/ia/ativar", { id_token: "token-do-dono", instalacao_id: "inst-0001-abcd", nome_escritorio: "Moura <b>Advogados</b>" });
  const d = await corpoDe(r);
  segredo = d.segredo;
  checar(r.status === 200 && /^pia_[0-9a-f]{24}_[0-9a-f]{64}$/.test(segredo), "ativar devolve o segredo da instalação", d);
  checar(d.conta.email === "dono@escritorio.com.br" && d.conta.nome === "Moura bAdvogados/b", "a conta é do e-mail do Google; o nome sem marcação", d.conta);
  checar(!d.conta.plano_vigente && d.conta.tokens.restantes === 0, "conta nova não tem plano nem tokens", d.conta);
  const guardado = [...objetos.values()][0].dados.get("conta");
  checar(!JSON.stringify(guardado).includes(segredo.slice(30)), "o medidor guarda só o resumo do segredo");
  const r2 = await ia("GET", "/api/ia/conta", null, "pia_" + "0".repeat(24) + "_" + "1".repeat(64));
  checar(r2.status === 401, "segredo inventado é recusado");
  const r3 = await ia("GET", "/api/ia/conta", null, segredo);
  checar(r3.status === 200, "o segredo dá acesso à conta");
}

// ------------------------------------------------ o portão antes do plano
const pergunta = { model: "meta-llama/Llama-3.3-70B-Instruct", messages: [{ role: "system", content: "Você é o PAULUS." }, { role: "user", content: "Quando vence o contrato?" }], stream: true, max_tokens: 2000 };
{
  const r = await ia("POST", "/api/ia/v1/chat/completions", pergunta, segredo);
  const d = await corpoDe(r);
  checar(r.status === 403 && d.motivo === "consentimento", "sem o sim do titular, nada sai", d);
  await ia("POST", "/api/ia/consentimento", { aceito: true, versao: "2026-10-01", quem: "Dra. Helena" }, segredo);
  const r2 = await ia("POST", "/api/ia/v1/chat/completions", pergunta, segredo);
  const d2 = await corpoDe(r2);
  checar(r2.status === 402 && d2.motivo === "sem_plano", "com o sim mas sem plano: 402", d2);
  checar(deepinfra.length === 0, "nenhum pedido chegou ao DeepInfra");
}

// ------------------------------------------------ assinar
let preId;
{
  const r = await ia("POST", "/api/ia/assinar", { plano: "escritorio" }, segredo);
  const d = await corpoDe(r);
  checar(r.status === 200 && d.link === "https://paulus.ia.br/cadastro/pagamento/?plano=escritorio&periodo=mensal" && !mpPedidos.some((p) => p.caminho === "/preapproval"),
    "o PAULUS instalado abre a página de pagamento do site; nada é criado no Mercado Pago", d);
  const pagar = (corpo) => ia("POST", "/api/ia/site/pagar", { id_token: "token-do-dono", plano: "escritorio", periodo: "mensal", cartao: cartao(), ...corpo });
  checar((await pagar({})).status === 409, "sem os dados do escritório, não cobra");
  const cad = await corpoDe(await ia("POST", "/api/ia/site/cadastro", { ...CADASTRO, id_token: "token-do-dono", plano: "escritorio" }));
  checar(cad.proximo === "https://paulus.ia.br/cadastro/pagamento/?plano=escritorio&periodo=mensal" && cad.cadastro, "o cadastro com o plano leva à página de pagamento", cad);
  const of = await corpoDe(await ia("POST", "/api/ia/site/oferta", { id_token: "token-do-dono", plano: "escritorio", periodo: "mensal" }));
  checar(of.valor === 300 && of.parcelas_max === 1 && of.email === "dono@escritorio.com.br" && of.cadastro_completo, "a oferta: o valor e as parcelas vêm do servidor", of);
  checar((await pagar({ cartao: cartao(undefined, { installments: 3 }) })).status === 400, "a assinatura mensal é sem parcelas");
  checar((await pagar({ cartao: cartao("12") })).status === 400, "token que não parece do bloco é recusado");
  checar((await pagar({ cartao: cartao(undefined, { payer: { identification: { type: "CPF", number: "111.111.111-11" } } }) })).status === 400,
    "o CPF do titular do cartão é conferido");
  const ruim = await pagar({ cartao: cartao("tokrecusa000000000001") });
  checar(ruim.status === 402 && (await corpoDe(ruim)).erro.includes("não aceitou o cartão"), "cartão recusado na assinatura: 402, com a frase");
  const r2 = await pagar({});
  const d2 = await corpoDe(r2);
  const criado = mpPedidos.filter((p) => p.caminho === "/preapproval" && p.metodo === "POST").at(-1).corpo;
  preId = [...mpPreapprovals.keys()].at(-1);
  checar(r2.status === 200 && d2.situacao === "authorized" && criado.status === "authorized" && criado.card_token_id === "tokaprovado00000000001"
    && criado.auto_recurring.transaction_amount === 300 && /^ia-assinatura-[0-9a-f]{24}$/.test(criado.external_reference)
    && criado.payer_email === "dono@escritorio.com.br" && criado.init_point === undefined,
    "o token do cartão vira a assinatura autorizada de R$ 300/mês (o valor é o do servidor, e não o do bloco)", criado);
  checar(d2.conta.plano_vigente, "e o plano vale na hora, sem esperar o aviso");
  checar((await pagar({ cartao: cartao("tokaprovado00000000009") })).status === 409, "com a assinatura ativa, não cobra de novo");
  // O aviso do Mercado Pago chega pelo Worker inteiro e não muda nada.
  const av = await worker.fetch(aviso(preId, "subscription_preapproval"), env, ctx);
  await Promise.all(pendentes.splice(0));
  checar(av.status === 200, "o aviso da assinatura é aceito");
  const c = await corpoDe(await ia("GET", "/api/ia/conta", null, segredo));
  checar(c.plano_vigente && c.tokens.do_mes === 30000 && c.tokens.restantes === 7000 && c.assinatura.situacao === "authorized",
    "assinatura ativa abre o ciclo com a cota do plano; a da semana é 7/30 dela", c.tokens);
  checar(soAdminSemPessoa(), "a assinatura da nuvem só grava no KV APOIOS o que é do painel, sem dado pessoal", [...guardados.keys()]);
  // A primeira cobrança (logo depois) só confirma o ciclo aberto.
  await worker.fetch(aviso("cob-1", "subscription_authorized_payment"), env, ctx);
  await Promise.all(pendentes.splice(0));
  const c2 = await corpoDe(await ia("GET", "/api/ia/conta", null, segredo));
  checar(c2.ciclo.inicio === c.ciclo.inicio && c2.tokens.restantes === 7000, "a primeira cobrança não abre um segundo ciclo", c2.ciclo);
  checar(soAdminSemPessoa() && [...guardados.keys()].includes("admin:nfse:cob-1"), "a cobrança do plano entra na fila de notas fiscais, sem dado pessoal", [...guardados.keys()]);
}

// ------------------------------------------------ chamar
{
  const r = await ia("POST", "/api/ia/v1/chat/completions", pergunta, segredo);
  checar(r.status === 200 && r.headers.get("content-type").startsWith("text/event-stream"), "com plano, a resposta vem aos pedaços");
  const texto = await r.text();
  await Promise.all(pendentes.splice(0));
  checar(texto.includes("vence em ") && texto.includes('"usage"'), "os pedaços passam como vieram");
  const enviado = deepinfra[deepinfra.length - 1];
  checar(enviado.auth === "Bearer chave-do-deepinfra-so-no-worker" && enviado.corpo.stream_options.include_usage, "vai ao DeepInfra com a chave do Worker e pedindo o uso");
  const c = await corpoDe(await ia("GET", "/api/ia/conta", null, segredo));
  checar(c.tokens.restantes === 7000 - 1200 && c.semana.usados === 1200 && c.tokens.reservados === 0 && c.tokens.hoje === 1200,
    "desconta o uso real (1.000 + 200) da semana e solta a reserva", c.tokens);
  // max_tokens acima do teto é cortado.
  await (await ia("POST", "/api/ia/v1/chat/completions", { ...pergunta, max_tokens: 99999 }, segredo)).text();
  await Promise.all(pendentes.splice(0));
  checar(deepinfra[deepinfra.length - 1].corpo.max_tokens === 4000, "a saída pedida passa do teto: vai com 4.000");
  // Modelo fora da lista.
  const r3 = await ia("POST", "/api/ia/v1/chat/completions", { ...pergunta, model: "gpt-4o" }, segredo);
  checar(r3.status === 400, "modelo fora da lista é recusado");
  // Texto grande demais.
  const r4 = await ia("POST", "/api/ia/v1/chat/completions", { ...pergunta, messages: [{ role: "user", content: "x".repeat(250000) }] }, segredo);
  checar(r4.status === 413, "texto acima do teto de um pedido é recusado");
  // Sem o uso no fim: entrada estimada + um token por pedaço.
  respostaDoModelo = "sem-uso";
  const antes = (await corpoDe(await ia("GET", "/api/ia/conta", null, segredo))).tokens.restantes;
  await (await ia("POST", "/api/ia/v1/chat/completions", { ...pergunta, max_tokens: 500 }, segredo)).text();
  await Promise.all(pendentes.splice(0));
  const depois = (await corpoDe(await ia("GET", "/api/ia/conta", null, segredo))).tokens.restantes;
  const gasto = antes - depois;
  checar(gasto > 0 && gasto < 500, "sem o uso, cobra pela estimativa (e não a reserva inteira)", gasto);
  // O provedor com erro: nada é cobrado.
  respostaDoModelo = "erro";
  const r5 = await ia("POST", "/api/ia/v1/chat/completions", pergunta, segredo);
  const d5 = await corpoDe(r5);
  const depois2 = (await corpoDe(await ia("GET", "/api/ia/conta", null, segredo))).tokens;
  checar(r5.status === 502 && d5.erro.includes("overloaded") && depois2.restantes === depois && depois2.reservados === 0, "erro do provedor: 502 e a reserva volta", { d5, depois2 });
  respostaDoModelo = "padrao";
  // Sem stream (o pedido de JSON).
  const r6 = await ia("POST", "/api/ia/v1/chat/completions", { ...pergunta, stream: false, response_format: { type: "json_object" } }, segredo);
  const d6 = await corpoDe(r6);
  checar(r6.status === 200 && d6.paulus.tokens === 150 && deepinfra[deepinfra.length - 1].corpo.response_format.type === "json_object", "sem stream: o JSON e o uso", d6.paulus);
}

// ------------------------------------------------ a cota acaba
{
  const c = await corpoDe(await ia("GET", "/api/ia/conta", null, segredo));
  // Gasta quase tudo de uma vez, direto no medidor.
  const o = [...objetos.values()][0];
  const conta = o.dados.get("conta");
  conta.ciclo.usados = conta.ciclo.tokens - 200;
  o.dados.set("conta", conta);
  const r = await ia("POST", "/api/ia/v1/chat/completions", pergunta, segredo);
  const d = await corpoDe(r);
  checar(r.status === 402 && d.motivo === "cota" && d.conta.tokens.restantes === 200, "sem saldo para a pergunta: 402, com o que resta", d);
  checar(c.tokens.restantes > 200, "(antes havia mais)");
}

// ------------------------------------------------ recarga
{
  const r = await ia("POST", "/api/ia/recarga", {}, segredo);
  const d = await corpoDe(r);
  checar(mpPedidos.filter((p) => p.caminho === "/v1/orders").pop().corpo.payer.email === "dono@escritorio.com.br", "sem e-mail no pedido, vai o da conta Google");
  checar(r.status === 200 && d.qr_code === "000201pix" && d.tokens === 5000 && d.valor === "50.00", "a recarga é um Pix de R$ 50 com o QR", d);
  const pend = await corpoDe(await ia("GET", "/api/ia/recarga/" + d.id, null, segredo));
  checar(pend.pago === false, "antes de pagar, nada entra");
  mpOrders.get(d.id).status = "processed";
  // O aviso do Pix pago, pelo Worker inteiro.
  await worker.fetch(aviso(d.id, "order"), env, ctx);
  await Promise.all(pendentes.splice(0));
  const c = await corpoDe(await ia("GET", "/api/ia/conta", null, segredo));
  checar(c.tokens.da_recarga === 5000 && c.tokens.restantes === 5200 && c.recargas.length === 1, "o Pix pago põe os tokens da recarga", c.tokens);
  checar(soAdminSemPessoa() && [...guardados.keys()].includes("admin:nfse:" + d.id), "a recarga entra na fila de notas fiscais, sem dado pessoal", [...guardados.keys()]);
  // Conferir de novo (o PAULUS pergunta) não credita duas vezes.
  await ia("GET", "/api/ia/recarga/" + d.id, null, segredo);
  const c2 = await corpoDe(await ia("GET", "/api/ia/conta", null, segredo));
  checar(c2.tokens.da_recarga === 5000, "o mesmo Pix não credita duas vezes");
  // A antiga rota do Pix do apoio saiu.
  checar((await worker.fetch(new Request("https://paulus.ia.br/api/mp/pix/" + d.id), env, ctx)).status === 404, "a rota do Pix do apoio não existe mais");
  // Gasta do ciclo e depois da recarga.
  await (await ia("POST", "/api/ia/v1/chat/completions", pergunta, segredo)).text();
  await Promise.all(pendentes.splice(0));
  const c3 = await corpoDe(await ia("GET", "/api/ia/conta", null, segredo));
  checar(c3.tokens.do_ciclo === 0 && c3.tokens.da_recarga === 5000 - 1000, "gasta o ciclo primeiro, o resto da recarga", c3.tokens);
}

// ------------------------------------------------ renovação
{
  relogio += 31 * 24 * 3600 * 1000;
  await worker.fetch(aviso("cob-2", "subscription_authorized_payment"), env, ctx);
  await Promise.all(pendentes.splice(0));
  const c = await corpoDe(await ia("GET", "/api/ia/conta", null, segredo));
  checar(c.tokens.do_ciclo === 30000 && c.tokens.da_recarga === 4000, "a cobrança do mês seguinte abre o ciclo novo; a recarga continua", c.tokens);
  await worker.fetch(aviso("cob-2", "subscription_authorized_payment"), env, ctx);
  await Promise.all(pendentes.splice(0));
  const c2 = await corpoDe(await ia("GET", "/api/ia/conta", null, segredo));
  checar(c2.ciclo.inicio === c.ciclo.inicio, "o mesmo aviso repetido não abre outro ciclo");
}

// ------------------------------------------------ cancelar e vencer
{
  const r = await ia("POST", "/api/ia/assinatura/cancelar", null, segredo);
  const d = await corpoDe(r);
  checar(r.status === 200 && d.assinatura.situacao === "cancelled" && d.plano_vigente, "cancelar: o ciclo pago continua até o fim", d);
  relogio += 32 * 24 * 3600 * 1000;
  const c = await corpoDe(await ia("GET", "/api/ia/conta", null, segredo));
  checar(!c.plano_vigente && c.tokens.restantes === 0, "fim do ciclo sem assinatura: nada mais sai", c);
  const r2 = await ia("POST", "/api/ia/v1/chat/completions", pergunta, segredo);
  checar(r2.status === 402, "e o portão bloqueia");
  const r3 = await ia("POST", "/api/ia/recarga", { email: "dono@escritorio.com.br" }, segredo);
  checar(r3.status === 409, "recarga sem plano em dia é recusada");
}

// ------------------------------------------------ retirar o sim, sair, cortesia, por minuto
{
  await ia("POST", "/api/ia/consentimento", { aceito: false }, segredo);
  const c = await corpoDe(await ia("GET", "/api/ia/conta", null, segredo));
  checar(c.consentimento === null, "retirar o sim apaga o consentimento");
  const outro = await corpoDe(await ia("POST", "/api/ia/ativar", { id_token: "token-do-dono", instalacao_id: "inst-0002-abcd" }));
  checar(outro.conta.instalacoes === 2, "outra instalação da mesma conta ganha outro segredo");
  await ia("POST", "/api/ia/sair", null, outro.segredo);
  checar((await ia("GET", "/api/ia/conta", null, outro.segredo)).status === 401, "sair apaga o segredo desta instalação");
  checar((await ia("GET", "/api/ia/conta", null, segredo)).status === 200, "e o da outra continua");

  const { createHash } = await import("node:crypto");
  const envCortesia = { ...env, IA_CORTESIA: createHash("sha256").update("fundador@paulus.ia.br").digest("hex") };
  const req = new Request("https://paulus.ia.br/api/ia/ativar", { method: "POST", body: JSON.stringify({ id_token: "token-cortesia", instalacao_id: "inst-funda-0001" }) });
  const f = await (await atenderIA(req, envCortesia, new URL(req.url), ctx, deps)).json();
  checar(f.conta.cortesia && f.conta.plano_vigente && f.conta.tokens.restantes === 7000, "o e-mail da cortesia tem o plano sem pagar", f.conta);
  const fs = f.segredo;
  await atenderIA(new Request("https://paulus.ia.br/api/ia/consentimento", { method: "POST", headers: { authorization: "Bearer " + fs }, body: JSON.stringify({ aceito: true, versao: "v" }) }),
    envCortesia, new URL("https://paulus.ia.br/api/ia/consentimento"), ctx, deps);
  const envMinuto = { ...envCortesia, IA_POR_MINUTO: "2" };
  const status = [];
  for (let i = 0; i < 3; i++) {
    const q = new Request("https://paulus.ia.br/api/ia/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer " + fs }, body: JSON.stringify({ ...pergunta, max_tokens: 300 }) });
    const r = await atenderIA(q, envMinuto, new URL(q.url), ctx, deps);
    status.push(r.status);
    await r.text();
    await Promise.all(pendentes.splice(0));
  }
  checar(status.join() === "200,200,429", "o teto de pedidos por minuto para o terceiro", status);
}

// ------------------------------------------------ o uso no fim, partido
checar(usoDoFim('data: {"choices":[]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}\n\ndata: [DONE]').entrada === 7, "lê o uso da última linha");
checar(usoDoFim("data: {\"usa") === null, "linha partida não quebra");

// ------------------------------------------------ aviso que não é da nuvem
{
  mpOrders.set("ORDAPOIO1", { id: "ORDAPOIO1", status: "processed", external_reference: "apoio-pix-abc", total_amount: "40.00" });
  const antes = guardados.size;
  const r = await worker.fetch(aviso("ORDAPOIO1", "order"), env, ctx);
  await Promise.all(pendentes.splice(0));
  checar(r.status === 200 && guardados.size === antes, "o aviso de um Pix que não é da nuvem (o antigo apoio) é aceito e ignorado");
}

// ------------------------------------------------ os planos e o cadastro pelo site
{
  donos["token-novo"] = { sub: "555", email: "nova@advocacia.com.br" };
  const planos = await corpoDe(await ia("GET", "/api/ia/planos"));
  checar(planos.planos.map((p) => p.id).join() === "advogado,escritorio,plus" && planos.planos[1].tokens === 30000
    && planos.planos[2].recursos.word && !planos.planos[0].recursos.equipe && planos.planos[2].modelos_info[0].nome === "Claude Sonnet 5.5",
    "três planos (IA_PLANOS), com o que falta vindo do de fábrica: recursos e modelos", planos.planos);

  let r = await ia("POST", "/api/ia/site/entrar", { id_token: "vencido" });
  checar(r.status === 401, "sem o Google confirmado, o site não entra");
  const entrou = await corpoDe(await ia("POST", "/api/ia/site/entrar", { id_token: "token-novo" }));
  checar(entrou.ok && entrou.email === "nova@advocacia.com.br" && entrou.cadastro === null && !entrou.plano_vigente && entrou.instalacoes === 0,
    "entrar pelo site abre a conta, sem cadastro, sem plano e sem instalação", entrou);

  const base = { id_token: "token-novo", nome_escritorio: "Nova Advocacia", documento: "529.982.247-25", telefone: "(91) 98888-7777",
    oab: "OAB/PA 12.345", aceite: true,
    endereco: { cep: "66.010-000", logradouro: "  Av. Presidente\u0000 Vargas ", numero: "100", complemento: "", bairro: "Campina", cidade: "Belém", uf: "pa", cmun: "1501402" } };
  const erro = async (mudanca) => (await corpoDe(await ia("POST", "/api/ia/site/cadastro", { ...base, ...mudanca }))).erro || "";
  checar((await erro({ endereco: undefined })).includes("endereço"), "cadastro novo sem endereço é recusado");
  checar((await erro({ endereco: { ...base.endereco, cep: "6601" } })).includes("CEP"), "CEP sem 8 dígitos é recusado");
  checar((await erro({ endereco: { ...base.endereco, numero: " " } })).includes("número"), "endereço sem número é recusado");
  checar((await erro({ endereco: { ...base.endereco, bairro: "" } })).includes("bairro"), "endereço sem bairro é recusado");
  checar((await erro({ endereco: { ...base.endereco, uf: "XX" } })).includes("UF"), "UF inexistente é recusada");
  checar((await erro({ endereco: { ...base.endereco, cmun: "150140" } })).includes("IBGE"), "código IBGE com 6 dígitos é recusado");
  checar((await erro({ documento: "111.111.111-11" })).includes("CPF ou CNPJ"), "CPF com dígito errado é recusado");
  checar((await erro({ telefone: "98888-7777" })).includes("DDD"), "telefone sem DDD é recusado");
  checar((await erro({ oab: "abc" })).includes("RG"), "sem OAB, RG ou CNH é recusado");
  checar((await erro({ aceite: false })).includes("aceitar"), "sem aceitar os termos, não cadastra");
  checar((await erro({ plano: "ouro" })) === "esse plano não existe", "plano que não existe é recusado");

  const antes = mpPreapprovals.size;
  r = await ia("POST", "/api/ia/site/cadastro", { ...base, plano: "advogado" });
  const assinou = await corpoDe(r);
  checar(r.status === 200 && assinou.proximo.endsWith("?plano=advogado&periodo=mensal") && mpPreapprovals.size === antes,
    "o cadastro com o plano Advogado leva ao pagamento, sem criar nada antes do cartão", assinou);
  await ia("POST", "/api/ia/site/pagar", { id_token: "token-novo", plano: "advogado", periodo: "mensal", cartao: cartao("tokaprovado00000000003") });
  const pre = [...mpPreapprovals.values()].at(-1);
  const pedidoMP = mpPedidos.filter((x) => x.caminho === "/preapproval" && x.metodo === "POST").at(-1).corpo;
  checar(mpPreapprovals.size === antes + 1 && pre.auto_recurring.transaction_amount === 150 && pedidoMP.back_url === "https://paulus.ia.br/cadastro/"
    && pedidoMP.payer_email === "nova@advocacia.com.br", "pago no bloco: a assinatura de R$ 150; o recibo vai ao e-mail do Google", pedidoMP);

  const situacao = await corpoDe(await ia("POST", "/api/ia/site/situacao", { id_token: "token-novo" }));
  checar(situacao.plano_vigente && situacao.plano.id === "advogado" && situacao.ciclo.tokens === 12000000,
    "cartão aceito: o plano Advogado vale, com 12 milhões de tokens", { plano: situacao.plano, ciclo: situacao.ciclo });
  checar(situacao.cadastro && situacao.cadastro.documento === "52998224725" && situacao.cadastro.oab === "PA 12345" && situacao.nome === "Nova Advocacia",
    "o cadastro fica na conta, conferido e normalizado", situacao.cadastro);
  const end = situacao.cadastro.endereco || {};
  checar(end.cep === "66010000" && end.logradouro === "Av. Presidente Vargas" && end.uf === "PA" && end.cmun === "1501402" && end.cidade === "Belém" && end.complemento === "",
    "o endereço fica no cadastro, limpo (CEP só dígitos, UF maiúscula, código IBGE)", end);

  // A conta antiga, cadastrada antes do endereço, continua valendo sem ele.
  donos["token-antigo"] = { sub: "666", email: "antiga@advocacia.com.br" };
  await ia("POST", "/api/ia/site/entrar", { id_token: "token-antigo" });
  const contaSemEndereco = [...objetos.values()].find((x) => (x.dados.get("conta") || {}).dono?.sub === "666");
  const guardada = contaSemEndereco.dados.get("conta");
  guardada.cadastro = { nome_escritorio: "Antiga Advocacia", documento: "52998224725", telefone: "91988887777", oab: "PA 12345", termos: "2026-10-02" };
  contaSemEndereco.dados.set("conta", guardada);
  const antiga = await ia("POST", "/api/ia/site/cadastro", { ...base, id_token: "token-antigo", endereco: undefined, nome_escritorio: "Antiga Advocacia" });
  const antigaCorpo = await corpoDe(antiga);
  checar(antiga.status === 200 && antigaCorpo.cadastro && !antigaCorpo.cadastro.endereco, "conta antiga sem endereço: o cadastro continua aceito sem ele", antigaCorpo);
  const antigaRuim = await ia("POST", "/api/ia/site/cadastro", { ...base, id_token: "token-antigo", endereco: { ...base.endereco, cep: "1" } });
  checar(antigaRuim.status === 400, "mas, se mandar o endereço, ele é conferido");

  // Trocar de plano: o valor muda no Mercado Pago, os tokens na renovação.
  let troca = await ia("POST", "/api/ia/site/plano", { id_token: "token-novo", plano: "ouro" });
  checar(troca.status === 400, "trocar para plano que não existe é recusado");
  troca = await corpoDe(await ia("POST", "/api/ia/site/plano", { id_token: "token-novo", plano: "plus" }));
  checar(pre.auto_recurring.transaction_amount === 550 && troca.plano.id === "advogado" && troca.plano_proximo && troca.plano_proximo.id === "plus"
    && troca.ciclo.tokens === 12000000, "trocar para o Plus: o Mercado Pago cobra R$ 550, e o ciclo pago continua no Advogado",
    { valor: pre.auto_recurring.transaction_amount, plano: troca.plano, proximo: troca.plano_proximo });
  const desfeita = await corpoDe(await ia("POST", "/api/ia/site/plano", { id_token: "token-novo", plano: "advogado" }));
  checar(desfeita.plano_proximo === null && pre.auto_recurring.transaction_amount === 150, "pedir o plano de agora desfaz a troca");
  await ia("POST", "/api/ia/site/plano", { id_token: "token-novo", plano: "plus" });
  const contaNova = [...objetos.values()].find((x) => (x.dados.get("conta") || {}).dono?.sub === "555");
  relogio += 31 * 24 * 3600 * 1000;
  const renovada = contaNova.o.fazer("renovar", contaNova.dados.get("conta"), { cobranca: "cob-plus-1", quando: new Date(relogio).toISOString() }, (await import("./ia.js")).numeros(env))[0];
  checar(renovada.plano.id === "plus" && renovada.ciclo.tokens === 60000000 && renovada.plano_proximo === null,
    "na renovação, o Plus entra com 60 milhões de tokens", { plano: renovada.plano, ciclo: renovada.ciclo });
  relogio -= 31 * 24 * 3600 * 1000;

  // Depois, o PAULUS instalado entra com a mesma conta Google e já encontra o plano.
  const ativou = await corpoDe(await ia("POST", "/api/ia/ativar", { id_token: "token-novo", instalacao_id: "inst-nova-0001" }));
  const pacote = await corpoDe(await ia("POST", "/api/ia/recarga", { pacote: "2" }, ativou.segredo));
  checar(pacote.valor === "100.00" && pacote.tokens === 10000, "a recarga do dobro: R$ 100 pelo dobro de tokens", pacote);
  mpOrders.get(pacote.id).status = "processed";
  mpOrders.get(pacote.id).total_amount = "100.00";
  const creditada = await corpoDe(await ia("GET", "/api/ia/recarga/" + pacote.id, null, ativou.segredo));
  checar(creditada.pago && creditada.conta.recargas[0].tokens === 10000, "paga, entram os tokens do pacote", creditada.conta && creditada.conta.recargas);
  checar((await ia("POST", "/api/ia/recarga", { pacote: "7" }, ativou.segredo)).status === 400, "pacote que não existe é recusado");
  checar(ativou.conta.plano_vigente && ativou.conta.plano.id === "plus" && ativou.conta.instalacoes === 1,
    "o PAULUS instalado entra com a mesma conta e já tem o plano", ativou.conta);

  // Quem assinava antes dos três planos fica no Escritório.
  const { numeros } = await import("./ia.js");
  const medidorAntigo = objeto("conta-de-antes-dos-planos").o;
  const contaAntiga = { id: "x", segredos: [], extra: 0, reservas: {}, recargas: [], cobrancas: [], uso: [],
    assinatura: { id: "pre-velha", situacao: "authorized", valor: 300 } };
  medidorAntigo.abrirCiclo(contaAntiga, numeros(env), relogio, "assinatura");
  const resumoAntigo = medidorAntigo.resumo(contaAntiga, numeros(env), relogio);
  checar(resumoAntigo.plano.id === "escritorio" && contaAntiga.ciclo.tokens === 30000 && resumoAntigo.plano_vigente,
    "quem assinava antes dos três planos fica no Escritório, com os mesmos tokens", resumoAntigo.plano);
}


// ------------------------------------------------ os planos de 03/10: modelos, profundidade, semana e anual
{
  const { createHash } = await import("node:crypto");
  const hash = (e) => createHash("sha256").update(e).digest("hex");
  // Os planos de fabrica (sem IA_PLANOS), com as chaves dos tres provedores.
  const envReal = { ...env, IA_PLANOS: undefined, MISTRAL_KEY: "chave-mistral", ANTHROPIC_KEY: "chave-anthropic",
    IA_CORTESIA: ["plus@a.br", "adv@a.br", "esc@a.br"].map(hash).join(",") };
  const pedir = async (e, metodo, caminho, corpo, seg) => {
    const headers = { "content-type": "application/json" };
    if (seg) headers.authorization = "Bearer " + seg;
    const req = new Request("https://paulus.ia.br" + caminho, { method: metodo, headers, body: corpo ? JSON.stringify(corpo) : undefined });
    return atenderIA(req, e, new URL(req.url), ctx, deps);
  };
  const objetoDe = (sub) => [...objetos.values()].find((x) => (x.dados.get("conta") || {}).dono?.sub === sub);
  // Uma conta de cortesia no plano pedido, com o sim dado.
  const contaNoPlano = async (sub, email, plano, e = envReal) => {
    donos["tk-" + sub] = { sub, email };
    const a = await corpoDe(await pedir(e, "POST", "/api/ia/ativar", { id_token: "tk-" + sub, instalacao_id: "inst-" + sub + "-0001" }));
    const o = objetoDe(sub);
    const c = o.dados.get("conta");
    c.plano = plano;
    delete c.ciclo;
    o.dados.set("conta", c);
    await pedir(e, "POST", "/api/ia/consentimento", { aceito: true, versao: "v" }, a.segredo);
    return a.segredo;
  };

  // O Plus fala com o Claude: o Sonnet no dia a dia, o Opus no Ministro.
  const sp = await contaNoPlano("801", "plus@a.br", "plus");
  const conta = await corpoDe(await pedir(envReal, "GET", "/api/ia/conta", null, sp));
  checar(conta.plano.id === "plus" && conta.tokens.do_mes === 40000000 && conta.semana.cota === Math.round(40000000 * 7 / 30)
    && conta.modelos.map((x) => x.nome).join() === "Claude Sonnet 5.5,Claude Opus 5.5",
    "a conta do Plus: 40 milhões de créditos no mês, a semana em 7/30, os modelos do Claude", { semana: conta.semana, modelos: conta.modelos });
  let r = await pedir(envReal, "POST", "/api/ia/v1/chat/completions", { ...pergunta, messages: [...pergunta.messages, { role: "assistant", content: "começo" }] }, sp);
  const texto = await r.text();
  await Promise.all(pendentes.splice(0));
  const pc = claude.at(-1);
  checar(r.status === 200 && r.headers.get("x-paulus-modelo") === "claude-sonnet-5-5" && pc.corpo.model === "claude-sonnet-5-5",
    "o PAULUS pede o Llama, mas o Plus responde com o Claude Sonnet 5.5", { status: r.status, modelo: pc && pc.corpo.model });
  checar(pc.headers["x-api-key"] === "chave-anthropic" && pc.headers["anthropic-beta"] === "server-side-fallback-2026-07-01" && pc.corpo.fallbacks === "default"
    && pc.corpo.thinking.type === "between_tools" && pc.corpo.system === "Você é o PAULUS." && pc.corpo.messages.length === 1 && pc.corpo.messages[0].role === "user"
    && pc.corpo.temperature === undefined, "o pedido ao Claude: chave do Worker, fallback, sem pensar, system à parte, termina no usuário", pc.corpo);
  checar(texto.includes('"content":"Prazo de "') && texto.includes('"content":"15 dias."') && texto.includes('"prompt_tokens":1000') && texto.includes('"completion_tokens":50')
    && texto.trim().endsWith("data: [DONE]"), "os eventos do Claude viram os pedaços do OpenAI, com o uso no fim", texto);
  let depois = await corpoDe(await pedir(envReal, "GET", "/api/ia/conta", null, sp));
  checar(depois.semana.usados === 1050 && depois.tokens.hoje === 1050, "o Sonnet gasta um crédito por token", depois.semana);
  r = await pedir(envReal, "POST", "/api/ia/v1/chat/completions", { ...pergunta, paulus_nivel: "ministro", max_tokens: 1000 }, sp);
  await r.text();
  await Promise.all(pendentes.splice(0));
  checar(claude.at(-1).corpo.model === "claude-opus-5-5" && claude.at(-1).corpo.output_config.effort === "high" && claude.at(-1).corpo.max_tokens === 5000
    && !claude.at(-1).corpo.thinking, "no Ministro, o Opus 5.5 com esforço alto e folga para pensar", claude.at(-1).corpo);
  depois = await corpoDe(await pedir(envReal, "GET", "/api/ia/conta", null, sp));
  checar(depois.semana.usados === 1050 + 2 * 1050, "o Opus gasta dois créditos por token", depois.semana);
  // Nos 7 primeiros dias da assinatura paga, o Plus responde só com o Sonnet; no 8º dia, o Opus.
  const spPago = await contaNoPlano("8011", "pluspago@a.br", "plus");
  const oPago = objetoDe("8011");
  const cPago = oPago.dados.get("conta");
  cPago.cortesia = false;
  cPago.assinatura = { id: "preplus", situacao: "authorized", valor: 3490, desde: new Date(relogio).toISOString() };
  cPago.ciclo = { inicio: new Date(relogio).toISOString(), fim: new Date(relogio + 30 * 864e5).toISOString(), tokens: 40000000, usados: 0, origem: "assinatura",
    semana: Math.round(40000000 * 7 / 30), por_semana: {} };
  oPago.dados.set("conta", cPago);
  r = await pedir(envReal, "POST", "/api/ia/v1/chat/completions", { ...pergunta, paulus_nivel: "ministro", max_tokens: 1000 }, spPago);
  await r.text();
  await Promise.all(pendentes.splice(0));
  checar(r.status === 200 && claude.at(-1).corpo.model === "claude-sonnet-5-5" && r.headers.get("x-paulus-modelo") === "claude-sonnet-5-5"
    && /Opus 5.5 libera no 8º dia/.test(decodeURIComponent(r.headers.get("x-paulus-aviso") || "")), "primeira semana do Plus: o Ministro responde com o Sonnet, e o aviso diz quando o Opus libera",
    { modelo: claude.at(-1).corpo.model, aviso: decodeURIComponent(r.headers.get("x-paulus-aviso") || "") });
  relogio += 8 * 864e5;
  r = await pedir(envReal, "POST", "/api/ia/v1/chat/completions", { ...pergunta, paulus_nivel: "ministro", max_tokens: 1000 }, spPago);
  await r.text();
  await Promise.all(pendentes.splice(0));
  checar(claude.at(-1).corpo.model === "claude-opus-5-5" && !r.headers.get("x-paulus-aviso"), "no 8º dia, o Opus", claude.at(-1).corpo.model);
  relogio -= 8 * 864e5;
  r = await pedir(envReal, "POST", "/api/ia/v1/chat/completions", { ...pergunta, stream: false, response_format: { type: "json_object" } }, sp);
  const dj = await corpoDe(r);
  checar(r.status === 200 && dj.choices[0].message.content === '{"ok":true}' && dj.paulus.tokens === 120 && dj.paulus.modelo === "claude-sonnet-5-5"
    && claude.at(-1).corpo.system.includes("JSON"), "sem stream: o JSON do Claude no formato OpenAI", dj);
  respostaDoClaude = "recusa";
  r = await pedir(envReal, "POST", "/api/ia/v1/chat/completions", { ...pergunta, stream: false }, sp);
  checar(r.status === 400 && (await corpoDe(r)).erro.includes("recusou"), "o Claude recusou (depois do fallback): erro, e nada é cobrado");
  const rs = await pedir(envReal, "POST", "/api/ia/v1/chat/completions", pergunta, sp);
  const ts = await rs.text();
  await Promise.all(pendentes.splice(0));
  checar(ts.includes("interrompeu esta resposta"), "recusa no meio do stream: a resposta diz que foi interrompida", ts);
  respostaDoClaude = "padrao";
  checar((await pedir({ ...envReal, ANTHROPIC_KEY: undefined }, "POST", "/api/ia/v1/chat/completions", pergunta, sp)).status === 503,
    "sem a chave do Anthropic no Worker: 503");

  // O Advogado: o Llama, e a profundidade só até Advogado.
  const sa = await contaNoPlano("802", "adv@a.br", "advogado");
  r = await pedir(envReal, "POST", "/api/ia/v1/chat/completions", { ...pergunta, paulus_nivel: "juiz" }, sa);
  const dn = await corpoDe(r);
  checar(r.status === 403 && dn.motivo === "profundidade" && dn.erro.includes("Escritório"), "o nível Juiz não é do Advogado: 403, dizendo o plano que tem", dn);
  r = await pedir(envReal, "POST", "/api/ia/v1/chat/completions", { ...pergunta, model: "claude-opus-5-5", paulus_nivel: "advogado" }, sa);
  await r.text();
  await Promise.all(pendentes.splice(0));
  checar(r.headers.get("x-paulus-modelo") === "meta-llama/Llama-3.3-70B-Instruct" && deepinfra.at(-1).corpo.model === "meta-llama/Llama-3.3-70B-Instruct",
    "pedir um modelo de outro plano não adianta: vai o do plano");
  const modelosAdv = await corpoDe(await pedir(envReal, "GET", "/api/ia/modelos", null, sa));
  checar(modelosAdv.modelos.join() === "meta-llama/Llama-3.3-70B-Instruct", "os modelos da conta são os do plano", modelosAdv);

  // O Escritório: a Mistral, no formato OpenAI dela.
  const se = await contaNoPlano("803", "esc@a.br", "escritorio");
  r = await pedir(envReal, "POST", "/api/ia/v1/chat/completions", { ...pergunta, temperature: 0.2 }, se);
  const tm = await r.text();
  await Promise.all(pendentes.splice(0));
  const pm = mistral.at(-1);
  checar(r.status === 200 && pm.auth === "Bearer chave-mistral" && pm.corpo.model === "mistral-large-latest" && !pm.corpo.stream_options && pm.corpo.temperature === 0.2
    && tm.includes("Mistral "), "o Escritório responde com o Mistral Large 3, sem stream_options", pm.corpo);
  const ce = await corpoDe(await pedir(envReal, "GET", "/api/ia/conta", null, se));
  checar(ce.semana.usados === 600, "o uso da Mistral sai do fim do stream", ce.semana);

  // A semana: acabou a cota da semana, com o mês ainda cheio.
  const oe = objetoDe("803");
  let c = oe.dados.get("conta");
  c.ciclo.por_semana = { 0: c.ciclo.semana - 100 };
  c.ciclo.usados = c.ciclo.semana - 100;
  oe.dados.set("conta", c);
  r = await pedir(envReal, "POST", "/api/ia/v1/chat/completions", pergunta, se);
  const dsem = await corpoDe(r);
  checar(r.status === 402 && dsem.motivo === "semana" && dsem.erro.includes("volta em"), "a cota da semana acabou: 402, dizendo quando volta", dsem);
  r = await pedir(envReal, "POST", "/api/ia/adiantar", null, se);
  const dad = await corpoDe(r);
  checar(r.status === 409 && dad.erro.includes("7 primeiros dias"), "nos 7 primeiros dias, não adianta a semana", dad);
  // No 9º dia (semana 2): adianta uma vez, a semana dobra e a seguinte fica vazia.
  relogio += 8 * 24 * 3600 * 1000;
  c = oe.dados.get("conta");
  c.ciclo.por_semana[1] = c.ciclo.semana;
  c.ciclo.usados += c.ciclo.semana;
  oe.dados.set("conta", c);
  let cs = await corpoDe(await pedir(envReal, "GET", "/api/ia/conta", null, se));
  checar(cs.semana.numero === 2 && cs.semana.livres === 0 && cs.semana.adiantamento.pode, "na semana 2, sem cota, o adiantamento está liberado", cs.semana);
  r = await pedir(envReal, "POST", "/api/ia/adiantar", null, se);
  cs = await corpoDe(r);
  checar(r.status === 200 && cs.semana.limite === 2 * cs.semana.cota && cs.semana.livres === cs.semana.cota && cs.semana.adiantamento.usado,
    "adiantar: a semana ganha a cota da seguinte", cs.semana);
  r = await pedir(envReal, "POST", "/api/ia/v1/chat/completions", pergunta, se);
  await r.text();
  await Promise.all(pendentes.splice(0));
  checar(r.status === 200, "e a pergunta volta a sair");
  checar((await pedir(envReal, "POST", "/api/ia/adiantar", null, se)).status === 409, "o segundo adiantamento do mês é recusado");
  relogio += 7 * 24 * 3600 * 1000;
  cs = await corpoDe(await pedir(envReal, "GET", "/api/ia/conta", null, se));
  checar(cs.semana.numero === 3 && cs.semana.limite === 0 && cs.tokens.restantes === 0, "a semana seguinte, já adiantada, fica vazia", cs.semana);
  relogio -= 15 * 24 * 3600 * 1000;

  // A recarga do plano: o pacote e o preço são os do plano, e a referência leva o plano.
  const rec = await corpoDe(await pedir(envReal, "POST", "/api/ia/recarga", {}, se));
  const refRec = mpPedidos.filter((x) => x.caminho === "/v1/orders").at(-1).corpo.external_reference;
  checar(rec.valor === "120.00" && rec.tokens === 10000000 && refRec.endsWith("-escritorio"), "a recarga do Escritório: 10 milhões por R$ 120", { rec, refRec });

  // O anual: paga o ano no bloco de cartão (em até 12 parcelas), o plano vale 12 meses e cada mês abre o seu ciclo.
  donos["tk-804"] = { sub: "804", email: "anual@a.br" };
  const an = await corpoDe(await pedir(envReal, "POST", "/api/ia/ativar", { id_token: "tk-804", instalacao_id: "inst-804-0001" }));
  await pedir(envReal, "POST", "/api/ia/site/cadastro", { ...CADASTRO, id_token: "tk-804" });
  const pagarAno = (tk, plano, corpo = {}) => pedir(envReal, "POST", "/api/ia/site/pagar", { id_token: tk, plano, periodo: "anual", ...corpo });
  checar((await pagarAno("tk-804", "advogado", { periodo: "trimestral", cartao: cartao() })).status === 400, "período que não existe é recusado");
  checar((await pagarAno("tk-804", "advogado", { cartao: cartao(undefined, { installments: 13 }) })).status === 400, "o anual vai em até 12 parcelas");
  r = await pagarAno("tk-804", "advogado", { idempotencia: "chave-anual-0000000001", cartao: cartao("tokaprovado00000000004", { installments: 12, transaction_amount: 1 }) });
  const pa = await corpoDe(r);
  const pg = mpPedidos.filter((x) => x.caminho === "/v1/payments" && x.metodo === "POST").at(-1);
  checar(r.status === 200 && pa.situacao === "approved" && pg.corpo.transaction_amount === 3990 && pg.corpo.installments === 12 && pg.corpo.payment_method_id === "master"
    && pg.corpo.issuer_id === 24 && pg.headers["X-Idempotency-Key"] === "chave-anual-0000000001" && pg.corpo.payer.email === "anual@a.br"
    && pg.corpo.payer.identification.number === "52998224725" && /^ia-anual-[0-9a-f]{24}-advogado-[0-9a-f]+$/.test(pg.corpo.external_reference),
    "o anual do Advogado: R$ 3.990 (do servidor) em 12 parcelas, com a chave de idempotência da página", pg);
  let sa2 = pa.conta;
  checar(sa2.plano_vigente && sa2.periodo === "anual" && sa2.plano.id === "advogado" && sa2.assinatura.periodo === "anual"
    && Date.parse(sa2.pago_ate) - relogio > 364 * 24 * 3600 * 1000 && sa2.ciclo.tokens === 30000000,
    "aprovado: o ano vale na hora, com o ciclo do mês aberto", { periodo: sa2.periodo, pago_ate: sa2.pago_ate, ciclo: sa2.ciclo });
  checar(!mpPedidos.some((x) => x.caminho === "/checkout/preferences"), "nenhum redirecionamento ao Checkout Pro");
  // O aviso depois não credita de novo.
  await worker.fetch(aviso(pa.pagamento, "payment"), envReal, ctx);
  await Promise.all(pendentes.splice(0));
  const pagos = [...objetos.values()].find((x) => (x.dados.get("conta") || {}).dono?.sub === "804").dados.get("conta").pagamentos;
  checar(pagos.length === 1 && [...guardados.keys()].includes("admin:nfse:" + pa.pagamento), "o aviso repetido não paga duas vezes; a nota fiscal entra na fila", pagos);
  checar((await pagarAno("tk-804", "advogado", { cartao: cartao("tokaprovado00000000005") })).status === 409, "ano pago: só renova nos últimos 45 dias");
  checar((await pedir(envReal, "POST", "/api/ia/assinatura/cancelar", null, an.segredo)).status === 409, "o anual não tem o que cancelar: não renova sozinho");
  checar((await pedir(envReal, "POST", "/api/ia/plano", { plano: "plus" }, an.segredo)).status === 409, "no anual, a troca de plano é na renovação");
  relogio += 40 * 24 * 3600 * 1000;
  sa2 = await corpoDe(await pedir(envReal, "GET", "/api/ia/conta", null, an.segredo));
  checar(sa2.plano_vigente && sa2.ciclo.origem === "anual" && sa2.ciclo.usados === 0 && Date.parse(sa2.ciclo.inicio) <= relogio && Date.parse(sa2.ciclo.fim) > relogio,
    "um mês depois, o ano pago abre o ciclo novo sozinho", sa2.ciclo);
  relogio += 330 * 24 * 3600 * 1000;
  sa2 = await corpoDe(await pedir(envReal, "GET", "/api/ia/conta", null, an.segredo));
  checar(!sa2.plano_vigente && sa2.assinatura.situacao === "expired", "depois do ano, sem renovar, o plano acaba", sa2.assinatura);
  relogio -= 370 * 24 * 3600 * 1000;

  // Recusado e em análise.
  donos["tk-806"] = { sub: "806", email: "recusa@a.br" };
  const rc = await corpoDe(await pedir(envReal, "POST", "/api/ia/ativar", { id_token: "tk-806", instalacao_id: "inst-806-0001" }));
  await pedir(envReal, "POST", "/api/ia/site/cadastro", { ...CADASTRO, id_token: "tk-806" });
  r = await pagarAno("tk-806", "escritorio", { cartao: cartao("tokrecusa000000000002", { installments: 3 }) });
  const dr = await corpoDe(r);
  checar(r.status === 402 && dr.erro === "o cartão não tem limite suficiente para este valor", "recusado: 402, com o motivo em português", dr);
  r = await pagarAno("tk-806", "escritorio", { cartao: cartao("tokanalise000000000001", { installments: 3 }) });
  const dan = await corpoDe(r);
  let crc = await corpoDe(await pedir(envReal, "GET", "/api/ia/conta", null, rc.segredo));
  checar(r.status === 200 && dan.situacao === "in_process" && !crc.plano_vigente && crc.anual_pendente, "em análise: o plano espera a aprovação", dan);
  mpPagamentos.get(dan.pagamento).status = "approved";
  await worker.fetch(aviso(dan.pagamento, "payment"), envReal, ctx);
  await Promise.all(pendentes.splice(0));
  crc = await corpoDe(await pedir(envReal, "GET", "/api/ia/conta", null, rc.segredo));
  checar(crc.plano_vigente && crc.periodo === "anual" && crc.plano.id === "escritorio" && !crc.anual_pendente, "aprovado depois, pelo aviso: o ano entra", crc.plano);

  // Do mensal para o anual: a assinatura mensal sai do Mercado Pago.
  donos["tk-805"] = { sub: "805", email: "troca@a.br" };
  const tr = await corpoDe(await pedir(envReal, "POST", "/api/ia/ativar", { id_token: "tk-805", instalacao_id: "inst-805-0001" }));
  await pedir(envReal, "POST", "/api/ia/site/cadastro", { ...CADASTRO, id_token: "tk-805" });
  await pedir(envReal, "POST", "/api/ia/site/pagar", { id_token: "tk-805", plano: "escritorio", periodo: "mensal", cartao: cartao("tokaprovado00000000006") });
  const mensalId = [...mpPreapprovals.keys()].at(-1);
  checar(mpPreapprovals.get(mensalId).auto_recurring.transaction_amount === 1290 && mpPreapprovals.get(mensalId).status === "authorized", "o mensal do Escritório é de R$ 1.290");
  const pt = await corpoDe(await pagarAno("tk-805", "plus", { cartao: cartao("tokaprovado00000000007", { installments: 6 }) }));
  let ct = await corpoDe(await pedir(envReal, "GET", "/api/ia/conta", null, tr.segredo));
  checar(mpPreapprovals.get(mensalId).status === "cancelled" && ct.plano.id === "plus" && ct.periodo === "anual" && ct.ciclo.tokens === 40000000,
    "passou ao anual do Plus: o mensal é cancelado no Mercado Pago e o ciclo novo é do Plus", { mp: mpPreapprovals.get(mensalId).status, plano: ct.plano.id });
  // O aviso do mensal cancelado, que chega depois, não mexe no anual.
  await worker.fetch(aviso(mensalId, "subscription_preapproval"), envReal, ctx);
  await Promise.all(pendentes.splice(0));
  ct = await corpoDe(await pedir(envReal, "GET", "/api/ia/conta", null, tr.segredo));
  checar(ct.assinatura.situacao === "authorized" && ct.assinatura.periodo === "anual", "o aviso do mensal cancelado não derruba o anual", ct.assinatura);
  // O reembolso dos 7 dias (estorno no Mercado Pago): o plano acaba na hora.
  mpPagamentos.get(pt.pagamento).status = "refunded";
  await worker.fetch(aviso(pt.pagamento, "payment"), envReal, ctx);
  await Promise.all(pendentes.splice(0));
  ct = await corpoDe(await pedir(envReal, "GET", "/api/ia/conta", null, tr.segredo));
  checar(!ct.plano_vigente && ct.assinatura.situacao === "refunded", "estornado, o plano anual acaba", ct.assinatura);

  // A chave pública e a CSP da página de pagamento.
  const cfg = await pedir({ ...envReal, MP_PUBLIC_KEY: "TEST-chave-publica" }, "GET", "/api/ia/mp-config");
  checar(cfg.status === 200 && (await corpoDe(cfg)).publicKey === "TEST-chave-publica" && cfg.headers.get("cache-control").includes("no-store"),
    "a chave pública sai do Worker, sem cache");
  checar((await pedir(envReal, "GET", "/api/ia/mp-config")).status === 503, "sem a chave pública: 503");
  const html = { fetch: async () => new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }) };
  const pagina = await worker.fetch(new Request("https://paulus.ia.br/cadastro/pagamento/"), { ...envReal, ASSETS: html }, ctx);
  const csp = pagina.headers.get("content-security-policy") || "";
  checar(/script-src 'self' https:\/\/sdk\.mercadopago\.com/.test(csp) && !/'sha256-/.test(csp) && !/script-src[^;]*'unsafe-inline'/.test(csp)
    && csp.includes("frame-ancestors 'none'") && csp.includes("object-src 'none'"), "a página de pagamento sai com a CSP: só scripts do site, do Mercado Pago e do Google", csp);
  const inicio = await worker.fetch(new Request("https://paulus.ia.br/"), { ...envReal, ASSETS: html }, ctx);
  checar(!inicio.headers.get("content-security-policy"), "as outras páginas não mudam");

  // O plano B: o formulario nao carregou e a pessoa paga na pagina do Mercado Pago.
  donos["tk-807"] = { sub: "807", email: "fora@a.br" };
  const fo = await corpoDe(await pedir(envReal, "POST", "/api/ia/ativar", { id_token: "tk-807", instalacao_id: "inst-807-0001" }));
  const fora = (corpo) => pedir(envReal, "POST", "/api/ia/site/pagar-fora", { id_token: "tk-807", plano: "advogado", periodo: "mensal", ...corpo });
  checar((await fora({})).status === 409, "plano B sem os dados do escritório: não abre");
  await pedir(envReal, "POST", "/api/ia/site/cadastro", { ...CADASTRO, id_token: "tk-807" });
  let fr = await corpoDe(await fora({ valor: 1 }));
  const preFora = mpPedidos.filter((x) => x.caminho === "/preapproval" && x.metodo === "POST").at(-1).corpo;
  checar(fr.link.startsWith("https://www.mercadopago.com.br/") && preFora.status === "pending" && !preFora.card_token_id && preFora.auto_recurring.transaction_amount === 449
    && preFora.back_url === "https://paulus.ia.br/cadastro/?voltou=1", "plano B mensal: a assinatura pendente de R$ 449 na página do Mercado Pago", preFora);
  let cf = await corpoDe(await pedir(envReal, "GET", "/api/ia/conta", null, fo.segredo));
  checar(!cf.plano_vigente && cf.assinatura.situacao === "pending", "e o plano espera o cartão entrar lá", cf.assinatura);
  fr = await corpoDe(await fora({ periodo: "anual" }));
  const prefFora = mpPedidos.filter((x) => x.caminho === "/checkout/preferences").at(-1).corpo;
  checar(fr.link.includes("pref_id=") && prefFora.items[0].unit_price === 3990 && prefFora.payment_methods.installments === 12
    && /^ia-anual-[0-9a-f]{24}-advogado-/.test(prefFora.external_reference), "plano B anual: R$ 3.990 no Checkout Pro, em até 12 vezes", prefFora);
  mpPagamentos.set("9907", { id: 9907, status: "approved", external_reference: prefFora.external_reference, transaction_amount: 3990 });
  const volta = await corpoDe(await pedir(envReal, "POST", "/api/ia/site/situacao", { id_token: "tk-807" }));
  checar(volta.plano_vigente && volta.periodo === "anual", "na volta, a consulta acha o pagamento do ano e o plano entra", volta.periodo);

  // O cupom saiu do sistema: a rota não existe e um "cupom" mandado no pagamento é ignorado (o valor é o do plano).
  checar((await pedir(envReal, "GET", "/api/ia/cupom?codigo=ANO10&plano=escritorio&periodo=anual")).status === 401, "a rota do cupom não existe mais (cai na autenticação)");

  // O Pix: o mês avulso (vale até vencer, não renova) e o ano à vista.
  donos["tk-808"] = { sub: "808", email: "pix@a.br" };
  const px = await corpoDe(await pedir(envReal, "POST", "/api/ia/ativar", { id_token: "tk-808", instalacao_id: "inst-808-0001" }));
  await pedir(envReal, "POST", "/api/ia/site/cadastro", { ...CADASTRO, id_token: "tk-808" });
  const pix = (corpo) => pedir(envReal, "POST", "/api/ia/site/pagar", { id_token: "tk-808", plano: "advogado", periodo: "mensal", meio: "pix", ...corpo });
  const of = await corpoDe(await pedir(envReal, "POST", "/api/ia/site/oferta", { id_token: "tk-808", plano: "advogado", periodo: "mensal" }));
  checar(of.meios && of.meios.cartao === "" && of.meios.pix === "" && of.valor === 449, "a oferta diz que cartão e Pix podem", of.meios);
  r = await pix({ valor: 1, cupom: "PILOTO30" });
  const qr = await corpoDe(r);
  const pgPix = mpPedidos.filter((x) => x.caminho === "/v1/payments" && x.metodo === "POST").at(-1);
  checar(r.status === 200 && qr.qr_code.startsWith("00020126pix") && qr.qr_code_base64 && pgPix.corpo.payment_method_id === "pix" && pgPix.corpo.transaction_amount === 449
    && /^ia-mes-[0-9a-f]{24}-advogado-[0-9a-f]+$/.test(pgPix.corpo.external_reference) && /-03:00$/.test(pgPix.corpo.date_of_expiration)
    && !pgPix.corpo.token && !pgPix.corpo.installments && pgPix.corpo.payer.identification.number === "52998224725",
    "o Pix do mês: R$ 449 (do servidor), QR que vence no horário de Brasília, sem cartão", { qr, corpo: pgPix.corpo });
  let spx = await corpoDe(await pedir(envReal, "POST", "/api/ia/site/pix", { id_token: "tk-808", pagamento: qr.pagamento }));
  checar(!spx.pago && spx.situacao === "pending" && !spx.conta.plano_vigente, "antes de pagar, o plano espera", spx.situacao);
  checar((await pedir(envReal, "POST", "/api/ia/site/pix", { id_token: "tk-807", pagamento: qr.pagamento })).status === 403, "o Pix de outra conta não se consulta");
  mpPagamentos.get(qr.pagamento).status = "approved";
  mpPagamentos.get(qr.pagamento).date_approved = new Date(relogio).toISOString();
  spx = await corpoDe(await pedir(envReal, "POST", "/api/ia/site/pix", { id_token: "tk-808", pagamento: qr.pagamento }));
  const um = spx.conta;
  const mes = Date.parse(um.pago_ate) - relogio;
  checar(spx.pago && um.plano_vigente && um.periodo === "avulso" && um.assinatura.periodo === "avulso" && mes > 27 * 864e5 && mes < 32 * 864e5
    && um.ciclo.tokens === 30000000 && um.ciclo.fim === um.pago_ate, "pago: o mês avulso vale na hora, até o fim do mês", { periodo: um.periodo, pago_ate: um.pago_ate });
  await worker.fetch(aviso(qr.pagamento, "payment"), envReal, ctx);
  await Promise.all(pendentes.splice(0));
  const pagosPix = [...objetos.values()].find((x) => (x.dados.get("conta") || {}).dono?.sub === "808").dados.get("conta").pagamentos;
  checar(pagosPix.length === 1 && pagosPix[0].tipo === "avulso" && JSON.parse(guardados.get("admin:nfse:" + qr.pagamento)).tipo === "mês avulso",
    "o aviso depois não paga duas vezes; a nota entra na fila como mês avulso", pagosPix);
  checar((await pedir(envReal, "POST", "/api/ia/site/pagar", { id_token: "tk-808", plano: "advogado", periodo: "mensal", cartao: cartao("tokaprovado00000000008") })).status === 409,
    "com o mês pago no Pix, a assinatura no cartão espera ele vencer");
  checar((await pedir(envReal, "POST", "/api/ia/assinatura/cancelar", null, px.segredo)).status === 409, "o mês avulso não tem o que cancelar");
  // O mês seguinte pago antes: começa no fim do pago.
  r = await pix({});
  const qr2 = await corpoDe(r);
  mpPagamentos.get(qr2.pagamento).status = "approved";
  const dois = (await corpoDe(await pedir(envReal, "POST", "/api/ia/site/pix", { id_token: "tk-808", pagamento: qr2.pagamento }))).conta;
  checar(Date.parse(dois.pago_ate) - Date.parse(um.pago_ate) > 27 * 864e5 && dois.ciclo.inicio === um.ciclo.inicio, "o segundo mês pago antes soma ao fim do primeiro; o ciclo de agora continua", dois.pago_ate);
  relogio += 40 * 864e5;
  let cpx = await corpoDe(await pedir(envReal, "GET", "/api/ia/conta", null, px.segredo));
  checar(cpx.plano_vigente && cpx.ciclo.origem === "avulso" && Date.parse(cpx.ciclo.inicio) <= relogio, "no segundo mês, o ciclo dele abre sozinho", cpx.ciclo);
  relogio += 30 * 864e5;
  cpx = await corpoDe(await pedir(envReal, "GET", "/api/ia/conta", null, px.segredo));
  checar(!cpx.plano_vigente && cpx.assinatura.situacao === "expired", "venceu sem pagar de novo: o plano acaba, sem cobrar nada", cpx.assinatura);
  // Depois de vencer, o ano à vista no Pix.
  r = await pix({ periodo: "anual" });
  const qr3 = await corpoDe(r);
  const pgAno = mpPedidos.filter((x) => x.caminho === "/v1/payments" && x.metodo === "POST").at(-1).corpo;
  checar(pgAno.transaction_amount === 3990 && /^ia-anual-/.test(pgAno.external_reference), "o ano no Pix: R$ 3.990 à vista", pgAno);
  mpPagamentos.get(qr3.pagamento).status = "approved";
  await worker.fetch(aviso(qr3.pagamento, "payment"), envReal, ctx);
  await Promise.all(pendentes.splice(0));
  cpx = await corpoDe(await pedir(envReal, "GET", "/api/ia/conta", null, px.segredo));
  checar(cpx.plano_vigente && cpx.periodo === "anual" && Date.parse(cpx.pago_ate) - relogio > 364 * 864e5, "pago pelo aviso: o ano entra", cpx.periodo);
  relogio -= 70 * 864e5;
  // Com a assinatura mensal no cartão ativa, o mês no Pix não é oferecido.
  donos["tk-809"] = { sub: "809", email: "cartao@a.br" };
  await pedir(envReal, "POST", "/api/ia/site/cadastro", { ...CADASTRO, id_token: "tk-809" });
  await pedir(envReal, "POST", "/api/ia/site/pagar", { id_token: "tk-809", plano: "advogado", periodo: "mensal", cartao: cartao("tokaprovado00000000009") });
  const ofCartao = await corpoDe(await pedir(envReal, "POST", "/api/ia/site/oferta", { id_token: "tk-809", plano: "advogado", periodo: "mensal" }));
  checar(ofCartao.erro && !ofCartao.meios, "com a assinatura no cartão ativa, nem outro mês no cartão nem no Pix", ofCartao);
  r = await pedir(envReal, "POST", "/api/ia/site/pagar", { id_token: "tk-809", plano: "advogado", periodo: "mensal", meio: "pix" });
  checar(r.status === 409 && (await corpoDe(r)).erro.includes("cartão já está ativa"), "e o Pix do mês é recusado com o motivo");
  const ofAno = await corpoDe(await pedir(envReal, "POST", "/api/ia/site/oferta", { id_token: "tk-809", plano: "advogado", periodo: "anual" }));
  checar(ofAno.meios && ofAno.meios.pix === "" && ofAno.meios.cartao === "", "mas passar ao anual, no cartão ou no Pix, pode", ofAno.meios);

  // A desistência nos 7 dias: o cliente desiste sozinho e o dinheiro volta.
  donos["tk-810"] = { sub: "810", email: "desiste@a.br" };
  const ds = await corpoDe(await pedir(envReal, "POST", "/api/ia/ativar", { id_token: "tk-810", instalacao_id: "inst-810-0001" }));
  await pedir(envReal, "POST", "/api/ia/site/cadastro", { ...CADASTRO, id_token: "tk-810" });
  const qrD = await corpoDe(await pedir(envReal, "POST", "/api/ia/site/pagar", { id_token: "tk-810", plano: "advogado", periodo: "mensal", meio: "pix" }));
  mpPagamentos.get(qrD.pagamento).status = "approved";
  let sd = (await corpoDe(await pedir(envReal, "POST", "/api/ia/site/pix", { id_token: "tk-810", pagamento: qrD.pagamento }))).conta;
  checar(sd.plano_vigente && sd.desistencia.pode && sd.desistencia.valor === 449 && sd.desistencia.ate, "pago há pouco: o resumo diz que dá para desistir, quanto volta e até quando", sd.desistencia);
  r = await pedir(envReal, "POST", "/api/ia/site/desistir", { id_token: "tk-810" });
  const des = await corpoDe(r);
  const refund = mpPedidos.filter((x) => x.caminho === "/v1/payments/" + qrD.pagamento + "/refunds").at(-1);
  checar(r.status === 200 && des.valor === 449 && refund && refund.headers["X-Idempotency-Key"] === "reembolso-" + qrD.pagamento && !des.conta.plano_vigente
    && des.conta.assinatura.situacao === "refunded", "desistiu pelo site: o Pix volta no Mercado Pago e o plano acaba na hora", { status: r.status, des });
  checar(des.notas[0].acao === "sem_emissor", "sem o emissor de NFS-e ligado, a nota fica para conferir no painel", des.notas);
  checar((await pedir(envReal, "POST", "/api/ia/site/desistir", { id_token: "tk-810" })).status === 409, "desistir de novo: não há mais o que devolver");
  // Assina de novo e desiste outra vez: a desistência pelo PAULUS é uma por conta.
  const qrD2 = await corpoDe(await pedir(envReal, "POST", "/api/ia/site/pagar", { id_token: "tk-810", plano: "advogado", periodo: "mensal", meio: "pix" }));
  mpPagamentos.get(qrD2.pagamento).status = "approved";
  sd = (await corpoDe(await pedir(envReal, "POST", "/api/ia/site/pix", { id_token: "tk-810", pagamento: qrD2.pagamento }))).conta;
  r = await pedir(envReal, "POST", "/api/ia/desistir", null, ds.segredo);
  checar(r.status === 409 && (await corpoDe(r)).erro.includes("já foi usada") && !sd.desistencia.pode, "a segunda desistência não é sozinha: fica para o painel");
  // O cartão sem a primeira cobrança ainda: a assinatura sai e a cobrança, quando vier, volta.
  donos["tk-811"] = { sub: "811", email: "cartao2@a.br" };
  const dc2 = await corpoDe(await pedir(envReal, "POST", "/api/ia/ativar", { id_token: "tk-811", instalacao_id: "inst-811-0001" }));
  // Outro CPF (o do tk-810 já desistiu): no cadastro e no cartão.
  const outro = { type: "CPF", number: "111.444.777-35" };
  await pedir(envReal, "POST", "/api/ia/site/cadastro", { ...CADASTRO, documento: outro.number, id_token: "tk-811" });
  await pedir(envReal, "POST", "/api/ia/site/pagar", { id_token: "tk-811", plano: "advogado", periodo: "mensal", cartao: cartao("tokaprovado00000000011", { payer: { identification: outro } }) });
  const preD = [...mpPreapprovals.keys()].at(-1);
  r = await pedir(envReal, "POST", "/api/ia/desistir", null, dc2.segredo);
  const d2 = await corpoDe(r);
  checar(r.status === 200 && mpPreapprovals.get(preD).status === "cancelled" && !d2.conta.plano_vigente && d2.conta.desistencia_pendente,
    "desistiu pelo PAULUS antes da primeira cobrança: a assinatura é cancelada e a cobrança fica para devolver quando chegar", { status: r.status, d2 });
  // Outra conta Google com o mesmo CPF da que já desistiu: a desistência sozinha não vale de novo.
  donos["tk-813"] = { sub: "813", email: "outraconta@a.br" };
  const oc = await corpoDe(await pedir(envReal, "POST", "/api/ia/ativar", { id_token: "tk-813", instalacao_id: "inst-813-0001" }));
  await pedir(envReal, "POST", "/api/ia/site/cadastro", { ...CADASTRO, documento: "123.456.789-09", id_token: "tk-813" });
  // O cadastro com outro CPF, mas o cartão no nome de quem já desistiu (o do tk-810).
  await pedir(envReal, "POST", "/api/ia/site/pagar", { id_token: "tk-813", plano: "advogado", periodo: "mensal", cartao: cartao("tokaprovado00000000013") });
  const c813 = await corpoDe(await pedir(envReal, "GET", "/api/ia/conta", null, oc.segredo));
  checar(c813.plano_vigente && !c813.desistencia.pode && c813.desistencia.motivo.includes("CPF ou CNPJ"), "outra conta Google, cartão no CPF que já desistiu: o resumo já não oferece", c813.desistencia);
  r = await pedir(envReal, "POST", "/api/ia/desistir", null, oc.segredo);
  checar(r.status === 409 && (await corpoDe(r)).erro.includes("CPF ou CNPJ"), "e desistir é recusado, com o motivo");
  const guardadoDoc = [...guardados.keys()].filter((k) => k.startsWith("admin:desistencia:"));
  checar(guardadoDoc.length >= 2 && guardadoDoc.every((k) => /^admin:desistencia:[0-9a-f]{32}$/.test(k)) && ![...guardados.values()].some((v) => String(v).includes("52998224725") && String(v).includes("desistencia")),
    "o KV guarda só o resumo do documento, não o número", guardadoDoc);
  // Passados os 7 dias, não há desistência sozinha.
  donos["tk-812"] = { sub: "812", email: "tarde@a.br" };
  const tt = await corpoDe(await pedir(envReal, "POST", "/api/ia/ativar", { id_token: "tk-812", instalacao_id: "inst-812-0001" }));
  await pedir(envReal, "POST", "/api/ia/site/cadastro", { ...CADASTRO, id_token: "tk-812" });
  const qrT = await corpoDe(await pedir(envReal, "POST", "/api/ia/site/pagar", { id_token: "tk-812", plano: "advogado", periodo: "anual", meio: "pix" }));
  mpPagamentos.get(qrT.pagamento).status = "approved";
  await pedir(envReal, "POST", "/api/ia/site/pix", { id_token: "tk-812", pagamento: qrT.pagamento });
  relogio += 8 * 864e5;
  r = await pedir(envReal, "POST", "/api/ia/desistir", null, tt.segredo);
  checar(r.status === 409 && (await corpoDe(r)).erro.includes("7 dias"), "depois dos 7 dias: recusado, com o motivo");
  relogio -= 8 * 864e5;
}

function aviso(dataId, tipo, ts = Date.now()) {
  const requestId = "4ed4fa2b-0b31-42ec-a62f-ad793c486c59";
  const id = /^[A-Z0-9]+$/.test(dataId) && /[A-Z]/.test(dataId) ? dataId.toLowerCase() : dataId;
  const manifest = `id:${id};request-id:${requestId};ts:${ts};`;
  const v1 = createHmac("sha256", env.MP_WEBHOOK_SECRET).update(manifest).digest("hex");
  return new Request(`https://paulus.ia.br/api/mp/aviso?data.id=${dataId}&type=${tipo}`, {
    method: "POST",
    headers: { "x-signature": `ts=${ts},v1=${v1}`, "x-request-id": requestId },
    body: "{}",
  });
}

console.log(falhas ? `\n  ${falhas} falha(s)` : "\n  nuvem: todos os testes passaram");
process.exit(falhas ? 1 : 0);
