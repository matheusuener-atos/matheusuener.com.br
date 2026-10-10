"""
Gera as fixtures de ouro do emissor em JS (worker/teste-nfse-emissor.mjs).

Cada caso passa pelo emissor de referência em Python (paulus/legal/src/nfse):
prestador.conferir (a configuração limpa e as faltas), tributos.calcular (a
conta, com as linhas), conferencia.conferir (erros e avisos, com "hoje"
fixo), dps.montar (o XML e o Id) e conferencia.validar_xsd (o XSD oficial).
O JS refaz cada passo a partir das MESMAS entradas e tem de dar o mesmo
resultado, e o XML byte a byte.

Também o pedido de evento (pedRegEvento) de eventos.Eventos._pedido_xml, com
a hora fixa.

    C:/coryphaeus/paulus/legal/venv/Scripts/python.exe worker/nfse/fixtures/gerar_emissor.py

Não mexe nos .pfx nem no dps.json da prova (fixtures/gerar.py).
"""

from __future__ import annotations

import base64
import copy
import csv
import json
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

AQUI = Path(__file__).resolve().parent
RAIZ = AQUI.parents[2]
LEGAL = RAIZ / "paulus" / "legal"
sys.path.insert(0, str(LEGAL / "src"))
sys.path.insert(0, str(LEGAL / "tests"))

from _nfse_comum import CNPJ_PRESTADOR, CNPJ_TOMADOR, CPF_TOMADOR, GOIANIA  # noqa: E402

CPF_PRESTADOR = "11144477735"
BELEM = "1501402"
SAO_PAULO = "3550308"
FUSO = timezone(timedelta(hours=-3))
QUANDO = datetime(2026, 9, 15, 10, 30, 0, tzinfo=FUSO)
HOJE = date(2026, 10, 3)


def _quando_ret(texto: str) -> tuple[str, int]:
    if texto == "n":
        return "nunca", 0
    if texto in ("pj", "s"):
        return ("tomador_pj" if texto == "pj" else "sempre"), 0
    if texto.endswith("pj"):
        return "tomador_pj", int(texto[:-2])
    return "sempre", int(texto[:-1])


def _csv() -> list[dict]:
    arq = LEGAL / "tests" / "dados" / "nfse_referencia_n2.csv"
    linhas = [l for l in arq.read_text(encoding="utf-8").splitlines() if l and not l.startswith("#")]
    return list(csv.DictReader(linhas, delimiter=";"))


