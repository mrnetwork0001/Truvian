import { interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { theme } from './theme';

export interface Line {
  text: string;
  color?: string;
  dim?: boolean;
}

/**
 * A terminal that types out REAL captured output.
 *
 * Every line here was produced by running the shipped scripts against the
 * live service; nothing is written for the camera.
 */
export const Terminal: React.FC<{ title: string; command: string; lines: Line[] }> = ({ title, command, lines }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();

  // Command types first, then lines appear one after another.
  const commandFrames = 34;
  const typed = Math.round(interpolate(frame, [4, commandFrames], [0, command.length], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  }));
  const bodyStart = commandFrames + 8;
  const perLine = Math.max(4, Math.floor((durationInFrames - bodyStart - 20) / Math.max(1, lines.length)));
  const visible = Math.max(0, Math.floor((frame - bodyStart) / perLine));
  const caretOn = Math.floor(frame / 15) % 2 === 0;

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div
        style={{
          width: 1560,
          background: '#0d0d0d',
          border: `1px solid ${theme.edge}`,
          borderRadius: 14,
          boxShadow: '0 40px 120px rgba(0,0,0,.65)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            height: 40,
            background: '#151515',
            borderBottom: `1px solid ${theme.edge}`,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '0 16px',
            fontFamily: theme.mono,
            fontSize: 14,
            color: theme.faint,
          }}
        >
          {['#f87171', '#f5b342', '#4ade80'].map((c) => (
            <div key={c} style={{ width: 11, height: 11, borderRadius: '50%', background: c, opacity: 0.85 }} />
          ))}
          <span style={{ marginLeft: 14 }}>{title}</span>
        </div>

        <div style={{ padding: '26px 30px', fontFamily: theme.mono, fontSize: 25, lineHeight: 1.55 }}>
          <div style={{ color: theme.text }}>
            <span style={{ color: theme.gold }}>$ </span>
            {command.slice(0, typed)}
            {typed < command.length && caretOn ? <span style={{ color: theme.gold }}>▋</span> : null}
          </div>
          {lines.slice(0, visible).map((line, i) => (
            <div
              key={i}
              style={{
                color: line.color ?? (line.dim ? theme.muted : theme.text),
                whiteSpace: 'pre',
                marginTop: i === 0 ? 14 : 2,
              }}
            >
              {line.text}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
