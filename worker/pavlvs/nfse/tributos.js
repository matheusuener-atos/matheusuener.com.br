// A conta dos tributos da nota (porte de paulus/legal/src/nfse/tributos.py),
// em centavos, com a regra de cada linha escrita ao lado. O que é previsão
// (ISS próprio, IBS, CBS: a Sefin calcula) e o que é decisão do escritório
// (retenções, ISS retido) ficam separados, como no Python.

import { aplicar, percentualTexto, reais } from "./dinheiro.js";
import * as tabelas from "./tabelas.js";

export const TIPO_RETENCAO_PCC = {
  "false,false,false": "0",
  "true,true,true": "3",
  "true,true,false": "4",
  "true,false,false": "5",
  "false,true,false": "6",
  "false,true,true": "7",
  "false,false,true": "8",
  "true,false,true": "9",
};

export const CBS_2026_BP = 90;
export const IBS_UF_2026_BP = 10;
export const IBS_MUN_2026_BP = 0;

const ROTULO_RETENCAO = {
  irrf: "IRRF retido", pis: "PIS retido", cofins: "COFINS retida", csll: "CSLL retida", cp: "Contribuição previdenciária retida",
};

function linha(chave, rotulo, centavos, regra, tipo = "valor") {
  return { chave, rotulo, centavos, regra, tipo };
}

export function contaVazia() {
  return {
    v_serv: 0, v_desc_incond: 0, base_iss: 0, aliquota_iss_bp: 0, iss: 0, iss_destacado: false, iss_retido: false,
    informar_paliq: false, retencoes: {}, v_ret_csll: 0, tp_ret_pis_cofins: "0", v_total_ret: 0, v_liq: 0, ibscbs: {},
    linhas: [], avisos: [], erros: [],
  };
}

function tomadorPj(tomador) {
  const doc = String(tomador.documento || "").replace(/[^\p{L}\p{N}]/gu, "");
  return [...doc].length === 14;
}

function seAplica(quando, tomador) {
  return quando === "sempre" || (quando === "tomador_pj" && tomadorPj(tomador));
}

/** Se a DPS leva a alíquota do ISS (E0600...E0640). Devolve [informar, por quê]. */
export function regraPaliq(prest, issRetido, municipioAtivo) {
  const op = prest.opcao_simples;
  if (op === "2") return [false, "MEI não informa alíquota (E0600)"];
  if ((prest.regime_especial ?? "0") !== "0") return [false, "com regime especial a alíquota não vai na nota (E0604)"];
  if (op === "1") {
    if (municipioAtivo) return [false, "não optante com município conveniado: a Sefin usa a alíquota do município (E0617)"];
    return [true, "não optante com município sem convênio ativo: a alíquota vai na nota (E0619)"];
  }
  if (op === "3") {
    if (prest.regime_apuracao_sn === "1") {
      if (issRetido) return [true, "Simples com ISS retido: a alíquota do Simples vai na nota (E0621/E0628)"];
      return [false, "Simples sem retenção: o ISS vai no DAS e a alíquota não vai na nota (E0625/E0631)"];
    }
    if (municipioAtivo) return [false, "Simples com ISS fora do DAS e município conveniado: a Sefin usa a alíquota do município (E0635)"];
    return [true, "Simples com ISS fora do DAS e município sem convênio ativo: a alíquota vai na nota (E0640)"];
  }
  return [false, "situação no Simples não configurada"];
}

/**
 * prest: a configuração conferida (prestador.js); nota: {valor_centavos,
 * desconto_incond_centavos, competencia, tomador}. Devolve a conta (objeto
 * com os mesmos campos da tributos.Conta do Python).
 */
