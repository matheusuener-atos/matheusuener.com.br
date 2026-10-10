// A DPS em XML, leiaute da NFS-e Nacional 1.01 com o grupo IBSCBS (porte de
// paulus/legal/src/nfse/dps.py). A ordem é a do XSD, sem prefixo de
// namespace e em UTF-8 (E1228, E1229); o emitente é o prestador (tpEmit 1),
// sem nome nem endereço dele (E0121). A saída é IDÊNTICA, byte a byte, à do
// Python (worker/teste-nfse-emissor.mjs, fixtures/gerar_emissor.py).

import { decimalXml, percentualXml } from "./dinheiro.js";
import { anexar, novo, serializar } from "./xml.js";
import { conferirCaracteres, cortar, limpa, semEspacos, soDigitos, strip } from "./texto.js";

export const NS = "http://www.sped.fazenda.gov.br/nfse";
export const VERSAO = "1.01";

// Os cIndOp que obrigam o endereço do tomador (RN 255 do Anexo I).
export const INDOP_EXIGE_ENDERECO = new Set(["030102", "050102", "100101", "100301", "100501", "030103", "050103",
  "100102", "100201", "100302", "100401", "100502", "100601"]);

function inteiroTexto(v) {
  const t = String(v).trim();
  if (!/^[+-]?\d+$/.test(t)) throw new Error(`invalid literal for int() with base 10: '${v}'`);
  return BigInt(t);
}

/** "DPS" + município(7) + tipo(1) + inscrição(14) + série(5) + número(15) (TSIdDPS). */
export function idDps(cmun, documento, serie, numero) {
  const doc = String(documento).toUpperCase().replace(/[^0-9A-Z]/g, "");
  let tipo;
  let insc;
  if (doc.length === 11) { tipo = "1"; insc = doc.padStart(14, "0"); }
  else if (doc.length === 14) { tipo = "2"; insc = doc; }
  else throw new Error("o documento do prestador precisa ser CPF ou CNPJ");
  return `DPS${cmun}${tipo}${insc}${String(inteiroTexto(serie)).padStart(5, "0")}${String(inteiroTexto(numero)).padStart(15, "0")}`;
}

