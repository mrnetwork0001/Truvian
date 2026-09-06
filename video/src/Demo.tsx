import { AbsoluteFill, Audio, Sequence, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { Footage } from './Footage';
import { Brand, Caption, TitleCard } from './Chrome';
import { Terminal, type Line } from './Terminal';
import { theme } from './theme';

export const FPS = 30;
const s = (seconds: number): number => Math.round(seconds * FPS);

/* ---- timeline ----------------------------------------------------------
   Every footage shot below is a real recording of the running app talking to
   live Telegraph miners; the terminal shots type real captured stdout. */
/* Slot lengths are led by the narration: each one is long enough for its
   voice-over clip to finish, and the action shots keep enough time to show the
   checks actually arriving. Measured clip lengths are in video/narration/. */
const PLAN: Array<{ key: string; seconds: number }> = [
  { key: 'intro', seconds: 5.5 },
  { key: 'hero', seconds: 9.5 },
  { key: 'tour', seconds: 15 },
  { key: 'titleCheck', seconds: 3 },
  { key: 'safe', seconds: 18.5 },
  { key: 'safeEvidence', seconds: 9 },
  { key: 'titleVerify', seconds: 2.5 },
  { key: 'verify', seconds: 10.5 },
  { key: 'titleRefuse', seconds: 2.5 },
  { key: 'block', seconds: 18.5 },
  { key: 'blockEvidence', seconds: 13 },
  { key: 'feed', seconds: 7.5 },
  { key: 'titlePays', seconds: 3 },
  { key: 'termPay', seconds: 16.5 },
  { key: 'termGuard', seconds: 20.5 },
  { key: 'why', seconds: 12 },
  { key: 'outro', seconds: 10.5 },
];

const T: Record<string, { at: number; dur: number }> = {};
{
  let cursor = 0;
  for (const step of PLAN) {
    const dur = s(step.seconds);
    T[step.key] = { at: cursor, dur };
    cursor += dur;
  }
}

export const DEMO_DURATION_IN_FRAMES = T.outro!.at + T.outro!.dur;

const PAY_LINES: Line[] = [
  { text: 'first attempt -> http 402', color: theme.warn },
  { text: '  reason: daily free allowance used. Pay $0.05 in USDC to run this check now.', dim: true },
  { text: '  price : $0.05 USDC on base-sepolia to 0xCd0a2370F2dC12c1802707B7d9aB3fec891E3c02', dim: true },
  { text: 'paid attempt  -> http 200', color: theme.safe },
  { text: '  settlement: {"success":true,', dim: true },
  { text: '    "transaction":"0xff12e5cfc9414b86c73e41b4cfd9f5764e0acb17ab148fdecb83e2e293009902",', color: theme.link },
  { text: '    "network":"base-sepolia"}', dim: true },
  { text: '' },
  { text: 'verdict SAFE (score 100)', color: theme.safe },
  { text: '  pass  FEE    $0.01', dim: true },
  { text: '  pass  VALUE  $0.01', dim: true },
];

const GUARD_LINES: Line[] = [
  { text: '1. small transfer, healthy counterparty', color: theme.text },
  { text: '    Shield: SAFE (score 100)', color: theme.safe },
  { text: '      pass  FEE           gas price 0.006 gwei is within the normal range', dim: true },
  { text: '      pass  COUNTERPARTY  referenced transaction succeeded onchain', dim: true },
  { text: '      pass  VALUE         0.05 ETH ~ $125.76 is below the caution thresholds', dim: true },
  { text: '    SIGNED -> 0xsigned', color: theme.safe },
  { text: '' },
  { text: '2. large transfer, reverted counterparty', color: theme.text },
  { text: '    Shield: BLOCK (score 30)', color: theme.block },
  { text: '      pass  FEE           gas price 0.006 gwei is within the normal range', dim: true },
  { text: '      fail  COUNTERPARTY  the referenced transaction REVERTED onchain', color: theme.block },
  { text: '      fail  VALUE         60 ETH ~ $150,916.20 exceeds $100,000.00', color: theme.block },
  { text: '    REFUSED - Truvian Shield returned BLOCK (score 30)', color: theme.block },
];

const Intro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const rise = spring({ frame, fps, config: { damping: 200 }, durationInFrames: 30 });
  const fade = interpolate(frame, [durationInFrames - 18, durationInFrames], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const sub = spring({ frame: frame - 14, fps, config: { damping: 200 }, durationInFrames: 26 });
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', opacity: fade }}>
      <div style={{ opacity: rise, transform: `translateY(${(1 - rise) * 26}px)` }}>
        <Brand />
      </div>
      <div
        style={{
          marginTop: 40,
          fontFamily: theme.mono,
          fontSize: 40,
          color: theme.muted,
          opacity: sub,
          transform: `translateY(${(1 - sub) * 16}px)`,
          textAlign: 'center',
        }}
      >
        Execution safety for onchain agents
      </div>
      <div
        style={{
          marginTop: 22,
          fontFamily: theme.mono,
          fontSize: 24,
          letterSpacing: 5,
          color: theme.gold,
          textTransform: 'uppercase',
          opacity: sub,
        }}
      >
        Telegraph Protocol · Season I · Track 3
      </div>
    </AbsoluteFill>
  );
};

