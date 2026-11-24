#!/usr/bin/env python3
"""Training pairs for a CORPORATE_REGISTRY_LOOKUP evaluator adapter.

The intent takes a company name (or registry identifier) and a jurisdiction
and answers the registered legal name, the registry identifier, whether the
company is active, the jurisdiction, the registered address and the date of
incorporation; the node scores `active`
(`GET /engine/v1/intents/CORPORATE_REGISTRY_LOOKUP`, class `judgment`).

A pair is (question, better answer, worse answer). Every case is built from
a synthetic registry record this script holds, with identifier formats that
follow each registry's real convention (Companies House numbers, HRB entries
at a German local court, Norwegian organisation numbers, Singapore UENs and
so on). The better answer reports the record; the worse answer is a copy of
it with one fault:

  Needs the evidence in the question (an extract or search results)
    flip_status      active and status reversed against the extract
    wrong_number     the identifier's digits changed, same format
    wrong_entity     a similarly named company (search results) or name changed
    wrong_date       incorporation date changed
    wrong_address    registered address changed
  Can be judged from the answer and the question alone
    contradiction    active says one thing, the status wording the other
    bad_format       an identifier in another registry's format
    wrong_jurisdiction  the record of another jurisdiction than the one asked
    impossible_date  incorporated after the lookup date, or dissolved before
                     it was incorporated

Both answers are rendered with the same random choices (style, wording,
field order), so they differ only in the fault.

Output: JSONL rows {prompt, chosen, rejected, worse_kind, evidence, style}.
"""
import argparse
import datetime as dt
import json
import random

STEMS = ["Northwind", "Aster", "Bluefield", "Corvane", "Delmar", "Elsworth", "Fennick", "Granite Peak",
         "Halcyon", "Ironbridge", "Juniper", "Kestrel", "Larkspur", "Meridian", "Nimbus", "Orchard",
         "Pinecrest", "Quayside", "Redwood", "Solace", "Tamarind", "Umber", "Vantage", "Westmere",
         "Alder", "Brightwater", "Cobalt", "Driftwood", "Emberly", "Foxglove", "Greyfriars", "Hollins",
         "Indigo", "Jasperline", "Kingsmead", "Lumen", "Marlow", "Northgate", "Oakhurst", "Pellham",
         "Quill", "Rosemont", "Silverdale", "Thornbury", "Upland", "Verity", "Wexford", "Yarrow"]
TRADES = ["Logistics", "Analytics", "Foods", "Robotics", "Media", "Energy", "Software", "Textiles",
          "Capital", "Labs", "Mining", "Retail", "Freight", "Cloud Services", "Pharma", "Builders",
          "Marine", "Payments", "Insurance", "Hotels", "Ceramics", "Telecom", "Farms", "Consulting",
          "Engineering", "Biotech", "Security", "Travel", "Packaging", "Instruments"]
STATUS_ACTIVE = ["Active", "Registered", "Live", "In good standing"]
STATUS_INACTIVE = ["Dissolved", "Struck off", "In liquidation", "Closed", "Deregistered"]
MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August",
          "September", "October", "November", "December"]


def digits(rng, n):
    return "".join(str(rng.randrange(10)) for _ in range(n))


def lei(rng):
    alnum = "0123456789ABCDEFGHJKLMNPRSTUVWXYZ"
    return "".join(rng.choice(alnum) for _ in range(18)) + digits(rng, 2)


