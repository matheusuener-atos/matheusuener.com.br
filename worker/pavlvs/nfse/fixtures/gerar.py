"""
Gera as fixtures da prova do emissor de NFS-e no Worker (worker/teste-nfse-prova.mjs).

Tudo sai do emissor de referência em Python (paulus/legal/src/nfse): os .pfx
de teste (certificado_a1 dos testes), DPS montadas por dps.montar, assinadas
por assinatura.assinar e embrulhadas por cliente.gzip_b64. O teste em JS
refaz cada passo e compara.

    C:/coryphaeus/paulus/legal/venv/Scripts/python.exe worker/nfse/fixtures/gerar.py

Os certificados são de TESTE (autoassinados, não ICP-Brasil): não servem
para a Sefin, só para conferir aqui.
"""

from __future__ import annotations

import base64
import csv
import json
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

AQUI = Path(__file__).resolve().parent
RAIZ = AQUI.parents[2]
LEGAL = RAIZ / "paulus" / "legal"
sys.path.insert(0, str(LEGAL / "src"))
sys.path.insert(0, str(LEGAL / "tests"))

from _nfse_comum import CNPJ_PRESTADOR, CNPJ_TOMADOR, CPF_TOMADOR, GOIANIA, certificado_a1  # noqa: E402

SENHA = "segredo-de-teste"
CPF_PRESTADOR = "11144477735"
QUANDO = datetime(2026, 9, 15, 10, 30, 0, tzinfo=timezone(timedelta(hours=-3)))


