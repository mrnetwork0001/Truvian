#!/usr/bin/env python3
"""Keep the first N pairs whose both texts fit the node's 512 tokens, rendered
as the node renders them: python3 fit512.py TOKENIZER IN.jsonl OUT.jsonl N"""
import json, sys
from tokenizers import Tokenizer
tok = Tokenizer.from_file(sys.argv[1])
n = int(sys.argv[4])
fits = lambda p, a: len(tok.encode(f"### Task:\n{p}\n\n### Answer:\n{a}").ids) <= 512
out = []
for line in open(sys.argv[2]):
    r = json.loads(line)
    if fits(r["prompt"], r["chosen"]) and fits(r["prompt"], r["rejected"]):
        out.append(line)
    if len(out) == n:
        break
if len(out) < n:
    sys.exit(f"only {len(out)} of {n} pairs fit")
open(sys.argv[3], "w").writelines(out)
print(f"kept {n} pairs")
