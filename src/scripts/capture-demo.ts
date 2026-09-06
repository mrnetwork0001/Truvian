/**
 * Capture the Truvian Shield demo footage.
 *
 * Drives the REAL app in a real Chrome and records frame sequences with the
 * DevTools screencast, so the video shows the product actually working
 * against live Telegraph miners - nothing is re-enacted or mocked.
 *
 *   npx tsx src/scripts/capture-demo.ts [shieldUrl]
 *
 * Writes numbered JPEGs per shot into video/assets/<shot>/ plus manifest.json
 * carrying each frame's capture time, which the Remotion composition uses to
 * play the footage back at true speed (the screencast emits frames on paint,
 * not at a fixed rate).
 *
 * Browser-side steps are passed as SOURCE STRINGS rather than functions: this
 * file runs under tsx, whose transform injects helpers that do not exist in
 * the page context.
 */
import 'dotenv/config';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';

const SHIELD = (process.argv[2] ?? 'http://127.0.0.1:8788').replace(/\/+$/, '');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ASSETS = resolve(process.cwd(), 'video/public/assets');
const WIDTH = 1920;
const HEIGHT = 1080;

interface Shot {
  name: string;
  frames: number;
  /** Milliseconds from the shot's first frame, one per frame. */
  times: number[];
  durationMs: number;
}
const shots: Shot[] = [];

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Smooth ease-in-out scroll, so the tour glides instead of jumping. */
const scrollScript = (target: number, ms: number): string => `
  new Promise((done) => {
    const start = window.scrollY;
    const distance = ${target} - start;
    const began = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - began) / ${ms});
      const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      window.scrollTo(0, start + distance * eased);
      if (t < 1) requestAnimationFrame(step); else done();
    };
    requestAnimationFrame(step);
  })`;

const scrollIntoView = (selector: string, block = 'center'): string => `
  (() => { const el = document.querySelector(${JSON.stringify(selector)});
    if (el) el.scrollIntoView({ behavior: 'smooth', block: ${JSON.stringify(block)} }); })()`;

const clickScript = (selector: string): string => `
  (() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el) el.click(); })()`;

/** Record the page for `ms` while `during` runs, one JPEG per painted frame. */
async function record(page: Page, name: string, ms: number, during?: () => Promise<void>): Promise<void> {
  const dir = `${ASSETS}/${name}`;
  await mkdir(dir, { recursive: true });
  const times: number[] = [];
  const writes: Promise<void>[] = [];
  const client = await page.createCDPSession();
  let started = 0;

  client.on('Page.screencastFrame', (event: { data: string; sessionId: number }) => {
    void client.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
    const now = Date.now();
    if (started === 0) started = now;
    const file = `${dir}/${String(times.length).padStart(5, '0')}.jpg`;
    times.push(now - started);
    writes.push(writeFile(file, Buffer.from(event.data, 'base64')));
  });

  await client.send('Page.startScreencast', { format: 'jpeg', quality: 90, everyNthFrame: 1 });
  await Promise.all([during ? during() : Promise.resolve(), wait(ms)]);
  await client.send('Page.stopScreencast');
  await Promise.all(writes);
  await client.detach();

  shots.push({ name, frames: times.length, times, durationMs: ms });
  console.log(`  ${name}: ${times.length} frames over ${ms}ms`);
}

async function main() {
  await rm(ASSETS, { recursive: true, force: true });
  await mkdir(ASSETS, { recursive: true });

  const browser: Browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    defaultViewport: { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1.5 },
    args: [`--window-size=${WIDTH},${HEIGHT}`, '--hide-scrollbars', '--force-device-scale-factor=1.5'],
  });

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(60_000);

    console.log('shot: landing hero (animated checkpoint diagram)');
    await page.goto(`${SHIELD}/`, { waitUntil: 'networkidle2' });
    await wait(1500);
    await record(page, 'hero', 8000);

    console.log('shot: landing tour');
    await record(page, 'tour', 15000, async () => {
      await page.evaluate(scrollScript(980, 3000));
      await wait(700);
      await page.evaluate(scrollScript(2100, 3000));
      await wait(700);
      await page.evaluate(scrollScript(3250, 3000));
      await wait(500);
      await page.evaluate(scrollScript(4500, 2500));
    });

    console.log('shot: recent checks feed');
    await record(page, 'feed', 4500, async () => {
      await page.evaluate(scrollIntoView('#recent'));
    });

    console.log('shot: why truvian');
    await record(page, 'why', 5000, async () => {
      await page.evaluate(scrollIntoView('#why'));
    });

    await page.goto(`${SHIELD}/app`, { waitUntil: 'networkidle2' });
    await wait(1500);

    console.log('shot: SAFE check streaming in (live miners, real payments)');
    await record(page, 'safe', 20000, async () => {
      await wait(1500);
      await page.evaluate(clickScript('[data-preset="safe"]'));
    });

    console.log('shot: SAFE evidence');
    await record(page, 'safe-evidence', 6500, async () => {
      await page.evaluate(scrollIntoView('#checks', 'start'));
    });

    console.log('shot: verify a signal hash on the Telegraph node');
    await record(page, 'verify', 8000, async () => {
      await page.evaluate(scrollIntoView('.verify-btn'));
      await wait(1800);
      await page.evaluate(clickScript('.verify-btn'));
    });

    console.log('shot: BLOCK check');
    await page.evaluate('window.scrollTo(0, 0)');
    await wait(800);
    await record(page, 'block', 20000, async () => {
      await wait(1200);
      await page.evaluate(clickScript('[data-preset="block"]'));
    });

    console.log('shot: BLOCK evidence + permalink');
    await record(page, 'block-evidence', 7000, async () => {
      await page.evaluate(scrollIntoView('#receipt-bar'));
    });

    await writeFile(`${ASSETS}/manifest.json`, JSON.stringify({ width: WIDTH, height: HEIGHT, shots }, null, 2));
    console.log(`\n${shots.length} shots, ${shots.reduce((n, s) => n + s.frames, 0)} frames total`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
