// XML mínimo para assinar a DPS no Worker (sem DOM: o Worker não tem DOMParser).
//
// Três peças, cada uma imitando o que o emissor em Python (lxml/libxml2) faz:
//   lerXml(texto)        -> árvore {tipo, nome, ns, attrs, filhos}
//   serializar(doc)      -> o que etree.tostring(raiz, xml_declaration=True,
//                           encoding="UTF-8") devolve (declaração com aspas
//                           simples, elemento vazio como <a/>, \r como &#13;)
//   c14n(el)             -> C14N 1.0 inclusivo, sem comentários
//                           (REC-xml-c14n-20010315), do elemento como apex
//
// O que NÃO é aceito, de propósito, e dá erro em vez de sair diferente do
// Python: DOCTYPE (o Python também recusa entidades: resolve_entities=False),
// entidades que não são as cinco do XML, instruções de processamento fora a
// declaração, e comentário fora do elemento raiz. A DPS e o pedido de evento
// do PAULUS não têm nada disso.
//
// Diferença conhecida, de borda: a cópia destacada do lxml (assinatura.py,
// _c14n) só leva para o apex os namespaces USADOS na subárvore; a norma (e
// este código) leva todos os que estão em escopo. Só muda o resultado se a
// raiz declarar um prefixo que a subárvore assinada não usa - o que a DPS
// do PAULUS não faz (só tem o namespace padrão da NFS-e).

export class ErroXml extends Error {}

const ENTIDADES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };
const RE_NOME = /[^\s/>=]+/y;

function decodificar(texto, ondeErro) {
  if (texto.indexOf("&") < 0) return texto;
  if (/&(?!#x[0-9a-fA-F]+;|#[0-9]+;|[A-Za-z]+;)/.test(texto)) throw new ErroXml(`"&" solto (${ondeErro})`);
  return texto.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);/g, (_, ref) => {
    if (ref[0] === "#") {
      const cp = ref[1] === "x" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return String.fromCodePoint(cp);
    }
    if (!(ref in ENTIDADES)) throw new ErroXml(`entidade &${ref}; não é aceita (${ondeErro})`);
    return ENTIDADES[ref];
  });
}

function elemento(nome, pai) {
  return { tipo: "el", nome, decls: [], attrs: [], filhos: [], pai };
}

