// O cliente da Atos Cobranca: um Durable Object por Conta Atos (o id vem do `sub`). Guarda os dados
// fiscais (uma vez, para todos os produtos), as assinaturas, as compras e o direito a cada produto. E o
// registro do dinheiro: um objeto atende um pedido de cada vez, entao duas abas pagando ao mesmo tempo
// nao se atropelam - o KV, eventualmente consistente, nao serve para isso.
//
// Chaves no storage do objeto:
//   dono                {sub, email} da Conta Atos (os eventos dizem de quem e)
//   perfil              {tipo: "pf"|"pj", documento, nome, email, endereco{...}, atualizado}
//   assinatura:<ref>    uma assinatura (a mensalidade no cartao) - ref e o external_reference
//   compra:<ref>        uma compra (o ano, o mes no Pix, a recarga)
//   direito:<produto>   ate quando o produto esta pago, o plano, o periodo que pagou, os creditos e a `versao`
//   evento:<seq>        a fila de saida para o produto (eventos.js), entregue pelo alarme deste objeto
//
// Pedidos: POST com {op, ...}; a resposta e JSON. Quem chama e so o Worker (api.js e o aviso).

import { entregar, REENTREGAS_S } from "./eventos.js";

const PREFIXOS = { assinatura: "assinatura:", compra: "compra:" };
const VIVAS = ["authorized", "pending", "paused"];

/* Um mes depois, no mesmo dia, ou no ultimo do mes se ele nao tiver o dia (31/01 -> 28/02), e um mes de
   cada vez (o ano sao doze): a mesma conta do produto (o PAVLVS abre os ciclos assim), para o "pago ate"
   da Atos e o fim do ciclo do produto cairem no mesmo dia. */
export function maisUmMes(ms) {
  const d = new Date(ms);
  const dia = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + 1);
  if (d.getUTCDate() < dia) d.setUTCDate(0);
  return d.getTime();
}

export async function idDoCliente(sub) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("cliente:" + sub));
  return [...new Uint8Array(h)].slice(0, 16).map((x) => x.toString(16).padStart(2, "0")).join("");
}

/* O external_reference de uma cobranca: diz de que cliente ela e sem consultar nada. */
export function novaRef(clienteId, tipo) {
  const r = [...crypto.getRandomValues(new Uint8Array(8))].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `atos-${clienteId}-${tipo}-${r}`;
}

export function clienteDaRef(ref) {
  const m = /^atos-([0-9a-f]{32})-(assinatura|compra)-[0-9a-f]{16}$/.exec(String(ref || ""));
  return m ? { clienteId: m[1], tipo: m[2] } : null;
}

/* O objeto do cliente, para pedir: await cliente(env, id).pedir("perfil_ler"). `dono` ({sub, email}, da
   sessao) vai em todo pedido e fica anotado no primeiro: e de quem os eventos dizem que e. */
export function cliente(env, clienteId, dono) {
  const stub = env.CLIENTES.get(env.CLIENTES.idFromName(clienteId));
  return {
    async pedir(op, dados = {}) {
      const r = await stub.fetch("https://cliente/", { method: "POST", body: JSON.stringify({ op, ...dados, ...(dono ? { dono } : {}) }) });
      return r.json();
    },
  };
}

export class ClienteCobranca {
  constructor(ctx, env, deps = {}) {
    this.ctx = ctx;
    this.env = env;
    this.deps = deps;
  }

  async fetch(request) {
    let d;
    try {
      d = await request.json();
    } catch {
      return Response.json({ ok: false, erro: "pedido inválido" }, { status: 400 });
    }
    try {
      return Response.json(await this.fazer(d));
    } catch (e) {
      return Response.json({ ok: false, erro: String((e && e.message) || e) }, { status: 500 });
    }
  }

