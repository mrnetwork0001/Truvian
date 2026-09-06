/**
 * Re-capture only the landing-tour shot.
 *
 * The page reveals each block as it scrolls into view, which is right for a
 * reader but wrong for a camera flying down the page: sections the scroll
 * passes quickly are still faded out when the frame is taken. Emulating
 * prefers-reduced-motion makes landing.js skip the reveal entirely, so every
 * section is fully painted while the tour scrolls.
 *
 *   npx tsx src/scripts/recapture-tour.ts [shieldUrl]
 *
 * Touches nothing but video/public/assets/tour and that shot's manifest entry.
 * No miner is queried, so this costs nothing.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const SHIELD = (process.argv[2] ?? 'http://127.0.0.1:8788').replace(/\/+$/, '');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ASSETS = resolve(process.cwd(), 'video/public/assets');
const WIDTH = 1920;
const HEIGHT = 1080;
const DURATION_MS = 15000;

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

async function main() {
  const dir = `${ASSETS}/tour`;
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    defaultViewport: { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1.5 },
    args: [`--window-size=${WIDTH},${HEIGHT}`, '--hide-scrollbars', '--force-device-scale-factor=1.5'],
  });

  try {
    const page = await browser.newPage();
    const client = await page.createCDPSession();
    await client.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });

    await page.goto(`${SHIELD}/`, { waitUntil: 'networkidle2' });
    await wait(1800);

    const times: number[] = [];
    const writes: Promise<void>[] = [];
    let started = 0;
    client.on('Page.screencastFrame', (event: { data: string; sessionId: number }) => {
      void client.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
      const now = Date.now();
      if (started === 0) started = now;
      writes.push(writeFile(`${dir}/${String(times.length).padStart(5, '0')}.jpg`, Buffer.from(event.data, 'base64')));
      times.push(now - started);
    });

    await client.send('Page.startScreencast', { format: 'jpeg', quality: 90, everyNthFrame: 1 });
    await Promise.all([
      (async () => {
        await page.evaluate(scrollScript(980, 3000));
        await wait(700);
        await page.evaluate(scrollScript(2100, 3000));
        await wait(700);
        await page.evaluate(scrollScript(3250, 3000));
        await wait(500);
        await page.evaluate(scrollScript(4500, 2500));
      })(),
      wait(DURATION_MS),
    ]);
    await client.send('Page.stopScreencast');
    await Promise.all(writes);

    const manifestPath = `${ASSETS}/manifest.json`;
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      shots: Array<{ name: string; frames: number; times: number[]; durationMs: number }>;
    };
    const shot = manifest.shots.find((s) => s.name === 'tour');
    if (!shot) throw new Error('no tour entry in the manifest');
    shot.frames = times.length;
    shot.times = times;
    shot.durationMs = DURATION_MS;
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    console.log(`tour re-captured: ${times.length} frames over ${DURATION_MS}ms (reveal disabled)`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
