// Records the real, live Truvian site (https://truvian.xyz) and the Solana Explorer for the film.
//   ONLY=settle,memo node scripts/capture.mjs   (merges marks/meta)
// Output: .cache/frames/<clip>/ (JPEG screencast + frames.json), .cache/marks.json, .cache/meta.json,
// stills in public/stills/. scripts/encode.mjs turns frames into public/footage/<clip>.mp4.
//
// No writes: nothing is submitted and nothing is paid. The one click on a desk is an example
// button, which only fills the form. 1600x900 CSS px at device scale 2.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { launch, sleep } from "./cdp.mjs";

const BASE = process.env.BASE || "https://truvian.xyz";
const ROOT = resolve(new URL("..", import.meta.url).pathname);
const FRAMES = join(ROOT, ".cache/frames");
const STILLS = join(ROOT, "public/stills");
const SCALE = 2;
const VIEW = { w: 1600, h: 900 };
const ONLY = process.env.ONLY?.split(",") ?? ["settle", "memo", "resolve", "anchor", "miner", "home"];
const want = (clip) => ONLY.includes(clip);
mkdirSync(FRAMES, { recursive: true });
mkdirSync(STILLS, { recursive: true });
const D = JSON.parse(readFileSync(join(ROOT, "data/onchain.json"), "utf8"));

const t0 = Date.now();
const log = (...a) => console.log(`+${((Date.now() - t0) / 1000).toFixed(0)}s`, ...a);
const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {});
const marks = readJson(join(ROOT, ".cache/marks.json"));
const meta = readJson(join(ROOT, ".cache/meta.json"));
const mark = (k) => { marks[k] = Date.now() / 1000; log("mark", k); };
const save = () => {
  writeFileSync(join(ROOT, ".cache/marks.json"), JSON.stringify(marks, null, 1));
  writeFileSync(join(ROOT, ".cache/meta.json"), JSON.stringify(meta, null, 1));
};

// A visible pointer (headless Chrome draws none), a click ring and an eased scroll helper.
const OVERLAY = `(() => {
  window.__ease = (el, prop, to, ms) => new Promise((done) => {
    const from = el[prop]; const start = performance.now();
    const f = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    const step = (now) => { const p = Math.min(1, (now - start) / ms); el[prop] = from + (to - from) * f(p); if (p < 1) requestAnimationFrame(step); else done(el[prop]); };
    requestAnimationFrame(step);
  });
  if (document.getElementById('__cur')) return;
  const s = document.createElement('style');
  s.textContent = 'html{scroll-behavior:auto!important}#__cur{position:fixed;left:-40px;top:-40px;width:20px;height:20px;margin:-10px 0 0 -10px;border-radius:50%;background:rgba(255,255,255,.96);box-shadow:0 0 0 2px rgba(202,165,61,.85),0 4px 16px rgba(0,0,0,.5);z-index:2147483647;pointer-events:none;opacity:0;transition:opacity .3s ease,transform .12s ease-out,left .8s cubic-bezier(.22,1,.36,1),top .8s cubic-bezier(.22,1,.36,1)}#__cur.down{transform:scale(.7)}.__ring{position:fixed;width:48px;height:48px;margin:-24px 0 0 -24px;border-radius:50%;border:2px solid rgba(202,165,61,.95);z-index:2147483646;pointer-events:none;animation:__r .6s ease-out forwards}@keyframes __r{from{transform:scale(.3);opacity:1}to{transform:scale(1.6);opacity:0}}';
  document.head.appendChild(s);
  const c = document.createElement('div'); c.id = '__cur'; document.body.appendChild(c);
})()`;