  async fazer(d) {
    const s = this.ctx.storage;
    const agora = new Date().toISOString();
    // Quem e o dono (o sub e o e-mail da Conta Atos): anotado no primeiro pedido que o traz.
    if (d.dono && d.dono.sub && !(await s.get("dono"))) await s.put("dono", { sub: d.dono.sub, email: d.dono.email || "" });
    switch (d.op) {
      case "perfil_ler":
        return { ok: true, perfil: (await s.get("perfil")) || null };
      case "perfil_salvar": {
        const perfil = { ...d.perfil, atualizado: agora };
        await s.put("perfil", perfil);
        return { ok: true, perfil };
      }
      case "registrar": {
        // Uma cobranca nova, antes de ir ao Mercado Pago: se a chamada cair no meio, o registro existe
        // e o aviso que chegar depois encontra onde aplicar.
        const chave = PREFIXOS[d.tipo] + d.registro.ref;
        if (!PREFIXOS[d.tipo] || (await s.get(chave))) return { ok: false, erro: "registro inválido ou repetido" };
        const r = { ...d.registro, criada: agora, atualizada: agora };
        await s.put(chave, r);
        return { ok: true, registro: r };
      }
      case "atualizar": {
        const chave = PREFIXOS[d.tipo] + d.ref;
        const antes = PREFIXOS[d.tipo] ? await s.get(chave) : null;
        if (!antes) return { ok: false, erro: "não existe" };
        const r = { ...antes, ...d.campos, atualizada: agora };
        // A assinatura mudou o que o produto ve (autorizou, pausou, cancelou, a proxima cobranca): ele fica
        // sabendo. A tentativa recusada nao muda o retrato, e nao vira evento.
        const retratoAntes = d.tipo === "assinatura" ? JSON.stringify(await this.retrato(antes.produto)) : "";
        await s.put(chave, r);
        if (d.tipo === "assinatura" && JSON.stringify(await this.retrato(r.produto)) !== retratoAntes) await this.publicarDireito(r.produto);
        return { ok: true, registro: r, antes };
      }
      case "ler": {
        const r = PREFIXOS[d.tipo] ? await s.get(PREFIXOS[d.tipo] + d.ref) : null;
        return r ? { ok: true, registro: r } : { ok: false, erro: "não existe" };
      }
      case "listar": {
        const out = {};
        for (const [tipo, prefixo] of Object.entries(PREFIXOS)) out[tipo] = [...(await s.list({ prefix: prefixo })).values()];
        return { ok: true, ...out };
      }
      case "estender": {
        // Um pagamento aprovado estende o direito ao produto: a partir do fim do que ja estava pago (ou de
        // agora, se ja venceu), `meses` a mais. A recarga nao estende: soma creditos ao direito.
        const chave = "direito:" + d.produto;
        const antes = (await s.get(chave)) || { produto: d.produto, ate: null, plano: null, creditos: [], aplicados: [], versao: 0 };
        // O mesmo pagamento (o aviso e a consulta da tela podem chegar os dois) estende uma vez so.
        if (!d.origem) return { ok: false, erro: "falta a origem do pagamento" };
        if ((antes.aplicados || []).includes(d.origem)) return { ok: true, direito: antes, repetido: true };
        const r = { ...antes, aplicados: [...(antes.aplicados || []), d.origem].slice(-200), plano: d.plano || antes.plano,
          metadados: d.metadados || antes.metadados || null, atualizado: agora };
        if (d.meses) {
          let ate = antes.ate && Date.parse(antes.ate) > Date.now() ? Date.parse(antes.ate) : Date.now();
          for (let i = 0; i < d.meses; i++) ate = maisUmMes(ate);
          r.ate = new Date(ate).toISOString();
          // O que pagou o direito de agora: o ano, ou um mes (a assinatura no cartao ou o mes no Pix).
          r.periodo = d.meses === 12 ? "ano" : "mes";
          // Quem pagou: a cobranca da assinatura (ap:) ou uma compra a parte (order:, o ano ou o mes no Pix).
          r.pago_por = String(d.origem).startsWith("ap:") ? "assinatura" : "compra";
        }
        if (d.credito) r.creditos = [...(antes.creditos || []), { ...d.credito, origem: d.origem, quando: agora }].slice(-50);
        await s.put(chave, r);
        if (d.credito) await this.enfileirar("credito.adicionado", d.produto, { origem: d.origem, ...d.credito });
        if (d.meses) await this.publicarDireito(d.produto);
        return { ok: true, direito: await s.get(chave) };
      }
      case "direitos":
        return { ok: true, direitos: [...(await s.list({ prefix: "direito:" })).values()] };
      case "retrato":
        return { ok: true, retrato: await this.retrato(d.produto) };
      case "eventos":
        return { ok: true, eventos: [...(await s.list({ prefix: "evento:" })).values()] };
      default:
        return { ok: false, erro: "op desconhecida" };
    }
  }

