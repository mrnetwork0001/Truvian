#!/usr/bin/env python3
"""Version 2 training pairs for the LLM_OUTPUT_EVALUATION adapter.

v1 (generate_pairs.py) ordered 7 of the node's 15 public pairs (registration
211, 2026-11-23). The node's pairs were of four kinds, and v1 had only part
of one. v2 covers all four, generated from facts and wording of our own; no
pool row and no text of the captured batch is in the data.

  evaluation   an evaluation of a model output, in the styles the pool uses
               ("Verdict: Poor, 2 out of 10. Errors: ... Strengths: ...",
               "Rating: Good. Score: 8/10. ...", JSON rating/score/strengths/
               errors). Outputs are v1's checked builders plus common
               misconceptions and false-premise questions. The better
               evaluation's rating matches the output's truth.
  answer       a direct answer to a factual question: the right fact against
               a wrong one of the same type
  extract      a question about a passage given in the prompt: the passage's
               sentence word for word against the same sentence with a phrase
               swapped for one from elsewhere in the passage
  scenario     a workflow case ("case 4 concerns a missed renewal"): an answer
               that names the case's issue, its consequence and a bounded next
               step against one that stays generic

Output: JSONL rows {prompt, chosen, rejected, pair_kind, worse_kind}.
"""
import argparse
import importlib.util
import json
import os
import random

_spec = importlib.util.spec_from_file_location("v1", os.path.join(os.path.dirname(os.path.abspath(__file__)), "generate_pairs.py"))
v1 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(v1)

# ---------------------------------------------------------------------------
# Evaluation pairs, in the pool's styles
# ---------------------------------------------------------------------------

EVAL_PROMPTS = [
    "Judge the following output against its task. Task: {t} Output: {o}",
    "[task] {t} [output] {o}",
    "Prompt given to the model: {t} Model output: {o} How good is the output?",
    "Evaluate this model output. Prompt: {t} Response: {o}",
    "Rate the answer to the task \"{t}\": {o}",
    "Task: {t} Output: {o}",
    "Evaluate this model output.\nTask: {t}\nOutput: {o}",
    "task: {t}\noutput: {o}",
]
NONE_STRENGTHS = ["none noted", "nothing notable", "none to credit"]
NONE_ERRORS = ["none", "none found", "none noted"]


def render(rng, rating, score, strengths, errors, style):
    if style == "verdict":
        e = "; ".join(errors) if errors else rng.choice(NONE_ERRORS)
        s = "; ".join(strengths) if strengths else rng.choice(NONE_STRENGTHS)
        return f"Verdict: {rating}, {score:g} out of 10. Errors: {e}. Strengths: {s}."
    if style == "rating":
        e = "; ".join(errors) if errors else rng.choice(NONE_ERRORS)
        s = "; ".join(strengths) if strengths else rng.choice(NONE_STRENGTHS)
        return f"Rating: {rating}. Score: {score:g}/10. Strengths: {s}. Errors: {e}."
    if style == "json":
        return json.dumps({"rating": rating, "score": score, "strengths": strengths, "errors": errors})
    return v1.render(rng, rating, score, strengths or [rng.choice(v1.STRENGTHS)], errors, "lines")


