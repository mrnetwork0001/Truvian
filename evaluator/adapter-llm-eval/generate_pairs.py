#!/usr/bin/env python3
"""Training pairs for an LLM_OUTPUT_EVALUATION evaluator adapter.

The intent gives a task and a model's output and asks for a judgement: a
rating (Excellent, Good, Acceptable, Poor, Fails), a score out of 10, the
strengths and the specific errors.

A pair is (question, better evaluation, worse evaluation). The better one is
right by construction: each output is built from facts this script holds,
with exactly one planted flaw or none, so the true errors are known.

  Output kinds
    fact      a short factual answer (capitals, elements, dates, distances)
    calc      a worked calculation (percentages, unit conversions, totals)
    summary   a summary of a given passage with figures and names
    cited     an answer citing numbered sources that are given in the task
    code      a short Python function for a stated job

  Flaws planted in the output (or none)
    wrong_fact, wrong_arithmetic, changed_figure, swapped_entity,
    unsupported_detail, wrong_citation, code_bug

  Worse evaluations (`worse_kind`)
    missed_error     praises a flawed output, lists no errors
    invented_error   on a correct output, names an error that is not one
    wrong_target     names an error, but in a claim that is correct
    bad_correction   names the right claim, "corrects" it to another wrong value
    inconsistent     the rating contradicts the score or the errors listed

Both sides draw on the same phrases (openers, strengths, closers) and the
same answer formats (JSON, labelled lines, prose), so neither length nor a
surface word tells them apart; the kit's dataset gate checks that.

Output: JSONL rows {prompt, chosen, rejected, label_kind, worse_kind, output_kind}.
"""
import argparse
import json
import random

# ---------------------------------------------------------------------------
# Facts (stable, checkable)
# ---------------------------------------------------------------------------
CAPITALS = [("Australia", "Canberra", "Sydney"), ("Canada", "Ottawa", "Toronto"), ("Brazil", "Brasilia", "Rio de Janeiro"),
            ("Turkey", "Ankara", "Istanbul"), ("Switzerland", "Bern", "Zurich"), ("Nigeria", "Abuja", "Lagos"),
            ("Morocco", "Rabat", "Casablanca"), ("New Zealand", "Wellington", "Auckland"), ("Vietnam", "Hanoi", "Ho Chi Minh City"),
            ("Pakistan", "Islamabad", "Karachi"), ("South Africa (executive)", "Pretoria", "Johannesburg"), ("Kazakhstan", "Astana", "Almaty")]
ELEMENTS = [("gold", "Au", 79), ("silver", "Ag", 47), ("iron", "Fe", 26), ("sodium", "Na", 11), ("potassium", "K", 19),
            ("lead", "Pb", 82), ("tin", "Sn", 50), ("mercury", "Hg", 80), ("tungsten", "W", 74), ("copper", "Cu", 29)]
DATES = [("the Apollo 11 Moon landing", 1969), ("the fall of the Berlin Wall", 1989), ("the first iPhone's release", 2007),
         ("the founding of the United Nations", 1945), ("the launch of Sputnik 1", 1957), ("the Bitcoin white paper", 2008),
         ("the Ethereum mainnet launch", 2015), ("the signing of the Treaty of Versailles", 1919), ("the first transatlantic telegraph cable", 1858)]
PLANETS = [("Mercury", 0), ("Venus", 0), ("Earth", 1), ("Mars", 2), ("Neptune", 16)]

NAMES = ["Amara Okafor", "Lena Fischer", "Rahul Mehta", "Sofia Duarte", "Kenji Watanabe", "Grace Mensah", "Tomas Novak",
         "Ines Haddad", "Daniel Kowalski", "Mei Lin", "Omar Farouk", "Clara Jensen", "Yusuf Demir", "Priya Nair"]
ORGS = ["Halden Logistics", "Brightwater Energy", "Northgate Robotics", "Corvel Health", "Aster Foods", "Kestrel Mining",
        "Lumen Analytics", "Orbit Freight", "Tamsin Bank", "Veridia Water", "Pallas Software", "Quarry Lane Retail"]
CITIES = ["Rotterdam", "Nairobi", "Lyon", "Pune", "Osaka", "Accra", "Krakow", "Porto", "Izmir", "Monterrey", "Durban", "Leeds"]

