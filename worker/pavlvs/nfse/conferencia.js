// A conferência antes de assinar (porte de conferencia.conferir, de
// paulus/legal/src/nfse/conferencia.py): as regras locais e os avisos, com
// as mesmas frases. Erro bloqueia; aviso não.
//
// O que fica de fora: o XSD oficial (validar_xsd). O Worker não tem
// validador de XML Schema; as regras que pegam o que a Sefin recusaria estão
// aqui, e o que só o XSD pegaria volta como rejeição traduzida da Sefin.

import { reais } from "./dinheiro.js";
import { INDOP_EXIGE_ENDERECO } from "./dps.js";
import * as tabelas from "./tabelas.js";
import { cnpjValido, cpfValido, documentoNormal, soDigitos, strip } from "./texto.js";

// Nome do elemento do XSD -> o que a pessoa entende.
export const CAMPOS = {
  tpAmb: "ambiente", dhEmi: "data e hora da emissão", serie: "série", nDPS: "número da DPS",
  dCompet: "competência", cLocEmi: "município do prestador", CNPJ: "CNPJ", CPF: "CPF",
  IM: "inscrição municipal", xNome: "nome do tomador", cMun: "município (IBGE)", CEP: "CEP",
  xLgr: "logradouro", nro: "número do endereço", xBairro: "bairro", email: "e-mail",
  cLocPrestacao: "município da prestação", cTribNac: "código de tributação nacional",
  cTribMun: "código de tributação municipal", xDescServ: "descrição do serviço", cNBS: "NBS",
  vServ: "valor do serviço", pAliq: "alíquota do ISS", vRetIRRF: "IRRF retido",
  vRetCSLL: "PIS/COFINS/CSLL retidos", vRetCP: "CP retida", CST: "CST", cClassTrib: "cClassTrib",
  cIndOp: "indicador da operação", xInfComp: "informações complementares",
};

/** "AAAA-MM-DD" válido -> {ano, mes, dia}; inválido -> null. */
export function lerData(texto) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(texto || ""));
  if (!m) return null;
  const [ano, mes, dia] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(Date.UTC(ano, mes - 1, dia));
  if (ano < 1 || d.getUTCFullYear() !== ano || d.getUTCMonth() !== mes - 1 || d.getUTCDate() !== dia) return null;
  return { ano, mes, dia };
}

/**
 * Devolve {erros, avisos}. `hoje`: "AAAA-MM-DD" (Brasília). `municipio`:
 * {pode_emitir, frase} ou null; `certificado`: {vencido, dias_restantes} ou
 * null; `lancamento`: {centavos} ou null; `original`: o rascunho da nota
 * substituída.
 */