# Common misconceptions: (question, the misconception as an answer, the established answer)
MYTHS = [
    ("What percentage of the brain do people use?", "People use only 10% of their brains.", "people use virtually all of the brain"),
    ("Can lightning strike the same place twice?", "Lightning never strikes the same place twice.", "lightning often strikes the same place, especially tall structures"),
    ("Did Viking warriors wear horned helmets?", "Yes, Viking warriors wore horned helmets into battle.", "there is no evidence Vikings wore horned helmets in battle"),
    ("Is the Great Wall of China visible from space with the naked eye?", "Yes, the Great Wall is the only man-made structure visible from space.", "it is not visible to the naked eye from orbit"),
    ("Does sugar make children hyperactive?", "Yes, eating sugar makes children hyperactive.", "controlled studies find no effect of sugar on children's behaviour"),
    ("How long is a goldfish's memory?", "A goldfish's memory lasts about three seconds.", "goldfish can remember things for months"),
    ("Does shaving make hair grow back thicker?", "Shaving makes hair grow back thicker and darker.", "shaving does not change the thickness or colour of hair"),
    ("Do bulls get angry at the colour red?", "Bulls are enraged by the colour red.", "bulls are colour-blind to red and react to the movement of the cape"),
    ("Is blood in human veins blue?", "Blood in your veins is blue until it touches oxygen.", "blood is always red; veins look blue because of how skin scatters light"),
    ("How many senses do humans have?", "Humans have exactly five senses.", "humans have more than five senses, including balance and temperature"),
    ("Do different parts of the tongue taste different flavours?", "The tip of the tongue tastes sweet and the back tastes bitter.", "all taste qualities are sensed across the whole tongue"),
    ("What happens if you swallow chewing gum?", "Swallowed gum stays in your stomach for seven years.", "swallowed gum passes through the digestive system in a few days"),
    ("Do ostriches bury their heads in the sand?", "Ostriches bury their heads in the sand when frightened.", "ostriches do not bury their heads; they lie low to the ground"),
    ("Did Napoleon Bonaparte have unusually short stature?", "Napoleon was extremely short, about five feet tall.", "Napoleon was of average height for his time, about 1.69 m"),
    ("Does cracking your knuckles cause arthritis?", "Cracking your knuckles causes arthritis.", "studies find no link between knuckle cracking and arthritis"),
    ("Are bats blind?", "Bats are blind and rely only on echolocation.", "bats can see, and many species see well"),
    ("Does cold weather cause colds?", "Being cold gives you a cold.", "colds are caused by viruses, not by low temperature itself"),
    ("Did Albert Einstein fail mathematics at school?", "Einstein failed maths as a student.", "Einstein excelled at mathematics at school"),
    ("What do camels store in their humps?", "Camels store water in their humps.", "camel humps store fat, not water"),
    ("Do we lose most of our body heat through our heads?", "Most body heat escapes through the head.", "the head loses heat roughly in proportion to its surface area"),
]

# False premises: (question with a false premise, an answer that corrects it, an answer that accepts it, why)
PREMISES = [
    ("How many legs does a snake use to walk?", "Snakes have no legs; they move by contracting their muscles against the ground.",
     "A snake walks on four short legs hidden under its scales.", "snakes have no legs"),
    ("In which year did Marie Curie win the Nobel Prize in Literature?", "Marie Curie never won the Nobel Prize in Literature; her Nobel Prizes were in Physics (1903) and Chemistry (1911).",
     "Marie Curie won the Nobel Prize in Literature in 1911.", "her prizes were in physics and chemistry"),
    ("What colour are a penguin's flight feathers in the Arctic?", "Penguins do not live in the Arctic, and they cannot fly; they live in the Southern Hemisphere.",
     "Arctic penguins have grey flight feathers that turn white in winter.", "penguins neither fly nor live in the Arctic"),
    ("How many moons does the Sun have?", "The Sun is a star and has no moons; moons orbit planets.",
     "The Sun has three small moons that orbit close to its surface.", "moons orbit planets, not the Sun"),
    ("Which ocean lies between Spain and Portugal?", "No ocean lies between Spain and Portugal; they share a land border on the Iberian Peninsula.",
     "The Iberian Ocean lies between Spain and Portugal.", "the two countries share a land border"),
    ("How long did Shakespeare live in New York?", "Shakespeare never lived in New York; he lived in England and died in 1616.",
     "Shakespeare lived in New York for about six years before returning to London.", "he never travelled to America"),
    ("What is the boiling point of water on the surface of the Sun?", "Water cannot exist as a liquid on the Sun's surface, which is about 5,500 °C, so there is no boiling point there.",
     "On the Sun's surface water boils at about 400 °C.", "liquid water cannot exist on the Sun"),
    ("How many teeth does a chicken have?", "Chickens have no teeth; they grind food in their gizzard.",
     "An adult chicken has about 24 teeth.", "birds have no teeth"),
    ("Which planet is closer to the Sun, Earth or the Moon?", "The Moon is not a planet; it orbits Earth, so on average both are the same distance from the Sun.",
     "The Moon is the planet closer to the Sun.", "the Moon is Earth's satellite, not a planet"),
    ("Why did Isaac Newton invent the telephone?", "Isaac Newton did not invent the telephone; telephones were developed in the 1870s, long after Newton's death in 1727.",
     "Newton invented the telephone to talk to colleagues at the Royal Society.", "the telephone came about 150 years after Newton"),
]


def eval_myth(rng, flaw):
    q, myth, truth = rng.choice(MYTHS)
    good = f"{truth[0].upper()}{truth[1:]}."
    return q, (myth if flaw else good), myth, truth


def eval_premise(rng, flaw):
    q, right, wrong, why = rng.choice(PREMISES)
    return q, (wrong if flaw else right), wrong, why


