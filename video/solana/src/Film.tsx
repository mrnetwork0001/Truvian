import React from "react";
import { AbsoluteFill, Audio, Freeze, Sequence, interpolate, staticFile, useCurrentFrame } from "remotion";
import { T, scene, wordAt } from "./timing";
import { C } from "./theme";
import { Captions } from "./ui/Captions";
import { Grain } from "./ui/Grain";
import { clamp } from "./ui/motion";
import { Open } from "./scenes/Open";
import { Problem } from "./scenes/Problem";
import { Telegraph } from "./scenes/Telegraph";
import { Catch } from "./scenes/Catch";
import { Turn } from "./scenes/Turn";
import { Settle } from "./scenes/Settle";
import { Resolve } from "./scenes/Resolve";
import { Miner } from "./scenes/Miner";
import { Close } from "./scenes/Close";

const SCENES: Record<string, React.FC> = { open: Open, problem: Problem, telegraph: Telegraph, catch: Catch, turn: Turn, settle: Settle, resolve: Resolve, miner: Miner, close: Close };
const OVERLAP = 10;

const SceneIn: React.FC<{ S: React.FC; first: boolean }> = ({ S, first }) => {
  const f = useCurrentFrame();
  if (first) return <S />;
  const p = interpolate(f, [0, OVERLAP], [0, 1], { ...clamp, easing: (t) => 1 - Math.pow(1 - t, 3) });
  const body = f < OVERLAP ? <Freeze frame={0}><S /></Freeze> : <Sequence from={OVERLAP} layout="none"><S /></Sequence>;
  return <AbsoluteFill style={{ opacity: p, transform: `scale(${1.04 - 0.04 * p})`, filter: p < 1 ? `blur(${(1 - p) * 12}px)` : undefined }}>{body}</AbsoluteFill>;
};

const LINES = T.scenes.flatMap((s) => s.lines.map((l) => [l.startFrame, l.words[l.words.length - 1].end] as const));
const DUCK: number[] = (() => {
  const v = new Array<number>(T.totalFrames + 1).fill(0);
  for (let f = 0; f <= T.totalFrames; f++) {
    let d = 0;
    for (const [a, b] of LINES) d = Math.max(d, interpolate(f, [a - 10, a, b, b + 14], [0, 1, 1, 0], clamp));
    v[f] = d;
  }
  return v;
})();
const musicVolume = (f: number) => {
  const end = T.totalFrames;
  return (0.62 - 0.4 * DUCK[Math.min(end, Math.max(0, f))]) * interpolate(f, [0, 12], [0, 1], clamp) * interpolate(f, [end - 40, end], [1, 0], clamp);
};

interface Fx { file: string; at: number; vol: number; dur?: number }
function effects(): Fx[] {
  const sc = (id: string) => scene(id).from;
  const w = (id: string, word: string, n = 0) => wordAt(id, word, n);
  const fx: Fx[] = [
    { file: "tick", at: 4, vol: 0.3 }, { file: "tick", at: 22, vol: 0.25 },
    { file: "pop", at: w("open", "payment") - 2, vol: 0.4 },
    { file: "glitch", at: w("open", "Garantex.") + 2, vol: 0.3 },
    { file: "scan", at: w("open", "sanctioned") - 2, vol: 0.25 },
    { file: "stamp", at: w("open", "no.") - 2, vol: 0.7 },
    { file: "denied", at: w("open", "no.") - 1, vol: 0.35 },
    { file: "whoosh", at: sc("problem") - 8, vol: 0.3 },
    { file: "whoosh", at: sc("telegraph") - 8, vol: 0.3 },
    ...[0, 8, 16].map((d) => ({ file: "pop", at: w("telegraph", "miners") + d, vol: 0.3 })),
    ...[0, 4, 8].map((d) => ({ file: "coin", at: w("telegraph", "cent") + d, vol: 0.3 })),
    { file: "whoosh", at: sc("catch") - 8, vol: 0.3 },
    { file: "glitch", at: w("catch", "nine") + 30, vol: 0.35 },
    { file: "stamp", at: w("catch", "ninety-eight.") + 14, vol: 0.5 },
    { file: "riser", at: sc("turn") - 80, vol: 0.4 },
    { file: "impact", at: w("turn", "Truvian.") - 4, vol: 0.55 },
    { file: "whoosh", at: sc("settle") - 8, vol: 0.3 },
    { file: "click", at: w("settle", "reads") + 4, vol: 0.45 },
    ...["release,", "review,", "reject."].map((x) => ({ file: "stamp", at: w("settle", x), vol: 0.4 })),
    { file: "whoosh", at: sc("resolve") - 8, vol: 0.3 },
    ...[0, 5, 10].map((d) => ({ file: "pop", at: w("resolve", "three") + d, vol: 0.3 })),
    { file: "chime", at: w("resolve", "anchors") + 2, vol: 0.35 },
    { file: "stamp", at: w("resolve", "signed"), vol: 0.45 },
    { file: "swoosh_up", at: sc("miner") - 8, vol: 0.3 },
    { file: "chime", at: w("miner", "balances") - 2, vol: 0.3 },
    { file: "whoosh", at: sc("close") - 8, vol: 0.3 },
    { file: "chime", at: w("close", "Truvian") - 2, vol: 0.4 },
  ];
  return fx.filter((x) => x.at >= 0 && x.at < T.totalFrames);
}

export const Film: React.FC = () => {
  const hideCaptions = (f: number) => {
    const s = T.scenes.find((x) => f >= x.from && f < x.from + x.durationInFrames);
    return !s || ["open", "problem", "catch", "turn", "miner", "close"].includes(s.id);
  };
  return (
    <AbsoluteFill style={{ background: C.bg }}>
      {T.scenes.map((s, i) => {
        const S = SCENES[s.id];
        const from = i === 0 ? s.from : s.from - OVERLAP;
        const dur = s.durationInFrames + (i === 0 ? 0 : OVERLAP);
        return S ? <Sequence key={s.id} from={from} durationInFrames={dur} name={s.id}><SceneIn S={S} first={i === 0} /></Sequence> : null;
      })}
      <Grain opacity={0.05} />
      <Captions hidden={hideCaptions} bottom={40} />
      <Audio src={staticFile("audio/music.mp3")} volume={musicVolume} />
      {T.scenes.flatMap((s) => s.lines).map((l, i) => (
        <Sequence key={`vo${i}`} from={l.startFrame} durationInFrames={l.durationFrames} name={`vo ${l.text.slice(0, 18)}`}>
          <Audio src={staticFile(l.file)} volume={1} />
        </Sequence>
      ))}
      {effects().map((x, i) => (
        <Sequence key={`fx${i}`} from={x.at} durationInFrames={x.dur ?? 120} name={`fx ${x.file}`}>
          <Audio src={staticFile(`audio/sfx/${x.file}.mp3`)} volume={x.vol} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
