// O emissor de NFS-e do PAVLVS na nuvem: o Durable Object EmissorNFSe.
//
// Porte de paulus/legal/src/nfse/emissao.py, numeracao.py, eventos.py e do
// que casa_nfse.py faz para as notas do PAVLVS. Uma instância só
// (idFromName("pavlvs")), com o estado em SQLite:
//
//   prestador    a configuração fiscal, uma VERSÃO por gravação (a nota
//                guarda a versão com que foi montada)
//   certificado  o certificado e a chave PKCS#8, CIFRADOS (cofre.js)
//   numeracao    o último número da DPS por ambiente e série
//   numeros_livres  os números devolvidos por nota descartada (sem buraco)
//   notas        a nota, com o estado e o que a Sefin devolveu
//   passos       cada mudança de estado, com quem e por quê
//   eventos      cancelamento (e101101) pedido pelo PAVLVS
//   municipio    a consulta do convênio (situação e prazo de cancelamento)
//   liberacao    a liberação da produção (sem ela, o cliente recusa produção)
//
// A regra que manda (emissao.py): SEM RESPOSTA, PRIMEIRO CONSULTA. Toda
// tentativa depois da primeira começa consultando a DPS na Sefin; reenviar
// só quando a consulta diz, com certeza (404), que não há nota. E0014 ("já
// existe nota para esta DPS") vira consulta, nunca segunda nota.
//
// O número é reservado e gravado na nota NA MESMA transação síncrona
// (transactionSync), sem await no meio: duas emissões ao mesmo tempo nunca
// pegam o mesmo número, e nenhum número sai sem uma nota que o registre.
// A nota descartada (rejeitada que não virou NFS-e) devolve o número.
//
// O estado é gravado ANTES de cada passo. A nota que fica sem resposta vai
// para a fila (na_fila / aguardando_confirmacao) com espera crescente, e o
// alarme do DO tenta de novo, sempre consultando antes.

import { assinar, b64, importarChave } from "./assinatura.js";
import { conferirPar } from "./certificado.js";
import { cifrar, decifrar, derDoPem } from "./cofre.js";
import { conferir, CAMPOS as NOMES_CAMPOS } from "./conferencia.js";
import { centavosDeTexto, centavosDoXml, reais } from "./dinheiro.js";
import { hojeBrasilia, montarDps } from "./dps.js";
import { ANALISE_DEFERIDA, ANALISE_FISCAL, ANALISE_INDEFERIDA, CANCELAMENTO, montarPedidoEvento, POR_OFICIO, POR_SUBSTITUICAO } from "./eventos.js";
import { deGzipB64 } from "./gzip.js";
import { AMBIENTES, conferirPrestador, fundir, padrao, QUANDO_RETER, RETENCOES } from "./prestador.js";
import {
  CAMPOS, ClienteSefin, campo, CONVENIADO, fetchPeloMtls, INDEFINIDO, interpretarConvenio, NAO_CONSULTADO, NaoChegou,
  prazoCancelamentoDias, ProducaoBloqueada, SEM_CONVENIO, SemResposta, valoresB64,
} from "./sefin.js";
import * as tabelas from "./tabelas.js";
import { calcular } from "./tributos.js";
import { juntarEspacos, soDigitos, strip, tamanho } from "./texto.js";
import { lerXml } from "./xml.js";
import { avisarNotaCancelada, guardarNotaDoCliente, marcarPagamento } from "../nfse-casa.js";

export const VER_APLIC = "PAVLVS-nuvem";
export const ORIGEM = "pavlvs";

export const RASCUNHO = "rascunho";
export const ASSINADA = "assinada";
export const ENVIANDO = "enviando";
export const AGUARDANDO_CONFIRMACAO = "aguardando_confirmacao";
export const NA_FILA = "na_fila";
export const EMITIDA = "emitida";
export const REJEITADA = "rejeitada";
export const CANCELADA = "cancelada";
export const SUBSTITUIDA = "substituida";
export const DESCARTADA = "descartada";

export const ESTADOS = {
  rascunho: "Rascunho", assinada: "Assinada", enviando: "Enviando", aguardando_confirmacao: "Aguardando confirmação",
  na_fila: "Na fila de envio", emitida: "Emitida", rejeitada: "Rejeitada", cancelada: "Cancelada",
  substituida: "Substituída", descartada: "Descartada",
};

// Estados do evento (eventos.py).
const EV_PEDIDO = "pedido";
const EV_ENVIANDO = "enviando";
const EV_CONFIRMANDO = "aguardando_confirmacao";
const EV_REGISTRADO = "registrado";
const EV_REJEITADO = "rejeitado";

// Espera crescente entre tentativas, em minutos (fica no último).
export const ESPERAS_MIN = [1, 2, 5, 10, 20, 40, 60];
// "Enviando" sem dono há mais que isto: o pedido caiu no meio (o DO foi
// reiniciado). A fila consulta antes de qualquer reenvio.
const ENVIANDO_PARADO_MS = 2 * 60 * 1000;
const JA_EXISTE = new Set(["E0014"]);
const CAMPOS_TOMADOR = ["nome", "documento", "logradouro", "numero", "complemento", "bairro", "cep", "cmun", "uf",
  "inscricao_municipal", "email", "telefone"];

/* O texto da nota pelo tipo do pagamento da nuvem (worker/ia.js, anotarPagamento). */
export function descricaoDoPagamento(tipo) {
  return {
    mensalidade: "Assinatura do PAULUS — plano mensal",
    anual: "Assinatura do PAULUS — plano anual",
    "mês avulso": "Assinatura do PAULUS — um mês, sem renovação",
  }[tipo] || "Recarga de uso do PAULUS (nuvem)";
}

export class ErroEmissor extends Error {
  constructor(mensagem, status = 400, extra = {}) {
    super(mensagem);
    this.status = status;
    this.extra = extra;
  }
}

const utf8 = new TextEncoder();
const json = (v) => JSON.stringify(v);
const lerJson = (t, padrao) => {
  try {
    const v = t ? JSON.parse(t) : padrao;
    return v ?? padrao;
  } catch {
    return padrao;
  }
};