def eval_pair(rng):
    style = rng.choice(["verdict", "rating", "json", "verdict", "rating"])
    src = rng.choices(["v1", "myth", "premise"], [50, 30, 20])[0]
    flaw = rng.random() < 0.5
    if src == "v1":
        kind = rng.choices(list(v1.BUILDERS), weights=[30, 20, 24, 16, 10])[0]
        task, out, claims, truth = v1.BUILDERS[kind](rng, flaw)
        err = [v1.error_text(truth)] if truth else []
        claim = truth["claim"] if truth else rng.choice(claims)
    elif src == "myth":
        task, out, myth, est = eval_myth(rng, flaw)
        claim = out
        counter = myth[0].lower() + myth[1:].rstrip(".")
        err = [rng.choice([f"States '{myth}', which contradicts the well-established answer: {est}",
                           f"'{myth}' is a common misconception; in fact {est}"])] if flaw else []
        kind = "myth"
    else:
        task, out, wrong, why = eval_premise(rng, flaw)
        claim = out
        counter = why
        err = [rng.choice([f"The output accepts the false premise of the question: {why}",
                           f"'{wrong}' is not true: {why}"])] if flaw else []
        kind = "premise"
    prompt = rng.choice(EVAL_PROMPTS).format(t=task, o=out)
    st_pool = v1.STRENGTHS + ["Answers in a single clear statement", "Direct and concise", "Written in fluent English",
                              "Tone is neutral and professional", "Addresses the question directly"]
    st = rng.sample(st_pool, 2)
    supported = f"The claim '{claim}' is supported by the common understanding of the topic"
    generic_err = f"The output contains a factual error: '{claim}' is not supported"
    if flaw:
        if rng.random() < 0.3:
            err = [generic_err]
        g_rating = rng.choice(["Poor", "Fails", "Poor", "Acceptable"])
        good = render(rng, g_rating, v1.score_for(g_rating, rng), st[:1] if rng.random() < 0.6 else [], err, style)
        wk = rng.choices(["missed_error", "inconsistent", "praise_false"], [55, 20, 25])[0]
        b_rating = rng.choice(["Excellent", "Good"])
        if wk == "missed_error":
            bad = render(rng, b_rating, v1.score_for(b_rating, rng), st, [], style)
        elif wk == "inconsistent":
            bad = render(rng, b_rating, rng.choice([9, 10, 8]), st[:1], err, style)
        else:
            bad = render(rng, b_rating, v1.score_for(b_rating, rng), [supported] + st[:1], [], style)
    else:
        g_rating = rng.choice(["Excellent", "Good"])
        good = render(rng, g_rating, v1.score_for(g_rating, rng), ([supported] + st[:1]) if rng.random() < 0.35 else st, [], style)
        wk = rng.choices(["invented_error", "inconsistent"], [75, 25])[0]
        b_rating = rng.choice(["Poor", "Fails", "Acceptable"])
        if wk == "invented_error":
            if rng.random() < 0.3:
                fe = generic_err
            elif src == "v1":
                fe = v1.fake_error(rng, None, claims, kind)
            elif src == "myth":
                fe = rng.choice([f"States '{out}', which contradicts the well-established answer: {counter}",
                                 f"'{out}' is a common misconception; in fact {counter}"])
            else:
                fe = rng.choice([f"The output accepts the false premise of the question: {counter}",
                                 f"'{out}' is not true: {counter}"])
            bad = render(rng, b_rating, v1.score_for(b_rating, rng), st[:1] if rng.random() < 0.5 else [], [fe], style)
        else:
            bad = render(rng, b_rating, rng.choice([9, 8, 10]), st, [], style)
    return dict(prompt=prompt, chosen=good, rejected=bad, pair_kind="evaluation", worse_kind=wk)


# ---------------------------------------------------------------------------
# Direct answers
# ---------------------------------------------------------------------------