export function calcular(prest, nota, { municipioAtivo = true } = {}) {
  const c = contaVazia();
  const tomador = nota.tomador || {};
  c.v_serv = Math.trunc(Number(nota.valor_centavos || 0));
  c.v_desc_incond = Math.trunc(Number(nota.desconto_incond_centavos || 0));
  if (c.v_serv <= 0) {
    c.erros.push("o valor do serviço precisa ser maior que zero");
    return c;
  }
  if (c.v_desc_incond < 0 || c.v_desc_incond > c.v_serv) {
    c.erros.push("o desconto incondicionado não pode passar do valor do serviço");
    return c;
  }
  const base = c.v_serv - c.v_desc_incond;
  c.linhas.push(linha("v_serv", "Valor do serviço", c.v_serv, "o valor da nota", "valor"));
  if (c.v_desc_incond) c.linhas.push(linha("desc", "Desconto incondicionado", -c.v_desc_incond, "dado na nota, sai da base do ISS", "valor"));

  const op = prest.opcao_simples ?? "1";
  const especial = prest.regime_especial ?? "0";
  const serv = prest.servico || {};
  const ret = prest.retencoes || {};

  // ISS
  const issCfg = ret.iss || {};
  const podeReterIss = op !== "2" && especial === "0";
  c.iss_retido = podeReterIss && seAplica(issCfg.quando ?? "nao_sei", tomador);
  c.base_iss = base;
  c.aliquota_iss_bp = Math.trunc(Number(serv.aliquota_iss_bp || 0));
  if (op === "2") {
    c.linhas.push(linha("iss", "ISS", 0, "MEI: o ISS vai no DAS do MEI, fora desta nota", "info"));
  } else if (especial !== "0") {
    const nome = tabelas.dominio("regime_especial")[especial] ?? especial;
    c.linhas.push(linha("iss", "ISS", 0, `regime especial (${nome}): o ISS é recolhido fora desta nota, `
      + "sem alíquota nem retenção na nota (E0604, E0588)", "info"));
  } else if (op === "3" && prest.regime_apuracao_sn === "1" && !c.iss_retido) {
    c.linhas.push(linha("iss", "ISS", 0, "Simples Nacional: o ISS vai no DAS, fora desta nota", "info"));
  } else {
    c.iss_destacado = true;
    if (!c.aliquota_iss_bp) {
      c.avisos.push("a alíquota do ISS não está configurada: a previsão do ISS fica sem valor "
        + "(a Sefin aplica a alíquota do município)");
    }
    c.iss = aplicar(base, c.aliquota_iss_bp);
    c.linhas.push(linha("base_iss", "Base do ISS", base, "valor do serviço − desconto incondicionado (E1295)", "previsao"));
    c.linhas.push(linha("iss", "ISS" + (c.iss_retido ? " retido pelo tomador" : ""), c.iss,
      `base × ${percentualTexto(c.aliquota_iss_bp)} (alíquota configurada; a Sefin aplica a `
      + "parametrizada pelo município e a nota emitida mostra a dela)", "previsao"));
  }
  if (podeReterIss && issCfg.quando === "nao_sei") c.avisos.push("ISS retido: não configurado — pergunte ao contador; a nota sai sem ISS retido");
  const [informar, motivoPaliq] = regraPaliq(prest, c.iss_retido, municipioAtivo);
  c.informar_paliq = informar;
  c.linhas.push(linha("paliq", "Alíquota do ISS na nota", 0, (informar ? "vai na nota: " : "não vai na nota: ") + motivoPaliq, "info"));

  // retenções federais
  const retidos = {};
  for (const k of ["irrf", "pis", "cofins", "csll", "cp"]) {
    const cfg = ret[k] || {};
    const quando = cfg.quando ?? "nao_sei";
    if (op === "2") { retidos[k] = 0; continue; }
    if (quando === "nao_sei") {
      retidos[k] = 0;
      c.avisos.push(`${ROTULO_RETENCAO[k]}: não configurado — pergunte ao contador; a nota sai sem esta retenção`);
      continue;
    }
    if (!seAplica(quando, tomador)) { retidos[k] = 0; continue; }
    const bp = Math.trunc(Number(cfg.aliquota_bp || 0));
    const valor = aplicar(base, bp);
    const minimo = Math.trunc(Number(cfg.minimo_centavos || 0));
    if (minimo && valor < minimo) {
      c.linhas.push(linha(k, ROTULO_RETENCAO[k], 0, `${percentualTexto(bp)} daria ${reais(valor)}, abaixo do `
        + `mínimo configurado (${reais(minimo)}): não retido`, "retencao"));
      retidos[k] = 0;
      continue;
    }
    retidos[k] = valor;
    const quem = quando === "sempre" ? "sempre" : "tomador pessoa jurídica";
    c.linhas.push(linha(k, ROTULO_RETENCAO[k], -valor, `${percentualTexto(bp)} × ${reais(base)} (regra do escritório: ${quem})`, "retencao"));
  }
  c.retencoes = retidos;
  c.v_ret_csll = retidos.pis + retidos.cofins + retidos.csll;
  c.tp_ret_pis_cofins = TIPO_RETENCAO_PCC[[retidos.pis > 0, retidos.cofins > 0, retidos.csll > 0].join(",")];
  if (c.v_ret_csll) {
    c.linhas.push(linha("v_ret_csll", "PIS + COFINS + CSLL retidos (campo único da nota)", -c.v_ret_csll,
      `somados em vRetCSLL, tipo de retenção ${c.tp_ret_pis_cofins} (NT 007)`, "info"));
  }
  for (const [k, v] of Object.entries(retidos)) {
    if (v && v >= c.v_serv) c.erros.push(`${ROTULO_RETENCAO[k]} não pode ser igual ou maior que o valor do serviço (E0699/E0700)`);
  }
  c.v_total_ret = retidos.cp + retidos.irrf + c.v_ret_csll + (c.iss_retido ? c.iss : 0);
  c.v_liq = c.v_serv - c.v_desc_incond - c.v_total_ret;
  if (c.v_total_ret) {
    c.linhas.push(linha("v_total_ret", "Total retido", -c.v_total_ret,
      "CP + IRRF + (PIS+COFINS+CSLL)" + (c.iss_retido ? " + ISS retido" : "") + " (E1506)", "total"));
  }
  c.linhas.push(linha("v_liq", "Valor líquido", c.v_liq, "valor do serviço − descontos − retenções (E1508)", "total"));
  if (c.v_liq < 0) c.erros.push("o valor líquido ficou negativo: confira as retenções (E1508)");

  // IBS/CBS
  const ib = prest.ibscbs || {};
  const ano = String(nota.competencia || "").slice(0, 4);
  if (ib.enviar) {
    if (ano === "2026") {
      const issNaBase = c.iss_destacado ? c.iss : 0;
      const baseIbs = base - issNaBase;
      const cbs = aplicar(baseIbs, CBS_2026_BP);
      const ibsUf = aplicar(baseIbs, IBS_UF_2026_BP);
      c.ibscbs = { ano, base: baseIbs, cbs_bp: CBS_2026_BP, ibs_uf_bp: IBS_UF_2026_BP, ibs_mun_bp: IBS_MUN_2026_BP, cbs, ibs_uf: ibsUf, ibs_mun: 0, recolhe: false };
      c.linhas.push(linha("base_ibscbs", "Base do IBS/CBS", baseIbs, "valor − desconto incondicionado − ISS (2026, regra E1530)", "previsao"));
      c.linhas.push(linha("cbs", "CBS", cbs, `${percentualTexto(CBS_2026_BP)} em 2026 (LC 214, art. 346), `
        + "antes de redução da classificação, que a Sefin aplica", "previsao"));
      c.linhas.push(linha("ibs", "IBS", ibsUf, `${percentualTexto(IBS_UF_2026_BP)} estadual em 2026 (LC 214, art. 343)`, "previsao"));
      c.linhas.push(linha("ibscbs_2026", "IBS e CBS em 2026", 0,
        "destacados na nota, sem recolhimento para quem cumpre as obrigações acessórias "
        + "(LC 214, art. 348, §1º); não mudam o valor líquido (vTotNF = vLiq)", "info"));
    } else {
      c.ibscbs = { ano, recolhe: null };
      c.linhas.push(linha("ibscbs", "IBS e CBS", 0, "a Sefin calcula pela alíquota vigente na competência; a nota emitida mostra os valores", "info"));
    }
    if ((op === "2" || op === "3") && ano === "2026") {
      c.avisos.push("Simples Nacional: o IBS/CBS só passa a valer em 2027 (Resolução CGSN 191/2026); "
        + "mandar o grupo em 2026 é opção do escritório");
    }
  }
  return c;
}
