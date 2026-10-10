// Abrir o certificado A1 (.pfx / PKCS#12) no Worker.
//
// O PKCS#12 é lido pelo node-forge vendorizado (worker/vendor/forge.min.js,
// JS puro, sem npm). Do .pfx sai o que o emissor precisa:
//   certPem      o certificado do titular (o que tem a chave)
//   certDer      o mesmo, em DER (vai no KeyInfo da assinatura)
//   cadeiaPem    os demais certificados do arquivo (AC intermediária/raiz)
//   chavePkcs8   a chave privada em PKCS#8 DER (Uint8Array), para o
//                crypto.subtle.importKey("pkcs8", ...)
//   titular      o nome do CN, sem o ":documento" do padrão ICP-Brasil
//   documento    CNPJ (14) ou CPF (11): do otherName da ICP-Brasil
//                (2.16.76.1.3.3 = CNPJ; 2.16.76.1.3.1 = nascimento + CPF)
//                ou, sem ele, do CN "NOME:DOCUMENTO"
//   validoAte    ISO 8601 (UTC)
//
// Senha errada (ou arquivo que não é PKCS#12) dá ErroCertificado com a mesma
// frase do Python (assinatura.py / certificado.py).

// UMD: default no node e no esbuild (sem __esModule); o namespace fica de reserva.
import * as forgeModulo from "../vendor/forge.min.js";
const forge = forgeModulo.pkcs12 ? forgeModulo : forgeModulo.default;

export class ErroCertificado extends Error {}

const OID_CNPJ = "2.16.76.1.3.3";
const OID_CPF = "2.16.76.1.3.1";
const OID_SAN = "2.5.29.17";

export function binParaBytes(bin) {
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i) & 0xff;
  return u;
}

export function bytesParaBin(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return s;
}

/** O documento dos otherName da ICP-Brasil no SubjectAltName, se houver. */
function documentoDoSan(certAsn1) {
  // tbsCertificate.extensions: [3] EXPLICIT SEQUENCE OF Extension
  const tbs = certAsn1.value[0];
  const ctx3 = tbs.value.find((v) => v.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC && v.type === 3);
  if (!ctx3) return "";
  for (const ext of ctx3.value[0].value) {
    if (forge.asn1.derToOid(ext.value[0].value) !== OID_SAN) continue;
    const octet = ext.value[ext.value.length - 1];
    const nomes = forge.asn1.fromDer(octet.value);
    let cnpj = "";
    let cpf = "";
    for (const g of nomes.value) {
      if (g.tagClass !== forge.asn1.Class.CONTEXT_SPECIFIC || g.type !== 0) continue; // otherName
      const oid = forge.asn1.derToOid(g.value[0].value);
      const embrulho = g.value[1]; // [0] EXPLICIT
      const interno = embrulho && embrulho.value && embrulho.value[0];
      const texto = interno && typeof interno.value === "string" ? interno.value : "";
      if (oid === OID_CNPJ) cnpj = texto.replace(/\D/g, "").slice(0, 14);
      else if (oid === OID_CPF) cpf = texto.slice(8, 19).replace(/\D/g, "");
    }
    if (cnpj.length === 14) return cnpj;
    if (cpf.length === 11) return cpf;
  }
  return "";
}

/**
 * Abre o .pfx. `bytes`: Uint8Array/ArrayBuffer; `senha`: string.
 */
export function lerPfx(bytes, senha) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let p12;
  try {
    const asn1 = forge.asn1.fromDer(bytesParaBin(u8));
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, true, senha || "");
  } catch (exc) {
    throw new ErroCertificado("senha do certificado incorreta, ou arquivo inválido");
  }
  const chaves = [
    ...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] || []),
    ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] || []),
  ].filter((b) => b.key);
  const certs = (p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || []).filter((b) => b.cert);
  if (!chaves.length) throw new ErroCertificado("o certificado não traz a chave privada");
  if (!certs.length) throw new ErroCertificado("o arquivo não traz certificado");

  const chave = chaves[0].key;
  // O certificado do titular é o que tem o mesmo módulo da chave.
  const doTitular = certs.find((b) => b.cert.publicKey.n && b.cert.publicKey.n.equals(chave.n)) || certs[0];
  const cert = doTitular.cert;
  // DER original do saco (não o re-codificado pelo forge): é o que vai no
  // KeyInfo e precisa ser o mesmo byte a byte.
  const certDer = binParaBytes(forge.asn1.toDer(doTitular.asn1 || forge.pki.certificateToAsn1(cert)).getBytes());
  const certAsn1 = forge.asn1.fromDer(bytesParaBin(certDer));

  const pkcs8 = forge.pki.wrapRsaPrivateKey(forge.pki.privateKeyToAsn1(chave));
  const chavePkcs8 = binParaBytes(forge.asn1.toDer(pkcs8).getBytes());

  const cn = (cert.subject.getField("CN") || {}).value || "";
  const [nome, ...resto] = String(cn).split(":");
  let documento = documentoDoSan(certAsn1);
  if (!documento) {
    const d = resto.join(":").replace(/\D/g, "");
    if (d.length === 14 || d.length === 11) documento = d;
  }
  return {
    certPem: forge.pki.certificateToPem(cert),
    certDer,
    cadeiaPem: certs.filter((b) => b !== doTitular).map((b) => forge.pki.certificateToPem(b.cert)),
    chavePkcs8,
    titular: nome.trim(),
    documento,
    validoAte: cert.validity.notAfter.toISOString(),
  };
}
