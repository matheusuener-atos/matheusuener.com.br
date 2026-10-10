// A configuração fiscal do prestador (porte de prestador.conferir e PADRAO,
// paulus/legal/src/nfse/prestador.py). Cada gravação é uma versão nova no
// Durable Object (emissor.js); a nota guarda a versão com que foi montada.

import * as tabelas from "./tabelas.js";
import { cnpjValido, cortar, cpfValido, documentoNormal, juntarEspacos, semEspacos, soDigitos, strip } from "./texto.js";

export const AMBIENTES = {
  producao_restrita: "Produção restrita (testes, sem valor fiscal)",
  producao: "Produção (vale de verdade)",
};

export const QUANDO_RETER = {
  nunca: "Nunca",
  tomador_pj: "Quando o tomador é pessoa jurídica",
  sempre: "Sempre",
  nao_sei: "Não sei — perguntar ao contador",
};

export const RETENCOES = {
  irrf: "IRRF",
  pis: "PIS",
  cofins: "COFINS",
  csll: "CSLL",
  cp: "Contribuição previdenciária (CP)",
  iss: "ISS retido pelo tomador",
};

export function padrao() {
  const retencoes = {};
  for (const r of Object.keys(RETENCOES)) retencoes[r] = { quando: "nao_sei", aliquota_bp: 0, minimo_centavos: 0, nota: "" };
  return {
    documento: "",
    razao_social: "",
    inscricao_municipal: "",
    municipio: "",
    uf: "",
    endereco: { logradouro: "", numero: "", complemento: "", bairro: "", cep: "" },
    telefone: "",
    email: "",
    opcao_simples: "1",
    regime_apuracao_sn: "",
    regime_especial: "0",
    regime_federal: "",
    anexo_simples: "",
    servico: { ctribnac: "171401", nbs: "", ctribmun: "", descricao: "", aliquota_iss_bp: 0 },
    retencoes,
    pis_cofins: { cst: "" },
    ibscbs: { enviar: true, cst: "", cclasstrib: "", cindop: "100301", indfinal: "0" },
    total_tributos: { modo: "percentual", federal_bp: 0, estadual_bp: 0, municipal_bp: 0, simples_bp: 0 },
    serie: "1",
    contador: { nome: "", email: "" },
    ambiente: "producao_restrita",
    revisado_por: "",
    revisado_em: "",
  };
}

const ehObjeto = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** _fundir: só as chaves que o modelo conhece; objeto dentro de objeto se funde. */
export function fundir(base, novo) {
  const saida = structuredClone(base);
  for (const [k, v] of Object.entries(novo || {})) {
    if (!(k in saida)) continue;
    if (ehObjeto(saida[k]) && ehObjeto(v)) saida[k] = fundir(saida[k], v);
    else saida[k] = structuredClone(v);
  }
  return saida;
}

function inteiro(valor, campo, minimo = 0, maximo = null) {
  if (typeof valor === "boolean") throw new Error(`${campo}: valor inválido`);
  let n;
  if (typeof valor === "number" && Number.isInteger(valor)) n = valor;
  else {
    const texto = strip(String(valor || "0"));
    if (!/^-?\d+$/.test(texto)) throw new Error(`${campo}: use um número inteiro`);
    n = Number(texto);
  }
  if (n < minimo || (maximo !== null && n > maximo)) throw new Error(`${campo}: fora do intervalo permitido`);
  return n;
}

/**
 * Limpa a configuração e diz o que falta. Devolve {prest, faltas}; erro de
 * formato é exceção (com a mesma frase do Python).
 */
