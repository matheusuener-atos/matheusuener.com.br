"""
Conferência visual do DANFSe do Worker (worker/nfse/danfse.js) contra o do
PAULUS em Python (paulus/legal/src/nfse/danfse.py).

Para algumas NFS-e de danfse.json (refazer com gerar_danfse.py), gera os dois
PDFs, desenha as páginas em PNG (pypdfium2) e grava, em fixtures/danfse/,
uma imagem por nota com três colunas: Python | JS | diferença (preto onde os
pixels diferem). Imprime a fração de pixels diferentes de cada uma.

    C:/coryphaeus/paulus/legal/venv/Scripts/python.exe worker/nfse/fixtures/comparar_danfse.py
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

import pypdfium2 as pdfium
from PIL import Image, ImageChops, ImageDraw

AQUI = Path(__file__).resolve().parent
RAIZ = AQUI.parents[2]
sys.path.insert(0, str(RAIZ / "paulus" / "legal" / "src"))

from nfse import danfse  # noqa: E402

SAIDA = AQUI / "danfse"
# índice em danfse.json -> nome do arquivo
CASOS = {
    3: "retencoes-ibscbs-homologacao",
    21: "producao-textos-compridos",
    19: "sem-tomador",
}
ESCALA_MEDIDA = 2.0  # 144 dpi para medir
ESCALA_IMAGEM = 1.3  # ~94 dpi para guardar

JS = """
import { gerarDanfse } from "%s";
import { readFileSync, writeFileSync } from "node:fs";
const pedidos = JSON.parse(readFileSync(process.argv[2], "utf8"));
for (const [xml, destino] of pedidos) writeFileSync(destino, await gerarDanfse(xml));
"""


def pagina(pdf: Path, escala: float) -> Image.Image:
    doc = pdfium.PdfDocument(str(pdf))
    assert len(doc) == 1, f"{pdf.name}: {len(doc)} páginas"
    img = doc[0].render(scale=escala).to_pil().convert("L")
    doc.close()
    return img


def main() -> int:
    dados = json.loads((AQUI / "danfse.json").read_text(encoding="utf-8"))
    SAIDA.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        pedidos = []
        for i, nome in CASOS.items():
            xml = dados["casos"][i]["xml"]
            (tmp / f"{nome}-py.pdf").write_bytes(danfse.gerar(xml.encode("utf-8")))
            pedidos.append([xml, str(tmp / f"{nome}-js.pdf")])
        (tmp / "pedidos.json").write_text(json.dumps(pedidos), encoding="utf-8")
        modulo = (RAIZ / "worker" / "nfse" / "danfse.js").as_uri()
        (tmp / "gerar.mjs").write_text(JS % modulo, encoding="utf-8")
        r = subprocess.run(["node", str(tmp / "gerar.mjs"), str(tmp / "pedidos.json")], capture_output=True, text=True)
        if r.returncode:
            print(r.stderr)
            return 1
        pior = 0.0
        for i, nome in CASOS.items():
            py, js = tmp / f"{nome}-py.pdf", tmp / f"{nome}-js.pdf"
            a, b = pagina(py, ESCALA_MEDIDA), pagina(js, ESCALA_MEDIDA)
            if a.size != b.size:
                print(f"{nome}: tamanhos diferentes {a.size} x {b.size}")
                return 1
            dif = ImageChops.difference(a, b).point(lambda v: 255 if v > 64 else 0)
            fracao = dif.histogram()[255] / (a.size[0] * a.size[1])
            pior = max(pior, fracao)
            a, b = pagina(py, ESCALA_IMAGEM), pagina(js, ESCALA_IMAGEM)
            d = ImageChops.invert(ImageChops.difference(a, b).point(lambda v: 255 if v > 64 else 0))
            w, h = a.size
            topo = 22
            junto = Image.new("L", (w * 3 + 20, h + topo), 255)
            for k, (img, titulo) in enumerate(((a, "Python (reportlab)"), (b, "Worker (danfse.js, pdf-lib)"),
                                                (d, f"diferença: {fracao * 100:.3f}% dos pixels"))):
                junto.paste(img, (k * (w + 10), topo))
                ImageDraw.Draw(junto).text((k * (w + 10) + 4, 4), titulo, fill=0)
            junto.save(SAIDA / f"{nome}.png", optimize=True)
            print(f"{nome}: {fracao * 100:.3f}% dos pixels diferentes -> danfse/{nome}.png")
    print(f"pior: {pior * 100:.3f}%")
    return 0


if __name__ == "__main__":
    sys.exit(main())