/** Lê o documento. Devolve {declaracao, raiz}. */
export function lerXml(entrada) {
  let s = typeof entrada === "string" ? entrada : new TextDecoder("utf-8", { fatal: true }).decode(entrada);
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  // Fim de linha normalizado como o parser faz (XML 1.0, 2.11).
  s = s.replace(/\r\n?/g, "\n");
  let i = 0;
  let declaracao = null;
  let raiz = null;
  let atual = null;

  const erro = (msg) => { throw new ErroXml(`${msg} (posição ${i})`); };

  while (i < s.length) {
    if (s[i] !== "<") {
      const fim = s.indexOf("<", i);
      const bruto = s.slice(i, fim < 0 ? s.length : fim);
      i = fim < 0 ? s.length : fim;
      if (!atual) {
        if (bruto.trim()) erro("texto fora do elemento raiz");
        continue;
      }
      adicionarTexto(atual, decodificar(bruto, "texto"));
      continue;
    }
    if (s.startsWith("<?", i)) {
      const fim = s.indexOf("?>", i);
      if (fim < 0) erro("instrução sem fim");
      const conteudo = s.slice(i + 2, fim);
      if (/^xml\s/.test(conteudo) && !raiz && !declaracao) declaracao = conteudo;
      else erro("instrução de processamento não é aceita");
      i = fim + 2;
      continue;
    }
    if (s.startsWith("<!--", i)) {
      const fim = s.indexOf("-->", i);
      if (fim < 0) erro("comentário sem fim");
      if (!atual) erro("comentário fora do elemento raiz não é aceito");
      atual.filhos.push({ tipo: "comentario", texto: s.slice(i + 4, fim) });
      i = fim + 3;
      continue;
    }
    if (s.startsWith("<![CDATA[", i)) {
      const fim = s.indexOf("]]>", i);
      if (fim < 0 || !atual) erro("CDATA inválido");
      adicionarTexto(atual, s.slice(i + 9, fim));
      i = fim + 3;
      continue;
    }
    if (s.startsWith("<!", i)) erro("DOCTYPE/declaração não é aceita");
    if (s.startsWith("</", i)) {
      const fim = s.indexOf(">", i);
      const nome = s.slice(i + 2, fim).trim();
      if (!atual || atual.nome !== nome) erro(`fechamento </${nome}> fora de ordem`);
      atual = atual.pai;
      i = fim + 1;
      continue;
    }
    // Abertura.
    i++;
    RE_NOME.lastIndex = i;
    const m = RE_NOME.exec(s);
    if (!m) erro("nome de elemento");
    const el = elemento(m[0], atual);
    i = RE_NOME.lastIndex;
    let vazio = false;
    for (;;) {
      while (/\s/.test(s[i])) i++;
      if (s[i] === ">") { i++; break; }
      if (s.startsWith("/>", i)) { i += 2; vazio = true; break; }
      RE_NOME.lastIndex = i;
      const a = RE_NOME.exec(s);
      if (!a) erro("nome de atributo");
      i = RE_NOME.lastIndex;
      while (/\s/.test(s[i])) i++;
      if (s[i] !== "=") erro("atributo sem =");
      i++;
      while (/\s/.test(s[i])) i++;
      const q = s[i];
      if (q !== "\"" && q !== "'") erro("valor de atributo sem aspas");
      const fim = s.indexOf(q, i + 1);
      if (fim < 0) erro("valor de atributo sem fim");
      // Normalização de atributo (XML 1.0, 3.3.3): espaço literal vira " ";
      // o que veio por referência (&#10;) fica.
      const valor = decodificar(s.slice(i + 1, fim).replace(/[\t\n]/g, " "), "atributo");
      i = fim + 1;
      const nome = a[0];
      if (nome === "xmlns") el.decls.push(["", valor]);
      else if (nome.startsWith("xmlns:")) el.decls.push([nome.slice(6), valor]);
      else {
        if (el.attrs.some(([n]) => n === nome)) erro(`atributo ${nome} repetido`);
        el.attrs.push([nome, valor]);
      }
    }
    if (atual) atual.filhos.push(el);
    else if (raiz) erro("dois elementos raiz");
    else raiz = el;
    if (!vazio) atual = el;
  }
  if (!raiz || atual) throw new ErroXml("documento incompleto");
  return { declaracao, raiz };
}

function adicionarTexto(el, texto) {
  if (!texto) return;
  const ultimo = el.filhos[el.filhos.length - 1];
  if (ultimo && ultimo.tipo === "texto") ultimo.texto += texto;
  else el.filhos.push({ tipo: "texto", texto });
}

/** Cria um elemento solto (para montar a Signature). */
export function novo(nome, { attrs = [], decls = [], texto } = {}) {
  const el = elemento(nome, null);
  el.attrs = attrs;
  el.decls = decls;
  if (texto !== undefined && texto !== "") el.filhos.push({ tipo: "texto", texto: String(texto) });
  return el;
}

export function anexar(pai, filho) {
  filho.pai = pai;
  pai.filhos.push(filho);
  return filho;
}

/** Todos os elementos, em ordem de documento. */
export function* elementos(el) {
  yield el;
  for (const f of el.filhos) if (f.tipo === "el") yield* elementos(f);
}

// ------------------------------------------------------------ namespaces

function prefixoDe(nome) {
  const k = nome.indexOf(":");
  return k < 0 ? "" : nome.slice(0, k);
}

function localDe(nome) {
  const k = nome.indexOf(":");
  return k < 0 ? nome : nome.slice(k + 1);
}

/** Namespaces em escopo do elemento: Map prefixo -> uri ("" = padrão). */
export function emEscopo(el) {
  const cadeia = [];
  for (let e = el; e; e = e.pai) cadeia.unshift(e);
  const mapa = new Map();
  for (const e of cadeia) for (const [p, u] of e.decls) mapa.set(p, u);
  return mapa;
}