let b;
const js = (e) => b.js(e);
async function overlay() { await js(OVERLAY); }
async function glide(x, y, settle = 900) {
  await js(`(() => { const k = document.getElementById('__cur'); if (k) { k.style.opacity = '1'; k.style.left = '${x}px'; k.style.top = '${y}px'; } })()`);
  await sleep(820);
  await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await sleep(Math.max(0, settle - 820));
}
async function cursorAt(x, y) {
  await js(`(() => { const k = document.getElementById('__cur'); if (!k) return; const t = k.style.transition; k.style.transition = 'opacity .3s ease'; k.style.left = '${x}px'; k.style.top = '${y}px'; k.offsetWidth; k.style.transition = t; k.style.opacity = '1'; })()`);
}
async function cursorHide() { await js(`(() => { const k = document.getElementById('__cur'); if (k) k.style.opacity = '0'; })()`); }
async function clickAt(x, y) {
  await js(`(() => { const k = document.getElementById('__cur'); k?.classList.add('down'); const r = document.createElement('div'); r.className = '__ring'; r.style.left = '${x}px'; r.style.top = '${y}px'; document.body.appendChild(r); setTimeout(() => { k?.classList.remove('down'); r.remove(); }, 650); })()`);
  await b.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await sleep(90);
  await b.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
}
const centerOf = (finder) => js(`(() => { const e = ${finder}; if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
const rectOf = async (finder) => { const r = await b.rectOf(finder); return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null; };
/** Absolute document y of an element's top. */
const docY = (finder) => js(`(() => { const e = ${finder}; return e ? Math.round(e.getBoundingClientRect().top + scrollY) : null; })()`);
const scrollTo = (y, ms) => js(`window.__ease(document.scrollingElement, 'scrollTop', ${y}, ${ms})`);
const parkMouse = () => b.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: VIEW.w - 4, y: VIEW.h - 4 });
/** Glide to an element and click it (real mouse events). */
async function press(finder, settle = 700) {
  const p = await centerOf(finder);
  if (!p) throw new Error("press: not found " + finder.slice(0, 90));
  await glide(p.x, p.y, 1000);
  await clickAt(p.x, p.y);
  await sleep(settle);
  return p;
}
/** Types text into the focused field, a key at a time, like a person. */
async function typeText(text, cps = 16) {
  for (const ch of text) {
    await b.send("Input.insertText", { text: ch });
    await sleep(1000 / cps + Math.random() * 30);
  }
}
const byText = (sel, text) => `[...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => e.textContent.trim().replace(/\\s+/g, ' ').startsWith(${JSON.stringify(text)}))`;
const byAria = (sel, label) => `[...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => (e.getAttribute('aria-label') || '').startsWith(${JSON.stringify(label)}))`;
const heading = (text) => byText("h1,h2,h3", text);
async function waitFor(cond, ms = 30000, what = cond) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await js(`!!(${cond})`).catch(() => false)) return true; await sleep(400); }
  throw new Error("timed out waiting for " + String(what).slice(0, 120));
}

let stopRec = null;
async function rec(name) {
  const dir = join(FRAMES, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  stopRec = await b.screencast(dir);
  if (meta[name]) meta[name].rects = {};
  mark(`${name}:start`);
}
async function endRec(name) {
  if (!stopRec) return;
  mark(`${name}:end`);
  const frames = await stopRec();
  stopRec = null;
  const span = frames.length > 1 ? frames[frames.length - 1].t - frames[0].t : 0;
  log(`${name}: ${frames.length} frames over ${span.toFixed(1)}s (${(frames.length / Math.max(span, 0.001)).toFixed(1)} fps)`);
}
function setMeta(clip, data) {
  const prev = meta[clip] || {};
  meta[clip] = { deviceScale: SCALE, viewport: VIEW, ...prev, ...data, rects: { ...(prev.rects || {}), ...(data.rects || {}) } };
}
async function still(name, finder) { await b.shot(join(STILLS, `${name}.png`), finder); log("still", name); }

/** Opens a route with the guide already marked seen, waits for it to settle, adds the pointer. */
async function open(route, { settle = 6000, guide = false } = {}) {
  if (!guide) await js(`try { localStorage.setItem('truvian-theme', 'dark') } catch {}`).catch(() => {});
  await b.goto(BASE + route, settle);
  await overlay();
  await parkMouse();
  const errs = await js(`/Application error|Something went wrong|500|This page could not be found/.test(document.title + ' ' + document.body.innerText.slice(0, 400))`);
  if (errs) log("WARN: page shows an error?", route);
}

// ---------------------------------------------------------------- clips
const CLIPS = {};
const R = async (clip, key, finder) => { const r = await rectOf(finder); setMeta(clip, { rects: { [key]: r } }); return r; };
const top = (sel) => `document.querySelector(${JSON.stringify(sel)})`;

/** The settlement desk: pick the Garantex example (it only fills the form). */
CLIPS.settle = async () => {
  await open("/preflight?desk=settlement", { settle: 5000 });
  await scrollTo(0, 10);
  await rec("settle");
  await sleep(1400);
  await R("settle", "presets", top("#fixtures"));
  await press(byText("button.preset-btn", "Sanctioned counterparty"), 300);
  mark("settle_filled");
  await sleep(800);
  await cursorHide();
  const y = await docY(top("#pf-form"));
  await scrollTo(y - 120, 1600);
  await sleep(400);
  await R("settle", "form", top("#pf-form"));
  await sleep(2600);
  await endRec("settle");
  await still("settle");
};

/** The real run of that example (memo rk43l_0A): the REJECT, the findings, the bought facts. */
CLIPS.memo = async () => {
  await open(`/preflight?m=${D.settlement.id}`, { settle: 6000 });
  await waitFor(`document.querySelector('#decision') && /REJECT/.test(document.querySelector('#decision').textContent)`, 20000);
  const y0 = await docY(top("#out"));
  await scrollTo(y0 - 40, 10);
  await sleep(500);
  await rec("memo");
  await R("memo", "decision", top("#decision"));
  await sleep(2200);
  mark("memo_findings");
  const y1 = await docY(top("#findings"));
  await scrollTo(y1 - 60, 1800);
  await sleep(300);
  await R("memo", "findings", top("#findings"));
  await sleep(2400);
  mark("memo_purchases");
  const y2 = await docY(top("#purchases"));
  await scrollTo(y2 - 60, 1800);
  await sleep(300);
  await R("memo", "purchases", top("#purchases"));
  await sleep(2600);
  await endRec("memo");
};

/** The resolution UnLKfa5v: three miners, the signed memo, the Solana anchor. */
CLIPS.resolve = async () => {
  await open(`/resolve?r=${D.resolution.id}`, { settle: 6000 });
  await waitFor(`document.querySelector('#decision') && /RESOLVED/.test(document.querySelector('#decision').textContent)`, 20000);
  const y0 = await docY(top("#out"));
  await scrollTo(y0 - 40, 10);
  await sleep(500);
  await rec("resolve");
  await R("resolve", "decision", top("#decision"));
  await sleep(1800);
  mark("resolve_answers");
  const y1 = await docY(top("#answers"));
  await scrollTo(y1 - 60, 1600);
  await sleep(300);
  await R("resolve", "answers", top("#answers"));
  await sleep(2200);
  mark("resolve_sig");
  const y2 = await docY(top("#sig"));
  await scrollTo(y2 - 200, 1600);
  await sleep(300);
  await R("resolve", "sig", top("#sig"));
  await sleep(2400);
  await endRec("resolve");
};

/** The anchor on Solana Explorer (devnet): status, slot, and the memo text. */
CLIPS.anchor = async () => {
  await b.goto(D.resolution.anchor.explorer, 9000);
  await overlay();
  await js(`(() => { for (const e of [...document.querySelectorAll('div,section,aside')]) { if (/uses cookies/i.test(e.textContent) && e.textContent.length < 400) e.remove(); } })()`);
  await parkMouse();
  await scrollTo(0, 10);
  await rec("anchor");
  await sleep(1800);
  const memoEl = `[...document.querySelectorAll('td,div,span,pre')].filter((e) => e.children.length === 0 && /Truvian Resolve sha256/.test(e.textContent)).pop()`;
  const y = await docY(memoEl);
  log("anchor memo y", y);
  if (y != null) {
    mark("anchor_memo");
    await scrollTo(y - 380, 2200);
    await sleep(300);
    await R("anchor", "memo", memoEl);
  }
  await sleep(3000);
  await endRec("anchor");
  await still("anchor");
};

/** The miner docs: registration 6194 and the Solana intents. */
CLIPS.miner = async () => {
  await open("/docs/miner", { settle: 5000 });
  await scrollTo(0, 10);
  await rec("miner");
  await sleep(1500);
  const sol = `[...document.querySelectorAll('li,p,td')].find((e) => /^Solana mainnet and devnet/.test(e.textContent.trim()))`;
  const y = await docY(sol);
  if (y != null) { mark("miner_solana"); await scrollTo(y - 300, 2000); await sleep(300); await R("miner", "solana", sol); }
  await sleep(2800);
  await endRec("miner");
};

/** The landing page hero, for the close. */
CLIPS.home = async () => {
  await open("/", { settle: 6000 });
  await rec("home");
  await sleep(6000);
  await endRec("home");
  await still("home");
};

// ---------------------------------------------------------------- run
const order = Object.keys(CLIPS).filter(want);
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
b = await launch({ width: VIEW.w, height: VIEW.h, extraArgs: [`--force-device-scale-factor=${SCALE}`, "--disable-blink-features=AutomationControlled", `--user-agent=${UA}`] });
await b.send("Network.enable");
await b.send("Network.setUserAgentOverride", { userAgent: UA, platform: "MacIntel" });
await b.send("Page.addScriptToEvaluateOnNewDocument", { source: "Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); try { localStorage.setItem('truvian-theme', 'dark') } catch {}" });
await b.send("Emulation.setDeviceMetricsOverride", { width: VIEW.w, height: VIEW.h, deviceScaleFactor: SCALE, mobile: false });
const hardStop = setTimeout(() => { log("HARD TIMEOUT"); b.close(); process.exit(2); }, 900_000);
try {
  for (const name of order) {
    log("clip", name);
    try { await CLIPS[name](); } catch (e) { log(`CLIP ${name} FAILED`, e.message); if (stopRec) await endRec(name); }
    save();
  }
} finally {
  save();
  if (b.consoleLines.length) log("console:", b.consoleLines.slice(0, 12).join("\n"));
  clearTimeout(hardStop);
  b.close();
}