# name, registry, suffixes, identifier maker, address maker, aliases used in questions
JURIS = {
    "United Kingdom": dict(
        registry="Companies House", suffix=["Ltd", "Limited", "plc", "LLP"],
        ident=lambda r: (lambda p: p + digits(r, 7 if len(p) == 1 else 6))(r.choice(["0", "1", "SC", "NI"])),
        addr=lambda r: f"{r.randrange(1, 220)} {r.choice(['High Street', 'Station Road', 'King Street', 'Church Lane', 'Mill Road'])}, "
                       f"{r.choice(['Leeds LS1 4AP', 'Bristol BS1 6QH', 'Manchester M2 3WQ', 'Edinburgh EH2 4AD', 'Cardiff CF10 1EP'])}",
        alias=["the UK", "England and Wales", "United Kingdom"]),
    "Ireland": dict(
        registry="Companies Registration Office (CRO)", suffix=["Limited", "DAC", "Teoranta"],
        ident=lambda r: digits(r, 6),
        addr=lambda r: f"{r.randrange(1, 90)} {r.choice(['Baggot Street', 'Grand Parade', 'Eyre Square', 'Dame Street'])}, "
                       f"{r.choice(['Dublin 2', 'Cork T12 X70A', 'Galway H91 E2K3', 'Dublin 8'])}",
        alias=["Ireland", "the Republic of Ireland"]),
    "Germany": dict(
        registry="Handelsregister", suffix=["GmbH", "AG", "UG (haftungsbeschränkt)"],
        ident=lambda r: f"HRB {r.randrange(10000, 299999)} ({r.choice(['Amtsgericht München', 'Amtsgericht Hamburg', 'Amtsgericht Berlin-Charlottenburg', 'Amtsgericht Köln'])})",
        addr=lambda r: f"{r.choice(['Leopoldstraße', 'Hauptstraße', 'Bahnhofstraße', 'Friedrichstraße'])} {r.randrange(1, 180)}, "
                       f"{r.choice(['80802 München', '20095 Hamburg', '10117 Berlin', '50667 Köln'])}",
        court_city=True,
        alias=["Germany", "DE"]),
    "Norway": dict(
        registry="Brønnøysund Register Centre", suffix=["AS", "ASA"],
        ident=lambda r: f"{r.choice('89')}{digits(r, 2)} {digits(r, 3)} {digits(r, 3)}",
        addr=lambda r: f"{r.choice(['Karl Johans gate', 'Bryggen', 'Storgata', 'Kongens gate'])} {r.randrange(1, 90)}, "
                       f"{r.choice(['0154 Oslo', '5003 Bergen', '7011 Trondheim'])}",
        alias=["Norway", "NO"]),
    "Delaware, United States": dict(
        registry="Delaware Division of Corporations", suffix=["Inc.", "LLC", "Corp."],
        ident=lambda r: "file number " + str(r.randrange(2000000, 7999999)),
        addr=lambda r: f"{r.randrange(100, 2999)} {r.choice(['Orange Street', 'Centerville Road', 'Market Street'])}, "
                       f"{r.choice(['Wilmington, DE 19801', 'Wilmington, DE 19808', 'Dover, DE 19901'])}",
        alias=["Delaware", "Delaware, US", "the State of Delaware"]),
    "Singapore": dict(
        registry="ACRA", suffix=["Pte. Ltd.", "Pte Ltd", "Ltd."],
        ident=lambda r: f"UEN {r.randrange(1990, 2025)}{digits(r, 5)}{r.choice('ABCDEGHKMNRWZ')}",
        addr=lambda r: f"{r.randrange(1, 300)} {r.choice(['Robinson Road', 'Cecil Street', 'Orchard Road', 'Jurong East Street 21'])}, "
                       f"Singapore {digits(r, 6)}",
        alias=["Singapore", "SG"]),
    "Australia": dict(
        registry="ASIC", suffix=["Pty Ltd", "Limited"],
        ident=lambda r: f"ACN {digits(r, 3)} {digits(r, 3)} {digits(r, 3)}",
        addr=lambda r: f"{r.randrange(1, 400)} {r.choice(['George Street', 'Collins Street', 'Queen Street', 'Hay Street'])}, "
                       f"{r.choice(['Sydney NSW 2000', 'Melbourne VIC 3000', 'Brisbane QLD 4000', 'Perth WA 6000'])}",
        alias=["Australia", "AU"]),
    "Netherlands": dict(
        registry="Kamer van Koophandel (KvK)", suffix=["B.V.", "N.V."],
        ident=lambda r: "KvK " + digits(r, 8),
        addr=lambda r: f"{r.choice(['Herengracht', 'Coolsingel', 'Lange Voorhout', 'Stationsplein'])} {r.randrange(1, 500)}, "
                       f"{r.choice(['1015 BS Amsterdam', '3011 AD Rotterdam', '2514 EA Den Haag', '3511 CE Utrecht'])}",
        alias=["the Netherlands", "NL"]),
}
JNAMES = list(JURIS)


def fdate(d, style):
    if style == 0:
        return d.isoformat()
    if style == 1:
        return f"{d.day} {MONTHS[d.month - 1]} {d.year}"
    return f"{MONTHS[d.month - 1]} {d.day}, {d.year}"


