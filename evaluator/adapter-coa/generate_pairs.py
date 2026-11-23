#!/usr/bin/env python3
"""Training pairs for a CONTRACT_OBLIGATION_AUDIT evaluator adapter.

The intent takes a contract (text) and answers a compliance verdict
(Compliant, Partially compliant, Non-compliant, Unclear), the obligations it
sets (who owes what by when), the clause wording cited and a short summary
(`GET /engine/v1/intents/CONTRACT_OBLIGATION_AUDIT`).

A pair is (contract, better audit, worse audit). The better audit is right by
construction: each contract is assembled from clauses whose obligor, action,
deadline and amount this script holds, and most prompts add a performance
record (dates of invoices, payments, deliveries, notices) from which each
checked obligation is met or breached by date arithmetic.

  Verdict rule (over the obligations the record covers)
    all met -> Compliant; some met, some breached -> Partially compliant;
    all breached -> Non-compliant; no record -> Unclear

  Worse audits (`worse_kind`): one copy of the better audit with one fault
    wrong_verdict      another verdict, the rest unchanged (contradicts it)
    misread_record     a breach read as met (or the reverse), verdict to match
    wrong_obligor      one obligation given to the other party
    wrong_deadline     one obligation's period or date changed
    wrong_amount       one obligation's amount changed
    misquote           a cited clause with the wrong number or altered wording
    missed_obligation  one obligation left out
    invented_obligation an obligation the contract does not contain

Both answers are rendered with the same random choices (style, phrasing,
order), so they differ only in the fault; the kit's dataset gate checks that
neither length nor surface words give the answer away.

Output: JSONL rows {prompt, chosen, rejected, worse_kind, contract_kind, style}.
"""
import argparse
import copy
import datetime as dt
import json
import random

COMPANIES = [
    "Northwind Logistics Ltd", "Aster Health GmbH", "Bluefield Analytics Inc", "Corvane Foods SA",
    "Delmar Robotics LLC", "Elsworth Media plc", "Fennick Energy BV", "Granite Peak Software Ltd",
    "Halcyon Textiles Pvt Ltd", "Ironbridge Capital LLP", "Juniper Labs Oy", "Kestrel Mining Pty Ltd",
    "Larkspur Retail Inc", "Meridian Freight AB", "Nimbus Cloud Services Ltd", "Orchard Pharma AG",
    "Pinecrest Builders LLC", "Quayside Marine Ltd", "Redwood Payments Inc", "Solace Insurance SE",
    "Tamarind Hotels Ltd", "Umber Ceramics Srl", "Vantage Telecom NV", "Westmere Farms Ltd",
]
PEOPLE = ["A. Okafor", "M. Lindqvist", "R. Sato", "J. Moreau", "P. Castillo", "D. Mensah", "K. Novak", "S. Iyer"]
CURRENCIES = [("USD", "$"), ("EUR", "€"), ("GBP", "£")]
MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August",
          "September", "October", "November", "December"]


def fdate(d):
    return f"{d.day} {MONTHS[d.month - 1]} {d.year}"


def money(rng, cur, lo, hi, step):
    return f"{cur[1]}{rng.randrange(lo, hi, step):,}"


# ---------------------------------------------------------------------------
# Contracts. Each obligation:
#   party: "A" or "B" (role names come from the contract kind)
#   text:  the clause wording, {party} filled in
#   short: "who owes what by when" as an audit lists it
#   kind:  "within" (N days after a trigger event) or "by" (a fixed date) or "none"
#   n / due / trigger / act: what the record needs to decide it
#   amount: the money figure in the clause, if any
# ---------------------------------------------------------------------------