def _pfx_com_oid(destino: Path, oid: str, valor: str, nome: str) -> None:
    """Um .pfx no formato ICP-Brasil de verdade: CN só com o nome e o
    documento num otherName do SubjectAltName (2.16.76.1.3.3 CNPJ, .1 CPF)."""
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.hazmat.primitives.serialization import pkcs12
    from cryptography.x509.oid import NameOID, ObjectIdentifier

    chave = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    nome_x = x509.Name([x509.NameAttribute(NameOID.COUNTRY_NAME, "BR"),
                        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "ICP-Brasil"),
                        x509.NameAttribute(NameOID.COMMON_NAME, nome)])
    # otherName: valor [0] EXPLICIT OCTET STRING (como as AC da ICP-Brasil emitem).
    bruto = valor.encode("ascii")
    octet = bytes([0x04, len(bruto)]) + bruto
    agora = datetime.now(timezone.utc)
    cert = (x509.CertificateBuilder()
            .subject_name(nome_x).issuer_name(nome_x).public_key(chave.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(agora - timedelta(days=1)).not_valid_after(agora + timedelta(days=365))
            .add_extension(x509.SubjectAlternativeName([
                x509.OtherName(ObjectIdentifier(oid), octet),
                x509.RFC822Name("fiscal@escritorio.com.br")]), critical=False)
            .sign(chave, hashes.SHA256()))
    pfx = pkcs12.serialize_key_and_certificates(b"teste", chave, cert, None,
                                                serialization.BestAvailableEncryption(SENHA.encode()))
    destino.write_bytes(pfx)


def _pfx_legado(destino: Path, pfx: bytes) -> None:
    """O mesmo certificado no formato que o Windows e as AC costumam exportar:
    3DES (PBE-SHA1) com 2048 rodadas e MAC SHA-1. O certificado_a1 dos testes
    usa o BestAvailableEncryption (AES-256, PBKDF2 com muito mais rodadas),
    bem mais caro de abrir em JS puro."""
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.serialization import PrivateFormat, pkcs12

    chave, cert, extras = pkcs12.load_key_and_certificates(pfx, SENHA.encode())
    cifra = (PrivateFormat.PKCS12.encryption_builder().kdf_rounds(2048)
             .key_cert_algorithm(pkcs12.PBES.PBESv1SHA1And3KeyTripleDESCBC)
             .hmac_hash(hashes.SHA1()).build(SENHA.encode()))
    destino.write_bytes(pkcs12.serialize_key_and_certificates(b"teste", chave, cert, extras, cifra))


def _quando_ret(texto: str) -> tuple[str, int]:
    if texto == "n":
        return "nunca", 0
    if texto in ("pj", "s"):
        return ("tomador_pj" if texto == "pj" else "sempre"), 0
    if texto.endswith("pj"):
        return "tomador_pj", int(texto[:-2])
    return "sempre", int(texto[:-1])


def _casos() -> dict[str, dict]:
    arq = LEGAL / "tests" / "dados" / "nfse_referencia_n2.csv"
    linhas = [l for l in arq.read_text(encoding="utf-8").splitlines() if l and not l.startswith("#")]
    return {c["caso"]: c for c in csv.DictReader(linhas, delimiter=";")}


def _prestador(c: dict) -> dict:
    from nfse import prestador

    ret = {}
    for k in ("iss", "irrf", "pis", "cofins", "csll", "cp"):
        quando, bp = _quando_ret(c[f"ret_{k}"])
        ret[k] = {"quando": quando, "aliquota_bp": bp, "minimo_centavos": int(c["min_irrf"]) if k == "irrf" else 0}
    dados = {
        "documento": CPF_PRESTADOR if c["prestador"] == "cpf" else CNPJ_PRESTADOR,
        "razao_social": "Escritório de Teste", "inscricao_municipal": "123456", "municipio": GOIANIA,
        "opcao_simples": c["op_simples"], "regime_apuracao_sn": "" if c["reg_ap"] == "-" else c["reg_ap"],
        "regime_especial": c["reg_esp"],
        "servico": {"ctribnac": "171401", "nbs": "113012000", "descricao": "Honorários advocatícios",
                    "aliquota_iss_bp": int(c["aliq_iss"])},
        "retencoes": ret, "pis_cofins": {"cst": "01"},
        "ibscbs": {"enviar": c["ibscbs"] == "1", "cst": "200", "cclasstrib": "200052", "cindop": "100301"},
        "total_tributos": {"modo": "simples" if c["op_simples"] == "3" else "percentual", "federal_bp": 1345,
                           "estadual_bp": 0, "municipal_bp": 500, "simples_bp": 600},
    }
    limpo, _ = prestador.conferir(dados)
    return limpo


def _nota(c: dict, descricao: str, nome_tomador: str) -> dict:
    return {
        "valor_centavos": int(c["valor"]), "desconto_incond_centavos": int(c["desconto"]),
        "competencia": "2026-09-15", "descricao": descricao,
        "municipio_incidencia": "" if c["loc_prest"] == "-" else c["loc_prest"],
        "tomador": {"nome": nome_tomador, "documento": CPF_TOMADOR if c["tomador"] == "cpf" else CNPJ_TOMADOR,
                    "logradouro": "Rua 1", "numero": "10", "bairro": "Centro", "cep": "74000000", "cmun": GOIANIA,
                    "email": "fiscal@tomador.com.br"},
    }


def main() -> None:
    from nfse import assinatura, cliente, dps, tributos

    with tempfile.TemporaryDirectory() as tmp:
        pfx_cn = certificado_a1(Path(tmp) / "cn.pfx", senha=SENHA).read_bytes()
    (AQUI / "a1-cn.pfx").write_bytes(pfx_cn)
    _pfx_legado(AQUI / "a1-legado.pfx", pfx_cn)
    _pfx_com_oid(AQUI / "a1-ecnpj.pfx", "2.16.76.1.3.3", CNPJ_PRESTADOR, "ESCRITORIO OID LTDA")
    # e-CPF: nascimento(8) + CPF(11) + NIS(11) + RG(15) + órgão/UF(6)
    _pfx_com_oid(AQUI / "a1-ecpf.pfx", "2.16.76.1.3.1",
                 "01011980" + CPF_PRESTADOR + "0" * 11 + "0" * 15 + "SSPGO ", "FULANO DE TAL")

    casos = _casos()
    escolhas = [
        ("1", "Honorários advocatícios — caso 1", "Tomador de Teste", "sha1"),
        ("3", "Honorários & custas <fase 2> \"aspas\" 'apóstrofo' — ação nº 123\nlinha 2\r\nlinha 3\tcom tab",
         "Tomador & Filhos <Ltda> \"ME\"", "sha1"),
        ("15", "Parecer jurídico — advogado autônomo (CPF) ção ü € 😀", "Empresa Ação S/A", "sha1"),
        ("8", "Consultoria — Simples, assinada com SHA-256", "Tomador de Teste", "sha256"),
    ]
    saida = []
    for caso, desc, nome, alg in escolhas:
        c = casos[caso]
        prest = _prestador(c)
        nota = _nota(c, desc, nome)
        conta = tributos.calcular(prest, nota, municipio_ativo=c["ativo"] == "1")
        xml, ident = dps.montar(prest=prest, nota=nota, conta=conta, ambiente="producao_restrita",
                                serie="1", numero=int(caso), quando=QUANDO, ver_aplic="PAULUS-teste")
        assinado = assinatura.assinar(xml, pfx_cn, SENHA, ident, algoritmo=alg)
        ok, msg = assinatura.verificar(assinado)
        assert ok, msg
        saida.append({
            "caso": caso, "id": ident, "algoritmo": alg,
            "xml_b64": base64.b64encode(xml).decode(),
            "assinado_b64": base64.b64encode(assinado).decode(),
            "gzip_b64_python": cliente.gzip_b64(assinado),
        })
    # Uma resposta "da Sefin" embrulhada pelo Python, para o JS desembrulhar.
    resposta_xml = saida[0]["assinado_b64"]
    dados = {
        "senha": SENHA, "cnpj": CNPJ_PRESTADOR, "cpf": CPF_PRESTADOR,
        "dps": saida,
        "resposta_gzip_b64": cliente.gzip_b64(base64.b64decode(resposta_xml)),
        "resposta_xml_b64": resposta_xml,
    }
    (AQUI / "dps.json").write_text(json.dumps(dados, ensure_ascii=False, indent=1), encoding="utf-8")
    print("fixtures gravadas:", [p.name for p in AQUI.iterdir()])


if __name__ == "__main__":
    main()
