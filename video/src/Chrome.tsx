import { interpolate, spring, useCurrentFrame, useVideoConfig, Img, staticFile } from 'remotion';
import { theme } from './theme';

/** Full-screen section title between chapters. */
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

/**
 * Lower-left block: a small chapter label stacked above the caption.
 *
 * Footage is full-bleed, so the overlay lives in one corner and stays out of
 * the page's way - and because the label and the line share a container they
 * can never collide with each other or with the app's own header.
 */
export const Caption: React.FC<{ label?: string; text: string; accent?: string }> = ({
  label,
  text,
  accent = theme.gold,
}) => {
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
        left: 40,
        bottom: 40,
        maxWidth: 1220,
        opacity: enter * exit,
        transform: `translateY(${(1 - enter) * 14}px)`,
      }}
    >
      {label ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, marginLeft: 2 }}>
          <div style={{ width: 30 * enter, height: 2, background: accent }} />
          <div
            style={{
              fontFamily: theme.mono,
              fontSize: 17,
              letterSpacing: 5,
              textTransform: 'uppercase',
              color: accent,
              textShadow: '0 2px 14px rgba(0,0,0,.95)',
            }}
          >
            {label}
          </div>
        </div>
      ) : null}
      <div
        style={{
          background: 'rgba(8,8,8,.9)',
          borderLeft: `3px solid ${accent}`,
          borderRadius: 4,
          padding: '13px 22px',
          fontFamily: theme.mono,
          fontSize: 26,
          lineHeight: 1.4,
          color: theme.text,
          boxShadow: '0 14px 44px rgba(0,0,0,.7)',
        }}
      >
        {text}
      </div>
    </div>
  );
};

/** Brand lockup used by the opening and closing cards. */
export const Brand: React.FC<{ scale?: number }> = ({ scale = 1 }) => (
  <Img src={staticFile('brand/truvian-header.png')} style={{ width: 720 * scale, display: 'block' }} />
);