def services(rng, start, cur):
    deliverable = rng.choice(["the data migration plan", "the security assessment report", "the first release of the booking app",
                              "the quarterly market study", "the network design document", "the training curriculum"])
    fee = money(rng, cur, 8000, 250000, 500)
    pay_days = rng.choice([14, 21, 30, 45, 60])
    due = start + dt.timedelta(days=rng.choice([30, 45, 60, 75, 90]))
    notice = rng.choice([15, 30, 60, 90])
    conf = rng.choice([2, 3, 5])
    fix_days = rng.choice([5, 7, 10, 14])
    obs = [
        dict(party="A", kind="by", due=due, act="delivered", what=f"deliver {deliverable}",
             text=f"{{A}} shall deliver {deliverable} to {{B}} no later than {fdate(due)}."),
        dict(party="B", kind="within", n=pay_days, trigger="invoice", act="paid", what=f"pay the fee of {fee}", amount=fee,
             text=f"{{B}} shall pay {{A}} a fee of {fee} within {pay_days} days of receiving {{A}}'s invoice."),
        dict(party="A", kind="within", n=fix_days, trigger="defect notice", act="fixed", what="correct any reported defect",
             text=f"{{A}} shall correct any defect reported in writing by {{B}} within {fix_days} days of the report."),
        dict(party="either", kind="none", what=f"give {notice} days' written notice to terminate",
             text=f"Either party may terminate this Agreement by giving {notice} days' written notice to the other."),
        dict(party="A", kind="none", what=f"keep {{B}}'s information confidential for {conf} years after termination",
             text=f"{{A}} shall keep all information received from {{B}} confidential during this Agreement and for {conf} years after it ends."),
    ]
    return "Services Agreement", ("Provider", "Client"), obs


def supply(rng, start, cur):
    item = rng.choice(["steel brackets", "printed circuit boards", "glass bottles", "LED panels", "cotton bales", "brake pads"])
    qty = rng.randrange(500, 20000, 250)
    unit = money(rng, cur, 2, 400, 1)
    due = start + dt.timedelta(days=rng.choice([21, 30, 45, 60]))
    pay_days = rng.choice([15, 30, 45, 60, 90])
    notify = rng.choice([5, 7, 10, 14])
    replace = rng.choice([10, 14, 21, 30])
    place = rng.choice(["the Buyer's Rotterdam warehouse", "the Buyer's plant in Monterrey", "the Buyer's depot in Leeds",
                        "the Buyer's site in Pune", "the Buyer's warehouse in Gdansk"])
    obs = [
        dict(party="A", kind="by", due=due, act="delivered", what=f"deliver {qty:,} {item} to {place}",
             text=f"{{A}} shall deliver {qty:,} {item} to {place} on or before {fdate(due)}."),
        dict(party="B", kind="within", n=pay_days, trigger="delivery", act="paid", what=f"pay {unit} per unit", amount=unit,
             text=f"{{B}} shall pay {unit} per unit within {pay_days} days of delivery."),
        dict(party="B", kind="within", n=notify, trigger="delivery", act="notified defects", what="notify defects",
             text=f"{{B}} shall notify {{A}} in writing of any defective units within {notify} days of delivery."),
        dict(party="A", kind="within", n=replace, trigger="defect notice", act="replaced", what="replace defective units",
             text=f"{{A}} shall replace defective units within {replace} days of {{B}}'s notice."),
    ]
    return "Supply Agreement", ("Supplier", "Buyer"), obs


def lease(rng, start, cur):
    rent = money(rng, cur, 900, 40000, 50)
    day = rng.choice([1, 5, 10, 15])
    repair = rng.choice([7, 14, 21, 30])
    deposit = money(rng, cur, 2000, 80000, 500)
    ret = rng.choice([14, 21, 30, 45])
    notice = rng.choice([30, 60, 90])
    obs = [
        dict(party="B", kind="monthly", day=day, act="paid rent", what=f"pay rent of {rent} by the {day}{'st' if day == 1 else 'th'} of each month", amount=rent,
             text=f"{{B}} shall pay rent of {rent} on or before the {day}{'st' if day == 1 else 'th'} day of each calendar month."),
        dict(party="A", kind="within", n=repair, trigger="repair request", act="completed repairs", what="complete structural repairs",
             text=f"{{A}} shall complete structural repairs within {repair} days of {{B}}'s written request."),
        dict(party="A", kind="within", n=ret, trigger="end of the lease", act="returned the deposit", what=f"return the deposit of {deposit}", amount=deposit,
             text=f"{{A}} shall return the security deposit of {deposit} within {ret} days after the lease ends, less documented damage."),
        dict(party="B", kind="none", what=f"give {notice} days' notice before vacating",
             text=f"{{B}} shall give {{A}} at least {notice} days' written notice before vacating the premises."),
    ]
    return "Commercial Lease", ("Landlord", "Tenant"), obs


