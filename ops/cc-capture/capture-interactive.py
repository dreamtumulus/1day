#!/usr/bin/env python3
"""Interactive-mode capture: run <binary> in a pty with onboarding pre-seeded, type a prompt,
wait for the /v1/messages request to reach the local capture server, then kill it.
usage: cc-interactive.py <binary> <tag> <model> [extra args...]"""
import json, os, pty, select, signal, subprocess, sys, time
BIN, TAG, MODEL = sys.argv[1], sys.argv[2], sys.argv[3]
EXTRA = sys.argv[4:]
D = "/root/cc-upgrade"; OUT = f"{D}/capture-{TAG}.ndjson"; open(OUT, "w").close()
srv = subprocess.Popen(["node", f"{D}/capsrv.mjs", OUT]); time.sleep(0.5)
H = f"{D}/home-int-{TAG}"; os.system(f"rm -rf {H}"); os.makedirs(f"{H}/cfg", exist_ok=True); os.makedirs(f"{H}/work", exist_ok=True)
cwd = f"{H}/work"
cfg = {"hasCompletedOnboarding": True, "theme": "dark", "numStartups": 5, "hasSeenTasksHint": True, "autoUpdates": False,
       "projects": {cwd: {"hasTrustDialogAccepted": True, "allowedTools": [], "hasCompletedProjectOnboarding": True}}}
json.dump(cfg, open(f"{H}/cfg/.claude.json", "w"))
env = {"PATH": os.environ["PATH"], "HOME": H, "TMPDIR": H, "CLAUDE_CONFIG_DIR": f"{H}/cfg", "ANTHROPIC_BASE_URL": "http://127.0.0.1:18999",
       "CLAUDE_CODE_OAUTH_TOKEN": "sk-ant-oat01-capture-dummy-token-0000000000000000000000000000000000000000",
       "DISABLE_AUTOUPDATER": "1", "DISABLE_TELEMETRY": "1", "TERM": "xterm-256color", "COLUMNS": "120", "LINES": "40", "LANG": "C.UTF-8"}
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.execve(BIN, [BIN, "--model", MODEL, *EXTRA], env)
buf = b""
def pump(sec):
    global buf
    end = time.time() + sec
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.2)
        if r:
            try: buf += os.read(fd, 65536)
            except OSError: return
def reqs():
    try: return [json.loads(l) for l in open(OUT) if json.loads(l)["url"].startswith("/v1/messages")]
    except Exception: return []
def captured():
    # the main turn: a request with a system block (billing header) — background calls have none
    return any(json.loads(r["body"]).get("system") for r in reqs() if r["body"])
pump(12)
os.write(fd, b"Reply with the single word OK.")
pump(1.5)
os.write(fd, b"\r")
for _ in range(60):
    pump(1)
    if captured(): break
pump(3)
try: os.kill(pid, signal.SIGKILL)
except Exception: pass
srv.terminate()
import re
text = re.sub(rb"\x1b\[[0-9;?]*[A-Za-z]", b"", buf).decode("utf-8", "replace")
m = reqs()
if not m:
    print(TAG, "NO /v1/messages captured; screen tail:", " ".join(text.split())[-500:]); sys.exit(1)
print(f"{TAG}: {len(m)} /v1/messages request(s)")
for i, r in enumerate(m):
    h = r["headers"]; b = json.loads(r["body"])
    sysb = b.get("system") or []
    print(f" [{i}] ua: {h.get('user-agent')} | model: {b.get('model')} | tools: {len(b.get('tools') or [])} | system blocks: {len(sysb)} | keys: {sorted(b.keys())}")
    print(f"     betas: {h.get('anthropic-beta')}")
    if sysb: print(f"     sys0: {sysb[0].get('text','')[:90]} | thinking: {json.dumps(b.get('thinking'))} | output_config: {json.dumps(b.get('output_config'))}")
