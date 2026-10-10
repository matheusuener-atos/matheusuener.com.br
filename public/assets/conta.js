/* A Minha conta (/conta/ e /conta/<secao>): Resumo e Dados da conta Atos;
   Assinaturas, Faturamento e Carteira do que a pessoa assina com a Atos.

   A conta (nome, e-mail, aplicativos) vem da Atos (/api/eu, /api/apps). A
   cobranca tambem: a Atos e quem cobra (docs/COBRANCA.md), e a tela le
   GET /api/cobranca/v1/conta (o direito, a assinatura e as faturas de cada
   produto) e muda a assinatura por /api/subscriptions/<id>/(pause|reactivate|cancel).
   Os dados fiscais sao os da Atos (/api/cobranca/v1/cliente), os mesmos do checkout.
   Sem sessao, vai para /entrar. */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var SECOES = ["resumo", "dados", "assinaturas", "faturamento", "carteira"];
  var S = {
    conta: null, apps: null, appsErro: "", editando: false, nomeErro: "",
    atos: null, atosErro: "",
    confirmar: "", mudando: "", acaoErro: "",
    dadosMsg: "", dadosErro: "", salvando: false, rascunho: null, ibge: "",
    filtro: filtroDaUrl(),
  };
  function filtroDaUrl() {
    var q = new URLSearchParams(location.search);
    var st = q.get("status");
    return { status: st === "paga" || st === "pendente" ? st : "", ano: q.get("ano") || "", produto: q.get("produto") || "", q: q.get("q") || "" };
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; });
  }
  function api(caminho, corpo) {
    var op = corpo === undefined ? { credentials: "same-origin" } :
      { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(corpo) };
    return fetch(caminho, op).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) { d._status = r.status; return d; });
    }, function () { return { erro: "sem conexão com o servidor", _status: 0 }; });
  }
  function data(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d)) return "";
    return d.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
  }
  function reais(v) { return Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }); }
  function centavos(c) { return reais(Number(c || 0) / 100); }
  var LOGO = '<img class="logo" src="/assets/paulus-p.png" alt="" width="32" height="32">';
  var FORA = ' target="_blank" rel="noopener"';

  function secaoAtual() {
    var m = /^\/conta\/([a-z]+)/.exec(location.pathname);
    return m && SECOES.indexOf(m[1]) > 0 ? m[1] : "resumo";
  }
  var GUIAS = [["resumo", "Resumo", "/conta/"], ["dados", "Dados", "/conta/dados"], null, ["assinaturas", "Assinaturas", "/conta/assinaturas"],
    ["faturamento", "Faturamento", "/conta/faturamento"], ["carteira", "Carteira", "/conta/carteira"]];
  function guias() {
    var sec = secaoAtual();
    return '<nav class="guias" aria-label="Minha conta">' + GUIAS.map(function (g) {
      if (!g) return '<span class="sep" aria-hidden="true"></span>';
      return '<a href="' + g[2] + '" data-secao="' + g[0] + '"' + (g[0] === sec ? ' aria-current="page"' : "") + ">" + g[1] + "</a>";
    }).join("") + '<button type="button" class="fim" data-acao="sair">Sair</button></nav>';
  }
  function titulo(t, descricao) { return "<h1>" + t + "</h1>" + (descricao ? '<p class="descricao">' + descricao + "</p>" : "") + guias(); }
  function h2(t) { return '<h2 class="titulo-secao">' + t + "</h2>"; }
  function vazio(t) { return '<div class="card"><p class="vazio">' + t + "</p></div>"; }

  var SITUACAO = {
    ativa: ["Ativa", ""], cortesia: ["Cortesia", ""], pendente: ["Pendente", "neutro"], pausada: ["Pausada", "neutro"],
    cancelada: ["Cancelada", "perigo"], vencida: ["Vencida", "perigo"],
  };
  function selo(sit) { var x = SITUACAO[sit] || [sit || "—", "neutro"]; return '<span class="selo' + (x[1] ? " " + x[1] : "") + '">' + esc(x[0]) + "</span>"; }
  var BANDEIRAS = { visa: ["VISA", "Visa"], master: ["MC", "Mastercard"], mastercard: ["MC", "Mastercard"], amex: ["AMEX", "American Express"], elo: ["ELO", "Elo"], hipercard: ["HIPER", "Hipercard"], diners: ["DINERS", "Diners"] };
  function bandeira(b) { var k = String(b || "").toLowerCase(); return BANDEIRAS[k] || [k.slice(0, 5).toUpperCase() || "CARTÃO", k ? k.charAt(0).toUpperCase() + k.slice(1) : "Cartão"]; }

  // ------------------------------------------------------------ a cobranca da Atos

  /* Ainda carregando, ou nao deu. "" quando ja chegou. */
  function esperandoAtos() {
    if (S.atosErro) return '<div class="card"><p class="vazio">' + esc(S.atosErro) + ' <button type="button" class="link" data-acao="recarregar">Tentar de novo</button></p></div>';
    if (!S.atos) return vazio("Carregando…");
    return "";
  }
  function temAtos() { return Boolean(S.atos && (S.atos.produtos.length || S.atos.faturas.length)); }
  function assinarDe(produto, preco) { return "/" + produto + "/assinar/" + (preco ? "?preco=" + encodeURIComponent(preco) : ""); }

  /* A situacao de um produto na Atos: o selo, a linha de baixo e o que se pode fazer. */
  function situacaoDe(x) {
    var a = x.assinatura, dir = x.direito || {};
    var ate = dir.ate && Date.parse(dir.ate) > Date.now() ? dir.ate : null;
    var mes = a ? centavos(a.centavos) + "/mês" : "";
    if (a && a.status === "authorized") return { sit: "ativa", linha: (a.proxima ? "Próxima cobrança em " + data(a.proxima) + " · " : "") + mes, forma: "Cartão, todo mês", viva: a };
    if (a && a.status === "pending") return { sit: "pendente", linha: "Esperando o Mercado Pago confirmar o cartão", forma: "Cartão, todo mês", viva: a };
    if (a && a.status === "paused") return { sit: "pausada", linha: "Pausada: nada é cobrado" + (ate ? " · pago até " + data(ate) : ""), forma: "Cartão, todo mês", viva: a };
    if (ate && dir.pago_por === "assinatura") return { sit: "cancelada", linha: "Assinatura cancelada · vale até " + data(ate), forma: "Cartão (cancelado)" };
    if (ate) return { sit: "ativa", linha: "Pago até " + data(ate), forma: dir.periodo === "ano" ? "O ano pago de uma vez" : "Um mês pago no Pix", renovar: true };
    return { sit: a && a.status === "canceled" ? "cancelada" : "vencida", linha: dir.ate ? "Venceu em " + data(dir.ate) : "Encerrada", forma: "—", assinarDeNovo: true };
  }

  function itemDoResumo(x) {
    var s = situacaoDe(x);
    return '<a class="item" href="/conta/assinaturas" data-ir="assinaturas">' + LOGO +
      '<span class="nome"><strong>' + esc(x.nome) + (x.plano_nome ? " · " + esc(x.plano_nome) : "") + "</strong><small>" + esc(s.linha) + "</small></span>" +
      selo(s.sit) + '<span class="seta" aria-hidden="true">→</span></a>';
  }

  function cartaoDoProduto(x) {
    var s = situacaoDe(x);
    var a = x.assinatura;
    var id = s.viva ? s.viva.id : "";
    var ocupado = S.mudando && S.mudando === id;
    var h = '<div class="card">' +
      '<div class="assinatura-topo"><img class="logo" src="/assets/paulus-p.png" alt="" width="40" height="40"><span class="nome"><strong>' + esc(x.nome) + "</strong><small>" +
      esc(x.plano_nome ? "Plano " + x.plano_nome : "") + "</small></span>" + selo(s.sit) + "</div>" +
      '<div class="colunas">' +
      '<div><span class="rotulo">Situação</span><span>' + esc(s.linha) + "</span></div>" +
      '<div><span class="rotulo">Pagamento</span><span>' + esc(s.forma) + (s.viva && s.viva.bandeira ? " · " + esc(bandeira(s.viva.bandeira)[1]) : "") + "</span></div>" +
      (a ? '<div><span class="rotulo">Desde</span><span>' + (data(a.criada) || "—") + "</span></div>" : "") +
      "</div>";
    if (S.confirmar && S.confirmar === id) {
      var dir = x.direito || {};
      h += '<div class="confirmar" role="alertdialog" aria-label="Cancelar a assinatura">' +
        "<p>Cancelar a assinatura do " + esc(x.nome) + "? O Mercado Pago para de cobrar o cartão" +
        (dir.ate && Date.parse(dir.ate) > Date.now() ? ", e o que já foi pago vale até " + data(dir.ate) + "." : ".") + "</p>" +
        '<div class="botoes"><button type="button" class="btn p perigo" data-acao="cancelar-sim" data-id="' + esc(id) + '"' + (ocupado ? " disabled" : "") + ">" +
        (ocupado ? "Cancelando…" : "Cancelar a assinatura") + '</button><button type="button" class="btn p" data-acao="cancelar-nao">Voltar</button></div></div>';
    } else {
      h += '<div class="botoes">';
      if (s.viva && s.viva.status === "authorized") h += '<button type="button" class="btn p" data-acao="pausar" data-id="' + esc(id) + '"' + (ocupado ? " disabled" : "") + ">Pausar</button>";
      if (s.viva && s.viva.status === "paused") h += '<button type="button" class="btn p" data-acao="reativar" data-id="' + esc(id) + '"' + (ocupado ? " disabled" : "") + ">Reativar</button>";
      if (s.renovar && x.plano) {
        var periodo = (x.direito || {}).periodo === "ano" ? "ano" : "mes";
        h += '<a class="btn p" href="' + assinarDe(x.produto, x.produto + "." + x.plano + "." + periodo) + '">' + (periodo === "ano" ? "Pagar mais um ano" : "Pagar mais um mês") + "</a>";
      }
      if (s.assinarDeNovo) h += '<a class="btn p primario" href="' + assinarDe(x.produto, x.plano ? x.produto + "." + x.plano + ".mes" : "") + '">Assinar de novo</a>';
      if (s.viva) h += '<button type="button" class="btn p perigo direita" data-acao="cancelar" data-id="' + esc(id) + '"' + (ocupado ? " disabled" : "") + ">Cancelar assinatura</button>";
      h += "</div>";
    }
    return h + "</div>";
  }

  // ------------------------------------------------------------ as secoes

  function resumo() {
    var c = S.conta;
    var nome = S.editando
      ? '<form data-form="nome"><input name="nome" maxlength="80" autocomplete="name" value="' + esc(c.nome) + '" aria-label="Nome"><button type="submit" class="btn p primario">Salvar</button><button type="button" class="btn p" data-acao="cancelar-nome">Cancelar</button></form>'
      : "<span>" + (c.nome ? esc(c.nome) : '<span class="apagado">Sem nome</span>') + "</span>";
    var h = titulo("Resumo") +
      '<figure class="quadro faixa-quadro" aria-label="A Última Ceia, Leonardo da Vinci"><div class="faixa-img"></div>' +
      "<figcaption><span>A Última Ceia</span><small>Leonardo da Vinci, 1498 · Atos 2:42</small></figcaption></figure>" +
      h2("Conta Atos") + '<div class="card">' +
      '<div class="dado"><span class="rotulo">Nome</span>' + nome + (S.editando ? "<span></span>" : '<button type="button" class="btn p" data-acao="editar-nome">Editar</button>') + "</div>" +
      '<div class="dado"><span class="rotulo">E-mail</span><span>' + esc(c.email) + "</span><span></span></div>" +
      '<div class="dado"><span class="rotulo">Senha</span><span class="apagado">••••••••••</span><a class="btn p" href="/entrar/?modo=esqueci">Trocar a senha</a></div>' +
      "</div>" + (S.nomeErro ? '<p class="erro" role="alert">' + esc(S.nomeErro) + "</p>" : "");

    h += h2("Assinaturas");
    if (esperandoAtos()) h += esperandoAtos();
    else if (temAtos() && S.atos.produtos.length) h += '<div class="card">' + S.atos.produtos.map(itemDoResumo).join("") + "</div>";
    else h += vazio('Nenhuma assinatura. <a href="' + assinarDe("pavlvs") + '">Assinar o PAVLVS</a>');

    h += h2("Aplicativos com acesso");
    if (S.appsErro) h += vazio(esc(S.appsErro));
    else if (!S.apps) h += vazio("Carregando…");
    else if (!S.apps.length) h += vazio("Nenhum aplicativo tem acesso à sua conta.");
    else {
      h += '<div class="card">' + S.apps.map(function (x) {
        var partes = [resumoEscopos(x.escopos)];
        if (x.quando) partes.push("Permitido em " + data(x.quando));
        if (x.ultimo) partes.push("Último acesso em " + data(x.ultimo));
        return '<div class="item"><img class="logo" src="' + esc(x.icone) + '" alt="" width="32" height="32"><span class="nome"><strong>' + esc(x.nome) + "</strong><small>" + esc(partes.join(" · ")) + "</small></span>" +
          '<button type="button" class="btn p" data-app="' + esc(x.id) + '">Tirar o acesso</button></div>';
      }).join("") + "</div>";
    }
    h += '<p class="nota">Tirar o acesso faz o aplicativo pedir a sua permissão de novo na próxima vez; para sair dele agora, saia também dentro do aplicativo.</p>';

    h += h2("Excluir a conta") + '<div class="card excluir"><span>Remove a conta Atos e o acesso a todos os aplicativos.</span><button type="button" class="btn p perigo" data-acao="excluir">Excluir a conta</button></div>';
    return h;
  }
  function resumoEscopos(lista) {
    var curto = { "Saber que é você (um identificador da sua conta Atos)": "Identificador da conta", "Ver o seu endereço de e-mail": "e-mail", "Ver o seu nome": "nome" };
    var p = (lista || []).map(function (e) { return curto[e] || e; });
    if (p.length > 1) return p.slice(0, -1).join(", ") + " e " + p[p.length - 1];
    return p[0] || "";
  }

  function campo(nome, rotulo, classe, valor, extra) {
    return '<label class="campo ' + classe + '"><span class="rotulo">' + rotulo + '</span><input name="' + nome + '" value="' + esc(valor) + '" ' + (extra || "") + "></label>";
  }
  function dados() {
    var h = titulo("Dados", "Usados nas cobranças e nas notas fiscais de tudo o que você assina com a Atos.");
    if (esperandoAtos()) return h + h2("Identificação") + esperandoAtos();
    var p = S.atos.perfil || {};
    var e = p.endereco || {};
    var c = S.rascunho || { nome: p.nome, documento: p.documento, cep: e.cep, logradouro: e.logradouro, numero: e.numero, complemento: e.complemento, bairro: e.bairro, cidade: e.cidade, uf: e.uf };
    h += '<form data-form="dados">' + h2("Identificação") + '<div class="card grade">' +
      campo("nome", "Nome completo ou razão social", "s4", c.nome, 'maxlength="120" autocomplete="name" required') +
      campo("documento", "CPF ou CNPJ", "s2", c.documento, 'inputmode="numeric" placeholder="000.000.000-00" required') +
      '<div class="campo s2"><span class="rotulo">E-mail das notas</span><span>' + esc(S.conta.email) + "</span></div>" +
      "</div>" + h2("Endereço") + '<div class="card grade">' +
      campo("cep", "CEP", "s2", c.cep, 'inputmode="numeric" autocomplete="postal-code" placeholder="00000-000" required data-cep') +
      campo("logradouro", "Endereço", "s4", c.logradouro, 'autocomplete="address-line1" required') +
      campo("numero", "Número", "s2", c.numero, "required") +
      campo("complemento", "Complemento", "s4", c.complemento, 'autocomplete="address-line2"') +
      campo("bairro", "Bairro", "s2", c.bairro, "") +
      campo("cidade", "Cidade", "s3", c.cidade, 'autocomplete="address-level2" required') +
      campo("uf", "UF", "s1", c.uf, 'maxlength="2" autocomplete="address-level1" required') +
      "</div>" + '<div class="salvar"><p class="erro" role="alert">' + esc(S.dadosErro) + '</p><p class="ok">' + esc(S.dadosMsg) + "</p>" +
      '<button type="submit" class="btn primario"' + (S.salvando ? " disabled" : "") + ">Salvar</button></div></form>";
    return h + '<p class="nota">O e-mail das notas é o da Conta Atos. Os dados valem para a próxima cobrança; uma nota já emitida não muda.</p>';
  }

  function assinaturas() {
    var h = titulo("Assinaturas", "Os planos que você assina com a Atos.");
    if (esperandoAtos()) return h + esperandoAtos();
    if (!S.atos.produtos.length) return h + vazio('Nenhuma assinatura. <a href="' + assinarDe("pavlvs") + '">Assinar o PAVLVS</a>');
    h += S.atos.produtos.map(cartaoDoProduto).join("");
    if (S.acaoErro) h += '<p class="erro" role="alert">' + esc(S.acaoErro) + "</p>";
    var viva = S.atos.produtos.some(function (x) { return x.assinatura && (x.assinatura.status === "authorized" || x.assinatura.status === "paused"); });
    return h + '<p class="nota">' + (viva ? "Pausar para as cobranças até você reativar; o que já foi pago continua valendo até o fim. " : "") +
      "Para mudar de plano: cancele, e assine o outro quando o período pago acabar (antes disso, seria cobrar duas vezes). " +
      'Dúvidas: <a href="mailto:contato@atos.dev.br">contato@atos.dev.br</a>.</p>';
  }

  var ST_FATURA = { paga: ["Paga", ""], aguardando: ["Aguardando o Pix", "pendente"], processando: ["Processando", "pendente"], devolvida: ["Devolvida", ""], recusada: ["Recusada", ""] };
  var pendente = function (x) { return x.status === "aguardando" || x.status === "processando"; };
  var anoDe = function (x) { return String(x.data || "").slice(0, 4); };
  function produtoDe(x) { return String(x.produto || (/^PAVLVS/i.test(x.descricao || "") ? "pavlvs" : "")); }
  /* As faturas da Atos, num formato so. */
  function todasAsFaturas() {
    return (S.atos.faturas || []).map(function (x) {
      return { id: x.id, data: x.data, descricao: x.descricao, valor: Number(x.centavos || 0) / 100, status: x.status, forma: x.forma, produto: produtoDe(x) };
    });
  }
  function filtrar(l, f, semStatus) {
    var q = f.q.trim().toLowerCase();
    return l.filter(function (x) {
      if (!semStatus && f.status === "paga" && x.status !== "paga") return false;
      if (!semStatus && f.status === "pendente" && !pendente(x)) return false;
      if (f.ano && anoDe(x) !== f.ano) return false;
      if (f.produto && x.produto !== f.produto) return false;
      if (q && (String(x.id || "") + " " + (x.descricao || "")).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
  }
  function opcao(valor, rotulo, atual) { return '<option value="' + esc(valor) + '"' + (valor === atual ? " selected" : "") + ">" + esc(rotulo) + "</option>"; }
  function faturamento() {
    var h = titulo("Faturamento", "Os pagamentos do que você assina com a Atos.");
    if (esperandoAtos()) return h + esperandoAtos();
    var todas = todasAsFaturas();
    if (!todas.length) return h + '<div class="card filtros-vazio"><p class="vazio">Nenhum pagamento até agora.</p></div>';
    var f = S.filtro;
    var base = filtrar(todas, f, true);
    var cont = { "": base.length, paga: base.filter(function (x) { return x.status === "paga"; }).length, pendente: base.filter(pendente).length };
    var anos = todas.map(anoDe).filter(function (a, i, l) { return a && l.indexOf(a) === i; }).sort().reverse();
    var lista = filtrar(todas, f, false);
    h += '<div class="card filtros">' +
      '<div class="opcoes" role="group" aria-label="Situação">' + [["", "Todas"], ["paga", "Pagas"], ["pendente", "Pendentes"]].map(function (o) {
        return '<button type="button" data-filtro-status="' + o[0] + '" aria-pressed="' + (f.status === o[0]) + '">' + o[1] + ' <span class="conta-n">' + cont[o[0]] + "</span></button>";
      }).join("") + "</div>" +
      '<div class="filtros-campos">' +
      '<select class="seletor" data-filtro="ano" aria-label="Ano">' + opcao("", "Todos os anos", f.ano) + anos.map(function (a) { return opcao(a, a, f.ano); }).join("") + "</select>" +
      '<select class="seletor" data-filtro="produto" aria-label="Produto">' + opcao("", "Todos os produtos", f.produto) + opcao("pavlvs", "PAVLVS", f.produto) + "</select>" +
      '<input class="seletor busca" type="search" data-filtro="q" aria-label="Buscar" placeholder="Buscar" value="' + esc(f.q) + '">' +
      "</div></div>";
    if (!lista.length) {
      h += '<div class="card faturas-vazio"><span>Nenhuma fatura com esses filtros.</span><button type="button" class="btn p" data-acao="limpar-filtros">Limpar filtros</button></div>';
    } else {
      h += '<div class="card faturas"><div>' +
        '<div class="fatura cab"><span>Emissão e fatura</span><span>Situação</span><span class="valor">Valor</span><span></span></div>' +
        lista.map(function (x) {
          var st = ST_FATURA[x.status] || [x.status, ""];
          var docs = "";
          var sub = [data(x.data), x.id ? "Fatura " + x.id : "", x.forma === "pix" ? "Pix" : "Cartão"].filter(Boolean).join(" · ");
          return '<div class="fatura"><span class="fatura-desc"><span>' + esc(x.descricao) + "</span><small>" + esc(sub) + "</small></span>" +
            '<span class="fatura-sit ' + st[1] + '">' + esc(st[0]) + '</span><span class="valor">' + reais(x.valor) + '</span><span class="docs">' + docs + "</span></div>";
        }).join("") + "</div></div>";
    }
    var total = lista.reduce(function (t, x) { return t + (x.status === "paga" ? x.valor : 0); }, 0);
    var pend = lista.filter(pendente).length;
    h += '<div class="card faturas-resumo"><span>' + lista.length + (lista.length === 1 ? " fatura" : " faturas") + ' · <strong>' + reais(total) + "</strong> pagos" +
      (pend ? ' · <span class="aviso">' + pend + (pend === 1 ? " pendente" : " pendentes") + "</span>" : "") + "</span></div>";
    return h + '<p class="nota">A nota fiscal (NFS-e) dos pagamentos feitos na Atos ainda não sai sozinha. Se precisar dela, escreva para <a href="mailto:contato@atos.dev.br">contato@atos.dev.br</a>.</p>';
  }
  function aplicarFiltro() {
    var f = S.filtro, q = new URLSearchParams();
    if (f.ano) q.set("ano", f.ano);
    if (f.status) q.set("status", f.status);
    if (f.produto) q.set("produto", f.produto);
    if (f.q) q.set("q", f.q);
    history.replaceState(null, "", "/conta/faturamento" + (q.toString() ? "?" + q : ""));
    desenhar();
  }

  function carteira() {
    var h = titulo("Carteira", "O cartão usado nas assinaturas.");
    if (esperandoAtos()) return h + h2("Cartão") + esperandoAtos();
    var vivas = S.atos.produtos.filter(function (x) { var a = x.assinatura; return a && ["authorized", "paused", "pending"].indexOf(a.status) >= 0; });
    if (!vivas.length) return h + h2("Cartão") + vazio("Nenhuma assinatura no cartão. Os pagamentos de uma vez (o ano, o mês no Pix) não deixam cartão guardado.");
    h += h2("Cartão") + '<div class="card">' + vivas.map(function (x) {
      var b = bandeira(x.assinatura.bandeira);
      return '<div class="cartao-salvo"><span class="bandeira">' + esc(b[0]) + '</span><span class="nome"><strong>' + esc(b[1]) + "</strong><small>Usado no " + esc(x.nome) + "</small></span></div>";
    }).join("") + "</div>";
    return h + '<p class="nota">O cartão fica guardado no Mercado Pago, nunca na Atos. Trocar o cartão de uma assinatura ainda não é feito por aqui: ' +
      'escreva para <a href="mailto:contato@atos.dev.br">contato@atos.dev.br</a>.</p>';
  }

  var DESENHO = { resumo: resumo, dados: dados, assinaturas: assinaturas, faturamento: faturamento, carteira: carteira };

  function desenhar() {
    var sec = secaoAtual();
    var ativo = document.activeElement;
    var foco = ativo && (ativo.name || (ativo.getAttribute && ativo.getAttribute("data-filtro")));
    var pos = ativo && ativo.selectionStart;
    $("secao").innerHTML = DESENHO[sec]();
    if (S.editando) { var i = $("secao").querySelector("input[name=nome]"); if (i) i.focus(); }
    else if (foco) {
      var j = $("secao").querySelector('input[name="' + foco + '"], [data-filtro="' + foco + '"]');
      if (j) { j.focus(); if (pos != null && j.setSelectionRange) try { j.setSelectionRange(pos, pos); } catch (x) { /* select */ } }
    }
  }

  function ir(sec) {
    var url = sec === "resumo" ? "/conta/" : "/conta/" + sec;
    if (location.pathname !== url) history.pushState(null, "", url);
    S.dadosMsg = ""; S.dadosErro = ""; S.rascunho = null; S.confirmar = ""; S.acaoErro = "";
    S.filtro = { status: "", ano: "", produto: "", q: "" };
    $("modal-excluir").hidden = true;
    desenhar();
    window.scrollTo(0, 0);
  }

  function carregarApps() {
    api("/api/apps").then(function (d) {
      if (d.erro) { S.appsErro = d.erro; S.apps = null; } else { S.appsErro = ""; S.apps = d.apps || []; }
      desenhar();
    });
  }
  function carregarAtos() {
    return api("/api/cobranca/v1/conta").then(function (d) {
      if (d.erro || !d.produtos) { S.atosErro = d.erro || "não deu para carregar a cobrança agora"; S.atos = null; }
      else { S.atosErro = ""; S.atos = d; }
      desenhar();
    });
  }
  /* Pausar, reativar e cancelar: o Mercado Pago muda, e a tela le de novo. */
  function mudar(id, acao) {
    S.mudando = id; S.acaoErro = ""; desenhar();
    api("/api/subscriptions/" + encodeURIComponent(id) + "/" + acao, {}).then(function (d) {
      S.mudando = "";
      if (d.erro) { S.acaoErro = d.erro; desenhar(); return; }
      S.confirmar = "";
      carregarAtos();
    });
  }

  async function buscarCep(input) {
    var cep = input.value.replace(/\D/g, "");
    if (cep.length !== 8) return;
    try {
      var r = await fetch("https://viacep.com.br/ws/" + cep + "/json/");
      var e = await r.json();
      if (e.erro) return;
      var f = input.form;
      if (!f.logradouro.value) f.logradouro.value = e.logradouro || "";
      if (!f.bairro.value) f.bairro.value = e.bairro || "";
      f.cidade.value = e.localidade || ""; f.uf.value = e.uf || "";
      S.ibge = e.ibge || "";
      f.numero.focus();
    } catch (x) { /* sem a ViaCEP, a pessoa digita */ }
  }

  // ------------------------------------------------------------ os eventos

  document.addEventListener("click", function (e) {
    var link = e.target.closest("a[data-secao], a[data-ir]");
    if (link && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      e.preventDefault();
      ir(link.getAttribute("data-secao") || link.getAttribute("data-ir"));
      return;
    }
    var fs = e.target.closest("[data-filtro-status]");
    if (fs) { S.filtro.status = fs.getAttribute("data-filtro-status"); aplicarFiltro(); return; }
    var t = e.target.closest("[data-acao], [data-app], [data-fechar]");
    if (!t) return;
    if (t.hasAttribute("data-fechar")) { $("modal-excluir").hidden = true; return; }
    if (t.hasAttribute("data-app")) {
      t.disabled = true;
      api("/api/apps/revogar", { app: t.getAttribute("data-app") }).then(function (d) {
        if (d.erro) { S.appsErro = d.erro; desenhar(); return; }
        carregarApps();
      });
      return;
    }
    var a = t.getAttribute("data-acao"), id = t.getAttribute("data-id") || "";
    if (a === "editar-nome") { S.editando = true; S.nomeErro = ""; desenhar(); }
    else if (a === "cancelar-nome") { S.editando = false; S.nomeErro = ""; desenhar(); }
    else if (a === "excluir") { $("modal-excluir").hidden = false; $("modal-excluir").querySelector("[data-fechar]").focus(); }
    else if (a === "recarregar") { S.atos = null; S.atosErro = ""; desenhar(); carregarAtos(); }
    else if (a === "pausar") mudar(id, "pause");
    else if (a === "reativar") mudar(id, "reactivate");
    else if (a === "cancelar") { S.confirmar = id; S.acaoErro = ""; desenhar(); }
    else if (a === "cancelar-nao") { S.confirmar = ""; desenhar(); }
    else if (a === "cancelar-sim") mudar(id, "cancel");
    else if (a === "limpar-filtros") { S.filtro = { status: "", ano: "", produto: "", q: "" }; aplicarFiltro(); }
    else if (a === "sair") api("/api/sair", {}).then(function () { location.replace("/entrar/"); });
  });
  document.addEventListener("input", function (e) {
    var k = e.target && e.target.getAttribute && e.target.getAttribute("data-filtro");
    if (!k) return;
    S.filtro[k] = e.target.value;
    aplicarFiltro();
  });
  document.addEventListener("focusout", function (e) {
    if (e.target && e.target.hasAttribute && e.target.hasAttribute("data-cep")) buscarCep(e.target);
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !$("modal-excluir").hidden) $("modal-excluir").hidden = true;
  });
  $("modal-excluir").addEventListener("click", function (e) { if (e.target === this) this.hidden = true; });

  document.addEventListener("submit", function (e) {
    var f = e.target.closest("form[data-form]");
    if (!f) return;
    e.preventDefault();
    var v = new FormData(f);
    if (f.getAttribute("data-form") === "nome") {
      api("/api/nome", { nome: String(v.get("nome") || "").trim() }).then(function (d) {
        if (d.erro) { S.nomeErro = d.erro; desenhar(); return; }
        S.conta = d.conta; S.editando = false; S.nomeErro = ""; desenhar();
      });
      return;
    }
    var c = {};
    v.forEach(function (x, k) { c[k] = String(x).trim(); });
    var antes = (S.atos.perfil && S.atos.perfil.endereco) || {};
    var corpo = { nome: c.nome, documento: c.documento, endereco: { cep: c.cep, logradouro: c.logradouro, numero: c.numero, complemento: c.complemento,
      bairro: c.bairro, cidade: c.cidade, uf: c.uf, ibge: S.ibge || (String(c.cep).replace(/\D/g, "") === antes.cep ? antes.ibge : "") } };
    S.rascunho = c; S.salvando = true; S.dadosErro = ""; S.dadosMsg = ""; desenhar();
    api("/api/cobranca/v1/cliente", corpo).then(function (d) {
      S.salvando = false;
      if (d.erro) { S.dadosErro = d.erro; desenhar(); return; }
      S.atos.perfil = d.perfil; S.rascunho = null; S.dadosMsg = "Salvo."; desenhar();
    });
  });

  window.addEventListener("popstate", function () { S.filtro = filtroDaUrl(); desenhar(); });

  api("/api/eu").then(function (d) {
    if (!d.conta) { location.replace("/entrar/?volta=" + encodeURIComponent(location.pathname)); return; }
    S.conta = d.conta;
    $("conta").hidden = false;
    desenhar();
    carregarApps();
    carregarAtos();
  });
})();
