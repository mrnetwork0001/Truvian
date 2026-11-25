import React from "react";
import { Img, interpolate, staticFile } from "remotion";
import { C, mono, serif } from "../theme";
import { clamp } from "../ui/motion";
import { Grid, Route, Stamp } from "../ui/Route";
import { Words } from "../ui/Words";
import { D, Fill, Label, Panel, short, useCue, easeIn } from "./common";

/** Cold open: the real payment from memo rk43l_0A, the sanctions hit, and the stamp. */
export const Open: React.FC = () => {
  const { f, rel } = useCue("open");
  const S = D.settlement;
  const tPay = rel("payment"), tG = rel("Garantex."), tSan = rel("sanctioned"), tNo = rel("no.");
  const card = { x: 1060, y: 250, w: 640 };
  const tgt: [number, number] = [card.x + card.w / 2, card.y + 300];
  const dim = interpolate(f, [tNo, tNo + 10], [0, 1], clamp);
  return (
    <Fill bg={C.bg}>
      <Grid />
      <div style={{ position: "absolute", left: 140, top: 300, width: 860, fontSize: 92, lineHeight: 1.05, letterSpacing: "-0.035em", fontWeight: 400 }}>
        <div><Words text="A payment on Solana," at={tPay - 4} every={3} /></div>
        <div><Words text="to Garantex." at={tG - 2} every={3} accent={{ "Garantex.": C.reject }} /></div>
        <div style={{ fontSize: 40, color: C.boneDim, marginTop: 36, letterSpacing: "-0.01em" }}>
          <Words text="A sanctioned exchange." at={tSan - 4} every={3} />
        </div>
      </div>
      {/* three facts routed in before the verdict */}
      {[[[1880, 120], [1880, 200], [tgt[0] + 180, 200], [tgt[0] + 180, tgt[1]]], [[1880, 980], [1500, 980], [1500, tgt[1] + 120], [tgt[0], tgt[1] + 120], [tgt[0], tgt[1]]], [[980, 980], [980, tgt[1]], [tgt[0] - 180, tgt[1]]]].map((pts, i) => (
        <Route key={i} pts={pts as [number, number][]} start={tSan + i * 5} dur={26} />
      ))}
      <Panel at={tPay} left={card.x} top={card.y} width={card.w} style={{ opacity: 1 - dim * 0.15 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <Label>Settlement · Solana devnet</Label>
          <Img src={staticFile("logos/solana-sol-logo.svg")} style={{ width: 34 }} />
        </div>
        <div style={{ marginTop: 18, fontSize: 64, letterSpacing: "-0.03em", fontWeight: 300 }}>{S.amountWhole} <span style={{ fontFamily: mono, fontSize: 30, color: C.boneDim }}>tUSD</span></div>
        <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "150px 1fr", rowGap: 10, fontFamily: mono, fontSize: 19 }}>
          <span style={{ color: C.boneFaint }}>TO</span><span>{short(S.recipient, 8, 6)}</span>
          <span style={{ color: C.boneFaint }}>COUNTERPARTY</span><span style={{ color: easeIn(f, tG, 10) > 0.5 ? C.bone : C.boneDim }}>{S.counterparty}</span>
          <span style={{ color: C.boneFaint }}>MINT</span><span>{short(S.mint, 8, 6)}</span>
        </div>
        <div style={{ marginTop: 18, display: "flex", gap: 10, flexWrap: "wrap", minHeight: 40 }}>
          {S.sanctions.lists.filter((l) => l !== "OFAC SDN aliases").map((l, i) => (
            <span key={l} style={{ opacity: easeIn(f, tSan + 26 + i * 5, 10), fontFamily: mono, fontSize: 16, letterSpacing: "0.1em", color: C.reject, border: `1px solid ${C.reject}`, padding: "6px 10px" }}>MATCH · {l}</span>
          ))}
        </div>
      </Panel>
      <div style={{ position: "absolute", left: card.x + 330, top: card.y + 330 }}>
        <Stamp at={tNo - 2} text="REJECT" color={C.reject} size={62} rot={-8} />
      </div>
      <div style={{ position: "absolute", left: card.x, top: card.y + 500, opacity: easeIn(f, tNo + 8, 12) }}>
        <Label color={C.boneFaint}>payment not sent · signed memo {S.id}</Label>
      </div>
      <div style={{ position: "absolute", left: 140, top: 200, opacity: easeIn(f, 0, 14) }}>
        <Label color={C.gold}>25 Nov 2026 · {S.createdAt.slice(11, 16)} UTC</Label>
      </div>
      <span style={{ display: "none", fontFamily: serif }} />
    </Fill>
  );
};
