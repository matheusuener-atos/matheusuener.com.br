// Teste das funcoes das notas do cliente (worker/nfse-casa.js) e das rotas do
// app do cliente (/api/ia/nfse em worker/ia.js), sem rede:
//   node worker/teste-nfse-casa.mjs
// A antiga ponte com o PAULUS da casa (/api/nfse-casa/*) saiu em 03/10/2026:
// confere que a rota responde 404. A emissao pelo painel esta em
// worker/teste-nfse-admin.mjs.
import worker from "./index.js";
import { ContaIA, numeros } from "./ia.js";
import {
  avisarNotaCancelada, faltasDoTomador, gravarTomador, guardarNotaDoCliente, listarClientes, listarPagamentos,
} from "./nfse-casa.js";

let falhas = 0;
const checar = (ok, descricao, detalhe) => {
  console.log((ok ? "  ok   " : "  FALHA ") + descricao + (ok || detalhe === undefined ? "" : " -> " + JSON.stringify(detalhe)));
  if (!ok) falhas++;
};

const guardados = new Map();
const APOIOS = {
  get: async (k) => (guardados.has(k) ? guardados.get(k) : null),
  put: async (k, v) => { guardados.set(k, v); },
  delete: async (k) => { guardados.delete(k); },
  list: async ({ prefix }) => ({ list_complete: true, keys: [...guardados.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }),
};
const relogio = Date.parse("2026-10-03T15:00:00Z");
const objetos = new Map();
const CONTAS_IA = {
  idFromName: (n) => n,
  get: (n) => ({
    fetch: (url, init) => {
      if (!objetos.has(n)) {
        const dados = new Map();
        const o = new ContaIA({ storage: { get: async (k) => structuredClone(dados.get(k)), put: async (k, v) => { dados.set(k, structuredClone(v)); } } }, { APOIOS });
        o.agora = () => relogio;
        objetos.set(n, o);
      }
      return objetos.get(n).fetch(new Request(url, init));
    },
  }),
};
const env = {
  IA_ATIVA: "1", CONTAS_IA, APOIOS, DEEPINFRA_KEY: "k", GOOGLE_CLIENT_IDS: "cid",
  ASSETS: { fetch: async () => new Response("site", { status: 200 }) },
};
const ctx = { waitUntil() {} };
const segredo = (id) => "pia_" + id + "_" + id.slice(0, 1).repeat(64);

async function doDe(id, acao, dados = {}) {
  const r = await CONTAS_IA.get(id).fetch("https://conta-ia/" + acao, { method: "POST", body: JSON.stringify({ acao, ...dados, numeros: numeros({}) }) });
  return r.json();
}
const ID_ANA = "a".repeat(24);
const ID_BRUNO = "b".repeat(24);
const sha = async (t) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)))].map((b) => b.toString(16).padStart(2, "0")).join("");
for (const [id, nome] of [[ID_ANA, "ana"], [ID_BRUNO, "bruno"]]) {
  await doDe(id, "ativar", { id, dono: { sub: nome, email: nome + "@escritorio.com.br" }, nome: "Escritório " + nome, instalacao: "inst-" + nome + "-123", hash: await sha(segredo(id)) });
}
await doDe(ID_ANA, "cadastro", { cadastro: { nome_escritorio: "Ana Advocacia", documento: "52998224725", telefone: "91988887777", oab: "PA 12345", termos: "x",
  endereco: { cep: "66010000", logradouro: "Rua dos Mundurucus", numero: "1500", complemento: "Sala 3", bairro: "Batista Campos", cidade: "Belém", uf: "PA", cmun: "1501402" } } });
guardados.set("admin:nfse:PAY1", JSON.stringify({ id: "PAY1", conta: ID_ANA, tipo: "mensalidade", valor: 300, quando: "2026-10-02T10:00:00Z", nota: "pendente" }));
guardados.set("admin:nfse:PAY2", JSON.stringify({ id: "PAY2", conta: ID_BRUNO, tipo: "recarga pix", valor: 50, quando: "2026-10-03T10:00:00Z", nota: "pendente", motivo: "falta CEP" }));

