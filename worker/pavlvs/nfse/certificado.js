// Conferir o certificado e a chave que chegam já abertos (PEM / PKCS#8), sem
// o node-forge: um leitor de DER mínimo tira do certificado a validade e a
// chave pública, e a chave privada assina um texto que a pública confere.
// Assim um par trocado (certificado de um, chave de outro) é recusado na
// hora de guardar, e não vira DPS com assinatura que a Sefin recusa.

import { ALGORITMOS_HASH, importarChave } from "./assinatura.js";

export class ErroCertificadoNuvem extends Error {}

function ler(u, i) {
  if (i + 2 > u.length) throw new ErroCertificadoNuvem("certificado truncado");
  const tag = u[i];
  let tam = u[i + 1];
  let k = i + 2;
  if (tam & 0x80) {
    const n = tam & 0x7f;
    if (n < 1 || n > 4) throw new ErroCertificadoNuvem("certificado com tamanho inválido");
    tam = 0;
    for (let j = 0; j < n; j++) tam = tam * 256 + u[k++];
  }
  if (k + tam > u.length) throw new ErroCertificadoNuvem("certificado truncado");
  return { tag, ini: i, conteudo: k, fim: k + tam };
}

function filhos(u, no) {
  const saida = [];
  for (let i = no.conteudo; i < no.fim;) {
    const f = ler(u, i);
    saida.push(f);
    i = f.fim;
  }
  return saida;
}

function hora(u, no) {
  const t = new TextDecoder().decode(u.subarray(no.conteudo, no.fim));
  const m = no.tag === 0x17 ? /^(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)?Z$/.exec(t) : /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)?Z$/.exec(t);
  if (!m) throw new ErroCertificadoNuvem("validade do certificado ilegível");
  let ano = Number(m[1]);
  if (no.tag === 0x17) ano += ano < 50 ? 2000 : 1900;
  return new Date(Date.UTC(ano, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] || 0))).toISOString();
}

/** Do DER do certificado X.509: {validoDe, validoAte, spki (Uint8Array)}. */
export function lerCertificado(der) {
  const u = der instanceof Uint8Array ? der : new Uint8Array(der);
  const cert = ler(u, 0);
  if (cert.tag !== 0x30) throw new ErroCertificadoNuvem("isto não é um certificado X.509");
  const [tbs] = filhos(u, cert);
  const tf = filhos(u, tbs);
  const k = tf[0] && tf[0].tag === 0xa0 ? 1 : 0;
  const validade = tf[k + 3];
  const spki = tf[k + 5];
  if (!validade || !spki || validade.tag !== 0x30 || spki.tag !== 0x30) throw new ErroCertificadoNuvem("isto não é um certificado X.509");
  const [de, ate] = filhos(u, validade);
  return { validoDe: hora(u, de), validoAte: hora(u, ate), spki: u.slice(spki.ini, spki.fim) };
}

/** A chave privada (PKCS#8) é a do certificado? Lança se não for. */
export async function conferirPar(certDer, chavePkcs8, algoritmo = "sha1") {
  const { spki, validoAte, validoDe } = lerCertificado(certDer);
  const hash = ALGORITMOS_HASH[algoritmo];
  let privada;
  let publica;
  try {
    privada = await importarChave(chavePkcs8, algoritmo);
  } catch {
    throw new ErroCertificadoNuvem("a chave privada não abre (esperava PKCS#8 RSA, sem senha)");
  }
  try {
    publica = await crypto.subtle.importKey("spki", spki, { name: "RSASSA-PKCS1-v1_5", hash }, false, ["verify"]);
  } catch {
    throw new ErroCertificadoNuvem("a chave pública do certificado não é RSA");
  }
  const amostra = new TextEncoder().encode("PAVLVS: conferência do par do certificado");
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privada, amostra);
  if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publica, sig, amostra))) {
    throw new ErroCertificadoNuvem("a chave privada não é a deste certificado");
  }
  return { validoDe, validoAte };
}