async function sha256(texto) {
  const h = await crypto.subtle.digest("SHA-256", typeof texto === "string" ? utf8.encode(texto) : texto);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Código + frase simples + o campo (emissao.frase_da_rejeicao). */
export function fraseDaRejeicao(codigo, descricao = "", complemento = "") {
  const r = tabelas.regra(codigo) || {};
  const oficial = r.mensagem || descricao || "rejeição sem descrição";
  const campoXsd = r.campo || "";
  const rotulo = NOMES_CAMPOS[campoXsd] ?? campoXsd;
  let frase = oficial.endsWith(".") ? oficial : oficial + ".";
  if (rotulo) frase += ` Campo: ${rotulo}.`;
  if (complemento) frase += ` (${String(complemento).slice(0, 200)})`;
  return { codigo, descricao: descricao || oficial, frase, campo: campoXsd };
}

/** A lista `erros` da Sefin, tolerante a maiúsculas no nome dos campos. */
export function errosDaResposta(corpo, texto = "") {
  let brutos = [];
  if (corpo && typeof corpo === "object") {
    for (const [k, v] of Object.entries(corpo)) {
      if (["erros", "erro", "errors"].includes(k.toLowerCase()) && Array.isArray(v)) { brutos = v; break; }
    }
  }
  const saida = [];
  for (const e of brutos) {
    if (!e || typeof e !== "object") continue;
    const low = Object.fromEntries(Object.entries(e).map(([k, v]) => [k.toLowerCase(), v]));
    saida.push(fraseDaRejeicao(String(low.codigo || low.code || ""), String(low.descricao || low.mensagem || ""), String(low.complemento || "")));
  }
  if (!saida.length && texto) saida.push({ codigo: "", descricao: texto.slice(0, 300), frase: texto.slice(0, 300), campo: "" });
  return saida;
}

// ------------------------------------------------------------ NFS-e

function filho(el, nome) {
  if (!el) return null;
  for (const f of el.filhos) {
    if (f.tipo === "el" && f.nome.replace(/^.*:/, "") === nome) return f;
  }
  return null;
}

function caminho(el, ...nomes) {
  let e = el;
  for (const n of nomes) e = filho(e, n);
  return e;
}

function textoDe(el) {
  if (!el) return "";
  return el.filhos.filter((f) => f.tipo === "texto").map((f) => f.texto).join("").trim();
}

/** O que a nota emitida diz (emissao.ler_nfse). */
export function lerNfse(xml) {
  const { raiz } = lerXml(xml);
  const inf = filho(raiz, "infNFSe");
  if (!inf) throw new Error("o XML devolvido não é uma NFS-e");
  const ident = (inf.attrs.find(([n]) => n === "Id") || [])[1] || "";
  const t = (...c) => textoDe(caminho(inf, ...c));
  const cent = (...c) => {
    const v = t(...c);
    return v ? centavosDoXml(v) : 0;
  };
  const infDps = caminho(inf, "DPS", "infDPS");
  return {
    chave: ident.startsWith("NFS") ? ident.slice(3) : ident,
    numero_nfse: t("nNFSe"),
    dh_proc: t("dhProc"),
    id_dps: infDps ? ((infDps.attrs.find(([n]) => n === "Id") || [])[1] || "") : "",
    valores: {
      v_bc: cent("valores", "vBC"), p_aliq_aplic: t("valores", "pAliqAplic"), v_issqn: cent("valores", "vISSQN"),
      v_total_ret: cent("valores", "vTotalRet"), v_liq: cent("valores", "vLiq"),
    },
    ibscbs: {
      v_bc: cent("IBSCBS", "valores", "vBC"), v_ibs: cent("IBSCBS", "totCIBS", "gIBS", "vIBSTot"),
      v_cbs: cent("IBSCBS", "totCIBS", "gCBS", "vCBS"), v_tot_nf: cent("IBSCBS", "totCIBS", "vTotNF"),
    },
  };
}

// ------------------------------------------------------------ rascunho

/** O pedido de emissão vira o rascunho (o _limpar de notas.py). */
export function limparRascunho(dados, anterior = {}, hoje = hojeBrasilia()) {
  const r = structuredClone(anterior || {});
  const tom = { ...(r.tomador || {}) };
  const novoTom = dados.tomador || {};
  for (const k of CAMPOS_TOMADOR) if (k in novoTom) tom[k] = juntarEspacos(String(novoTom[k] || ""));
  tom.documento = String(tom.documento || "").replace(/[^0-9A-Za-z]/g, "").toUpperCase();
  tom.cep = soDigitos(tom.cep || "");
  tom.cmun = soDigitos(tom.cmun || "");
  if (tom.cmun) tom.uf = (tabelas.municipio(tom.cmun) || {}).uf ?? tom.uf ?? "";
  r.tomador = tom;
  if ("valor_centavos" in dados) r.valor_centavos = centavosDeTexto(Math.trunc(Number(dados.valor_centavos)));
  else if ("valor" in dados) {
    const v = dados.valor;
    // O painel manda reais como número (300); a tela, texto ("1.234,56").
    r.valor_centavos = typeof v === "number" ? centavosDeTexto(v.toFixed(2).replace(".", ",")) : centavosDeTexto(v);
  }
  if ("desconto" in dados) r.desconto_incond_centavos = centavosDeTexto(dados.desconto);
  for (const k of ["descricao", "competencia", "ctribnac", "nbs", "ctribmun", "municipio_incidencia", "informacoes"]) {
    if (k in dados) r[k] = strip(String(dados[k] ?? ""));
  }
  for (const k of ["ctribnac", "nbs", "ctribmun", "municipio_incidencia"]) if (r[k]) r[k] = soDigitos(r[k]);
  if (/^\d{4}-\d{2}$/.test(r.competencia || "")) r.competencia += "-01";
  if (!r.competencia) r.competencia = hoje;
  if ("substitui" in dados) r.substitui = dados.substitui;
  r.valor_centavos ??= 0;
  r.desconto_incond_centavos ??= 0;
  return r;
}

// ------------------------------------------------------------ o DO

export class EmissorNFSe {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env || {};
    this.sql = ctx.storage.sql;
    this.ocupadas = new Set();
    this.chaveAberta = null;
    this.agora = () => new Date();
    // Os testes trocam (Sefin simulada); em produção é o service binding SEFIN_MTLS.
    this.fetchSefin = null;
    this.criarTabelas();
  }

  criarTabelas() {
    for (const q of [
      `CREATE TABLE IF NOT EXISTS prestador (id INTEGER PRIMARY KEY AUTOINCREMENT, dados TEXT NOT NULL,
        criado_em TEXT, criado_por TEXT, motivo TEXT)`,
      `CREATE TABLE IF NOT EXISTS certificado (id INTEGER PRIMARY KEY AUTOINCREMENT, cert_cifrado TEXT NOT NULL,
        chave_cifrada TEXT NOT NULL, titular TEXT, documento TEXT, valido_de TEXT, valido_ate TEXT, algoritmo TEXT,
        criado_em TEXT, criado_por TEXT, ativo INTEGER DEFAULT 1)`,
      `CREATE TABLE IF NOT EXISTS numeracao (ambiente TEXT NOT NULL, serie TEXT NOT NULL, ultimo INTEGER NOT NULL,
        PRIMARY KEY (ambiente, serie))`,
      `CREATE TABLE IF NOT EXISTS numeros_livres (ambiente TEXT NOT NULL, serie TEXT NOT NULL, numero INTEGER NOT NULL,
        devolvido_por INTEGER, PRIMARY KEY (ambiente, serie, numero))`,
      `CREATE TABLE IF NOT EXISTS notas (id INTEGER PRIMARY KEY AUTOINCREMENT, estado TEXT NOT NULL, ambiente TEXT NOT NULL,
        origem TEXT, conta TEXT DEFAULT '', pagamento TEXT DEFAULT '', prestador_versao INTEGER, rascunho TEXT,
        calculo TEXT, avisos TEXT, centavos INTEGER DEFAULT 0, competencia TEXT DEFAULT '', tomador_nome TEXT DEFAULT '',
        serie TEXT, numero INTEGER, id_dps TEXT, dh_emi TEXT, xml_dps TEXT, hash_enviado TEXT, chave TEXT, numero_nfse TEXT,
        dh_proc TEXT, xml_nfse TEXT, hash_recebido TEXT, sefin TEXT, rejeicao TEXT, ultimo_erro TEXT DEFAULT '',
        tentativas INTEGER DEFAULT 0, esperas INTEGER DEFAULT 0, proxima_tentativa TEXT DEFAULT '', substitui_id INTEGER,
        substituida_por_id INTEGER, cliente_avisado TEXT DEFAULT '', pdf_em TEXT DEFAULT '', email TEXT DEFAULT '',
        criado_por TEXT, criado_em TEXT, atualizado_em TEXT)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS notas_dps ON notas (ambiente, id_dps) WHERE id_dps IS NOT NULL`,
      // Um pagamento, uma nota (a substituta herda o pagamento; cancelada libera).
      `CREATE UNIQUE INDEX IF NOT EXISTS notas_pagamento ON notas (pagamento)
        WHERE pagamento <> '' AND substitui_id IS NULL AND estado NOT IN ('descartada', 'cancelada')`,
      `CREATE TABLE IF NOT EXISTS passos (id INTEGER PRIMARY KEY AUTOINCREMENT, nota_id INTEGER, evento_id INTEGER,
        quando TEXT, de TEXT, para TEXT, quem TEXT, detalhe TEXT)`,
      `CREATE TABLE IF NOT EXISTS eventos (id INTEGER PRIMARY KEY AUTOINCREMENT, nota_id INTEGER NOT NULL, tipo TEXT NOT NULL,
        estado TEXT NOT NULL, motivo TEXT, texto TEXT, pedido_por TEXT, xml_pedido TEXT, xml_evento TEXT, rejeicao TEXT,
        ultimo_erro TEXT DEFAULT '', tentativas INTEGER DEFAULT 0, criado_em TEXT, atualizado_em TEXT)`,
      `CREATE TABLE IF NOT EXISTS municipio (cmun TEXT NOT NULL, ambiente TEXT NOT NULL, situacao TEXT, detalhes TEXT,
        resposta TEXT, prazo_cancelamento_dias INTEGER, consultado_em TEXT, PRIMARY KEY (cmun, ambiente))`,
      `CREATE TABLE IF NOT EXISTS liberacao (id INTEGER PRIMARY KEY AUTOINCREMENT, liberado_em TEXT, liberado_por TEXT,
        testes INTEGER, revogado_em TEXT, revogado_por TEXT)`,
    ]) this.sql.exec(q);
  }

  // ------------------------------------------------------------ SQL

  todos(q, ...b) {
    return this.sql.exec(q, ...b.map((v) => (v === undefined ? null : v))).toArray();
  }

  um(q, ...b) {
    return this.todos(q, ...b)[0] || null;
  }

  rodar(q, ...b) {
    this.todos(q, ...b);
  }

  agoraIso() {
    return this.agora().toISOString();
  }

  // -------------------------------------------------------- configuração

  prestadorAtual() {
    const l = this.um("SELECT * FROM prestador ORDER BY id DESC LIMIT 1");
    if (!l) return { id: 0, dados: padrao(), criado_em: "", criado_por: "" };
    return { ...l, dados: fundir(padrao(), lerJson(l.dados, {})) };
  }

  prestadorVersao(id) {
    const l = this.um("SELECT * FROM prestador WHERE id = ?", id);
    return l ? { ...l, dados: fundir(padrao(), lerJson(l.dados, {})) } : null;
  }

  faltas() {
    try {
      return conferirPrestador(this.prestadorAtual().dados).faltas;
    } catch (e) {
      return [e.message];
    }
  }

  /** Grava uma versão nova (se algo mudou). O ambiente só muda pela liberação. */
  configurar({ prestador, quem = "", motivo = "" }) {
    const atual = this.prestadorAtual();
    const novo = { ...(prestador || {}) };
    delete novo.ambiente;
    delete novo.revisado_por;
    delete novo.revisado_em;
    let limpo;
    let faltas;
    try {
      ({ prest: limpo, faltas } = conferirPrestador(fundir(atual.dados, novo)));
    } catch (e) {
      throw new ErroEmissor(e.message);
    }
    if (atual.id && json(limpo) === json(atual.dados)) return { versao: atual.id, mudou: false, faltas, prestador: atual.dados };
    const id = this.gravarVersao(limpo, quem, motivo || "configuração");
    return { versao: id, mudou: true, faltas, prestador: limpo };
  }

  gravarVersao(dados, quem, motivo) {
    return this.um("INSERT INTO prestador (dados, criado_em, criado_por, motivo) VALUES (?,?,?,?) RETURNING id",
      json(dados), this.agoraIso(), quem, motivo).id;
  }

  ambiente() {
    return this.prestadorAtual().dados.ambiente || "producao_restrita";
  }

  // -------------------------------------------------------- certificado

  certificadoAtivo() {
    return this.um("SELECT * FROM certificado WHERE ativo = 1 ORDER BY id DESC LIMIT 1");
  }

  certificadoParaTela() {
    const c = this.certificadoAtivo();
    if (!c) return { instalado: false };
    const restam = Math.floor((Date.parse(c.valido_ate) - this.agora().getTime()) / 86400000);
    return { instalado: true, titular: c.titular, documento: c.documento, valido_ate: c.valido_ate, algoritmo: c.algoritmo,
      vencido: restam < 0, dias_restantes: restam, instalado_em: c.criado_em };
  }

  /**
   * Guarda o certificado e a chave já abertos (o .pfx é aberto fora, no
   * navegador, site/assets/nfse-pfx.js, ou pelo lerPfx). Confere que a chave é a do certificado;
   * a validade sai do próprio certificado. Os dois vão cifrados.
   */
  async guardarCertificado({ certificado, chave, titular = "", documento = "", algoritmo = "sha1", quem = "" }) {
    if (!["sha1", "sha256"].includes(algoritmo)) throw new ErroEmissor("algoritmo de assinatura: sha1 ou sha256");
    let certDer;
    let chaveDer;
    let validade;
    try {
      certDer = derDoPem(certificado, ["CERTIFICATE"]);
      chaveDer = derDoPem(chave, ["PRIVATE KEY"]);
      validade = await conferirPar(certDer, chaveDer, algoritmo);
    } catch (e) {
      throw new ErroEmissor(e.message);
    }
    const doc = soDigitos(documento);
    const certCifrado = await cifrar(this.env, certDer, "certificado");
    const chaveCifrada = await cifrar(this.env, chaveDer, "chave");
    this.ctx.storage.transactionSync(() => {
      this.rodar("UPDATE certificado SET ativo = 0 WHERE ativo = 1");
      this.rodar(`INSERT INTO certificado (cert_cifrado, chave_cifrada, titular, documento, valido_de, valido_ate, algoritmo,
        criado_em, criado_por, ativo) VALUES (?,?,?,?,?,?,?,?,?,1)`, certCifrado, chaveCifrada, juntarEspacos(titular).slice(0, 200),
      doc, validade.validoDe, validade.validoAte, algoritmo, this.agoraIso(), quem);
    });
    this.chaveAberta = null;
    // O documento e o nome do certificado preenchem a configuração, se vazios.
    const atual = this.prestadorAtual();
    if (doc && !atual.dados.documento) this.configurar({ prestador: { documento: doc, razao_social: atual.dados.razao_social || titular }, quem, motivo: "do certificado" });
    return this.certificadoParaTela();
  }

  /** A chave e o certificado prontos para assinar (decifrados com a NFSE_CHAVE_MESTRA). */
  async abrirChave() {
    const c = this.certificadoAtivo();
    if (!c) throw new ErroEmissor("falta o certificado A1 da nota", 409);
    if (this.chaveAberta && this.chaveAberta.id === c.id) return this.chaveAberta;
    this.chaveAberta = { id: c.id, ...(await abrirChave(this.env, c)) };
    return this.chaveAberta;
  }

  // ------------------------------------------------------------ município

  situacaoMunicipio(ambiente = this.ambiente()) {
    const cmun = this.prestadorAtual().dados.municipio || "";
    const u = cmun ? this.um("SELECT * FROM municipio WHERE cmun = ? AND ambiente = ?", cmun, ambiente) : null;
    if (!u) return { situacao: NAO_CONSULTADO, frase: fraseMunicipio(cmun, NAO_CONSULTADO), pode_emitir: false, prazo_cancelamento_dias: null, consultado_em: "" };
    return { situacao: u.situacao, frase: fraseMunicipio(cmun, u.situacao, u.detalhes), pode_emitir: u.situacao === CONVENIADO,
      prazo_cancelamento_dias: u.prazo_cancelamento_dias, consultado_em: u.consultado_em, detalhes: u.detalhes || "" };
  }

  producaoLiberada() {
    return Boolean(this.um("SELECT id FROM liberacao WHERE revogado_em IS NULL ORDER BY id DESC LIMIT 1"));
  }

  cliente(ambiente) {
    const fetch = this.fetchSefin || fetchPeloMtls(this.env);
    return new ClienteSefin({ ambiente, fetch, producaoLiberada: this.producaoLiberada() });
  }

  /** Testar comunicação: pergunta o convênio do município à Sefin e guarda. */
  async testar() {
    const cmun = this.prestadorAtual().dados.municipio || "";
    if (!cmun) throw new ErroEmissor("escolha primeiro o município do prestador");
    const ambiente = this.ambiente();
    const inicio = Date.now();
    let info;
    let corpo = null;
    let status = 0;
    try {
      const r = await this.cliente(ambiente).parametrosConvenio(cmun);
      status = r.status;
      info = interpretarConvenio(r.status, r.corpo);
      corpo = r.corpo;
    } catch (e) {
      if (e instanceof ProducaoBloqueada) throw new ErroEmissor(e.message, 403);
      if (!(e instanceof SemResposta || e instanceof NaoChegou)) throw e;
      info = { situacao: INDEFINIDO, emissor_nacional: null, detalhes: e.message };
    }
    const prazo = prazoCancelamentoDias(corpo);
    this.rodar(`INSERT INTO municipio (cmun, ambiente, situacao, detalhes, resposta, prazo_cancelamento_dias, consultado_em)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT (cmun, ambiente) DO UPDATE SET situacao = excluded.situacao, detalhes = excluded.detalhes,
      resposta = excluded.resposta, prazo_cancelamento_dias = excluded.prazo_cancelamento_dias, consultado_em = excluded.consultado_em`,
    cmun, ambiente, info.situacao, info.detalhes || "", json(corpo), prazo, this.agoraIso());
    return { ambiente, status, ms: Date.now() - inicio, municipio: this.situacaoMunicipio(ambiente) };
  }

  // ------------------------------------------------------------ situação

  podeEmitir() {
    const motivos = this.faltas().map((f) => `falta ${f}`);
    const cert = this.certificadoParaTela();
    if (!cert.instalado) motivos.push("falta o certificado A1 da nota");
    else {
      if (cert.vencido) motivos.push("o certificado da nota venceu");
      const doc = this.prestadorAtual().dados.documento;
      if (cert.documento && doc && cert.documento !== doc) motivos.push("o certificado é de outro CPF/CNPJ que o do prestador");
    }
    if (!this.env.NFSE_CHAVE_MESTRA) motivos.push("falta o segredo NFSE_CHAVE_MESTRA no Worker");
    const mun = this.situacaoMunicipio();
    if (!mun.pode_emitir) motivos.push(mun.frase);
    if (this.ambiente() === "producao" && !this.producaoLiberada()) motivos.push("a produção não está liberada");
    return { pode: motivos.length === 0, motivos };
  }

  situacao() {
    const p = this.prestadorAtual();
    const { pode, motivos } = this.podeEmitir();
    const ambiente = p.dados.ambiente;
    const serie = p.dados.serie || "1";
    return {
      ambiente, ambiente_rotulo: AMBIENTES[ambiente] || "", producao_liberada: this.producaoLiberada(),
      prestador: { versao: p.id, dados: p.dados, faltas: this.faltas() }, certificado: this.certificadoParaTela(),
      municipio: this.situacaoMunicipio(), pode_emitir: pode, motivos, proximo_numero: this.proximoNumero(ambiente, serie),
      tabelas: tabelas.versoes(), opcoes: opcoesDaTela(),
    };
  }

  // ------------------------------------------------------------ numeração

  /** Dentro de transactionSync: o menor devolvido, ou o último + 1. */
  reservarNumero(ambiente, serie) {
    const s = String(Number(serie));
    const livre = this.um("SELECT numero FROM numeros_livres WHERE ambiente = ? AND serie = ? ORDER BY numero LIMIT 1", ambiente, s);
    if (livre) {
      this.rodar("DELETE FROM numeros_livres WHERE ambiente = ? AND serie = ? AND numero = ?", ambiente, s, livre.numero);
      return Number(livre.numero);
    }
    this.rodar("INSERT OR IGNORE INTO numeracao (ambiente, serie, ultimo) VALUES (?, ?, 0)", ambiente, s);
    return Number(this.um("UPDATE numeracao SET ultimo = ultimo + 1 WHERE ambiente = ? AND serie = ? RETURNING ultimo", ambiente, s).ultimo);
  }

  proximoNumero(ambiente, serie) {
    const s = String(Number(serie));
    const livre = this.um("SELECT MIN(numero) AS n FROM numeros_livres WHERE ambiente = ? AND serie = ?", ambiente, s);
    if (livre && livre.n) return Number(livre.n);
    const l = this.um("SELECT ultimo FROM numeracao WHERE ambiente = ? AND serie = ?", ambiente, s);
    return (l ? Number(l.ultimo) : 0) + 1;
  }

  // ------------------------------------------------------------ notas

  ler(l) {
    if (!l) return null;
    const n = { ...l };
    n.rascunho = lerJson(l.rascunho, {});
    n.calculo = lerJson(l.calculo, {});
    n.avisos = lerJson(l.avisos, []);
    n.rejeicao = lerJson(l.rejeicao, []);
    n.sefin = lerJson(l.sefin, null);
    n.estado_rotulo = ESTADOS[n.estado] || n.estado;
    n.valor = reais(Number(n.centavos || 0));
    return n;
  }

  obter(id) {
    return this.ler(this.um("SELECT * FROM notas WHERE id = ?", Number(id)));
  }

  exigir(id) {
    const n = this.obter(id);
    if (!n) throw new ErroEmissor("essa nota não existe", 404);
    return n;
  }

  passo(notaId, de, para, quem = "", detalhe = "", eventoId = null) {
    this.rodar("INSERT INTO passos (nota_id, evento_id, quando, de, para, quem, detalhe) VALUES (?,?,?,?,?,?,?)",
      notaId, eventoId, this.agoraIso(), de, para, quem, String(detalhe).slice(0, 2000));
  }

  /** Grava o estado (e os campos) ANTES do passo seguinte. */
  mudarEstado(id, para, quem = "", detalhe = "", campos = {}) {
    const atual = this.um("SELECT estado FROM notas WHERE id = ?", id);
    const sets = ["estado = ?", "atualizado_em = ?"];
    const valores = [para, this.agoraIso()];
    for (const [k, v] of Object.entries(campos)) {
      sets.push(`${k} = ?`);
      valores.push(v !== null && typeof v === "object" ? json(v) : v);
    }
    this.ctx.storage.transactionSync(() => {
      this.rodar(`UPDATE notas SET ${sets.join(", ")} WHERE id = ?`, ...valores, id);
      this.passo(id, atual ? atual.estado : "", para, quem, detalhe);
    });
    return this.obter(id);
  }

  paraTela(n) {
    if (!n) return null;
    const r = n.rascunho || {};
    const t = r.tomador || {};
    return {
      id: n.id, estado: n.estado, estado_rotulo: n.estado_rotulo, ambiente: n.ambiente, conta: n.conta, pagamento: n.pagamento,
      numero: n.numero_nfse || "", chave: n.chave || "", serie: n.serie, numero_dps: n.numero, id_dps: n.id_dps || "",
      cliente: t.nome || n.tomador_nome || "", documento: t.documento || "", tomador: t, valor: n.valor, centavos: n.centavos,
      competencia: (r.competencia || "").slice(0, 7), descricao: r.descricao || "", quando: n.dh_proc || n.atualizado_em || "",
      erro: n.ultimo_erro || "", rejeicao: n.rejeicao, avisos: n.avisos, tentativas: n.tentativas,
      proxima_tentativa: n.proxima_tentativa || "", substitui_id: n.substitui_id, substituida_por_id: n.substituida_por_id,
      cliente_avisado: n.cliente_avisado || "", pdf_em: n.pdf_em || "", tem_pdf: Boolean(n.pdf_em), email: n.email || "", sefin: n.sefin,
    };
  }

  listar({ estado = "", limite = 300 } = {}) {
    const lim = Math.max(1, Math.min(1000, Number(limite) || 300));
    const linhas = estado
      ? this.todos("SELECT * FROM notas WHERE estado = ? ORDER BY id DESC LIMIT ?", estado, lim)
      : this.todos("SELECT * FROM notas ORDER BY id DESC LIMIT ?", lim);
    return linhas.map((l) => this.paraTela(this.ler(l)));
  }

  detalhe(id) {
    const n = this.exigir(id);
    return {
      nota: this.paraTela(n),
      passos: this.todos("SELECT quando, de, para, quem, detalhe, evento_id FROM passos WHERE nota_id = ? ORDER BY id", n.id),
      eventos: this.todos("SELECT id, tipo, estado, motivo, texto, ultimo_erro, rejeicao, tentativas, criado_em, atualizado_em FROM eventos WHERE nota_id = ? ORDER BY id", n.id)
        .map((e) => ({ ...e, rejeicao: lerJson(e.rejeicao, []) })),
    };
  }

  xml(id, tipo = "nfse") {
    const n = this.exigir(id);
    const x = tipo === "dps" ? n.xml_dps : n.xml_nfse;
    if (!x) throw new ErroEmissor(tipo === "dps" ? "a nota ainda não tem DPS" : "a nota ainda não foi emitida", 404);
    return { xml: x, nome: `${tipo === "dps" ? n.id_dps : "NFS-e " + (n.numero_nfse || n.id)}.xml` };
  }

  async pagamento(id) {
    if (!id || !this.env.APOIOS) return null;
    try {
      const v = await this.env.APOIOS.get("admin:nfse:" + id);
      return v ? JSON.parse(v) : null;
    } catch {
      return null;
    }
  }

  /** A conta, a conferência e a prévia: {prest, conta, erros, avisos}. */
  conferirRascunho(prestVersao, rascunho, { original = null, lancamento = null } = {}) {
    const prest = prestVersao.dados;
    const mun = this.situacaoMunicipio(prest.ambiente);
    const conta = calcular(prest, rascunho, { municipioAtivo: mun.situacao === CONVENIADO });
    const cert = this.certificadoParaTela();
    const { erros, avisos } = conferir({ prest, nota: rascunho, conta, municipio: mun, hoje: hojeBrasilia(this.agora()),
      certificado: cert.instalado ? cert : null, lancamento, original });
    const faltas = this.faltas().map((f) => `configuração: falta ${f}`);
    return { prest, conta, erros: [...faltas, ...erros], avisos };
  }

  // ------------------------------------------------------------ emitir

  /**
   * {conta?, pagamento?, tomador, valor | valor_centavos, descricao, competencia, quem}.
   * Cria, confere, reserva o número, assina e envia. Devolve a nota.
   */
  async emitir(d, { substituiId = null } = {}) {
    const quem = String(d.quem || "PAVLVS");
    const { pode, motivos } = this.podeEmitir();
    if (!pode) throw new ErroEmissor("ainda não dá para emitir: " + motivos.slice(0, 4).join("; "), 409, { motivos });
    const conta = String(d.conta || "");
    if (conta && !/^[0-9a-f]{24}$/.test(conta)) throw new ErroEmissor("conta inválida");
    const pagamento = String(d.pagamento || "").slice(0, 80);
    if (pagamento && !substituiId && this.um("SELECT id FROM notas WHERE pagamento = ? AND substitui_id IS NULL AND estado NOT IN ('descartada','cancelada')", pagamento)) {
      throw new ErroEmissor("este pagamento já tem nota", 409);
    }
    // O pagamento completa o que faltar (não na substituta: ela parte da original).
    const pag = pagamento && !substituiId ? await this.pagamento(pagamento) : null;
    const dados = { ...d };
    if (pag && !("valor" in dados) && !("valor_centavos" in dados) && pag.valor !== undefined) dados.valor = Number(pag.valor);
    if (pag && !dados.descricao) dados.descricao = descricaoDoPagamento(pag.tipo);
    if (pag && !dados.competencia && pag.quando) dados.competencia = String(pag.quando).slice(0, 7) + "-01";
    const p = this.prestadorAtual();
    let rascunho;
    try {
      rascunho = limparRascunho(dados, d.base || {}, hojeBrasilia(this.agora()));
    } catch (e) {
      throw new ErroEmissor(e.message);
    }
    const original = substituiId ? this.obter(substituiId).rascunho : null;
    const lancamento = pag && pag.valor !== undefined ? { centavos: Math.round(Number(pag.valor) * 100) } : null;
    const { prest, conta: calc, erros, avisos } = this.conferirRascunho(p, rascunho, { original, lancamento });
    if (erros.length) throw new ErroEmissor("a nota não passou na conferência: " + erros.slice(0, 4).join("; "), 400, { erros, avisos });
    // A chave abre ANTES de reservar: se a mestra falhar, nenhum número sai.
    await this.abrirChave();
    const ambiente = prest.ambiente;
    const serie = prest.serie || "1";
    const quando = this.agora();
    const id = this.ctx.storage.transactionSync(() => {
      const agora = this.agoraIso();
      const nova = this.um(`INSERT INTO notas (estado, ambiente, origem, conta, pagamento, prestador_versao, rascunho, calculo,
        avisos, centavos, competencia, tomador_nome, substitui_id, criado_por, criado_em, atualizado_em)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`, RASCUNHO, ambiente, ORIGEM, conta, pagamento, p.id, json(rascunho),
      json(calc), json(avisos), rascunho.valor_centavos, rascunho.competencia, rascunho.tomador.nome || "", substituiId, quem, agora, agora).id;
      const numero = this.reservarNumero(ambiente, serie);
      const { xml, id: idDps } = montarDps({ prest, nota: rascunho, conta: calc, ambiente, serie, numero, quando, verAplic: VER_APLIC });
      this.rodar("UPDATE notas SET serie = ?, numero = ?, id_dps = ?, dh_emi = ?, xml_dps = ? WHERE id = ?",
        String(Number(serie)), numero, idDps, xml.match(/<dhEmi>([^<]*)</)[1], xml, nova);
      this.passo(nova, "", RASCUNHO, quem, `nota criada (${ORIGEM}); DPS ${idDps}, número ${numero} reservado`);
      return nova;
    });
    return this.comNota(id, () => this.assinarEEnviar(id, quem));
  }

  async comNota(id, fn) {
    if (this.ocupadas.has(id)) throw new ErroEmissor("esta nota já está em andamento; consulte de novo em instantes", 409);
    this.ocupadas.add(id);
    try {
      return await fn();
    } finally {
      this.ocupadas.delete(id);
    }
  }

  conferirAmbiente(nota) {
    if (nota.ambiente === "producao" && !this.producaoLiberada()) throw new ErroEmissor("a produção ainda não foi liberada pelo titular", 403);
  }

  async assinarEEnviar(id, quem) {
    let nota = this.obter(id);
    this.conferirAmbiente(nota);
    if (nota.estado === RASCUNHO) {
      const { chave, certDer, algoritmo } = await this.abrirChave();
      const assinado = await assinar(nota.xml_dps, chave, certDer, nota.id_dps, algoritmo);
      nota = this.mudarEstado(id, ASSINADA, quem, `assinada; DPS ${nota.id_dps}`, { xml_dps: assinado, hash_enviado: await sha256(assinado) });
    }
    return this.emitirNota(nota, quem);
  }

  /** A nota assinada (ou na fila) até emitida, rejeitada ou na fila. Já houve tentativa: consulta antes. */
  async emitirNota(nota, quem) {
    this.conferirAmbiente(nota);
    if (nota.estado === RASCUNHO) return this.assinarEEnviar(nota.id, quem);
    if ([NA_FILA, AGUARDANDO_CONFIRMACAO, ENVIANDO].includes(nota.estado) || (nota.estado === ASSINADA && nota.tentativas)) {
      return this.consultar(nota, quem, true);
    }
    if (nota.estado !== ASSINADA) return nota;
    return this.enviar(nota, quem);
  }

  async enviar(nota, quem) {
    let cliente;
    try {
      cliente = this.cliente(nota.ambiente);
    } catch (e) {
      if (e instanceof ProducaoBloqueada) throw new ErroEmissor(e.message, 403);
      return this.paraFila(nota, `não deu para preparar o envio: ${e.message}`, quem, false);
    }
    nota = this.mudarEstado(nota.id, ENVIANDO, quem, "enviando ao Sistema Nacional", { tentativas: Number(nota.tentativas || 0) + 1 });
    // Se o DO cair durante o envio, o alarme consulta antes de qualquer reenvio.
    await this.agendar(this.agora().getTime() + ENVIANDO_PARADO_MS + 1000);
    let r;
    try {
      r = await cliente.emitir(nota.xml_dps);
    } catch (e) {
      if (e instanceof NaoChegou) return this.paraFila(nota, e.message, quem, false);
      if (e instanceof SemResposta) {
        nota = this.mudarEstado(nota.id, AGUARDANDO_CONFIRMACAO, quem, `sem resposta: ${e.message}`, { ultimo_erro: e.message });
        return this.consultar(nota, quem, false);
      }
      throw e;
    }
    return this.tratarResposta(nota, r, quem);
  }

  async tratarResposta(nota, r, quem) {
    const xmlB64 = campo(r.corpo, CAMPOS.nfse);
    if (r.ok && xmlB64) return this.registrarEmitida(nota, await deGzipB64(xmlB64), quem, "emitida");
    if (r.status >= 500 || r.status === 408 || r.status === 429) {
      nota = this.mudarEstado(nota.id, AGUARDANDO_CONFIRMACAO, quem, `resposta ${r.status} do Sistema Nacional`, { ultimo_erro: `HTTP ${r.status}` });
      return this.consultar(nota, quem, false);
    }
    const erros = errosDaResposta(r.corpo, r.texto);
    if (erros.some((e) => JA_EXISTE.has(e.codigo))) {
      nota = this.mudarEstado(nota.id, AGUARDANDO_CONFIRMACAO, quem, "a Sefin diz que esta DPS já gerou nota (E0014): consultando", { ultimo_erro: "E0014" });
      return this.consultar(nota, quem, false);
    }
    return this.mudarEstado(nota.id, REJEITADA, quem, "rejeitada: " + erros.filter((e) => e.codigo).map((e) => e.codigo).join(", "), {
      rejeicao: erros, ultimo_erro: erros.length ? erros[0].frase : `HTTP ${r.status}`, esperas: 0, proxima_tentativa: "" });
  }

  async paraFila(nota, motivo, quem, chegou) {
    const atual = this.obter(nota.id) || nota;
    const n = Number(atual.esperas || 0);
    const espera = ESPERAS_MIN[Math.min(n, ESPERAS_MIN.length - 1)];
    const quando = this.agora().getTime() + espera * 60000;
    const r = this.mudarEstado(nota.id, chegou ? AGUARDANDO_CONFIRMACAO : NA_FILA, quem, `${motivo}; nova tentativa em ${espera} min`,
      { ultimo_erro: motivo, proxima_tentativa: new Date(quando).toISOString(), esperas: n + 1 });
    await this.agendar(quando);
    return r;
  }

  /**
   * Pergunta à Sefin se a DPS já virou NFS-e: existe -> registra emitida;
   * não existe com certeza (404) -> reenvia a MESMA DPS, se pedido; sem
   * resposta -> fila, consultando de novo depois.
   */
  async consultar(nota, quem, reenviarSeNaoExiste) {
    if (nota.estado === EMITIDA) return nota;
    this.conferirAmbiente(nota);
    let cliente;
    let existe;
    try {
      cliente = this.cliente(nota.ambiente);
      existe = await cliente.dpsExiste(nota.id_dps);
    } catch (e) {
      if (e instanceof ProducaoBloqueada) throw new ErroEmissor(e.message, 403);
      return this.paraFila(nota, `consulta sem resposta: ${e.message}`, quem, true);
    }
    if (existe.status === 200) {
      let xml;
      try {
        const r = await cliente.consultarDps(nota.id_dps);
        const chave = campo(r.corpo, CAMPOS.chave);
        if (!chave) throw new SemResposta("a consulta da DPS não trouxe a chave");
        const rn = await cliente.consultarNfse(chave);
        const b = campo(rn.corpo, CAMPOS.nfse);
        if (!b) throw new SemResposta("a consulta da NFS-e não trouxe o XML");
        xml = await deGzipB64(b);
      } catch (e) {
        if (!(e instanceof SemResposta || e instanceof NaoChegou)) throw e;
        return this.paraFila(nota, `a nota existe, mas a consulta não terminou: ${e.message}`, quem, true);
      }
      return this.registrarEmitida(nota, xml, quem, "confirmada pela consulta");
    }
    if (existe.status === 404) {
      this.passo(nota.id, nota.estado, nota.estado, quem, "consulta: a DPS não gerou nota no Sistema Nacional");
      if (!reenviarSeNaoExiste) return this.paraFila(nota, "a DPS não chegou a gerar nota", quem, false);
      const n = this.mudarEstado(nota.id, ASSINADA, quem, "consulta confirmou: não existe; reenviando a mesma DPS");
      return this.enviar(n, quem);
    }
    return this.paraFila(nota, `a consulta respondeu ${existe.status}`, quem, true);
  }

  async registrarEmitida(nota, xmlNfse, quem, como) {
    const texto = typeof xmlNfse === "string" ? xmlNfse : new TextDecoder().decode(xmlNfse);
    const dados = lerNfse(texto);
    if (dados.id_dps && nota.id_dps && dados.id_dps !== nota.id_dps) throw new ErroEmissor("a NFS-e devolvida é de outra DPS", 502);
    const avisos = [...(nota.avisos || [])];
    const prev = (nota.calculo || {}).v_liq;
    if (prev !== undefined && dados.valores.v_liq && dados.valores.v_liq !== prev) {
      avisos.push(`a Sefin calculou valor líquido ${reais(dados.valores.v_liq)}, diferente da previsão (${reais(prev)}): vale o da nota emitida`);
    }
    const emitida = this.mudarEstado(nota.id, EMITIDA, quem, `${como}: NFS-e ${dados.numero_nfse}, chave ${dados.chave}`, {
      chave: dados.chave, numero_nfse: dados.numero_nfse, dh_proc: dados.dh_proc, xml_nfse: texto, hash_recebido: await sha256(texto),
      sefin: { ...dados.valores, ibscbs: dados.ibscbs }, avisos, ultimo_erro: "", proxima_tentativa: "", rejeicao: [], esperas: 0 });
    await this.depoisDaNota(emitida);
    return this.obter(nota.id);
  }

  /**
   * O que vem depois de emitida; nada aqui desfaz a nota (falha vira passo).
   * O pagamento sempre fica marcado; a nota só vai ao app do cliente com o
   * interruptor "email" do painel ligado (desligado, o botão Enviar ao
   * cliente entrega). O PDF e o e-mail ficam para outro pedido
   * (api.js, depoisDeEmitir): a nota entra na lista admin:nfse-depois.
   */
  async depoisDaNota(nota) {
    if (nota.substitui_id) {
      const original = this.obter(nota.substitui_id);
      if (original && original.estado === EMITIDA) {
        this.mudarEstado(original.id, SUBSTITUIDA, "PAVLVS", `substituída pela NFS-e ${nota.numero_nfse} (a Sefin cancela por substituição)`,
          { substituida_por_id: nota.id });
        await this.avisarCancelada(original, { numero: nota.numero_nfse });
      }
    }
    if (nota.pagamento && this.env.APOIOS) {
      try {
        await marcarPagamento(this.env, nota.pagamento, { nota: "emitida", numero: nota.numero_nfse, nota_id: idNoCliente(nota.id), erro: "", motivo: "" });
      } catch {
        // a nota vale; a marca do pagamento é só para a lista do painel
      }
    }
    if ((await this.config()).email) await this.mandarAoCliente(nota);
    else if (nota.conta) this.passo(nota.id, nota.estado, nota.estado, "PAVLVS", "não foi ao app do cliente (a entrega logo depois de emitir está desligada no painel): use Enviar ao cliente");
    if (this.env.APOIOS) {
      try {
        await anotarParaDepois(this.env, nota.id, this.agora());
      } catch {
        // sem o KV agora: o botão PDF gera na hora
      }
    }
  }

  /** A meta e o XML nas chaves do app do cliente (nfse:nota*, como POST /api/nfse-casa/notas). */
  async mandarAoCliente(nota) {
    if (!this.env.APOIOS) return;
    let resultado;
    try {
      if (nota.conta) {
        const r = await guardarNotaDoCliente(this.env, notaParaCliente(nota));
        resultado = r.status === 200 ? this.agoraIso() : `erro: ${r.corpo.erro || r.status}`;
      } else return;
    } catch (e) {
      resultado = `erro: ${String(e && e.message || e).slice(0, 200)}`;
    }
    this.rodar("UPDATE notas SET cliente_avisado = ? WHERE id = ?", resultado, nota.id);
    this.passo(nota.id, nota.estado, nota.estado, "PAVLVS", resultado.startsWith("erro") ? `app do cliente: ${resultado}` : "a nota foi ao app do cliente");
  }

  async avisarCancelada(nota, substituta = null) {
    if (!this.env.APOIOS) return "";
    // A nota não chegou ao app do cliente: só o pagamento muda.
    if (!nota.conta || !nota.cliente_avisado || String(nota.cliente_avisado).startsWith("erro")) {
      if (nota.pagamento && !substituta) await marcarPagamento(this.env, nota.pagamento, { nota: "cancelada" }).catch(() => {});
      if (nota.conta) this.passo(nota.id, nota.estado, nota.estado, "PAVLVS", "o app do cliente não tinha esta nota: nada a avisar");
      return "";
    }
    let frase;
    try {
      const corpo = { conta: nota.conta, email: (await this.config()).mail };
      if (substituta) corpo.substituta = substituta;
      const r = await avisarNotaCancelada(this.env, idNoCliente(nota.id), corpo);
      frase = r.status === 200 ? "o app do cliente foi avisado" : `não consegui avisar o app do cliente: ${r.corpo.erro || r.status}`;
    } catch (e) {
      frase = `não consegui avisar o app do cliente: ${e.message}`;
    }
    this.passo(nota.id, nota.estado, nota.estado, "PAVLVS", frase);
    return frase;
  }

  /** Os interruptores do painel: {auto, email, mail} (admin:nfse:config). */
  async config() {
    try {
      const v = this.env.APOIOS ? await this.env.APOIOS.get("admin:nfse:config") : null;
      const c = v ? JSON.parse(v) : {};
      return { auto: Boolean(c.auto), email: Boolean(c.email), mail: Boolean(c.mail) };
    } catch {
      return { auto: false, email: false, mail: false };
    }
  }

  /** Enviar ao cliente (o botão do painel): a nota emitida vai ao app dele agora. */
  async enviarAoCliente({ id, quem = "PAVLVS" }) {
    const n = this.exigir(id);
    if (n.estado !== EMITIDA) throw new ErroEmissor("só se envia ao cliente a nota emitida", 409);
    if (!n.conta) throw new ErroEmissor("esta nota não é de um assinante (sem conta): baixe o PDF e mande à mão", 409);
    await this.mandarAoCliente(n);
    const depois = this.obter(n.id);
    if (String(depois.cliente_avisado || "").startsWith("erro")) {
      throw new ErroEmissor("não consegui entregar ao app do cliente: " + depois.cliente_avisado.replace(/^erro:\s*/, ""), 502);
    }
    this.passo(n.id, n.estado, n.estado, quem, "enviada ao app do cliente pelo painel");
    return this.paraTela(depois);
  }

  /** O que aconteceu com o e-mail da nota (depois do envio). */
  anotarEmail({ id, email = "" }) {
    const n = this.exigir(id);
    this.rodar("UPDATE notas SET email = ? WHERE id = ?", String(email).slice(0, 200), n.id);
    this.passo(n.id, n.estado, n.estado, "PAVLVS", "e-mail: " + String(email).slice(0, 200));
    return this.paraTela(this.obter(n.id));
  }

  /** O certificado e a chave em PEM, para cadastrar o mTLS na Cloudflare (mtls.js). Não sai do Worker. */
  async parParaMtls() {
    const c = this.certificadoAtivo();
    if (!c) throw new ErroEmissor("falta o certificado A1 da nota", 409);
    const certDer = await decifrar(this.env, c.cert_cifrado, "certificado");
    const chaveDer = await decifrar(this.env, c.chave_cifrada, "chave");
    const pem = (rotulo, der) => `-----BEGIN ${rotulo}-----\n` + b64(der).replace(/(.{64})/g, "$1\n").replace(/\n$/, "") + `\n-----END ${rotulo}-----\n`;
    const saida = { certPem: pem("CERTIFICATE", certDer), chavePem: pem("PRIVATE KEY", chaveDer), documento: c.documento, valido_ate: c.valido_ate, titular: c.titular };
    chaveDer.fill(0);
    return saida;
  }

  /** Tentar de novo a nota da fila (sempre consulta antes de reenviar). */
  async tentar(id, quem = "PAVLVS") {
    const n = this.exigir(id);
    if ([EMITIDA, CANCELADA, SUBSTITUIDA, DESCARTADA, REJEITADA].includes(n.estado)) return n;
    return this.comNota(n.id, () => this.emitirNota(this.obter(n.id), quem));
  }

  /** Rejeitada (ou rascunho que não assinou) que não virou NFS-e: descarta e devolve o número. */
  descartar(id, quem = "PAVLVS") {
    const n = this.exigir(id);
    if (![RASCUNHO, REJEITADA].includes(n.estado)) throw new ErroEmissor(`a nota está “${n.estado_rotulo}”: nota emitida não se apaga, se cancela`, 409);
    if (this.ocupadas.has(n.id)) throw new ErroEmissor("esta nota está em andamento", 409);
    this.ctx.storage.transactionSync(() => {
      if (n.numero) {
        this.rodar("INSERT OR IGNORE INTO numeros_livres (ambiente, serie, numero, devolvido_por) VALUES (?,?,?,?)",
          n.ambiente, n.serie, n.numero, n.id);
      }
      this.rodar("UPDATE notas SET estado = ?, numero = NULL, id_dps = NULL, atualizado_em = ? WHERE id = ?", DESCARTADA, this.agoraIso(), n.id);
      this.passo(n.id, n.estado, DESCARTADA, quem, n.numero ? `descartada; o número ${n.numero} volta para a próxima nota` : "descartada");
    });
    return this.obter(n.id);
  }

  // ------------------------------------------------------------ fila e alarme

  async agendar(quando) {
    const st = this.ctx.storage;
    if (!st.setAlarm) return;
    const atual = await st.getAlarm();
    if (!atual || atual > quando) await st.setAlarm(quando);
  }

  async processarFila(quem = "fila") {
    const agora = this.agora().getTime();
    const feitas = [];
    const parado = new Date(agora - ENVIANDO_PARADO_MS).toISOString();
    for (const l of this.todos("SELECT id FROM notas WHERE estado = ? AND atualizado_em <= ?", ENVIANDO, parado)) {
      if (this.ocupadas.has(l.id)) continue;
      this.mudarEstado(l.id, AGUARDANDO_CONFIRMACAO, quem, "o envio parou no meio: consultando antes de qualquer reenvio");
    }
    const prontas = this.todos(`SELECT id FROM notas WHERE estado IN (?, ?) AND (proxima_tentativa = '' OR proxima_tentativa <= ?)
      ORDER BY id LIMIT 20`, NA_FILA, AGUARDANDO_CONFIRMACAO, new Date(agora).toISOString());
    for (const l of prontas) {
      if (this.ocupadas.has(l.id)) continue;
      try {
        feitas.push(this.paraTela(await this.tentar(l.id, quem)));
      } catch (e) {
        this.passo(l.id, "", "", quem, `fila: ${e.message}`);
      }
    }
    for (const ev of this.todos("SELECT id FROM eventos WHERE estado IN (?, ?) AND tentativas > 0 AND atualizado_em <= ?",
      EV_CONFIRMANDO, EV_ENVIANDO, parado)) {
      try {
        await this.enviarEvento(ev.id, quem);
      } catch {
        // fica para a próxima volta
      }
    }
    // A próxima volta: a menor tentativa marcada, ou daqui a 3 min se ainda há envio em curso.
    const prox = this.um(`SELECT MIN(proxima_tentativa) AS p FROM notas WHERE estado IN (?, ?) AND proxima_tentativa <> ''`, NA_FILA, AGUARDANDO_CONFIRMACAO);
    const pendente = this.um(`SELECT COUNT(*) AS n FROM notas WHERE estado = ?`, ENVIANDO).n
      + this.um("SELECT COUNT(*) AS n FROM eventos WHERE estado IN (?, ?)", EV_CONFIRMANDO, EV_ENVIANDO).n;
    if (prox && prox.p) await this.agendar(Math.max(Date.parse(prox.p), agora + 1000));
    else if (pendente) await this.agendar(agora + ENVIANDO_PARADO_MS + 60000);
    return feitas;
  }

  async alarm() {
    await this.processarFila("alarme");
  }

  // ------------------------------------------------------------ cancelar

  prazoDeCancelamento(nota) {
    const dias = this.situacaoMunicipio(nota.ambiente).prazo_cancelamento_dias;
    const emitida = (nota.dh_proc || "").slice(0, 10);
    if (dias === null || dias === undefined || !emitida) {
      return { dias: null, ate: "", dentro: true, frase: "O prazo de cancelamento é do município e não veio nos parâmetros: se tiver passado, a "
        + "Sefin recusa (regra E0822) e o motivo aparece aqui." };
    }
    const ate = new Date(Date.parse(emitida + "T00:00:00Z") + Number(dias) * 86400000).toISOString().slice(0, 10);
    const dentro = hojeBrasilia(this.agora()) <= ate;
    const br = `${ate.slice(8, 10)}/${ate.slice(5, 7)}/${ate.slice(0, 4)}`;
    return { dias: Number(dias), ate, dentro, frase: dentro
      ? `O município deixa cancelar em até ${dias} dia(s) da emissão: até ${br}.`
      : `O prazo de cancelamento do município (${dias} dia(s)) acabou em ${br}. Para corrigir, emita uma nota substituta `
        + "(a Sefin cancela esta sozinha), se o motivo for um dos da tabela de substituição; senão, o caminho é o pedido de análise fiscal ao município." };
  }

  async cancelar({ id, motivo, texto, quem = "PAVLVS" }) {
    const nota = this.exigir(id);
    if (nota.estado !== EMITIDA) throw new ErroEmissor("só se cancela nota emitida", 409);
    motivo = String(motivo || "");
    if (!(motivo in tabelas.dominio("motivo_cancelamento"))) {
      throw new ErroEmissor("escolha o motivo da tabela oficial: 1 – Erro na emissão, 2 – Serviço não prestado, 9 – Outros");
    }
    texto = juntarEspacos(String(texto || ""));
    if (tamanho(texto) < 15 || tamanho(texto) > 255) throw new ErroEmissor("descreva o motivo com 15 a 255 caracteres (regra do leiaute do evento)");
    const prazo = this.prazoDeCancelamento(nota);
    if (!prazo.dentro) throw new ErroEmissor(prazo.frase, 409);
    if (this.um("SELECT id FROM eventos WHERE nota_id = ? AND tipo = ? AND estado <> ?", nota.id, CANCELAMENTO, EV_REJEITADO)) {
      throw new ErroEmissor("já há um pedido de cancelamento desta nota", 409);
    }
    const agora = this.agoraIso();
    const evId = this.um(`INSERT INTO eventos (nota_id, tipo, estado, motivo, texto, pedido_por, criado_em, atualizado_em)
      VALUES (?,?,?,?,?,?,?,?) RETURNING id`, nota.id, CANCELAMENTO, EV_PEDIDO, motivo, texto, quem, agora, agora).id;
    this.passo(nota.id, EMITIDA, EMITIDA, quem, `cancelamento pedido (motivo ${motivo})`, evId);
    const ev = await this.comNota(nota.id, () => this.enviarEvento(evId, quem));
    return { evento: ev, nota: this.paraTela(this.obter(nota.id)), prazo };
  }

  /** Fora do prazo: a solicitação de análise fiscal para cancelamento (e101103). A nota
      continua emitida até o município deferir (e105104); atualizarSituacao lê a resposta. */
  async pedirAnaliseFiscal({ id, motivo = "9", texto, quem = "PAVLVS" }) {
    const nota = this.exigir(id);
    if (nota.estado !== EMITIDA) throw new ErroEmissor("só se pede análise fiscal de nota emitida", 409);
    if (!["1", "2", "9"].includes(String(motivo))) throw new ErroEmissor("o motivo da análise fiscal é 1, 2 ou 9 (TSCodJustAnaliseFiscalCanc)");
    texto = juntarEspacos(String(texto || ""));
    if (tamanho(texto) < 15 || tamanho(texto) > 255) throw new ErroEmissor("descreva o motivo com 15 a 255 caracteres (regra do leiaute do evento)");
    if (this.um("SELECT id FROM eventos WHERE nota_id = ? AND tipo = ? AND estado <> ?", nota.id, ANALISE_FISCAL, EV_REJEITADO)) {
      throw new ErroEmissor("já há um pedido de análise fiscal desta nota", 409);
    }
    const agora = this.agoraIso();
    const evId = this.um(`INSERT INTO eventos (nota_id, tipo, estado, motivo, texto, pedido_por, criado_em, atualizado_em)
      VALUES (?,?,?,?,?,?,?,?) RETURNING id`, nota.id, ANALISE_FISCAL, EV_PEDIDO, String(motivo), texto, quem, agora, agora).id;
    this.passo(nota.id, EMITIDA, EMITIDA, quem, `análise fiscal para cancelamento pedida ao município (motivo ${motivo})`, evId);
    const ev = await this.comNota(nota.id, () => this.enviarEvento(evId, quem));
    return { evento: ev, nota: this.paraTela(this.obter(nota.id)) };
  }

  /** O pagamento foi devolvido (o reembolso): a nota dele sai. Não emitida, é
      descartada; emitida e no prazo do município, cancelada; fora do prazo (ou
      a Sefin dizendo E0822), a análise fiscal. -> {acao, frase, nota?}. */
  async notaDoReembolso({ pagamento, texto, quem = "PAVLVS" }) {
    const notas = this.todos("SELECT id FROM notas WHERE pagamento = ? AND estado NOT IN (?,?,?) ORDER BY id DESC", String(pagamento), DESCARTADA, CANCELADA, SUBSTITUIDA)
      .map((x) => this.obter(x.id));
    if (!notas.length) return { acao: "sem_nota", frase: "o pagamento não tinha nota" };
    const nota = notas[0];
    texto = texto || "Desistência do contratante no prazo de arrependimento (CDC, art. 49): o valor foi devolvido integralmente.";
    if ([RASCUNHO, REJEITADA].includes(nota.estado)) {
      this.descartar(nota.id, quem);
      return { acao: "descartada", frase: "a nota ainda não emitida foi descartada", nota: nota.id };
    }
    if (nota.estado !== EMITIDA) {
      return { acao: "em_andamento", frase: `a nota está “${nota.estado_rotulo || nota.estado}”: quando sair, cancele em Notas fiscais`, nota: nota.id };
    }
    const prazo = this.prazoDeCancelamento(nota);
    if (prazo.dentro) {
      const r = await this.cancelar({ id: nota.id, motivo: "9", texto, quem });
      const ev = r.evento || {};
      const foraDoPrazo = ev.estado === EV_REJEITADO && (ev.rejeicao || []).some((e) => e.codigo === "E0822");
      if (!foraDoPrazo) {
        return { acao: ev.estado === EV_REJEITADO ? "cancelamento_recusado" : "cancelada",
          frase: ev.estado === EV_REJEITADO ? "a Sefin recusou o cancelamento: " + (ev.ultimo_erro || "veja a nota") : "a nota foi cancelada", nota: nota.id };
      }
    }
    const a = await this.pedirAnaliseFiscal({ id: nota.id, motivo: "9", texto, quem });
    const ev = a.evento || {};
    return { acao: ev.estado === EV_REJEITADO ? "analise_recusada" : "analise_fiscal",
      frase: ev.estado === EV_REJEITADO ? "a Sefin recusou o pedido de análise fiscal: " + (ev.ultimo_erro || "veja a nota")
        : "o prazo de cancelamento passou: a análise fiscal foi pedida ao município", nota: nota.id };
  }

  obterEvento(id) {
    const e = this.um("SELECT * FROM eventos WHERE id = ?", id);
    if (e) e.rejeicao = lerJson(e.rejeicao, []);
    return e;
  }

  mudarEvento(id, campos) {
    const sets = ["atualizado_em = ?"];
    const valores = [this.agoraIso()];
    for (const [k, v] of Object.entries(campos)) {
      sets.push(`${k} = ?`);
      valores.push(v !== null && typeof v === "object" ? json(v) : v);
    }
    this.rodar(`UPDATE eventos SET ${sets.join(", ")} WHERE id = ?`, ...valores, id);
    return this.obterEvento(id);
  }

  async enviarEvento(evId, quem) {
    let ev = this.obterEvento(evId);
    const nota = this.obter(ev.nota_id);
    this.conferirAmbiente(nota);
    const cliente = this.cliente(nota.ambiente);
    if (ev.tentativas) {
      // Já houve tentativa: consulta antes de pedir de novo.
      const achado = await this.consultarEvento(cliente, nota, ev.tipo).catch(() => null);
      if (achado) return this.eventoRegistrado(ev, nota, achado, quem, "confirmado pela consulta");
    }
    const prest = (this.prestadorVersao(nota.prestador_versao) || this.prestadorAtual()).dados;
    const { xml, id: ident } = montarPedidoEvento({ chave: nota.chave, ambiente: nota.ambiente, documento: prest.documento,
      tipo: ev.tipo, motivo: ev.motivo, texto: ev.texto, quando: this.agora(), verAplic: VER_APLIC });
    const { chave, certDer, algoritmo } = await this.abrirChave();
    const assinado = await assinar(xml, chave, certDer, ident, algoritmo);
    ev = this.mudarEvento(evId, { estado: EV_ENVIANDO, xml_pedido: assinado, tentativas: Number(ev.tentativas || 0) + 1 });
    await this.agendar(this.agora().getTime() + ENVIANDO_PARADO_MS + 1000);
    let r;
    try {
      r = await cliente.registrarEvento(nota.chave, assinado);
    } catch (e) {
      if (!(e instanceof SemResposta || e instanceof NaoChegou)) throw e;
      ev = this.mudarEvento(evId, { estado: EV_CONFIRMANDO, ultimo_erro: e.message });
      const achado = await this.consultarEvento(cliente, nota, ev.tipo).catch(() => null);
      if (achado) return this.eventoRegistrado(ev, nota, achado, quem, "confirmado pela consulta");
      return ev;
    }
    const b = campo(r.corpo, CAMPOS.evento);
    if (r.ok && b) return this.eventoRegistrado(ev, nota, await deGzipB64(b), quem, "registrado");
    if (r.status >= 500) return this.mudarEvento(evId, { estado: EV_CONFIRMANDO, ultimo_erro: `HTTP ${r.status}` });
    const erros = errosDaResposta(r.corpo, r.texto);
    this.passo(nota.id, EMITIDA, EMITIDA, quem, "cancelamento recusado: " + erros.filter((e) => e.codigo).map((e) => e.codigo).join(", "), evId);
    return this.mudarEvento(evId, { estado: EV_REJEITADO, rejeicao: erros, ultimo_erro: erros.length ? erros[0].frase : `HTTP ${r.status}` });
  }

  async consultarEvento(cliente, nota, tipo) {
    const r = await cliente.consultarEventos(nota.chave, tipo);
    if (r.status === 404 || !r.corpo) return null;
    for (const v of valoresB64(r.corpo)) {
      let xml;
      try {
        xml = new TextDecoder().decode(await deGzipB64(v));
      } catch {
        continue;
      }
      if (xml.includes(`e${tipo}`)) return xml;
    }
    return null;
  }

  async eventoRegistrado(ev, nota, xmlEvento, quem, como) {
    const texto = typeof xmlEvento === "string" ? xmlEvento : new TextDecoder().decode(xmlEvento);
    ev = this.mudarEvento(ev.id, { estado: EV_REGISTRADO, xml_evento: texto, ultimo_erro: "" });
    if (ev.tipo === CANCELAMENTO && this.obter(nota.id).estado === EMITIDA) {
      const n = this.mudarEstado(nota.id, CANCELADA, quem, `cancelamento ${como} (motivo ${ev.motivo})`);
      await this.avisarCancelada(n);
    }
    return ev;
  }

  /** Os eventos da nota na Sefin: cancelada, substituída, por ofício (eventos.atualizar_situacao). */
  async atualizarSituacao(id, quem = "PAVLVS") {
    const nota = this.exigir(id);
    if (![EMITIDA, CANCELADA, SUBSTITUIDA].includes(nota.estado)) return this.tentar(id, quem);
    const r = await this.cliente(nota.ambiente).consultarEventos(nota.chave);
    const tipos = new Set();
    for (const v of valoresB64(r.corpo || {})) {
      let xml;
      try {
        xml = new TextDecoder().decode(await deGzipB64(v));
      } catch {
        continue;
      }
      for (const t of [CANCELAMENTO, POR_SUBSTITUICAO, POR_OFICIO, ANALISE_FISCAL, ANALISE_DEFERIDA, ANALISE_INDEFERIDA]) if (xml.includes(`<e${t}`)) tipos.add(t);
    }
    if (nota.estado === EMITIDA && (tipos.has(CANCELAMENTO) || tipos.has(POR_OFICIO) || tipos.has(ANALISE_DEFERIDA))) {
      const como = tipos.has(ANALISE_DEFERIDA) ? "pela análise fiscal (o município deferiu)"
        : tipos.has(POR_OFICIO) && !tipos.has(CANCELAMENTO) ? "por ofício (o município cancelou)" : "no Sistema Nacional";
      await this.avisarCancelada(this.mudarEstado(nota.id, CANCELADA, quem, `a consulta mostrou a nota cancelada ${como}`));
    } else if (nota.estado === EMITIDA && tipos.has(POR_SUBSTITUICAO)) {
      this.mudarEstado(nota.id, SUBSTITUIDA, quem, "a consulta mostrou a nota cancelada por substituição");
    } else {
      const analise = tipos.has(ANALISE_INDEFERIDA) ? " · a análise fiscal foi indeferida pelo município: a nota continua valendo"
        : tipos.has(ANALISE_FISCAL) ? " · a análise fiscal espera a resposta do município" : "";
      this.passo(nota.id, nota.estado, nota.estado, quem, "situação consultada: " + ([...tipos].sort().join(", ") || "sem eventos de cancelamento") + analise);
    }
    return this.obter(nota.id);
  }

  // ------------------------------------------------------------ substituir

  /** A substituta: a original com os ajustes; emitida, a Sefin cancela a original (e105102). */
  async substituir({ id, motivo, texto, ajustes = {}, quem = "PAVLVS" }) {
    const original = this.exigir(id);
    if (original.estado !== EMITIDA) throw new ErroEmissor("só se substitui nota emitida", 409);
    if (original.origem !== ORIGEM) throw new ErroEmissor("só a nota do PAVLVS se substitui por aqui", 409);
    motivo = String(motivo || "");
    if (!(motivo in tabelas.dominio("motivo_substituicao"))) throw new ErroEmissor("escolha o motivo da tabela oficial de substituição (01 a 05 ou 99)");
    texto = juntarEspacos(String(texto || ""));
    if (texto && (tamanho(texto) < 15 || tamanho(texto) > 255)) throw new ErroEmissor("a descrição do motivo tem de 15 a 255 caracteres");
    if (motivo === "99" && !texto) throw new ErroEmissor("com o motivo 99 – Outros, descreva o motivo (15 a 255 caracteres)");
    if (this.um("SELECT id FROM notas WHERE substitui_id = ? AND estado NOT IN ('descartada')", original.id)) {
      throw new ErroEmissor("já existe uma nota substituta desta (veja a nota nova)", 409);
    }
    const a = ajustes || {};
    const pedido = { conta: original.conta, pagamento: original.pagamento, quem, base: original.rascunho,
      substitui: { chave: original.chave, motivo, texto } };
    if (a.tomador) pedido.tomador = a.tomador;
    for (const k of ["valor", "valor_centavos", "descricao", "competencia"]) if (a[k] !== undefined && a[k] !== "") pedido[k] = a[k];
    const nova = await this.emitir(pedido, { substituiId: original.id });
    this.passo(original.id, EMITIDA, this.obter(original.id).estado, quem, `nota substituta ${nova.id} (motivo ${motivo}): ${nova.estado}`);
    return { nota: this.paraTela(nova), original: this.paraTela(this.obter(original.id)) };
  }

  // ------------------------------------------------------------ produção

  liberarProducao({ quem = "" }) {
    if (!quem) throw new ErroEmissor("diga quem libera a produção");
    if (this.producaoLiberada()) return this.situacao();
    const faltas = this.faltas();
    if (faltas.length) throw new ErroEmissor("ainda falta: " + faltas.slice(0, 4).join("; "), 409);
    if (!this.certificadoAtivo()) throw new ErroEmissor("falta o certificado A1 da nota", 409);
    const testes = this.um("SELECT COUNT(*) AS n FROM notas WHERE ambiente = 'producao_restrita' AND estado IN ('emitida','cancelada','substituida')").n;
    if (!testes) throw new ErroEmissor("emita antes ao menos uma nota no ambiente de testes (produção restrita)", 409);
    this.ctx.storage.transactionSync(() => {
      this.rodar("INSERT INTO liberacao (liberado_em, liberado_por, testes) VALUES (?,?,?)", this.agoraIso(), quem, testes);
      this.gravarVersao({ ...this.prestadorAtual().dados, ambiente: "producao" }, quem, "produção liberada pelo titular");
    });
    return this.situacao();
  }

  voltarParaTestes({ quem = "" }) {
    this.ctx.storage.transactionSync(() => {
      this.rodar("UPDATE liberacao SET revogado_em = ?, revogado_por = ? WHERE revogado_em IS NULL", this.agoraIso(), quem);
      if (this.ambiente() !== "producao_restrita") {
        this.gravarVersao({ ...this.prestadorAtual().dados, ambiente: "producao_restrita" }, quem, "de volta à produção restrita");
      }
    });
    return this.situacao();
  }

  /** O depois de emitir (o PDF): marca na nota. */
  marcarDepois({ id, pdf_em = "", email = "" }) {
    const n = this.exigir(id);
    this.rodar("UPDATE notas SET pdf_em = ?, email = ? WHERE id = ?", pdf_em, email, n.id);
    this.passo(n.id, n.estado, n.estado, "PAVLVS", `PDF ${pdf_em ? "gerado" : "não gerado"}${email ? "; e-mail: " + email : ""}`);
    return this.paraTela(this.obter(n.id));
  }

  // ------------------------------------------------------------ porta

  async fazer(acao, d) {
    switch (acao) {
      case "situacao": return this.situacao();
      case "configurar": return this.configurar(d);
      case "certificado": return this.guardarCertificado(d);
      case "testar": return this.testar();
      case "emitir": return this.paraTela(await this.emitir(d));
      case "listar": return { notas: this.listar(d) };
      case "nota": return this.detalhe(d.id);
      case "xml": return this.xml(d.id, d.tipo);
      case "tentar": return this.paraTela(await this.tentar(d.id, d.quem));
      case "descartar": return this.paraTela(this.descartar(d.id, d.quem));
      case "fila": return { feitas: await this.processarFila(d.quem || "fila") };
      case "cancelar": return this.cancelar(d);
      case "analise_fiscal": return this.pedirAnaliseFiscal(d);
      case "nota_do_reembolso": return this.notaDoReembolso(d);
      case "substituir": return this.substituir(d);
      case "atualizar_situacao": return this.paraTela(await this.atualizarSituacao(d.id, d.quem));
      case "liberar_producao": return this.liberarProducao(d);
      case "voltar_testes": return this.voltarParaTestes(d);
      case "para_pdf": {
        // O DANFSe sai só do XML da NFS-e (danfse.js): a nota e o XML bastam.
        const n = this.exigir(d.id);
        return { nota: this.paraTela(n), xml_nfse: n.xml_nfse || "" };
      }
      case "marcar_depois": return this.marcarDepois(d);
      case "enviar_cliente": return this.enviarAoCliente(d);
      case "anotar_email": return this.anotarEmail(d);
      case "par_para_mtls": return this.parParaMtls();
      default: throw new ErroEmissor("ação desconhecida", 404);
    }
  }

  async fetch(request) {
    let d;
    try {
      d = await request.json();
    } catch {
      return resposta({ erro: "pedido inválido" }, 400);
    }
    try {
      return resposta(await this.fazer(d.acao, d.dados || {}));
    } catch (e) {
      if (e instanceof ErroEmissor) return resposta({ erro: e.message, ...e.extra }, e.status);
      if (e instanceof ProducaoBloqueada) return resposta({ erro: e.message }, 403);
      return resposta({ erro: String((e && e.message) || e).slice(0, 300) }, 500);
    }
  }
}