# (question, answer template with {}, right value, wrong values)
FACTS = [
    ("Who wrote the novel Pride and Prejudice?", "Pride and Prejudice was written by {}.", "Jane Austen", ["Charlotte Bronte", "George Eliot", "Mary Shelley"]),
    ("Who painted the Mona Lisa?", "The Mona Lisa was painted by {}.", "Leonardo da Vinci", ["Michelangelo", "Raphael", "Titian"]),
    ("Who developed the theory of general relativity?", "The theory of general relativity was developed by {}.", "Albert Einstein", ["Niels Bohr", "Max Planck", "Isaac Newton"]),
    ("Who composed the Moonlight Sonata?", "The Moonlight Sonata was composed by {}.", "Ludwig van Beethoven", ["Wolfgang Amadeus Mozart", "Frederic Chopin", "Franz Schubert"]),
    ("Who wrote One Hundred Years of Solitude?", "One Hundred Years of Solitude was written by {}.", "Gabriel Garcia Marquez", ["Jorge Luis Borges", "Mario Vargas Llosa", "Isabel Allende"]),
    ("Who directed the film Jaws?", "Jaws was directed by {}.", "Steven Spielberg", ["George Lucas", "Martin Scorsese", "Francis Ford Coppola"]),
    ("Who directed the film Spirited Away?", "Spirited Away was directed by {}.", "Hayao Miyazaki", ["Isao Takahata", "Makoto Shinkai", "Mamoru Hosoda"]),
    ("Who discovered penicillin?", "Penicillin was discovered by {}.", "Alexander Fleming", ["Louis Pasteur", "Joseph Lister", "Robert Koch"]),
    ("Who was the first person to walk on the Moon?", "The first person to walk on the Moon was {}.", "Neil Armstrong", ["Buzz Aldrin", "Yuri Gagarin", "Michael Collins"]),
    ("Who proposed the theory of evolution by natural selection?", "The theory of evolution by natural selection was proposed by {}.", "Charles Darwin", ["Gregor Mendel", "Jean-Baptiste Lamarck", "Carl Linnaeus"]),
    ("In what year did the Titanic sink?", "The Titanic sank in {}.", "1912", ["1910", "1914", "1905"]),
    ("In what year did World War II end?", "World War II ended in {}.", "1945", ["1944", "1946", "1939"]),
    ("In what year did the French Revolution begin?", "The French Revolution began in {}.", "1789", ["1776", "1799", "1815"]),
    ("In what year was the World Wide Web proposed by Tim Berners-Lee?", "Tim Berners-Lee proposed the World Wide Web in {}.", "1989", ["1991", "1983", "1995"]),
    ("What is the largest planet in the Solar System?", "The largest planet in the Solar System is {}.", "Jupiter", ["Saturn", "Neptune", "Uranus"]),
    ("What is the longest river in South America?", "The longest river in South America is the {}.", "Amazon", ["Parana", "Orinoco", "Magdalena"]),
    ("What is the chemical formula of table salt?", "The chemical formula of table salt is {}.", "NaCl", ["KCl", "NaOH", "CaCl2"]),
    ("What is the hardest natural substance?", "The hardest natural substance is {}.", "diamond", ["quartz", "corundum", "topaz"]),
    ("Which element has the chemical symbol Fe?", "The element with the symbol Fe is {}.", "iron", ["fluorine", "lead", "tin"]),
    ("What is the smallest prime number?", "The smallest prime number is {}.", "2", ["1", "3", "0"]),
    ("Which country has the largest population in South America?", "The country with the largest population in South America is {}.", "Brazil", ["Argentina", "Colombia", "Peru"]),
    ("What language has the most native speakers?", "The language with the most native speakers is {}.", "Mandarin Chinese", ["English", "Spanish", "Hindi"]),
    ("Who wrote the play Romeo and Juliet?", "Romeo and Juliet was written by {}.", "William Shakespeare", ["Christopher Marlowe", "Ben Jonson", "John Webster"]),
    ("What is the capital of Canada?", "The capital of Canada is {}.", "Ottawa", ["Toronto", "Montreal", "Vancouver"]),
    ("What is the capital of Australia?", "The capital of Australia is {}.", "Canberra", ["Sydney", "Melbourne", "Perth"]),
    ("Who invented the World Wide Web?", "The World Wide Web was invented by {}.", "Tim Berners-Lee", ["Vint Cerf", "Bill Gates", "Marc Andreessen"]),
    ("Who wrote the Bitcoin white paper?", "The Bitcoin white paper was written by {}.", "Satoshi Nakamoto", ["Vitalik Buterin", "Nick Szabo", "Hal Finney"]),
    ("Who proposed Ethereum?", "Ethereum was proposed by {}.", "Vitalik Buterin", ["Gavin Wood", "Charles Hoskinson", "Satoshi Nakamoto"]),
    ("What gas do plants absorb for photosynthesis?", "For photosynthesis, plants absorb {}.", "carbon dioxide", ["oxygen", "nitrogen", "hydrogen"]),
    ("How many continents are there by the most common convention?", "By the most common convention there are {} continents.", "seven", ["six", "five", "eight"]),
]
ASK_STYLES = ["{q}", "{ql}", "Q: {q}", "Answer in one sentence: {q}"]


