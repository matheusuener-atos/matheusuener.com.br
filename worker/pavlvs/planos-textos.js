// Os textos dos planos na pagina de assinatura (paulus.ia.br/assinatura): a
// frase de cada plano, o "antes dos itens" (a heranca) e os itens, com o que
// abre em cada um. O padrao e montado aqui com os numeros do plano (creditos,
// pessoas, modelos, recursos), o mesmo que a pagina mostrava sozinha ate
// 07/10/2026. O painel admin (Planos > Edicao e .JSON) troca qualquer um deles
// por um texto proprio, guardado junto do plano no IA_PLANOS do painel
// ("admin:planos"); texto proprio igual ao padrao nao e guardado, para os
// itens continuarem acompanhando os numeros. A pagina le pronto em
// GET /api/planos/textos (worker/admin.js); "(em breve)" no texto do item
// marca o que ainda nao existe.

import { catalogo, modelosDoPlano } from "./ia.js";

const NIVEL = { estagiario: "Estagiário", bacharel: "Bacharel", advogado: "Advogado", juiz: "Juiz", ministro: "Ministro" };
export const PARA_PADRAO = { advogado: "Para quem advoga sozinho.", escritorio: "Para escritórios com equipe.", plus: "Para escritórios que querem a melhor IA do mercado." };
export const HERANCA_PADRAO = { escritorio: "Tudo do plano Advogado, e mais", plus: "Tudo do plano Escritório, e mais" };
// Os limites do que o painel guarda.
export const LIMITES_DOS_TEXTOS = { para: 160, heranca: 120, itens: 20, titulo: 80, descricao: 600 };

function milhoes(t) {
  return (t / 1e6).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + " milhões de créditos";
}

/* Os itens padrao de um plano (o completo, de numeros(env).planos): [{titulo, descricao}]. */
export function itensPadrao(p) {
  const r = p.recursos || {};
  const modelos = catalogo(modelosDoPlano(p));
  const empresas = modelos.map((m) => m.empresa).filter((e, i, l) => l.indexOf(e) === i);
  const ia = ["IA " + modelos.map((m) => m.nome).join(" e ") + (empresas.length ? ", da " + empresas.join(" e da ") : ""),
    "Com " + milhoes(p.tokens) + " por mês, liberados por semana." + (r.profundidade ? " Profundidade até " + (NIVEL[r.profundidade] || r.profundidade) + "." : "") +
    // worker/ia.js, primeiraSemanaAte: nos 7 primeiros dias, so o modelo principal.
    (modelos.length > 1 ? " Nos 7 primeiros dias da assinatura, responde só o " + modelos[0].nome + "; o " + modelos.slice(1).map((m) => m.nome).join(" e o ") + " libera no 8º dia." : "")];
  const pessoas = p.pessoas > 1 ? ["Até " + p.pessoas + " pessoas", "Cada uma com login Google, código no celular, permissões próprias, e-mail e agenda próprios." +
    (r.consumo_por_pessoa ? " Consumo de IA por pessoa, com limite definido por você." : "")] : null;
  const nfse = r.nfse_mes === null ? ["NFS-e sem limite", "Nota fiscal de serviço nacional" + (r.nfse_recorrente ? ", com notas recorrentes." : ".")]
    : r.nfse_mes > 0 ? ["Nota fiscal de serviço", "NFS-e nacional: até " + r.nfse_mes + " por mês." + (r.horas ? " Horas por serviço que viram cobrança no financeiro." : "")] : null;
  const agentes = r.agentes ? ["Até " + r.agentes + " agentes personalizados", "Agentes com as suas instruções, para tarefas que se repetem."]
    : r.agentes === null && r.autonomia ? ["Agentes sem limite", "Inclusive o que faz sozinho tarefas de vários passos."] : null;
  const porPlano = {
    advogado: [ia,
      ["Converse com os seus documentos", "Toda resposta mostra o trecho de onde saiu. Prazos, valores e partes lidos sozinhos dos documentos, inclusive de PDF escaneado. Foto de documento pelo celular, que vira PDF pesquisável."],
      ["Processos, prazos e intimações", "Pastas de processo com etapas, e os prazos entram na Agenda. Intimações do DJEN pela sua OAB, todo dia, com o prazo contado em dias úteis."],
      ["Agenda, e-mail e reuniões", "Agenda, tarefas, Google Agenda e Google Meet. E-mail: acompanha a caixa, acha prazos e traduz mensagens."],
      ["Clientes e financeiro", "Cadastro de clientes e financeiro, com relatórios em PDF e Excel."],
      ["Editores e assinatura digital", "Editor de peças, planilha com fórmulas em português e editor de PDF. Assinatura digital com certificado A1."],
      ["Biblioteca jurídica", "Constituição, 11 códigos, súmulas e temas do STJ, e a sua posição sobre cada artigo."],
      agentes,
      ["Acesso pelo celular", "De qualquer lugar, no seu endereço nome.paulus.ia.br."],
      ["Nada sai sem a sua aprovação", "Nada sai do programa sem a sua aprovação. Backup, WhatsApp, foco e bem-estar."]],
    escritorio: [ia, pessoas, nfse,
      r.datajud ? ["Processos no DataJud", "Processos acompanhados no DataJud todo dia. A IA explicando cada movimentação do processo (em breve)."] : null,
      r.gravacao ? ["Gravação de reuniões", "Com transcrição no seu computador e resumo."] : null,
      r.muralha ? ["Alerta de conflito de interesses", "Alerta de conflito de interesses entre clientes."] : null,
      agentes,
      r.jurisprudencia_stj ? ["Jurisprudência completa do STJ", "No seu computador."] : null],
    plus: [ia, pessoas,
      r.word ? ["Assistente dentro do Word", "Nos documentos criados pelo PAVLVS."] : null,
      nfse,
      r.ao_vivo ? ["Reuniões e cliente", "Sugestões jurídicas ao vivo durante a reunião. Página para o seu cliente acompanhar o processo (em breve)."] : null,
      r.mcp ? ["Conexão com outras IAs pelo MCP", "Conecte o PAVLVS a outras IAs e ferramentas pelo protocolo MCP."] : null,
      ["Implantação assistida", "Implantação assistida e suporte prioritário."]],
  };
  return (porPlano[p.id] || [ia, pessoas, nfse, agentes]).filter(Boolean).map(([titulo, descricao]) => ({ titulo, descricao }));
}

