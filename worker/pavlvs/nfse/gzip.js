// O embrulho do Sistema Nacional: XML -> gzip -> base64 (e o inverso), como
// paulus/legal/src/nfse/cliente.py (gzip_b64 / de_gzip_b64), com o
// CompressionStream do Worker.
//
// Os BYTES do gzip não são os do Python (o Python grava a hora no cabeçalho e
// comprime no nível 9; o CompressionStream não grava hora e usa o nível
// padrão): o que tem de bater é o conteúdo depois de descomprimir, e o teste
// confere nos dois sentidos.

import { b64 } from "./assinatura.js";

async function passar(bytes, transformacao) {
  const fluxo = new Blob([bytes]).stream().pipeThrough(transformacao);
  return new Uint8Array(await new Response(fluxo).arrayBuffer());
}

export async function gzipB64(xml) {
  const bytes = typeof xml === "string" ? new TextEncoder().encode(xml) : xml;
  return b64(await passar(bytes, new CompressionStream("gzip")));
}

export async function deGzipB64(texto) {
  const bin = atob(texto);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return passar(u, new DecompressionStream("gzip"));
}