def answer_pair(rng):
    q, tmpl, right, wrongs = rng.choice(FACTS)
    prompt = rng.choice(ASK_STYLES).format(q=q, ql=q[0].lower() + q[1:])
    return dict(prompt=prompt, chosen=tmpl.format(right), rejected=tmpl.format(rng.choice(wrongs)), pair_kind="answer", worse_kind="wrong_fact")


# ---------------------------------------------------------------------------
# Passage extraction
# ---------------------------------------------------------------------------

TOWNS = ["Harrowgate", "Bellmere", "Kingsford", "Ashwick", "Dunmore", "Elvaston", "Farnley", "Glenrock", "Holloway", "Ivybridge",
         "Larchmont", "Millbrook", "Northam", "Oakhurst", "Pendleton", "Redcliff", "Stonehaven", "Thornbury", "Westerly", "Yarrow"]
FOUNDERS = ["Flemish weavers", "Norwegian fishermen", "Quaker merchants", "Basque shipbuilders", "Moravian missionaries",
            "Scottish miners", "Portuguese traders", "Huguenot refugees", "Welsh quarrymen", "Dutch farmers"]
THINGS = ["a stone bridge", "a lighthouse", "a covered market", "a textile mill", "a railway station", "an observatory",
          "a botanical garden", "a public library", "a canal lock", "a clock tower"]


def passage(rng):
    town, other = rng.sample(TOWNS, 2)
    f1, f2 = rng.sample(FOUNDERS, 2)
    t1, t2 = rng.sample(THINGS, 2)
    y1 = rng.randint(1620, 1780)
    y2 = y1 + rng.randint(30, 120)
    y3 = y2 + rng.randint(20, 90)
    n = rng.randrange(1200, 48000, 100)
    mi = rng.randint(6, 60)
    sents = [
        f"{town} was founded in {y1} by {f1}, who arrived from the coast and cleared the river valley for farms.",
        f"A second group, {f2}, settled {mi} miles north of {town} in a village they named {other}.",
        f"In {y2} the town built {t1}, which is now listed as a protected heritage site and draws visitors every summer.",
        f"The population reached {n:,} by {y3}, when {t2} opened beside the old market square.",
        f"Local records describe the {f1} as skilled craftsmen who traded wool, timber and salt along the river.",
    ]
    qs = [
        (0, [f"Who founded {town}?", f"When was {town} founded, and by whom?"]),
        (1, [f"Where did the {f2} settle?", f"What village did the second group name?"]),
        (2, [f"What did {town} build in {y2}?", f"Which structure in {town} is a protected heritage site?"]),
        (3, [f"What was the population of {town} by {y3}?", f"What opened beside the old market square?"]),
        (4, [f"How do local records describe the {f1}?", f"What did the {f1} trade?"]),
    ]
    return sents, qs


def extract_pair(rng):
    sents, qs = passage(rng)
    rng_order = list(range(len(sents)))
    text = " ".join(sents[i] for i in rng_order)
    i, opts = rng.choice(qs)
    q = rng.choice(opts)
    right = sents[i]
    wk = rng.choice(["swapped_phrase", "changed_word", "changed_number"])
    words = right.rstrip(".").split()
    wrong = None
    if wk == "swapped_phrase":
        other = rng.choice([s for j, s in enumerate(sents) if j != i]).rstrip(".").split()
        k = rng.randint(2, 4)
        a = rng.randrange(0, max(1, len(words) - k))
        b = rng.randrange(0, max(1, len(other) - k))
        wrong = " ".join(words[:a] + other[b:b + k] + words[a + k:]) + "."
    elif wk == "changed_number":
        idx = [j for j, w in enumerate(words) if any(ch.isdigit() for ch in w)]
        if idx:
            j = rng.choice(idx)
            digits = "".join(ch for ch in words[j] if ch.isdigit())
            alt = str(int(digits) + rng.choice([-40, -12, -3, 3, 12, 40, 100]))
            words2 = list(words)
            words2[j] = words[j].replace(digits, alt) if "," not in words[j] else f"{int(digits) + rng.choice([-900, 1100, 2500]):,}"
            wrong = " ".join(words2) + "."
    if wrong is None or wrong == right:
        wk = "changed_word"
        pool = [w for s in sents for w in s.rstrip(".").split() if len(w) > 4 and w not in words]
        j = rng.choice([j for j, w in enumerate(words) if len(w) > 4] or [0])
        words2 = list(words)
        words2[j] = rng.choice(pool)
        wrong = " ".join(words2) + "."
    head = rng.choice(["Passage: {p}\nQuestion: {q}", "{q} Context: {p}", "Context: {p}\n\n{q}", "Read the passage and answer. {p}\nQ: {q}"])
    return dict(prompt=head.format(p=text, q=q), chosen=right, rejected=wrong, pair_kind="extract", worse_kind=wk)


