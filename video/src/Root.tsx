import { Composition } from 'remotion';
import { Demo, DEMO_DURATION_IN_FRAMES, FPS } from './Demo';

export const RemotionRoot: React.FC = () => (
  <Composition
    id="TruvianDemo"
    component={Demo}
    durationInFrames={DEMO_DURATION_IN_FRAMES}
    fps={FPS}
    width={1920}
    height={1080}
  />
);