function resposta(dados, status = 200) {
  return new Response(JSON.stringify(dados), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

/** O id da nota no app do cliente (não colide com as notas que a casa mandou). */
export function idNoCliente(id) {
  return `nuvem-${id}`;
}

/** O corpo de POST /api/nfse-casa/notas a partir da nota emitida. */
export function notaParaCliente(nota) {
  const r = nota.rascunho || {};
  return {
    id: idNoCliente(nota.id), conta: nota.conta, pagamento: nota.pagamento || "", numero: nota.numero_nfse || "", chave: nota.chave || "",
    competencia: String(r.competencia || "").slice(0, 7), valor: Number(nota.centavos || 0) / 100, descricao: r.descricao || "",
    ambiente: nota.ambiente, emitida_em: nota.dh_proc || nota.atualizado_em || "",
    xml_b64: b64(utf8.encode(nota.xml_nfse || "")), email: false,
  };
}

/** As listas das escolhas da tela (Parâmetros, Cancelar, Substituir). */
export function opcoesDaTela() {
  return {
    motivos_cancelamento: tabelas.dominio("motivo_cancelamento"), motivos_substituicao: tabelas.dominio("motivo_substituicao"),
    opcao_simples: tabelas.dominio("opcao_simples"), regime_especial: tabelas.dominio("regime_especial"),
    regime_apuracao_sn: tabelas.dominio("regime_apuracao_sn"), quando_reter: { ...QUANDO_RETER }, retencoes: { ...RETENCOES },
  };
}

// As notas emitidas que ainda esperam o PDF (e o e-mail): o painel pede logo
// depois de emitir; o Cron de cada minuto (index.js, depoisPendentes) pega as
// que ficaram (emissão automática, nota que saiu da fila).
export const K_DEPOIS = "admin:nfse-depois";

export async function anotarParaDepois(env, id, agora = new Date()) {
  let lista = [];
  try {
    lista = JSON.parse((await env.APOIOS.get(K_DEPOIS)) || "[]");
  } catch {
    lista = [];
  }
  if (!Array.isArray(lista)) lista = [];
  if (lista.some((x) => x && x.id === id)) return;
  lista.push({ id, quando: agora.toISOString() });
  await env.APOIOS.put(K_DEPOIS, JSON.stringify(lista.slice(-200)));
}

export function fraseMunicipio(cmun, situacao, detalhes = "") {
  const m = tabelas.municipio(cmun);
  const nome = m ? `${m.nome}/${m.uf}` : (cmun || "o município");
  if (situacao === CONVENIADO) return `Dá para emitir pelo padrão nacional: ${nome} tem convênio ativo com o Sistema Nacional da NFS-e.`;
  if (situacao === SEM_CONVENIO) return `${nome} não emite pelo Sistema Nacional da NFS-e` + (detalhes ? ` (${detalhes})` : "") + ".";
  if (situacao === INDEFINIDO) {
    return `Não consegui confirmar se ${nome} emite pelo Sistema Nacional` + (detalhes ? ` (${detalhes})` : "")
      + ". Enquanto não confirmar, a emissão fica desligada; teste a comunicação de novo.";
  }
  return "Ainda não consultei o município: teste a comunicação (a consulta pergunta ao próprio Sistema Nacional se dá para emitir).";
}

/**
 * Decifra (NFSE_CHAVE_MESTRA) o certificado e a chave guardados no DO e
 * importa a chave para assinar: {chave: CryptoKey, certDer, algoritmo}.
 */
export async function abrirChave(env, guardado) {
  const algoritmo = guardado.algoritmo || "sha1";
  const certDer = await decifrar(env, guardado.cert_cifrado, "certificado");
  const pkcs8 = await decifrar(env, guardado.chave_cifrada, "chave");
  const chave = await importarChave(pkcs8, algoritmo);
  pkcs8.fill(0);
  return { chave, certDer, algoritmo };
}
