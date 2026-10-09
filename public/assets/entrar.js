/* A pagina /entrar: entrar na conta Atos, criar a conta, trocar a senha e,
   quando um aplicativo pede ("Entrar com Atos", ?client_id=...), permitir que
   ele saiba quem e voce. O Worker confere tudo (worker/oidc.js e
   worker/contas.js); aqui so se desenha e se pergunta.

   Sem client_id na consulta, a pessoa entra e vai para /conta. */
(function () {
  "use strict";
  var consulta = location.search.replace(/^\?/, "");
  var params = new URLSearchParams(consulta);
  var OIDC = params.has("client_id");
  var tela = document.getElementById("tela");
  var S = { modo: "carregando", email: "", nome: "", erro: params.get("erro_google") || "", pedido: null, ocupado: false, google: false };
  // O pedido do aplicativo vai junto ao Google e volta (worker/google.js); o erro dele nao.
  params.delete("erro_google");
  consulta = OIDC ? (function () { var q = new URLSearchParams(params); return q.toString(); })() : "";
  var G = '<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>';
  /* "Continuar com Google" (worker/google.js): so com o Google ligado na Atos. */
  function comGoogle() {
    if (!S.google) return "";
    return '<a class="btn google" href="/oauth/google?consulta=' + encodeURIComponent(consulta) + '">' + G + "<span>Continuar com Google</span></a>" +
      '<p class="ou"><span>ou com e-mail e senha</span></p>';
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
    return '<label class="campo' + (classe ? " " + classe : "") + '"><span>' + rotulo + '</span><input name="' + nome + '" type="' + tipo + '" ' + (extra || "") + "></label>";
  }
  var REGRA = '<p class="nota">Pelo menos 10 caracteres, com letras e números.</p>';
  var ERRO = function () { return '<p class="erro" role="alert">' + esc(S.erro) + "</p>"; };
  function botao(texto) { return '<div class="botoes"><button type="submit"' + (S.ocupado ? " disabled" : "") + ">" + texto + "</button></div>"; }
  function link(acao, texto) { return '<button type="button" class="link" data-acao="' + acao + '">' + texto + "</button>"; }

  function desenhar() {
    var h = "";
    var app = nomeDoApp();
    if (S.modo === "carregando") {
      h = '<p class="sub">' + (app ? "Voltando ao " + esc(app) + "…" : "Carregando…") + "</p>";
    } else if (S.modo === "fatal") {
      h = "<h1>Não foi possível continuar</h1><p class=\"sub\">" + esc(S.erro) + '</p><p class="pequeno">Volte ao aplicativo e tente de novo. Se continuar, escreva para contato@atos.dev.br.</p>';
    } else if (S.modo === "entrar") {
      h = "<h1>" + (app ? "Entrar com a conta Atos" : "Entrar na conta Atos") + "</h1>" +
        '<p class="sub">' + (app ? "para continuar no " + esc(app) : "Com o Google ou com o seu e-mail e a sua senha.") + "</p>" +
        comGoogle() + '<form data-form="entrar">' + ERRO() +
        campo("email", "E-mail", "email", 'autocomplete="username" maxlength="200" required value="' + esc(S.email) + '"') +
        campo("senha", "Senha", "password", 'autocomplete="current-password" maxlength="200" required') +
        botao("Entrar") + '<div class="links">' + link("esqueci", "Esqueci a senha") + link("criar", "Criar conta") + "</div></form>";
    } else if (S.modo === "criar") {
      h = "<h1>Criar a conta Atos</h1>" +
        '<p class="sub">A conta é o seu próprio e-mail. Com o Google, ela já sai pronta; com senha, mandamos um código para confirmar que o e-mail é seu.</p>' +
        comGoogle() + '<form data-form="criar">' + ERRO() +
        campo("nome", "Nome", "text", 'autocomplete="name" maxlength="80" value="' + esc(S.nome) + '"') +
        campo("email", "E-mail", "email", 'autocomplete="email" maxlength="200" required value="' + esc(S.email) + '"') +
        campo("senha", "Senha", "password", 'autocomplete="new-password" maxlength="200" required') +
        campo("senha2", "Confirmar a senha", "password", 'autocomplete="new-password" maxlength="200" required') + REGRA +
        botao("Criar conta") + '<div class="links">' + link("entrar", "Já tenho conta") + "</div></form>";
    } else if (S.modo === "confirmar") {
      h = "<h1>Confirme o seu e-mail</h1>" +
        '<p class="sub">Enviamos um código de 6 dígitos para <strong>' + esc(S.email) + "</strong>. Ele vale 15 minutos.</p>" +
        '<form data-form="confirmar">' + ERRO() +
        campo("codigo", "Código", "text", 'inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required', "codigo") +
        botao("Confirmar") + '<div class="links">' + link("criar", "Voltar") + "</div></form>";
    } else if (S.modo === "esqueci") {
      h = "<h1>Trocar a senha</h1>" +
        '<p class="sub">Mandamos um código para o seu e-mail. Se você entrava no PAVLVS com o Google, assim você cria uma senha para a mesma conta.</p>' +
        '<form data-form="esqueci">' + ERRO() +
        campo("email", "E-mail", "email", 'autocomplete="email" maxlength="200" required value="' + esc(S.email) + '"') +
        botao("Enviar o código") + '<div class="links">' + link("entrar", "Voltar") + "</div></form>";
    } else if (S.modo === "redefinir") {
      h = "<h1>Trocar a senha</h1>" +
        '<p class="sub">Se <strong>' + esc(S.email) + "</strong> tem conta, chegou lá um código de 6 dígitos. Ele vale 15 minutos.</p>" +
        '<form data-form="redefinir">' + ERRO() +
        campo("codigo", "Código", "text", 'inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required', "codigo") +
        campo("senha", "Nova senha", "password", 'autocomplete="new-password" maxlength="200" required') +
        campo("senha2", "Confirmar a nova senha", "password", 'autocomplete="new-password" maxlength="200" required') + REGRA +
        botao("Trocar a senha") + '<div class="links">' + link("esqueci", "Voltar") + "</div></form>";
    } else if (S.modo === "consentir") {
      var p = S.pedido;
      h = '<div class="app"><img src="' + esc(p.app.icone) + '" alt=""><div><strong>' + esc(p.app.nome) + "</strong><small>" + esc(p.app.descricao) + "</small></div></div>" +
        "<h1>O " + esc(p.app.nome) + " quer entrar com a sua conta Atos</h1>" +
        '<div class="quem"><span>' + esc(p.conta.nome ? p.conta.nome + " · " : "") + esc(p.conta.email) + "</span>" + link("trocar", "Trocar de conta") + "</div>" +
        '<p class="aviso">Ao permitir, o ' + esc(p.app.nome) + " poderá:</p>" +
        '<ul class="permissoes">' + p.escopos.map(function (e) { return "<li>" + esc(e.texto) + "</li>"; }).join("") + "</ul>" +
        '<p class="pequeno">O ' + esc(p.app.nome) + " não recebe a sua senha. Você pode tirar essa permissão quando quiser, em atos.dev.br/conta. " +
        "Veja como o " + esc(p.app.nome) + ' trata os seus dados na <a href="' + esc(p.app.privacidade) + '" target="_blank" rel="noopener">política de privacidade</a> e nos ' +
        '<a href="' + esc(p.app.termos) + '" target="_blank" rel="noopener">termos de uso</a> dele.</p>' +
        ERRO() + '<div class="botoes"><button type="button" class="secundario" data-acao="negar"' + (S.ocupado ? " disabled" : "") + ">Cancelar</button>" +
        '<button type="button" data-acao="permitir"' + (S.ocupado ? " disabled" : "") + ">Permitir</button></div>";
    }
    tela.innerHTML = h;
    var foco = tela.querySelector("input:not([value]), input[value=''], input[name=senha], input[name=codigo]") || tela.querySelector("input");
    if (foco && !S.ocupado) foco.focus();
  }

  function ir(modo, erro) { S.modo = modo; S.erro = erro || ""; S.ocupado = false; desenhar(); }

  /* Ja dentro da conta: com aplicativo, segue o pedido; sem, vai para /conta. */
  function depoisDeEntrar() {
    if (!OIDC) { location.replace("/conta/"); return; }
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
    else if (modo === "criar") { rota = "/api/cadastrar"; corpo = { email: S.email, senha: v("senha"), nome: S.nome }; depois = function () { ir("confirmar"); }; }
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
    else ir(a);
  });

  if (OIDC) pedir();
  else api("/api/eu").then(function (d) {
    var modo = params.get("modo");
    S.google = Boolean(d.google);
    if (d.conta && !modo && !S.erro) { location.replace("/conta/"); return; }
    if (d.conta) S.email = d.conta.email;
    ir(modo === "criar" || modo === "esqueci" ? modo : "entrar", S.erro);
  });
})();
