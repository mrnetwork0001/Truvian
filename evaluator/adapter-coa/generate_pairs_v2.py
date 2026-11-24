#!/usr/bin/env python3
"""Clause-extraction pairs for CONTRACT_OBLIGATION_AUDIT, version 2.

Most of the node's public pairs for this intent quote a contract excerpt
and ask for one provision; the answer is a small JSON object
{"clause": label, "value": quoted text, "found": true|false}. This script
writes synthetic contracts (made-up parties, products, places and amounts;
no outside corpus), cuts an excerpt around the provision asked for, and
pairs the right extraction with one fault:

  foreign_value   the right label, a value from another contract (not in the excerpt)
  wrong_label     the right value under another clause label
  other_span      a sentence that is in the excerpt but belongs to another provision
  found_flip      "found": false for a provision that is there, or a made-up value
                  reported as found when the excerpt does not contain the provision

Both answers use the same JSON layout. Output: JSONL rows {prompt, chosen,
rejected, worse_kind, clause, style}, the format of version 1, so the two
sets can be mixed.
"""
import argparse
import datetime as dt
import json
import random

NAMES = ["Arbor Vale", "Brightline", "Corvane", "Delmar", "Eastwick", "Fennimore", "Glenhaven", "Halcyon", "Ironwood",
         "Juniper", "Kestrel", "Lakemont", "Meridian", "Northbrook", "Oakridge", "Pinecrest", "Quillon", "Redstone",
         "Sablewood", "Tidewater", "Unity Ridge", "Vireo", "Westbourne", "Yellowfin", "Zenith", "Ashcombe", "Bexley",
         "Carrow", "Dunmore", "Elmstead", "Fairmont", "Greystone", "Hartwell", "Islington", "Kingsley", "Larchmont"]
TRADES = ["Pharmaceuticals", "Communications", "Software", "Networks", "Biosciences", "Media", "Energy", "Logistics",
          "Technologies", "Systems", "Foods", "Interactive", "Health", "Semiconductor", "Entertainment", "Materials"]
FORMS = [("Inc.", "a Delaware corporation"), ("Corporation", "a Nevada corporation"), ("LLC", "a Delaware limited liability company"),
         ("Ltd.", "a company incorporated in England and Wales"), ("Corp.", "a California corporation"),
         ("Inc.", "a New York corporation"), ("GmbH", "a German limited liability company"), ("Limited", "a Hong Kong company")]
TITLES = ["DISTRIBUTOR AGREEMENT", "Development Agreement", "HOSTING AGREEMENT", "LICENSE AGREEMENT", "PROMOTION AGREEMENT",
          "SUPPLY AGREEMENT", "Co-Branding Agreement", "MANUFACTURING AGREEMENT", "Reseller Agreement", "SPONSORSHIP AGREEMENT",
          "INTELLECTUAL PROPERTY AGREEMENT", "Strategic Alliance Agreement", "MAINTENANCE AGREEMENT", "Joint Venture Agreement",
          "Outsourcing Agreement", "Endorsement Agreement", "Franchise Agreement", "Consulting Agreement", "Transportation Agreement",
          "LIMITED POWER OF ATTORNEY", "Content License Agreement", "Services Agreement", "Agency Agreement", "Marketing Agreement"]
LAWS = ["the State of Delaware", "the State of New York", "the State of California", "England and Wales", "the State of Texas",
        "the Commonwealth of Massachusetts", "the State of Illinois", "the State of Washington", "the Province of Ontario",
        "the State of Virginia", "the Hong Kong Special Administrative Region", "the State of Florida", "Germany", "Singapore"]
PRODUCTS = ["the Licensed Products", "the Products", "the Software", "the Services", "the Licensed Product", "the Content",
            "the Branded Products", "the Hosted Application", "the Equipment", "the Compound"]
TERRITORIES = ["the Territory", "North America", "the United States", "Brazil", "the European Union", "Japan", "Canada",
               "the Asia-Pacific region", "Mexico", "the United Kingdom", "India", "Australia"]
NUMWORDS = {1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 10: "ten", 12: "twelve",
            15: "fifteen", 30: "thirty", 45: "forty-five", 60: "sixty", 90: "ninety", 120: "one hundred twenty", 180: "one hundred eighty"}
MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]


def nw(n):
    return "%s (%d)" % (NUMWORDS.get(n, str(n)), n)


