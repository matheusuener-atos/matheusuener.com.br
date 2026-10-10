/* O ultimo item do topo: "Entrar" para quem esta fora, "Minha conta" para quem
   ja entrou (GET /api/eu). Sem resposta, fica "Entrar". */
(function () {
  "use strict";
  var a = document.querySelector("[data-conta]");
  if (!a) return;
  fetch("/api/eu", { credentials: "same-origin" }).then(function (r) { return r.json(); }).then(function (d) {
    if (d && d.conta) { a.textContent = "Minha conta"; a.href = "/conta/"; }
  }, function () {});
})();
