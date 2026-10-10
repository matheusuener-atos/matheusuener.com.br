/* A home (v6): a abertura em cena, guiada pela rolagem (o Pentecostes ocupa a
   tela com a coroa e Atos 5:12, depois encolhe ate virar moldura e a abertura
   aparece, com o h1 sendo digitado), a faixa de Projetos que corre sozinha e
   as entradas do Indice e do Fundador. Quem pede menos movimento ve tudo ja
   no estado final, sem a faixa correr. */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var parado = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var clamp = function (x) { return Math.min(1, Math.max(0, x)); };
  var suave = function (t) { return t * t * (3 - 2 * t); };
  var lerp = function (a, b, t) { return a + (b - a) * t; };
  var px = function (n) { return n.toFixed(1) + "px"; };

  // ------------------------------------------------------------ a cena
  var cena = $("cena"), quadro = $("cena-quadro"), tela = $("cena-tela"), vinheta = $("cena-vinheta"), moldura = $("cena-moldura");
  var legenda = $("cena-legenda"), titulo = $("cena-titulo"), dica = $("cena-dica"), texto = $("cena-texto");
  var R = 1.729;
  if (parado) cena.style.height = "100vh";

  function desenharCena() {
    var W = window.innerWidth, H = window.innerHeight;
    var p = 1;
    if (!parado) { var r = cena.getBoundingClientRect(); p = clamp(-r.top / Math.max(1, r.height - H)); }
    var seg = function (a, b) { return suave(clamp((p - a) / (b - a))); };
    var largo = W >= 860;
    var cw = Math.min(960, W - 56), esq = (W - cw) / 2;
    var iw, ih, ix, iy, tx, ty, tw;
    if (largo) {
      iw = cw * 0.44; ih = iw / R; ix = esq + cw - iw; iy = Math.max(84, (H - ih) / 2 + 8);
      tw = cw * 0.5; tx = esq; ty = Math.max(84, H / 2 - 150);
    } else {
      iw = cw; ih = iw / R; ix = esq; iy = Math.max(H - ih - 56, 340);
      tw = cw; tx = esq; ty = 84;
    }
    var sw = Math.max(W, H * R) * 1.06, sh = sw / R;
    var t = seg(0.12, 0.72);
    var esc = lerp(sw / iw, 1, t);
    var dx = lerp((W - sw) / 2 - ix, 0, t), dy = lerp((H - sh) / 2 - iy, 0, t);
    quadro.style.left = px(ix); quadro.style.top = px(iy); quadro.style.width = px(iw); quadro.style.height = px(ih);
    quadro.style.transform = "translate(" + px(dx) + "," + px(dy) + ") scale(" + esc.toFixed(4) + ")";
    tela.style.filter = "brightness(" + lerp(0.32, 1, seg(0.2, 0.78)).toFixed(3) + ")";
    vinheta.style.opacity = (1 - seg(0.25, 0.7)).toFixed(3);
    moldura.style.opacity = seg(0.6, 0.78).toFixed(3);
    legenda.style.left = px(ix); legenda.style.top = px(iy + ih + 12); legenda.style.width = px(iw);
    legenda.style.opacity = seg(0.72, 0.86).toFixed(3);
    titulo.style.opacity = (1 - seg(0.1, 0.3)).toFixed(3);
    titulo.style.transform = "translateY(" + px(lerp(0, -24, clamp(p / 0.3))) + ")";
    dica.style.opacity = (1 - seg(0, 0.06)).toFixed(3);
    texto.style.left = px(tx); texto.style.top = px(ty); texto.style.width = px(tw);
    texto.style.opacity = seg(0.55, 0.78).toFixed(3);
    texto.style.transform = "translateY(" + px(lerp(12, 0, seg(0.55, 0.8))) + ")";
    texto.style.pointerEvents = p > 0.6 ? "auto" : "none";
    texto.setAttribute("aria-hidden", p > 0.6 ? "false" : "true");
    document.body.classList.toggle("cena-ativa", p <= 0.75);
    if (p > 0.6) digitar();
  }

  // o h1 digitado, uma vez
  var FRASE = $("h1-resto").textContent, n = 0, comecou = false;
  function digitar() {
    if (comecou) return;
    comecou = true;
    if (parado) { $("h1-digitado").textContent = FRASE; $("h1-resto").textContent = ""; $("h1-cursor").hidden = true; return; }
    (function passo() {
      n++;
      $("h1-digitado").textContent = FRASE.slice(0, n);
      $("h1-resto").textContent = FRASE.slice(n);
      if (n >= FRASE.length) { $("h1-cursor").hidden = true; return; }
      var c = FRASE[n - 1];
      setTimeout(passo, c === "," || c === "." ? 260 : c === " " ? 45 : 22 + Math.random() * 30);
    })();
  }

  var pedido = 0;
  function aoRolar() { cancelAnimationFrame(pedido); pedido = requestAnimationFrame(desenharCena); }
  window.addEventListener("scroll", aoRolar, { passive: true });
  window.addEventListener("resize", aoRolar);
  desenharCena();

  // Quem chega no alto e nao mexe: a cena anda sozinha ate a abertura (qualquer gesto para).
  if (!parado && window.scrollY < 10 && !location.hash) {
    var parou = false, quadroAuto = 0;
    var parar = function () { parou = true; cancelAnimationFrame(quadroAuto); };
    ["wheel", "touchstart", "keydown", "mousedown"].forEach(function (ev) { window.addEventListener(ev, parar, { once: true, passive: true }); });
    setTimeout(function () {
      if (parou) return;
      var H = window.innerHeight;
      var alvo = cena.offsetTop + (cena.offsetHeight - H) * 0.88;
      var de = window.scrollY, dist = alvo - de, dur = 3200, t0 = performance.now();
      var io = function (t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };
      (function passo(agora) {
        if (parou) return;
        var k = Math.min(1, (agora - t0) / dur);
        window.scrollTo(0, de + dist * io(k));
        if (k < 1) quadroAuto = requestAnimationFrame(passo);
      })(t0);
    }, 1400);
  }

  // ------------------------------------------------------------ a faixa de Projetos
  var faixa = $("faixa"), trilho = $("faixa-trilho");
  var originais = Array.prototype.slice.call(trilho.children);
  function montarFaixa() {
    var W = window.innerWidth;
    var cw = Math.round(Math.min(280, Math.max(220, (W - 56) * 0.33)));
    var cabem = Math.max(originais.length, Math.ceil((W - 56 + 12) / (cw + 12)));
    trilho.innerHTML = "";
    var volta = [];
    originais.forEach(function (a) { volta.push(a); });
    for (var i = originais.length; i < cabem; i++) { var v = document.createElement("div"); v.className = "projeto vazio-faixa"; v.setAttribute("aria-hidden", "true"); volta.push(v); }
    volta.forEach(function (el) { el.style.width = cw + "px"; trilho.appendChild(el); });
    if (parado) return;
    // a segunda volta, para correr sem emenda: so enfeite, fora do leitor de tela e do Tab
    volta.forEach(function (el) {
      var c = el.cloneNode(true);
      c.setAttribute("aria-hidden", "true");
      c.querySelectorAll("a").forEach(function (a) { a.tabIndex = -1; });
      trilho.appendChild(c);
    });
  }
  montarFaixa();
  var larguraAntes = window.innerWidth;
  window.addEventListener("resize", function () { if (window.innerWidth !== larguraAntes) { larguraAntes = window.innerWidth; montarFaixa(); } });
  if (!parado) {
    var desloc = 0, ultimo = performance.now(), pausa = false;
    faixa.addEventListener("mouseenter", function () { pausa = true; });
    faixa.addEventListener("mouseleave", function () { pausa = false; });
    faixa.addEventListener("focusin", function () { pausa = true; });
    faixa.addEventListener("focusout", function () { pausa = false; });
    (function correr(t) {
      var dt = Math.min(64, t - ultimo); ultimo = t;
      if (!pausa) desloc += dt * 0.04;
      var meia = trilho.scrollWidth / 2 + 6;
      if (desloc >= meia) desloc -= meia;
      trilho.style.transform = "translate3d(" + (-desloc).toFixed(2) + "px,0,0)";
      requestAnimationFrame(correr);
    })(ultimo);
  }

  // ------------------------------------------------------------ as entradas
  // Na conta da rolagem (e nao num observador): se algo falhar, aparece de qualquer jeito.
  var revelar = Array.prototype.slice.call(document.querySelectorAll(".revela"));
  function entrar() {
    var H = window.innerHeight;
    revelar = revelar.filter(function (el) {
      if (!parado && el.getBoundingClientRect().top > H * 0.88) return true;
      var i = Array.prototype.indexOf.call(el.parentNode.children, el);
      el.style.transitionDelay = parado ? "0s" : (i * 0.1).toFixed(2) + "s";
      el.classList.add("visto");
      return false;
    });
  }
  window.addEventListener("scroll", entrar, { passive: true });
  window.addEventListener("resize", entrar);
  entrar();

  // Chegou com #projetos (ou outro) no endereco: vai la depois de a cena ter altura, e redesenha.
  if (location.hash.length > 1) {
    var alvo = document.getElementById(location.hash.slice(1));
    if (alvo) requestAnimationFrame(function () { alvo.scrollIntoView(); desenharCena(); entrar(); });
  }
})();