// ------------------------------------------------------------ a ponte saiu
console.log("a ponte antiga saiu");
for (const caminho of ["/api/nfse-casa/ping", "/api/nfse-casa/clientes", "/api/nfse-casa/pagamentos"]) {
  const r = await worker.fetch(new Request("https://paulus.ia.br" + caminho, { headers: { authorization: "Bearer " + segredo(ID_ANA) } }), env, ctx);
  checar(r.status === 404, caminho + ": 404 (a emissão é pelo painel)");
}
const r0 = await worker.fetch(new Request("https://paulus.ia.br/api/nfse-casa/notas", { method: "POST", body: "{}" }), env, ctx);
checar(r0.status === 404, "POST /api/nfse-casa/notas: 404");

// ------------------------------------------------------------ clientes
console.log("clientes");
let clientes = await listarClientes(env);
const ana = clientes.find((c) => c.id === ID_ANA);
checar(clientes.length === 2 && ana.tomador.nome === "Ana Advocacia" && ana.tomador.documento === "52998224725" && ana.tomador.email === "ana@escritorio.com.br" && ana.oab === "PA 12345" && ana.tomador.telefone === "91988887777", "clientes: tomador vem do cadastro", ana);
checar(ana.tomador.logradouro === "Rua dos Mundurucus" && ana.tomador.numero === "1500" && ana.tomador.complemento === "Sala 3" && ana.tomador.bairro === "Batista Campos"
  && ana.tomador.cep === "66010000" && ana.tomador.cmun === "1501402" && ana.tomador.uf === "PA" && ana.faltas.length === 0, "o endereco do cadastro vai no tomador; nada falta", ana.tomador);
const bruno = clientes.find((c) => c.id === ID_BRUNO);
checar(bruno.tomador.logradouro === "" && bruno.tomador.cep === "" && bruno.faltas.includes("CEP") && bruno.faltas.includes("CPF/CNPJ") && bruno.faltas.includes("município (IBGE)"),
  "conta sem endereco: o que falta para a nota aparece", bruno.faltas);
checar(faltasDoTomador({ ...ana.tomador, documento: "52998224726" }).includes("CPF/CNPJ válido"), "CPF com digito errado conta como falta");
let g = await gravarTomador(env, ID_ANA, { documento: "123" });
checar(g.status === 400 && g.corpo.erro.includes("CPF ou CNPJ"), "documento com digito errado: 400");
g = await gravarTomador(env, ID_ANA, { cep: "6600" });
checar(g.status === 400, "CEP curto: 400");
g = await gravarTomador(env, ID_ANA, { cmun: "150140" });
checar(g.status === 400, "cMun com 6 digitos: 400");
g = await gravarTomador(env, ID_ANA, { uf: "XX" });
checar(g.status === 400, "UF inexistente: 400");
g = await gravarTomador(env, ID_ANA, { email: "sem-arroba" });
checar(g.status === 400, "e-mail sem @: 400");
g = await gravarTomador(env, "c".repeat(24), { uf: "PA" });
checar(g.status === 404, "conta inexistente: 404");
g = await gravarTomador(env, ID_ANA, { documento: "11.222.333/0001-81", nome: "  Ana   Advocacia\u0000 S/S  ", cep: "66.010-000", cmun: "1501402", uf: "pa", logradouro: "Av. Presidente Vargas", numero: "100", bairro: "Campina" });
checar(g.status === 200 && g.corpo.tomador.documento === "11222333000181" && g.corpo.tomador.nome === "Ana Advocacia S/S" && g.corpo.tomador.cep === "66010000" && g.corpo.tomador.uf === "PA" && g.corpo.tomador.email === "ana@escritorio.com.br",
  "override gravado, limpo, e funde com o cadastro", g.corpo.tomador);
