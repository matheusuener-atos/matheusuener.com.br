// Os eventos da Atos Cobranca para os produtos (docs/COBRANCA.md, "Eventos para o produto"): a orquestracao.
// O produto nao fala com o Mercado Pago; ele recebe da Atos o que mudou e aplica.
//
// Dois tipos:
//   direito.atualizado   o retrato do direito ao produto: o plano, ate quando esta pago, a assinatura viva
//                        e a `versao` (cresce a cada mudanca). O produto aplica so versao maior que a que ja
//                        tem - evento repetido ou fora de ordem nao estraga nada.
//   credito.adicionado   uma compra avulsa paga (a recarga do PAVLVS), com a `origem` (o pagamento): o produto
//                        credita uma vez por origem.
//
// A entrega: POST JSON ao endpoint do produto, com
//   Atos-Evento:      o id do evento (o mesmo em toda tentativa)
//   Atos-Assinatura:  t=<segundos>,v1=<HMAC-SHA256 hex de "<t>.<corpo>" com o segredo do produto>
// Resposta 2xx = entregue. Senao a Atos tenta de novo (REENTREGAS) e, esgotadas, marca "falhou" (o painel mostra).
// O produto confere a assinatura e a idade (5 minutos) antes de tudo - verificarEvento faz isso.

import { PRODUTOS } from "./catalogo.js";

export const REENTREGAS_S = [60, 300, 1800, 7200, 43200];
export const IDADE_MAXIMA_S = 300;
const TEMPO_MS = 15000;

const te = new TextEncoder();
async function hmacHex(segredo, texto) {
  const k = await crypto.subtle.importKey("raw", te.encode(segredo), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", k, te.encode(texto)))].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function iguais(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/* O segredo de um produto: EVENTOS_SEGREDO_<PRODUTO> (segredo do Worker, o mesmo gravado no produto). */
export function segredoDo(env, produto) {
  return String(env["EVENTOS_SEGREDO_" + String(produto).toUpperCase()] || "");
}

export async function assinarEvento(segredo, corpo, ts = Math.floor(Date.now() / 1000)) {
  return `t=${ts},v1=${await hmacHex(segredo, `${ts}.${corpo}`)}`;
}

/* Para o produto: confere a Atos-Assinatura de um corpo recebido. true | false. */
export async function verificarEvento(segredo, corpo, cabecalho, agora = Date.now()) {
  const p = Object.fromEntries(String(cabecalho || "").split(",").map((x) => x.trim().split("=")).filter((x) => x.length === 2));
  const ts = Number(p.t);
  if (!segredo || !ts || !p.v1 || Math.abs(agora / 1000 - ts) > IDADE_MAXIMA_S) return false;
  return iguais(await hmacHex(segredo, `${ts}.${corpo}`), String(p.v1).toLowerCase());
}

/* Entrega um evento ao produto. {ok, status}. Sem endpoint ou sem segredo: nao entrega (e diz). */
export async function entregar(env, evento, { buscar = fetch } = {}) {
  const produto = PRODUTOS[evento.produto];
  const segredo = segredoDo(env, evento.produto);
  if (!produto || !produto.eventos || !segredo) return { ok: false, status: 0, motivo: "produto sem endpoint ou sem segredo de eventos" };
  const corpo = JSON.stringify(evento);
  try {
    const r = await buscar(produto.eventos, {
      method: "POST",
      headers: { "content-type": "application/json", "Atos-Evento": evento.id, "Atos-Assinatura": await assinarEvento(segredo, corpo) },
      body: corpo,
      signal: AbortSignal.timeout(TEMPO_MS),
    });
    return { ok: r.ok, status: r.status };
  } catch {
    return { ok: false, status: 0, motivo: "o produto não respondeu" };
  }
}
