import { AbsoluteFill, Sequence, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { Footage } from './Footage';
import { Brand, Caption, TitleCard } from './Chrome';
import { Terminal, type Line } from './Terminal';
import { theme } from './theme';

export const FPS = 30;
const s = (seconds: number): number => Math.round(seconds * FPS);

/* ---- timeline ----------------------------------------------------------
   Every footage shot below is a real recording of the running app talking to
   live Telegraph miners; the terminal shots type real captured stdout. */
const T = {
  intro: { at: s(0), dur: s(6) },
  hero: { at: s(6), dur: s(10) },
  tour: { at: s(16), dur: s(15) },
  titleCheck: { at: s(31), dur: s(2.5) },
  safe: { at: s(33.5), dur: s(20) },
  safeEvidence: { at: s(53.5), dur: s(7.5) },
  titleVerify: { at: s(61), dur: s(2.5) },
  verify: { at: s(63.5), dur: s(9) },
  titleRefuse: { at: s(72.5), dur: s(2.5) },
  block: { at: s(75), dur: s(20) },
  blockEvidence: { at: s(95), dur: s(8) },
  feed: { at: s(103), dur: s(6) },
  titlePays: { at: s(109), dur: s(2.5) },
  termPay: { at: s(111.5), dur: s(14) },
  termGuard: { at: s(125.5), dur: s(16) },
  why: { at: s(141.5), dur: s(8) },
  outro: { at: s(149.5), dur: s(9) },
};

export const DEMO_DURATION_IN_FRAMES = T.outro.at + T.outro.dur;

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

export const Demo: React.FC = () => (
  <AbsoluteFill style={{ background: theme.bg }}>
    <Sequence from={T.intro.at} durationInFrames={T.intro.dur}>
      <Intro />
    </Sequence>

    <Sequence from={T.hero.at} durationInFrames={T.hero.dur}>
      <Footage shot="hero" zoom={0.04} />
      <Caption text="Your agent is about to sign. Should it?" />
    </Sequence>

    <Sequence from={T.tour.at} durationInFrames={T.tour.dur}>
      <Footage shot="tour" />
      <Caption text="Four paid questions to live Telegraph miners, one verdict, receipts anyone can verify." />
    </Sequence>

    <Sequence from={T.titleCheck.at} durationInFrames={T.titleCheck.dur}>
      <TitleCard eyebrow="One click" title="A normal transfer" />
    </Sequence>

    <Sequence from={T.safe.at} durationInFrames={T.safe.dur}>
      <Footage shot="safe" label="truvian.xyz/app" />
      <Caption text="Each check is a real paid query. They arrive one at a time, named, timed and priced." accent={theme.safe} />
    </Sequence>

    <Sequence from={T.safeEvidence.at} durationInFrames={T.safeEvidence.dur}>
      <Footage shot="safe-evidence" label="truvian.xyz/app" />
      <Caption text="SAFE, score 100 - with the miner's own answer kept as evidence." accent={theme.safe} />
    </Sequence>

    <Sequence from={T.titleVerify.at} durationInFrames={T.titleVerify.dur}>
      <TitleCard eyebrow="Don't trust the card" title="Resolve the hash" />
    </Sequence>

    <Sequence from={T.verify.at} durationInFrames={T.verify.dur}>
      <Footage shot="verify" label="truvian.xyz/app" />
      <Caption text="The Telegraph node confirms it: recorded by truvian-onchain-truth." accent={theme.link} />
    </Sequence>

    <Sequence from={T.titleRefuse.at} durationInFrames={T.titleRefuse.dur}>
      <TitleCard eyebrow="Now the other one" title="A reverted counterparty" />
    </Sequence>

    <Sequence from={T.block.at} durationInFrames={T.block.dur}>
      <Footage shot="block" label="truvian.xyz/app" />
      <Caption text="Same four checks, a different answer." accent={theme.block} />
    </Sequence>

    <Sequence from={T.blockEvidence.at} durationInFrames={T.blockEvidence.dur}>
      <Footage shot="block-evidence" label="truvian.xyz/app" />
      <Caption text="BLOCK, score 30: the counterparty's transaction reverted, and the value has no verified evidence." accent={theme.block} />
    </Sequence>

    <Sequence from={T.feed.at} durationInFrames={T.feed.dur}>
      <Footage shot="feed" />
      <Caption text="Every report gets a permanent link, and the feed is public." />
    </Sequence>

    <Sequence from={T.titlePays.at} durationInFrames={T.titlePays.dur}>
      <TitleCard eyebrow="It pays, and it is paid" title="x402, both directions" />
    </Sequence>

    <Sequence from={T.termPay.at} durationInFrames={T.termPay.dur}>
      <Terminal title="agent paying for a check" command="npx tsx src/scripts/pay-check.ts https://truvian.xyz" lines={PAY_LINES} />
      <Caption text="Out of free checks, Shield quotes a price. The payment settles on Base Sepolia." />
    </Sequence>

    <Sequence from={T.termGuard.at} durationInFrames={T.termGuard.dur}>
      <Terminal title="a guarded viem wallet" command="npx tsx src/scripts/demo-guard.ts https://truvian.xyz" lines={GUARD_LINES} />
      <Caption text="Drop the guard around a wallet and it refuses to sign a BLOCK." accent={theme.block} />
    </Sequence>

    <Sequence from={T.why.at} durationInFrames={T.why.dur}>
      <Footage shot="why" />
      <Caption text="We built the miner, the scorer that grades it, and the app that pays for both." />
    </Sequence>

    <Sequence from={T.outro.at} durationInFrames={T.outro.dur}>
      <Outro />
    </Sequence>
  </AbsoluteFill>
);