# ---------------------------------------------------------------------------
# Workflow scenarios: specific against generic
# ---------------------------------------------------------------------------

DOMAINS = ["an insurance claims workflow", "a payroll approval workflow", "a hospital discharge workflow", "a vendor onboarding workflow",
           "a customs clearance workflow", "a loan underwriting workflow", "a software release workflow", "a grant review workflow",
           "a building inspection workflow", "a procurement approval workflow", "a data access request workflow", "a refund handling workflow"]
ISSUES = ["a missed renewal date", "a duplicate invoice", "an expired certificate", "a mismatched account number", "an unsigned approval",
          "a late shipment", "a missing audit trail", "an overdrawn budget line", "a conflicting delivery address", "a stale exchange rate",
          "an unverified identity document", "a skipped safety check", "a rounding error in a total", "a revoked API key"]
SC_PROMPTS = [
    "For {d}, case {n} concerns {i}. Judge whether the answer is supported, follows instructions, and is safe to accept.",
    "Evaluate this answer for support and instruction following. In {d}, scenario {n} involves {i}. Give the precise conclusion and the smallest safe action.",
    "Case {n} in {d}: {i}. Is the answer specific, supported and safe to act on?",
    "Review the response for {d}. Case {n} is about {i}. Should the answer be accepted?",
]
SPECIFIC = [
    "It names {i} as the fact that matters in case {n}, says what it changes, and gives one next step with a condition that can be checked.",
    "The answer is not a general statement: it identifies {i}, states the consequence for case {n}, and sets an action so the case can be closed.",
    "It points to {i}, ties it to the facts of case {n} in {d}, and gives an action with a stated condition for closing it.",
    "The response picks out {i}, explains why case {n} cannot close until it is fixed, and proposes the smallest fix, with a check.",
    "For {d}, it names the operative fact ({i}), its consequence, and a next step that can be checked before case {n} closes.",
]
GENERIC = [
    "For {d}, it gives a general statement with no fact, consequence or next step for case {n} that can be checked.",
    "The answer offers broad reassurance about {d}, but it does not identify the fact that matters, so no action can be checked.",
    "It says case {n} should be reviewed carefully, with no fact, no consequence and no condition for closing it.",
    "The response restates the question about {d} in general terms and leaves out the operative fact, its consequence and the next step.",
    "It recommends the standard process for {d}, without naming the problem in case {n} or a step with a condition that can be checked.",
    "The answer names {i} but gives no consequence and no action, so case {n} cannot be closed on it.",
]


def scenario_pair(rng):
    d, i, n = rng.choice(DOMAINS), rng.choice(ISSUES), rng.randint(1, 12)
    prompt = rng.choice(SC_PROMPTS).format(d=d, n=n, i=i)
    return dict(prompt=prompt, chosen=rng.choice(SPECIFIC).format(i=i, n=n, d=d), rejected=rng.choice(GENERIC).format(i=i, n=n, d=d),
                pair_kind="scenario", worse_kind="generic")


KINDS = [(eval_pair, 58), (answer_pair, 12), (extract_pair, 20), (scenario_pair, 10)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=1400)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    rng = random.Random(a.seed)
    v1.rng_shared.seed(a.seed)
    seen, rows = set(), []
    tries = 0
    while len(rows) < a.n:
        tries += 1
        if tries > a.n * 50:
            raise SystemExit(f"stopped at {len(rows)} unique rows")
        f = rng.choices([k for k, _ in KINDS], [w for _, w in KINDS])[0]
        r = f(rng)
        key = r["rejected"]
        if r["chosen"] == r["rejected"] or key in seen:
            continue
        seen.add(key)
        rows.append(r)
    with open(a.out, "w") as fh:
        for r in rows:
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"wrote {len(rows)} rows to {a.out}")


if __name__ == "__main__":
    main()
