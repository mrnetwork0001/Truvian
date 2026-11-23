#!/usr/bin/env python3
"""Training pairs for an OPTIMAL_EXECUTION_ROUTE evaluator adapter.

The intent asks one thing: how many USDC base units does selling exactly
1 ETH (10^18 wei) for USDC on Ethereum mainnet return? Its scored field is
`amount_out` in USDC base units (6 decimals), between 10^8 and 10^11.

A pair is (question, better answer, worse answer). Nothing here knows the
live price, and neither does an adapter, so the better answer is never
told apart by its price alone. What separates the two is what a judge can
check inside the text:

  - units: base units (6 decimals) as asked, not whole USDC, not 18-decimal
    wei-style figures, and a whole-USDC figure that agrees with them;
  - direction: ETH sold for USDC, not USDC sold for ETH;
  - the pair and chain: ETH/USDC on Ethereum, not USDT, WBTC or an L2;
  - consistency: a quoted price, amount_out and route that agree with each
    other (amount_out ~ price x 1 ETH less a fee of a few basis points);
  - an answer at all: a number for the route, not a refusal, a range or
    a generic description of DEX aggregators;
  - plausibility: amount_out inside the intent's range for the stated price.

Both sides draw on the same pool of phrases (routes, venues, caveats,
block references), so a surface word or length does not give the answer
away; the kit's dataset gate checks that.

Output: JSONL rows {prompt, chosen, rejected, label_kind, worse_kind}.
"""
import argparse
import json
import random

QUESTIONS = [
    "Swap to route: sell exactly 1 ETH for USDC on Ethereum",
    "Sell exactly 1 ETH for USDC on Ethereum. How much USDC is received, in USDC base units?",
    "What is the best execution route to sell 1 ETH for USDC on Ethereum mainnet, and the amount out?",
    "Quote the optimal route for swapping 1 ETH (1000000000000000000 wei) to USDC on Ethereum.",
    "pair: ETH/USDC. Route a sale of exactly 1 ETH into USDC on Ethereum mainnet and give amount_out in base units.",
    "How many USDC base units would I get for exactly 1 ETH on Ethereum right now, using the best route?",
    "Find the optimal execution route for 1 ETH -> USDC on Ethereum and report the amount received.",
    "Best price to sell 1 ETH for USDC on Ethereum? Give amount_out (USDC, 6 decimals).",
    "OPTIMAL_EXECUTION_ROUTE: ETH/USDC, sell 1 ETH, Ethereum mainnet.",
    "I want to swap 1 ETH to USDC on Ethereum. Which route gives the most USDC, and how much exactly?",
]

VENUES = [
    ("Uniswap v3", "the WETH/USDC 0.05% pool"), ("Uniswap v3", "the WETH/USDC 0.3% pool"),
    ("Uniswap v4", "the ETH/USDC 0.05% pool"), ("Curve", "the tricrypto pool"),
    ("Balancer", "the WETH/USDC weighted pool"), ("SushiSwap", "the WETH/USDC pair"),
    ("Fluid", "the ETH/USDC DEX"), ("Maverick", "the ETH/USDC boosted position"),
    ("PancakeSwap v3", "the WETH/USDC 0.01% pool"), ("Ekubo", "the ETH/USDC pool"),
]
AGGS = ["1inch", "CoW Swap", "ParaSwap", "0x", "Odos", "KyberSwap", "OpenOcean", "LI.FI", "Bebop", "UniswapX"]
SOURCES = [
    "quoted by {agg}'s API", "from {agg}'s quote endpoint", "simulated with eth_call against {v}",
    "read from the pools' on-chain state", "from {agg}'s route finder", "per {agg} at block {b}",
]
CAVEATS = [
    "Prices move every block, so this quote is valid for block {b} only.",
    "The figure excludes gas, which is paid separately in ETH.",
    "Gas for the route is about {g} gwei per unit and is not deducted from amount_out.",
    "Slippage tolerance was not applied; the minimum received would be lower.",
    "This is a quote, not an executed trade.",
    "Quoted at block {b}; a later block will differ.",
    "No MEV protection is assumed.",
    "",
]
NOISE_OPEN = ["", "Route found. ", "Quote: ", "Result: ", "Answer: ", "Here is the route. ", "Done. "]


def fmt_usd(x, places=2):
    return f"{x:,.{places}f}"


def split_route(rng, total):
    """1-3 legs whose shares add to 100%."""
    n = rng.choice([1, 1, 2, 2, 3])
    venues = rng.sample(VENUES, n)
    if n == 1:
        return [(venues[0], 100)]
    cuts = sorted(rng.sample(range(5, 96, 5), n - 1))
    shares = [b - a for a, b in zip([0] + cuts, cuts + [100])]
    return list(zip(venues, shares))


