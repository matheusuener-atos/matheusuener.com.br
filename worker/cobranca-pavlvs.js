// A cobranca do PAVLVS na Atos (docs/MIGRACAO-COBRANCA.md, etapa 2): o motor que era do Worker
// "paulus" roda aqui, em worker/pavlvs/ (o mesmo codigo, com os mesmos testes), sobre os mesmos
// dados - o KV (o APOIOS de la e o CONTAS daqui) e os Durable Objects ContaIA e EmissorNFSe, que
// continuam do Worker "paulus" e chegam aqui por binding (script_name).
//
// So as rotas de cobranca entram aqui. O proxy da IA (/api/ia/v1/*, ativar, modelos), o acesso de fora, o
// painel e a identidade antiga (/api/id/*) continuam no PAVLVS.

import pavlvs from "./pavlvs/index.js";

const EXATAS = new Set([
  "/api/conta", "/api/mp/aviso", "/api/planos/textos",
  "/api/ia/planos", "/api/ia/mp-config", "/api/ia/assinar", "/api/ia/assinatura", "/api/ia/assinatura/cancelar",
  "/api/ia/plano", "/api/ia/recarga", "/api/ia/desistir", "/api/ia/nfse", "/api/ia/minha-conta/link",
]);
const PREFIXOS = ["/api/conta/", "/api/ia/site/", "/api/ia/recarga/", "/api/ia/nfse/"];

export function ehRotaDaCobrancaPavlvs(url) {
  return EXATAS.has(url.pathname) || PREFIXOS.some((p) => url.pathname.startsWith(p));
}

/* O env do motor: o KV com o nome de la. O resto (DOs, segredos, vars) tem o mesmo nome nos dois Workers. */
export function envDoMotor(env) {
  return { ...env, APOIOS: env.CONTAS };
}

export async function atenderCobrancaPavlvs(request, env, ctx) {
  return pavlvs.fetch(request, envDoMotor(env), ctx);
}
