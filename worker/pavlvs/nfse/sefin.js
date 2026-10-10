// A conversa com o Sistema Nacional da NFS-e (porte de cliente.py e da
// leitura do convênio de municipio.py, paulus/legal/src/nfse).
//
// A conexão sai por um `fetch` injetável (url, init) -> Response:
//   - em produção, fetchPeloMtls(env): o service binding SEFIN_MTLS, um Worker
//     auxiliar com o certificado A1 num binding mtls_certificate, que só repassa
//     à Sefin o que vem no cabeçalho x-nfse-url (worker/nfse/MTLS.md);
//   - nos testes, a Sefin simulada (worker/nfse/sefin-simulada.js).
//
// Três cuidados, como no Python:
//   - produção trancada: o cliente recusa "producao" sem a liberação registrada
//     no Durable Object (ProducaoBloqueada);
//   - sem resposta, consulta: erro de rede ou tempo esgotado vira SemResposta,
//     e quem recebe nunca reenvia às cegas (emissor.js consulta antes);
//   - nada do conteúdo vai para log.

import { gzipB64 } from "./gzip.js";

export const URLS = {
  producao_restrita: {
    sefin: "https://sefin.producaorestrita.nfse.gov.br/API/SefinNacional",
    parametros: "https://adn.producaorestrita.nfse.gov.br/parametrizacao",
    contribuintes: "https://adn.producaorestrita.nfse.gov.br/contribuintes",
  },
  producao: {
    sefin: "https://sefin.nfse.gov.br/SefinNacional",
    parametros: "https://adn.nfse.gov.br/parametrizacao",
    contribuintes: "https://adn.nfse.gov.br/contribuintes",
  },
};

export const CAMPOS = {
  dps: "dpsXmlGZipB64",
  nfse: "nfseXmlGZipB64",
  chave: "chaveAcesso",
  id_dps: "idDps",
  evento_pedido: "pedidoRegistroEventoXmlGZipB64",
  evento: "eventoXmlGZipB64",
  erros: "erros",
  alertas: "alertas",
};

export const TEMPO_RESPOSTA_MS = 60000;

export class ProducaoBloqueada extends Error {}
/** O pedido pode ter chegado e não houve resposta: consulte antes de qualquer reenvio. */
export class SemResposta extends Error {}
/** O pedido certamente não chegou (o auxiliar recusou antes de abrir a conexão). */
export class NaoChegou extends Error {}

/**
 * O fetch de produção: pelo service binding SEFIN_MTLS. O auxiliar responde
 * com `x-nfse-nao-chegou: 1` quando recusou o destino sem abrir conexão.
 */
export function fetchPeloMtls(env) {
  if (!env || !env.SEFIN_MTLS || typeof env.SEFIN_MTLS.fetch !== "function") return null;
  return (url, init = {}) => env.SEFIN_MTLS.fetch("https://interno/", {
    method: init.method || "GET",
    headers: { ...(init.headers || {}), "x-nfse-url": url },
    body: init.body,
    signal: init.signal,
  });
}

export class ClienteSefin {
  constructor({ ambiente, fetch, producaoLiberada = false, urls = null }) {
    if (!URLS[ambiente]) throw new Error("ambiente desconhecido");
    if (ambiente === "producao" && !producaoLiberada) {
      throw new ProducaoBloqueada("a produção ainda não foi liberada pelo titular (painel › Notas fiscais › Parâmetros › Produção)");
    }
    if (typeof fetch !== "function") throw new NaoChegou("sem conexão com a Sefin configurada (SEFIN_MTLS)");
    this.ambiente = ambiente;
    this.urls = { ...(urls || URLS[ambiente]) };
    this.fetch = fetch;
  }

  async pedir(metodo, servico, caminho, corpo) {
    const url = this.urls[servico].replace(/\/+$/, "") + caminho;
    const init = { method: metodo, headers: { accept: "application/json", "user-agent": "PAVLVS-nuvem" } };
    if (corpo !== undefined) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(corpo);
    }
    if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) init.signal = AbortSignal.timeout(TEMPO_RESPOSTA_MS);
    let r;
    try {
      r = await this.fetch(url, init);
    } catch (exc) {
      // Pode ter caído antes ou depois de chegar: na dúvida, é "sem resposta".
      const tempo = exc && (exc.name === "TimeoutError" || exc.name === "AbortError");
      throw new SemResposta(tempo ? "o Sistema Nacional não respondeu a tempo" : "a conexão caiu sem resposta do Sistema Nacional");
    }
    if (r.headers.get("x-nfse-nao-chegou") === "1") throw new NaoChegou("o pedido não saiu para o Sistema Nacional (auxiliar mTLS recusou)");
    let texto = "";
    try {
      texto = metodo === "HEAD" ? "" : await r.text();
    } catch {
      throw new SemResposta("a resposta do Sistema Nacional chegou pela metade");
    }
    let dados = null;
    if (texto) {
      try {
        dados = JSON.parse(texto);
      } catch {
        dados = null;
      }
    }
    const ehObjeto = dados !== null && typeof dados === "object" && !Array.isArray(dados);
    return { status: r.status, corpo: ehObjeto ? dados : null, texto: ehObjeto ? "" : texto.slice(0, 2000), ok: r.status >= 200 && r.status < 300 };
  }

  async emitir(dpsAssinada) {
    return this.pedir("POST", "sefin", "/nfse", { [CAMPOS.dps]: await gzipB64(dpsAssinada) });
  }

  consultarNfse(chave) {
    return this.pedir("GET", "sefin", `/nfse/${chave}`);
  }

  consultarDps(idDps) {
    return this.pedir("GET", "sefin", `/dps/${idDps}`);
  }

  dpsExiste(idDps) {
    return this.pedir("HEAD", "sefin", `/dps/${idDps}`);
  }

  async registrarEvento(chave, pedidoAssinado) {
    return this.pedir("POST", "sefin", `/nfse/${chave}/eventos`, { [CAMPOS.evento_pedido]: await gzipB64(pedidoAssinado) });
  }

  consultarEventos(chave, tipo = "") {
    return this.pedir("GET", "sefin", `/nfse/${chave}/eventos` + (tipo ? `/${tipo}` : ""));
  }

  parametrosConvenio(cmun) {
    return this.pedir("GET", "parametros", `/parametros_municipais/${cmun}/convenio`);
  }
}

