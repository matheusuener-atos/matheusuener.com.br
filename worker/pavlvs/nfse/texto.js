// O texto como o Python trata (o emissor de referência): espaço é o de
// str.isspace()/str.split(), "dígito" é o \d do re (Unicode Nd), corte é por
// caractere (code point), não por unidade UTF-16. Assim o XML em JS sai igual
// ao do Python mesmo com emoji, tab, \r\n e espaço não separável.

// str.isspace() do Python 3 (e o \s do re com str).
const ESPACOS = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const RE_ESPACOS = new RegExp(`[${ESPACOS}]+`, "g");
const RE_ESPACO_UM = new RegExp(`[${ESPACOS}]`, "g");
const RE_BORDA = new RegExp(`^[${ESPACOS}]+|[${ESPACOS}]+$`, "g");

/** str(texto).strip() */
export function strip(texto) {
  return String(texto).replace(RE_BORDA, "");
}

/** " ".join(str(texto).split()) */
export function juntarEspacos(texto) {
  return strip(String(texto).replace(RE_ESPACOS, " "));
}

/** re.sub(r"\s", "", texto) */
export function semEspacos(texto) {
  return String(texto).replace(RE_ESPACO_UM, "");
}

/** re.sub(r"\D", "", texto) */
export function soDigitos(texto) {
  return String(texto ?? "").replace(/\P{Nd}/gu, "");
}

/** texto[:n] do Python (por code point). */
export function cortar(texto, n) {
  const s = String(texto);
  if (s.length <= n) return s;
  return Array.from(s).slice(0, n).join("");
}

/** len(texto) do Python. */
export function tamanho(texto) {
  let n = 0;
  for (const _ of String(texto)) n++;
  return n;
}

/** " ".join(str(texto or "").split())[:maximo] (o _limpa do dps.py). */
export function limpa(texto, maximo) {
  return cortar(juntarEspacos(texto || ""), maximo);
}

/** campos_br.normalizado: só [0-9A-Z] do texto em maiúsculas. */
export function documentoNormal(valor) {
  return String(valor || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
}

export function cpfValido(valor) {
  const d = String(valor || "").replace(/\D/g, "");
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  for (const n of [9, 10]) {
    let soma = 0;
    for (let i = 0; i < n; i++) soma += Number(d[i]) * (n + 1 - i);
    if ((soma * 10) % 11 % 10 !== Number(d[n])) return false;
  }
  return true;
}

const PESOS_CNPJ_1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const PESOS_CNPJ_2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

/** CNPJ numérico ou alfanumérico (IN RFB 2.229/2024): letra vale código - 48. */
export function cnpjValido(valor) {
  const c = documentoNormal(valor);
  if (!/^[0-9A-Z]{12}[0-9]{2}$/.test(c) || c === c[0].repeat(14)) return false;
  for (const [n, pesos] of [[12, PESOS_CNPJ_1], [13, PESOS_CNPJ_2]]) {
    let soma = 0;
    for (let i = 0; i < n; i++) soma += (c.charCodeAt(i) - 48) * pesos[i];
    const resto = soma % 11;
    if ((resto < 2 ? 0 : 11 - resto) !== Number(c[n])) return false;
  }
  return true;
}

/** Texto que o XML aceita (o lxml recusa controle e NUL com ValueError). */
export function conferirCaracteres(texto) {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(texto)) {
    throw new Error("All strings must be XML compatible: Unicode or ASCII, no NULL bytes or control characters");
  }
  return texto;
}