def route_text(legs):
    if len(legs) == 1:
        (dex, pool), _ = legs[0]
        return f"100% through {dex} ({pool})"
    return ", ".join(f"{share}% via {dex} ({pool})" for (dex, pool), share in legs)


def ctx(rng):
    price = round(rng.uniform(1400, 4800), 2)
    fee_bps = rng.choice([1, 2, 3, 5, 5, 8, 10, 12, 30])
    out_usdc = price * (1 - fee_bps / 10000) * rng.uniform(0.9992, 1.0)
    out_units = int(round(out_usdc * 1_000_000))
    return {
        "price": price, "fee_bps": fee_bps, "out_usdc": out_units / 1_000_000, "out_units": out_units,
        "block": rng.randint(20_500_000, 26_900_000), "gwei": round(rng.uniform(0.05, 12), 3),
        "agg": rng.choice(AGGS), "legs": split_route(rng, out_units),
    }


def fill(s, c, rng):
    return s.format(agg=c["agg"], v=route_text(c["legs"]), b=c["block"], g=c["gwei"])


# One template per answer shape. Both answers of a pair are rendered from the
# same shape, phrases and route, so they differ only in the fact that is wrong.
# {U} amount_out in base units, {Q2}/{Q4}/{Q6} the whole-token amount, {T} the
# token received, {IN} what is sold, {CH} the chain, {P} the ETH price.
SHAPES = [
    "Selling exactly {IN} returns {U} {T} base units ({Q6} {T}), {R}, {S}. That is ETH at about ${P} less roughly {F} bps of fees and price impact.",
    "JSON",
    "amount_out: {U} ({T}, 6 decimals = {Q2} {T}). Best route: {R} on {CH}. Source: {S}.",
    "Best execution for {IN} -> {T} on {CH}: {R}. You receive {Q2} {T}, which is {U} base units, {S}.",
    "{U} {T} base units for {IN} on {CH} ({Q4} {T} at an implied ${Q2} per ETH), {R}.",
    "Route {R} on {CH}, {S}: sell {IN} (10^18 wei), receive {U} {T} base units, i.e. {Q2} {T}.",
]


def render(shape, v, open_, cav):
    if SHAPES[shape] == "JSON":
        body = json.dumps({"pair": f"ETH/{v['T']}", "chain": v["CH"].lower().replace(" mainnet", ""), "amount_in": v["IN"],
                           "amount_out": v["U"], "amount_out_token": v["Q6"], "route": v["R"], "block": v["B"]})
    else:
        body = SHAPES[shape].format(**v)
    return (open_ + body + (" " + cav if cav else "")).strip()


def values(c, rng):
    return {
        "U": str(c["out_units"]), "Q2": fmt_usd(c["out_usdc"], 2), "Q4": fmt_usd(c["out_usdc"], 4), "Q6": f"{c['out_usdc']:.6f}",
        "T": "USDC", "IN": "1 ETH", "CH": rng.choice(["Ethereum", "Ethereum mainnet"]), "P": fmt_usd(c["price"]),
        "F": str(c["fee_bps"]), "R": route_text(c["legs"]), "S": fill(rng.choice(SOURCES), c, rng), "B": c["block"],
    }


