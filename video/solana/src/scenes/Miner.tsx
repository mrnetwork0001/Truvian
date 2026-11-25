import React from "react";
import { Img, staticFile } from "remotion";
import { C, mono } from "../theme";
import { Words } from "../ui/Words";
import { D, Fill, Label, Panel, short, useCue, easeIn } from "./common";

/** Paper: miner registration 6194, read back from Ethereum Sepolia, now answering Solana. */
export const Miner: React.FC = () => {
  const { f, rel } = useCue("miner");
  const M = D.miner;
  const tOwn = rel("own"), tAns = rel("answers"), tBal = rel("balances");
  const intents = [["WALLET_BALANCE_CHECK", "balances over every token account"], ["TOKEN_TOTAL_SUPPLY_VERIFY", "mint supply"], ["CRYPTO_TRANSFER_VERIFY", "SPL transfers"]];
  return (
    <Fill bg={C.paper} color={C.paperInk}>
      <div style={{ position: "absolute", left: 140, top: 300, fontSize: 84, letterSpacing: "-0.04em", width: 760, lineHeight: 1.05 }}>
        <Words text="Our own miner answers Solana." at={tOwn - 4} every={3} accent={{ "Solana.": C.goldOnPaper }} />
      </div>
      <div style={{ position: "absolute", left: 140, top: 620, display: "flex", alignItems: "center", gap: 18, opacity: easeIn(f, tAns, 12) }}>
        <Img src={staticFile("logos/solana-sol-logo.svg")} style={{ height: 44 }} />
        <div style={{ fontFamily: mono, fontSize: 20, color: C.paperDim, letterSpacing: "0.08em" }}>MAINNET + DEVNET · SPL TOKEN + TOKEN-2022</div>
      </div>
      <Panel paper at={tOwn} left={1000} top={230} width={780} accent={C.goldOnPaper} style={{ padding: "28px 32px", background: "#fcfaf4" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <Label color={C.paperDim}>Telegraph miner registration</Label>
          <Img src={staticFile("logos/telegraph-mark.svg")} style={{ height: 26, filter: "invert(1)" }} />
        </div>
        <div style={{ marginTop: 10, fontSize: 120, fontWeight: 300, letterSpacing: "-0.05em", lineHeight: 1 }}>{M.registration}</div>
        <div style={{ marginTop: 14, fontFamily: mono, fontSize: 17, lineHeight: 1.7, color: C.paperDim }}>
          Ethereum Sepolia · block {M.block.toLocaleString("en-US")}<br />
          {M.time.slice(0, 10)} {M.time.slice(11, 16)} UTC · tx {short(M.tx, 8, 6)} · status ok
        </div>
        <div style={{ marginTop: 18, borderTop: `1px solid ${C.paperRule}` }}>
          {intents.map(([k, v], i) => (
            <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "12px 0", borderBottom: `1px solid ${C.paperRule}`, opacity: easeIn(f, tBal - 6 + i * 5, 10), fontFamily: mono, fontSize: 17 }}>
              <span>{k}</span><span style={{ color: C.paperDim }}>{v}</span>
            </div>
          ))}
        </div>
      </Panel>
    </Fill>
  );
};
