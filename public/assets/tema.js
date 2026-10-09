// O tema escolhido na pagina da Atos, aplicado antes da pintura (sem piscar).
// Arquivo, e nao script na pagina, porque a CSP so deixa rodar os do proprio site.
document.documentElement.classList.add("js");
try {
  var t = localStorage.getItem("atos-tema");
  if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
} catch (e) {}