export function conferirPrestador(dados) {
  const c = fundir(padrao(), dados || {});
  const faltas = [];

  const doc = documentoNormal(c.documento);
  if (doc) {
    if (doc.length === 14) {
      if (!cnpjValido(doc)) throw new Error("o CNPJ do prestador não confere (dígito verificador)");
    } else if (doc.length === 11) {
      if (!cpfValido(doc)) throw new Error("o CPF do prestador não confere (dígito verificador)");
    } else throw new Error("o documento do prestador precisa ser um CNPJ ou um CPF");
  } else faltas.push("o CNPJ (ou CPF) do prestador");
  c.documento = doc;

  c.inscricao_municipal = cortar(semEspacos(String(c.inscricao_municipal || "")), 15);
  const mun = soDigitos(c.municipio || "");
  if (mun) {
    const achado = tabelas.municipio(mun);
    if (!achado) throw new Error("o município do prestador não está na tabela oficial do IBGE");
    c.uf = achado.uf;
  } else faltas.push("o município do prestador");
  c.municipio = mun;

  const end = c.endereco;
  end.cep = soDigitos(end.cep || "");
  if (end.cep && end.cep.length !== 8) throw new Error("o CEP do prestador precisa de 8 dígitos");
  c.telefone = soDigitos(c.telefone || "");

  if (!(c.opcao_simples in tabelas.dominio("opcao_simples"))) throw new Error("situação no Simples Nacional inválida");
  if (!(c.regime_especial in tabelas.dominio("regime_especial"))) throw new Error("regime especial de tributação inválido");
  if (c.opcao_simples === "3") {
    if (!(c.regime_apuracao_sn in tabelas.dominio("regime_apuracao_sn"))) faltas.push("o regime de apuração do Simples (ME/EPP)");
  } else c.regime_apuracao_sn = "";

  const s = c.servico;
  s.ctribnac = s.ctribnac ? soDigitos(s.ctribnac).padStart(6, "0") : "";
  if (s.ctribnac && !tabelas.servico(s.ctribnac)) throw new Error("o código de tributação nacional não está na lista oficial de serviços");
  if (!s.ctribnac) faltas.push("o código de tributação nacional do serviço");
  s.nbs = soDigitos(s.nbs || "");
  if (s.nbs && !tabelas.nbs(s.nbs)) throw new Error("a NBS não está na tabela oficial");
  s.ctribmun = soDigitos(s.ctribmun || "");
  if (s.ctribmun && s.ctribmun.length !== 3) throw new Error("o código de tributação municipal tem 3 dígitos");
  s.aliquota_iss_bp = inteiro(s.aliquota_iss_bp, "alíquota do ISS", 0, 500);
  s.descricao = cortar(strip(String(s.descricao || "")), 2000);

  for (const [nome, r] of Object.entries(c.retencoes)) {
    if (!(r.quando in QUANDO_RETER)) throw new Error(`${RETENCOES[nome] || nome}: escolha quando reter`);
    r.aliquota_bp = inteiro(r.aliquota_bp, RETENCOES[nome], 0, 10000);
    r.minimo_centavos = inteiro(r.minimo_centavos, `${RETENCOES[nome]} (mínimo)`, 0);
    if ((r.quando === "tomador_pj" || r.quando === "sempre") && nome !== "iss" && !r.aliquota_bp) faltas.push(`a alíquota de ${RETENCOES[nome]}`);
  }
  if (c.regime_especial !== "0" && ["tomador_pj", "sempre"].includes(c.retencoes.iss.quando)) {
    throw new Error("com regime especial de tributação a Sefin não aceita ISS retido (regra E0588)");
  }
  if (c.opcao_simples === "2") {
    for (const nome of ["irrf", "pis", "cofins", "csll", "cp"]) {
      if (["tomador_pj", "sempre"].includes(c.retencoes[nome].quando)) throw new Error("MEI não informa tributos federais na nota (regra E0676)");
    }
  }

  const pc = c.pis_cofins;
  pc.cst = soDigitos(pc.cst || "");
  if (pc.cst && !(pc.cst in tabelas.dominio("cst_pis_cofins"))) throw new Error("o CST do PIS/COFINS não está na tabela do XSD");
  if (!pc.cst && ["pis", "cofins", "csll"].some((k) => ["tomador_pj", "sempre"].includes(c.retencoes[k].quando))) {
    faltas.push("o CST do PIS/COFINS (a nota pede quando há PIS/COFINS/CSLL retidos)");
  }

  const ib = c.ibscbs;
  ib.enviar = Boolean(ib.enviar);
  for (const [campo, tam] of [["cst", 3], ["cclasstrib", 6], ["cindop", 6]]) {
    ib[campo] = soDigitos(ib[campo] || "");
    if (ib[campo] && ib[campo].length !== tam) throw new Error(`IBS/CBS: o ${campo} tem ${tam} dígitos`);
  }
  if (ib.cindop && !tabelas.indop(ib.cindop)) throw new Error("IBS/CBS: o indicador da operação não está na tabela oficial");
  if (ib.enviar) {
    if (!ib.cst || !ib.cclasstrib) faltas.push("o CST e o cClassTrib do IBS/CBS (pergunta ao contador)");
    if (!ib.cindop) faltas.push("o indicador da operação do IBS/CBS");
  }
  ib.indfinal = String(ib.indfinal) === "1" ? "1" : "0";

  const tt = c.total_tributos;
  if (!["percentual", "simples"].includes(tt.modo)) throw new Error("total aproximado de tributos: escolha percentual ou percentual do Simples");
  for (const campo of ["federal_bp", "estadual_bp", "municipal_bp", "simples_bp"]) tt[campo] = inteiro(tt[campo], "total aproximado de tributos", 0, 10000);
  if (c.opcao_simples === "1" && tt.modo === "simples") tt.modo = "percentual";
  if (c.opcao_simples === "2" && tt.modo === "simples") tt.modo = "percentual";

  const ct = c.contador;
  ct.nome = cortar(juntarEspacos(ct.nome || ""), 120);
  ct.email = cortar(strip(String(ct.email || "")), 120);
  if (ct.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ct.email)) throw new Error("o e-mail do contador não parece um e-mail");

  const serie = soDigitos(String(c.serie || "1")).replace(/^0+/, "") || "1";
  if (!(Number(serie) >= 1 && Number(serie) <= 49999)) throw new Error("a série da DPS de aplicativo próprio vai de 1 a 49999");
  c.serie = serie;
  if (!(c.ambiente in AMBIENTES)) throw new Error("ambiente inválido");
  return { prest: c, faltas };
}