  /* O que o produto precisa saber do direito, agora: o plano, ate quando, a assinatura viva e a versao. */
  async retrato(produto) {
    const s = this.ctx.storage;
    const dir = (await s.get("direito:" + produto)) || {};
    const vivas = [...(await s.list({ prefix: PREFIXOS.assinatura })).values()]
      .filter((a) => a.produto === produto && a.status !== "criando" && a.status !== "recusada")
      .sort((a, b) => String(b.criada).localeCompare(String(a.criada)));
    const a = vivas.find((x) => VIVAS.includes(x.status)) || vivas[0] || null;
    return {
      versao: dir.versao || 0, plano: dir.plano || (a && a.plano) || null, metadados: dir.metadados || null, ate: dir.ate || null,
      periodo: dir.periodo || null, pago_por: dir.pago_por || null,
      assinatura: a ? { id: a.ref, status: a.status, proxima: a.proxima || null, preco: a.preco } : null,
    };
  }

  /* Uma versao nova do direito vai para a fila do produto. */
  async publicarDireito(produto) {
    const s = this.ctx.storage;
    const chave = "direito:" + produto;
    const dir = (await s.get(chave)) || { produto, ate: null, plano: null, creditos: [], aplicados: [], versao: 0 };
    dir.versao = (dir.versao || 0) + 1;
    await s.put(chave, dir);
    await this.enfileirar("direito.atualizado", produto, await this.retrato(produto));
  }

  async enfileirar(tipo, produto, dados) {
    const s = this.ctx.storage;
    const dono = (await s.get("dono")) || {};
    const seq = ((await s.get("evento_seq")) || 0) + 1;
    await s.put("evento_seq", seq);
    const evento = { id: crypto.randomUUID(), tipo, produto, criado: new Date().toISOString(), conta: { sub: dono.sub || "", email: dono.email || "" }, dados };
    await s.put("evento:" + String(seq).padStart(10, "0"), { evento, estado: "pendente", tentativas: 0, proxima: Date.now() });
    // A entrega e do alarme: a resposta ao pagamento nao espera o produto.
    await s.setAlarm(Date.now());
  }

  /* O alarme entrega a fila em ordem; o que o produto recusar volta em REENTREGAS_S, e esgotado vira "falhou". */
  async alarm() {
    const s = this.ctx.storage;
    const agora = Date.now();
    let proxima = null;
    for (const [chave, item] of await s.list({ prefix: "evento:" })) {
      if (item.estado !== "pendente") continue;
      if (item.proxima > agora) { proxima = Math.min(proxima ?? Infinity, item.proxima); continue; }
      const r = await entregar(this.env, item.evento, { buscar: this.deps.fetch });
      if (r.ok) {
        await s.put(chave, { ...item, estado: "entregue", tentativas: item.tentativas + 1, entregue: new Date().toISOString() });
        continue;
      }
      const tentativas = item.tentativas + 1;
      const espera = REENTREGAS_S[tentativas - 1];
      const novo = { ...item, tentativas, ultimo: { status: r.status, motivo: r.motivo || "", quando: new Date().toISOString() } };
      if (espera === undefined) novo.estado = "falhou";
      else { novo.proxima = agora + espera * 1000; proxima = Math.min(proxima ?? Infinity, novo.proxima); }
      await s.put(chave, novo);
    }
    if (proxima !== null) await s.setAlarm(proxima);
  }
}
