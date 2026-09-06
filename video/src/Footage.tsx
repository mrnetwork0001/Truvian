import { useCurrentFrame, useVideoConfig, Img, staticFile } from 'remotion';
import manifest from '../public/assets/manifest.json';

interface Shot {
  name: string;
  frames: number;
  times: number[];
  durationMs: number;
}
const SHOTS = manifest.shots as Shot[];

export const shotByName = (name: string): Shot => {
  const shot = SHOTS.find((s) => s.name === name);
  if (!shot) throw new Error(`no captured shot named "${name}"`);
  return shot;
};

/**
 * Plays a captured shot full-bleed, edge to edge.
 *
 * The footage is recorded at the composition's own 16:9 size, so it fills the
 * frame with no letterboxing and no browser mockup - what you see is the whole
 * screen of the running app.
 *
 * The DevTools screencast emits a frame per paint rather than at a fixed rate,
 * so the right image for a moment is the last one captured at or before it: a
 * still page simply holds. Playback is fitted to the slot, so a shot always
 * fills exactly the time it is given.
 */
export const Footage: React.FC<{
  shot: string;
  /** Slow push-in, to keep otherwise-static shots alive. */
  zoom?: number;
}> = ({ shot, zoom = 0 }) => {
  const frame = useCurrentFrame();
  const { durationInFrames, fps } = useVideoConfig();
  const data = shotByName(shot);

  const progress = durationInFrames > 1 ? Math.min(1, frame / (durationInFrames - 1)) : 0;
  // A shot shorter than its slot plays at true speed and then holds its last
  // frame - stretching it instead would turn real motion into a crawl. A shot
  // longer than its slot is compressed to fit.
  const slotMs = (durationInFrames / fps) * 1000;
  const elapsed =
    data.durationMs <= slotMs ? Math.min((frame / fps) * 1000, data.durationMs) : progress * data.durationMs;
  let index = 0;
  for (let i = 0; i < data.times.length; i++) {
    if (data.times[i]! <= elapsed) index = i;
    else break;
  }
  const src = staticFile(`assets/${shot}/${String(index).padStart(5, '0')}.jpg`);
  const scale = 1 + zoom * progress;

  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
      <Img
        src={src}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          transform: `scale(${scale})`,
          transformOrigin: 'center center',
          display: 'block',
        }}
      />
    </div>
  );
};