const Outro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const rise = spring({ frame, fps, config: { damping: 200 }, durationInFrames: 28 });
  const rows = [
    ['truvian.xyz', 'the app'],
    ['miner.truvian.xyz', 'our miner, registration 172'],
    ['github.com/mrnetwork0001/Truvian', 'miner, scorer and app'],
  ];
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ opacity: rise, transform: `translateY(${(1 - rise) * 22}px)` }}>
        <Brand scale={0.8} />
      </div>
      <div style={{ marginTop: 46, display: 'flex', flexDirection: 'column', gap: 18 }}>
        {rows.map(([url, note], i) => {
          const appear = spring({ frame: frame - 16 - i * 8, fps, config: { damping: 200 }, durationInFrames: 24 });
          return (
            <div
              key={url}
              style={{
                display: 'flex',
                gap: 22,
                alignItems: 'baseline',
                opacity: appear,
                transform: `translateY(${(1 - appear) * 12}px)`,
                fontFamily: theme.mono,
              }}
            >
              <span style={{ fontSize: 34, color: theme.link, minWidth: 620 }}>{url}</span>
              <span style={{ fontSize: 24, color: theme.faint }}>{note}</span>
            </div>
          );
        })}
      </div>
      <div
        style={{
          marginTop: 52,
          fontFamily: theme.mono,
          fontSize: 26,
          color: theme.gold,
          opacity: spring({ frame: frame - 44, fps, config: { damping: 200 }, durationInFrames: 24 }),
        }}
      >
        Live miners only. Nothing mocked. Verdicts are advisory.
      </div>
    </AbsoluteFill>
  );
};


/** Narration for one section, offset a beat after the cut so it never clips. */
const Narration: React.FC<{ id: string; delay?: number }> = ({ id, delay = 8 }) => (
  <Sequence from={delay}>
    <Audio src={staticFile(`narration/${id}.mp3`)} />
  </Sequence>
);