/** Data e hora de Brasília com o fuso (AAAA-MM-DDThh:mm:ss-03:00). */
export function dhEmi(quando = new Date()) {
  const b = new Date(quando.getTime() - 3 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${b.getUTCFullYear()}-${p(b.getUTCMonth() + 1)}-${p(b.getUTCDate())}T${p(b.getUTCHours())}:${p(b.getUTCMinutes())}:${p(b.getUTCSeconds())}-03:00`;
}

/** A data de hoje em Brasília (AAAA-MM-DD). */
export function hojeBrasilia(agora = new Date()) {
  return dhEmi(agora).slice(0, 10);
}

function sub(pai, nome, texto) {
  const el = novo(nome);
  // Texto "" sai como <a></a> no lxml; sem texto (None), como <a/>.
  if (texto !== undefined && texto !== null) el.filhos.push({ tipo: "texto", texto: conferirCaracteres(String(texto)) });
  return anexar(pai, el);
}

function documento(pai, doc) {
  const d = String(doc || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (d.length === 14) sub(pai, "CNPJ", d);
  else if (d.length === 11) sub(pai, "CPF", d);
  else throw new Error("documento do tomador precisa ser CPF ou CNPJ");
}

/**
 * Devolve {xml (string UTF-8), id}. `nota` é o rascunho conferido:
 * {competencia, descricao, tomador{...}, municipio_incidencia, ctribnac, nbs,
 *  ctribmun, informacoes, substitui{chave, motivo, texto}}; `conta`, a de tributos.js.
 */
export function montarDps({ prest, nota, conta, ambiente, serie, numero, quando, verAplic = "PAULUS" }) {
  const tomador = nota.tomador || {};
  const serv = prest.servico || {};
  const cmunPrest = prest.municipio;
  const ident = idDps(cmunPrest, prest.documento, serie, numero);

  const dps = novo("DPS", { decls: [["", NS]], attrs: [["versao", VERSAO]] });
  const inf = sub(dps, "infDPS");
  inf.attrs.push(["Id", ident]);
  sub(inf, "tpAmb", ambiente === "producao" ? "1" : "2");
  sub(inf, "dhEmi", dhEmi(quando || new Date()));
  sub(inf, "verAplic", limpa(verAplic, 20));
  sub(inf, "serie", String(inteiroTexto(serie)));
  sub(inf, "nDPS", String(inteiroTexto(numero)));
  sub(inf, "dCompet", cortar(String(nota.competencia), 10));
  sub(inf, "tpEmit", "1");
  sub(inf, "cLocEmi", cmunPrest);

  const subst = nota.substitui || {};
  if (subst.chave) {
    const g = sub(inf, "subst");
    sub(g, "chSubstda", subst.chave);
    sub(g, "cMotivo", subst.motivo);
    if (subst.texto) sub(g, "xMotivo", limpa(subst.texto, 255));
  }

  const p = sub(inf, "prest");
  documento(p, prest.documento);
  if (prest.inscricao_municipal) sub(p, "IM", prest.inscricao_municipal);
  const rt = sub(p, "regTrib");
  sub(rt, "opSimpNac", prest.opcao_simples);
  if (prest.opcao_simples === "3" && prest.regime_apuracao_sn) sub(rt, "regApTribSN", prest.regime_apuracao_sn);
  sub(rt, "regEspTrib", prest.regime_especial || "0");

  if (tomador.documento) {
    const t = sub(inf, "toma");
    documento(t, tomador.documento);
    if (tomador.inscricao_municipal) sub(t, "IM", cortar(semEspacos(tomador.inscricao_municipal), 15));
    sub(t, "xNome", limpa(tomador.nome, 300));
    if (tomador.cmun && tomador.cep && tomador.logradouro) {
      const e = sub(t, "end");
      const en = sub(e, "endNac");
      sub(en, "cMun", tomador.cmun);
      sub(en, "CEP", soDigitos(tomador.cep));
      sub(e, "xLgr", limpa(tomador.logradouro, 255));
      sub(e, "nro", limpa(tomador.numero || "S/N", 60));
      if (tomador.complemento) sub(e, "xCpl", limpa(tomador.complemento, 156));
      sub(e, "xBairro", limpa(tomador.bairro || "", 60));
    }
    const fone = soDigitos(String(tomador.telefone || ""));
    if ([...fone].length >= 6 && [...fone].length <= 20) sub(t, "fone", fone);
    if (tomador.email) sub(t, "email", limpa(tomador.email, 80));
  }

  const s = sub(inf, "serv");
  const lp = sub(s, "locPrest");
  sub(lp, "cLocPrestacao", nota.municipio_incidencia || cmunPrest);
  const cs = sub(s, "cServ");
  sub(cs, "cTribNac", nota.ctribnac || serv.ctribnac);
  const ctribmun = nota.ctribmun !== undefined && nota.ctribmun !== null ? nota.ctribmun : serv.ctribmun;
  if (ctribmun) sub(cs, "cTribMun", ctribmun);
  const desc = strip(String(nota.descricao || serv.descricao || ""));
  sub(cs, "xDescServ", cortar(desc, 2000));
  const nbs = nota.nbs || serv.nbs;
  if (nbs) sub(cs, "cNBS", nbs);
  if (nota.informacoes) {
    const ic = sub(s, "infoCompl");
    sub(ic, "xInfComp", cortar(strip(String(nota.informacoes)), 2000));
  }

  const v = sub(inf, "valores");
  const vsp = sub(v, "vServPrest");
  sub(vsp, "vServ", decimalXml(conta.v_serv));
  if (conta.v_desc_incond) {
    const dc = sub(v, "vDescCondIncond");
    sub(dc, "vDescIncond", decimalXml(conta.v_desc_incond));
  }
  const trib = sub(v, "trib");
  const tm = sub(trib, "tribMun");
  sub(tm, "tribISSQN", "1");
  sub(tm, "tpRetISSQN", conta.iss_retido ? "2" : "1");
  if (conta.informar_paliq) sub(tm, "pAliq", percentualXml(conta.aliquota_iss_bp));

  const r = conta.retencoes || {};
  if (conta.v_ret_csll || r.cp || r.irrf) {
    const tf = sub(trib, "tribFed");
    if (conta.v_ret_csll) {
      const pc = sub(tf, "piscofins");
      sub(pc, "CST", (prest.pis_cofins || {}).cst || "00");
      sub(pc, "tpRetPisCofins", conta.tp_ret_pis_cofins);
    }
    if (r.cp) sub(tf, "vRetCP", decimalXml(r.cp));
    if (r.irrf) sub(tf, "vRetIRRF", decimalXml(r.irrf));
    if (conta.v_ret_csll) sub(tf, "vRetCSLL", decimalXml(conta.v_ret_csll));
  }

  const tt = prest.total_tributos || {};
  const tot = sub(trib, "totTrib");
  const op = prest.opcao_simples;
  const n = (k) => Math.trunc(Number(tt[k] || 0));
  if (op === "3" && tt.modo === "simples") {
    sub(tot, "pTotTribSN", percentualXml(n("simples_bp")));
  } else if (op === "2" && !["federal_bp", "estadual_bp", "municipal_bp"].some((k) => n(k))) {
    sub(tot, "indTotTrib", "0");
  } else {
    const pt = sub(tot, "pTotTrib");
    sub(pt, "pTotTribFed", percentualXml(n("federal_bp")));
    sub(pt, "pTotTribEst", percentualXml(n("estadual_bp")));
    sub(pt, "pTotTribMun", percentualXml(n("municipal_bp")));
  }

  const ib = prest.ibscbs || {};
  if (ib.enviar) {
    const g = sub(inf, "IBSCBS");
    sub(g, "finNFSe", "0");
    sub(g, "indFinal", ib.indfinal || "0");
    sub(g, "cIndOp", ib.cindop);
    sub(g, "indDest", "0");
    const vg = sub(g, "valores");
    const tg = sub(vg, "trib");
    const gi = sub(tg, "gIBSCBS");
    sub(gi, "CST", ib.cst);
    sub(gi, "cClassTrib", ib.cclasstrib);
  }
  return { xml: serializar(dps), id: ident };
}
