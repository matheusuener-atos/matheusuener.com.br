// A assinatura XMLDSig da DPS e do pedido de evento, no Worker.
//
// Porte de paulus/legal/src/nfse/assinatura.py, com o mesmo perfil:
// enveloped, Reference ao Id do elemento (infDPS / infPedReg),
// transformações enveloped-signature + C14N 1.0 (20010315), RSA PKCS#1 v1.5
// com SHA-1 por padrão (SHA-256 como opção), Signature sem prefixo como
// último filho da raiz e o certificado no KeyInfo.
//
// Para o mesmo XML de entrada e a mesma chave, o resultado é o MESMO, byte a
// byte, do Python (RSA PKCS#1 v1.5 é determinístico): worker/teste-nfse-prova.mjs.
//
// A chave entra em PKCS#8 (pfx.js, lerPfx) e é usada pelo crypto.subtle.

import { anexar, c14n, elementos, lerXml, localName, novo, nsDe, serializar } from "./xml.js";

export class ErroAssinatura extends Error {}

const DS = "http://www.w3.org/2000/09/xmldsig#";
const C14N = "http://www.w3.org/TR/2001/REC-xml-c14n-20010315";
const ENVELOPED = "http://www.w3.org/2000/09/xmldsig#enveloped-signature";
const ALGORITMOS = {
  sha1: { assinatura: "http://www.w3.org/2000/09/xmldsig#rsa-sha1", resumo: "http://www.w3.org/2000/09/xmldsig#sha1", hash: "SHA-1" },
  sha256: { assinatura: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256", resumo: "http://www.w3.org/2001/04/xmlenc#sha256", hash: "SHA-256" },
};

/** sha1 | sha256 -> o nome do hash no WebCrypto. */
export const ALGORITMOS_HASH = { sha1: "SHA-1", sha256: "SHA-256" };

const utf8 = new TextEncoder();

export function b64(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Importa a chave PKCS#8 para assinar (guarde o CryptoKey entre chamadas). */
export async function importarChave(chavePkcs8, algoritmo = "sha1") {
  const alg = ALGORITMOS[algoritmo];
  if (!alg) throw new ErroAssinatura("algoritmo de assinatura desconhecido");
  return crypto.subtle.importKey("pkcs8", chavePkcs8, { name: "RSASSA-PKCS1-v1_5", hash: alg.hash }, false, ["sign"]);
}

/**
 * Assina o elemento com Id=refId. `xml`: string ou bytes UTF-8;
 * `chave`: CryptoKey (importarChave) com o MESMO algoritmo;
 * `certDer`: Uint8Array do certificado. Devolve a string do XML assinado
 * (UTF-8 ao codificar).
 */
export async function assinar(xml, chave, certDer, refId, algoritmo = "sha1") {
  const alg = ALGORITMOS[algoritmo];
  if (!alg) throw new ErroAssinatura("algoritmo de assinatura desconhecido");
  if (chave.algorithm && chave.algorithm.hash && chave.algorithm.hash.name !== alg.hash) {
    throw new ErroAssinatura("a chave foi importada para outro algoritmo");
  }
  const { raiz } = lerXml(xml);
  const alvos = [...elementos(raiz)].filter((e) => e.attrs.some(([n, v]) => n === "Id" && v === refId));
  if (alvos.length !== 1) throw new ErroAssinatura(`não achei um único elemento com Id ${refId}`);
  const alvo = alvos[0];
  raiz.filhos = raiz.filhos.filter((f) => !(f.tipo === "el" && localName(f) === "Signature" && nsDe(f) === DS));

  const resumo = b64(await crypto.subtle.digest(alg.hash, utf8.encode(c14n(alvo))));

  const sig = anexar(raiz, novo("Signature", { decls: [["", DS]] }));
  const si = anexar(sig, novo("SignedInfo"));
  anexar(si, novo("CanonicalizationMethod", { attrs: [["Algorithm", C14N]] }));
  anexar(si, novo("SignatureMethod", { attrs: [["Algorithm", alg.assinatura]] }));
  const ref = anexar(si, novo("Reference", { attrs: [["URI", `#${refId}`]] }));
  const trs = anexar(ref, novo("Transforms"));
  anexar(trs, novo("Transform", { attrs: [["Algorithm", ENVELOPED]] }));
  anexar(trs, novo("Transform", { attrs: [["Algorithm", C14N]] }));
  anexar(ref, novo("DigestMethod", { attrs: [["Algorithm", alg.resumo]] }));
  anexar(ref, novo("DigestValue", { texto: resumo }));

  const valor = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", chave, utf8.encode(c14n(si)));
  anexar(sig, novo("SignatureValue", { texto: b64(valor) }));
  const ki = anexar(sig, novo("KeyInfo"));
  const xd = anexar(ki, novo("X509Data"));
  anexar(xd, novo("X509Certificate", { texto: b64(certDer) }));
  return serializar(raiz);
}
