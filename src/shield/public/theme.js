/* Truvian theme switch: dark (the default, the brand) or light (the page as paper).

   The choice lives in localStorage "truvian-theme". An inline script in each
   page's <head> sets data-theme before the stylesheets load, so a stored light
   theme never flashes dark. This file wires every .theme-toggle button (it
   adds the sun/moon icons to empty ones), keeps <meta name="theme-color"> in
   step, and fires a "themechange" event on window for the canvas background. */
(function () {
  'use strict';
  var KEY = 'truvian-theme';
  var root = document.documentElement;
  var COLOR = { dark: '#0d0c0a', light: '#f1ebde' };
  var ICONS =
    '<svg class="ic-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z"/></svg>' +
    '<svg class="ic-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/></svg>';

  function current() {
    return root.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  }

  function sync() {
    var t = current();
    var meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'theme-color';
      document.head.appendChild(meta);
    }
    meta.content = COLOR[t];
    var buttons = document.querySelectorAll('.theme-toggle');
    for (var i = 0; i < buttons.length; i++) {
      var b = buttons[i];
      if (!b.querySelector('svg')) b.insertAdjacentHTML('afterbegin', ICONS);
      b.setAttribute('aria-pressed', String(t === 'light'));
      b.setAttribute('aria-label', t === 'light' ? 'Switch to dark mode' : 'Switch to light mode');
      b.title = t === 'light' ? 'Dark mode' : 'Light mode';
    }
  }

  function set(t) {
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!reduce) {
      root.classList.add('theme-anim');
      setTimeout(function () { root.classList.remove('theme-anim'); }, 260);
    }
    if (t === 'light') root.setAttribute('data-theme', 'light');
    else root.removeAttribute('data-theme');
    try { localStorage.setItem(KEY, t); } catch (e) { /* private mode: the choice lasts this page only */ }
    sync();
    var ev;
    try { ev = new CustomEvent('themechange', { detail: { theme: t } }); } catch (e) { ev = document.createEvent('CustomEvent'); ev.initCustomEvent('themechange', false, false, { theme: t }); }
    window.dispatchEvent(ev);
  }

  document.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('.theme-toggle') : null;
    if (!b) return;
    e.preventDefault();
    set(current() === 'light' ? 'dark' : 'light');
  });

  // Another tab changed the theme
  window.addEventListener('storage', function (e) {
    if (e.key !== KEY) return;
    if ((e.newValue === 'light') !== (current() === 'light')) set(e.newValue === 'light' ? 'light' : 'dark');
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', sync);
  else sync();

  window.TruvianTheme = { get: current, set: set };
})();