def make_record(rng, jur, lookup, name=None):
    j = JURIS[jur]
    if name is None:
        name = f"{rng.choice(STEMS)} {rng.choice(TRADES)} {rng.choice(j['suffix'])}"
    inc = lookup - dt.timedelta(days=rng.randrange(200, 30 * 365))
    active = rng.random() < 0.55
    ident, addr = j["ident"](rng), j["addr"](rng)
    if j.get("court_city"):
        city = {"München": "80802 München", "Hamburg": "20095 Hamburg", "Berlin": "10117 Berlin", "Köln": "50667 Köln"}
        for k, v in city.items():
            if k in ident:
                addr = addr.rsplit(", ", 1)[0] + ", " + v
    rec = dict(name=name, jur=jur, ident=ident, addr=addr, inc=inc, active=active,
               status=rng.choice(STATUS_ACTIVE if active else STATUS_INACTIVE), registry=j["registry"])
    if not active:
        rec["ended"] = inc + dt.timedelta(days=rng.randrange(150, max(151, (lookup - inc).days - 10)))
    return rec


def other_jur(rng, jur):
    return rng.choice([x for x in JNAMES if x != jur])


def alter_digits(rng, ident):
    pos = [i for i, c in enumerate(ident) if c.isdigit()]
    out = list(ident)
    for i in rng.sample(pos, min(len(pos), rng.choice([1, 2]))):
        out[i] = rng.choice([d for d in "0123456789" if d != out[i]])
    return "".join(out)


def extract_text(rng, rec, ds):
    fields = [("Name", rec["name"]), ("Number" if rng.random() < 0.5 else "Registration", rec["ident"]),
              ("Status", rec["status"] + (f" (since {fdate(rec['ended'], ds)})" if "ended" in rec else "")),
              ("Incorporated", fdate(rec["inc"], ds)), ("Registered office", rec["addr"])]
    if rng.random() < 0.5:
        return "\n".join(f"{k}: {v}" for k, v in fields)
    return "; ".join(f"{k}: {v}" for k, v in fields)


def build_case(rng):
    lookup = dt.date(2026, 11, rng.randrange(1, 24))
    jur = rng.choice(JNAMES)
    rec = make_record(rng, jur, lookup)
    ds = rng.randrange(3)
    asked_j = rng.choice(JURIS[jur]["alias"])
    by_id = rng.random() < 0.2
    asked = rec["ident"] if by_id else rec["name"]
    evidence = rng.choices(["extract", "search", "none"], [55, 20, 25])[0]
    q_open = rng.choice([
        f"Look up {asked} in the company registry of {asked_j}.",
        f"Company: {asked}. Jurisdiction: {asked_j}. Is it registered and active?",
        f"Check the registration of {asked} ({asked_j}): legal name, number, status, address and incorporation date.",
        f"Verify whether {asked} is an active company in {asked_j}.",
        f"Registry lookup. company={asked}; jurisdiction={asked_j}",
    ])
    rival = None
    if evidence == "extract":
        q = f"{q_open}\nRegistry extract ({rec['registry']}, retrieved {fdate(lookup, ds)}):\n{extract_text(rng, rec, ds)}"
    elif evidence == "search":
        stem = rec["name"].split()[0]
        rival = make_record(rng, jur, lookup, name=f"{stem} {rng.choice(TRADES)} {rng.choice(JURIS[jur]['suffix'])}")
        rows = [rec, rival]
        rng.shuffle(rows)
        lines = [f"{i + 1}. {r['name']} | {r['ident']} | {r['status']}" + (f" since {fdate(r['ended'], ds)}" if "ended" in r else "")
                 + f" | incorporated {fdate(r['inc'], ds)} | {r['addr']}"
                 for i, r in enumerate(rows)]
        q = f"{q_open}\nSearch results from {rec['registry']} ({fdate(lookup, ds)}):\n" + "\n".join(lines)
    else:
        q = f"{q_open} Today is {fdate(lookup, ds)}."
    return dict(rec=rec, rival=rival, lookup=lookup, ds=ds, evidence=evidence, prompt=q)


FAULTS_EVIDENCE = ["flip_status", "wrong_number", "wrong_entity", "wrong_date", "wrong_address"]
FAULTS_ANY = ["contradiction", "bad_format", "wrong_jurisdiction", "impossible_date"]


