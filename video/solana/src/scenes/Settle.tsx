import React from "react";
import { Img, Sequence, staticFile } from "remotion";
import { C, mono } from "../theme";
import { Browser, markOf } from "../ui/Footage";
import { Stamp } from "../ui/Route";
import { D, Fill, Label, Panel, useCue, easeIn } from "./common";
import { Grid } from "../ui/Route";

/** The settlement desk on the live site: the example filled in, then the real REJECT memo. */
export const Settle: React.FC = () => {
  const { f, rel, dur } = useCue("settle");
  const S = D.settlement;
  const tReads = rel("reads"), tMint = rel("mint"), tCp = rel("counterparty,"), tAns = rel("answers:");
  const tRel = rel("release,"), tRev = rel("review,"), tRej = rel("reject.");
  const swap = tAns - 10;
  const B = { left: 70, top: 180, width: 1180 };
  const restr = ["permanent delegate", "transfer hook", "transfer fee", "default frozen", "non-transferable", "freeze authority"];
  return (
    <Fill bg={C.bg}>
      <Grid opacity={0.6} />
      <div style={{ position: "absolute", left: 70, top: 92, display: "flex", alignItems: "center", gap: 16, opacity: easeIn(f, 0, 12) }}>
        <Label color={C.gold}>Desk · Settlement assurance</Label>
        <Label>truvian.xyz · live</Label>
      </div>
      <Sequence durationInFrames={swap + 12} layout="none">
        <Browser name="settle" url="truvian.xyz/preflight?desk=settlement" {...B} startFrom={Math.max(0, markOf("settle", "settle_filled") - (tReads + 4))}
          cams={[{ f: 0, z: 1.6, rect: { x: 80, y: 200, w: 1300, h: 140 } }, { f: tReads + 14, z: 1.6, rect: { x: 80, y: 200, w: 1300, h: 140 } }, { f: tReads + 54, z: 1.45, rect: "form", dy: 60 }]} exit={swap} />
      </Sequence>
      <Sequence from={swap} layout="none">
        <Browser name="memo" url={`truvian.xyz/preflight?m=${S.id}`} {...B} enter={0}
          cams={[{ f: 0, z: 1.75, rect: "decision", dx: -260 }, { f: 50, z: 1.75, rect: "decision", dx: -260 }, { f: 84, z: 1.5, rect: "findings", dx: -200, dy: -60 }]} />
      </Sequence>
      <Panel at={tReads} left={1300} top={180} width={560} accent={C.solB} style={{ padding: "18px 22px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}><Img src={staticFile("logos/solana-sol-logo.svg")} style={{ height: 18 }} /><Label>Mint, read from Solana</Label></div>
        <div style={{ marginTop: 10, fontFamily: mono, fontSize: 17, lineHeight: 1.6, color: C.boneDim }}>
          {S.mintProgram === "spl-token" ? "SPL Token" : "Token-2022"} · {D.mint.decimals} decimals · slot {S.mintSlot.toLocaleString("en-US")}
        </div>
        <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: 8 }}>
          {restr.map((r, i) => (
            <span key={r} style={{ opacity: easeIn(f, tMint + 4 + i * 3, 10), fontFamily: mono, fontSize: 14, letterSpacing: "0.06em", color: C.bone, border: `1px solid ${C.rule}`, padding: "5px 8px" }}>{r}</span>
          ))}
        </div>
        <div style={{ marginTop: 10, opacity: easeIn(f, tMint + 24, 10) }}><Label size={12}>Token-2022 checks on every mint</Label></div>
      </Panel>
      <Panel at={tCp - 2} left={1300} top={470} width={560} style={{ padding: "18px 22px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}><Img src={staticFile("logos/telegraph-mark.svg")} style={{ height: 18 }} /><Label>Counterparty, via Telegraph</Label></div>
        <div style={{ marginTop: 10, fontSize: 24 }}>{S.counterparty}</div>
        <div style={{ marginTop: 6, fontFamily: mono, fontSize: 16, color: C.reject }}>sanctions match · registry inactive</div>
      </Panel>
      <div style={{ position: "absolute", left: 1300, top: 680, display: "flex", flexDirection: "column", gap: 18 }}>
        <Stamp at={tRel} text="RELEASE" color={C.ok} size={30} rot={-3} />
        <Stamp at={tRev} text="REVIEW" color={C.review} size={30} rot={-3} />
        <Stamp at={tRej} text="REJECT" color={C.reject} size={30} rot={-3} style={{ boxShadow: f > tRej + 8 ? `0 0 0 6px rgba(208,100,90,0.12)` : undefined }} />
      </div>
      <div style={{ display: "none" }}>{dur}</div>
    </Fill>
  );
};
