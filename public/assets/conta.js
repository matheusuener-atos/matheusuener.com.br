/* A pagina /conta: quem esta dentro, os aplicativos com acesso (tirar o
   acesso) e sair. Sem sessao, vai para /entrar. */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; });
  }
  function api(caminho, corpo) {
    var op = corpo === undefined ? { credentials: "same-origin" } :
      { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(corpo) };
    return fetch(caminho, op).then(function (r) { return r.json().catch(function () { return {}; }); }, function () { return { erro: "sem conexão com o servidor" }; });
  }
  function data(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
  }

  function apps() {
    api("/api/apps").then(function (d) {
      var l = $("c-apps");
      if (d.erro) { $("c-erro").textContent = d.erro; return; }
      if (!d.apps || !d.apps.length) { l.innerHTML = '<li class="vazio">Nenhum aplicativo tem acesso à sua conta.</li>'; return; }
      l.innerHTML = d.apps.map(function (a) {
        return '<li><img src="' + esc(a.icone) + '" alt=""><div><strong>' + esc(a.nome) + "</strong><small>" +
          esc(a.escopos.join(" · ")) + "</small><small>" + (a.quando ? "Permitido em " + data(a.quando) : "") +
          (a.ultimo ? " · último acesso em " + data(a.ultimo) : "") + "</small></div>" +
          '<div class="trilho"><button type="button" data-app="' + esc(a.id) + '">Tirar o acesso</button></div></li>';
      }).join("");
    });
  }

  $("c-apps").addEventListener("click", function (e) {
    var b = e.target.closest("[data-app]");
    if (!b) return;
    b.disabled = true;
    api("/api/apps/revogar", { app: b.getAttribute("data-app") }).then(function (d) {
      if (d.erro) { $("c-erro").textContent = d.erro; b.disabled = false; return; }
      apps();
    });
  });
  $("c-sair").addEventListener("click", function () {
    api("/api/sair", {}).then(function () { location.replace("/entrar/"); });
  });

  api("/api/eu").then(function (d) {
    if (!d.conta) { location.replace("/entrar/"); return; }
    $("c-nome").textContent = d.conta.nome || "Sua conta";
    $("c-email").textContent = d.conta.email;
    $("conta").hidden = false;
    apps();
  });
})();