# ---------------------------------------------------------------------------
# Shared phrasing, used by better and worse evaluations alike
# ---------------------------------------------------------------------------
OPENERS = ["", "Evaluation of the output against the task.", "Checked each claim against the task and its sources.",
           "Judged for factual fidelity, support and completeness.", "Reviewed the output line by line.",
           "Assessment follows.", "Here is my evaluation."]
STRENGTHS = ["answers the question that was asked", "is concise and well organised", "uses the units the task asks for",
             "keeps to the scope of the task", "states its result clearly", "shows its working",
             "is easy to follow", "uses a neutral, factual tone", "follows the requested format"]
CLOSERS = ["", "No safety concerns.", "Tone is appropriate.", "Formatting is fine.", "Length suits the task.",
           "Nothing else needs changing.", "Otherwise the output is usable as written.",
           "It could be a little shorter.", "A reader may want the sources linked.", "Wording could be tighter in places.",
           "The values match the task's units."]
RATING_SCORE = {"Excellent": (9, 10), "Good": (7, 8), "Acceptable": (5, 6), "Poor": (3, 4), "Fails": (0, 2)}


def score_for(rating, rng):
    lo, hi = RATING_SCORE[rating]
    return rng.choice([lo, hi]) if rng.random() < 0.6 else round(rng.uniform(lo, hi + 0.9 if hi < 10 else hi), 1)


# ---------------------------------------------------------------------------
# Output builders: each returns (task, output, claims, truth)
#   claims: list of short claim strings that appear in the output
#   truth:  None (no flaw) or {"claim": text, "fix": correct value, "why": reason, "kind": flaw}
# ---------------------------------------------------------------------------

def build_fact(rng, flaw):
    c, capital, decoy = rng.choice(CAPITALS)
    el, sym, num = rng.choice(ELEMENTS)
    ev, yr = rng.choice(DATES)
    picks = rng.sample(["capital", "element", "date"], 2)
    parts, claims, wrong = [], [], None
    bad_i = rng.randrange(2) if flaw else -1
    for i, p in enumerate(picks):
        bad = i == bad_i
        if p == "capital":
            val = decoy if bad else capital
            parts.append(f"The capital of {c} is {val}.")
            claims.append(f"the capital of {c} is {val}")
            if bad: wrong = {"claim": f"the capital of {c} is {decoy}", "fix": capital, "why": f"{decoy} is a larger city, but the capital is {capital}"}
        elif p == "element":
            alt = num + rng.choice([-2, -1, 1, 2])
            val = alt if bad else num
            parts.append(f"The chemical symbol for {el} is {sym}, and its atomic number is {val}.")
            claims.append(f"{el} has atomic number {val}")
            if bad: wrong = {"claim": f"{el} has atomic number {alt}", "fix": str(num), "why": f"{el} ({sym}) is element {num}"}
        else:
            alt = yr + rng.choice([-3, -2, -1, 1, 2, 3])
            val = alt if bad else yr
            parts.append(f"{ev[0].upper() + ev[1:]} happened in {val}.")
            claims.append(f"{ev} happened in {val}")
            if bad: wrong = {"claim": f"{ev} happened in {alt}", "fix": str(yr), "why": f"{ev} was in {yr}"}
    q = " and ".join({"capital": f"the capital of {c}", "element": f"the symbol and atomic number of {el}", "date": f"the year of {ev}"}[p] for p in picks)
    task = rng.choice([f"Answer briefly: what are {q}?", f"Give {q}.", f"Quick facts needed: {q}."])
    if wrong: wrong["kind"] = "wrong_fact"
    return task, " ".join(parts), claims, wrong