export const Demo: React.FC = () => (
  <AbsoluteFill style={{ background: theme.bg }}>
    <Sequence from={T.intro!.at} durationInFrames={T.intro!.dur}>
      <Narration id="intro" />
      <Intro />
    </Sequence>

    <Sequence from={T.hero!.at} durationInFrames={T.hero!.dur}>
      <Narration id="hero" />
      <Footage shot="hero" zoom={0.04} />
      <Caption label="The problem" text="Your agent is about to sign. Should it?" />
    </Sequence>

    <Sequence from={T.tour!.at} durationInFrames={T.tour!.dur}>
      <Narration id="tour" />
      <Footage shot="tour" />
      <Caption label="How it works" text="Four paid questions to live Telegraph miners, one verdict, receipts anyone can verify." />
    </Sequence>

    <Sequence from={T.titleCheck!.at} durationInFrames={T.titleCheck!.dur}>
      <Narration id="titleCheck" />
      <TitleCard eyebrow="One click" title="A normal transfer" />
    </Sequence>

    <Sequence from={T.safe!.at} durationInFrames={T.safe!.dur}>
      <Narration id="safe" />
      <Footage shot="safe" />
      <Caption label="A normal transfer" text="Each check is a real paid query. They arrive one at a time, named, timed and priced." accent={theme.safe} />
    </Sequence>

    <Sequence from={T.safeEvidence!.at} durationInFrames={T.safeEvidence!.dur}>
      <Narration id="safeEvidence" />
      <Footage shot="safe-evidence" />
      <Caption label="Verdict · SAFE" text="SAFE, score 100 - with the miner's own answer kept as evidence." accent={theme.safe} />
    </Sequence>

    <Sequence from={T.titleVerify!.at} durationInFrames={T.titleVerify!.dur}>
      <Narration id="titleVerify" />
      <TitleCard eyebrow="Don't trust the card" title="Resolve the hash" />
    </Sequence>

    <Sequence from={T.verify!.at} durationInFrames={T.verify!.dur}>
      <Narration id="verify" />
      <Footage shot="verify" />
      <Caption label="Verify on the node" text="The Telegraph node confirms it: recorded by truvian-onchain-truth." accent={theme.link} />
    </Sequence>

    <Sequence from={T.titleRefuse!.at} durationInFrames={T.titleRefuse!.dur}>
      <Narration id="titleRefuse" />
      <TitleCard eyebrow="Now the other one" title="A reverted counterparty" />
    </Sequence>

    <Sequence from={T.block!.at} durationInFrames={T.block!.dur}>
      <Narration id="block" />
      <Footage shot="block" />
      <Caption label="A reverted counterparty" text="Same four checks, a different answer." accent={theme.block} />
    </Sequence>

    <Sequence from={T.blockEvidence!.at} durationInFrames={T.blockEvidence!.dur}>
      <Narration id="blockEvidence" />
      <Footage shot="block-evidence" />
      <Caption label="Verdict · BLOCK" text="BLOCK, score 30: the counterparty's transaction reverted, and the value has no verified evidence." accent={theme.block} />
    </Sequence>

    <Sequence from={T.feed!.at} durationInFrames={T.feed!.dur}>
      <Narration id="feed" />
      <Footage shot="feed" />
      <Caption label="Public receipts" text="Every report gets a permanent link, and the feed is public." />
    </Sequence>

    <Sequence from={T.titlePays!.at} durationInFrames={T.titlePays!.dur}>
      <Narration id="titlePays" />
      <TitleCard eyebrow="It pays, and it is paid" title="x402, both directions" />
    </Sequence>

    <Sequence from={T.termPay!.at} durationInFrames={T.termPay!.dur}>
      <Narration id="termPay" />
      <Terminal title="agent paying for a check" command="npx tsx src/scripts/pay-check.ts https://truvian.xyz" lines={PAY_LINES} />
      <Caption label="Paying for a check" text="Out of free checks, Shield quotes a price. The payment settles on Base Sepolia." />
    </Sequence>

    <Sequence from={T.termGuard!.at} durationInFrames={T.termGuard!.dur}>
      <Narration id="termGuard" />
      <Terminal title="a guarded viem wallet" command="npx tsx src/scripts/demo-guard.ts https://truvian.xyz" lines={GUARD_LINES} />
      <Caption label="Inside an agent" text="Drop the guard around a wallet and it refuses to sign a BLOCK." accent={theme.block} />
    </Sequence>

    <Sequence from={T.why!.at} durationInFrames={T.why!.dur}>
      <Narration id="why" />
      <Footage shot="why" />
      <Caption label="Why Truvian" text="We built the miner, the scorer that grades it, and the app that pays for both." />
    </Sequence>

    <Sequence from={T.outro!.at} durationInFrames={T.outro!.dur}>
      <Narration id="outro" />
      <Outro />
    </Sequence>
  </AbsoluteFill>
);