/* Os textos padrao de um plano completo: {para, heranca, itens}. */
export function textosPadrao(p) {
  return { para: PARA_PADRAO[p.id] || "", heranca: HERANCA_PADRAO[p.id] || "", itens: itensPadrao(p) };
}

/* Os textos que valem para um plano: os proprios que o painel guardou no plano
   (`guardado`: o objeto do plano em admin:planos) ou os padrao, e de onde veio cada um. */
export function textosDoPlano(p, guardado = {}) {
  const padrao = textosPadrao(p);
  const g = guardado || {};
  const itens = Array.isArray(g.itens) && g.itens.length ? g.itens.map((x) => ({ titulo: String(x.titulo || ""), descricao: String(x.descricao || "") })) : null;
  return {
    para: g.para ? String(g.para) : padrao.para,
    heranca: g.heranca ? String(g.heranca) : padrao.heranca,
    itens: itens || padrao.itens,
    proprios: { para: Boolean(g.para), heranca: Boolean(g.heranca), itens: Boolean(itens) },
  };
}

const igualItens = (a, b) => JSON.stringify((a || []).map((x) => [x.titulo, x.descricao || ""])) === JSON.stringify((b || []).map((x) => [x.titulo, x.descricao || ""]));

/* Limpa e confere os textos pedidos: {para?, heranca?, itens?} -> {textos} ou {erro}. */
export function conferirTextos(d) {
  const limpo = (t, max) => String(t == null ? "" : t).replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max + 1);
  const t = {};
  if (d.para !== undefined) {
    t.para = limpo(d.para, LIMITES_DOS_TEXTOS.para);
    if (t.para.length > LIMITES_DOS_TEXTOS.para) return { erro: "a frase do plano passa de " + LIMITES_DOS_TEXTOS.para + " caracteres" };
  }
  if (d.heranca !== undefined) {
    t.heranca = limpo(d.heranca, LIMITES_DOS_TEXTOS.heranca);
    if (t.heranca.length > LIMITES_DOS_TEXTOS.heranca) return { erro: "o texto antes dos itens passa de " + LIMITES_DOS_TEXTOS.heranca + " caracteres" };
  }
  if (d.itens !== undefined && d.itens !== null) {
    if (!Array.isArray(d.itens)) return { erro: "os itens são uma lista de {titulo, descricao}" };
    if (d.itens.length > LIMITES_DOS_TEXTOS.itens) return { erro: "no máximo " + LIMITES_DOS_TEXTOS.itens + " itens por plano" };
    t.itens = [];
    for (const [i, x] of d.itens.entries()) {
      const titulo = limpo(x && x.titulo, LIMITES_DOS_TEXTOS.titulo);
      const descricao = limpo(x && x.descricao, LIMITES_DOS_TEXTOS.descricao);
      if (!titulo) return { erro: "o item " + (i + 1) + " está sem título" };
      if (titulo.length > LIMITES_DOS_TEXTOS.titulo) return { erro: "o título do item " + (i + 1) + " passa de " + LIMITES_DOS_TEXTOS.titulo + " caracteres" };
      if (descricao.length > LIMITES_DOS_TEXTOS.descricao) return { erro: "a descrição do item " + (i + 1) + " passa de " + LIMITES_DOS_TEXTOS.descricao + " caracteres" };
      t.itens.push({ titulo, descricao });
    }
  } else if (d.itens === null) t.itens = [];
  return { textos: t };
}

/* Poe no plano guardado (`alvo`, o objeto de admin:planos) os textos pedidos.
   Vazio, ou igual ao padrao (o de antes da mudanca ou o de depois, com os
   numeros novos), volta ao padrao: o texto sai do plano guardado. */
export function guardarTextos(alvo, textos, padroes) {
  const ehPadrao = (k, v) => padroes.some((p) => (k === "itens" ? igualItens(v, p.itens) : v === p[k]));
  for (const k of ["para", "heranca", "itens"]) {
    if (!(k in textos)) continue;
    const v = textos[k];
    const vazio = k === "itens" ? !v.length : !v;
    if (vazio || ehPadrao(k, v)) delete alvo[k];
    else alvo[k] = v;
  }
  return alvo;
}