def fdate(d, style):
    if style == 0:
        return "%s %d, %d" % (MONTHS[d.month - 1], d.day, d.year)
    if style == 1:
        return "%d %s %d" % (d.day, MONTHS[d.month - 1], d.year)
    return "%02d/%02d/%02d" % (d.month, d.day, d.year % 100)


def money(rng):
    return "$%s" % format(rng.choice([25, 50, 75, 100, 150, 250, 500, 750, 1000, 2500, 5000]) * 1000, ",")


# provision label -> sentence templates; slots filled from the contract's facts
CLAUSES = {
    "Governing Law": ["This Agreement shall be governed by and construed in accordance with the laws of {LAW}, without regard to its conflict of laws principles.",
                      "This agreement shall be governed by the Laws of {LAW}.",
                      "The validity, interpretation and performance of this Agreement shall be governed by the laws of {LAW}."],
    "Exclusivity": ["During the Term, {A} shall be the exclusive distributor of {PRODUCT} in {TERR}.",
                    "{B} will not appoint any other person to sell {PRODUCT} in {TERR} during the Term.",
                    "{A} hereby grants to {B} an exclusive right to market {PRODUCT} in {TERR}."],
    "Non-Compete": ["During the Term and for {N} months thereafter, {B} shall not manufacture or sell any product that competes with {PRODUCT}.",
                    "{A} agrees not to engage, directly or indirectly, in any business competitive with {B} in {TERR} for a period of {YW} years."],
    "Change Of Control": ["Either Party may terminate this Agreement upon written notice if the other Party undergoes a Change of Control.",
                          "In the event of a change of control of {B}, {A} may terminate this Agreement on {D} days' written notice."],
    "Anti-Assignment": ["Neither Party may assign this Agreement without the prior written consent of the other Party, which shall not be unreasonably withheld.",
                        "{B} shall not assign or transfer any of its rights under this Agreement without {A}'s prior written consent."],
    "Cap On Liability": ["In no event shall either Party's aggregate liability under this Agreement exceed {MONEY}.",
                         "{A}'s total liability arising out of this Agreement shall not exceed the fees paid by {B} in the twelve (12) months preceding the claim.",
                         "IN NO EVENT WILL {AU}'S LIABILITY UNDER THIS AGREEMENT EXCEED THE AMOUNTS ACTUALLY PAID HEREUNDER."],
    "Uncapped Liability": ["The limitations in this Section shall not apply to a Party's breach of its confidentiality obligations or to its indemnification obligations."],
    "Warranty Duration": ["{A} warrants that {PRODUCT} will be free from defects in materials and workmanship for {M} months from the date of delivery.",
                          "The warranty period for {PRODUCT} shall be {YW} years from acceptance."],
    "Insurance": ["{B} shall maintain commercial general liability insurance with limits of not less than {MONEY} per occurrence.",
                  "Each Party shall carry product liability insurance in an amount of at least {MONEY} during the Term."],
    "Audit Rights": ["{A} may, upon {D} days' notice, audit {B}'s books and records relating to this Agreement once per calendar year.",
                     "{B} shall keep accurate records and permit {A}'s auditors to inspect them during normal business hours."],
    "License Grant": ["{A} hereby grants to {B} a non-exclusive, non-transferable license to use {PRODUCT} solely in {TERR}.",
                      "Subject to the terms of this Agreement, {A} grants {B} a royalty-free license to reproduce and distribute {PRODUCT}."],
    "Volume Restriction": ["{B} may not exceed {Q} units of {PRODUCT} per calendar quarter without {A}'s written approval.",
                           "Services shall be limited to {Q} hours in any month."],
    "Minimum Commitment": ["{B} shall purchase a minimum of {Q} units of {PRODUCT} in each Contract Year.",
                           "{B} agrees to place orders totalling at least {MONEY} in each calendar year of the Term."],
    "Termination For Convenience": ["Either Party may terminate this Agreement for any reason upon {D} days' prior written notice to the other Party.",
                                    "{A} may terminate this Agreement at any time, without cause, by giving {D} days' written notice."],
    "Renewal Term": ["This Agreement shall automatically renew for successive {YW}-year periods unless either Party gives notice of non-renewal.",
                     "Upon expiry of the Initial Term, this Agreement will renew for further terms of {M} months each."],
    "Notice Period To Terminate Renewal": ["Either Party may prevent renewal by giving written notice at least {D} days before the end of the then-current term."],
    "Liquidated Damages": ["If {A} fails to deliver on time, it shall pay {B} liquidated damages of {PCT}% of the order value for each week of delay."],
    "Revenue/Profit Sharing": ["{B} shall pay {A} {PCT}% of the Net Revenue received from sales of {PRODUCT}.",
                               "The Parties shall share the net profits from {PRODUCT} equally."],
    "Ip Ownership Assignment": ["All inventions made by {B} in performing the Services shall be the sole property of {A}, and {B} hereby assigns them to {A}."],
    "Non-Disparagement": ["Neither Party shall make any public statement that disparages the other Party or its products."],
    "Third Party Beneficiary": ["Nothing in this Agreement confers any rights on any person other than the Parties and their permitted successors."],
    "Post-Termination Services": ["For {M} months after termination, {A} shall continue to supply spare parts for {PRODUCT} at the then-current prices."],
    "Most Favored Nation": ["If {A} offers {PRODUCT} to any other customer on more favourable terms, it shall offer the same terms to {B}."],
    "No-Solicit Of Employees": ["During the Term and for {M} months thereafter, neither Party shall solicit for employment any employee of the other Party."],
}
HEADINGS = {"Governing Law": "GOVERNING LAW", "Exclusivity": "Exclusivity", "Non-Compete": "Non-Competition",
            "Change Of Control": "Change of Control", "Anti-Assignment": "Assignment", "Cap On Liability": "Limitation of Liability",
            "Uncapped Liability": "Exceptions", "Warranty Duration": "Warranty", "Insurance": "Insurance", "Audit Rights": "Records and Audit",
            "License Grant": "Grant of License", "Volume Restriction": "Capacity", "Minimum Commitment": "Minimum Purchases",
            "Termination For Convenience": "Termination", "Renewal Term": "Renewal", "Notice Period To Terminate Renewal": "Non-Renewal",
            "Liquidated Damages": "Late Delivery", "Revenue/Profit Sharing": "Revenue Share", "Ip Ownership Assignment": "Inventions",
            "Non-Disparagement": "Non-Disparagement", "Third Party Beneficiary": "No Third Party Rights",
            "Post-Termination Services": "Post-Termination Support", "Most Favored Nation": "Most Favoured Terms",
            "No-Solicit Of Employees": "Non-Solicitation"}
