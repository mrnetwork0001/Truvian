// Loads the ElevenLabs key at runtime. Never log or persist it.
// Order: process.env.ELEVENLABS_API_KEY, then /Users/mrnetwork/.config/elevenlabs/.env.
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY_FILE = "/Users/mrnetwork/.config/elevenlabs/.env";

function load() {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY.trim();
  if (existsSync(KEY_FILE)) {
    for (const line of readFileSync(KEY_FILE, "utf8").split("\n")) {
      const m = line.match(/^\s*(?:export\s+)?ELEVENLABS_API_KEY\s*=\s*(.*?)\s*$/);
      if (m) return m[1].replace(/^["']|["']$/g, "");
    }
  }
  return null;
}

export const key = load();
if (!key) {
  console.error("ELEVENLABS_API_KEY not found (env or ~/.config/elevenlabs/.env).");
  process.exit(1);
}

export const API = "https://api.elevenlabs.io/v1";

export async function retry(fn, tries = 4) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      if (/\b(401|402|403|422)\b/.test(String(e.message))) break; // not retryable
      await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
  throw last;
}

// Error text never includes the key (we only echo response bodies).
export async function post(path, body) {
  const res = await fetch(API + path, {
    method: "POST",
    headers: { "xi-api-key": key, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 300)}`);
  return res;
}
