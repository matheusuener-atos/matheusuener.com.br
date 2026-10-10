// O cliente da Atos Cobranca: um Durable Object por Conta Atos (o id vem do `sub`). Guarda os dados
// fiscais (uma vez, para todos os produtos), as assinaturas e as compras. E o registro do dinheiro:
// um objeto atende um pedido de cada vez, entao duas abas pagando ao mesmo tempo nao se atropelam -
// o KV, eventualmente consistente, nao serve para isso.
//
// Chaves no storage do objeto:
//   perfil              {tipo: "pf"|"pj", documento, nome, email, endereco{...}, atualizado}
//   assinatura:<ref>    uma assinatura (a mensalidade no cartao) - ref e o external_reference
//   compra:<ref>        uma compra (o ano, o mes no Pix, a recarga)
//   visto:<tipo>:<id>   um aviso do Mercado Pago ja aplicado (o mesmo aviso chega mais de uma vez)
//
// Pedidos: POST com {op, ...}; a resposta e JSON. Quem chama e so o Worker (api.js e o aviso).

const PREFIXOS = { assinatura: "assinatura:", compra: "compra:" };

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

/* O objeto do cliente, para pedir: await cliente(env, id).pedir("perfil_ler"). */
export function cliente(env, clienteId) {
  const stub = env.CLIENTES.get(env.CLIENTES.idFromName(clienteId));
  return {
    async pedir(op, dados = {}) {
      const r = await stub.fetch("https://cliente/", { method: "POST", body: JSON.stringify({ op, ...dados }) });
      return r.json();
    },
  };
}

export class ClienteCobranca {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
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
      return Response.json({ ok: false, erro: String(e && e.message || e) }, { status: 500 });
    }
  }

  async fazer(d) {
    const s = this.ctx.storage;
    const agora = new Date().toISOString();
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
        await s.put(chave, r);
        return { ok: true, registro: r, antes };
      }
      case "ler": {
        const r = PREFIXOS[d.tipo] ? await s.get(PREFIXOS[d.tipo] + d.ref) : null;
        return r ? { ok: true, registro: r } : { ok: false, erro: "não existe" };
      }
      case "achar_mp": {
        // A assinatura (ou compra) com este id do Mercado Pago.
        const lista = await s.list({ prefix: PREFIXOS[d.tipo] });
        for (const r of lista.values()) if (r.mp_id === d.mp_id) return { ok: true, registro: r };
        return { ok: false, erro: "não existe" };
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
        const antes = (await s.get(chave)) || { produto: d.produto, ate: null, plano: null, creditos: [], aplicados: [] };
        // O mesmo pagamento (o aviso e a consulta da tela podem chegar os dois) estende uma vez so.
        if (!d.origem) return { ok: false, erro: "falta a origem do pagamento" };
        if ((antes.aplicados || []).includes(d.origem)) return { ok: true, direito: antes, repetido: true };
        antes.aplicados = [...(antes.aplicados || []), d.origem].slice(-200);
        const base = antes.ate && Date.parse(antes.ate) > Date.now() ? new Date(antes.ate) : new Date();
        const r = { ...antes, plano: d.plano || antes.plano, atualizado: agora };
        if (d.meses) {
          base.setUTCMonth(base.getUTCMonth() + d.meses);
          r.ate = base.toISOString();
        }
        if (d.credito) r.creditos = [...(antes.creditos || []), { ...d.credito, quando: agora }].slice(-50);
        await s.put(chave, r);
        return { ok: true, direito: r };
      }
      case "direitos":
        return { ok: true, direitos: [...(await s.list({ prefix: "direito:" })).values()] };
      case "aviso_visto": {
        // Marca e responde se ja tinha sido visto - de uma vez, dentro do objeto (sem corrida).
        const chave = "visto:" + d.chave;
        if (await s.get(chave)) return { ok: true, visto: true };
        await s.put(chave, agora);
        return { ok: true, visto: false };
      }
      default:
        return { ok: false, erro: "op desconhecida" };
    }
  }
}
