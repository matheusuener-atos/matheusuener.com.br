(function () {
  'use strict';

  var root = document.documentElement;

  /* ---------- Tema claro/escuro ---------- */
  var themeBtn = document.getElementById('theme-toggle');
  var darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

  function currentTheme() {
    var forced = root.getAttribute('data-theme');
    if (forced === 'light' || forced === 'dark') return forced;
    return darkQuery.matches ? 'dark' : 'light';
  }

  function syncThemeColor() {
    var color = currentTheme() === 'dark' ? '#131312' : '#faf9f6';
    document.querySelectorAll('meta[name="theme-color"]').forEach(function (m) {
      m.setAttribute('content', color);
    });
    themeBtn.setAttribute('aria-label', currentTheme() === 'dark' ? 'Usar tema claro' : 'Usar tema escuro');
  }

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  var fadeTimer;

  function applyTheme(next) {
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('atos-tema', next); } catch (e) {}
    syncThemeColor();
  }

  themeBtn.addEventListener('click', function () {
    var next = currentTheme() === 'dark' ? 'light' : 'dark';

    if (reduceMotion.matches) return applyTheme(next);

    // Crossfade da página inteira onde houver View Transitions;
    // nos outros navegadores, as cores deslizam por transição de CSS.
    if (document.startViewTransition) {
      document.startViewTransition(function () { applyTheme(next); });
      return;
    }
    root.classList.add('theme-fading');
    applyTheme(next);
    clearTimeout(fadeTimer);
    fadeTimer = setTimeout(function () { root.classList.remove('theme-fading'); }, 400);
  });

  if (darkQuery.addEventListener) darkQuery.addEventListener('change', syncThemeColor);
  syncThemeColor();

  /* ---------- Menu no celular ---------- */
  var menuBtn = document.getElementById('menu-toggle');
  var nav = document.getElementById('nav');

  function setMenu(open) {
    nav.classList.toggle('is-open', open);
    menuBtn.setAttribute('aria-expanded', String(open));
    menuBtn.setAttribute('aria-label', open ? 'Fechar menu' : 'Abrir menu');
  }

  menuBtn.addEventListener('click', function () {
    setMenu(!nav.classList.contains('is-open'));
  });

  nav.addEventListener('click', function (e) {
    if (e.target.closest('a')) setMenu(false);
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && nav.classList.contains('is-open')) {
      setMenu(false);
      menuBtn.focus();
    }
  });

  document.addEventListener('click', function (e) {
    if (nav.classList.contains('is-open') && !e.target.closest('.topbar')) setMenu(false);
  });

  window.matchMedia('(min-width: 821px)').addEventListener('change', function (e) {
    if (e.matches) setMenu(false);
  });

  /* ---------- Foto: monograma se o arquivo faltar ---------- */
  var photo = document.querySelector('.photo');
  var img = photo && photo.querySelector('img');
  if (img) {
    var markMissing = function () { photo.classList.add('is-missing'); };
    var markLoaded = function () { photo.classList.add('is-loaded'); };
    if (img.complete) {
      if (img.naturalWidth === 0) markMissing();
      else requestAnimationFrame(markLoaded);
    } else {
      img.addEventListener('load', markLoaded);
      img.addEventListener('error', markMissing);
    }
  }
})();
