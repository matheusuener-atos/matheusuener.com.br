// O DANFSe - o documento auxiliar da NFS-e, em PDF, gerado no Worker a partir
// do XML. Porte de paulus/legal/src/nfse/danfse.py (o leiaute da NT 008,
// v1.02): os mesmos blocos, na mesma ordem, com os mesmos textos, campos,
// tamanhos e posições, e o QR Code da consulta pública (worker/nfse/qr.js,
// a mesma matriz que o reportlab desenha no Python).
//
//   dadosDoXml(xml)  o que vai no DANFSe, tirado só do XML (== dados_do_xml)
//   urlQr(chave)     o endereço do QR Code (NT 008, §2.4.3) (== url_qr)
//   gerarDanfse(xml) o PDF (Uint8Array), uma página A4
//
// O teste de ouro (worker/teste-nfse-danfse.mjs) confere dadosDoXml e a
// matriz do QR contra o Python, nas NFS-e de worker/nfse/fixtures/danfse.json;
// a conferência visual, página contra página, está em
// worker/nfse/fixtures/danfse/ (comparar_danfse.py).
//
// CPU: o PDF sai num pedido SEPARADO da emissão (api.js, depoisDeEmitir), e
// cabe com folga: o conteúdo da página é escrito direto como operadores do
// PDF (sem o drawText/drawRectangle do pdf-lib, que empilham estado gráfico
// a cada chamada) e as fontes são as padrão do PDF (Helvetica e
// Helvetica-Bold, nada embutido), com as larguras da mesma tabela que o
// reportlab usa - assim o corte de texto ("...") cai no mesmo caractere que
// no Python. O pdf-lib monta o documento (objetos, xref).
//
// Diferenças conhecidas, as mesmas do Python: a fonte é a Helvetica do PDF
// (de métrica igual à Arial pedida) e a logomarca oficial não vem embutida.
// Caractere fora do WinAnsi (a codificação das fontes padrão) sai como "?";
// o reportlab desenha um quadradinho de outra fonte no lugar.

// UMD: no esbuild (wrangler) os nomes vêm no namespace (o pdf-lib marca
// __esModule); no node, no default. Aceita os dois.
import * as pdfLibModulo from "../vendor/pdf-lib.min.js";
import DESCRICOES from "./tabelas/servicos_descricao.json" with { type: "json" };
import { centavosDoXml, reais } from "./dinheiro.js";
import { LOGO_NFSE } from "./logo-nfse.js";
import { matrizQr } from "./qr.js";
import { dominio, municipio } from "./tabelas.js";
import { cnpjValido, cpfValido, documentoNormal, juntarEspacos, strip } from "./texto.js";
import { lerXml } from "./xml.js";

const PDFLib = pdfLibModulo.PDFDocument ? pdfLibModulo : pdfLibModulo.default;
const { PDFDocument, PDFName } = PDFLib;

const NS = "http://www.sped.fazenda.gov.br/nfse";
const URL_CONSULTA = "https://www.nfse.gov.br/ConsultaPublica/?tpc=1&chave=";

/** O endereço do QR Code (NT 008, §2.4.3). */
export function urlQr(chave) {
  return URL_CONSULTA + chave;
}

// ------------------------------------------------------------ o XML

// Anota em cada elemento o namespace e o nome local (uma passada só).
function anotar(el, escopo) {
  let mapa = escopo;
  if (el.decls.length) {
    mapa = new Map(escopo);
    for (const [p, u] of el.decls) mapa.set(p, u);
  }
  const k = el.nome.indexOf(":");
  el._local = k < 0 ? el.nome : el.nome.slice(k + 1);
  el._ns = mapa.get(k < 0 ? "" : el.nome.slice(0, k)) || "";
  for (const f of el.filhos) if (f.tipo === "el") anotar(f, mapa);
}

// O find do ElementTree com "n:a/n:b" (todos no namespace da NFS-e).
function achar(no, caminho) {
  if (!no) return null;
  let atuais = [no];
  for (const nome of caminho.split("/")) {
    const proximos = [];
    for (const a of atuais) for (const f of a.filhos) if (f.tipo === "el" && f._local === nome && f._ns === NS) proximos.push(f);
    if (!proximos.length) return null;
    atuais = proximos;
  }
  return atuais[0];
}

// O .text do lxml: o texto antes do primeiro filho.
function textoDe(el) {
  let s = "";
  for (const f of el.filhos) {
    if (f.tipo === "el") break;
    if (f.tipo === "texto") s += f.texto;
  }
  return s;
}

