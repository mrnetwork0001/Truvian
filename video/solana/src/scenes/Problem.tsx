import React from "react";
import { interpolate } from "remotion";
import { C, mono } from "../theme";
import { clamp } from "../ui/motion";
import { Words } from "../ui/Words";
import { Fill, useCue, easeIn } from "./common";

/** Paper: money moves in a second; nobody looks at the other side. */
export const Problem: React.FC = () => {
  const { f, rel } = useCue("problem");
  const tA = rel("Agents"), tN = rel("Nobody"), tS = rel("side.");
  const y = 760;
  const q = easeIn(f, tN + 6, 16);
  return (
    <Fill bg={C.paper} color={C.paperInk}>
      <div style={{ position: "absolute", left: 140, top: 190, width: 1640, fontSize: 104, lineHeight: 1.04, letterSpacing: "-0.04em" }}>
        <Words text="Agents move money on Solana in under a second." at={tA - 2} every={2} accent={{ "second.": C.goldOnPaper }} />
      </div>
      <div style={{ position: "absolute", left: 140, top: 470, fontSize: 56, letterSpacing: "-0.03em", color: C.paperDim }}>
        <Words text="Nobody checks who is on the other side." at={tN - 2} every={2} accent={{ "side.": C.rejectPaper }} />
      </div>
      {/* a lane of transfers: agent -> unknown */}
      <div style={{ position: "absolute", left: 140, top: y - 34, width: 200, height: 68, border: `1.5px solid ${C.paperInk}`, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: mono, fontSize: 20, letterSpacing: "0.14em", opacity: easeIn(f, tA, 12) }}>AGENT</div>
      <div style={{ position: "absolute", left: 1580, top: y - 34, width: 200, height: 68, border: `1.5px dashed ${C.rejectPaper}`, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: mono, fontSize: 30, color: C.rejectPaper, opacity: q, transform: `scale(${0.8 + 0.2 * q})` }}>?</div>
      <div style={{ position: "absolute", left: 340, top: y, width: 1240, height: 1.5, background: C.paperRule }} />
      {Array.from({ length: 14 }, (_, i) => {
        const s = tA + 10 + i * 12;
        const p = interpolate(f, [s, s + 16], [0, 1], clamp);
        if (p <= 0 || p >= 1) return null;
        return <div key={i} style={{ position: "absolute", left: 340 + p * 1240 - 60, top: y - 2, width: 60, height: 5, background: `linear-gradient(90deg, transparent, ${C.goldOnPaper})` }} />;
      })}
      <div style={{ position: "absolute", left: 340, top: y + 24, fontFamily: mono, fontSize: 16, letterSpacing: "0.12em", color: C.paperDim, opacity: easeIn(f, tA + 14, 12) }}>SPL TRANSFER · ~400 MS SLOTS</div>
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 6, background: `linear-gradient(90deg, ${C.solA}, ${C.solB})`, opacity: 0.85 * interpolate(f, [tS, tS + 10], [1, 1], clamp) }} />
    </Fill>
  );
};