FILLER = ["Each Party shall bear its own legal costs and expenses incurred in connection with this Agreement.",
          "Any notice under this Agreement shall be in writing and delivered by hand, courier or email.",
          "This Agreement may be executed in counterparts, each of which shall be deemed an original.",
          "If any provision of this Agreement is held invalid, the remaining provisions shall continue in full force.",
          "The headings in this Agreement are for convenience only and do not affect its interpretation.",
          "No failure to exercise any right under this Agreement shall operate as a waiver of that right.",
          "The Parties shall cooperate in good faith to complete all preparatory work before the Launch Date.",
          "Payment shall be made in US dollars within thirty (30) days of the date of each invoice.",
          "Each order form shall reference this Agreement and shall incorporate its terms."]
HEADER_LABELS = ["Document Name", "Parties", "Agreement Date", "Effective Date", "Expiration Date"]

ASK = {
    "Document Name": ["Extract the Document Name from this contract excerpt.", "Contract audit: quote the document title.",
                      "What is this document called, per the excerpt?"],
    "Parties": ["Extract the Parties provision from this contract excerpt.", "Who is a party to this agreement, per the excerpt?"],
    "Agreement Date": ["Extract the Agreement Date from this contract excerpt.", "Audit the excerpt for the Agreement Date and quote it.",
                       "On what date was this agreement made?"],
    "Effective Date": ["When does this agreement take effect, per the excerpt?", "Extract the Effective Date from this contract excerpt."],
    "Expiration Date": ["Extract the Expiration Date provision from this contract excerpt.", "When does the term of this agreement end, per the excerpt?"],
    "Governing Law": ["Which law governs this agreement, per the excerpt?"],
}
GENERIC_ASK = ["Extract the {L} provision from this contract excerpt.", "Extract the {L} from this contract excerpt.",
               "Audit the excerpt for the {L} clause and quote it.", "Contract audit: quote the {L} clause, if the excerpt has one.",
               "Does this excerpt contain a {L} provision? Quote it."]