/** O valor de um campo do corpo, sem ligar para maiúsculas no nome. */
export function campo(corpo, nome) {
  if (!corpo || typeof corpo !== "object") return undefined;
  const alvo = nome.toLowerCase();
  for (const [k, v] of Object.entries(corpo)) if (k.toLowerCase() === alvo) return v;
  return undefined;
}

/** Todos os textos que parecem XML compactado em base64 (chave terminada em b64). */
export function valoresB64(corpo) {
  const saida = [];
  if (Array.isArray(corpo)) for (const v of corpo) saida.push(...valoresB64(v));
  else if (corpo && typeof corpo === "object") {
    for (const [k, v] of Object.entries(corpo)) {
      if (typeof v === "string" && k.toLowerCase().endsWith("b64")) saida.push(v);
      else if (v && typeof v === "object") saida.push(...valoresB64(v));
    }
  }
  return saida;
}

// ------------------------------------------------- convênio do município

export const CONVENIADO = "conveniado";
export const SEM_CONVENIO = "sem_convenio";
export const INDEFINIDO = "indefinido";
export const NAO_CONSULTADO = "nao_consultado";

const semAcento = (t) => String(t).normalize("NFD").replace(/\p{Mn}/gu, "").toLowerCase();

function achatar(obj, prefixo = "", saida = {}) {
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj)) achatar(v, `${prefixo}${semAcento(k)}.`, saida);
  } else if (Array.isArray(obj)) {
    obj.slice(0, 50).forEach((v, i) => achatar(v, `${prefixo}${i}.`, saida));
  } else saida[prefixo.replace(/\.$/, "")] = obj;
  return saida;
}

function verdade(valor) {
  if (typeof valor === "boolean") return valor;
  if (valor === 0 || valor === 1) return Boolean(valor);
  const t = semAcento(valor).trim();
  if (["s", "sim", "true", "ativo", "ativa", "1", "permitido", "habilitado"].includes(t)) return true;
  if (["n", "nao", "false", "inativo", "inativa", "0", "suspenso", "suspensa", "bloqueado"].includes(t)) return false;
  return null;
}

/** A resposta do convênio em {situacao, emissor_nacional, detalhes} (municipio.interpretar). */
export function interpretarConvenio(status, corpo) {
  if (status === 404) return { situacao: SEM_CONVENIO, emissor_nacional: false, detalhes: "convênio não encontrado" };
  if (status !== 200 || !corpo || typeof corpo !== "object") {
    return { situacao: INDEFINIDO, emissor_nacional: null, detalhes: `resposta ${status} do Sistema Nacional` };
  }
  const plano = achatar(corpo);
  for (const v of Object.values(plano)) {
    if (typeof v === "string" && ["nao encontrad", "inexistente", "nao conveniad"].some((p) => semAcento(v).includes(p))) {
      return { situacao: SEM_CONVENIO, emissor_nacional: false, detalhes: v.slice(0, 200) };
    }
  }
  const negativos = [];
  let emissor = null;
  for (const [k, v] of Object.entries(plano)) {
    const ultimo = k.split(".").pop();
    const vv = verdade(v);
    if (["situacao", "ativo", "status", "aderente", "vigente"].some((p) => ultimo.includes(p))) {
      if (vv === false || (typeof v === "string" && ["inativo", "suspenso", "inativa", "suspensa"].includes(semAcento(v).trim()))) negativos.push(`${k}=${v}`);
    }
    if (ultimo.includes("emissor") || ultimo.includes("emissao") || ultimo.includes("sefin")) {
      if (vv !== null) emissor = emissor === null ? vv : emissor && vv;
    }
  }
  if (negativos.length) return { situacao: SEM_CONVENIO, emissor_nacional: false, detalhes: "convênio inativo ou suspenso (" + negativos.slice(0, 3).join(", ") + ")" };
  if (emissor === false) return { situacao: SEM_CONVENIO, emissor_nacional: false, detalhes: "o município não permite os emissores públicos nacionais" };
  return { situacao: CONVENIADO, emissor_nacional: emissor === null ? true : emissor, detalhes: "" };
}

/** O prazo de cancelamento parametrizado, se a resposta trouxer (senão null: a Sefin decide, E0822). */
export function prazoCancelamentoDias(corpo) {
  for (const [k, v] of Object.entries(achatar(corpo || {}))) {
    if (k.includes("cancel") && ["prazo", "dias", "dia"].some((p) => k.includes(p))) {
      const t = String(v).trim();
      if (!/^[+-]?\d+$/.test(t)) continue;
      const n = Number(t);
      if (n >= 0 && n <= 3650) return n;
    }
  }
  return null;
}
