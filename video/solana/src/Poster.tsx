import React from "react";
import { AbsoluteFill, Img, staticFile } from "remotion";
import { C, mono, sans, serif } from "./theme";
import { Grid } from "./ui/Route";

/** Thumbnail: the REJECT on a Solana payment to a sanctioned exchange. */
export const Poster: React.FC = () => (
  <AbsoluteFill style={{ background: C.bg, fontFamily: sans, color: C.bone }}>
    <Grid />
    <Img src={staticFile("brand/truvian-header.png")} style={{ position: "absolute", left: 120, top: 100, width: 380 }} />
    <div style={{ position: "absolute", left: 120, top: 300, fontSize: 150, lineHeight: 0.98, letterSpacing: "-0.05em", width: 1100 }}>
      Check before <span style={{ fontFamily: serif, fontStyle: "italic", color: C.gold }}>Solana</span> money moves.
    </div>
    <div style={{ position: "absolute", right: 150, top: 330, transform: "rotate(-8deg)", border: `10px double ${C.reject}`, color: C.reject, fontFamily: mono, fontSize: 96, letterSpacing: "0.2em", padding: "14px 30px 10px 44px" }}>REJECT</div>
    <div style={{ position: "absolute", right: 150, top: 520, fontFamily: mono, fontSize: 30, color: C.boneDim, textAlign: "right" }}>Garantex · OFAC SDN</div>
    <div style={{ position: "absolute", left: 120, bottom: 110, display: "flex", gap: 36, alignItems: "center" }}>
      <Img src={staticFile("logos/solana-sol-logo.svg")} style={{ height: 52 }} />
      <Img src={staticFile("logos/telegraph-mark.svg")} style={{ height: 56 }} />
      <span style={{ fontFamily: mono, fontSize: 34, color: C.gold }}>truvian.xyz</span>
    </div>
  </AbsoluteFill>
);
