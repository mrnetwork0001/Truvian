#!/usr/bin/env python3
"""Drop held-out pairs whose negative appears in the training set, keep the first N:
python3 dedupe_test.py TRAIN.jsonl TEST_IN.jsonl TEST_OUT.jsonl N"""
import json, sys
train = {json.loads(l)["rejected"] for l in open(sys.argv[1])}
n = int(sys.argv[4])
out = [l for l in open(sys.argv[2]) if json.loads(l)["rejected"] not in train][:n]
if len(out) < n:
    sys.exit(f"only {len(out)} of {n} held-out pairs are new")
open(sys.argv[3], "w").writelines(out)
print(f"kept {n} held-out pairs")
