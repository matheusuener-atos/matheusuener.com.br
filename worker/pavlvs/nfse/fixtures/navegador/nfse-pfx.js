/* Abre o certificado A1 (.pfx / .p12) NO NAVEGADOR, para o painel admin
   (Notas fiscais › certificado). O arquivo e a senha nunca vão ao servidor:
   daqui sai só o que o emissor precisa, e é isso que o painel manda ao Worker
   (POST /api/admin/nfse/emissor/certificado):
     certPem      o certificado do titular (o que tem a chave)
     cadeiaPem    os demais certificados do arquivo (AC intermediária/raiz)
     chavePkcs8   a chave privada em PKCS#8 DER, em base64
     titular      o nome do CN, sem o ":documento" do padrão ICP-Brasil
     documento    CNPJ (14) ou CPF (11): do otherName da ICP-Brasil
                  (2.16.76.1.3.3 = CNPJ; 2.16.76.1.3.1 = nascimento + CPF)
                  ou, sem ele, do CN "NOME:DOCUMENTO"
     validoAte    ISO 8601 (UTC)
   Porte de worker/nfse/pfx.js (mesma lógica). Precisa do node-forge
   vendorizado (assets/vendor/forge.min.js), carregado antes: window.forge. */
(function () {
  "use strict";
  var OID_CNPJ = "2.16.76.1.3.3";
  var OID_CPF = "2.16.76.1.3.1";
  var OID_SAN = "2.5.29.17";

  function bytesParaBin(u8) {
    var s = "";
    for (var i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return s;
  }

  function documentoDoSan(forge, certAsn1) {
    var tbs = certAsn1.value[0];
    var ctx3 = tbs.value.filter(function (v) { return v.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC && v.type === 3; })[0];
    if (!ctx3) return "";
    var exts = ctx3.value[0].value;
    for (var i = 0; i < exts.length; i++) {
      var ext = exts[i];
      if (forge.asn1.derToOid(ext.value[0].value) !== OID_SAN) continue;
      var octet = ext.value[ext.value.length - 1];
      var nomes = forge.asn1.fromDer(octet.value);
      var cnpj = "", cpf = "";
      for (var j = 0; j < nomes.value.length; j++) {
        var g = nomes.value[j];
        if (g.tagClass !== forge.asn1.Class.CONTEXT_SPECIFIC || g.type !== 0) continue; // otherName
        var oid = forge.asn1.derToOid(g.value[0].value);
        var embrulho = g.value[1];
        var interno = embrulho && embrulho.value && embrulho.value[0];
        var texto = interno && typeof interno.value === "string" ? interno.value : "";
        if (oid === OID_CNPJ) cnpj = texto.replace(/\D/g, "").slice(0, 14);
        else if (oid === OID_CPF) cpf = texto.slice(8, 19).replace(/\D/g, "");
      }
      if (cnpj.length === 14) return cnpj;
      if (cpf.length === 11) return cpf;
    }
    return "";
  }

  /* bytes: ArrayBuffer ou Uint8Array; senha: texto. Lança Error com a frase para a tela. */
  function ler(bytes, senha) {
    var forge = window.forge;
    if (!forge || !forge.pkcs12) throw new Error("não consegui carregar o leitor de certificados; recarregue a página");
    var u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var p12;
    try {
      p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(bytesParaBin(u8)), true, senha || "");
    } catch (e) {
      throw new Error("senha do certificado incorreta, ou o arquivo não é um .pfx/.p12");
    }
    var oids = forge.pki.oids;
    var chaves = [].concat(p12.getBags({ bagType: oids.pkcs8ShroudedKeyBag })[oids.pkcs8ShroudedKeyBag] || [], p12.getBags({ bagType: oids.keyBag })[oids.keyBag] || [])
      .filter(function (b) { return b.key; });
    var certs = (p12.getBags({ bagType: oids.certBag })[oids.certBag] || []).filter(function (b) { return b.cert; });
    if (!chaves.length) throw new Error("o certificado não traz a chave privada");
    if (!certs.length) throw new Error("o arquivo não traz certificado");
    var chave = chaves[0].key;
    var doTitular = certs.filter(function (b) { return b.cert.publicKey.n && b.cert.publicKey.n.equals(chave.n); })[0] || certs[0];
    var cert = doTitular.cert;
    var certDerBin = forge.asn1.toDer(doTitular.asn1 || forge.pki.certificateToAsn1(cert)).getBytes();
    var certAsn1 = forge.asn1.fromDer(certDerBin);
    var pkcs8 = forge.pki.wrapRsaPrivateKey(forge.pki.privateKeyToAsn1(chave));
    var chaveB64 = forge.util.encode64(forge.asn1.toDer(pkcs8).getBytes());
    var cnField = cert.subject.getField("CN") || {};
    var partes = String(cnField.value || "").split(":");
    var nome = partes[0];
    var documento = documentoDoSan(forge, certAsn1);
    if (!documento) {
      var dd = partes.slice(1).join(":").replace(/\D/g, "");
      if (dd.length === 14 || dd.length === 11) documento = dd;
    }
    return {
      certPem: forge.pki.certificateToPem(cert),
      cadeiaPem: certs.filter(function (b) { return b !== doTitular; }).map(function (b) { return forge.pki.certificateToPem(b.cert); }),
      chavePkcs8: chaveB64,
      titular: nome.trim(),
      documento: documento,
      validoAte: cert.validity.notAfter.toISOString(),
    };
  }

  window.PavlvsPfx = { ler: ler };
})();
