import React from "react";
import { Img, staticFile } from "remotion";
import { C, mono } from "../theme";
import { Browser } from "../ui/Footage";
import { Grid } from "../ui/Route";
import { Words } from "../ui/Words";
import { D, Fill, Label, useCue, easeIn } from "./common";

/** The close: the live site, the logo, the line, the URL, and the stack it is built on. */
export const Close: React.FC = () => {
  const { f, rel } = useCue("close");
  const tS = rel("Signed"), tU = rel("Truvian");
  const logos: [string, string, number][] = [["logos/solana-sol-logo.svg", "Solana", 30], ["logos/telegraph-mark.svg", "Telegraph", 30], ["logos/polymarket-gh.png", "Polymarket", 30], ["logos/anjoman-mark.svg", "Anjoman", 30]];
  return (
    <Fill bg={C.bg}>
      <Grid />
      <Browser name="home" url="truvian.xyz" left={1000} top={200} width={840} tilt={8} enter={4} />
      <div style={{ position: "absolute", left: 140, top: 220, opacity: easeIn(f, 0, 16) }}>
        <Img src={staticFile("brand/truvian-header.png")} style={{ width: 420 }} />
      </div>
      <div style={{ position: "absolute", left: 140, top: 400, width: 820, fontSize: 82, letterSpacing: "-0.04em", lineHeight: 1.04 }}>
        <Words text="Signed decisions for Solana agents." at={tS - 2} every={3} accent={{ "agents.": C.gold }} />
      </div>
      <div style={{ position: "absolute", left: 140, top: 660, fontFamily: mono, fontSize: 40, color: C.gold, opacity: easeIn(f, tU - 4, 12) }}>truvian.xyz</div>
      <div style={{ position: "absolute", left: 140, top: 820, opacity: easeIn(f, tU + 10, 14) }}>
        <Label>Built with</Label>
        <div style={{ marginTop: 16, display: "flex", gap: 40, alignItems: "center" }}>
          {logos.map(([src, name, h]) => (
            <div key={name} style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <Img src={staticFile(src)} style={{ height: h }} />
              <span style={{ fontSize: 24, color: C.boneDim }}>{name}</span>
            </div>
          ))}
        </div>
      </div>
      <div style={{ position: "absolute", left: 1000, top: 760, width: 840, textAlign: "right", opacity: easeIn(f, tU + 16, 14) }}>
        <Label>Telegraph Season II · {D.stats.deskDecisions} signed desk decisions so far</Label>
      </div>
    </Fill>
  );
};
