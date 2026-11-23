"""Replay a logged node batch through a runnable URL and count pairs where the first text scores higher:
python3 replay-log.py BODYLOG LINE URL"""
import json, struct, sys, urllib.request
log, n, url = sys.argv[1], int(sys.argv[2]), sys.argv[3]
d = json.loads(open(log).read().splitlines()[n])
body = d["body"].encode().decode("unicode_escape")
req = urllib.request.Request(url, data=body.encode(), headers={"Content-Type": "application/json"})
res = json.loads(urllib.request.urlopen(req, timeout=1900).read())
s = [struct.unpack("<f", struct.pack("<I", r["score"]))[0] for r in res["results"]]
pairs = [(s[2*i], s[2*i+1]) for i in range(len(s)//2)]
print(json.dumps({"pairs": len(pairs), "first_higher": sum(a > b for a, b in pairs), "ties": sum(a == b for a, b in pairs),
                  "scores": [[round(a, 3), round(b, 3)] for a, b in pairs]}))
