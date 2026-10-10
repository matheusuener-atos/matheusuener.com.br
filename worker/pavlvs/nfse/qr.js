// QR Code em JS puro, só o que o DANFSe precisa: nível de correção L,
// versões 1 a 10, modos numérico, alfanumérico e byte (UTF-8).
//
// É o porte do codificador que o reportlab usa no DANFSe do PAULUS
// (reportlab/graphics/barcode/qrencoder.py, QrCodeWidget com barLevel "L"),
// com as mesmas escolhas: o modo pelo primeiro que serve (numérico,
// alfanumérico, byte), a menor versão que cabe e a máscara de menor
// penalidade calculada do jeito dele (inclusive a avaliação com as
// informações de formato zeradas). Assim a matriz sai IGUAL à do Python - o
// teste worker/teste-nfse-danfse.mjs confere módulo a módulo.

// [blocos, total, dados] por versão, nível L (ISO/IEC 18004, tabela 9).
const BLOCOS_L = [
  null,
  [1, 26, 19], [1, 44, 34], [1, 70, 55], [1, 100, 80], [1, 134, 108],
  [2, 86, 68], [2, 98, 78], [2, 121, 97], [2, 146, 116], [2, 86, 68, 2, 87, 69],
];
const ALINHAMENTO = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
const NIVEL_L = 1; // o valor do reportlab (QRErrorCorrectLevel.L) nos bits de formato
const ALFANUM = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";

// GF(256), polinômio 0x11d.
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];

const geradores = new Map();
function gerador(n) {
  let g = geradores.get(n);
  if (g) return g;
  g = [1];
  for (let i = 0; i < n; i++) {
    const novo = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      novo[j] ^= g[j];
      novo[j + 1] ^= g[j] === 0 ? 0 : EXP[LOG[g[j]] + i];
    }
    g = novo;
  }
  geradores.set(n, g);
  return g;
}

function restoRs(dados, n) {
  const g = gerador(n);
  const r = new Array(n).fill(0);
  for (const b of dados) {
    const f = b ^ r[0];
    r.shift();
    r.push(0);
    if (f) for (let j = 0; j < n; j++) if (g[j + 1]) r[j] ^= EXP[LOG[g[j + 1]] + LOG[f]];
  }
  return r;
}

class Bits {
  constructor() {
    this.bytes = [];
    this.n = 0;
  }
  put(num, tam) {
    for (let i = tam - 1; i >= 0; i--) this.bit(((num >>> i) & 1) === 1);
  }
  bit(b) {
    const k = this.n >> 3;
    if (this.bytes.length <= k) this.bytes.push(0);
    if (b) this.bytes[k] |= 0x80 >>> (this.n & 7);
    this.n++;
  }
}

function segmento(texto) {
  if (/^[0-9]*$/.test(texto)) return { modo: 1, dados: [...texto], largura: [10, 12, 14], bits: (n) => Math.floor(n / 3) * 10 + [0, 4, 7][n % 3] };
  if (/^[-0-9A-Z $%*+./:]*$/.test(texto)) return { modo: 2, dados: [...texto], largura: [9, 11, 13], bits: (n) => Math.floor(n / 2) * 11 + (n % 2) * 6 };
  return { modo: 4, dados: [...new TextEncoder().encode(texto)], largura: [8, 16, 16], bits: (n) => n * 8 };
}

function blocosDa(versao) {
  const t = BLOCOS_L[versao];
  const lista = [];
  for (let i = 0; i < t.length; i += 3) for (let j = 0; j < t[i]; j++) lista.push([t[i + 1], t[i + 2]]);
  return lista;
}

function codewords(seg, versao) {
  const larg = seg.largura[versao < 10 ? 0 : versao < 27 ? 1 : 2];
  const blocos = blocosDa(versao);
  const total = blocos.reduce((s, [, d]) => s + d, 0);
  const b = new Bits();
  b.put(seg.modo, 4);
  b.put(seg.dados.length, larg);
  if (seg.modo === 1) {
    for (let i = 0; i < seg.dados.length; i += 3) {
      const g = seg.dados.slice(i, i + 3).join("");
      b.put(Number(g), [0, 4, 7, 10][g.length]);
    }
  } else if (seg.modo === 2) {
    for (let i = 0; i < seg.dados.length; i += 2) {
      const a = ALFANUM.indexOf(seg.dados[i]);
      if (i + 1 < seg.dados.length) b.put(a * 45 + ALFANUM.indexOf(seg.dados[i + 1]), 11);
      else b.put(a, 6);
    }
  } else {
    for (const x of seg.dados) b.put(x, 8);
  }
  if (b.n > total * 8) throw new Error("o texto não cabe no QR Code");
  if (b.n + 4 <= total * 8) b.put(0, 4);
  while (b.n % 8) b.bit(false);
  for (let pad = 0; b.n < total * 8; pad ^= 1) b.put(pad ? 0x11 : 0xec, 8);
  const dc = [];
  const ec = [];
  let pos = 0;
  for (const [tot, d] of blocos) {
    const parte = b.bytes.slice(pos, pos + d);
    pos += d;
    dc.push(parte);
    ec.push(restoRs(parte, tot - d));
  }
  const saida = [];
  for (const grupo of [dc, ec]) {
    const max = Math.max(...grupo.map((x) => x.length));
    for (let i = 0; i < max; i++) for (const x of grupo) if (i < x.length) saida.push(x[i]);
  }
  return saida;
}

