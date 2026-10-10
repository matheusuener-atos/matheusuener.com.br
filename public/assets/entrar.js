/* A pagina /entrar: entrar na conta Atos, criar a conta, trocar a senha e,
   quando um aplicativo pede ("Entrar com Atos", ?client_id=...), permitir que
   ele saiba quem e voce. O Worker confere tudo (worker/oidc.js e
   worker/contas.js); aqui so se desenha e se pergunta.

   Sem client_id na consulta, a pessoa entra e vai para /conta - ou para o ?volta=, quando e um caminho
   desta propria Atos (o checkout de um produto manda quem ainda nao entrou para ca e volta). */
(function () {
  "use strict";
  var consulta = location.search.replace(/^\?/, "");
  var params = new URLSearchParams(consulta);
  var OIDC = params.has("client_id");
  var tela = document.getElementById("tela");
  var S = { modo: "carregando", email: "", nome: "", erro: params.get("erro_google") || "", pedido: null, ocupado: false, google: false, aviso: "" };
  // O cadastro esperando o codigo (so na memoria desta aba): o "Reenviar codigo" manda de novo.
  var pendente = null;
  // Aberto por um aplicativo ("Entrar com Atos"): o modo popup, so a marca no topo.
  if (OIDC) document.body.classList.add("popup");
  // O pedido do aplicativo vai junto ao Google e volta (worker/google.js); o erro dele nao.
  params.delete("erro_google");
  // So caminho daqui ("/pavlvs/assinar/?preco=..."), nunca outro site: "//x" e "https:" nao passam.
  var VOLTA = (function () { var v = params.get("volta") || ""; return /^\/(?![\/\\])/.test(v) ? v : ""; })();
  consulta = OIDC ? (function () { var q = new URLSearchParams(params); return q.toString(); })() : VOLTA ? "volta=" + encodeURIComponent(VOLTA) : "";
  var G = '<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>';
  /* "Continuar com Google" (worker/google.js), dentro do cartao, depois do "ou": so com o Google ligado na Atos. */
  function comGoogle() {
    if (!S.google) return "";
    return '<div class="ou">ou</div><a class="btn largo" href="/oauth/google?consulta=' + encodeURIComponent(consulta) + '">' + G + "<span>Continuar com Google</span></a>";
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

  function nomeDoApp() { return S.pedido && S.pedido.app ? S.pedido.app.nome : ""; }

  function campo(nome, rotulo, tipo, extra, classe) {
    // div e label for, e nao o label em volta: o "Esqueci a senha" ao lado do rotulo e um botao
    var topo = '<label class="rotulo" for="c-' + nome + '">' + rotulo + "</label>";
    if (nome === "senha" && S.modo === "entrar") topo = '<span class="topo-campo">' + topo + link("esqueci", "Esqueci a senha") + "</span>";
    return '<div class="campo' + (classe ? " " + classe : "") + '">' + topo + '<input id="c-' + nome + '" name="' + nome + '" type="' + tipo + '" ' + (extra || "") + ">" +
      (nome === "senha2" ? '<span class="dica">Pelo menos 10 caracteres, com letras e números.</span>' : "") + "</div>";
  }
  var ERRO = function () { return '<p class="erro" role="alert">' + esc(S.erro) + "</p>"; };
  var DIS = function () { return S.ocupado ? " disabled" : ""; };
  function botao(texto) { return '<button type="submit" class="btn primario largo"' + DIS() + ">" + texto + "</button>"; }
  function link(acao, texto, forte) { return '<button type="button" class="link' + (forte ? " forte" : "") + '" data-acao="' + acao + '">' + texto + "</button>"; }
  /* a frase curta embaixo do titulo vai em prata; a explicacao longa, em cinza */
  function cabeca(titulo, sub, longo) { return '<div class="cabeca"><h1>' + titulo + "</h1>" + (sub ? (longo ? '<p class="longo">' : "<p>") + sub + "</p>" : "") + "</div>"; }
  function pe(conteudo) { return '<div class="pe">' + conteudo + "</div>"; }
  function maiuscula(t) { t = String(t || ""); return t.charAt(0).toUpperCase() + t.slice(1); }
  var COD = 'inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" placeholder="000000" required';

  function desenhar() {
    var h = "";
    var app = nomeDoApp();
    var paraApp = app ? "Para continuar no " + esc(app) : "";
    if (S.modo === "carregando") {
      h = cabeca(app ? "Voltando ao " + esc(app) + "…" : "Carregando…");
    } else if (S.modo === "fatal") {
      h = cabeca("Não foi possível continuar") +
        '<div class="form"><p class="erro" role="alert">' + esc(S.erro) + '</p><p class="nota">Volte ao aplicativo e tente de novo. Se continuar, escreva para contato@atos.dev.br.</p></div>';
    } else if (S.modo === "entrar") {
      h = cabeca(app ? "Entrar com a conta Atos" : "Entrar na conta Atos", paraApp) +
        '<form class="form" data-form="entrar">' + ERRO() +
        campo("email", "E-mail", "email", 'autocomplete="username" maxlength="200" placeholder="voce@empresa.com" required value="' + esc(S.email) + '"') +
        campo("senha", "Senha", "password", 'autocomplete="current-password" maxlength="200" required') +
        botao("Entrar") + comGoogle() + "</form>" +
        pe("Não tem conta? " + link("criar", "Criar conta", true));
    } else if (S.modo === "criar") {
      h = cabeca("Criar a conta Atos", paraApp) +
        '<form class="form" data-form="criar">' + ERRO() +
        campo("nome", "Nome", "text", 'autocomplete="name" maxlength="80" value="' + esc(S.nome) + '"') +
        campo("email", "E-mail", "email", 'autocomplete="email" maxlength="200" placeholder="voce@empresa.com" required value="' + esc(S.email) + '"') +
        campo("senha", "Senha", "password", 'autocomplete="new-password" maxlength="200" required') +
        campo("senha2", "Confirmar a senha", "password", 'autocomplete="new-password" maxlength="200" required') +
        botao("Criar conta") + comGoogle() + "</form>" +
        pe("Já tem conta? " + link("entrar", "Entrar", true));
    } else if (S.modo === "confirmar") {
      h = cabeca("Confirme o seu e-mail", "Enviamos um código de 6 dígitos para <strong>" + esc(S.email) + "</strong>. Ele vale 15 minutos.", true) +
        '<form class="form" data-form="confirmar">' + ERRO() + (S.aviso ? '<p class="ok">' + esc(S.aviso) + "</p>" : "") +
        campo("codigo", "Código", "text", COD, "codigo") + botao("Confirmar") + "</form>" +
        pe(link("criar", "Voltar") + (pendente ? " · " + link("reenviar", "Reenviar código") : ""));
    } else if (S.modo === "esqueci") {
      h = cabeca("Trocar a senha", "Mandamos um código para o seu e-mail. Se você só entrava com o Google, assim você cria uma senha para a mesma conta.", true) +
        '<form class="form" data-form="esqueci">' + ERRO() +
        campo("email", "E-mail", "email", 'autocomplete="email" maxlength="200" placeholder="voce@empresa.com" required value="' + esc(S.email) + '"') +
        botao("Enviar o código") + "</form>" + pe(link("entrar", "Voltar"));
    } else if (S.modo === "redefinir") {
      h = cabeca("Trocar a senha", "Se <strong>" + esc(S.email) + "</strong> tem conta, chegou lá um código de 6 dígitos. Ele vale 15 minutos.", true) +
        '<form class="form" data-form="redefinir">' + ERRO() +
        campo("codigo", "Código", "text", COD, "codigo") +
        campo("senha", "Nova senha", "password", 'autocomplete="new-password" maxlength="200" required') +
        campo("senha2", "Confirmar a nova senha", "password", 'autocomplete="new-password" maxlength="200" required') +
        botao("Trocar a senha") + "</form>" + pe(link("esqueci", "Voltar"));
    } else if (S.modo === "consentir") {
      var p = S.pedido;
      var nome = esc(p.app.nome);
      h = cabeca("O " + nome + " quer entrar com a sua conta Atos", "Confira antes de permitir") +
        '<div class="card">' +
        '<div class="linha app"><img class="logo" src="' + esc(p.app.icone) + '" alt="" width="36" height="36"><span class="nome"><strong>' + nome + "</strong><small>" + esc(maiuscula(p.app.descricao)) + "</small></span></div>" +
        '<div class="linha"><span class="nome"><strong>' + esc(p.conta.nome || p.conta.email) + "</strong>" + (p.conta.nome ? "<small>" + esc(p.conta.email) + "</small>" : "") + "</span>" + link("trocar", "Trocar de conta") + "</div>" +
        '<div class="escopos"><span class="titulo-secao">O ' + nome + " poderá</span>" +
        p.escopos.map(function (e) { return '<div><span aria-hidden="true">✓</span><span>' + esc(e.texto) + "</span></div>"; }).join("") + "</div></div>" +
        '<p class="nota">O ' + nome + " não recebe a sua senha. Você pode tirar essa permissão quando quiser, em Minha conta. " +
        "Veja como o " + nome + ' trata os seus dados na <a href="' + esc(p.app.privacidade) + '" target="_blank" rel="noopener">política de privacidade</a> e nos ' +
        '<a href="' + esc(p.app.termos) + '" target="_blank" rel="noopener">termos de uso</a> dele.</p>' + ERRO() +
        '<div class="dois"><button type="button" class="btn" data-acao="negar"' + DIS() + ">Cancelar</button>" +
        '<button type="button" class="btn primario" data-acao="permitir"' + DIS() + ">Permitir</button></div>";
    }
    tela.innerHTML = h;
    var foco = tela.querySelector("input:not([value]), input[value=''], input[name=senha], input[name=codigo]") || tela.querySelector("input");
    if (foco && !S.ocupado) foco.focus();
  }

  function ir(modo, erro) { S.modo = modo; S.erro = erro || ""; S.aviso = ""; S.ocupado = false; desenhar(); }

  /* Ja dentro da conta: com aplicativo, segue o pedido; sem, vai para /conta. */
  function depoisDeEntrar() {
    if (!OIDC) { location.replace(VOLTA || "/conta/"); return; }
    pedir();
  }

  function pedir() {
    api("/api/pedido", { consulta: consulta }).then(function (d) {
      if (d.ir) { location.replace(d.ir); return; }
      if (d.erro) { ir("fatal", d.erro); return; }
      S.pedido = d;
      S.google = Boolean(d.google);
      if (d.entrar) { S.email = S.email || d.dica || (d.conta && d.conta.email) || ""; ir("entrar", S.erro); return; }
      if (d.permitido) { autorizar(true); return; }
      ir("consentir");
    });
  }

  function autorizar(permitir) {
    S.ocupado = true; S.erro = "";
    if (permitir && S.modo !== "consentir") S.modo = "carregando";
    desenhar();
    api("/api/autorizar", { consulta: consulta, permitir: permitir }).then(function (d) {
      if (d.ir) { location.replace(d.ir); return; }
      if (d._status === 401) { ir("entrar", d.erro); return; }
      S.ocupado = false; S.erro = d.erro || "não deu certo: tente de novo"; desenhar();
    });
  }

  function enviar(form) {
    var f = new FormData(form);
    var v = function (k) { return String(f.get(k) || ""); };
    var modo = form.getAttribute("data-form");
    if (v("email")) S.email = v("email").trim();
    if (modo === "criar") S.nome = v("nome").trim();
    if ((modo === "criar" || modo === "redefinir") && v("senha") !== v("senha2")) { S.erro = "as duas senhas não são iguais"; desenhar(); return; }
    var rota, corpo, depois;
    if (modo === "entrar") { rota = "/api/entrar"; corpo = { email: S.email, senha: v("senha") }; depois = depoisDeEntrar; }
    else if (modo === "criar") { rota = "/api/cadastrar"; corpo = { email: S.email, senha: v("senha"), nome: S.nome }; depois = function () { pendente = corpo; ir("confirmar"); }; }
    else if (modo === "confirmar") { rota = "/api/confirmar"; corpo = { email: S.email, codigo: v("codigo").trim() }; depois = depoisDeEntrar; }
    else if (modo === "esqueci") { rota = "/api/esqueci"; corpo = { email: S.email }; depois = function () { ir("redefinir"); }; }
    else if (modo === "redefinir") { rota = "/api/redefinir"; corpo = { email: S.email, codigo: v("codigo").trim(), senha: v("senha") }; depois = depoisDeEntrar; }
    S.ocupado = true; S.erro = ""; desenhar();
    api(rota, corpo).then(function (d) {
      S.ocupado = false;
      if (d.ok) { depois(); return; }
      S.erro = d.erro || "não deu certo: tente de novo"; desenhar();
    });
  }

  tela.addEventListener("submit", function (e) { e.preventDefault(); if (!S.ocupado) enviar(e.target); });
  tela.addEventListener("click", function (e) {
    var b = e.target.closest("[data-acao]");
    if (!b || S.ocupado) return;
    var a = b.getAttribute("data-acao");
    if (a === "permitir") autorizar(true);
    else if (a === "negar") autorizar(false);
    else if (a === "trocar") api("/api/sair", {}).then(function () { S.email = ""; ir("entrar"); });
    else if (a === "reenviar") {
      if (!pendente) return;
      S.ocupado = true; S.erro = ""; S.aviso = ""; desenhar();
      api("/api/cadastrar", pendente).then(function (d) {
        S.ocupado = false;
        if (d.ok) S.aviso = "Mandamos um código novo. O anterior não vale mais."; else S.erro = d.erro || "não deu certo: tente de novo";
        desenhar();
      });
    }
    else ir(a);
  });

  if (OIDC) pedir();
  else api("/api/eu").then(function (d) {
    var modo = params.get("modo");
    S.google = Boolean(d.google);
    if (d.conta && !modo && !S.erro) { location.replace(VOLTA || "/conta/"); return; }
    if (d.conta) S.email = d.conta.email;
    ir(modo === "criar" || modo === "esqueci" ? modo : "entrar", S.erro);
  });
})();
