import { interpolate, spring, useCurrentFrame, useVideoConfig, Img, staticFile } from 'remotion';
import { theme } from './theme';

/** Section title card between chapters. */
export const TitleCard: React.FC<{ eyebrow: string; title: string }> = ({ eyebrow, title }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 200 }, durationInFrames: 20 });
  const exit = interpolate(frame, [durationInFrames - 12, durationInFrames], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        opacity: enter * exit,
      }}
    >
      <div
        style={{
          fontFamily: theme.mono,
          fontSize: 22,
          letterSpacing: 8,
          textTransform: 'uppercase',
          color: theme.gold,
          marginBottom: 26,
        }}
      >
        {eyebrow}
      </div>
      <div
        style={{
          fontFamily: theme.mono,
          fontSize: 72,
          fontWeight: 700,
          color: theme.text,
          textAlign: 'center',
          maxWidth: 1500,
          lineHeight: 1.2,
          transform: `translateY(${(1 - enter) * 20}px)`,
        }}
      >
        {title}
      </div>
    </div>
  );
};

/** Caption strip pinned to the bottom while footage plays. */
export const Caption: React.FC<{ text: string; accent?: string }> = ({ text, accent = theme.gold }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 200 }, durationInFrames: 16 });
  const exit = interpolate(frame, [durationInFrames - 12, durationInFrames], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 40,
        display: 'flex',
        justifyContent: 'center',
        opacity: enter * exit,
        transform: `translateY(${(1 - enter) * 16}px)`,
      }}
    >
      <div
        style={{
          background: 'rgba(10,10,10,.92)',
          border: `1px solid ${theme.edge}`,
          borderLeft: `4px solid ${accent}`,
          borderRadius: 10,
          padding: '14px 26px',
          fontFamily: theme.mono,
          fontSize: 27,
          color: theme.text,
          maxWidth: 1500,
          boxShadow: '0 18px 50px rgba(0,0,0,.6)',
        }}
      >
        {text}
      </div>
    </div>
  );
};

/** Brand lockup used by the opening and closing cards. */
export const Brand: React.FC<{ scale?: number }> = ({ scale = 1 }) => (
  <Img
    src={staticFile('brand/truvian-header.png')}
    style={{ width: 720 * scale, display: 'block' }}
  />
);