def loan(rng, start, cur):
    principal = money(rng, cur, 50000, 5000000, 10000)
    inst = money(rng, cur, 5000, 400000, 1000)
    first = start + dt.timedelta(days=rng.choice([30, 60, 90]))
    stmt = rng.choice([30, 45, 60, 90])
    release = rng.choice([5, 10, 15, 30])
    obs = [
        dict(party="B", kind="by", due=first, act="paid the first instalment", what=f"pay the first instalment of {inst}", amount=inst,
             text=f"{{B}} shall repay the loan of {principal} in instalments, the first of {inst} falling due on {fdate(first)}."),
        dict(party="B", kind="within", n=stmt, trigger="quarter end", act="delivered financial statements", what="deliver quarterly financial statements",
             text=f"{{B}} shall deliver its financial statements to {{A}} within {stmt} days after the end of each quarter."),
        dict(party="A", kind="within", n=release, trigger="final repayment", act="released the collateral", what="release the collateral",
             text=f"{{A}} shall release all collateral within {release} days after the final repayment."),
        dict(party="B", kind="none", what="maintain insurance on the collateral",
             text=f"{{B}} shall keep the collateral insured for its full replacement value while any amount is outstanding."),
    ]
    return "Loan Agreement", ("Lender", "Borrower"), obs


KINDS = [services, supply, lease, loan]


# ---------------------------------------------------------------------------
# The performance record: for 1 to 3 dated obligations, the dates that decide
# them. A breach is by a margin of 2 to 25 days; a met obligation is early or
# on the day.
# ---------------------------------------------------------------------------

def trigger_date(rng, trigger, start, events):
    """One timeline per case: a delivery is dated once, a defect notice follows
    the delivery, and a quarter end is a real quarter end."""
    if trigger in events:
        return events[trigger]
    if trigger == "defect notice" and "delivery" in events:
        t = events["delivery"] + dt.timedelta(days=rng.randrange(2, 20))
    elif trigger == "quarter end":
        d = start + dt.timedelta(days=rng.randrange(20, 300))
        q = (d.month - 1) // 3
        t = dt.date(d.year, 3 * q + 3, 30 if q in (1, 2) else 31)
    else:
        t = start + dt.timedelta(days=rng.randrange(10, 120))
    events[trigger] = t
    return t


