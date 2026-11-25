import React from "react";
import { Img, interpolate, staticFile } from "remotion";
import { C } from "../theme";
import { clamp, expo } from "../ui/motion";
import { Words } from "../ui/Words";
import { Fill, useCue } from "./common";

/** Full-bleed gold: the logo on its ink plate, and the line. */
export const Turn: React.FC = () => {
  const { f, rel } = useCue("turn");
  const tName = rel("Truvian."), tD = rel("Decide");
  const p = interpolate(f, [tName - 6, tName + 16], [0, 1], { ...clamp, easing: expo });
  const ring = interpolate(f, [tName - 2, tName + 40], [0, 1], clamp);
  return (
    <Fill bg={C.gold} color="#17140c">
      <div style={{ position: "absolute", left: 960 - 500, top: 360 - 500, width: 1000, height: 1000, borderRadius: "50%", border: `2px solid rgba(23,20,12,${0.5 * (1 - ring)})`, transform: `scale(${0.2 + ring * 1.3})` }} />
      <div style={{ position: "absolute", left: 960 - 380, top: 250, width: 760, height: 220, background: C.bg, display: "flex", alignItems: "center", justifyContent: "center", opacity: p, transform: `scale(${0.85 + 0.15 * p})`, boxShadow: "0 40px 90px rgba(40,30,5,0.35)" }}>
        <Img src={staticFile("brand/truvian-header.png")} style={{ width: 560 }} />
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, top: 560, textAlign: "center", fontSize: 110, letterSpacing: "-0.04em" }}>
        <Words text="Decide before you act." at={tD - 2} every={3} accent={{ "act.": "#17140c" }} />
      </div>
    </Fill>
  );
};