/** _t: o texto do caminho, sem espaço nas pontas ("" se não há). */
function t(no, caminho) {
  if (!no) return "";
  const el = achar(no, caminho);
  return el ? strip(textoDe(el)) : "";
}

const r$ = (texto) => (texto ? reais(centavosDoXml(texto)) : "-");
const pct = (texto) => (texto ? texto.replace(/\./g, ",") + "%" : "-");
const pega = (obj, k, padrao) => (Object.prototype.hasOwnProperty.call(obj, k) ? obj[k] : padrao);
const corte = (s, qtd) => Array.from(s).slice(0, qtd).join("");

// campos_br.exibir_documento: formatado se fecha; se não, como veio.
const soNumeros = (v) => String(v || "").replace(/[^0-9]/g, "");
function mascaraCpf(v) {
  const d = soNumeros(v).slice(0, 11);
  if (d.length <= 3) return d;
  if (d.length <= 6) return d.slice(0, 3) + "." + d.slice(3);
  if (d.length <= 9) return d.slice(0, 3) + "." + d.slice(3, 6) + "." + d.slice(6);
  return d.slice(0, 3) + "." + d.slice(3, 6) + "." + d.slice(6, 9) + "-" + d.slice(9);
}
function mascaraCnpj(v) {
  const bruto = documentoNormal(v);
  const c = (bruto.slice(0, 12) + soNumeros(bruto.slice(12))).slice(0, 14);
  if (c.length <= 2) return c;
  if (c.length <= 5) return c.slice(0, 2) + "." + c.slice(2);
  if (c.length <= 8) return c.slice(0, 2) + "." + c.slice(2, 5) + "." + c.slice(5);
  if (c.length <= 12) return c.slice(0, 2) + "." + c.slice(2, 5) + "." + c.slice(5, 8) + "/" + c.slice(8);
  return c.slice(0, 2) + "." + c.slice(2, 5) + "." + c.slice(5, 8) + "/" + c.slice(8, 12) + "-" + c.slice(12);
}
function exibirDocumento(valor) {
  const v = strip(String(valor || ""));
  if (!v) return v;
  const norm = documentoNormal(v);
  const ladoCnpj = norm.length > 11 || /[A-Z]/.test(norm);
  const problema = ladoCnpj ? norm.length < 14 || !cnpjValido(v) : soNumeros(v).length < 11 || !cpfValido(v);
  if (problema) return v;
  return ladoCnpj ? mascaraCnpj(norm) : mascaraCpf(norm);
}

function doc(no) {
  for (const tag of ["CNPJ", "CPF", "NIF"]) {
    const v = t(no, tag);
    if (v) return tag !== "NIF" ? exibirDocumento(v) : v;
  }
  return "-";
}

