// A Sefin Nacional de mentira, SÓ PARA TESTE (worker/teste-nfse-emissor.mjs).
// Porte de paulus/legal/tests/_sefin_simulada.py: sucesso com a NFS-e;
// rejeição com a lista `erros`; E0014 para a DPS que já gerou nota; tempo
// esgotado antes e depois de gerar; 503 depois de gerar; servidor fora; e os
// eventos (cancelamento, por substituição, fora do prazo).
//
// Atende como o Worker auxiliar do mTLS: recebe o pedido com o destino em
// x-nfse-url (env.SEFIN_MTLS = { fetch: sim.fetch }).
// A NFS-e devolvida não é assinada (o Python só assina com pfx_sefin).

import { deGzipB64, gzipB64 } from "./gzip.js";
import { anexar, lerXml, novo, serializar } from "./xml.js";

const NS = "http://www.sped.fazenda.gov.br/nfse";

function filho(el, nome) {
  return el ? el.filhos.find((f) => f.tipo === "el" && f.nome === nome) || null : null;
}
function txt(el, ...nomes) {
  let e = el;
  for (const n of nomes) e = filho(e, n);
  return e ? e.filhos.filter((f) => f.tipo === "texto").map((f) => f.texto).join("") : "";
}
const cx = (t) => {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(t || "").trim());
  return m ? Number(m[1]) * 100 + Number(((m[2] || "") + "00").slice(0, 2)) : 0;
};
const fmt = (c) => (c ? `${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}` : "0");
const sub = (pai, nome, texto) => anexar(pai, novo(nome, texto === undefined ? {} : { texto: String(texto) }));
const dh = () => new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 19) + "-03:00";

export class SefinSimulada {
  constructor(modos = "sucesso") {
    this.modos = Array.isArray(modos) ? [...modos] : [modos];
    this.geradas = new Map(); // idDps -> {chave, xml}
    this.recebidas = new Map(); // idDps -> n
    this.eventos = new Map(); // chave -> [{tipo, xml}]
    this.pedidosEvento = new Map();
    this.numero = 0;
    this.pedidos = [];
    this.convenio = { situacaoConvenio: "Ativo", permiteEmissorNacional: true, prazoCancelamentoDias: 30 };
    this.fetch = (req, init) => this.atender(req instanceof Request ? req : new Request(req, init));
  }

  usar(modos) {
    this.modos = Array.isArray(modos) ? [...modos] : [modos];
  }

  modo() {
    return this.modos.length > 1 ? this.modos.shift() : this.modos[0];
  }

  montarNfse(dps, numero) {
    const inf = filho(dps, "infDPS");
    const cmun = txt(inf, "cLocEmi");
    const cnpj = txt(inf, "prest", "CNPJ");
    const doc = cnpj || txt(inf, "prest", "CPF").padStart(14, "0");
    const tipo = cnpj ? "2" : "1";
    const agora = new Date();
    const aamm = String(agora.getUTCFullYear()).slice(2) + String(agora.getUTCMonth() + 1).padStart(2, "0");
    const chave = `${cmun}2${tipo}${doc}${String(numero).padStart(13, "0")}${aamm}${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}0`;
    const nfse = novo("NFSe", { decls: [["", NS]], attrs: [["versao", "1.01"]] });
    const i = anexar(nfse, novo("infNFSe", { attrs: [["Id", "NFS" + chave]] }));
    sub(i, "xLocEmi", "Goiânia");
    sub(i, "xLocPrestacao", "Goiânia");
    sub(i, "nNFSe", numero);
    sub(i, "cLocIncid", txt(inf, "serv", "locPrest", "cLocPrestacao") || cmun);
    sub(i, "xLocIncid", "Goiânia");
    sub(i, "xTribNac", "Serviço");
    sub(i, "verAplic", "SefinSimulada-1.0");
    sub(i, "ambGer", "2");
    sub(i, "tpEmis", "1");
    sub(i, "procEmi", "1");
    sub(i, "cStat", "100");
    sub(i, "dhProc", dh());
    sub(i, "nDFSe", numero);
    const cent = cx(txt(inf, "valores", "vServPrest", "vServ"));
    const desc = cx(txt(inf, "valores", "vDescCondIncond", "vDescIncond"));
    const base = cent - desc;
    const iss = Math.floor((base * 500 + 5000) / 10000);
    let ret = 0;
    for (const c of ["vRetIRRF", "vRetCSLL", "vRetCP"]) ret += cx(txt(inf, "valores", "trib", "tribFed", c));
    if (txt(inf, "valores", "trib", "tribMun", "tpRetISSQN") === "2") ret += iss;
    const v = sub(i, "valores");
    sub(v, "vBC", fmt(base));
    sub(v, "pAliqAplic", "5.00");
    sub(v, "vISSQN", fmt(iss));
    sub(v, "vTotalRet", fmt(ret));
    sub(v, "vLiq", fmt(cent - desc - ret));
    anexar(i, dps);
    return { xml: serializar(nfse), chave };
  }

