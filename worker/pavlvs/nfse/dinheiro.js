// Dinheiro e percentual em inteiros (porte de paulus/legal/src/nfse/dinheiro.py).
//
// Centavo é inteiro; alíquota é inteiro em pontos-base (1% = 100). A conta
// "valor × alíquota" é feita em inteiros (BigInt, para não perder precisão
// acima de 2^53) e dividida uma vez, com o arredondamento bancário
// (half-even) da NT 007. Nenhum float no caminho do dinheiro da nota.

export function centavosDeTexto(texto) {
  if (typeof texto === "boolean") throw new Error("valor inválido");
  if (typeof texto === "number") {
    if (!Number.isInteger(texto)) throw new Error("valor inválido: use centavos inteiros ou o texto \"1.234,56\"");
    return texto;
  }
  let t = String(texto ?? "").trim().replace(/R\$/g, "").replace(/ /g, "").replace(/ /g, "");
  if (!t) return 0;
  const negativo = t.startsWith("-");
  t = t.replace(/^-+/, "");
  let inteiro;
  let frac;
  if (t.includes(",")) {
    const k = t.lastIndexOf(",");
    inteiro = t.slice(0, k).replace(/\./g, "");
    frac = t.slice(k + 1);
  } else if (/^\d{1,3}(\.\d{3})+$/.test(t)) {
    inteiro = t.replace(/\./g, "");
    frac = "";
  } else if (/^\d+\.\d{1,2}$/.test(t)) {
    [inteiro, frac] = t.split(".");
  } else {
    inteiro = t;
    frac = "";
  }
  if (!/^\d+$/.test(inteiro || "0") || !/^\d{0,2}$/.test(frac)) throw new Error(`valor inválido: ${texto}`);
  const n = Number(inteiro || "0") * 100 + Number((frac + "00").slice(0, 2));
  if (!Number.isSafeInteger(n)) throw new Error(`valor inválido: ${texto}`);
  return negativo ? -n : n;
}

function milhar(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

/** 5000000 -> "R$ 50.000,00". */
export function reais(centavos) {
  const c = Number(centavos);
  const sinal = c < 0 ? "-" : "";
  const a = Math.abs(c);
  return `${sinal}R$ ${milhar(Math.floor(a / 100))},${String(a % 100).padStart(2, "0")}`;
}

/** O formato do XSD (TSDec15V2): "0" ou "5000.00". */
export function decimalXml(centavos) {
  const c = Number(centavos);
  if (c < 0) throw new Error("valor negativo não vai na nota");
  if (c === 0) return "0";
  return `${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;
}

/** "5000.00" (ou "5000") -> 500000. */
export function centavosDoXml(texto) {
  const t = String(texto ?? "").trim();
  if (!t) return 0;
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(t);
  if (!m) throw new Error(`valor inválido no XML: ${texto}`);
  return Number(m[1]) * 100 + Number(((m[2] || "") + "00").slice(0, 2));
}

/** Pontos-base no formato do XSD: 500 -> "5.00". */
export function percentualXml(bp) {
  const b = Number(bp);
  if (b < 0) throw new Error("percentual negativo");
  if (b === 0) return "0";
  return `${Math.floor(b / 100)}.${String(b % 100).padStart(2, "0")}`;
}

/** 500 -> "5,00%". */
export function percentualTexto(bp) {
  const b = Number(bp);
  return `${Math.floor(b / 100)},${String(b % 100).padStart(2, "0")}%`;
}

/** numerador / denominador ao inteiro mais próximo, empate para o par. */
export function dividirHalfEven(numerador, denominador) {
  const d = BigInt(denominador);
  if (d <= 0n) throw new Error("denominador inválido");
  let n = BigInt(numerador);
  const negativo = n < 0n;
  if (negativo) n = -n;
  let q = n / d;
  const dobro = 2n * (n % d);
  if (dobro > d || (dobro === d && q % 2n === 1n)) q += 1n;
  return Number(negativo ? -q : q);
}

/** centavos × alíquota (pontos-base), em centavos, half-even. */
export function aplicar(centavos, bp) {
  return dividirHalfEven(BigInt(Math.trunc(Number(centavos))) * BigInt(Math.trunc(Number(bp))), 10000);
}