def build_calc(rng, flaw):
    kind = rng.choice(["pct", "units", "total"])
    if kind == "pct":
        base = rng.choice([240, 380, 1250, 860, 4200, 96, 175]); pct = rng.choice([12, 15, 18, 25, 35, 8])
        res = base * pct / 100; tot = base + res
        shown = tot + (rng.choice([-1, 1]) * rng.choice([10, 20, base * 0.01 * rng.choice([2, 5])]) if flaw else 0)
        task = f"A price of ${base} rises by {pct}%. What is the new price?"
        out = f"{pct}% of ${base} is ${res:g}, so the new price is ${shown:g}."
        claims = [f"{pct}% of ${base} is ${res:g}", f"the new price is ${shown:g}"]
        wrong = {"claim": f"the new price is ${shown:g}", "fix": f"${tot:g}", "why": f"${base} + ${res:g} = ${tot:g}"} if flaw else None
    elif kind == "units":
        km = rng.choice([5, 12, 26, 42, 80, 150]); mi = round(km * 0.621371, 2)
        shown = round(mi * rng.choice([0.9, 1.1, 1.6]), 2) if flaw else mi
        task = f"Convert {km} km to miles, to two decimal places."
        out = f"One kilometre is about 0.621371 miles, so {km} km is {shown} miles."
        claims = ["one kilometre is about 0.621371 miles", f"{km} km is {shown} miles"]
        wrong = {"claim": f"{km} km is {shown} miles", "fix": f"{mi} miles", "why": f"{km} x 0.621371 = {mi}"} if flaw else None
    else:
        q1, p1, q2, p2 = rng.randint(2, 9), rng.choice([4, 6, 12, 15, 25]), rng.randint(2, 9), rng.choice([3, 8, 10, 20])
        tot = q1 * p1 + q2 * p2
        shown = tot + rng.choice([-p1, p2, 10, -10]) if flaw else tot
        task = f"An order has {q1} items at ${p1} and {q2} items at ${p2}. What is the total?"
        out = f"{q1} x ${p1} = ${q1 * p1} and {q2} x ${p2} = ${q2 * p2}, for a total of ${shown}."
        claims = [f"{q1} x ${p1} = ${q1 * p1}", f"the total is ${shown}"]
        wrong = {"claim": f"the total is ${shown}", "fix": f"${tot}", "why": f"${q1 * p1} + ${q2 * p2} = ${tot}"} if flaw else None
    if wrong: wrong["kind"] = "wrong_arithmetic"
    return task, out, claims, wrong


def build_summary(rng, flaw):
    org, ceo, other = rng.choice(ORGS), *rng.sample(NAMES, 2)
    city = rng.choice(CITIES)
    rev = rng.choice([120, 340, 58, 910, 75, 230]); growth = rng.choice([4, 7, 11, 15, 22]); staff = rng.choice([180, 450, 1200, 2600])
    passage = (f"{org}, based in {city}, reported revenue of ${rev} million for the year, up {growth}% on the year before. "
               f"Chief executive {ceo} said the company would hire about {staff} people, while finance director {other} "
               f"warned that higher energy costs would weigh on margins.")
    kinds = ["changed_figure", "swapped_entity", "unsupported_detail"]
    k = rng.choice(kinds) if flaw else None
    g, s, who_ceo, extra = growth, staff, ceo, ""
    wrong = None
    if k == "changed_figure":
        g = growth + rng.choice([3, 5, 10, -2])
        wrong = {"claim": f"revenue grew {g}%", "fix": f"{growth}%", "why": f"the passage says up {growth}%"}
    elif k == "swapped_entity":
        who_ceo = other
        wrong = {"claim": f"{other} is the chief executive", "fix": ceo, "why": f"the passage names {ceo} as chief executive and {other} as finance director"}
    elif k == "unsupported_detail":
        extra = rng.choice([f" It also plans to open a second site in {rng.choice([x for x in CITIES if x != city])}.",
                            " The board approved a share buyback.", f" Profit doubled to ${rev // 4} million."])
        wrong = {"claim": extra.strip().rstrip("."), "fix": "remove it", "why": "the passage says nothing about this"}
    out = (f"{org} grew revenue {g}% to ${rev} million. CEO {who_ceo} plans about {s} hires, and the finance director "
           f"flagged energy costs as a risk to margins.{extra}")
    claims = [f"revenue grew {g}%", f"revenue was ${rev} million", f"{who_ceo} is the chief executive", f"about {s} hires"]
    task = rng.choice([f"Summarise this passage in two sentences: {passage}", f"Summarize faithfully: {passage}",
                       f"Write a short summary of the following, without adding anything. {passage}"])
    if wrong: wrong["kind"] = k
    return task, out, claims, wrong


