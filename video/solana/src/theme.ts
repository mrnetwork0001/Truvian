import { loadFont as loadSans } from "@remotion/google-fonts/InterTight";
import { loadFont as loadMono } from "@remotion/google-fonts/JetBrainsMono";
import { loadFont as loadSerif } from "@remotion/google-fonts/InstrumentSerif";

/** Truvian's three families (src/shield/public/tokens.css). */
export const sans = loadSans("normal", { weights: ["300", "400", "500", "600"], subsets: ["latin"] }).fontFamily;
export const display = sans;
export const mono = loadMono("normal", { weights: ["400", "500"], subsets: ["latin"] }).fontFamily;
export const serif = loadSerif("italic", { weights: ["400"], subsets: ["latin"] }).fontFamily;

/** "The signed memo": ink desk, bone paper, one gold. Verdict colours on stamps only. */
export const C = {
  bg: "#0d0c0a", ink2: "#13120f", ink3: "#1a1814", rule: "#2b2822",
  bone: "#ece5d6", boneDim: "#b2ab9c", boneFaint: "#8d8678",
  paper: "#efe9dc", paper2: "#e6dfcf", paperRule: "#cfc6b2", paperInk: "#1c1a16", paperDim: "#5b5548",
  gold: "#caa53d", goldSoft: "#e3c46f", goldOnPaper: "#7d5f12",
  ok: "#7fae73", review: "#d9a441", reject: "#d0645a",
  okPaper: "#2f5f2b", reviewPaper: "#7a4f00", rejectPaper: "#8b2219",
  // Solana's brand gradient, for Solana moments only
  solA: "#9945FF", solB: "#14F195",
  faint: "#8d8678",
};
export const SOL_GRAD = `linear-gradient(90deg, ${C.solA}, ${C.solB})`;

export type Tone = "dark" | "light" | "brand";
export const TONE: Record<Tone, { bg: string; ink: string; muted: string; line: string; pill: string }> = {
  dark: { bg: C.bg, ink: C.bone, muted: "rgba(236,229,214,0.55)", line: "rgba(236,229,214,0.14)", pill: "rgba(13,12,10,0.72)" },
  light: { bg: C.paper, ink: C.paperInk, muted: "rgba(28,26,22,0.55)", line: "rgba(28,26,22,0.14)", pill: "rgba(252,250,244,0.86)" },
  brand: { bg: C.gold, ink: "#17140c", muted: "rgba(23,20,12,0.7)", line: "rgba(23,20,12,0.2)", pill: "rgba(23,20,12,0.5)" },
};
export const SCENE_TONE: Record<string, Tone> = {
  open: "dark", problem: "light", telegraph: "dark", catch: "dark", turn: "brand",
  settle: "dark", resolve: "dark", miner: "light", close: "dark",
};
