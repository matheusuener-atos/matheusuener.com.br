"""
Gera as fixtures de ouro do DANFSe em JS (worker/teste-nfse-danfse.mjs).

Cada DPS do emissor.json (as mesmas do teste do emissor) vira uma NFS-e pela
Sefin simulada do Python (tests/_sefin_simulada.py), com a hora e o número
aleatório fixos, e algumas ganham variações (tomador estrangeiro, sem
tomador, sem xTribNac, descrição comprida, produção, situação 102...). Para
cada uma, o que nfse.danfse.dados_do_xml tira do XML e a matriz do QR Code
que o reportlab desenha (QrCodeWidget, nível L, como o danfse.gerar). O JS
refaz os dois e tem de dar igual.

    C:/coryphaeus/paulus/legal/venv/Scripts/python.exe worker/nfse/fixtures/gerar_danfse.py

Escreve worker/nfse/fixtures/danfse.json.
"""

from __future__ import annotations

import base64
import json
import sys
import tempfile
from datetime import datetime
from pathlib import Path

from lxml import etree

AQUI = Path(__file__).resolve().parent
RAIZ = AQUI.parents[2]
LEGAL = RAIZ / "paulus" / "legal"
sys.path.insert(0, str(LEGAL / "src"))
sys.path.insert(0, str(LEGAL / "tests"))

import _sefin_simulada  # noqa: E402
from nfse import danfse  # noqa: E402

NS = "http://www.sped.fazenda.gov.br/nfse"
N = {"n": NS}


class _Agora(datetime):
    momento = datetime(2026, 9, 15, 10, 31, 7)

    @classmethod
    def now(cls, tz=None):  # noqa: D401
        return cls.momento


class _Sorte:
    valor = 123456789

    @classmethod
    def randint(cls, a, b):
        return cls.valor


_sefin_simulada.datetime = _Agora
_sefin_simulada.random = _Sorte


def q(nome: str) -> str:
    return f"{{{NS}}}{nome}"


def sub(pai, nome: str, texto: str | None = None, antes: str | None = None):
    el = etree.Element(q(nome))
    if texto is not None:
        el.text = texto
    if antes is not None and pai.find(q(antes)) is not None:
        pai.find(q(antes)).addprevious(el)
    else:
        pai.append(el)
    return el


def qr_matriz(texto: str) -> list[str]:
    from reportlab.graphics.barcode.qr import QrCodeWidget

    w = QrCodeWidget(texto)
    w.qr.make()
    return ["".join("1" if m else "0" for m in linha) for linha in w.qr.modules]


# ------------------------------------------------------------ variações

def enriquecer_emitente(inf):
    emit = inf.find("n:emit", N)
    sub(emit, "IM", "998877", antes="xNome")
    end = emit.find("n:enderNac", N)
    sub(end, "xCpl", "Sala 1203")
    sub(emit, "fone", "62999998888")
    sub(emit, "email", "financeiro@escritorio.com.br")


def federais_completos(dps_inf):
    fed = dps_inf.find("n:valores/n:trib/n:tribFed", N)
    pc = fed.find("n:piscofins", N)
    sub(pc, "vBCPisCofins", "5000.00")
    sub(pc, "pAliqPis", "0.65")
    sub(pc, "pAliqCofins", "3.00")
    sub(pc, "vPis", "32.50")
    sub(pc, "vCofins", "150.00")
    if fed.find("n:vRetCP", N) is None:
        sub(fed, "vRetCP", "550.00")
    vals = dps_inf.find("n:valores", N)
    dc = vals.find("n:vDescCondIncond", N)
    if dc is None:
        dc = sub(vals, "vDescCondIncond", antes="trib")
        sub(dc, "vDescIncond", "0")
    sub(dc, "vDescCond", "40.00")


def sem_tomador(dps_inf):
    dps_inf.remove(dps_inf.find("n:toma", N))


def tomador_estrangeiro(dps_inf):
    toma = dps_inf.find("n:toma", N)
    for tag in ("CNPJ", "CPF"):
        el = toma.find(f"n:{tag}", N)
        if el is not None:
            novo = etree.Element(q("NIF"))
            novo.text = "DE811234567"
            el.addprevious(novo)
            toma.remove(el)
    end = toma.find("n:end", N)
    if end is not None:
        toma.remove(end)
    sub(toma, "fone", "+49 30 1234567")


def municipio_desconhecido(dps_inf):
    c = dps_inf.find("n:toma/n:end/n:endNac/n:cMun", N)
    if c is not None:
        c.text = "9999999"


