"""
As tabelas oficiais da NFS-e que o emissor do Worker usa, em JSON compacto,
tiradas das de paulus/legal/src/nfse/tabelas (as mesmas do PAULUS).

Só o necessário para montar e conferir a DPS na nuvem:

  municipios.json  {"codigo IBGE": "nome"}  (a UF sai dos 2 primeiros dígitos;
                   o script confere que bate com a tabela em todos os 5.570)
  servicos.json    {"cTribNac": "local de incidência (EP/LP/ET ou vazio)"}
  servicos_descricao.json  {"cTribNac": "descrição"}  (só o DANFSe usa, quando a
                   NFS-e não traz o xTribNac)
  nbs.json         ["código NBS", ...]
  indop.json       ["cIndOp", ...]
  regras.json      {"E0014": ["mensagem", "campo"], ...}  (DPS + eventos)
  dominios.json    {"motivo_cancelamento": {...}, ...}  (os domínios do XSD usados,
                   inclusive os rótulos que o DANFSe imprime)
  versoes.json     a versão, a data e a fonte de cada tabela de origem

    C:/coryphaeus/paulus/legal/venv/Scripts/python.exe worker/nfse/tabelas/gerar.py
"""

from __future__ import annotations

import json
from pathlib import Path

AQUI = Path(__file__).resolve().parent
ORIGEM = AQUI.parents[2] / "paulus" / "legal" / "src" / "nfse" / "tabelas"

UF_DO_CODIGO = {
    "11": "RO", "12": "AC", "13": "AM", "14": "RR", "15": "PA", "16": "AP", "17": "TO",
    "21": "MA", "22": "PI", "23": "CE", "24": "RN", "25": "PB", "26": "PE", "27": "AL",
    "28": "SE", "29": "BA", "31": "MG", "32": "ES", "33": "RJ", "35": "SP", "41": "PR",
    "42": "SC", "43": "RS", "50": "MS", "51": "MT", "52": "GO", "53": "DF",
}
DOMINIOS = ("motivo_cancelamento", "motivo_substituicao", "regime_especial", "opcao_simples",
            "regime_apuracao_sn", "cst_pis_cofins", "retencao_pis_cofins", "retencao_iss", "tributacao_iss")


def _ler(nome: str) -> dict:
    return json.loads((ORIGEM / f"{nome}.json").read_text(encoding="utf-8"))


def _gravar(nome: str, dados) -> int:
    texto = json.dumps(dados, ensure_ascii=False, separators=(",", ":"))
    (AQUI / f"{nome}.json").write_text(texto, encoding="utf-8")
    return len(texto.encode("utf-8"))


def main() -> None:
    versoes = {}
    tamanhos = {}

    t = _ler("municipios")
    mun = {}
    for m in t["itens"]:
        if UF_DO_CODIGO.get(m["codigo"][:2]) != m["uf"]:
            raise SystemExit(f"UF fora do padrão: {m}")
        mun[m["codigo"]] = m["nome"]
    tamanhos["municipios"] = _gravar("municipios", mun)
    versoes["municipios"] = {k: t.get(k, "") for k in ("versao", "data", "fonte")}

    s, inc = _ler("servicos"), _ler("incidencia")
    local = {i["codigo"]: i.get("local", "") for i in inc["itens"]}
    tamanhos["servicos"] = _gravar("servicos", {i["codigo"]: local.get(i["codigo"], "") for i in s["itens"]})
    tamanhos["servicos_descricao"] = _gravar("servicos_descricao", {i["codigo"]: i.get("descricao", "") for i in s["itens"]})
    versoes["servicos"] = {k: s.get(k, "") for k in ("versao", "data", "fonte")}
    versoes["incidencia"] = {k: inc.get(k, "") for k in ("versao", "data", "fonte")}

    n = _ler("nbs")
    tamanhos["nbs"] = _gravar("nbs", [i["codigo"] for i in n["itens"]])
    versoes["nbs"] = {k: n.get(k, "") for k in ("versao", "data", "fonte")}

    o = _ler("indop")
    tamanhos["indop"] = _gravar("indop", [i["codigo"] for i in o["itens"]])
    versoes["indop"] = {k: o.get(k, "") for k in ("versao", "data", "fonte")}

    regras = {}
    for nome in ("regras", "regras_eventos"):
        r = _ler(nome)
        versoes[nome] = {k: r.get(k, "") for k in ("versao", "data", "fonte")}
        for i in r["itens"]:
            c = str(i.get("codigo") or "").strip().upper()
            if c and c not in regras:  # tabelas.regra: a da DPS vence a do evento
                regras[c] = [i.get("mensagem") or "", i.get("campo") or ""]
    tamanhos["regras"] = _gravar("regras", regras)

    d = _ler("dominios")
    dom = {x["nome"]: x["valores"] for x in d["itens"] if x["nome"] in DOMINIOS}
    tamanhos["dominios"] = _gravar("dominios", dom)
    versoes["dominios"] = {k: d.get(k, "") for k in ("versao", "data", "fonte")}

    tamanhos["versoes"] = _gravar("versoes", versoes)
    total = sum(tamanhos.values())
    for k, v in tamanhos.items():
        print(f"{k:12} {v / 1024:8.1f} KiB")
    print(f"{'total':12} {total / 1024:8.1f} KiB")


if __name__ == "__main__":
    main()
