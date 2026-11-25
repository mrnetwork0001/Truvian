import React from "react";
import { Img, staticFile } from "remotion";
import { C, mono } from "../theme";
import { Grid, Route } from "../ui/Route";
import { Words } from "../ui/Words";
import { D, Fill, Label, Panel, short, useCue, easeIn } from "./common";

/** Three facts bought from three ranked Telegraph miners, a cent each, each with a receipt. */
export const Telegraph: React.FC = () => {
  const { f, rel } = useCue("telegraph");
  const S = D.settlement;
  const tBuy = rel("buys"), tM = rel("miners"), tTg = rel("Telegraph."), tCent = rel("cent"), tR = rel("receipt.");
  const node: [number, number] = [470, 600];
  const facts = [
    { k: "Sanctions screening", m: S.sanctions.miner.split(" — ")[0], id: S.sanctions.minerId, v: "MATCH · OFAC SDN", sig: S.sanctions.signal },
    { k: "Corporate registry", m: S.registry.miner, id: S.registry.minerId, v: `INACTIVE · ${S.registry.jurisdiction}`, sig: S.registry.signal },
    { k: "Wallet balance", m: S.balance.miner, id: S.balance.minerId, v: `${S.balance.answered}`, sig: S.balance.signal },
  ];
  return (
    <Fill bg={C.bg}>
      <Grid />
      <div style={{ position: "absolute", left: 140, top: 130, display: "flex", alignItems: "center", gap: 22, opacity: easeIn(f, tTg - 10, 14) }}>
        <Img src={staticFile("logos/telegraph-mark.svg")} style={{ height: 50 }} />
        <div style={{ fontSize: 46, letterSpacing: "-0.02em" }}>Telegraph</div>
        <Label style={{ marginLeft: 10 }}>ranked specialist miners</Label>
      </div>
      <div style={{ position: "absolute", left: node[0] - 90, top: node[1] - 90, width: 180, height: 180, border: `1px solid ${C.rule}`, background: C.ink2, display: "flex", alignItems: "center", justifyContent: "center", opacity: easeIn(f, tBuy - 8, 12) }}>
        <Img src={staticFile("brand/truvian-icon-transparent.png")} style={{ height: 96 }} />
      </div>
      <div style={{ position: "absolute", left: node[0] - 140, top: node[1] + 110, width: 280, textAlign: "center", opacity: easeIn(f, tBuy, 12) }}><Label color={C.gold}>Truvian buys the facts</Label></div>
      {facts.map((x, i) => {
        const top = 270 + i * 215;
        const at = tM - 6 + i * 8;
        return (
          <React.Fragment key={x.k}>
            <Route pts={[[1020, top + 80], [800, top + 80], [800, node[1]], [node[0] + 92, node[1]]]} start={at + 10} dur={22} />
            <Panel at={at} left={1020} top={top} width={760} style={{ padding: "18px 24px" }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <Label color={C.boneFaint}>{x.k}</Label>
                <span style={{ fontFamily: mono, fontSize: 22, color: C.gold, opacity: easeIn(f, tCent + i * 4, 10) }}>$0.01</span>
              </div>
              <div style={{ marginTop: 8, fontSize: 28, letterSpacing: "-0.01em" }}>{x.m} <span style={{ fontFamily: mono, fontSize: 17, color: C.boneFaint }}>miner {x.id}</span></div>
              <div style={{ marginTop: 8, display: "flex", justifyContent: "space-between", fontFamily: mono, fontSize: 17 }}>
                <span style={{ color: C.boneDim }}>{x.v}</span>
                <span style={{ color: C.boneFaint, opacity: easeIn(f, tR - 6 + i * 4, 10) }}>receipt {short(x.sig, 8, 6)}</span>
              </div>
            </Panel>
          </React.Fragment>
        );
      })}
    </Fill>
  );
};
