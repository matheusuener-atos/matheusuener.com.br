// O pedido de registro de evento (pedRegEvento 1.01): cancelamento (e101101),
// o cancelamento por substituição (e105102) e a solicitação de análise fiscal
// para cancelamento (e101103, fora do prazo do município; o município responde
// com e105104, deferido, ou e105105, indeferido). Porte de
// eventos.Eventos._pedido_xml (paulus/legal/src/nfse/eventos.py); o XML sai
// idêntico ao do Python (worker/teste-nfse-emissor.mjs).

import { dhEmi, NS } from "./dps.js";
import { conferirCaracteres, cortar } from "./texto.js";
import { anexar, novo, serializar } from "./xml.js";

export const CANCELAMENTO = "101101";
export const POR_SUBSTITUICAO = "105102";
export const POR_OFICIO = "305101";
export const ANALISE_FISCAL = "101103";
export const ANALISE_DEFERIDA = "105104";
export const ANALISE_INDEFERIDA = "105105";
// O xDesc de cada evento: o texto fixo do XSD (tiposEventos_v1.01.xsd).
export const DESCRICOES = { [CANCELAMENTO]: "Cancelamento de NFS-e", [POR_SUBSTITUICAO]: "Cancelamento de NFS-e por Substituição",
  [ANALISE_FISCAL]: "Solicitação de Análise Fiscal para Cancelamento de NFS-e" };

function sub(pai, nome, valor) {
  const el = novo(nome);
  if (valor !== undefined && valor !== null) el.filhos.push({ tipo: "texto", texto: conferirCaracteres(String(valor)) });
  return anexar(pai, el);
}

/** {xml, id}. documento: CNPJ/CPF do autor (o prestador). */
export function montarPedidoEvento({ chave, ambiente, documento, tipo, motivo, texto = "", chaveSubstituta = "", quando, verAplic = "PAULUS" }) {
  const ident = `PRE${chave}${tipo}`;
  const raiz = novo("pedRegEvento", { decls: [["", NS]], attrs: [["versao", "1.01"]] });
  const inf = anexar(raiz, novo("infPedReg", { attrs: [["Id", ident]] }));
  sub(inf, "tpAmb", ambiente === "producao" ? "1" : "2");
  sub(inf, "verAplic", cortar(verAplic, 20));
  sub(inf, "dhEvento", dhEmi(quando || new Date()));
  sub(inf, String(documento).length === 14 ? "CNPJAutor" : "CPFAutor", documento);
  sub(inf, "chNFSe", chave);
  const ev = anexar(inf, novo(`e${tipo}`));
  sub(ev, "xDesc", DESCRICOES[tipo]);
  sub(ev, "cMotivo", motivo);
  if (texto) sub(ev, "xMotivo", cortar(texto, 255));
  if (chaveSubstituta) sub(ev, "chSubstituta", chaveSubstituta);
  return { xml: serializar(raiz), id: ident };
}