checar((await doDe(ID_ANA, "ler_cadastro")).cadastro.documento === "52998224725", "o cadastro original da conta nao muda");
clientes = await listarClientes(env);
const anaDepois = clientes.find((c) => c.id === ID_ANA).tomador;
checar(anaDepois.documento === "11222333000181" && anaDepois.logradouro === "Av. Presidente Vargas" && anaDepois.complemento === "Sala 3",
  "o override vence o cadastro (e o que nao foi corrigido continua o do cadastro)", anaDepois);

// ------------------------------------------------------------ pagamentos e notas
console.log("notas");
const pg = await listarPagamentos(env);
checar(pg.pagamentos.length === 2 && pg.pagamentos[0].id === "PAY2" && pg.pagamentos[0].motivo === "falta CEP" && pg.pagamentos[1].cliente === "Ana Advocacia" && pg.config.mail === false,
  "pagamentos: mais novos primeiro, com o cliente e o motivo", pg);
const pdf = Buffer.from("%PDF-1.4 nota da Ana").toString("base64");
const xml = Buffer.from("<NFSe><nNFSe>42</nNFSe></NFSe>").toString("base64");
const nota = { id: "n-1", conta: ID_ANA, pagamento: "PAY1", numero: "42", chave: "1501402" + "9".repeat(43), competencia: "2026-10", valor: 300, descricao: "Licença do PAVLVS - outubro", ambiente: "producao_restrita", emitida_em: "2026-10-03T12:00:00Z", pdf_b64: pdf, xml_b64: xml };
let x = await guardarNotaDoCliente(env, { ...nota, competencia: "10/2026" });
checar(x.status === 400, "competencia fora de AAAA-MM: 400");
x = await guardarNotaDoCliente(env, { ...nota, pdf_b64: Buffer.alloc(2 * 1024 * 1024 + 10).toString("base64") });
checar(x.status === 413, "arquivo acima de 2 MB: 413");
x = await guardarNotaDoCliente(env, nota);
checar(x.status === 200 && x.corpo.ok && JSON.parse(guardados.get("admin:nfse:PAY1")).nota === "emitida", "nota guardada e o pagamento marcado emitida", x);
x = await guardarNotaDoCliente(env, { ...nota, numero: "43", pdf_b64: undefined });
const meta1 = JSON.parse(guardados.get("nfse:nota:" + ID_ANA + ":n-1"));
checar(meta1.numero === "43" && meta1.tem_pdf === true && guardados.get("nfse:nota-pdf:" + ID_ANA + ":n-1") === pdf, "reenviar sem pdf_b64 mantem o PDF que ja estava", meta1);

// ------------------------------------------------------------ e-mail
console.log("e-mail");
const enviados = [];
let resendResponde = 200;
const fetchDeVerdade = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url) !== "https://api.resend.com/emails") return fetchDeVerdade(url, init);
  if (resendResponde === "rede") throw new Error("sem rede");
  enviados.push({ corpo: JSON.parse(init.body) });
  return new Response(JSON.stringify(resendResponde === 200 ? { id: "em_" + enviados.length } : { message: "domínio não verificado" }), { status: resendResponde });
};
const envMail = { ...env, RESEND_API_KEY: "re_teste" };
const nota2 = { ...nota, id: "n-2", pagamento: "", numero: "44", competencia: "2026-09" };
x = await guardarNotaDoCliente(env, { ...nota2, email: true });
checar(x.corpo.ok && x.corpo.email === "sem RESEND_API_KEY" && enviados.length === 0, "sem RESEND_API_KEY: a nota entra e diz que o e-mail nao foi", x.corpo);
x = await guardarNotaDoCliente(envMail, { ...nota2, email: true });
let m = enviados.at(-1);
checar(x.corpo.email === "enviado" && m.corpo.to[0] === "ana@escritorio.com.br" && m.corpo.subject === "Sua NFS-e de setembro/2026 — PAVLVS"
  && m.corpo.text.includes("ambiente de testes, sem valor fiscal") && m.corpo.attachments.length === 2, "com a chave: e-mail ao cliente com PDF e XML", m && m.corpo.subject);
