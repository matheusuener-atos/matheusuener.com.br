// O catalogo da Atos Cobranca (docs/COBRANCA.md, "Catalogo"): o que cada produto vende, com o
// preco em centavos. E a unica fonte de valor e de recorrencia - o navegador manda so o id do preco,
// e o servidor resolve aqui (resolveOffer). Os `metadados` sao do produto (o PAVLVS le o plano, os
// tokens do ciclo e as pessoas); a Atos so os entrega nos eventos e nos direitos.
//
// Formas de cobrar, por periodo:
//   mes    a mensalidade: no cartao, assinatura recorrente (/preapproval); no Pix, um mes avulso (Orders API)
//   ano    o ano pago de uma vez: cartao ou Pix (Orders API)
//   avulso uma compra so (a recarga do PAVLVS): Pix (Orders API); exige assinatura ativa do produto
//
// Mudar um valor e criar uma versao nova do preco (o id muda, ex.: "...@2"): quem ja assinou continua no
// valor dele. `aberto` diz se o produto ja vende pela Atos - so depois que ele recebe os eventos.

export const MOEDA = "BRL";

const PAVLVS_PLANOS = [
  { plano: "advogado", nome: "Advogado", mes: 44900, ano: 399000, tokens: 30000000, pessoas: 1, recarga: { centavos: 5000, tokens: 10000000 } },
  { plano: "escritorio", nome: "Escritório", mes: 129000, ano: 1149000, tokens: 60000000, pessoas: 5, recarga: { centavos: 12000, tokens: 10000000 } },
  { plano: "plus", nome: "Escritório Plus", mes: 349000, ano: 3099000, tokens: 40000000, pessoas: 15, recarga: { centavos: 30000, tokens: 5000000 } },
];

function precosDoPavlvs() {
  const l = [];
  for (const p of PAVLVS_PLANOS) {
    const meta = { plano: p.plano, tokens_por_ciclo: p.tokens, pessoas: p.pessoas };
    l.push({ id: `pavlvs.${p.plano}.mes`, nome: `PAVLVS ${p.nome}`, periodo: "mes", centavos: p.mes, formas: ["cartao", "pix"], metadados: meta });
    l.push({ id: `pavlvs.${p.plano}.ano`, nome: `PAVLVS ${p.nome} · anual`, periodo: "ano", centavos: p.ano, formas: ["cartao", "pix"], metadados: meta });
    l.push({ id: `pavlvs.${p.plano}.recarga`, nome: `PAVLVS ${p.nome} · recarga`, periodo: "avulso", centavos: p.recarga.centavos, formas: ["pix"],
      requer_assinatura: true, metadados: { plano: p.plano, tokens: p.recarga.tokens } });
  }
  return l;
}

export const PRODUTOS = {
  pavlvs: {
    nome: "PAVLVS",
    site: "https://paulus.ia.br",
    // Para onde a pessoa volta depois de pagar (so estes; o ?volta= que nao bater vira o site).
    voltas: ["https://paulus.ia.br/", "https://paulus.ia.br/minha-conta/"],
    // Onde o produto recebe os eventos (worker/cobranca/eventos.js); o segredo e EVENTOS_SEGREDO_PAVLVS.
    eventos: "https://paulus.ia.br/api/atos/eventos",
    precos: precosDoPavlvs(),
  },
};

/* O produto vende pela Atos? Liga por var (PRODUTOS_ABERTOS="pavlvs,..."), quando ele ja recebe os eventos. */
export function produtoAberto(env, produto) {
  return String(env.PRODUTOS_ABERTOS || "").split(",").map((s) => s.trim()).includes(produto);
}

export function catalogoPublico(produto) {
  const p = PRODUTOS[produto];
  if (!p) return null;
  return { produto, nome: p.nome, moeda: MOEDA, precos: p.precos };
}

/* A oferta confiavel de um preco (resolveOffer): o que o servidor cobra, nunca o que o navegador disse. */
export function resolveOffer(precoId) {
  const [produto] = String(precoId || "").split(".");
  const p = PRODUTOS[produto];
  const preco = p && p.precos.find((x) => x.id === precoId);
  if (!preco) return null;
  return { produto, produtoNome: p.nome, ...preco, valor: (preco.centavos / 100).toFixed(2) };
}

export function voltaPermitida(produto, volta) {
  const p = PRODUTOS[produto];
  if (!p) return "";
  return p.voltas.includes(volta) ? volta : p.site;
}
