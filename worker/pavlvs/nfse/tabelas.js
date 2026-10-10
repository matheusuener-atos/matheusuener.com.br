// As tabelas oficiais da NFS-e no Worker (porte do necessário de
// paulus/legal/src/nfse/tabelas.py). Os JSON compactos saem de
// worker/nfse/tabelas/gerar.py, a partir das tabelas do PAULUS; mudar uma
// tabela é rodar o gerar.py de novo, nunca editar à mão.

import MUNICIPIOS from "./tabelas/municipios.json" with { type: "json" };
import SERVICOS from "./tabelas/servicos.json" with { type: "json" };
import NBS from "./tabelas/nbs.json" with { type: "json" };
import INDOP from "./tabelas/indop.json" with { type: "json" };
import REGRAS from "./tabelas/regras.json" with { type: "json" };
import DOMINIOS from "./tabelas/dominios.json" with { type: "json" };
import VERSOES from "./tabelas/versoes.json" with { type: "json" };
import { soDigitos } from "./texto.js";

export const UF_DO_CODIGO = {
  11: "RO", 12: "AC", 13: "AM", 14: "RR", 15: "PA", 16: "AP", 17: "TO",
  21: "MA", 22: "PI", 23: "CE", 24: "RN", 25: "PB", 26: "PE", 27: "AL",
  28: "SE", 29: "BA", 31: "MG", 32: "ES", 33: "RJ", 35: "SP", 41: "PR",
  42: "SC", 43: "RS", 50: "MS", 51: "MT", 52: "GO", 53: "DF",
};

const conjuntoNbs = new Set(NBS);
const conjuntoIndop = new Set(INDOP);
const tem = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k);

/** {codigo, nome, uf} ou null. */
export function municipio(codigo) {
  const c = soDigitos(codigo);
  if (!tem(MUNICIPIOS, c)) return null;
  return { codigo: c, nome: MUNICIPIOS[c], uf: UF_DO_CODIGO[c.slice(0, 2)] };
}

/** {codigo, local} ou null (o cTribNac com 6 dígitos). */
export function servico(codigo) {
  const c = soDigitos(codigo).padStart(6, "0");
  return tem(SERVICOS, c) ? { codigo: c, local: SERVICOS[c] } : null;
}

export function nbs(codigo) {
  const c = soDigitos(codigo);
  return conjuntoNbs.has(c) ? { codigo: c } : null;
}

export function indop(codigo) {
  const c = soDigitos(codigo);
  return conjuntoIndop.has(c) ? { codigo: c } : null;
}

/** EP, LP ou ET para o código de serviço ("" se a tabela não diz). */
export function localDeIncidencia(ctribnac) {
  const s = servico(ctribnac);
  return s ? s.local : "";
}

/** A regra oficial (E0014, E0840...) como {mensagem, campo}, ou null. */
export function regra(codigo) {
  const c = String(codigo || "").trim().toUpperCase();
  const r = tem(REGRAS, c) ? REGRAS[c] : null;
  return r ? { mensagem: r[0], campo: r[1] } : null;
}

/** Um domínio do XSD como {código: rótulo}. */
export function dominio(nome) {
  return { ...(DOMINIOS[nome] || {}) };
}

export function versoes() {
  return VERSOES;
}

// ------------------------------------------------------------ busca pelo nome

const semAcento = (t) => String(t || "").normalize("NFD").replace(/\p{Mn}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
let indiceNomes = null; // [[codigo, nome sem acento]], feito na 1ª busca
// As 27 capitais vêm primeiro em cada grupo ("goi" mostra Goiânia antes de Goiabeira).
const CAPITAIS = new Set(["1100205", "1200401", "1302603", "1400100", "1501402", "1600303", "1721000", "2111300", "2211001", "2304400",
  "2408102", "2507507", "2611606", "2704302", "2800308", "2927408", "3106200", "3205309", "3304557", "3550308", "4106902", "4205407",
  "4314902", "5002704", "5103403", "5208707", "5300108"]);

/**
 * Os municípios pelo nome, sem acento e por começo de palavra ("goi" acha
 * Goiânia e Goiás; "paulo", São Paulo), até `limite`: primeiro o nome igual,
 * depois o que começa pelo texto, depois o que tem uma palavra que começa
 * por ele; em cada grupo, as capitais primeiro e depois a ordem alfabética. Com uf, só os dela. Os 7
 * dígitos do código IBGE também acham. Devolve [{codigo, nome, uf}].
 */
export function buscarMunicipios(texto, uf = "", limite = 12) {
  const so = soDigitos(texto);
  const filtroUf = String(uf || "").trim().toUpperCase();
  if (so.length === 7 && /^\s*\d{7}\s*$/.test(String(texto))) {
    const m = municipio(so);
    return m && (!filtroUf || m.uf === filtroUf) ? [m] : [];
  }
  const alvo = semAcento(texto);
  if (!alvo) return [];
  if (!indiceNomes) indiceNomes = Object.keys(MUNICIPIOS).map((c) => [c, semAcento(MUNICIPIOS[c])]);
  const grupos = [[], [], []];
  for (const [c, n] of indiceNomes) {
    if (filtroUf && UF_DO_CODIGO[c.slice(0, 2)] !== filtroUf) continue;
    if (n === alvo) grupos[0].push(c);
    else if (n.startsWith(alvo)) grupos[1].push(c);
    else if (n.includes(" " + alvo)) grupos[2].push(c);
  }
  const ordem = (a, b) => (CAPITAIS.has(b) - CAPITAIS.has(a)) || MUNICIPIOS[a].localeCompare(MUNICIPIOS[b], "pt-BR") || a.localeCompare(b);
  return grupos.flatMap((g) => g.sort(ordem)).slice(0, Math.max(1, Math.min(50, Number(limite) || 12))).map(municipio);
}