def descricao_comprida(dps_inf):
    d = dps_inf.find("n:serv/n:cServ/n:xDescServ", N)
    d.text = ("Honorários advocatícios referentes ao acompanhamento processual da ação de cobrança nº "
              "5001234-56.2026.8.09.0051, fase de instrução, conforme o contrato de prestação de serviços "
              "assinado em 02/01/2026, com audiências, petições, diligências e despachos com o juízo. ") * 4
    toma = dps_inf.find("n:toma", N)
    if toma is not None:
        toma.find("n:xNome", N).text = ("Companhia Brasileira de Distribuição de Produtos Agropecuários "
                                        "e Insumos do Centro-Oeste Sociedade Anônima")


def info_comprida(dps_inf):
    serv = dps_inf.find("n:serv", N)
    ic = serv.find("n:infoCompl", N)
    if ic is None:
        ic = sub(serv, "infoCompl")
        sub(ic, "xInfComp", "")
    ic.find("n:xInfComp", N).text = "Pagamento por PIX em 15/09/2026. Pedido de compra 7781. " * 12


def total_simples(dps_inf):
    tt = dps_inf.find("n:valores/n:trib/n:totTrib", N)
    if tt is None:
        tt = sub(dps_inf.find("n:valores/n:trib", N), "totTrib")
    for f in list(tt):
        tt.remove(f)
    sub(tt, "pTotTribSN", "6.00")


def finalidade(dps_inf):
    fin = dps_inf.find("n:IBSCBS/n:finNFSe", N)
    if fin is not None:
        fin.text = "1"


def nfse_sem_xtribnac(inf):
    inf.remove(inf.find("n:xTribNac", N))


def nfse_102(inf):
    inf.find("n:cStat", N).text = "102"


def nfse_sem_emit(inf):
    inf.remove(inf.find("n:emit", N))


# índice no emissor.json -> (variações na DPS, variações na NFS-e, rótulo)
VARIACOES = {
    3: ((federais_completos,), (enriquecer_emitente,), "retenções completas e IBS/CBS, emitente com telefone e e-mail"),
    7: ((total_simples,), (enriquecer_emitente,), "Simples Nacional com total de tributos do SN"),
    14: ((tomador_estrangeiro,), (), "tomador estrangeiro (NIF), sem endereço"),
    16: ((municipio_desconhecido, finalidade), (nfse_102,), "município fora da tabela, finalidade 1, situação 102"),
    19: ((sem_tomador,), (nfse_sem_xtribnac,), "sem tomador e sem xTribNac (descrição da tabela)"),
    21: ((descricao_comprida, info_comprida), (), "produção, descrição e informações compridas (corte)"),
    24: ((), (enriquecer_emitente,), "bordas de texto, informações e substituição"),
    25: ((), (nfse_sem_emit,), "MEI sem emitente no grupo emit"),
}


def main() -> None:
    emissor = json.loads((AQUI / "emissor.json").read_text(encoding="utf-8"))
    casos = []
    with tempfile.TemporaryDirectory() as tmp:
        sim = _sefin_simulada.SefinSimulada(Path(tmp) / "sefin.json")
        for i, c in enumerate(emissor["casos"]):
            if not c.get("xml_b64"):
                continue
            dps = etree.fromstring(base64.b64decode(c["xml_b64"]))
            dps_v, nfse_v, rotulo = VARIACOES.get(i, ((), (), ""))
            for f in dps_v:
                f(dps.find("n:infDPS", N))
            _Sorte.valor = 100000000 + i
            xml = sim._montar_nfse(dps, 1000 + i)
            if nfse_v:
                raiz = etree.fromstring(xml)
                for f in nfse_v:
                    f(raiz.find("n:infNFSe", N))
                xml = etree.tostring(raiz, xml_declaration=True, encoding="UTF-8")
            dados = danfse.dados_do_xml(xml)
            casos.append({"nome": c["nome"] + (" + " + rotulo if rotulo else ""), "xml": xml.decode("utf-8"),
                          "dados": dados, "qr": qr_matriz(danfse.url_qr(dados["chave"]))})
    extras = ["https://www.nfse.gov.br/ConsultaPublica/?tpc=1&chave=", "PAVLVS", "a" * 120,
              "Olá, mundo! ação 1234567890", "x" * 200]
    saida = {"casos": casos, "qr_extras": [{"texto": t, "matriz": qr_matriz(t)} for t in extras]}
    (AQUI / "danfse.json").write_text(json.dumps(saida, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{len(casos)} casos, {len(extras)} QR extras -> danfse.json")


if __name__ == "__main__":
    main()