export function conferir({ prest, nota, conta, municipio = null, certificado = null, lancamento = null, hoje, original = null }) {
  const erros = [...conta.erros];
  const avisos = [...conta.avisos];
  const tomador = nota.tomador || {};
  const serv = prest.servico || {};

  if (!strip(String(nota.descricao || serv.descricao || ""))) erros.push("falta a descrição do serviço");
  const comp = String(nota.competencia || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(comp)) {
    erros.push("falta a competência (data de início da prestação do serviço)");
  } else {
    const dc = lerData(comp);
    if (!dc) erros.push("competência inválida");
    else {
      const h = lerData(hoje);
      if (comp > hoje) erros.push("a competência não pode ser depois de hoje (regra E0015 da Sefin)");
      else if (dc.ano < h.ano || (dc.ano === h.ano && dc.mes < h.mes)) {
        avisos.push(`a competência é de ${comp.slice(5, 7)}/${comp.slice(0, 4)}, mês anterior ao atual: confira se o mês `
          + "já foi fechado com o contador");
      }
      const ib0 = prest.ibscbs || {};
      if (ib0.enviar && comp < "2026-01-01") erros.push("IBS/CBS só a partir da competência 01/01/2026 (regra E0850): desligue o grupo para esta nota");
    }
  }

  const doc = documentoNormal(tomador.documento);
  if (!doc) erros.push("falta o CPF ou CNPJ do tomador");
  else if (doc.length === 14 && !cnpjValido(doc)) erros.push("o CNPJ do tomador não confere (dígito verificador; regra E0188)");
  else if (doc.length === 11 && !cpfValido(doc)) erros.push("o CPF do tomador não confere (dígito verificador)");
  else if (doc.length !== 11 && doc.length !== 14) erros.push("o documento do tomador precisa ser CPF ou CNPJ");
  if (!strip(String(tomador.nome || ""))) erros.push("falta o nome do tomador");
  const temEndereco = ["logradouro", "bairro", "cep", "cmun"].every((k) => strip(String(tomador[k] || "")));
  const ib = prest.ibscbs || {};
  const exigeEnd = (ib.enviar && INDOP_EXIGE_ENDERECO.has(ib.cindop)) || conta.iss_retido;
  if (!temEndereco) {
    if (exigeEnd) {
      erros.push("falta o endereço completo do tomador (logradouro, bairro, CEP e município): "
        + (conta.iss_retido ? "o ISS retido" : `o indicador da operação ${ib.cindop}`)
        + " exige o endereço (regras E0237 / RN 255)");
    } else avisos.push("o tomador está sem endereço completo");
  }
  if (tomador.cep && !/^\d{8}$/.test(soDigitos(String(tomador.cep)))) erros.push("o CEP do tomador precisa de 8 dígitos");
  if (tomador.cmun && !tabelas.municipio(tomador.cmun)) erros.push("o município do tomador não está na tabela oficial do IBGE");
  if (tomador.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(tomador.email))) erros.push("o e-mail do tomador não parece um e-mail (regra E0247)");

  const ctribnac = nota.ctribnac || serv.ctribnac;
  if (!tabelas.servico(ctribnac || "")) erros.push("o código de tributação nacional não está na lista oficial (regra E0310)");
  const nbs = nota.nbs || serv.nbs;
  if (nbs && !tabelas.nbs(nbs)) erros.push("a NBS não está na tabela oficial (regra E0316)");
  if (ib.enviar && !nbs) erros.push("com IBS/CBS a NBS é obrigatória (regra E0322)");
  if (ib.enviar && (!ib.cst || !ib.cclasstrib)) erros.push("IBS/CBS: falta o CST e o cClassTrib na configuração (pergunte ao contador)");
  if (conta.v_ret_csll && !(prest.pis_cofins || {}).cst) erros.push("há PIS/COFINS/CSLL retidos e falta o CST do PIS/COFINS na configuração (pergunte ao contador)");
  const inc = nota.municipio_incidencia || prest.municipio;
  if (inc && !tabelas.municipio(inc)) erros.push("o município da prestação não está na tabela oficial do IBGE (regra E0302)");
  if (conta.informar_paliq && conta.aliquota_iss_bp > 500) erros.push("a alíquota do ISS não pode passar de 5% (regra E0595)");
  if (conta.informar_paliq && !conta.aliquota_iss_bp) erros.push("esta nota precisa da alíquota do ISS e ela não está configurada");
  const local = tabelas.localDeIncidencia(ctribnac || "");
  if (tomador.cmun && tomador.cmun !== prest.municipio) {
    if (local === "LP" || local === "ET") {
      avisos.push("o tomador é de outro município e, para este serviço, o ISS incide "
        + (local === "LP" ? "no local da prestação" : "no município do tomador")
        + " (LC 116): confira o município da prestação");
    } else if (local === "EP") {
      avisos.push("o tomador é de outro município; para este serviço o ISS continua no município do escritório (LC 116, art. 3º)");
    }
  }
  if (inc && inc !== prest.municipio) avisos.push("o município da prestação é diferente do município do escritório: confira a incidência do ISS");

  if (prest.opcao_simples === "2" && Object.values(conta.retencoes || {}).some((v) => v)) erros.push("MEI não informa tributos federais (regra E0676)");
  if ((prest.regime_especial ?? "0") !== "0" && conta.iss_retido) erros.push("com regime especial não há ISS retido (regra E0588)");

  if ((nota.substitui || {}).chave) {
    if (original && (prest.opcao_simples === "2" || prest.opcao_simples === "3")) {
      const o = original;
      if (documentoNormal((o.tomador || {}).documento) !== doc) erros.push("na substituição de nota do Simples Nacional o tomador não muda (regra E0061)");
      if (String(o.competencia || "") !== String(nota.competencia || "")) erros.push("na substituição de nota do Simples Nacional a competência não muda (regra E0061)");
      if (Number(o.valor_centavos || 0) !== Number(nota.valor_centavos || 0)) erros.push("na substituição de nota do Simples Nacional o valor do serviço não muda (regra E0061)");
    }
    avisos.push("esta nota substitui a de chave " + nota.substitui.chave + ": emitida, a Sefin cancela a anterior por substituição");
  }

  if (lancamento && Number(lancamento.centavos || 0) !== conta.v_serv) {
    avisos.push(`o valor da nota (${reais(conta.v_serv)}) é diferente do recebimento (${reais(Number(lancamento.centavos))})`);
  }
  if (certificado) {
    if (certificado.vencido) erros.push("o certificado da nota venceu: a Sefin recusa (regra E1203)");
    else if (certificado.dias_restantes !== undefined && certificado.dias_restantes !== null && certificado.dias_restantes <= 30) {
      avisos.push(`o certificado da nota vence em ${certificado.dias_restantes} dia(s)`);
    }
  }
  if (municipio !== null && municipio !== undefined && !municipio.pode_emitir) erros.push(municipio.frase || "o município não emite pelo Sistema Nacional");
  return { erros, avisos };
}