/** O namespace (uri) de um elemento. */
export function nsDe(el, escopo = emEscopo(el)) {
  return escopo.get(prefixoDe(el.nome)) || "";
}

export function localName(el) {
  return localDe(el.nome);
}

// ---------------------------------------------------- serializar (lxml)

function escTextoLxml(t) {
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r/g, "&#13;");
}

function escAttrLxml(t) {
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
    .replace(/\n/g, "&#10;").replace(/\r/g, "&#13;").replace(/\t/g, "&#9;");
}

function serEl(el, partes) {
  partes.push("<", el.nome);
  for (const [p, u] of el.decls) partes.push(p ? ` xmlns:${p}="` : " xmlns=\"", escAttrLxml(u), "\"");
  for (const [n, v] of el.attrs) partes.push(" ", n, "=\"", escAttrLxml(v), "\"");
  if (!el.filhos.length) { partes.push("/>"); return; }
  partes.push(">");
  for (const f of el.filhos) {
    if (f.tipo === "el") serEl(f, partes);
    else if (f.tipo === "texto") partes.push(escTextoLxml(f.texto));
    else partes.push("<!--", f.texto, "-->");
  }
  partes.push("</", el.nome, ">");
}

/** Como etree.tostring(raiz, xml_declaration=True, encoding="UTF-8"). */
export function serializar(raiz) {
  const partes = ["<?xml version='1.0' encoding='UTF-8'?>\n"];
  serEl(raiz, partes);
  return partes.join("");
}

// --------------------------------------------------------- C14N 1.0

function escTextoC14n(t) {
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r/g, "&#xD;");
}

function escAttrC14n(t) {
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;")
    .replace(/\t/g, "&#x9;").replace(/\n/g, "&#xA;").replace(/\r/g, "&#xD;");
}

function c14nEl(el, escopoPai, renderizados, partes) {
  const escopo = new Map(escopoPai);
  for (const [p, u] of el.decls) escopo.set(p, u);

  // Namespaces a declarar: os em escopo que o ancestral de saída ainda não
  // declarou com o mesmo valor. xmlns="" só quando desfaz um padrão anterior.
  const decl = [];
  for (const [p, u] of escopo) {
    const antes = renderizados.has(p) ? renderizados.get(p) : (p === "" ? "" : undefined);
    if (antes === u) continue;
    if (p === "" && u === "" && antes === undefined) continue;
    decl.push([p, u]);
  }
  decl.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const novosRender = new Map(renderizados);
  for (const [p, u] of decl) novosRender.set(p, u);

  const attrs = el.attrs.map(([n, v]) => {
    const p = prefixoDe(n);
    const uri = p === "xml" ? "http://www.w3.org/XML/1998/namespace" : p ? escopo.get(p) : "";
    if (p && uri === undefined) throw new ErroXml(`prefixo ${p} sem namespace`);
    return { n, v, uri, local: localDe(n) };
  });
  attrs.sort((a, b) => (a.uri !== b.uri ? (a.uri < b.uri ? -1 : 1) : a.local < b.local ? -1 : a.local > b.local ? 1 : 0));

  partes.push("<", el.nome);
  for (const [p, u] of decl) partes.push(p ? ` xmlns:${p}="` : " xmlns=\"", escAttrC14n(u), "\"");
  for (const a of attrs) partes.push(" ", a.n, "=\"", escAttrC14n(a.v), "\"");
  partes.push(">");
  for (const f of el.filhos) {
    if (f.tipo === "el") c14nEl(f, escopo, novosRender, partes);
    else if (f.tipo === "texto") partes.push(escTextoC14n(f.texto));
  }
  partes.push("</", el.nome, ">");
}

/** C14N 1.0 inclusivo, sem comentários, do elemento como apex (string). */
export function c14n(el) {
  const escopoAncestral = el.pai ? emEscopo(el.pai) : new Map();
  const partes = [];
  c14nEl(el, escopoAncestral, new Map(), partes);
  return partes.join("");
}