  montarEvento(pedido, seq = 1) {
    const inf = filho(pedido, "infPedReg");
    const id = (inf.attrs.find(([n]) => n === "Id") || [])[1] || "";
    const ident = "EVT" + id.slice(3) + String(seq).padStart(3, "0");
    const ev = novo("evento", { decls: [["", NS]], attrs: [["versao", "1.01"]] });
    const i = anexar(ev, novo("infEvento", { attrs: [["Id", ident]] }));
    sub(i, "verAplic", "SefinSimulada-1.0");
    sub(i, "ambGer", "2");
    sub(i, "nSeqEvento", String(seq).padStart(3, "0"));
    sub(i, "dhProc", dh());
    sub(i, "nDFSe", seq);
    pedido.decls = [];
    anexar(i, pedido);
    return serializar(ev);
  }

  async resposta(status, corpo) {
    return new Response(corpo === undefined ? null : JSON.stringify(corpo), { status, headers: { "content-type": "application/json" } });
  }

  async registrarEvento(chave, xml, tipo) {
    const lista = this.eventos.get(chave) || [];
    lista.push({ tipo, xml: await gzipB64(xml) });
    this.eventos.set(chave, lista);
  }

  chaveGerada(chave) {
    return [...this.geradas.values()].some((g) => g.chave === chave);
  }

