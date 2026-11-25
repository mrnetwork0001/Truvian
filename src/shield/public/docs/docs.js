/* Truvian docs: the phone drawer. At 900px and below the sidebar is a left
   drawer: the burger opens it; the backdrop, Esc, Close, any link in it, or
   growing the window past 900px close it. Focus moves into the drawer and back
   to the burger; the page behind does not scroll while it is open. */
(function () {
  'use strict';
  var burger = document.getElementById('dburger');
  var nav = document.getElementById('dnav');
  var backdrop = document.getElementById('dbackdrop');
  var closeBtn = document.getElementById('dclose');
  if (!burger || !nav) return;
  var phone = window.matchMedia('(max-width: 900px)');

  function isOpen() { return document.body.classList.contains('menu-open'); }
  function open() {
    document.body.classList.add('menu-open');
    burger.setAttribute('aria-expanded', 'true');
    burger.setAttribute('aria-label', 'Close the docs menu');
    var current = nav.querySelector('a[aria-current="page"]') || nav.querySelector('a');
    if (current) current.focus({ preventScroll: true });
  }
  function close(returnFocus) {
    if (!isOpen()) return;
    document.body.classList.remove('menu-open');
    burger.setAttribute('aria-expanded', 'false');
    burger.setAttribute('aria-label', 'Open the docs menu');
    if (returnFocus) burger.focus({ preventScroll: true });
  }
  burger.addEventListener('click', function () { if (isOpen()) close(true); else open(); });
  if (backdrop) backdrop.addEventListener('click', function () { close(true); });
  if (closeBtn) closeBtn.addEventListener('click', function () { close(true); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(true); });
  Array.prototype.forEach.call(nav.querySelectorAll('a'), function (a) { a.addEventListener('click', function () { close(false); }); });
  var onChange = function () { if (!phone.matches) close(false); };
  if (phone.addEventListener) phone.addEventListener('change', onChange); else if (phone.addListener) phone.addListener(onChange);
})();