function bch(dados, g, deslocamento) {
  const digitos = (v) => (v === 0 ? 0 : 32 - Math.clz32(v));
  let d = dados << deslocamento;
  while (digitos(d) - digitos(g) >= 0) d ^= g << (digitos(d) - digitos(g));
  return (dados << deslocamento) | d;
}
const G15 = 0b10100110111;
const G18 = 0b1111100100101;
const G15_MASCARA = 0b101010000010010;

const MASCARAS = [
  (i, j) => (i + j) % 2 === 0,
  (i) => i % 2 === 0,
  (i, j) => j % 3 === 0,
  (i, j) => (i + j) % 3 === 0,
  (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
  (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
  (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0,
  (i, j) => (((i * j) % 3) + ((i + j) % 2)) % 2 === 0,
];

// A ordem de percorrer a área de dados, como o _dataPosIterator do reportlab.
function posicoes(versao, n) {
  const cols = [];
  for (let c = n - 1; c > 6; c -= 2) cols.push(c);
  cols.push(5, 3, 1);
  const faixa = (a, b) => Array.from({ length: Math.max(0, b - a) }, (_, k) => a + k);
  let linhas = [faixa(9, n - 8), [...faixa(0, 6), ...faixa(7, n)], faixa(9, n)];
  let inversas = linhas.map((l) => [...l].reverse());
  const pp = new Set();
  for (const p of ALINHAMENTO[versao]) for (let d = -2; d <= 2; d++) pp.add(p + d);
  const maxpos = n - 11;
  const saida = [];
  for (const col of cols) {
    [linhas, inversas] = [inversas, linhas];
    const idx = col <= 8 ? 0 : col >= n - 8 ? 2 : 1;
    for (const row of linhas[idx]) {
      for (let k = 0; k < 2; k++) {
        const c = col - k;
        if (versao >= 7) {
          if (row < 6 && c >= n - 11) continue;
          if (col < 6 && row >= n - 11) continue;
        }
        if (pp.has(row) && pp.has(c)) {
          if (!((row < 11 && (c < 11 || c > maxpos)) || (c < 11 && (row < 11 || row > maxpos)))) continue;
        }
        saida.push(row * n + c);
      }
    }
  }
  return saida;
}

// Os padrões fixos (localizadores, alinhamento, sincronismo, formato e versão).
function padroes(versao, mascara, teste) {
  const n = versao * 4 + 17;
  const m = new Uint8Array(n * n);
  const por = (r, c, v) => { m[r * n + c] = v ? 1 : 0; };
  const sonda = (row, col) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = row + r;
        const cc = col + c;
        if (rr < 0 || rr >= n || cc < 0 || cc >= n) continue;
        const dentro = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        por(rr, cc, dentro && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4)));
      }
    }
  };
  sonda(0, 0);
  sonda(n - 7, 0);
  sonda(0, n - 7);
  const pos = ALINHAMENTO[versao];
  const maxpos = n - 8;
  for (const row of pos) {
    for (const col of pos) {
      if (col <= 8 && (row <= 8 || row >= maxpos)) continue;
      if (col >= maxpos && row <= 8) continue;
      for (let r = -2; r <= 2; r++) for (let c = -2; c <= 2; c++) por(row + r, col + c, Math.max(Math.abs(r), Math.abs(c)) !== 1);
    }
  }
  for (let r = 8; r < n - 8; r++) por(r, 6, r % 2 === 0);
  for (let c = 8; c < n - 8; c++) por(6, c, c % 2 === 0);
  const formato = bch((NIVEL_L << 3) | mascara, G15, 10) ^ G15_MASCARA;
  for (let i = 0; i < 15; i++) {
    const v = !teste && ((formato >> i) & 1) === 1;
    if (i < 6) por(i, 8, v);
    else if (i < 8) por(i + 1, 8, v);
    else por(n - 15 + i, 8, v);
  }
  for (let i = 0; i < 15; i++) {
    const v = !teste && ((formato >> i) & 1) === 1;
    if (i < 8) por(8, n - i - 1, v);
    else if (i < 9) por(8, 15 - i, v);
    else por(8, 15 - i - 1, v);
  }
  por(n - 8, 8, !teste);
  if (versao >= 7) {
    const bits = bch(versao, G18, 12);
    for (let i = 0; i < 18; i++) {
      const v = !teste && ((bits >> i) & 1) === 1;
      por(Math.floor(i / 3), (i % 3) + n - 11, v);
      por((i % 3) + n - 11, Math.floor(i / 3), v);
    }
  }
  return m;
}