def record_for(rng, ob, start, roles, met, events):
    who = {"A": roles[0], "B": roles[1]}.get(ob["party"], roles[0])
    if ob["kind"] == "within":
        t = trigger_date(rng, ob["trigger"], start, events)
        late = rng.randrange(2, 26)
        act = t + dt.timedelta(days=ob["n"] - rng.randrange(0, max(1, ob["n"] // 2)) if met else ob["n"] + late)
        if ob["act"] == "notified defects":
            events["defect notice"] = act
        line = f"{ob['trigger'].capitalize()}: {fdate(t)}. {who} {ob['act']} on {fdate(act)}."
        took = (act - t).days
        why = (f"{who} {ob['act']} {took} days after the {ob['trigger']}, within the {ob['n']} days allowed"
               if met else f"{who} {ob['act']} {took} days after the {ob['trigger']}, past the {ob['n']} days allowed")
        alt = (f"{who} {ob['act']} {took} days after the {ob['trigger']}, past the {ob['n']} days allowed"
               if met else f"{who} {ob['act']} {took} days after the {ob['trigger']}, within the {ob['n']} days allowed")
        return line, why, alt
    if ob["kind"] == "by":
        act = ob["due"] - dt.timedelta(days=rng.randrange(0, 10)) if met else ob["due"] + dt.timedelta(days=rng.randrange(2, 26))
        if ob["act"] == "delivered":
            events["delivery"] = act
        line = f"{who} {ob['act']} on {fdate(act)}."
        why = (f"{who} {ob['act']} on {fdate(act)}, on or before the {fdate(ob['due'])} deadline"
               if met else f"{who} {ob['act']} on {fdate(act)}, after the {fdate(ob['due'])} deadline")
        alt = (f"{who} {ob['act']} on {fdate(act)}, after the {fdate(ob['due'])} deadline"
               if met else f"{who} {ob['act']} on {fdate(act)}, on or before the {fdate(ob['due'])} deadline")
        return line, why, alt
    if ob["kind"] == "monthly":
        m = start + dt.timedelta(days=rng.randrange(30, 200))
        d = dt.date(m.year, m.month, ob["day"])
        act = d - dt.timedelta(days=rng.randrange(0, 4)) if met else d + dt.timedelta(days=rng.randrange(2, 15))
        line = f"{MONTHS[d.month - 1]} {d.year} rent: {who} {ob['act']} on {fdate(act)}."
        why = (f"{MONTHS[d.month - 1]} rent was paid on {fdate(act)}, by the due date of {fdate(d)}"
               if met else f"{MONTHS[d.month - 1]} rent was paid on {fdate(act)}, after the due date of {fdate(d)}")
        alt = (f"{MONTHS[d.month - 1]} rent was paid on {fdate(act)}, after the due date of {fdate(d)}"
               if met else f"{MONTHS[d.month - 1]} rent was paid on {fdate(act)}, by the due date of {fdate(d)}")
        return line, why, alt
    return None


def verdict_of(results):
    if not results:
        return "Unclear"
    if all(results):
        return "Compliant"
    if not any(results):
        return "Non-compliant"
    return "Partially compliant"


# ---------------------------------------------------------------------------
# One case: contract text, the audit facts, and the prompt
# ---------------------------------------------------------------------------

def build_case(rng):
    cur = rng.choice(CURRENCIES)
    start = dt.date(2025, 1, 1) + dt.timedelta(days=rng.randrange(0, 600))
    title, roles, obs = rng.choice(KINDS)(rng, start, cur)
    a, b = rng.sample(COMPANIES, 2)
    rng.shuffle(obs)
    obs = obs[: rng.randint(3, len(obs))]
    first_clause = rng.choice([1, 2, 3])
    for i, ob in enumerate(obs):
        ob["clause"] = first_clause + i
        ob["text"] = ob["text"].replace("{A}", f"the {roles[0]}").replace("{B}", f"the {roles[1]}")
        ob["what"] = ob["what"].replace("{B}", f"the {roles[1]}")
        ob["who"] = {"A": roles[0], "B": roles[1]}.get(ob["party"], "Either party")
    head = (f"{title} dated {fdate(start)} between {a} (the \"{roles[0]}\") and {b} (the \"{roles[1]}\").")
    body = "\n".join(f"{ob['clause']}. {ob['text'][0].upper() + ob['text'][1:]}" for ob in obs)
    sig = rng.choice(["", f"\nSigned for the {roles[0]}: {rng.choice(PEOPLE)}. Signed for the {roles[1]}: {rng.choice(PEOPLE)}."])
    contract = f"{head}\n{body}{sig}"

    dated = [ob for ob in obs if ob["kind"] != "none"]
    checked, record, results = [], [], []
    if dated and rng.random() < 0.85:
        k = rng.randint(1, min(3, len(dated)))
        order = lambda ob: (0 if ob["kind"] == "by" else 3 if ob.get("trigger") == "defect notice" else 1 if ob.get("trigger") == "delivery" else 2)
        events = {}
        for ob in sorted(rng.sample(dated, k), key=order):
            met = rng.random() < 0.5
            line, why, alt = record_for(rng, ob, start, roles, met, events)
            checked.append((ob, met, why, alt))
            record.append(line)
            results.append(met)
    verdict = verdict_of(results)

    rec_text = ""
    if record:
        rec_text = rng.choice(["Performance record:", "What happened:", "Record of performance:", "Facts:"]) + "\n" + "\n".join(f"- {r}" for r in record)
    asks = [
        "Audit this contract: list each party's obligations, cite the clauses, and say whether the parties have complied.",
        "Check the following contract for compliance. Who owes what, by when, and was it done?",
        "Review this agreement and its performance record. Give a compliance verdict with the obligations and clauses behind it.",
        "Contract obligation audit. Identify the obligations and judge compliance from the record, if one is given.",
    ]
    if rng.random() < 0.35:
        prompt = f"contract: {contract}" + (f"\n{rec_text}" if rec_text else "")
    else:
        prompt = f"{rng.choice(asks)}\n\n{contract}" + (f"\n\n{rec_text}" if rec_text else "")
    return dict(prompt=prompt, title=title, roles=roles, obs=obs, checked=checked, verdict=verdict, cur=cur, kind=title)


# ---------------------------------------------------------------------------
# The audit, as data, then rendered in one of three styles
# ---------------------------------------------------------------------------

def audit_of(case, rng):
    obl = [dict(who=ob["who"], what=ob["what"], when=when_of(ob), clause=ob["clause"]) for ob in case["obs"]]
    cited = [dict(clause=ob["clause"], text=ob["text"]) for ob, *_ in case["checked"]] or \
            [dict(clause=ob["clause"], text=ob["text"]) for ob in rng.sample(case["obs"], min(2, len(case["obs"])))]
    reasons = [why for _, _, why, _ in case["checked"]]
    return dict(verdict=case["verdict"], obligations=obl, clauses=cited, reasons=reasons)


def when_of(ob):
    if ob["kind"] == "within":
        return f"within {ob['n']} days of the {ob['trigger']}"
    if ob["kind"] == "by":
        return f"by {fdate(ob['due'])}"
    if ob["kind"] == "monthly":
        return f"by day {ob['day']} of each month"
    return "for the term" if "confidential" not in ob["what"] and "insur" not in ob["what"] else "ongoing"


def summary_of(au, case):
    v = au["verdict"]
    if v == "Unclear":
        return (f"The {case['title'].lower()} sets {len(au['obligations'])} obligations, "
                "but no performance record is given, so compliance cannot be judged.")
    return "; ".join(au["reasons"]) + "."


def render(au, case, style, ph):
    summ = summary_of(au, case)
    obl = [f"{o['who']}: {o['what']}, {o['when']} (clause {o['clause']})" for o in au["obligations"]]
    cl = [f"Clause {c['clause']}: \"{c['text'][0].upper() + c['text'][1:]}\"" for c in au["clauses"]]
    if style == "json":
        return json.dumps({"verdict": au["verdict"], "obligations": obl, "clauses": cl, "summary": summ}, ensure_ascii=False)
    if style == "lines":
        return (f"{ph['open']}\nVerdict: {au['verdict']}\nObligations:\n" + "\n".join(f"- {o}" for o in obl) +
                "\nClauses cited:\n" + "\n".join(f"- {c}" for c in cl) + f"\nSummary: {summ}")
    return (f"{ph['open']} Verdict: {au['verdict']}. The obligations are: " + "; ".join(obl) +
            ". Clauses relied on: " + " ".join(cl) + f" In short: {summ}")


# ---------------------------------------------------------------------------
# Faults
# ---------------------------------------------------------------------------

def other_amount(rng, amount):
    sym = amount[0]
    n = int(amount[1:].replace(",", ""))
    m = n
    while m == n:
        m = max(1, round(n * rng.choice([0.5, 0.75, 0.8, 0.9, 1.1, 1.2, 1.25, 1.5, 2, 10, 0.1])))
    return f"{sym}{m:,}"


def corrupt(au, case, rng):
    """Return (worse audit, kind) or None if this kind does not apply."""
    w = copy.deepcopy(au)
    kinds = ["wrong_verdict", "misread_record", "wrong_obligor", "wrong_deadline", "wrong_amount",
             "misquote", "missed_obligation", "invented_obligation"]
    weights = [16, 16, 12, 14, 8, 12, 11, 11]
    for _ in range(20):
        k = rng.choices(kinds, weights)[0]
        if k == "wrong_verdict":
            w["verdict"] = rng.choice([v for v in ["Compliant", "Partially compliant", "Non-compliant", "Unclear"] if v != au["verdict"]])
            return w, k
        if k == "misread_record" and case["checked"]:
            i = rng.randrange(len(case["checked"]))
            res = [m for _, m, _, _ in case["checked"]]
            res[i] = not res[i]
            w["reasons"][i] = case["checked"][i][3]
            w["verdict"] = verdict_of(res)
            return w, k
        if k == "wrong_obligor":
            cand = [o for o in w["obligations"] if o["who"] in case["roles"]]
            if cand:
                o = rng.choice(cand)
                o["who"] = case["roles"][1] if o["who"] == case["roles"][0] else case["roles"][0]
                return w, k
        if k == "wrong_deadline":
            cand = [(o, ob) for o, ob in zip(w["obligations"], case["obs"]) if ob["kind"] in ("within", "by", "monthly")]
            if cand:
                o, ob = rng.choice(cand)
                if ob["kind"] == "within":
                    o["when"] = f"within {rng.choice([n for n in [5, 7, 10, 14, 15, 21, 30, 45, 60, 90] if n != ob['n']])} days of the {ob['trigger']}"
                elif ob["kind"] == "by":
                    o["when"] = f"by {fdate(ob['due'] + dt.timedelta(days=rng.choice([-30, -14, -7, 7, 14, 30])))}"
                else:
                    o["when"] = f"by day {rng.choice([d for d in [1, 5, 10, 15, 20, 28] if d != ob['day']])} of each month"
                return w, k
        if k == "wrong_amount":
            cand = [(o, ob) for o, ob in zip(w["obligations"], case["obs"]) if ob.get("amount")]
            if cand:
                o, ob = rng.choice(cand)
                o["what"] = o["what"].replace(ob["amount"], other_amount(rng, ob["amount"]))
                return w, k
        if k == "misquote" and w["clauses"]:
            c = rng.choice(w["clauses"])
            if rng.random() < 0.5:
                c["clause"] = rng.choice([n for n in range(1, 8) if n != c["clause"]])
            else:
                ob = next(ob for ob in case["obs"] if ob["clause"] == c["clause"])
                if ob.get("n"):
                    c["text"] = c["text"].replace(f"{ob['n']} ", f"{rng.choice([n for n in [5, 7, 10, 14, 21, 30, 45, 60, 90] if n != ob['n']])} ", 1)
                elif ob.get("amount"):
                    c["text"] = c["text"].replace(ob["amount"], other_amount(rng, ob["amount"]), 1)
                else:
                    c["text"] = c["text"].replace(" shall ", " may ", 1)
                if c["text"] == next(x["text"] for x in au["clauses"] if x["clause"] == c["clause"]):
                    continue
            return w, k
        if k == "missed_obligation" and len(w["obligations"]) > 2:
            w["obligations"].pop(rng.randrange(len(w["obligations"])))
            return w, k
        if k == "invented_obligation":
            r = rng.choice(case["roles"])
            fake = rng.choice([
                ("pay a late fee of 2% per month on overdue amounts", "from the due date"),
                ("provide a performance bond", "before work starts"),
                ("obtain the other party's consent before subcontracting", "ongoing"),
                ("deliver monthly status reports", "by the 5th of each month"),
                ("hold liability insurance of at least 1,000,000", "for the term"),
                ("give 10 days' notice of any price change", "before the change"),
            ])
            pos = rng.randrange(len(w["obligations"]) + 1)
            w["obligations"].insert(pos, dict(who=r, what=fake[0], when=fake[1], clause=rng.randint(1, 8)))
            return w, k
    return None


def pair(rng):
    case = build_case(rng)
    au = audit_of(case, rng)
    got = corrupt(au, case, rng)
    if got is None:
        return None
    worse, kind = got
    style = rng.choices(["json", "lines", "prose"], [45, 35, 20])[0]
    ph = dict(open=rng.choice(["Audit result.", "Contract audit:", "Here is the audit.", "Compliance review.", "Findings."]))
    good, bad = render(au, case, style, ph), render(worse, case, style, ph)
    if good == bad:
        return None
    return dict(prompt=case["prompt"], chosen=good, rejected=bad, worse_kind=kind, contract_kind=case["kind"], style=style)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=1200)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    rng = random.Random(a.seed)
    rows, seen = [], set()
    while len(rows) < a.n:
        p = pair(rng)
        if p and p["rejected"] not in seen:
            seen.add(p["rejected"])
            rows.append(p)
    with open(a.out, "w") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