def apply_fault(rng, case, ans, kind):
    a = dict(ans)
    rec = case["rec"]
    if kind == "flip_status":
        a["active"] = not a["active"]
        a["status"] = rng.choice(STATUS_ACTIVE if a["active"] else STATUS_INACTIVE)
        a.pop("ended", None)
        if not a["active"]:
            a["ended"] = rec["inc"] + dt.timedelta(days=rng.randrange(100, max(101, (case["lookup"] - rec["inc"]).days - 5)))
    elif kind == "contradiction":
        a["active"] = not a["active"]
    elif kind == "wrong_number":
        a["ident"] = alter_digits(rng, a["ident"])
    elif kind == "bad_format":
        a["ident"] = JURIS[other_jur(rng, rec["jur"])]["ident"](rng)
    elif kind == "wrong_entity":
        r = case["rival"]
        if r is not None:
            a.update(name=r["name"], ident=r["ident"], addr=r["addr"], inc=r["inc"], active=r["active"], status=r["status"])
            a.pop("ended", None)
            if "ended" in r:
                a["ended"] = r["ended"]
        else:
            words = a["name"].split()
            words.insert(len(words) - 1, rng.choice(["Holdings", "Group", "International", "Services"]))
            a["name"] = " ".join(words)
    elif kind == "wrong_date":
        a["inc"] = a["inc"] + dt.timedelta(days=rng.choice([-1, 1]) * rng.randrange(40, 2000))
    elif kind == "wrong_address":
        a["addr"] = JURIS[rec["jur"]]["addr"](rng)
    elif kind == "wrong_jurisdiction":
        oj = other_jur(rng, rec["jur"])
        a.update(jur=oj, registry=JURIS[oj]["registry"], ident=JURIS[oj]["ident"](rng), addr=JURIS[oj]["addr"](rng))
    elif kind == "impossible_date":
        if "ended" in a and rng.random() < 0.5:
            a["ended"] = a["inc"] - dt.timedelta(days=rng.randrange(30, 900))
        else:
            a["inc"] = case["lookup"] + dt.timedelta(days=rng.randrange(20, 900))
    return a


def render(rng_choices, a, ds):
    style, order, src_phrase, status_word = rng_choices
    status = a["status"] + (f" since {fdate(a['ended'], ds)}" if "ended" in a else "")
    fields = {
        "legal_name": a["name"], "registration_id": a["ident"], "active": a["active"], "status": status,
        "jurisdiction": a["jur"], "registered_address": a["addr"], "incorporated": a["inc"].isoformat() if ds == 0 else fdate(a["inc"], ds),
        "source": f"{a['registry']}",
    }
    keys = order
    if style == "json":
        return json.dumps({k: fields[k] for k in keys}, ensure_ascii=False)
    if style == "lines":
        return "\n".join(f"{k.replace('_', ' ').capitalize()}: {('yes' if fields[k] else 'no') if k == 'active' else fields[k]}" for k in keys)
    act = "is active" if a["active"] else "is not active"
    return (f"{a['name']} ({a['ident']}) {act}; its {status_word} is {status}. It was incorporated on "
            f"{fields['incorporated']} in {a['jur']}, with its registered address at {a['addr']}. {src_phrase} {a['registry']}.")


KEYS = ["legal_name", "registration_id", "active", "status", "jurisdiction", "registered_address", "incorporated", "source"]


def make_pair(rng):
    case = build_case(rng)
    rec = case["rec"]
    ans = {k: rec[k] for k in ("name", "jur", "ident", "addr", "inc", "active", "status", "registry") if k in rec}
    if "ended" in rec:
        ans["ended"] = rec["ended"]
    pool = FAULTS_ANY + (FAULTS_EVIDENCE if case["evidence"] != "none" else [])
    if case["evidence"] == "search" and rng.random() < 0.5:
        kind = "wrong_entity"
    else:
        kind = rng.choice(pool)
    worse = apply_fault(rng, case, ans, kind)
    style = rng.choice(["json", "lines", "prose"])
    order = KEYS[:2] + rng.sample(KEYS[2:7], 5) + ["source"]
    choices = (style, order, rng.choice(["Source:", "Per", "As recorded by", "Checked against"]),
               rng.choice(["registry status", "status", "register entry"]))
    chosen, rejected = render(choices, ans, case["ds"]), render(choices, worse, case["ds"])
    if chosen == rejected:
        return None
    return dict(prompt=case["prompt"], chosen=chosen, rejected=rejected, worse_kind=kind,
                evidence=case["evidence"], style=style)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=1200)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    rng = random.Random(args.seed)
    seen, rows = set(), []
    while len(rows) < args.n:
        r = make_pair(rng)
        if r is None or r["rejected"] in seen:
            continue
        seen.add(r["rejected"])
        rows.append(r)
    with open(args.out, "w") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