function dataHora(iso) {
  if (!iso) return "-";
  const k = iso.indexOf("T");
  const d = k < 0 ? iso : iso.slice(0, k);
  const h = k < 0 ? "" : iso.slice(k + 1);
  const p = d.split("-");
  return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` + (h ? " " + corte(h, 8) : "") : iso;
}

/** [endereço, município/UF, IBGE/CEP] de um grupo end/enderNac. */
function endereco(no) {
  if (!no) return ["-", "-", "-"];
  const cmun = t(no, "endNac/cMun") || t(no, "cMun");
  const cep = t(no, "endNac/CEP") || t(no, "CEP");
  const m = municipio(cmun);
  const linha = [t(no, "xLgr"), t(no, "nro"), t(no, "xCpl"), t(no, "xBairro")].filter(Boolean).join(", ");
  return [linha || "-", m ? `${m.nome}/${m.uf}` : cmun || "-", `${cmun || "-"} / ${cep || "-"}`];
}

/** O que vai no DANFSe, tirado só do XML da NFS-e (texto ou bytes). */
export function dadosDoXml(xml) {
  const { raiz } = lerXml(xml);
  anotar(raiz, new Map());
  const inf = raiz._local === "NFSe" && raiz._ns === NS ? achar(raiz, "infNFSe") : null;
  const dps = achar(inf, "DPS/infDPS");
  if (!inf || !dps) throw new Error("o XML não é de uma NFS-e (falta infNFSe/DPS)");
  const prestDps = achar(dps, "prest");
  const emit = achar(inf, "emit");
  const toma = achar(dps, "toma");
  const trib = achar(dps, "valores/trib");
  const val = achar(inf, "valores");
  const ib = achar(inf, "IBSCBS");
  const ibDps = achar(dps, "IBSCBS");
  const idAttr = (inf.attrs.find(([nome]) => nome === "Id") || [])[1] || "";
  const op = t(prestDps, "regTrib/opSimpNac");
  const endEmit = emit ? endereco(achar(emit, "enderNac")) : ["-", "-", "-"];
  const endToma = toma ? endereco(achar(toma, "end")) : ["-", "-", "-"];
  const tpRet = t(trib, "tribFed/piscofins/tpRetPisCofins");
  const ctribnac = t(dps, "serv/cServ/cTribNac");
  const loc = t(dps, "serv/locPrest/cLocPrestacao");
  const mloc = municipio(loc);
  const minc = municipio(t(inf, "cLocIncid"));
  const vLiq = t(val, "vLiq") ? centavosDoXml(t(val, "vLiq")) : 0;
  const vIbs = ib && t(ib, "totCIBS/gIBS/vIBSTot") ? centavosDoXml(t(ib, "totCIBS/gIBS/vIBSTot")) : 0;
  const vCbs = ib && t(ib, "totCIBS/gCBS/vCBS") ? centavosDoXml(t(ib, "totCIBS/gCBS/vCBS")) : 0;
  const totNf = ib ? t(ib, "totCIBS/vTotNF") : "";
  const finNfse = t(ibDps, "finNFSe");
  const cstat = t(inf, "cStat");
  const tt = (caminho, rotulo) => (t(trib, caminho) ? rotulo + " " + pct(t(trib, caminho)) : "");
  return {
    homologacao: t(dps, "tpAmb") === "2",
    municipio_emissor: t(inf, "xLocEmi"),
    chave: Array.from(idAttr).slice(3).join(""),
    numero: t(inf, "nNFSe"),
    competencia: dataHora(t(dps, "dCompet")),
    emissao_nfse: dataHora(t(inf, "dhProc")),
    numero_dps: t(dps, "nDPS"),
    serie_dps: t(dps, "serie"),
    emissao_dps: dataHora(t(dps, "dhEmi")),
    emitente: pega({ 1: "Prestador", 2: "Tomador", 3: "Intermediário" }, t(dps, "tpEmit"), "-"),
    situacao: pega({ 100: "NFS-e gerada", 102: "Gerada por decisão judicial/administrativa" }, cstat, cstat),
    finalidade: finNfse === "" || finNfse === "0" ? "Regular" : finNfse,
    prestador: {
      doc: doc(emit), im: t(emit, "IM") || t(prestDps, "IM") || "-",
      fone: t(emit, "fone") || "-", nome: t(emit, "xNome") || "-",
      municipio: endEmit[1], ibge_cep: endEmit[2], endereco: endEmit[0],
      email: t(emit, "email") || "-",
      simples: pega(dominio("opcao_simples"), op, op || "-"),
      apuracao: pega(dominio("regime_apuracao_sn"), t(prestDps, "regTrib/regApTribSN"), "-"),
    },
    tomador: !toma ? null : {
      doc: doc(toma), im: t(toma, "IM") || "-", fone: t(toma, "fone") || "-",
      nome: t(toma, "xNome") || "-", municipio: endToma[1], ibge_cep: endToma[2],
      endereco: endToma[0], email: t(toma, "email") || "-",
    },
    servico: {
      codigo: Array.from(ctribnac).length === 6 ? `${ctribnac.slice(0, 2)}.${ctribnac.slice(2, 4)}.${ctribnac.slice(4)}` : ctribnac,
      codigo_mun: t(dps, "serv/cServ/cTribMun") || "-",
      nbs: t(dps, "serv/cServ/cNBS") || "-",
      local: loc ? `${mloc ? mloc.nome : loc}/${mloc ? mloc.uf : ""}` : "-",
      descricao_codigo: t(inf, "xTribNac") || pega(DESCRICOES, soNumeros(ctribnac).padStart(6, "0"), "-"),
      descricao: t(dps, "serv/cServ/xDescServ"),
    },
    iss: {
      tributacao: pega(dominio("tributacao_iss"), t(trib, "tribMun/tribISSQN"), "-"),
      incidencia: `${minc ? minc.nome : "-"}/${minc ? minc.uf : ""}`,
      regime_especial: pega(dominio("regime_especial"), t(prestDps, "regTrib/regEspTrib"), "-"),
      bc: r$(t(val, "vBC")), aliquota: pct(t(val, "pAliqAplic")),
      retencao: pega(dominio("retencao_iss"), t(trib, "tribMun/tpRetISSQN"), "-"),
      iss: r$(t(val, "vISSQN")),
      desconto: r$(t(dps, "valores/vDescCondIncond/vDescIncond")),
    },
    federal: {
      irrf: r$(t(trib, "tribFed/vRetIRRF")), cp: r$(t(trib, "tribFed/vRetCP")),
      contribuicoes: r$(t(trib, "tribFed/vRetCSLL")),
      pis: r$(t(trib, "tribFed/piscofins/vPis")), cofins: r$(t(trib, "tribFed/piscofins/vCofins")),
      descricao: tpRet ? pega(dominio("retencao_pis_cofins"), tpRet, "-") : "-",
    },
    ibscbs: !ib ? null : {
      cst: `${t(ibDps, "valores/trib/gIBSCBS/CST")} / ${t(ibDps, "valores/trib/gIBSCBS/cClassTrib")}`,
      indop: `${t(ibDps, "cIndOp")} / ${t(ib, "cLocalidadeIncid")} / ${t(ib, "xLocalidadeIncid")}`,
      bc: r$(t(ib, "valores/vBC")),
      p_ibs_uf: pct(t(ib, "valores/uf/pIBSUF")), p_ibs_mun: pct(t(ib, "valores/mun/pIBSMun")),
      p_ef_uf: pct(t(ib, "valores/uf/pAliqEfetUF")), p_ef_mun: pct(t(ib, "valores/mun/pAliqEfetMun")),
      v_ibs_uf: r$(t(ib, "totCIBS/gIBS/gIBSUFTot/vIBSUF")), v_ibs_mun: r$(t(ib, "totCIBS/gIBS/gIBSMunTot/vIBSMun")),
      v_ibs: r$(t(ib, "totCIBS/gIBS/vIBSTot")), p_cbs: pct(t(ib, "valores/fed/pCBS")),
      p_ef_cbs: pct(t(ib, "valores/fed/pAliqEfetCBS")), v_cbs: r$(t(ib, "totCIBS/gCBS/vCBS")),
    },
    total: {
      servico: r$(t(dps, "valores/vServPrest/vServ")),
      desc_incond: r$(t(dps, "valores/vDescCondIncond/vDescIncond")),
      desc_cond: r$(t(dps, "valores/vDescCondIncond/vDescCond")),
      retencoes: r$(t(val, "vTotalRet")), liquido: r$(t(val, "vLiq")),
      ibscbs: ib ? reais(vIbs + vCbs) : "-",
      liquido_ibscbs: totNf ? r$(totNf) : reais(vLiq),
    },
    complementares: t(dps, "serv/infoCompl/xInfComp"),
    tot_trib: [
      tt("totTrib/pTotTrib/pTotTribFed", "Federal"),
      tt("totTrib/pTotTrib/pTotTribEst", "Estadual"),
      tt("totTrib/pTotTrib/pTotTribMun", "Municipal"),
      tt("totTrib/pTotTribSN", "Simples Nacional"),
    ].filter(Boolean).join(" · "),
    substituida: t(dps, "subst/chSubstda"),
  };
}

// ------------------------------------------------------------ as fontes

// As larguras (milésimos do corpo) dos códigos 32 a 255 no WinAnsi, da
// tabela do reportlab (pdfmetrics.getFont(...).widths): as mesmas do Python.
const LARGURAS = {
  F1: "278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584,350,556,350,222,556,333,1000,556,556,333,1000,667,333,1000,350,611,350,350,222,222,333,333,350,556,1000,333,1000,500,333,944,350,500,667,278,333,556,556,556,556,260,556,333,737,370,556,584,333,737,333,400,584,333,333,333,556,537,278,333,333,365,556,834,834,834,611,667,667,667,667,667,667,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,500,556,556,556,556,278,278,278,278,556,556,556,556,556,556,556,584,611,556,556,556,556,500,556,500",
  F2: "278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584,350,556,350,278,556,500,1000,556,556,333,1000,667,333,1000,350,611,350,350,278,278,500,500,350,556,1000,333,1000,556,333,944,350,500,667,278,333,556,556,556,556,280,556,333,737,370,556,584,333,737,333,400,584,333,333,333,611,556,278,333,333,365,556,834,834,834,611,722,722,722,722,722,722,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,556,556,556,556,556,278,278,278,278,611,611,611,611,611,611,611,584,611,611,611,611,611,556,611,556",
};
const LARG = {};
for (const [f, s] of Object.entries(LARGURAS)) {
  const a = new Uint16Array(256);
  s.split(",").forEach((w, i) => { a[32 + i] = Number(w); });
  LARG[f] = a;
}
const F_NORMAL = "F1";
const F_NEGRITO = "F2";

// Unicode -> código WinAnsi (0x80-0x9F são os do cp1252; o resto é Latin-1).
const CP1252 = { "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85, "†": 0x86, "‡": 0x87, "ˆ": 0x88, "‰": 0x89, "Š": 0x8a, "‹": 0x8b,
  "Œ": 0x8c, "Ž": 0x8e, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "˜": 0x98, "™": 0x99,
  "š": 0x9a, "›": 0x9b, "œ": 0x9c, "ž": 0x9e, "Ÿ": 0x9f };
function codigoDe(ch) {
  const cp = ch.codePointAt(0);
  if ((cp >= 0x20 && cp < 0x7f) || (cp >= 0xa0 && cp <= 0xff)) return cp;
  return CP1252[ch] || 0x3f; // "?"
}
const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

function largura(texto, fonte, tam) {
  const w = LARG[fonte];
  let s = 0;
  for (const ch of texto) s += w[codigoDe(ch)];
  return (s * tam) / 1000;
}

// ------------------------------------------------------------ a página

const CM = 72 / 2.54;
const MM = CM * 0.1;
const A4 = [210 * MM, 297 * MM];
const num = (v) => {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? "0" : String(r);
};

// Os operadores da página, como o canvas do reportlab escreve.
class Tela {
  constructor() {
    this.ops = [];
  }
  larguraLinha(w) { this.ops.push(`${num(w)} w`); }
  corFundo(r, g, b) { this.ops.push(`${num(r)} ${num(g)} ${num(b)} rg`); }
  // fill e stroke como o c.rect(x, y, w, h, fill=, stroke=)
  ret(x, y, w, h, preencher = false, tracar = true) {
    if (!preencher && !tracar) return;
    this.ops.push(`${num(x)} ${num(y)} ${num(w)} ${num(h)} re ${preencher && tracar ? "B" : preencher ? "f" : "S"}`);
  }
  escrever(x, y, texto, fonte, tam) {
    let hex = "";
    for (const ch of String(texto)) hex += HEX[codigoDe(ch)];
    this.ops.push(`BT /${fonte} ${num(tam)} Tf 1 0 0 1 ${num(x)} ${num(y)} Tm <${hex}> Tj ET`);
  }
  centro(x, y, texto, fonte, tam) { this.escrever(x - largura(String(texto), fonte, tam) / 2, y, texto, fonte, tam); }
  direita(x, y, texto, fonte, tam) { this.escrever(x - largura(String(texto), fonte, tam), y, texto, fonte, tam); }
  imagem(nome, x, y, w, h) { this.ops.push(`q ${num(w)} 0 0 ${num(h)} ${num(x)} ${num(y)} cm /${nome} Do Q`); }
}

// As palavras como o str.split() do Python.
const palavrasDe = (s) => juntarEspacos(s).split(" ").filter(Boolean);

// O QR como o QrCodeWidget do reportlab: borda de 4 módulos, cada corrida
// de módulos escuros de uma linha num retângulo só.
function desenharQr(c, texto, x, y, lado) {
  const { n: qtd, modulos } = matrizQr(texto);
  const u = lado / (qtd + 8);
  c.corFundo(0, 0, 0);
  for (let r = 0; r < qtd; r++) {
    let col = 0;
    while (col < qtd) {
      const v = modulos[r * qtd + col];
      let fim = col;
      while (fim < qtd && modulos[r * qtd + fim] === v) fim++;
      if (v) c.ret(x + (col + 4) * u, y + lado - (r + 5) * u, (fim - col) * u, u, true, false);
      col = fim;
    }
  }
}

/** Desenha o DANFSe dos dados (dadosDoXml) e devolve os operadores da página. */
function desenhar(d) {
  const c = new Tela();
  const [larg, alt] = A4;
  const m = 0.2 * CM;
  const x0 = m;
  const x1 = larg - m;
  let y = alt - m;
  c.larguraLinha(1);
  c.ret(m, m, larg - 2 * m, alt - 2 * m);
  const cinza = [0.95, 0.95, 0.95];

  const corta = (texto, fonte, tam, w) => {
    const s = String(texto || "-");
    if (largura(s, fonte, tam) <= w) return s;
    let cps = Array.from(s);
    while (cps.length && largura(cps.join("") + "...", fonte, tam) > w) cps = cps.slice(0, -1);
    return cps.join("") + "...";
  };

  const tituloBloco = (texto) => {
    const h = 10;
    c.corFundo(...cinza);
    c.larguraLinha(0.5);
    c.ret(x0, y - h, x1 - x0, h, true, true);
    c.corFundo(0, 0, 0);
    c.escrever(x0 + 3, y - 7.5, texto.toUpperCase(), F_NEGRITO, 7);
    y -= h;
  };

  const linhaCampos = (campos, larguras = null, h = 17, sombra = null) => {
    const total = x1 - x0;
    const fr = larguras || campos.map(() => 1 / campos.length);
    let x = x0;
    c.larguraLinha(0.5);
    campos.forEach(([rot, val], i) => {
      const w = total * fr[i];
      if (sombra && sombra.has(i)) {
        c.corFundo(...cinza);
        c.ret(x, y - h, w, h, true, false);
        c.corFundo(0, 0, 0);
      }
      c.ret(x, y - h, w, h);
      c.escrever(x + 2, y - 6.5, corta(rot, F_NEGRITO, 6, w - 4), F_NEGRITO, 6);
      c.escrever(x + 2, y - 14.5, corta(val, F_NORMAL, 7, w - 4), F_NORMAL, 7);
      x += w;
    });
    y -= h;
  };

  const textoBloco = (texto, h) => {
    c.larguraLinha(0.5);
    c.ret(x0, y - h, x1 - x0, h);
    let linhas = [];
    let atual = "";
    for (const palavra of palavrasDe(String(texto || "-"))) {
      const teste = strip(atual + " " + palavra);
      if (largura(teste, F_NORMAL, 7) > x1 - x0 - 6) {
        linhas.push(atual);
        atual = palavra;
      } else atual = teste;
    }
    linhas.push(atual);
    const maximo = Math.max(1, Math.floor((h - 4) / 8.5));
    if (linhas.length > maximo) {
      linhas = linhas.slice(0, maximo);
      linhas[linhas.length - 1] = corta(linhas[linhas.length - 1] + " ...", F_NORMAL, 7, x1 - x0 - 6);
    }
    linhas.forEach((l, i) => c.escrever(x0 + 3, y - 8 - i * 8.5, l, F_NORMAL, 7));
    y -= h;
  };

  // --- cabeçalho
  const hc = 1.3 * CM;
  c.corFundo(...cinza);
  c.ret(x0, y - hc, x1 - x0, hc, true, true);
  c.corFundo(0, 0, 0);
  // A logomarca oficial da NFS-e à esquerda (NT 008, §2.1), 0,9 cm de altura.
  const hl = 0.9 * CM;
  c.imagem("LogoNFSe", x0 + 4, y - 1.1 * CM, (hl * LOGO_NFSE.largura) / LOGO_NFSE.altura, hl);
  c.centro(larg / 2, y - 0.5 * CM, "DANFSe v2.0", F_NEGRITO, 9);
  c.centro(larg / 2, y - 0.85 * CM, "Documento Auxiliar da NFS-e", F_NEGRITO, 9);
  if (d.homologacao) c.centro(larg / 2, y - 1.15 * CM, "NFS-e SEM VALIDADE JURÍDICA", F_NEGRITO, 8);
  c.direita(x1 - 4, y - 0.45 * CM, d.municipio_emissor || "", F_NORMAL, 8);
  c.direita(x1 - 4, y - 0.75 * CM, "Ambiente gerador: Sistema Nacional NFS-e", F_NORMAL, 6);
  c.direita(x1 - 4, y - 1.0 * CM, d.homologacao ? "Produção restrita (homologação)" : "Produção", F_NORMAL, 6);
  y -= hc;

  // --- identificação + QR
  const topo = y;
  const qrLado = 2.4 * CM;
  const colunaQr = 3.8 * CM;
  const wCampos = (x1 - x0 - colunaQr) / (x1 - x0);
  linhaCampos([["CHAVE DE ACESSO DA NFS-E", d.chave]], [wCampos]);
  linhaCampos([["NÚMERO DA NFS-E", d.numero], ["COMPETÊNCIA DA NFS-E", d.competencia],
    ["DATA E HORA DA EMISSÃO DA NFS-E", d.emissao_nfse]], [0.3, 0.3, 0.4].map((f) => wCampos * f));
  linhaCampos([["NÚMERO DA DPS", d.numero_dps], ["SÉRIE DA DPS", d.serie_dps],
    ["DATA E HORA DA EMISSÃO DA DPS", d.emissao_dps]], [0.3, 0.3, 0.4].map((f) => wCampos * f));
  linhaCampos([["EMITENTE DA NFS-E", d.emitente], ["SITUAÇÃO DA NFS-E", d.situacao],
    ["FINALIDADE", d.finalidade]], [0.3, 0.4, 0.3].map((f) => wCampos * f), 17, new Set([0]));
  const centroQr = x1 - colunaQr / 2;
  desenharQr(c, urlQr(d.chave), centroQr - qrLado / 2, topo - qrLado - 0.05 * CM, qrLado);
  ["A autenticidade desta NFS-e pode ser verificada",
    "pela leitura deste código QR ou pela consulta da",
    "chave de acesso no portal nacional da NFS-e"].forEach((txt, i) => c.centro(centroQr, topo - qrLado - 7 - i * 6, txt, F_NORMAL, 5));
  y = Math.min(y, topo - qrLado - 22);

  // --- prestador
  const p = d.prestador;
  tituloBloco("Prestador / Fornecedor");
  linhaCampos([["CNPJ / CPF / NIF", p.doc], ["Inscrição Municipal", p.im], ["Telefone", p.fone]], [0.4, 0.3, 0.3]);
  linhaCampos([["Nome / Nome Empresarial", p.nome], ["Município / UF", p.municipio], ["Código IBGE / CEP", p.ibge_cep]], [0.5, 0.25, 0.25]);
  linhaCampos([["Endereço", p.endereco], ["E-mail", p.email]], [0.6, 0.4]);
  linhaCampos([["Simples Nacional na Data de Competência", p.simples], ["Regime de Apuração Tributária pelo SN", p.apuracao]], [0.5, 0.5]);

  // --- tomador, destinatário, intermediário
  tituloBloco("Tomador / Adquirente da Operação");
  const tm = d.tomador;
  if (tm) {
    linhaCampos([["CNPJ / CPF / NIF", tm.doc], ["Inscrição Municipal", tm.im], ["Telefone", tm.fone]], [0.4, 0.3, 0.3]);
    linhaCampos([["Nome / Nome Empresarial", tm.nome], ["Município / UF", tm.municipio], ["Código IBGE / CEP", tm.ibge_cep]], [0.5, 0.25, 0.25]);
    linhaCampos([["Endereço", tm.endereco], ["E-mail", tm.email]], [0.6, 0.4]);
  } else {
    textoBloco("TOMADOR/ADQUIRENTE DA OPERAÇÃO NÃO IDENTIFICADO NA NFS-e", 12);
  }
  tituloBloco("Destinatário da Operação");
  textoBloco("O DESTINATÁRIO É O PRÓPRIO TOMADOR/ADQUIRENTE DA OPERAÇÃO", 12);
  tituloBloco("Intermediário da Operação");
  textoBloco("INTERMEDIÁRIO DA OPERAÇÃO NÃO IDENTIFICADO NA NFS-e", 12);

  // --- serviço
  const s = d.servico;
  tituloBloco("Serviço Prestado");
  linhaCampos([["Código de Tributação Nacional / Municipal", `${s.codigo} / ${s.codigo_mun}`], ["Código da NBS", s.nbs],
    ["Local da Prestação", s.local]], [0.4, 0.25, 0.35]);
  linhaCampos([["Descrição do Código de Tributação Nacional", s.descricao_codigo]]);
  tituloBloco("Descrição do Serviço");
  textoBloco(s.descricao, 52);

  // --- ISSQN
  const i = d.iss;
  tituloBloco("Tributação Municipal (ISSQN)");
  linhaCampos([["Tipo de Tributação do ISSQN", i.tributacao], ["Município de Incidência do ISSQN", i.incidencia],
    ["Regime Especial de Tributação", i.regime_especial]], [0.3, 0.35, 0.35]);
  linhaCampos([["Desconto Incondicionado", i.desconto], ["BC ISSQN", i.bc], ["Alíquota Aplicada", i.aliquota],
    ["Retenção do ISSQN", i.retencao], ["ISSQN Apurado", i.iss]], [0.2, 0.2, 0.15, 0.25, 0.2]);

  // --- federal
  const f = d.federal;
  tituloBloco("Tributação Federal (exceto CBS)");
  linhaCampos([["IRRF", f.irrf], ["Contribuição Previdenciária - Retida", f.cp], ["Contribuições Sociais - Retidas", f.contribuicoes],
    ["PIS - Débito Apuração Própria", f.pis], ["COFINS - Débito Apuração Própria", f.cofins]]);
  linhaCampos([["Descrição das Contribuições Sociais - Retidas", f.descricao]]);

  // --- IBS/CBS
  tituloBloco("Tributação IBS / CBS");
  const ib = d.ibscbs;
  if (ib) {
    linhaCampos([["CST / cClassTrib", ib.cst], ["Indicador de Operação / IBGE / Município de Incidência", ib.indop],
      ["Base de Cálculo Após Exclusões e Reduções", ib.bc]], [0.2, 0.5, 0.3]);
    linhaCampos([["Alíquota IBS Estadual / Municipal", `${ib.p_ibs_uf} / ${ib.p_ibs_mun}`],
      ["Alíq. Efetiva IBS Estadual", ib.p_ef_uf], ["Valor IBS Estadual", ib.v_ibs_uf],
      ["Alíq. Efetiva IBS Municipal", ib.p_ef_mun], ["Valor IBS Municipal", ib.v_ibs_mun]]);
    linhaCampos([["Valor Total Apurado do IBS", ib.v_ibs], ["Alíquota da CBS", ib.p_cbs],
      ["Alíquota Efetiva da CBS", ib.p_ef_cbs], ["Valor Total Apurado da CBS", ib.v_cbs]]);
  } else {
    textoBloco("Sem o grupo IBS/CBS nesta NFS-e.", 12);
  }

  // --- total
  const tt = d.total;
  tituloBloco("Valor Total da NFS-e");
  linhaCampos([["Valor da Operação / Serviço", tt.servico], ["Desconto Incondicionado", tt.desc_incond],
    ["Desconto Condicionado", tt.desc_cond], ["Total das Retenções (ISSQN / Federais)", tt.retencoes]]);
  linhaCampos([["Valor Líquido da NFS-e", tt.liquido], ["Total do IBS/CBS", tt.ibscbs],
    ["Valor Líquido da NFS-e + IBS/CBS", tt.liquido_ibscbs]], [0.35, 0.3, 0.35], 17, new Set([2]));

  // --- complementares
  tituloBloco("Informações Complementares");
  const extra = [];
  if (d.substituida) extra.push(`Substitui a NFS-e de chave ${d.substituida}.`);
  if (d.complementares) extra.push(d.complementares);
  if (d.tot_trib) extra.push("Totais aproximados dos tributos (Lei 12.741/2012): " + d.tot_trib);
  textoBloco(extra.join(" ") || "-", Math.max(30, y - m - 6));
  return c.ops.join("\n");
}

// "15/09/2026 10:31:07" -> a data da nota (Brasília), para o PDF não mudar a cada geração.
function dataDaNota(d) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}:\d{2}:\d{2})$/.exec(d.emissao_nfse || "");
  const ms = m ? Date.parse(`${m[3]}-${m[2]}-${m[1]}T${m[4]}-03:00`) : NaN;
  return new Date(Number.isFinite(ms) ? ms : 0);
}

let _logo = null;
function logoBytes() {
  if (!_logo) _logo = Uint8Array.from(atob(LOGO_NFSE.b64), (ch) => ch.charCodeAt(0));
  return _logo;
}

/**
 * O PDF do DANFSe (uma página A4), do XML da NFS-e (texto ou bytes).
 * Devolve Uint8Array. O mesmo XML dá sempre o mesmo PDF.
 */
export async function gerarDanfse(xml) {
  const d = dadosDoXml(xml);
  const conteudo = desenhar(d);
  const pdf = await PDFDocument.create({ updateMetadata: false });
  pdf.setTitle(`DANFSe ${d.numero} - ${d.chave}`);
  pdf.setAuthor("PAULUS Legal");
  pdf.setProducer("PAULUS");
  pdf.setCreator("PAULUS");
  const quando = dataDaNota(d);
  pdf.setCreationDate(quando);
  pdf.setModificationDate(quando);
  const pag = pdf.addPage(A4);
  const ctx = pdf.context;
  for (const [nome, base] of [[F_NORMAL, "Helvetica"], [F_NEGRITO, "Helvetica-Bold"]]) {
    const ref = ctx.register(ctx.obj({ Type: "Font", Subtype: "Type1", BaseFont: base, Encoding: "WinAnsiEncoding" }));
    pag.node.setFontDictionary(PDFName.of(nome), ref);
  }
  const logo = await pdf.embedJpg(logoBytes());
  pag.node.setXObject(PDFName.of("LogoNFSe"), logo.ref);
  pag.node.addContentStream(ctx.register(ctx.stream(conteudo)));
  return pdf.save({ useObjectStreams: false });
}