def build_cited(rng, flaw):
    org = rng.choice(ORGS); city = rng.choice(CITIES)
    a, b = rng.choice([12, 30, 45, 60]), rng.choice([2019, 2020, 2021, 2022])
    s1 = f"[1] {org} operates {a} depots across the region."
    s2 = f"[2] {org} was founded in {b} in {city}."
    task = (f"Using only these sources, describe {org}. Cite each claim. Sources: {s1} {s2}")
    if flaw:
        k = rng.choice(["swap", "unsupported"])
        if k == "swap":
            out = f"{org} was founded in {b} in {city} [1] and runs {a} depots [2]."
            wrong = {"claim": f"founded in {b} in {city} [1]", "fix": "cite [2]", "why": "source [1] is about depots; the founding is in [2]"}
        else:
            yr = rng.choice([2023, 2024])
            out = f"{org} runs {a} depots [1], was founded in {b} in {city} [2], and listed on the stock exchange in {yr} [2]."
            wrong = {"claim": f"listed on the stock exchange in {yr} [2]", "fix": "remove it or find a source", "why": "neither source mentions a listing"}
    else:
        out = f"{org} was founded in {b} in {city} [2] and runs {a} depots across the region [1]."
        wrong = None
    claims = [f"{a} depots", f"founded in {b}", f"in {city}"]
    if wrong: wrong["kind"] = "wrong_citation"
    return task, out, claims, wrong


CODE = [
    ("return the sum of the even numbers in a list", "def sum_even(xs):\n    return sum(x for x in xs if x % 2 == 0)",
     "def sum_even(xs):\n    return sum(x for x in xs if x % 2 == 1)", "it keeps odd numbers (x % 2 == 1) instead of even ones"),
    ("return the last n items of a list", "def last_n(xs, n):\n    return xs[-n:] if n > 0 else []",
     "def last_n(xs, n):\n    return xs[-n - 1:] if n > 0 else []", "the slice starts one item early and returns n + 1 items"),
    ("count the vowels in a string", "def vowels(s):\n    return sum(c in 'aeiouAEIOU' for c in s)",
     "def vowels(s):\n    return sum(c in 'aeiou' for c in s)", "it misses upper-case vowels"),
    ("check whether a year is a leap year", "def leap(y):\n    return y % 4 == 0 and (y % 100 != 0 or y % 400 == 0)",
     "def leap(y):\n    return y % 4 == 0 and y % 100 != 0", "it treats 2000 and other years divisible by 400 as non-leap"),
    ("return the largest number in a non-empty list", "def largest(xs):\n    m = xs[0]\n    for x in xs:\n        if x > m:\n            m = x\n    return m",
     "def largest(xs):\n    m = 0\n    for x in xs:\n        if x > m:\n            m = x\n    return m", "starting from 0 gives 0 for a list of negative numbers"),
    ("reverse the words in a sentence", "def rev_words(s):\n    return ' '.join(s.split()[::-1])",
     "def rev_words(s):\n    return ' '.join(s.split())[::-1]", "it reverses the characters of the whole string, not the word order"),
]


def build_code(rng, flaw):
    job, good, bad, why = rng.choice(CODE)
    task = rng.choice([f"Write a Python function to {job}.", f"Python: {job}.", f"Implement a function that will {job}."])
    out = bad if flaw else good
    claims = [f"the function to {job}"]
    wrong = {"claim": "the implementation", "fix": "see the error", "why": why, "kind": "code_bug"} if flaw else None
    return task, out, claims, wrong


BUILDERS = {"fact": build_fact, "calc": build_calc, "summary": build_summary, "cited": build_cited, "code": build_code}

# ---------------------------------------------------------------------------
# Evaluations
# ---------------------------------------------------------------------------