// Por versão: os padrões da avaliação (formato zerado, igual para as 8
// máscaras) e a ordem da área de dados. A matriz se monta 9 vezes por QR.
const cacheVersao = new Map();
function daVersao(versao) {
  let c = cacheVersao.get(versao);
  if (!c) {
    const n = versao * 4 + 17;
    const lista = Int32Array.from(posicoes(versao, n));
    const linha = new Int32Array(lista.length);
    const coluna = new Int32Array(lista.length);
    for (let k = 0; k < lista.length; k++) { linha[k] = Math.floor(lista[k] / n); coluna[k] = lista[k] % n; }
    c = { teste: padroes(versao, 0, true), lista, linha, coluna };
    cacheVersao.set(versao, c);
  }
  return c;
}

function montar(versao, dados, mascara, teste) {
  const v = daVersao(versao);
  const m = teste ? v.teste.slice() : padroes(versao, mascara, false);
  const f = MASCARAS[mascara];
  const { lista, linha, coluna } = v;
  for (let k = 0; k < lista.length; k++) {
    const byte = k >> 3;
    const escuro = byte < dados.length ? ((dados[byte] >> (7 - (k & 7))) & 1) === 1 : false;
    m[lista[k]] = escuro !== f(linha[k], coluna[k]) ? 1 : 0;
  }
  return m;
}

// A penalidade do reportlab (QRUtil.getLostPoint), com as mesmas regras,
// numa passada por linha e outra por coluna (sem função por módulo: a 1ª
// chamada roda no interpretador e cada chamada conta).
//   regra 1: corrida de L >= 5 módulos iguais, nas duas direções: L - 2
//   regra 2: bloco 2x2 da mesma cor: 3
//   regra 3: 1011101 0000 nas linhas, só neste sentido e sem a última posição
//            (no reportlab a passada nas colunas compara tupla com lista,
//            maskScoreRule3hor(zip(*modules)), e nunca pontua)
//   regra 4: 10 por 5% de desvio dos escuros em relação a 50%
const PADRAO3 = 0b10111010000; // 11 módulos, o 1º no bit mais alto
function penalidade(m, n) {
  let pontos = 0;
  let escuros = 0;
  for (let r = 0; r < n; r++) {
    const base = r * n;
    let corrida = 1;
    let janela = 0;
    for (let c = 0; c < n; c++) {
      const v = m[base + c];
      escuros += v;
      if (c > 0) {
        if (v === m[base + c - 1]) corrida++;
        else {
          if (corrida >= 5) pontos += corrida - 2;
          corrida = 1;
        }
        if (r > 0 && v === m[base + c - 1] && v === m[base - n + c] && v === m[base - n + c - 1]) pontos += 3;
      }
    }
    if (corrida >= 5) pontos += corrida - 2;
    // regra 3: j vai de 0 a n - 12; ao achar, pula 11
    let j = 0;
    while (j < n - 11) {
      janela = 0;
      for (let k = 0; k < 11; k++) janela = (janela << 1) | m[base + j + k];
      if (janela === PADRAO3) { pontos += 40; j += 11; } else j++;
    }
  }
  for (let c = 0; c < n; c++) {
    let corrida = 1;
    for (let r = 1; r < n; r++) {
      if (m[r * n + c] === m[(r - 1) * n + c]) corrida++;
      else {
        if (corrida >= 5) pontos += corrida - 2;
        corrida = 1;
      }
    }
    if (corrida >= 5) pontos += corrida - 2;
  }
  pontos += 10 * Math.floor(Math.abs(Math.floor((100 * escuros) / (n * n)) - 50) / 5);
  return pontos;
}

/** A matriz do QR Code: {n, modulos: Uint8Array(n*n), 1 = escuro}. */
export function matrizQr(texto) {
  const seg = segmento(String(texto));
  let versao = 0;
  for (let v = 1; v < BLOCOS_L.length; v++) {
    const total = blocosDa(v).reduce((s, [, d]) => s + d, 0);
    if (4 + seg.largura[v < 10 ? 0 : 1] + seg.bits(seg.dados.length) <= total * 8) { versao = v; break; }
  }
  if (!versao) throw new Error("o texto não cabe no QR Code (até a versão 10)");
  const dados = codewords(seg, versao);
  const n = versao * 4 + 17;
  let melhor = 0;
  let menor = 0;
  for (let k = 0; k < 8; k++) {
    const p = penalidade(montar(versao, dados, k, true), n);
    if (k === 0 || menor > p) { menor = p; melhor = k; }
  }
  return { n, versao, mascara: melhor, modulos: montar(versao, dados, melhor, false) };
}
