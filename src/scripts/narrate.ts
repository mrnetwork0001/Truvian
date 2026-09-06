/**
 * Generate the demo narration with ElevenLabs.
 *
 * Credit-safe by construction:
 *   - refuses to run unless the whole script fits inside the remaining quota
 *     with a margin to spare;
 *   - skips any section whose MP3 already exists, so re-running (or re-rendering
 *     the video) never spends again;
 *   - one take per section, no retries that would double-charge.
 *
 *   npx tsx src/scripts/narrate.ts          # generate what is missing
 *   npx tsx src/scripts/narrate.ts --dry    # quota + cost report only
 *
 * The API key is read from the Syntura env file, never logged.
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const ENV_FILE = '/Users/mrnetwork/Syntura/video/.env';
const OUT_DIR = resolve(process.cwd(), 'video/public/narration');
const SCRIPT_FILE = resolve(process.cwd(), 'video/narration/script.json');
/** Never spend the quota below this many characters. */
const RESERVE = 400;

interface Section {
  id: string;
  text: string;
}

function readEnv(file: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const [key, ...rest] = line.split('=');
    env[key!.trim()] = rest.join('=').trim().replace(/^["']|["']$/g, '');
  }
  return env;
}

async function main() {
  const dry = process.argv.includes('--dry');
  const env = readEnv(ENV_FILE);
  const apiKey = env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error(`no ELEVENLABS_API_KEY in ${ENV_FILE}`);

  const script = JSON.parse(readFileSync(SCRIPT_FILE, 'utf8')) as {
    voice: string;
    model: string;
    sections: Section[];
  };
  await mkdir(OUT_DIR, { recursive: true });

  const pending = script.sections.filter((s) => !existsSync(`${OUT_DIR}/${s.id}.mp3`));
  const cost = pending.reduce((n, s) => n + s.text.length, 0);

  const subRes = await fetch('https://api.elevenlabs.io/v1/user/subscription', { headers: { 'xi-api-key': apiKey } });
  if (!subRes.ok) throw new Error(`subscription check failed: ${subRes.status}`);
  const sub = (await subRes.json()) as { character_count: number; character_limit: number; tier: string };
  const remaining = sub.character_limit - sub.character_count;

  console.log(`tier ${sub.tier}: ${remaining} characters remaining`);
  console.log(`${script.sections.length - pending.length} of ${script.sections.length} sections already generated (cached, free)`);
  console.log(`${pending.length} to generate, costing ${cost} characters -> ${remaining - cost} would remain`);

  if (pending.length === 0) {
    console.log('nothing to do.');
    return;
  }
  if (cost > remaining - RESERVE) {
    throw new Error(`refusing to run: ${cost} characters needed but only ${remaining} remain (keeping ${RESERVE} in reserve)`);
  }
  if (dry) {
    console.log('\n--dry: nothing generated.');
    return;
  }

  for (const section of pending) {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${script.voice}`, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({
        text: section.text,
        model_id: script.model,
        voice_settings: { stability: 0.45, similarity_boost: 0.75, style: 0.1, use_speaker_boost: true },
      }),
    });
    if (!res.ok) {
      // Stop at the first failure rather than burning quota on the rest.
      throw new Error(`${section.id}: ElevenLabs replied ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    const audio = Buffer.from(await res.arrayBuffer());
    await writeFile(`${OUT_DIR}/${section.id}.mp3`, audio);
    console.log(`  ${section.id.padEnd(14)} ${String(section.text.length).padStart(4)} chars -> ${(audio.length / 1024).toFixed(0)} KB`);
  }

  const after = await (await fetch('https://api.elevenlabs.io/v1/user/subscription', { headers: { 'xi-api-key': apiKey } })).json() as {
    character_count: number;
    character_limit: number;
  };
  console.log(`\ndone. ${after.character_limit - after.character_count} characters remaining.`);
}

main().catch((err) => {
  console.error('FAILED', err instanceof Error ? err.message : err);
  process.exit(1);
});