await gravarTomador(env, ID_ANA, { email: "fiscal@ana.adv.br" });
await guardarNotaDoCliente(envMail, { ...nota2, email: true });
checar(enviados.at(-1).corpo.to[0] === "fiscal@ana.adv.br", "com o e-mail do tomador corrigido, vai a ele");
resendResponde = 422;
x = await guardarNotaDoCliente(envMail, { ...nota2, numero: "45", email: true });
checar(x.corpo.ok && x.corpo.email.startsWith("falhou: ") && JSON.parse(guardados.get("nfse:nota:" + ID_ANA + ":n-2")).numero === "45", "Resend recusa: a nota fica e o e-mail diz por que falhou", x.corpo);
resendResponde = 200;
await gravarTomador(env, ID_ANA, { email: "" });
const antes = enviados.length;
x = await avisarNotaCancelada(envMail, "n-2", { conta: ID_ANA, email: true, substituta: { numero: "46" } });
m = enviados.at(-1);
checar(x.corpo.ok && x.corpo.email === "enviado" && enviados.length === antes + 1 && !m.corpo.attachments && m.corpo.text.includes("substituída pela nota nº 46"),
  "cancelada com email: aviso curto, sem anexos, dizendo a substituta", x.corpo);
checar(JSON.parse(guardados.get("nfse:nota:" + ID_ANA + ":n-2")).substituta === "46", "a substituta fica na meta");
x = await avisarNotaCancelada(env, "n-2", { conta: ID_BRUNO });
checar(x.status === 404, "cancelar com a conta errada: 404");
for (const k of [...guardados.keys()]) if (/^nfse:nota(-pdf|-xml)?:[0-9a-f]{24}:n-2$/.test(k)) guardados.delete(k);
globalThis.fetch = fetchDeVerdade;

// ------------------------------------------------------------ o cliente
console.log("cliente");
async function cliente(caminho, id) {
  return worker.fetch(new Request("https://paulus.ia.br" + caminho, { headers: { authorization: "Bearer " + segredo(id) } }), env, ctx);
}
let r = await cliente("/api/ia/nfse", ID_ANA);
let d = await r.json();
checar(r.status === 200 && d.notas.length === 1 && d.notas[0].numero === "43" && d.notas[0].competencia === "2026-10" && !d.notas[0].cancelada && !("pdf_b64" in d.notas[0]), "a Ana ve a nota dela (sem os arquivos)", d);
r = await cliente("/api/ia/nfse", ID_BRUNO);
checar((await r.json()).notas.length === 0, "o Bruno nao ve a nota da Ana");
r = await cliente("/api/ia/nfse/n-1/pdf", ID_BRUNO);
checar(r.status === 404, "o Bruno nao baixa o PDF da Ana");
r = await cliente("/api/ia/nfse/n-1/pdf", ID_ANA);
const bytes = Buffer.from(await r.arrayBuffer()).toString();
checar(r.status === 200 && r.headers.get("content-type") === "application/pdf" && bytes === "%PDF-1.4 nota da Ana" && r.headers.get("content-disposition").includes("NFS-e 43.pdf"), "a Ana baixa o PDF");
r = await cliente("/api/ia/nfse/n-1/xml", ID_ANA);
checar(r.status === 200 && (await r.text()).includes("<nNFSe>42"), "e o XML");
r = await worker.fetch(new Request("https://paulus.ia.br/api/ia/nfse"), env, ctx);
checar(r.status === 401, "sem o segredo da instalacao: 401");
x = await avisarNotaCancelada(env, "n-1", { conta: ID_ANA });
d = await (await cliente("/api/ia/nfse", ID_ANA)).json();
checar(x.status === 200 && d.notas[0].cancelada === true && JSON.parse(guardados.get("admin:nfse:PAY1")).nota === "cancelada", "o cliente ve a nota cancelada e o pagamento tambem", d);

console.log(falhas ? `\n  ${falhas} falha(s)` : "\n  notas do cliente: todos os testes passaram");
process.exit(falhas ? 1 : 0);
