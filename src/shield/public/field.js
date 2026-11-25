/* Truvian landing background: "the evidence field".

   A faint drafting grid. Gold pulses travel along its lines, turning only at
   right angles, like routed asks crossing the network. When one lands, a
   receipt ring opens and a short ledger mark types itself in (a hash, a
   price, a verdict) and fades. Grid points near the pointer brighten.

   One fixed canvas behind the page, drawn at most ~40 fps, paused when the
   tab is hidden, static (grid only) under prefers-reduced-motion. No
   libraries. Purely decorative: aria-hidden, no pointer events. */
(function () {
  'use strict';
  if (!window.HTMLCanvasElement) return;

  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  canvas.className = 'evidence-field';
  var css = document.createElement('style');
  css.textContent = '.evidence-field{position:fixed;inset:0;width:100%;height:100%;z-index:0;pointer-events:none}' +
    'body>main,body>footer,body>.site-foot{position:relative;z-index:1}';
  document.head.appendChild(css);
  document.body.insertBefore(canvas, document.body.firstChild);
  var ctx = canvas.getContext('2d');

  // Colours per theme (theme.js sets data-theme="light" on <html> and fires "themechange")
  var PALETTES = {
    dark: { gold: '202,165,61', bone: '236,229,214', ok: '127,174,115', rev: '217,164,65', rej: '208,100,90', glow: 0.07, line: 0.035, dot: 0.16, mark: 0.5 },
    light: { gold: '127,96,15', bone: '28,26,22', ok: '47,95,43', rev: '122,79,0', rej: '139,34,25', glow: 0.10, line: 0.05, dot: 0.2, mark: 0.62 },
  };
  var P = PALETTES.dark;
  function readTheme() {
    P = document.documentElement.getAttribute('data-theme') === 'light' ? PALETTES.light : PALETTES.dark;
  }
  readTheme();
  var MARKS = [
    ['0x3f9a…c21e', 'gold'], ['0xd9e3…32f9', 'gold'], ['sha256 6b04…ecbb', 'gold'], ['$0.01', 'bone'], ['$0.01 · receipt', 'bone'],
    ['RELEASE', 'ok'], ['VERIFIED', 'ok'], ['HOLD', 'ok'], ['REVIEW', 'rev'], ['REJECT', 'rej'], ['RESOLVED', 'ok'], ['rank 1', 'bone'], ['slot 526130868', 'bone'],
  ];

  var W = 0, H = 0, DPR = 1, STEP = 64, cols = 0, rows = 0;
  var pulses = [], rings = [], marks = [];
  var mouse = { x: -9999, y: -9999 };
  var last = 0, spawnAt = 0, running = true;

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    STEP = W < 700 ? 48 : 64;
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    cols = Math.ceil(W / STEP) + 1;
    rows = Math.ceil(H / STEP) + 1;
    if (reduce) draw(0);
  }

  function rnd(n) { return Math.floor(Math.random() * n); }

  // A route: from a grid point, a few straight legs at right angles.
  function spawn() {
    var x = rnd(cols), y = rnd(rows);
    var pts = [[x, y]];
    var legs = 2 + rnd(3);
    var horizontal = Math.random() < 0.5;
    for (var i = 0; i < legs; i++) {
      var len = 2 + rnd(5);
      var dir = Math.random() < 0.5 ? -1 : 1;
      if (horizontal) x = Math.max(0, Math.min(cols - 1, x + dir * len));
      else y = Math.max(0, Math.min(rows - 1, y + dir * len));
      pts.push([x, y]);
      horizontal = !horizontal;
    }
    var total = 0;
    for (var j = 1; j < pts.length; j++) total += Math.abs(pts[j][0] - pts[j - 1][0]) + Math.abs(pts[j][1] - pts[j - 1][1]);
    if (total < 3) return;
    pulses.push({ pts: pts, total: total, t: 0, speed: 2.2 + Math.random() * 2.2 });
  }

  // Position along the route after `d` grid units.
  function at(p, d) {
    for (var j = 1; j < p.pts.length; j++) {
      var a = p.pts[j - 1], b = p.pts[j];
      var seg = Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]);
      if (d <= seg) {
        var f = seg === 0 ? 0 : d / seg;
        return [(a[0] + (b[0] - a[0]) * f) * STEP, (a[1] + (b[1] - a[1]) * f) * STEP];
      }
      d -= seg;
    }
    var e = p.pts[p.pts.length - 1];
    return [e[0] * STEP, e[1] * STEP];
  }

  function drawGrid(now) {
    // a slow gold glow drifting across the page, like light on a desk
    var gx = W * (0.5 + 0.38 * Math.sin(now / 9000)), gy = H * (0.45 + 0.3 * Math.cos(now / 11000));
    var glow = ctx.createRadialGradient(gx, gy, 0, gx, gy, Math.max(W, H) * 0.55);
    glow.addColorStop(0, 'rgba(' + P.gold + ',' + P.glow + ')');
    glow.addColorStop(1, 'rgba(' + P.gold + ',0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);
    // hairline grid
    ctx.strokeStyle = 'rgba(' + P.bone + ',' + P.line + ')';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var gi = 0; gi < cols; gi++) { ctx.moveTo(gi * STEP + 0.5, 0); ctx.lineTo(gi * STEP + 0.5, H); }
    for (var gj = 0; gj < rows; gj++) { ctx.moveTo(0, gj * STEP + 0.5); ctx.lineTo(W, gj * STEP + 0.5); }
    ctx.stroke();
    // grid points, brighter near the pointer
    for (var i = 0; i < cols; i++) {
      for (var j = 0; j < rows; j++) {
        var px = i * STEP, py = j * STEP;
        var dx = px - mouse.x, dy = py - mouse.y;
        var near = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) / 220);
        var a = 0.16 + near * 0.5;
        ctx.fillStyle = near > 0.05 ? 'rgba(' + P.gold + ',' + a + ')' : 'rgba(' + P.bone + ',' + P.dot + ')';
        ctx.fillRect(px - 0.75, py - 0.75, 1.5 + near * 1.2, 1.5 + near * 1.2);
      }
    }
  }

  function draw(dt, now) {
    ctx.clearRect(0, 0, W, H);
    drawGrid(now || 0);
    if (reduce) return;

    // pulses with a fading trail along the route
    for (var k = pulses.length - 1; k >= 0; k--) {
      var p = pulses[k];
      p.t += p.speed * dt;
      // the whole route, faintly, so the network shows
      ctx.strokeStyle = 'rgba(' + P.gold + ',0.12)';
      ctx.setLineDash([2, 5]);
      ctx.beginPath();
      ctx.moveTo(p.pts[0][0] * STEP, p.pts[0][1] * STEP);
      for (var v = 1; v < p.pts.length; v++) ctx.lineTo(p.pts[v][0] * STEP, p.pts[v][1] * STEP);
      ctx.stroke();
      ctx.setLineDash([]);
      var head = Math.min(p.t, p.total);
      var tail = Math.max(0, head - 3.2);
      var N = 18;
      for (var s = 0; s <= N; s++) {
        var d = tail + (head - tail) * (s / N);
        var q = at(p, d);
        var alpha = (s / N) * 0.55;
        ctx.fillStyle = 'rgba(' + P.gold + ',' + alpha + ')';
        ctx.fillRect(q[0] - 0.9, q[1] - 0.9, 1.8, 1.8);
      }
      var hd = at(p, head);
      ctx.beginPath();
      ctx.fillStyle = 'rgba(' + P.gold + ',0.95)';
      ctx.arc(hd[0], hd[1], 2.1, 0, Math.PI * 2);
      ctx.fill();
      if (p.t >= p.total) {
        rings.push({ x: hd[0], y: hd[1], r: 2, life: 1 });
        if (Math.random() < 0.55) {
          var m = MARKS[rnd(MARKS.length)];
          marks.push({ x: hd[0] + 8, y: hd[1] - 8, text: m[0], rgb: m[1], shown: 0, life: 1 });
        }
        pulses.splice(k, 1);
      }
    }

    // receipt rings
    for (var r = rings.length - 1; r >= 0; r--) {
      var g = rings[r];
      g.r += 34 * dt;
      g.life -= 0.9 * dt;
      if (g.life <= 0) { rings.splice(r, 1); continue; }
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(' + P.gold + ',' + (g.life * 0.45) + ')';
      ctx.lineWidth = 1;
      ctx.arc(g.x, g.y, g.r, 0, Math.PI * 2);
      ctx.stroke();
    }

    // ledger marks type in, hold, fade
    ctx.font = '500 10px "JetBrains Mono", ui-monospace, Menlo, monospace';
    ctx.textBaseline = 'bottom';
    for (var mI = marks.length - 1; mI >= 0; mI--) {
      var mk = marks[mI];
      mk.shown = Math.min(mk.text.length, mk.shown + 28 * dt);
      if (mk.shown >= mk.text.length) mk.life -= 0.35 * dt;
      if (mk.life <= 0) { marks.splice(mI, 1); continue; }
      ctx.fillStyle = 'rgba(' + (P[mk.rgb] || P.gold) + ',' + (Math.min(1, mk.life) * P.mark) + ')';
      ctx.fillText(mk.text.slice(0, Math.floor(mk.shown)), mk.x, mk.y);
    }
  }

  function frame(now) {
    if (!running) return;
    var dt = Math.min(0.05, (now - last) / 1000 || 0);
    if (now - last >= 24) {
      last = now;
      var cap = W < 700 ? 7 : 16;
      if (now > spawnAt && pulses.length < cap) {
        spawn();
        spawnAt = now + 180 + Math.random() * 380;
      }
      draw(dt, now);
    }
    requestAnimationFrame(frame);
  }

  window.addEventListener('resize', resize);
  window.addEventListener('pointermove', function (e) { mouse.x = e.clientX; mouse.y = e.clientY; }, { passive: true });
  window.addEventListener('pointerleave', function () { mouse.x = mouse.y = -9999; });
  window.addEventListener('themechange', function () { readTheme(); if (reduce || !running) draw(0, performance.now()); });
  document.addEventListener('visibilitychange', function () {
    running = !document.hidden && !reduce;
    if (running) { last = performance.now(); requestAnimationFrame(frame); }
  });
  resize();
  if (!reduce) {
    for (var i = 0; i < 5; i++) spawn();
    requestAnimationFrame(function (t) { last = t; frame(t); });
  } else {
    draw(0);
  }
})();
