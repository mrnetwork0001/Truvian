import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { scene, wordAt } from "../timing";
import { C, mono, sans } from "../theme";
import { clamp, expo, pop } from "../ui/motion";
import onchain from "../../data/onchain.json";

export const D = onchain;

/** Scene-local frame and word cues: rel("word", n) is when the nth "word" is spoken, scene-local. */
export function useCue(id: string) {
  const s = scene(id);
  const f = useCurrentFrame();
  const rel = (w: string, n = 0) => wordAt(id, w, n) - s.from;
  return { s, f, rel, dur: s.durationInFrames };
}

export const Fill: React.FC<{ bg: string; children: React.ReactNode; color?: string }> = ({ bg, children, color = C.bone }) => (
  <AbsoluteFill style={{ background: bg, fontFamily: sans, color, overflow: "hidden" }}>{children}</AbsoluteFill>
);

export const Kicker: React.FC<{ children: React.ReactNode; color?: string; dot?: string; size?: number; style?: React.CSSProperties }> = ({ children, color = C.boneFaint, dot = C.gold, size = 16, style }) => (
  <div style={{ fontFamily: mono, fontSize: size, letterSpacing: "0.16em", textTransform: "uppercase", color, display: "flex", alignItems: "center", gap: 12, ...style }}>
    <span style={{ width: 8, height: 8, borderRadius: 4, background: dot, boxShadow: `0 0 0 4px ${dot}22` }} />{children}
  </div>
);

export const In: React.FC<{ at: number; dur?: number; y?: number; x?: number; children: React.ReactNode; style?: React.CSSProperties; out?: number }> = ({ at, dur = 16, y = 26, x = 0, children, style, out }) => {
  const f = useCurrentFrame();
  const p = interpolate(f, [at, at + dur], [0, 1], { ...clamp, easing: expo });
  const o = out != null ? interpolate(f, [out, out + 10], [1, 0], clamp) : 1;
  return <div style={{ opacity: p * o, transform: `translate(${(1 - p) * x}px, ${(1 - p) * y}px)`, filter: p < 1 ? `blur(${(1 - p) * 7}px)` : undefined, ...style }}>{children}</div>;
};

/** A memo-like panel that pops in: ink by default, paper when `paper`. */
export const Panel: React.FC<{ at: number; left: number; top: number; width: number; paper?: boolean; accent?: string; children: React.ReactNode; style?: React.CSSProperties; out?: number }> = ({ at, left, top, width, paper, accent = C.gold, children, style, out }) => {
  const f = useCurrentFrame();
  const p = pop(f, at);
  const o = interpolate(f, [at, at + 8], [0, 1], clamp) * (out != null ? interpolate(f, [out, out + 10], [1, 0], clamp) : 1);
  return (
    <div style={{
      position: "absolute", left, top, width, opacity: o, transform: `translateY(${(1 - p) * 26}px) scale(${0.95 + 0.05 * p})`, transformOrigin: "50% 100%",
      background: paper ? C.paper : C.ink2, color: paper ? C.paperInk : C.bone, padding: "22px 26px",
      border: `1px solid ${paper ? C.paperRule : C.rule}`, borderTop: `3px solid ${accent}`,
      boxShadow: paper ? "0 30px 70px rgba(0,0,0,0.35)" : "0 30px 70px rgba(0,0,0,0.5)", fontFamily: sans, ...style,
    }}>{children}</div>
  );
};

export const short = (h: string, a = 6, b = 4) => `${h.slice(0, a)}…${h.slice(-b)}`;
export const Head: React.FC<{ children: React.ReactNode; size?: number; style?: React.CSSProperties }> = ({ children, size = 96, style }) => (
  <div style={{ fontFamily: sans, fontWeight: 400, fontSize: size, letterSpacing: "-0.035em", lineHeight: 1.02, ...style }}>{children}</div>
);
export const Label: React.FC<{ children: React.ReactNode; color?: string; size?: number; style?: React.CSSProperties }> = ({ children, color = C.boneFaint, size = 14, style }) => (
  <div style={{ fontFamily: mono, fontSize: size, letterSpacing: "0.14em", textTransform: "uppercase", color, ...style }}>{children}</div>
);
export const easeIn = (f: number, a: number, d = 18) => interpolate(f, [a, a + d], [0, 1], { ...clamp, easing: expo });