def party(rng):
    nm = rng.choice(NAMES) + " " + rng.choice(TRADES)
    form, desc = rng.choice(FORMS)
    full = nm + " " + form
    if rng.random() < 0.35:
        full = full.upper()
    short = nm.split(" ")[0]
    return full, desc, short


def contract(rng):
    """A synthetic contract as a list of (label or None, sentence) in reading order, plus its facts."""
    (a, adesc, ash), (b, bdesc, bsh) = party(rng), party(rng)
    while bsh == ash:
        b, bdesc, bsh = party(rng)
    title = rng.choice(TITLES)
    ds = rng.randrange(3)
    made = dt.date(rng.randrange(1998, 2024), rng.randrange(1, 13), rng.randrange(1, 29))
    eff = made if rng.random() < 0.5 else made + dt.timedelta(days=rng.randrange(1, 60))
    years = rng.choice([1, 2, 3, 4, 5, 7, 10])
    slots = dict(A='"%s"' % ash if rng.random() < 0.3 else ash, B=bsh, AU=ash.upper(), LAW=rng.choice(LAWS),
                 PRODUCT=rng.choice(PRODUCTS), TERR=rng.choice(TERRITORIES), N=rng.choice([6, 12, 18, 24, 36]),
                 YW=rng.choice([1, 2, 3, 5]), D=rng.choice([15, 30, 45, 60, 90, 120, 180]), M=rng.choice([3, 6, 12, 18, 24, 36]),
                 MONEY=money(rng), Q=format(rng.choice([500, 1000, 2500, 5000, 10000, 25000]), ","), PCT=rng.choice([1, 2, 5, 10, 15, 20, 25, 50]))
    slots["A"] = ash
    parts = []
    exhibit = rng.choice(["Exhibit 10.%d " % rng.randrange(1, 40), "Exhibit 99.%d " % rng.randrange(1, 5), "", ""])
    parts.append(("Document Name", exhibit + title, title))
    datew = fdate(made, ds)
    lead = rng.choice(['This %s (the "Agreement") dated as of %s is entered into by and between %s, %s ("%s"), and %s, %s ("%s").',
                       'THIS AGREEMENT, dated as of %s is between %s, %s (hereinafter referred to as "%s"), and %s, %s ("%s").'])
    if lead.startswith("This %s"):
        txt = lead % (title.title() if title.isupper() else title, datew, a, adesc, ash, b, bdesc, bsh)
    else:
        txt = lead % (datew, a, adesc, ash, b, bdesc, bsh)
    parts.append(("Agreement Date", txt, datew))
    parts.append(("Parties", None, a if rng.random() < 0.6 else b))
    effw = fdate(eff, ds)
    if eff != made:
        parts.append(("Effective Date", 'This Agreement shall become effective on %s (the "Effective Date").' % effw, effw))
    else:
        parts.append(("Effective Date", None, datew))
    end = eff + dt.timedelta(days=365 * years - 1)
    exp = rng.choice(["This Agreement shall have an initial term of %s years from the Effective Date." % nw(years),
                      "Unless terminated earlier, this Agreement shall expire on %s." % fdate(end, ds)])
    parts.append(("Expiration Date", exp, exp))
    labels = rng.sample(list(CLAUSES), rng.randint(6, 11))
    sec = rng.randrange(1, 4)
    body = []
    for i, lab in enumerate(labels):
        s = rng.choice(CLAUSES[lab]).format(**slots)
        head = "%d.%d %s" % (sec + i // 3, i % 3 + 1, HEADINGS[lab])
        if rng.random() < 0.5:
            head = head.upper()
        body.append((lab, head, s))
        if rng.random() < 0.4:
            body.append((None, None, rng.choice(FILLER)))
    return dict(header=parts, body=body, slots=slots, ds=ds, a=a, b=b)


def text_of(c):
    """Full contract text and, for each labelled sentence, (label, start, end, value)."""
    out, spans = "", []
    for lab, sent, val in c["header"]:
        if sent is None:
            continue
        start = len(out)
        out += sent + " "
        if lab == "Document Name":
            vs = out.index(val, start)
            spans.append((lab, vs, vs + len(val), val))
        elif lab == "Agreement Date":
            vs = out.index(val, start)
            spans.append((lab, vs, vs + len(val), val))
            pa = out.index(c["a"], start)
            pb = out.index(c["b"], start)
            spans.append(("Parties", pa, pa + len(c["a"]), c["a"]))
            spans.append(("Parties", pb, pb + len(c["b"]), c["b"]))
        elif lab == "Effective Date":
            vs = out.index(val, start)
            spans.append((lab, vs, vs + len(val), val))
        else:
            spans.append((lab, start, start + len(sent), sent))
    for lab, head, sent in c["body"]:
        if head:
            out += head + " "
        start = len(out)
        out += sent + " "
        if lab:
            spans.append((lab, start, start + len(sent), sent))
    return out.strip(), spans


def excerpt_around(rng, text, s, e):
    """A window of the text holding [s, e); sometimes cut so the value runs off the end."""
    width = rng.randrange(280, 760)
    if s < 40 and rng.random() < 0.8:
        lo = 0
    else:
        lo = max(0, s - rng.randrange(20, max(21, width - (e - s) - 10)))
    hi = min(len(text), lo + width)
    if hi < e and rng.random() < 0.7:
        hi = e  # usually keep the value whole
    return lo, hi


def value_seen(text, lo, hi, s, e):
    return text[max(lo, s):min(hi, e)]


def render(lab, val, found, ch):
    obj = {"clause": lab, "value": val, "found": found}
    if ch["spaced"]:
        return json.dumps(obj, ensure_ascii=False)
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def make_pair(rng):
    c = contract(rng)
    text, spans = text_of(c)
    present = sorted({lab for lab, *_ in spans})
    absent = [lab for lab in list(CLAUSES) if lab not in present]
    ch = dict(spaced=rng.random() < 0.2)
    if rng.random() < 0.12 and absent:
        # the provision asked for is not in the contract at all
        lab = rng.choice(absent)
        s = rng.randrange(0, max(1, len(text) - 400))
        lo, hi = s, min(len(text), s + rng.randrange(280, 700))
        ex = text[lo:hi]
        good = render(lab, "", False, ch)
        other = contract(rng)
        fake = rng.choice(CLAUSES[lab]).format(**other["slots"])
        bad = render(lab, fake, True, ch)
        kind = "found_flip"
    else:
        pick = rng.choice(present)
        lab, s, e, val = rng.choice([x for x in spans if x[0] == pick])
        lo, hi = excerpt_around(rng, text, s, e)
        ex = text[lo:hi]
        seen = value_seen(text, lo, hi, s, e)
        if len(seen) < 6:
            return None
        good = render(lab, seen, True, ch)
        in_ex = [(l2, s2, e2) for l2, s2, e2, _ in spans if l2 != lab and s2 >= lo and e2 <= hi]
        kinds = ["foreign_value", "wrong_label", "other_span", "found_flip"]
        kind = rng.choices(kinds, [42, 24, 22 if in_ex else 0, 12])[0]
        if kind == "foreign_value":
            other = contract(rng)
            _, ospans = text_of(other)
            cands = [v for l2, _, _, v in ospans if l2 == lab and v not in ex]
            if not cands:
                return None
            bad = render(lab, rng.choice(cands), True, ch)
        elif kind == "wrong_label":
            pool = [l for l in HEADER_LABELS + list(CLAUSES) if l != lab]
            bad = render(rng.choice(pool), seen, True, ch)
        elif kind == "other_span":
            l2, s2, e2 = rng.choice(in_ex)
            bad = render(lab, text[s2:e2], True, ch)
        else:
            bad = render(lab, "", False, ch)
    if lo > 0 and rng.random() < 0.7:
        ex = ex[rng.randrange(0, 6):]  # excerpts often start mid-word
    ask = (rng.choice(ASK[lab]) if lab in ASK and rng.random() < 0.6 else rng.choice(GENERIC_ASK).format(L=lab))
    prompt = 'Contract excerpt: "%s" %s' % (ex, ask)
    if good == bad:
        return None
    return dict(prompt=prompt, chosen=good, rejected=bad, worse_kind=kind, clause=lab, style="extract")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=1200)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    rng = random.Random(a.seed)
    rows, seen = [], set()
    while len(rows) < a.n:
        p = make_pair(rng)
        if p and p["rejected"] not in seen:
            seen.add(p["rejected"])
            rows.append(p)
    with open(a.out, "w") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
