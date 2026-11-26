"""Build SLA_COMPLIANCE_GENERAL preference pairs from vendors' own status pages.

    python3 -I evaluator/sla-pairs/build.py <dir with inc-<host>.json> > evaluator/sla-pairs/pairs.jsonl

Each inc-<host>.json is the vendor's https://<host>/api/v2/incidents.json
(Atlassian Statuspage, the latest 50 incidents). A period is used only when it
lies wholly inside the covered window (after the oldest listed incident and
before the newest one was fetched), so no incident in it can be missing.

Outage minutes = the time between started_at (or created_at) and resolved_at
of every incident the vendor itself marked "major" or "critical", clipped to
the period and merged where incidents overlap. The SLA target is stated in
each question, so the verdict follows from the vendor's data and the target,
not from a contract we would have to interpret.

The better answer gives the measured uptime, the target, the minutes counted
and the verdict. The worse answer makes one clear mistake: wrong arithmetic,
the wrong verdict for its own numbers, no measurement at all, or the wrong
period.
"""
import json, sys, os, difflib, re
from datetime import datetime, timedelta, timezone

VENDORS = {
    'www.githubstatus.com': 'GitHub',
    'www.vercel-status.com': 'Vercel',
    'status.digitalocean.com': 'DigitalOcean',
    'www.netlifystatus.com': 'Netlify',
    'status.npmjs.org': 'npm',
    'www.cloudflarestatus.com': 'Cloudflare',
    'status.openai.com': 'OpenAI',
}
FETCHED = datetime(2026, 11, 26, tzinfo=timezone.utc)
MAX_PER_VENDOR = 14


def ts(s):
    return datetime.fromisoformat(s.replace('Z', '+00:00')).astimezone(timezone.utc)


def load(path):
    inc = json.load(open(path))['incidents']
    oldest = min(ts(i['created_at']) for i in inc)
    spans = []
    for i in inc:
        if i.get('impact') not in ('major', 'critical') or not i.get('resolved_at'):
            continue
        a, b = ts(i.get('started_at') or i['created_at']), ts(i['resolved_at'])
        if b > a:
            spans.append((a, b))
    return oldest, sorted(spans)


def outage_minutes(spans, start, end):
    cut = [(max(a, start), min(b, end)) for a, b in spans if b > start and a < end]
    total, cur = 0.0, None
    for a, b in sorted(cut):
        if cur and a <= cur[1]:
            cur = (cur[0], max(cur[1], b))
        else:
            if cur:
                total += (cur[1] - cur[0]).total_seconds()
            cur = (a, b)
    if cur:
        total += (cur[1] - cur[0]).total_seconds()
    return round(total / 60, 1)


def periods(oldest):
    """Calendar months, half months and ISO weeks wholly inside the window."""
    out = []
    m = datetime(oldest.year, oldest.month, 1, tzinfo=timezone.utc)
    while True:
        nxt = datetime(m.year + (m.month == 12), m.month % 12 + 1, 1, tzinfo=timezone.utc)
        if nxt > FETCHED:
            break
        if m >= oldest:
            out.append((m.strftime('%B %Y'), m, nxt, 'month'))
            mid = m.replace(day=16)
            out.append((f"1-15 {m.strftime('%B %Y')}", m, mid, 'half'))
            out.append((f"16-{(nxt - timedelta(days=1)).day} {m.strftime('%B %Y')}", mid, nxt, 'half'))
        m = nxt
    w = oldest + timedelta(days=(7 - oldest.weekday()) % 7)
    w = w.replace(hour=0, minute=0, second=0, microsecond=0)
    if w < oldest:
        w += timedelta(days=7)
    while w + timedelta(days=7) <= FETCHED:
        e = w + timedelta(days=7)
        out.append((f"the week of {w.strftime('%-d %B %Y')} (Monday to Sunday, UTC)", w, e, 'week'))
        w = e
    return out


PROMPTS = [
    "Did {v} meet a {t}% uptime SLA in {p}?",
    "Was {v} SLA-compliant for {p}, if the contract promises {t}% availability?",
    "Our contract with {v} guarantees {t}% uptime. Check {p}: was the SLA met or breached?",
    "Using {v}'s public status page, what was its uptime over {p}, and does that clear a {t}% target?",
    "{v} uptime for {p} against a {t}% SLA: compliant or not?",
    "I pay for {v} with a {t}% availability commitment. How much downtime did it have in {p} and did it miss the commitment?",
    "Measure {v}'s availability for {p}. Target is {t}%.",
    "SLA check, {v}, {p}, target {t}% - what is the measured uptime percentage?",
    "Could we claim an SLA credit from {v} for {p}? Their promise is {t}% uptime.",
    "How available was {v} during {p}, counting the outages it reported itself, versus a {t}% SLA?",
    "Is {v} within its {t}% SLA for {p}? Give the uptime figure.",
    "Compute {v}'s {p} uptime from its incident history and compare it with {t}%.",
    "Procurement wants to know whether {v} kept to {t}% availability in {p}.",
    "Our vendor review covers {p}. {v} commits to {t}% uptime - did it deliver?",
    "Before renewing {v}: across {p}, was availability at or above {t}%?",
    "Give me {v}'s downtime minutes and uptime % for {p}; the SLA we signed says {t}%.",
    "Finance asks: does {v} owe us a service credit for {p} under a {t}% uptime clause?",
    "{p} - {v}. Promised availability {t}%. Measured availability?",
    "Audit {v} for {p}: incident minutes, uptime, and whether {t}% held.",
    "Has {v} honoured {t}% availability throughout {p}?",
]
TARGETS = ['99.9', '99.95', '99.99', '99.5', '99.9', '99.95']


