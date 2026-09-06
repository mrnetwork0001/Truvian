import { useCurrentFrame, useVideoConfig, Img, staticFile } from 'remotion';
import manifest from '../public/assets/manifest.json';
import { theme } from './theme';

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

/** Frames the shot needs at `fps` to play at true speed. */
export const shotFrames = (name: string, fps: number): number =>
  Math.round((shotByName(name).durationMs / 1000) * fps);

/**
 * Plays a captured shot back inside a browser-style window.
 *
 * The DevTools screencast emits a frame per paint, not at a fixed rate, so the
 * right image for a given moment is the last one captured at or before it -
 * a static page simply holds. The footage is fitted to the slot, so a shot
 * always fills exactly the time it is given.
 */
export const Footage: React.FC<{
  shot: string;
  /** Slow zoom, for shots that would otherwise sit still. */
  zoom?: number;
  /** Vertical pan in px across the shot, applied to the scaled image. */
  panY?: number;
  label?: string;
}> = ({ shot, zoom = 0, panY = 0, label }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const data = shotByName(shot);

  // Map this slot's progress onto the captured timeline.
  const progress = durationInFrames > 1 ? Math.min(1, frame / (durationInFrames - 1)) : 0;
  const elapsed = progress * data.durationMs;
  let index = 0;
  for (let i = 0; i < data.times.length; i++) {
    if (data.times[i]! <= elapsed) index = i;
    else break;
  }
  const src = staticFile(`assets/${shot}/${String(index).padStart(5, '0')}.jpg`);

  const scale = 1 + zoom * progress;
  const shift = panY * progress;

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: 26,
      }}
    >
      <div
        style={{
          width: 1600,
          height: 1000,
          transform: 'scale(0.9)',
          transformOrigin: 'top center',
          borderRadius: 14,
          overflow: 'hidden',
          border: `1px solid ${theme.edge}`,
          boxShadow: '0 40px 120px rgba(0,0,0,.65)',
          background: theme.bg,
          position: 'relative',
        }}
      >
        {/* browser chrome */}
        <div
          style={{
            height: 38,
            background: '#141414',
            borderBottom: `1px solid ${theme.edge}`,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '0 14px',
          }}
        >
          {['#f87171', '#f5b342', '#4ade80'].map((c) => (
            <div key={c} style={{ width: 11, height: 11, borderRadius: '50%', background: c, opacity: 0.85 }} />
          ))}
          <div
            style={{
              marginLeft: 14,
              flex: 1,
              height: 22,
              borderRadius: 6,
              background: theme.bg,
              border: `1px solid ${theme.edge}`,
              color: theme.faint,
              fontFamily: theme.mono,
              fontSize: 12,
              display: 'flex',
              alignItems: 'center',
              paddingLeft: 10,
            }}
          >
            {label ?? 'truvian.xyz'}
          </div>
        </div>
        <div style={{ position: 'absolute', top: 38, left: 0, right: 0, bottom: 0, overflow: 'hidden' }}>
          <Img
            src={src}
            style={{
              width: '100%',
              transform: `scale(${scale}) translateY(${-shift}px)`,
              transformOrigin: 'top center',
              display: 'block',
            }}
          />
        </div>
      </div>
    </div>
  );
};
