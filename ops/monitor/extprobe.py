#!/usr/bin/env python3
"""External availability probe, meant to run on a machine that is NOT the main server (worker-01):
GET https://api.1dayapi.com/health and GET /v1/models with a consumer key (keys.txt: consumer=...).
Two consecutive failures raise an alert through alert.py; recovery is announced once.
Runs every 2 minutes from the 1dayapi-extprobe.timer unit."""
import json, os, sys, time, urllib.request, urllib.error

D = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, D)
import alert  # noqa: E402

G = "https://api.1dayapi.com"
for k in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"):
    os.environ.pop(k, None)
keys = {}
try:
    keys = dict(l.strip().split("=", 1) for l in open(os.path.join(D, "keys.txt")) if "=" in l)
except FileNotFoundError:
    pass


def get(path, headers=None, timeout=20):
    req = urllib.request.Request(G + path, headers={"user-agent": "1dayapi-extprobe/1.0", **(headers or {})})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")[:300], round((time.time() - t0) * 1000)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")[:300], round((time.time() - t0) * 1000)
    except Exception as e:
        return 0, f"EXC {type(e).__name__}: {e}", round((time.time() - t0) * 1000)


results = {}
st, body, ms = get("/health")
results["health"] = {"ok": st == 200 and '"ok"' in body, "status": st, "ms": ms, "err": None if st == 200 else body}
if keys.get("consumer"):
    st, body, ms = get("/v1/models", {"authorization": f"Bearer {keys['consumer']}"})
    results["models"] = {"ok": st == 200, "status": st, "ms": ms, "err": None if st == 200 else body}
failed = [k for k, v in results.items() if not v["ok"]]
line = {"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "results": results}
with open(os.path.join(D, "extprobe.jsonl"), "a") as f:
    f.write(json.dumps(line) + "\n")
print(line["ts"], json.dumps({k: (v["ok"], v["status"], v["ms"]) for k, v in results.items()}))
alert.evaluate(failed, "extprobe", "; ".join(f"{k}: HTTP {results[k]['status']} {results[k]['err'] or ''}" for k in failed)[:400])