def render(rng, rating, score, strengths, errors, style):
    op, cl = rng.choice(OPENERS), rng.choice(CLOSERS)
    if style == "json":
        return json.dumps({"rating": rating, "score": score, "strengths": strengths, "errors": errors})
    if style == "lines":
        e = "; ".join(errors) if errors else "none found"
        return "\n".join(x for x in [op, f"Rating: {rating}", f"Score: {score}/10", f"Strengths: {'; '.join(strengths)}", f"Errors: {e}", cl] if x)
    e = (" Errors: " + " ".join(f"{x[0].upper() + x[1:]}." for x in errors)) if errors else " I found no errors."
    return f"{(op + ' ') if op else ''}{rating}, {score}/10. The output {strengths[0]}{(' and ' + strengths[1]) if len(strengths) > 1 else ''}.{e}{(' ' + cl) if cl else ''}"


rng_shared = random.Random(0)


def error_text(w):
    if w["kind"] == "code_bug":
        return f"the function has a bug: {w['why']}"
    if w["fix"] in ("remove it", "remove it or find a source"):
        return f"'{w['claim']}' is not supported: {w['why']}"
    if w["kind"] == "wrong_citation" and w["fix"].startswith("cite"):
        return f"'{w['claim']}' cites the wrong source: {w['why']}"
    if w["kind"] == "wrong_fact" and rng_shared.random() < 0.5:
        return f"'{w['claim']}' is wrong: " + rng_shared.choice([f"the correct value is {w['fix']}", f"it should read {w['fix']}"]) + f" (should be {w['fix']})"
    return f"'{w['claim']}' is wrong: {w['why']} (should be {w['fix']})"


def fake_error(rng, truth, claims, out_kind, avoid=None):
    """An error in the same words a real one uses, about a claim that is in fact correct (or the wrong fix)."""
    pool = [c for c in claims if c != avoid] or claims
    c = rng.choice(pool)
    nums = [t for t in c.replace("$", " ").replace("%", " ").split() if t.replace(".", "", 1).isdigit()]
    if nums:
        v = float(nums[0])
        if v.is_integer() and 1000 <= v <= 2100:      # a year: a near miss
            alt = str(int(v) + rng.choice([-3, -2, -1, 1, 2, 3]))
        elif v.is_integer() and v < 120:              # a small count: a near miss
            alt = str(max(1, int(v) + rng.choice([-2, -1, 1, 2])))
        else:
            alt = f"{round(v * rng.choice([0.9, 1.1, 1.25, 0.8]), 2):g}"
    else:
        alt = rng.choice(NAMES + [x[1] for x in CAPITALS] + [x[2] for x in CAPITALS])
    if out_kind == "code":
        other = rng.choice([x for x in CODE if x[3] != (truth or {}).get("why")])
        return f"the function has a bug: {other[3]}"
    if out_kind == "calc" and nums:
        a, b = int(float(nums[0])), rng.randint(2, 40)
        return f"'{c}' is wrong: {a} + {b} = {a + b} (should be {a + b})"
    if out_kind == "summary":
        if rng.random() < 0.5:
            return f"'{c}' is not supported: the passage says nothing about this"
        return f"'{c}' is wrong: the passage says {alt} (should be {alt})"
    if out_kind == "cited":
        if rng.random() < 0.5:
            return f"'{c}' cites the wrong source: the claim is in a different source"
        return f"'{c}' is not supported: neither source mentions it"
    return f"'{c}' is wrong: " + rng.choice([f"the correct value is {alt}", f"it should read {alt}"]) + f" (should be {alt})"


def better(rng, truth, claims, style):
    st = rng.sample(STRENGTHS, 2)
    if truth is None:
        rating = rng.choice(["Excellent", "Good"])
        return render(rng, rating, score_for(rating, rng), st, [], style)
    rating = rng.choice(["Poor", "Fails", "Acceptable"])
    return render(rng, rating, score_for(rating, rng), st[:1], [error_text(truth)], style)


def worse(rng, truth, claims, style, task_kind):
    return worse_(rng, truth, claims, style, task_kind)