def corrupt(v, c, rng, kind):
    """The same values with one fact made wrong."""
    w = dict(v)
    if kind == "whole_units":
        w["U"] = str(int(round(c["out_usdc"])))
    elif kind == "wei_units":
        w["U"] = str(c["out_units"] * 10**12)
    elif kind == "decimal_slip":
        f = rng.choice([10, 100, 1000])
        w["U"] = str(c["out_units"] // f if rng.random() < 0.5 else c["out_units"] * f)
    elif kind == "contradiction":
        w["U"] = str(int(c["out_units"] * rng.choice([0.7, 0.8, 0.88, 1.12, 1.25, 1.4])))
    elif kind == "out_of_range":
        w["U"] = str(rng.choice([rng.randint(10**4, 9_999_999), rng.randint(10**12, 10**15)]))
        q = int(w["U"]) / 1e6
        w["Q2"], w["Q4"], w["Q6"] = fmt_usd(q, 2), fmt_usd(q, 4), f"{q:.6f}"
    elif kind == "wrong_pair":
        alt = rng.choice(["USDT", "DAI", "USDe", "USDC.e", "PYUSD"])
        w["T"] = alt  # the route keeps its USDC pools: the answer names the wrong token received
    elif kind == "wrong_chain":
        w["CH"] = rng.choice(["Base", "Arbitrum One", "OP Mainnet", "Polygon", "BNB Smart Chain", "Avalanche"])
        w["R"] = v["R"]
    elif kind == "inverted":
        eth = 1 / c["price"]
        w["IN"] = "1 USDC"
        w["T"] = "ETH"
        w["U"] = str(int(eth * 10**18))
        w["Q2"], w["Q4"], w["Q6"] = f"{eth:.2f}", f"{eth:.4f}", f"{eth:.6f}"
    elif kind == "range":
        lo, hi = int(c["out_units"] * 0.95), int(c["out_units"] * 1.05)
        w["U"] = f"between {lo} and {hi}"
        w["Q2"] = f"{fmt_usd(c['out_usdc'] * 0.95, 0)}-{fmt_usd(c['out_usdc'] * 1.05, 0)}"
        w["Q4"], w["Q6"] = w["Q2"], w["Q2"]
    elif kind == "no_number":
        # words the shared asides also use ("live", "market", "current", "price"), so only the missing figure tells
        w["U"] = rng.choice(["the live market amount of", "the current amount of", "the market price in", "the live amount of"])
        w["Q2"] = w["Q4"] = w["Q6"] = rng.choice(["the current market", "the live price in", "the current", "the market amount in"])
    else:
        raise ValueError(kind)
    return w


# Side remarks that carry the words the wrong answers introduce (other chains,
# other stablecoins, ranges, the reverse direction, "market"), added to BOTH
# answers of a pair so those words do not mark the worse one.
ASIDES = [
    "The same swap on {L2} quotes differently.",
    "A {ALT} route on Ethereum quoted lower.",
    "Quotes across aggregators were between {LO} and {HI} base units.",
    "In the other direction, 1 USDC buys about {INV} ETH.",
    "The live market price sets the amount; this is the current one.",
    "Routes on Base, Arbitrum One or Polygon were not considered.",
    "USDT and DAI pools were checked and gave less.",
    "",
    "",
]


def aside(c, rng):
    lo, hi = int(c["out_units"] * rng.uniform(0.985, 0.999)), int(c["out_units"] * rng.uniform(1.0, 1.002))
    return rng.choice(ASIDES).format(
        L2=rng.choice(["Base", "Arbitrum One", "OP Mainnet", "Polygon", "BNB Smart Chain", "Avalanche"]),
        ALT=rng.choice(["USDT", "DAI", "USDe", "USDC.e", "PYUSD"]), LO=lo, HI=hi, INV=f"{1 / c['price']:.6f}")


def pair(c, rng, kind):
    v = values(c, rng)
    shape = rng.randrange(len(SHAPES))
    open_ = rng.choice(NOISE_OPEN)
    cav = fill(rng.choice(CAVEATS), c, rng)
    # the wrong chain must show: shapes that do not name the chain get it named on both sides
    if kind == "wrong_chain" and "{CH}" not in SHAPES[shape] and SHAPES[shape] != "JSON":
        shape = 2
    side = aside(c, rng)
    cav = " ".join(x for x in (side, cav) if x)
    good, bad = render(shape, v, open_, cav), render(shape, corrupt(v, c, rng, kind), open_, cav)
    # The range and no-number answers bring "between", "live", "market" and
    # "current" into the worse side; the better side gets them as often.
    r = rng.random()
    if r < 0.11:
        lo, hi = int(c["out_units"] * 0.997), int(c["out_units"] * 1.001)
        good += f" Quotes across aggregators were between {lo} and {hi} base units."
    elif r < 0.17:
        good += " The live market price sets the amount; this is the current one."
    return good, bad


KINDS = ["whole_units", "wei_units", "decimal_slip", "inverted", "wrong_pair", "wrong_chain",
         "contradiction", "out_of_range", "no_number", "range"]


def make(rng):
    c = ctx(rng)
    kind = rng.choice(KINDS)
    chosen, rejected = pair(c, rng, kind)
    # the kit trains only on label_kind "preference_pair"; the kind of worse answer is kept as worse_kind
    return {"prompt": rng.choice(QUESTIONS), "chosen": chosen, "rejected": rejected,
            "label_kind": "preference_pair", "worse_kind": kind}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--n", type=int, default=1200)
    ap.add_argument("--seed", type=int, default=41)
    a = ap.parse_args()
    rng = random.Random(a.seed)
    rows, seen = [], set()
    while len(rows) < a.n:
        r = make(rng)
        if r["rejected"] in seen:
            continue
        seen.add(r["rejected"])
        rows.append(r)
    with open(a.out, "w") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")


if __name__ == "__main__":
    main()