def fmt(x):
    s = f"{x:.4f}".rstrip('0').rstrip('.')
    return s


def answer(v, p, up, t, mins, allowed, ok, n_days):
    verdict = 'met' if ok else 'breached'
    return (f"{fmt(up)}% uptime for {v} over {p}, against a {t}% SLA target, so the SLA was {verdict}. "
            f"{v}'s status page marks {mins} minutes of major or critical outage in that period "
            f"({n_days} days, {int(n_days * 1440)} minutes); a {t}% target allows {fmt(allowed)} minutes. "
            f"compliant: {'true' if ok else 'false'}.")


def worse(kind, v, p, up, t, mins, ok, n_days, other_p):
    verdict = 'met' if ok else 'breached'
    if kind == 'arith':
        # minutes treated as hours: a typical unit slip
        bad = max(0.0, 100 * (1 - mins * 60 / (n_days * 1440))) if mins else 100 - 0.05
        bad_ok = bad >= float(t)
        return (f"{fmt(bad)}% uptime for {v} over {p} against {t}%, so the SLA was "
                f"{'met' if bad_ok else 'breached'}. ({mins} hours of outage.)")
    if kind == 'flip':
        return (f"{fmt(up)}% uptime for {v} over {p}. That is {'below' if ok else 'above'} the {t}% target, "
                f"so the SLA was {'breached' if ok else 'met'}.")
    if kind == 'vague':
        return (f"{v} is a reliable provider and had only minor issues in {p}, "
                f"so it almost certainly met its SLA.")
    if kind == 'notarget':
        return (f"{v} had {mins} minutes of outage in {p}. Uptime was high overall.")
    if kind == 'period':
        return (f"{fmt(up)}% uptime for {v} in {other_p}, so the SLA was {verdict}.")
    raise ValueError(kind)


def main(src):
    rows, kept = [], []
    per = []
    for host, v in VENDORS.items():
        path = os.path.join(src, f'inc-{host}.json')
        if not os.path.exists(path):
            continue
        oldest, spans = load(path)
        ps = periods(max(oldest, FETCHED - timedelta(days=365)))
        order = sorted(ps, key=lambda x: ({'month': 0, 'half': 1, 'week': 2}[x[3]], -x[1].timestamp()))
        per.append([(host, v, spans, p, a, b, ps) for (p, a, b, _k) in order][:MAX_PER_VENDOR])
    combos = [c for tier in zip(*[x + [None] * (max(map(len, per)) - len(x)) for x in per]) for c in tier if c]
    kinds = ['flip', 'arith', 'vague', 'notarget', 'period']
    for i, (host, v, spans, p, a, b, ps) in enumerate(combos):
        t = TARGETS[i % len(TARGETS)]
        n_days = (b - a).days
        total = n_days * 1440
        mins = outage_minutes(spans, a, b)
        up = 100 * (1 - mins / total)
        allowed = total * (1 - float(t) / 100)
        ok = mins <= allowed + 1e-9
        q = PROMPTS[(i * 5) % len(PROMPTS)].format(v=v, p=p, t=t)
        norm = re.sub(r'\s+', ' ', q.lower())
        if any(difflib.SequenceMatcher(None, norm, k).ratio() >= 0.8 for k in kept):
            # try the other phrasings before giving up on this period
            for k2 in range(1, len(PROMPTS)):
                q = PROMPTS[(i * 5 + k2) % len(PROMPTS)].format(v=v, p=p, t=t)
                norm = re.sub(r'\s+', ' ', q.lower())
                if not any(difflib.SequenceMatcher(None, norm, k).ratio() >= 0.8 for k in kept):
                    break
            else:
                continue
        kept.append(norm)
        others = [x[0] for x in ps if x[0] != p]
        kind = kinds[i % len(kinds)]
        if kind == 'period' and not others:
            kind = 'flip'
        other = others[0] if others else None
        rows.append({
            'prompt': q,
            'chosen': answer(v, p, up, t, mins, allowed, ok, n_days),
            'rejected': worse(kind, v, p, up, t, mins, ok, n_days, other),
            'label_kind': 'preference_pair',
            'intent_id': 'SLA_COMPLIANCE_GENERAL',
            'provenance': {'source_kind': 'vendor_status_page', 'source_url': f'https://{host}/history'},
        })
    for r in rows:
        assert r['chosen'] != r['rejected'] and len(r['prompt']) >= 16
        sys.stdout.write(json.dumps(r, ensure_ascii=False) + '\n')
    sys.stderr.write(f'{len(rows)} rows from {len(combos)} vendor periods\n')


if __name__ == '__main__':
    main(sys.argv[1])