  async atender(req) {
    const url = req.headers.get("x-nfse-url") || req.url;
    const metodo = req.method;
    this.pedidos.push([metodo, url]);
    const caminho = url.includes("SefinNacional") ? url.split("SefinNacional")[1] : url.split("nfse.gov.br")[1] || url;
    const modo = this.modo();
    if (modo === "fora") return new Response("destino fora do ar", { status: 502, headers: { "x-nfse-nao-chegou": "1" } });
    if (metodo === "POST" && caminho.endsWith("/nfse")) {
      const corpo = await req.json();
      const dpsXml = new TextDecoder().decode(await deGzipB64(corpo.dpsXmlGZipB64));
      const { raiz } = lerXml(dpsXml);
      const ident = (filho(raiz, "infDPS").attrs.find(([n]) => n === "Id") || [])[1];
      this.recebidas.set(ident, (this.recebidas.get(ident) || 0) + 1);
      if (modo === "timeout_antes") throw Object.assign(new Error("tempo esgotado (simulado, antes de gerar)"), { name: "TimeoutError" });
      if (modo === "rejeicao") return this.resposta(400, { erros: [{ Codigo: "E0595", Descricao: "Não é permitido informar alíquota superior a 5%." }] });
      if (this.geradas.has(ident)) return this.resposta(400, { erros: [{ Codigo: "E0014", Descricao: "Conjunto de Série, Número, ... já existe" }] });
      this.numero += 1;
      const { xml, chave } = this.montarNfse(raiz, this.numero);
      const b = await gzipB64(xml);
      this.geradas.set(ident, { chave, xml: b });
      const subst = txt(filho(raiz, "infDPS"), "subst", "chSubstda");
      if (subst) {
        const ped = novo("pedRegEvento", { decls: [["", NS]], attrs: [["versao", "1.01"]] });
        const ip = anexar(ped, novo("infPedReg", { attrs: [["Id", "PRE" + subst + "105102"]] }));
        const ev = anexar(ip, novo("e105102"));
        sub(ev, "xDesc", "Cancelamento de NFS-e por Substituição");
        sub(ev, "chSubstituta", chave);
        await this.registrarEvento(subst, this.montarEvento(ped), "105102");
      }
      if (modo === "timeout_depois") throw Object.assign(new Error("tempo esgotado (simulado, depois de gerar)"), { name: "TimeoutError" });
      if (modo === "erro500_depois") return new Response("Service Unavailable", { status: 503 });
      return this.resposta(201, { chaveAcesso: chave, nfseXmlGZipB64: b, idDps: ident, alertas: [] });
    }
    if (caminho.startsWith("/dps/")) {
      const ident = caminho.split("/").pop();
      // "nao_acha": a consulta ainda não enxerga a nota gerada (índice atrasado).
      const g = modo === "nao_acha" ? null : this.geradas.get(ident);
      if (metodo === "HEAD") return new Response(null, { status: g ? 200 : 404 });
      return g ? this.resposta(200, { chaveAcesso: g.chave }) : this.resposta(404, { erros: [{ Codigo: "E2001", Descricao: "não encontrada" }] });
    }
    if (metodo === "GET" && caminho.startsWith("/nfse/") && !caminho.includes("/eventos")) {
      const chave = caminho.split("/").pop();
      for (const g of this.geradas.values()) if (g.chave === chave) return this.resposta(200, { chaveAcesso: chave, nfseXmlGZipB64: g.xml });
      return new Response(null, { status: 404 });
    }
    if (caminho.includes("/eventos")) {
      const partes = caminho.replace(/^\/+/, "").split("/");
      const chave = partes[1];
      if (metodo === "POST") {
        const corpo = await req.json();
        const { raiz } = lerXml(new TextDecoder().decode(await deGzipB64(corpo.pedidoRegistroEventoXmlGZipB64)));
        const inf = filho(raiz, "infPedReg");
        const tipo = inf.filhos.find((f) => f.tipo === "el" && /^e\d+$/.test(f.nome)).nome.slice(1);
        this.pedidosEvento.set(chave + tipo, (this.pedidosEvento.get(chave + tipo) || 0) + 1);
        if (!this.chaveGerada(chave)) return this.resposta(400, { erros: [{ Codigo: "E0820", Descricao: "NFS-e não encontrada" }] });
        if (modo === "fora_do_prazo" && tipo === "101101") return this.resposta(400, { erros: [{ Codigo: "E0822", Descricao: "O prazo para o cancelamento da NFS-e expirou" }] });
        if (modo === "timeout_antes") throw Object.assign(new Error("sem resposta (simulado)"), { name: "TimeoutError" });
        if ((this.eventos.get(chave) || []).some((x) => ["101101", "105102"].includes(x.tipo))) {
          return this.resposta(400, { erros: [{ Codigo: "E0840", Descricao: "Já existe evento de cancelamento vinculado" }] });
        }
        const xml = this.montarEvento(raiz);
        await this.registrarEvento(chave, xml, tipo);
        if (modo === "timeout_depois") throw Object.assign(new Error("sem resposta (simulado)"), { name: "TimeoutError" });
        return this.resposta(201, { eventoXmlGZipB64: await gzipB64(xml) });
      }
      const tipo = partes[3] || "";
      const achados = (this.eventos.get(chave) || []).filter((x) => !tipo || x.tipo === tipo);
      if (!achados.length) return new Response(null, { status: 404 });
      return this.resposta(200, { eventos: achados.map((x) => ({ eventoXmlGZipB64: x.xml })) });
    }
    if (caminho.includes("/parametros_municipais/") && caminho.endsWith("/convenio")) return this.resposta(200, this.convenio);
    return new Response("rota não simulada", { status: 404 });
  }
}