def worse_(rng, truth, claims, style, task_kind):
    st = rng.sample(STRENGTHS, 2)
    if truth is None:
        kind = rng.choice(["invented_error", "inconsistent"])
    else:
        kind = rng.choices(["missed_error", "wrong_target", "bad_correction", "inconsistent"], weights=[50, 15, 15, 20])[0]
        if task_kind == "code" and kind in ("wrong_target", "bad_correction"):
            kind = "missed_error"
    if kind == "missed_error":
        rating = rng.choice(["Excellent", "Good"])
        return kind, render(rng, rating, score_for(rating, rng), st, [], style)
    if kind == "invented_error":
        rating = rng.choice(["Poor", "Fails", "Acceptable"])
        return kind, render(rng, rating, score_for(rating, rng), st[:1], [fake_error(rng, None, claims, task_kind)], style)
    if kind == "wrong_target":
        rating = rng.choice(["Poor", "Fails", "Acceptable"])
        return kind, render(rng, rating, score_for(rating, rng), st[:1], [fake_error(rng, truth, claims, task_kind, avoid=truth["claim"])], style)
    if kind == "bad_correction":
        fix = truth["fix"]
        alt = None
        for tok in fix.replace("$", "").replace("%", "").split():
            try:
                v = float(tok); alt = fix.replace(tok, f"{v * rng.choice([1.1, 0.9, 2]):g}"); break
            except ValueError:
                continue
        if alt is None:
            alt = rng.choice([n for n in NAMES + [x[1] for x in CAPITALS] if n not in fix])
        rating = rng.choice(["Poor", "Fails", "Acceptable"])
        why = truth["why"]
        for tok in truth["fix"].replace("$", " ").replace("%", " ").split():
            why = why.replace(tok, alt.replace("$", "").replace("%", "").split()[0] if alt.replace("$", "").replace("%", "").split() else tok)
        return kind, render(rng, rating, score_for(rating, rng), st[:1], [f"'{truth['claim']}' is wrong: {why} (should be {alt})"], style)
    if kind == "inconsistent":
        if truth is None:
            if rng.random() < 0.6:
                return kind, render(rng, rng.choice(["Excellent", "Good"]), rng.choice([1, 2, 3, 2.5]), st, [], style)
            return kind, render(rng, rng.choice(["Poor", "Fails", "Acceptable"]), rng.choice([9, 10, 8.5]), st, [], style)
        rating, score = rng.choice(["Excellent", "Good"]), rng.choice([9, 9.5, 10, 8])
        return kind, render(rng, rating, score, st[:1], [error_text(truth)], style) if rng.random() < 0.5 else render(rng, "Excellent", rng.choice([2, 3, 1]), st, [], style)
    # vague
    rating = rng.choice(["Good", "Acceptable", "Excellent"])
    c = rng.choice(claims)
    filler = {"summary": f"'{c}' is not supported: the passage says nothing about this",
              "cited": f"'{c}' is not supported: neither source mentions it"}.get(
        task_kind, f"'{c}' is not supported: " + rng.choice(["the task gives no basis for it", "it should read differently"]))
    return kind, render(rng, rating, score_for(rating, rng), st, [filler], style)


PROMPTS = [
    "Evaluate this model output.\nTask: {t}\nOutput: {o}",
    "Rate the following answer for factual accuracy, support and completeness.\n\nTask:\n{t}\n\nModel output:\n{o}",
    "task: {t}\noutput: {o}",
    "Here is a model answer. Judge it: rating, score out of 10, strengths and specific errors.\nPrompt: {t}\nAnswer: {o}",
    "Check this LLM response for hallucinations and errors.\nQuestion: {t}\nResponse: {o}",
]


def make(rng):
    kind = rng.choices(list(BUILDERS), weights=[22, 20, 24, 18, 16])[0]
    flaw = rng.random() < 0.5
    task, out, claims, truth = BUILDERS[kind](rng, flaw)
    prompt = rng.choice(PROMPTS).format(t=task, o=out)
    style = rng.choice(["json", "lines", "prose"])
    wk, w = worse(rng, truth, claims, style, kind)
    return {"prompt": prompt, "chosen": better(rng, truth, claims, style), "rejected": w,
            "label_kind": "preference_pair", "worse_kind": wk, "output_kind": kind}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=1200)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    rng = random.Random(a.seed)
    seen, rows = set(), []
    while len(rows) < a.n:
        r = make(rng)
        if r["rejected"] in seen or r["chosen"] == r["rejected"]:
            continue
        seen.add(r["rejected"])
        rows.append(r)
    with open(a.out, "w") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")
    print(f"wrote {len(rows)} rows to {a.out}")


if __name__ == "__main__":
    main()
