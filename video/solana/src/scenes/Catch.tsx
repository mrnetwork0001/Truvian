import React from "react";
import { Img, staticFile } from "remotion";
import { C, mono } from "../theme";
import { Count } from "../ui/Count";
import { Grid, Stamp } from "../ui/Route";
import { Words } from "../ui/Words";
import { D, Fill, Label, Panel, useCue, easeIn } from "./common";

/** The miner's answer against the chain's: 855.24 vs 998 at slot 526,219,339. Flagged. */
export const Catch: React.FC = () => {
  const { f, rel } = useCue("catch");
  const S = D.settlement;
  const tThen = rel("Then"), tMin = rel("miner"), t855 = rel("eight"), tSol = rel("Solana"), t998 = rel("nine");
  const t998end = rel("ninety-eight.") + 14;
  return (
    <Fill bg={C.bg}>
      <Grid />
      <div style={{ position: "absolute", left: 140, top: 130, fontSize: 64, letterSpacing: "-0.03em" }}>
        <Words text="Then it checks the chain." at={tThen - 2} every={3} accent={{ "chain.": C.gold }} />
      </div>
      <Panel at={tMin - 4} left={140} top={330} width={760} style={{ padding: "28px 32px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <Img src={staticFile("logos/telegraph-mark.svg")} style={{ height: 26 }} />
          <Label>A Telegraph miner said</Label>
        </div>
        <div style={{ marginTop: 18, fontSize: 150, fontWeight: 300, letterSpacing: "-0.05em", lineHeight: 1 }}>
          <Count to={S.balance.answered} at={t855 - 4} dur={22} decimals={2} />
        </div>
        <div style={{ marginTop: 14, fontFamily: mono, fontSize: 18, color: C.boneFaint }}>{S.balance.miner} · miner {S.balance.minerId}</div>
      </Panel>
      <Panel at={tSol - 4} left={1020} top={330} width={760} accent={C.solB} style={{ padding: "28px 32px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <Img src={staticFile("logos/solana-sol-logo.svg")} style={{ height: 24 }} />
          <Label>Solana devnet said</Label>
        </div>
        <div style={{ marginTop: 18, fontSize: 150, fontWeight: 300, letterSpacing: "-0.05em", lineHeight: 1 }}>
          <Count to={Number(S.payerBalanceChain)} at={t998 - 4} dur={22} /> <span style={{ fontFamily: mono, fontSize: 40, color: C.boneDim, letterSpacing: 0 }}>tUSD</span>
        </div>
        <div style={{ marginTop: 14, fontFamily: mono, fontSize: 18, color: C.boneFaint }}>slot {S.mintSlot.toLocaleString("en-US")} · finalized</div>
      </Panel>
      <div style={{ position: "absolute", left: 140, top: 760, width: 1640, display: "flex", alignItems: "center", gap: 30, opacity: easeIn(f, t998end - 6, 12) }}>
        <Stamp at={t998end} text="REVIEW" color={C.review} size={40} rot={-4} />
        <div style={{ fontSize: 34, letterSpacing: "-0.01em" }}>Payer balance conflicts with the chain</div>
        <span style={{ fontFamily: mono, fontSize: 17, color: C.boneFaint }}>finding · balance.conflict</span>
      </div>
    </Fill>
  );
};
