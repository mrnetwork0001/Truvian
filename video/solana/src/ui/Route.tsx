import React from "react";
import { interpolate, random, useCurrentFrame } from "remotion";
import { C, mono } from "../theme";
import { clamp, expo } from "./motion";

/**
 * The film's motif, taken from truvian.xyz's background: a fact routed across the network.
 * A gold pulse travels a right-angled path, leaving a fading trail, and lands with a receipt ring.
 */
export type Pt = [number, number];
const lenOf = (pts: Pt[]) => pts.slice(1).reduce((n, p, i) => n + Math.abs(p[0] - pts[i][0]) + Math.abs(p[1] - pts[i][1]), 0);
const at = (pts: Pt[], d: number): Pt => {
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const seg = Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]);
    if (d <= seg) { const f = seg ? d / seg : 0; return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]; }
    d -= seg;
  }
  return pts[pts.length - 1];
};

export const Route: React.FC<{ pts: Pt[]; start: number; dur?: number; color?: string; width?: number; ring?: boolean; label?: string; faint?: number }> = ({ pts, start, dur = 24, color = C.gold, width = 2, ring = true, label, faint = 0.22 }) => {
  const f = useCurrentFrame();
  const L = lenOf(pts);
  const p = interpolate(f, [start, start + dur], [0, 1], { ...clamp, easing: expo });
  const head = at(pts, p * L);
  const d = "M " + pts.map((q) => q.join(" ")).join(" L ");
  const shown = interpolate(f, [start - 6, start], [0, 1], clamp);
  const landed = f - (start + dur);
  const rr = landed >= 0 ? interpolate(landed, [0, 26], [4, 46], clamp) : 0;
  const ro = landed >= 0 ? interpolate(landed, [0, 26], [0.9, 0], clamp) : 0;
  return (
    <svg width={1920} height={1080} style={{ position: "absolute", left: 0, top: 0, overflow: "visible", pointerEvents: "none" }}>
      <path d={d} stroke={color} strokeOpacity={faint * shown} strokeWidth={1.4} strokeDasharray="3 7" fill="none" />
      <path d={d} stroke={color} strokeWidth={width} fill="none" strokeLinecap="round" strokeDasharray={`${p * L} ${L}`} opacity={0.85 * shown} />
      {p > 0 && p < 1 ? <circle cx={head[0]} cy={head[1]} r={width * 2.6} fill="#fff" style={{ filter: `drop-shadow(0 0 10px ${color})` }} /> : null}
      {landed >= 0 && ring ? <circle cx={head[0]} cy={head[1]} r={rr} stroke={color} strokeOpacity={ro} strokeWidth={1.5} fill="none" /> : null}
      {landed >= 0 ? <circle cx={head[0]} cy={head[1]} r={width * 2} fill={color} /> : null}
      {label && landed >= 0 ? (
        <text x={head[0] + 12} y={head[1] - 12} fill={color} fontFamily={mono} fontSize={15} letterSpacing="0.06em" opacity={interpolate(landed, [0, 10], [0, 0.9], clamp)}>{label}</text>
      ) : null}
    </svg>
  );
};

/** The drafting grid behind dark scenes, with points that breathe. */
export const Grid: React.FC<{ step?: number; opacity?: number; color?: string }> = ({ step = 64, opacity = 1, color = "236,229,214" }) => {
  const f = useCurrentFrame();
  const cols = Math.ceil(1920 / step) + 1, rows = Math.ceil(1080 / step) + 1;
  const glowX = 960 + 520 * Math.sin(f / 90), glowY = 540 + 260 * Math.cos(f / 120);
  return (
    <div style={{ position: "absolute", inset: 0, opacity }}>
      <div style={{ position: "absolute", inset: 0, background: `radial-gradient(42% 52% at ${glowX}px ${glowY}px, rgba(202,165,61,0.10), transparent 70%)` }} />
      <svg width={1920} height={1080} style={{ position: "absolute", inset: 0 }}>
        {Array.from({ length: cols }, (_, i) => <line key={`v${i}`} x1={i * step + 0.5} y1={0} x2={i * step + 0.5} y2={1080} stroke={`rgba(${color},0.04)`} />)}
        {Array.from({ length: rows }, (_, j) => <line key={`h${j}`} x1={0} y1={j * step + 0.5} x2={1920} y2={j * step + 0.5} stroke={`rgba(${color},0.04)`} />)}
        {Array.from({ length: cols * rows }, (_, k) => {
          const i = k % cols, j = Math.floor(k / cols);
          const tw = 0.1 + 0.12 * Math.abs(Math.sin((f + random(`g${k}`) * 300) / 40));
          return <rect key={k} x={i * step - 0.8} y={j * step - 0.8} width={1.6} height={1.6} fill={`rgba(${color},${tw})`} />;
        })}
      </svg>
    </div>
  );
};

/** Truvian's verdict stamp: a double rule, mono caps, slammed in at `at`. */
export const Stamp: React.FC<{ at: number; text: string; color: string; rot?: number; size?: number; style?: React.CSSProperties }> = ({ at, text, color, rot = -7, size = 40, style }) => {
  const f = useCurrentFrame();
  const s = interpolate(f, [at, at + 7], [2.2, 1], { ...clamp, easing: expo });
  const o = interpolate(f, [at, at + 3], [0, 1], clamp);
  const shake = f >= at + 7 && f < at + 13 ? Math.sin((f - at) * 3) * 2 : 0;
  return (
    <div style={{
      display: "inline-block", opacity: o, transform: `translate(${shake}px, 0) scale(${s}) rotate(${rot}deg)`, border: `${Math.max(4, size * 0.16)}px double ${color}`,
      color, fontFamily: mono, fontWeight: 500, fontSize: size, letterSpacing: "0.2em", padding: `${size * 0.18}px ${size * 0.4}px ${size * 0.14}px ${size * 0.52}px`, borderRadius: size * 0.08, ...style,
    }}>{text}</div>
  );
};
