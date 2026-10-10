/* A Minha conta (/conta/ e /conta/<secao>): Resumo e Dados da conta Atos;
   Assinaturas, Faturamento e Carteira do que a pessoa assina com a Atos.

   A conta (nome, e-mail, aplicativos) vem da Atos (/api/eu, /api/apps). A
   cobranca vem do PAVLVS, que e quem cobra, pela ponte do Worker
   (/api/cobranca, worker/cobranca.js). Trocar de plano, trocar o cartao e
   cancelar abrem a Minha conta do PAVLVS, onde esta o pagamento.
   Sem sessao, vai para /entrar. */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var PAVLVS_CONTA = "https://paulus.ia.br/minha-conta";
  var SECOES = ["resumo", "dados", "assinaturas", "faturamento", "carteira"];
  var S = { conta: null, apps: null, appsErro: "", cob: null, cobErro: "", editando: false, nomeErro: "", tipo: "", dadosMsg: "", dadosErro: "", salvando: false, rascunho: null };

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
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
    return m ? m[3] + "/" + m[2] + "/" + m[1] : "";
  }
  function reais(v) { return Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }); }
  var LOGO = '<img class="logo" src="/assets/paulus-p.png" alt="" width="32" height="32">';
  var FORA = ' target="_blank" rel="noopener"';

  function secaoAtual() {
    var m = /^\/conta\/([a-z]+)/.exec(location.pathname);
    return m && SECOES.indexOf(m[1]) > 0 ? m[1] : "resumo";
  }
  function titulo(t, descricao) { return "<h1>" + t + "</h1>" + (descricao ? '<p class="descricao">' + descricao + "</p>" : ""); }
  function h2(t) { return '<h2 class="titulo-secao">' + t + "</h2>"; }
  function vazio(t) { return '<div class="card"><p class="vazio">' + t + "</p></div>"; }
  /* a cobranca ainda nao chegou, ou nao deu */
  function semCobranca() {
    if (S.cobErro) return '<div class="card"><p class="vazio">' + esc(S.cobErro) + ' <button type="button" class="link" data-acao="recarregar">Tentar de novo</button></p></div>';
    if (!S.cob) return vazio("Carregando…");
    return "";
  }

  var SITUACAO = {
    ativa: ["Ativa", ""], cortesia: ["Cortesia", ""], pendente: ["Pendente", "neutro"], pausada: ["Pausada", "neutro"],
    cancelada: ["Cancelada", "perigo"], vencida: ["Vencida", "perigo"],
  };
  function selo(sit) { var x = SITUACAO[sit] || [sit || "—", "neutro"]; return '<span class="selo' + (x[1] ? " " + x[1] : "") + '">' + esc(x[0]) + "</span>"; }
  function planoDe(a) { return "Plano " + (a.nome || "").replace(/^plano\s+/i, "") + (a.periodo === "anual" ? " anual" : ""); }
  function valorDe(a) { return reais(a.valor) + (a.periodo === "anual" ? "/ano" : "/mês"); }
  var BANDEIRAS = { visa: ["VISA", "Visa"], master: ["MC", "Mastercard"], mastercard: ["MC", "Mastercard"], amex: ["AMEX", "American Express"], elo: ["ELO", "Elo"], hipercard: ["HIPER", "Hipercard"], diners: ["DINERS", "Diners"] };
  function bandeira(b) { var k = String(b || "").toLowerCase(); return BANDEIRAS[k] || [k.slice(0, 5).toUpperCase() || "CARTÃO", k ? k.charAt(0).toUpperCase() + k.slice(1) : "Cartão"]; }
  function cartaoTexto(c) { return bandeira(c.bandeira)[1] + " •••• " + esc(c.final); }
  function pagamentoTexto(cob) {
    var a = cob.assinatura;
    if (a && a.forma === "pix") return "Pix" + (cob.pix_ate ? " · pago até " + data(cob.pix_ate) : "");
    return cob.cartao ? cartaoTexto(cob.cartao) : "Cartão";
  }

  // ------------------------------------------------------------ as secoes

  function resumo() {
    var c = S.conta;
    var nome = S.editando
      ? '<form data-form="nome"><input name="nome" maxlength="80" autocomplete="name" value="' + esc(c.nome) + '" aria-label="Nome"><button type="submit" class="btn p primario">Salvar</button><button type="button" class="btn p" data-acao="cancelar-nome">Cancelar</button></form>'
      : "<span>" + (c.nome ? esc(c.nome) : '<span class="apagado">Sem nome</span>') + "</span>";
    var h = titulo("Resumo") + h2("Conta Atos") + '<div class="card">' +
      '<div class="dado"><span class="rotulo">Nome</span>' + nome + (S.editando ? "<span></span>" : '<button type="button" class="btn p" data-acao="editar-nome">Editar</button>') + "</div>" +
      '<div class="dado"><span class="rotulo">E-mail</span><span>' + esc(c.email) + "</span><span></span></div>" +
      '<div class="dado"><span class="rotulo">Senha</span><span class="apagado">••••••••••</span><a class="btn p" href="/entrar/?modo=esqueci">Trocar a senha</a></div>' +
      "</div>" + (S.nomeErro ? '<p class="erro" role="alert">' + esc(S.nomeErro) + "</p>" : "");

    h += h2("Assinatura");
    var a = S.cob && S.cob.assinatura;
    if (!S.cob || S.cobErro) h += semCobranca();
    else if (!a) h += vazio("Nenhuma assinatura ativa.");
    else {
      var linha = a.proxima && a.situacao === "ativa" ? "Próxima cobrança em " + data(a.proxima) + " · " + valorDe(a)
        : a.proxima ? "Vale até " + data(a.proxima) : valorDe(a);
      h += '<a class="item" href="/conta/assinaturas" data-ir="assinaturas">' + LOGO +
        '<span class="nome"><strong>PAVLVS · ' + esc(planoDe(a)) + "</strong><small>" + linha + "</small></span>" + selo(a.situacao) + '<span class="seta" aria-hidden="true">→</span></a>';
    }

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
    var h = titulo("Dados", "Usados na assinatura e nas notas fiscais.");
    if (!S.cob || S.cobErro) return h + h2("Identificação") + semCobranca();
    if (!S.cob.cadastro) {
      return h + h2("Identificação") + vazio('Os dados da nota ficam na assinatura do PAVLVS e aparecem aqui depois que você assinar, em <a href="https://paulus.ia.br/assinatura"' + FORA + ">paulus.ia.br/assinatura</a>.");
    }
    var c = S.rascunho || S.cob.cadastro;
    var titular = S.cob.papel === "titular";
    var digitos = String(c.documento || "").replace(/\D/g, "");
    var tipo = S.tipo || (digitos.length === 14 ? "pj" : "pf");
    var pf = tipo === "pf";
    var trava = titular ? "" : " disabled";
    h += '<form data-form="dados">' + h2("Identificação") + '<div class="card grade">' +
      '<div class="alternar tudo" role="group" aria-label="Tipo de pessoa">' +
      '<button type="button" data-tipo="pf" aria-pressed="' + pf + '"' + trava + ">Pessoa física</button>" +
      '<button type="button" data-tipo="pj" aria-pressed="' + !pf + '"' + trava + ">Pessoa jurídica</button></div>" +
      campo("nome", pf ? "Nome completo" : "Razão social", "s4", c.nome, 'maxlength="80" autocomplete="' + (pf ? "name" : "organization") + '" required' + trava) +
      campo("documento", pf ? "CPF" : "CNPJ", "s2", c.documento, 'inputmode="numeric" placeholder="' + (pf ? "000.000.000-00" : "00.000.000/0000-00") + '" required' + trava) +
      campo("oab", "OAB, RG ou CNH", "s2", c.oab, 'maxlength="40" required' + trava) +
      campo("telefone", "Telefone", "s2", c.telefone, 'type="tel" autocomplete="tel" placeholder="(00) 00000-0000" required' + trava) +
      campo("email_cobranca", "E-mail para notas fiscais", "s2", c.email_cobranca, 'type="email" maxlength="120"' + trava) +
      "</div>" + h2("Endereço de cobrança") + '<div class="card grade">' +
      campo("cep", "CEP", "s2", c.cep, 'inputmode="numeric" autocomplete="postal-code" placeholder="00000-000" required' + trava) +
      campo("logradouro", "Endereço", "s4", c.logradouro, 'autocomplete="address-line1" required' + trava) +
      campo("numero", "Número", "s2", c.numero, 'required' + trava) +
      campo("complemento", "Complemento", "s4", c.complemento, 'autocomplete="address-line2"' + trava) +
      campo("bairro", "Bairro", "s2", c.bairro, 'required' + trava) +
      campo("cidade", "Cidade", "s3", c.cidade, 'autocomplete="address-level2" required' + trava) +
      campo("uf", "UF", "s1", c.uf, 'maxlength="2" autocomplete="address-level1" required' + trava) +
      "</div>" + '<div class="salvar"><p class="erro" role="alert">' + esc(S.dadosErro) + '</p><p class="ok">' + esc(S.dadosMsg) + "</p>" +
      (titular ? '<button type="submit" class="btn primario"' + (S.salvando ? " disabled" : "") + ">Salvar</button>" : '<p class="nota">Só o titular da assinatura troca estes dados.</p>') +
      "</div></form>";
    return h;
  }

  function assinaturas() {
    var h = titulo("Assinaturas", "Planos dos softwares geridos pela Atos.");
    if (!S.cob || S.cobErro) return h + h2("Ativas") + semCobranca();
    var a = S.cob.assinatura;
    if (!a) return h + h2("Ativas") + vazio("Nenhuma assinatura ativa.");
    var ativa = a.situacao === "ativa" || a.situacao === "cortesia" || a.situacao === "pendente";
    var titular = S.cob.papel === "titular";
    h += h2(ativa ? "Ativas" : "Assinatura") + '<div class="card">' +
      '<div class="assinatura-topo"><img class="logo" src="/assets/paulus-p.png" alt="" width="40" height="40"><span class="nome"><strong>PAVLVS</strong><small>' + esc(planoDe(a)) + " · " + valorDe(a) + "</small></span>" + selo(a.situacao) + "</div>" +
      '<div class="colunas">' +
      '<div><span class="rotulo">Desde</span><span>' + (data(a.desde) || "—") + "</span></div>" +
      '<div><span class="rotulo">' + (a.situacao === "ativa" ? "Próxima cobrança" : "Vale até") + "</span><span>" + (data(a.proxima) || "—") + "</span></div>" +
      '<div><span class="rotulo">Pagamento</span><span>' + pagamentoTexto(S.cob) + "</span></div>" +
      "</div>" + '<div class="botoes">' +
      (titular ? '<a class="btn p" href="' + PAVLVS_CONTA + '"' + FORA + '>Trocar de plano<span class="glifo" aria-hidden="true">↗</span></a>' : "") +
      (a.forma !== "pix" ? '<a class="btn p" href="/conta/carteira" data-ir="carteira">Trocar cartão</a>' : "") +
      (titular && ativa ? '<a class="btn p perigo direita" href="' + PAVLVS_CONTA + '"' + FORA + '>Cancelar assinatura<span class="glifo" aria-hidden="true">↗</span></a>' : "") +
      "</div></div>";
    return h + '<p class="nota">Trocar de plano e cancelar abrem a Minha conta do PAVLVS, onde está o pagamento.</p>';
  }

  function faturamento() {
    var h = titulo("Faturamento", "Notas fiscais (NFS-e) e arquivos XML.");
    if (!S.cob || S.cobErro) return h + h2("Faturas") + semCobranca();
    var f = S.cob.faturas || [];
    if (!f.length) return h + h2("Faturas") + vazio("Nenhuma fatura até agora.");
    var ST = { paga: ["Paga", ""], pendente: ["Pendente", "outro"], estornada: ["Estornada", "outro"] };
    h += h2("Faturas") + '<div class="card tabela"><div>' +
      '<div class="tr th"><span>Data</span><span>Descrição</span><span>Valor</span><span>Status</span><span>Documentos</span></div>' +
      f.map(function (x) {
        var st = ST[x.situacao] || [x.situacao, "outro"];
        var docs = (x.pdf ? '<a class="btn mini" href="' + esc(x.pdf) + '"' + FORA + ">NFS-e</a>" : "") + (x.xml ? '<a class="btn mini" href="' + esc(x.xml) + '"' + FORA + ">XML</a>" : "");
        return '<div class="tr"><span class="data">' + data(x.data) + '</span><span class="desc"><span>PAVLVS · ' + esc(x.descricao) + "</span>" +
          (x.nfse ? "<small>NFS-e " + esc(x.nfse) + "</small>" : x.situacao === "paga" ? "<small>NFS-e em emissão</small>" : "") + "</span>" +
          "<span>" + reais(x.valor) + '</span><span class="status ' + st[1] + '">' + esc(st[0]) + '</span><span class="docs">' + (docs || '<span class="sem">—</span>') + "</span></div>";
      }).join("") + "</div></div>";
    return h;
  }

  function carteira() {
    var h = titulo("Carteira", "O cartão usado nas assinaturas.");
    if (!S.cob || S.cobErro) return h + h2("Cartão salvo") + semCobranca();
    var c = S.cob.cartao;
    var a = S.cob.assinatura;
    if (a && a.forma === "pix") return h + h2("Cartão salvo") + vazio("A assinatura está no Pix" + (S.cob.pix_ate ? ", paga até " + data(S.cob.pix_ate) : "") + ": não há cartão em uso.");
    if (!c) return h + h2("Cartão salvo") + vazio("Nenhuma forma de pagamento cadastrada.");
    var v = /^(\d{2})\/(\d{2})$/.exec(c.validade || "");
    var vence = v ? v[1] + "/20" + v[2] : esc(c.validade);
    h += h2("Cartão salvo") + '<div class="card cartao-salvo"><span class="bandeira">' + esc(bandeira(c.bandeira)[0]) + "</span>" +
      '<span class="nome"><strong>' + cartaoTexto(c) + "</strong><small>" + (vence ? "Vence em " + vence + " · " : "") + "Usado no PAVLVS</small></span>" +
      '<a class="btn p" href="' + PAVLVS_CONTA + '"' + FORA + '>Trocar<span class="glifo" aria-hidden="true">↗</span></a></div>';
    return h + '<p class="nota">O cartão é trocado na Minha conta do PAVLVS, onde está o pagamento. Ele não pode ser removido enquanto a assinatura estiver no cartão.</p>';
  }

  var DESENHO = { resumo: resumo, dados: dados, assinaturas: assinaturas, faturamento: faturamento, carteira: carteira };

  function desenhar() {
    var sec = secaoAtual();
    document.querySelectorAll(".menu nav a").forEach(function (a) {
      if (a.getAttribute("data-secao") === sec) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    $("m-nome").textContent = S.conta.nome || "Sua conta";
    $("m-email").textContent = S.conta.email;
    $("m-email").title = S.conta.email;
    var foco = document.activeElement && document.activeElement.name;
    $("secao").innerHTML = DESENHO[sec]();
    if (S.editando) { var i = $("secao").querySelector("input[name=nome]"); if (i) i.focus(); }
    else if (foco) { var j = $("secao").querySelector('input[name="' + foco + '"]'); if (j) j.focus(); }
  }

  function ir(sec) {
    var url = sec === "resumo" ? "/conta/" : "/conta/" + sec;
    if (location.pathname !== url) history.pushState(null, "", url);
    S.dadosMsg = ""; S.dadosErro = ""; S.tipo = ""; S.rascunho = null;
    desenhar();
    window.scrollTo(0, 0);
  }

  function carregarApps() {
    api("/api/apps").then(function (d) {
      if (d.erro) { S.appsErro = d.erro; S.apps = null; } else { S.appsErro = ""; S.apps = d.apps || []; }
      desenhar();
    });
  }
  function carregarCobranca() {
    S.cob = null; S.cobErro = "";
    api("/api/cobranca").then(function (d) {
      if (d.sem_conta) S.cob = { assinatura: null, cartao: null, faturas: [], cadastro: null, papel: "" };
      else if (d.erro) S.cobErro = d.erro;
      else S.cob = d;
      desenhar();
    });
  }

  // ------------------------------------------------------------ os eventos

  document.addEventListener("click", function (e) {
    var link = e.target.closest("a[data-secao], a[data-ir]");
    if (link && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      e.preventDefault();
      ir(link.getAttribute("data-secao") || link.getAttribute("data-ir"));
      return;
    }
    var t = e.target.closest("[data-acao], [data-app], [data-tipo], [data-fechar]");
    if (!t) return;
    if (t.hasAttribute("data-fechar")) { $("modal-excluir").hidden = true; return; }
    if (t.hasAttribute("data-tipo")) {
      var fd = t.closest("form") ? new FormData(t.closest("form")) : null;
      if (fd) { S.rascunho = {}; fd.forEach(function (x, k) { S.rascunho[k] = String(x); }); }
      S.tipo = t.getAttribute("data-tipo"); desenhar(); return;
    }
    if (t.hasAttribute("data-app")) {
      t.disabled = true;
      api("/api/apps/revogar", { app: t.getAttribute("data-app") }).then(function (d) {
        if (d.erro) { S.appsErro = d.erro; desenhar(); return; }
        carregarApps();
      });
      return;
    }
    var a = t.getAttribute("data-acao");
    if (a === "editar-nome") { S.editando = true; S.nomeErro = ""; desenhar(); }
    else if (a === "cancelar-nome") { S.editando = false; S.nomeErro = ""; desenhar(); }
    else if (a === "excluir") { $("modal-excluir").hidden = false; $("modal-excluir").querySelector("[data-fechar]").focus(); }
    else if (a === "recarregar") { carregarCobranca(); desenhar(); }
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
    var corpo = {};
    v.forEach(function (x, k) { corpo[k] = String(x).trim(); });
    S.rascunho = corpo; S.salvando = true; S.dadosErro = ""; S.dadosMsg = ""; desenhar();
    api("/api/cobranca/cadastro", corpo).then(function (d) {
      S.salvando = false;
      if (d.erro) { S.dadosErro = d.erro; desenhar(); return; }
      if (d.cadastro) S.cob.cadastro = d.cadastro;
      S.tipo = ""; S.rascunho = null; S.dadosMsg = "Salvo."; desenhar();
    });
  });

  $("m-sair").addEventListener("click", function () {
    api("/api/sair", {}).then(function () { location.replace("/entrar/"); });
  });
  window.addEventListener("popstate", desenhar);

  api("/api/eu").then(function (d) {
    if (!d.conta) { location.replace("/entrar/"); return; }
    S.conta = d.conta;
    $("conta").hidden = false;
    desenhar();
    carregarApps();
    carregarCobranca();
  });
})();