def _prest_csv(c: dict) -> dict:
    """A configuração do test_n2_dps.py, caso a caso (ainda crua: o JS também a limpa)."""
    ret = {}
    for k in ("iss", "irrf", "pis", "cofins", "csll", "cp"):
        quando, bp = _quando_ret(c[f"ret_{k}"])
        ret[k] = {"quando": quando, "aliquota_bp": bp, "minimo_centavos": int(c["min_irrf"]) if k == "irrf" else 0}
    return {
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


def _nota_csv(c: dict) -> dict:
    return {
        "valor_centavos": int(c["valor"]), "desconto_incond_centavos": int(c["desconto"]),
        "competencia": "2026-09-15", "descricao": f"Honorários — caso {c['caso']}",
        "municipio_incidencia": "" if c["loc_prest"] == "-" else c["loc_prest"],
        "tomador": {"nome": "Tomador de Teste", "documento": CPF_TOMADOR if c["tomador"] == "cpf" else CNPJ_TOMADOR,
                    "logradouro": "Rua 1", "numero": "10", "bairro": "Centro", "cep": "74000000", "cmun": GOIANIA,
                    "email": "fiscal@tomador.com.br"},
    }


def _sem_ret(**mudar) -> dict:
    r = {k: {"quando": "nunca", "aliquota_bp": 0, "minimo_centavos": 0} for k in ("iss", "irrf", "pis", "cofins", "csll", "cp")}
    r.update(mudar)
    return r


def _pavlvs(opcao: str, reg_ap: str, ctribnac: str, nbs: str, cindop: str, municipio: str = BELEM) -> dict:
    """O PAVLVS vendendo software: IBS/CBS com cClassTrib 000001 e CST 000."""
    return {
        "documento": CNPJ_PRESTADOR, "razao_social": "PAVLVS Tecnologia", "inscricao_municipal": "7788990",
        "municipio": municipio, "opcao_simples": opcao, "regime_apuracao_sn": reg_ap, "regime_especial": "0",
        "servico": {"ctribnac": ctribnac, "nbs": nbs, "descricao": "Assinatura do PAULUS", "aliquota_iss_bp": 200},
        "retencoes": _sem_ret(), "pis_cofins": {"cst": ""},
        "ibscbs": {"enviar": True, "cst": "000", "cclasstrib": "000001", "cindop": cindop, "indfinal": "1"},
        "total_tributos": {"modo": "simples" if opcao == "3" else "percentual", "federal_bp": 1345,
                           "estadual_bp": 0, "municipal_bp": 200, "simples_bp": 600},
        "serie": "900",
    }


TOM_PF = {"nome": "Ana  Advocacia\tME", "documento": "529.982.247-25", "logradouro": "Rua dos Mundurucus",
          "numero": "1500", "complemento": "Sala 3", "bairro": "Batista Campos", "cep": "66010-000",
          "cmun": BELEM, "email": "ana@escritorio.com.br", "telefone": "(91) 98888-7777"}
TOM_PJ = {"nome": "Bruno & Cia <Advogados> \"Associados\"", "documento": "45.997.418/0001-53",
          "inscricao_municipal": " 12 34 5 ", "logradouro": "Av. Paulista", "numero": "", "bairro": "Bela Vista",
          "cep": "01310100", "cmun": SAO_PAULO, "email": "fiscal@bruno.adv.br", "telefone": "1133334444"}


def _extras() -> list[dict]:
    casos = []
    # Os dois códigos de software do PAVLVS. 110322000 é o código pedido para
    # 01.05, e NÃO está na tabela NBS oficial (a conferência acusa E0316 nos
    # dois lados); 111032200 é o "licenciamento de direitos de uso de
    # programas de computador" da correlação oficial (Anexo VIII) para 01.05.
    casos.append({"nome": "software 01.05 / NBS 110322000 / cIndOp 100501 (NBS fora da tabela)",
                  "prest": _pavlvs("3", "1", "010501", "", "100501"),
                  "nota": {"valor_centavos": 30000, "competencia": "2026-10-01", "descricao": "Assinatura do PAULUS — plano mensal",
                           "nbs": "110322000", "tomador": TOM_PF}, "ativo": True})
    casos.append({"nome": "software 01.05 / NBS 111032200 / cIndOp 100501",
                  "prest": _pavlvs("3", "1", "010501", "111032200", "100501"),
                  "nota": {"valor_centavos": 30000, "competencia": "2026-10-01", "descricao": "Assinatura do PAULUS — plano mensal",
                           "tomador": TOM_PF}, "ativo": True})
    casos.append({"nome": "software 01.03 / NBS 115062100 / cIndOp 100301, não optante",
                  "prest": _pavlvs("1", "", "010301", "115062100", "100301"),
                  "nota": {"valor_centavos": 5000, "competencia": "2026-10-02", "descricao": "Recarga de uso do PAULUS (nuvem)",
                           "tomador": TOM_PJ}, "ativo": True})
    casos.append({"nome": "software 01.03 / NBS 115062100, município sem convênio (alíquota vai)",
                  "prest": _pavlvs("1", "", "010301", "115062100", "100301"),
                  "nota": {"valor_centavos": 123456, "competencia": "2026-09-30", "descricao": "SaaS",
                           "tomador": TOM_PJ}, "ativo": False})
    # Bordas do texto: & < > aspas, \r\n, tab, acento, emoji, informações, cTribMun, substituição.
    p = _prest_csv(next(c for c in _csv() if c["caso"] == "3"))
    p["servico"]["ctribmun"] = "001"
    casos.append({"nome": "bordas de texto, informações, cTribMun e substituição",
                  "prest": p,
                  "nota": {"valor_centavos": 500000, "competencia": "2026-09-15",
                           "descricao": "  Honorários & custas <fase 2> \"aspas\" 'apóstrofo' — ação nº 123\nlinha 2\r\nlinha 3\tcom tab ção ü € 😀  ",
                           "informacoes": " Pagamento via PIX\r\nobrigado ",
                           "substitui": {"chave": "52087072211222333000181000000000000126091234567890", "motivo": "99",
                                         "texto": "  Valor  digitado\nerrado  na nota anterior  "},
                           "tomador": {**TOM_PJ, "cmun": GOIANIA, "cep": "74000-000"}}, "ativo": True})
    # MEI sem percentual: indTotTrib 0; tomador sem endereço e sem e-mail.
    casos.append({"nome": "MEI sem total de tributos; tomador sem endereço",
                  "prest": {"documento": CNPJ_PRESTADOR, "municipio": GOIANIA, "opcao_simples": "2",
                            "servico": {"ctribnac": "171401", "descricao": "Serviço"}, "retencoes": _sem_ret(),
                            "ibscbs": {"enviar": False}, "total_tributos": {"modo": "percentual"}},
                  "nota": {"valor_centavos": 99999, "desconto_incond_centavos": 999, "competencia": "2026-08-31",
                           "descricao": "Consultoria", "tomador": {"nome": "Fulano", "documento": CPF_TOMADOR}},
                  "ativo": True})
    # Erros da conferência: CNPJ que não confere, sem nome, e-mail torto, CEP curto, município fora da tabela.
    casos.append({"nome": "conferência com erros",
                  "prest": _pavlvs("1", "", "010301", "115062100", "100301"),
                  "nota": {"valor_centavos": 1000, "competencia": "2026-10-04", "descricao": "",
                           "tomador": {"nome": " ", "documento": "11222333000182", "email": "sem-arroba", "cep": "123",
                                       "cmun": "9999999", "logradouro": "Rua"}}, "ativo": True})
    casos.append({"nome": "competência inválida e ISS retido sem endereço",
                  "prest": _prest_csv(next(c for c in _csv() if c["caso"] == "4")),
                  "nota": {"valor_centavos": 1000, "competencia": "2026-02-30", "descricao": "x",
                           "tomador": {"nome": "Empresa", "documento": CNPJ_TOMADOR}}, "ativo": True})
    return casos


def _caso(nome: str, prest_cru: dict, nota: dict, ativo: bool, serie: str | None, numero: int, ambiente: str) -> dict:
    from nfse import conferencia, dps, prestador, tributos

    limpo, faltas = prestador.conferir(copy.deepcopy(prest_cru))
    conta = tributos.calcular(limpo, nota, municipio_ativo=ativo)
    erros, avisos = conferencia.conferir(prest=limpo, nota=nota, conta=conta,
                                         municipio={"pode_emitir": True}, hoje=HOJE)
    serie = serie or limpo.get("serie") or "1"
    try:
        xml, ident = dps.montar(prest=limpo, nota=nota, conta=conta, ambiente=ambiente, serie=serie,
                                numero=numero, quando=QUANDO, ver_aplic="PAVLVS-nuvem")
        xsd = conferencia.validar_xsd(xml, ambiente)
        xml_b64, erro_montar = base64.b64encode(xml).decode(), ""
    except (ValueError, KeyError) as exc:
        xml_b64, ident, xsd, erro_montar = "", "", [], str(exc)
    return {"nome": nome, "prest_cru": prest_cru, "prest": limpo, "faltas": faltas, "nota": nota,
            "municipio_ativo": ativo, "conta": conta.to_dict(), "erros": erros, "avisos": avisos,
            "ambiente": ambiente, "serie": serie, "numero": numero, "id": ident, "xml_b64": xml_b64,
            "xsd": xsd, "erro_montar": erro_montar}


def _eventos() -> list[dict]:
    """O pedido de evento como eventos.Eventos._pedido_xml monta, com a hora fixa."""
    import versao
    from nfse import eventos

    class _Hora(datetime):
        @classmethod
        def now(cls, tz=None):
            return QUANDO.astimezone(tz) if tz else QUANDO.replace(tzinfo=None)

    eventos.datetime = _Hora

    class _Notas:
        def __init__(self, prest):
            self.prest = prest

        def prestador_da_nota(self, nota):
            return {"dados": self.prest}

    class _Falso:
        def __init__(self, prest):
            self.notas = _Notas(prest)

    chave = "52087072211222333000181000000000000126091234567890"
    saida = []
    for nome, doc, amb, tipo, motivo, texto in (
            ("cancelamento, CNPJ, produção restrita", CNPJ_PRESTADOR, "producao_restrita", "101101", "1",
             "Erro na emissão: valor & tomador <errados>"),
            ("cancelamento, CPF, produção", CPF_PRESTADOR, "producao", "101101", "9", "Serviço cancelado pelo cliente — ç ü")):
        xml, ident = eventos.Eventos._pedido_xml(_Falso({"documento": doc}), {"chave": chave, "ambiente": amb},
                                                 tipo, motivo, texto)
        saida.append({"nome": nome, "documento": doc, "ambiente": amb, "tipo": tipo, "motivo": motivo, "texto": texto,
                      "chave": chave, "ver_aplic": f"PAULUS-{versao.VERSAO}", "id": ident,
                      "xml_b64": base64.b64encode(xml).decode()})
    return saida


def main() -> None:
    casos = []
    for c in _csv():
        casos.append(_caso(f"N2 caso {c['caso']}: {c['descricao']}", _prest_csv(c), _nota_csv(c), c["ativo"] == "1",
                           "1", int(c["caso"]), "producao_restrita"))
    for i, e in enumerate(_extras()):
        casos.append(_caso(e["nome"], e["prest"], e["nota"], e["ativo"], None, 1000 + i,
                           "producao" if i % 2 else "producao_restrita"))
    dados = {"quando": QUANDO.isoformat(), "hoje": HOJE.isoformat(), "casos": casos, "eventos": _eventos()}
    (AQUI / "emissor.json").write_text(json.dumps(dados, ensure_ascii=False, indent=1), encoding="utf-8")
    for c in casos:
        estado = "XSD ok" if c["xml_b64"] and not c["xsd"] else ("XSD: " + "; ".join(c["xsd"])[:120] if c["xml_b64"] else "sem XML: " + c["erro_montar"])
        print(f"{c['nome'][:70]:70} erros={len(c['erros'])} avisos={len(c['avisos'])} {estado}")
    print("eventos:", [e["id"] for e in dados["eventos"]])


if __name__ == "__main__":
    main()
