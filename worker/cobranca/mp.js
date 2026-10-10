// O Mercado Pago da Atos (o app "Atos Cobranca", 6924335552095997): a unica porta para a API REST.
// O Worker nao roda o SDK de Node; aqui so ha fetch, com o que a documentacao manda:
//   - Authorization com o MP_ACCESS_TOKEN (segredo do Worker; nunca sai daqui);
//   - X-Idempotency-Key em toda criacao da Orders API (a mesma chave numa nova tentativa nao cobra duas vezes);
//   - tempo limite, e o erro do Mercado Pago reduzido a um codigo e uma frase (o corpo cru nao vai ao navegador).

export const API = "https://api.mercadopago.com";
const TEMPO_MS = 20000;

export class ErroMP extends Error {
  constructor(status, codigo, frase) {
    super(frase);
    this.status = status;
    this.codigo = codigo;
  }
}

/* {ok, status, dados}. `idempotencia`: a chave da tentativa (POST da Orders API). */
export async function mpFetch(env, metodo, caminho, corpo, { idempotencia, buscar = fetch } = {}) {
  if (!env.MP_ACCESS_TOKEN) throw new ErroMP(503, "mp_desligado", "a cobrança ainda não está ligada (falta o MP_ACCESS_TOKEN)");
  const headers = { Authorization: `Bearer ${env.MP_ACCESS_TOKEN}`, Accept: "application/json" };
  if (corpo !== undefined) headers["Content-Type"] = "application/json";
  if (idempotencia) headers["X-Idempotency-Key"] = idempotencia;
  let r;
  try {
    r = await buscar(API + caminho, { method: metodo, headers, body: corpo === undefined ? undefined : JSON.stringify(corpo), signal: AbortSignal.timeout(TEMPO_MS) });
  } catch {
    throw new ErroMP(502, "mp_sem_resposta", "o Mercado Pago não respondeu: tente de novo em instantes");
  }
  let dados = null;
  try {
    dados = await r.json();
  } catch {
    dados = null;
  }
  return { ok: r.ok, status: r.status, dados };
}

/* A frase para a pessoa a partir da recusa do Mercado Pago (o detalhe tecnico fica no registro). */
const RECUSAS = {
  cc_rejected_insufficient_amount: "o cartão não tem limite para este valor",
  cc_rejected_bad_filled_security_code: "o código de segurança não confere",
  cc_rejected_bad_filled_date: "a validade do cartão não confere",
  cc_rejected_bad_filled_other: "confira os dados do cartão",
  cc_rejected_call_for_authorize: "o banco pediu para autorizar este pagamento: ligue para ele e tente de novo",
  cc_rejected_card_disabled: "o cartão está desativado: ative com o banco ou use outro",
  cc_rejected_duplicated_payment: "este pagamento já foi feito",
  cc_rejected_high_risk: "o pagamento foi recusado por segurança: tente outro cartão ou o Pix",
  cc_rejected_max_attempts: "tentativas demais com este cartão: use outro",
  insufficient_amount: "o cartão não tem limite para este valor",
};

export function fraseDaRecusa(detalhe) {
  return RECUSAS[detalhe] || "o pagamento foi recusado: tente outro cartão ou o Pix";
}

/* Cria a assinatura (a mensalidade no cartao). Endereco exato, sem /v1: https://api.mercadopago.com/preapproval.
   A referencia da API nao documenta X-Idempotency-Key aqui; o que impede a segunda e o external_reference
   unico, registrado antes, e a recusa de uma segunda assinatura viva do mesmo produto (api.js). */
export async function criarPreapproval(env, corpo, { buscar } = {}) {
  const fetch = buscar || globalThis.fetch; // os testes trocam o fetch
  if (!env.MP_ACCESS_TOKEN) throw new ErroMP(503, "mp_desligado", "a cobrança ainda não está ligada (falta o MP_ACCESS_TOKEN)");
  let r;
  try {
    r = await fetch("https://api.mercadopago.com/preapproval", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.MP_ACCESS_TOKEN}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(corpo),
      signal: AbortSignal.timeout(TEMPO_MS),
    });
  } catch {
    throw new ErroMP(502, "mp_sem_resposta", "o Mercado Pago não respondeu: tente de novo em instantes");
  }
  let dados = null;
  try {
    dados = await r.json();
  } catch {
    dados = null;
  }
  return { ok: r.ok, status: r.status, dados };
}
