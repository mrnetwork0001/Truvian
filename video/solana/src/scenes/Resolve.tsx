import React from "react";
import { Img, Sequence, staticFile } from "remotion";
import { C, mono } from "../theme";
import { Browser, clip, markOf } from "../ui/Footage";
const clipLen = (n: string) => clip(n)?.durationFrames ?? 0;
import { Grid, Stamp } from "../ui/Route";
import { D, Fill, Label, Panel, short, useCue, easeIn } from "./common";

/** Resolve on the live site: three miners agree; the signed result is anchored on Solana devnet. */
export const Resolve: React.FC = () => {
  const { f, rel } = useCue("resolve");
  const R = D.resolution;
  const tPm = rel("prediction"), tThree = rel("three"), tAnch = rel("anchors"), tSig = rel("signed");
  const swap = tAnch - 8;
  const B = { left: 70, top: 180, width: 1180 };
  return (
    <Fill bg={C.bg}>
      <Grid opacity={0.6} />
      <div style={{ position: "absolute", left: 70, top: 92, display: "flex", alignItems: "center", gap: 16, opacity: easeIn(f, 0, 12) }}>
        <Label color={C.gold}>Desk · Resolve</Label>
        <Label>prediction-market resolution</Label>
      </div>
      <Sequence durationInFrames={swap + 12} layout="none">
        <Browser name="resolve" url={`truvian.xyz/resolve?r=${R.id}`} {...B}
          cams={[{ f: 0, z: 1.7, rect: "decision", dx: -260 }, { f: tThree - 10, z: 1.7, rect: "decision", dx: -260 }, { f: tThree + 20, z: 1.5, rect: "answers", dx: -220, dy: -40 }]} exit={swap} />
      </Sequence>
      <Sequence from={swap} layout="none">
        <Browser name="anchor" url="explorer.solana.com · devnet" {...B} startFrom={Math.min(clipLen("anchor") - 90, markOf("anchor", "anchor_memo") + 60)}
          cams={[{ f: 0, z: 1.25, rect: "memo", dx: -200 }, { f: 14, z: 1.25, rect: "memo", dx: -200 }, { f: 44, z: 1.85, rect: "memo", dx: -60 }]} />
      </Sequence>
      <Panel at={tPm - 4} left={1300} top={180} width={560} style={{ padding: "18px 22px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Img src={staticFile("logos/polymarket-gh.png")} style={{ height: 26 }} />
          <Label>Polymarket · market {R.marketId}</Label>
        </div>
        <div style={{ marginTop: 10, fontSize: 23, lineHeight: 1.3 }}>{R.question}</div>
      </Panel>
      {R.answers.map((a, i) => (
        <Panel key={a.minerId} at={tThree + i * 5} left={1300} top={350 + i * 98} width={560} style={{ padding: "12px 22px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div><div style={{ fontSize: 21 }}>{a.miner}</div><div style={{ fontFamily: mono, fontSize: 14, color: C.boneFaint }}>rank {a.rank} · {a.route}</div></div>
            <span style={{ fontFamily: mono, fontSize: 20, color: C.ok }}>{a.outcome.toUpperCase()}</span>
          </div>
        </Panel>
      ))}
      <Panel at={tAnch} left={1300} top={660} width={560} accent={C.solB} style={{ padding: "16px 22px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}><Img src={staticFile("logos/solana-sol-logo.svg")} style={{ height: 18 }} /><Label>Anchored on Solana devnet</Label></div>
        <div style={{ marginTop: 8, fontFamily: mono, fontSize: 16, lineHeight: 1.6, color: C.boneDim }}>
          slot {R.anchor.slot.toLocaleString("en-US")} · tx {short(R.anchor.signature, 6, 6)}<br />memo = sha256 {short(R.sha256, 6, 6)}
        </div>
      </Panel>
      <div style={{ position: "absolute", left: 1330, top: 860 }}>
        <Stamp at={tSig} text={`${R.decision}: ${R.outcome.toUpperCase()}`} color={C.ok} size={30} rot={-4} />
      </div>
    </Fill>
  );
};
