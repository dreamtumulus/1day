# Interactive-mode (pty) driver for the G9 `cli` profile: runs the real CC binary in a pseudo-terminal
# with a pre-seeded fake HOME (no onboarding prompts), types one prompt, waits until the capture server has
# seen a /v1/messages request, lingers a few seconds to collect auxiliary requests, then SIGKILLs it.
# usage: capture-cli.py <binary> <home> <model> <baseUrl> <proxyUrl>
# All traffic is local: ANTHROPIC_BASE_URL -> capture server, everything else -> refusing CONNECT proxy.
import json, os, pty, re, select, signal, subprocess, sys, time

BIN, HOME, MODEL, BASE, PROXY = sys.argv[1:6]
PROMPT = os.environ.get("CLI_PROMPT", "Reply with the single word OK.")
DUMP = os.environ["CLI_DUMP"]  # ndjson file the node capture server appends to
cfg = os.path.join(HOME, "cfg")
work = os.path.join(HOME, "work")
os.makedirs(cfg, mode=0o700, exist_ok=True)
os.makedirs(work, mode=0o700, exist_ok=True)
# onboarding / trust pre-seeded so the TUI goes straight to the composer (no account, no network)
json.dump({
    "userID": "ccprobe" + "0" * 58, "hasCompletedOnboarding": True, "theme": "dark", "numStartups": 5,
    "hasSeenTasksHint": True, "autoUpdates": False, "oauthAccount": {
        "accountUuid": "9d2d1c5e-1111-4a7b-8c3d-aaaaaaaaaaaa", "emailAddress": "",
        "organizationUuid": "11111111-2222-4333-8444-555555555555", "displayName": "", "fullName": "",
        "profileFetchedAt": int(time.time() * 1000)},
    "projects": {work: {"hasTrustDialogAccepted": True, "allowedTools": [], "hasCompletedProjectOnboarding": True}},
}, open(os.path.join(cfg, ".claude.json"), "w"))
json.dump({"claudeAiOauth": {"accessToken": "sk-ant-oat01-probe-fake-token", "refreshToken": "sk-ant-ort01-probe-fake",
                             "expiresAt": int(time.time() * 1000) + 8 * 3600 * 1000,
                             "scopes": ["user:inference", "user:profile"], "subscriptionType": "max"}},
          open(os.path.join(cfg, ".credentials.json"), "w"))
os.chmod(os.path.join(cfg, ".credentials.json"), 0o600)
json.dump({"hasCompletedOnboarding": True}, open(os.path.join(cfg, "settings.json"), "w"))

env = {"PATH": os.environ["PATH"], "HOME": HOME, "TMPDIR": HOME, "CLAUDE_CONFIG_DIR": cfg,
       "ANTHROPIC_BASE_URL": BASE, "HTTPS_PROXY": PROXY, "HTTP_PROXY": PROXY,
       "NO_PROXY": "127.0.0.1,localhost", "no_proxy": "127.0.0.1,localhost",
       "DISABLE_AUTOUPDATER": "1", "DISABLE_ERROR_REPORTING": "1", "CLAUDE_CODE_NO_MODEL_FALLBACK": "1",
       "CLAUDE_CODE_DISABLE_ATTACHMENTS": "1",
       "TERM": "xterm-256color", "COLUMNS": "120", "LINES": "40", "LANG": "C.UTF-8", "SHELL": "/bin/bash"}

pid, fd = pty.fork()
if pid == 0:
    os.chdir(work)
    os.execve(BIN, [BIN, "--model", MODEL], env)

buf = b""
def pump(sec):
    global buf
    end = time.time() + sec
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.2)
        if r:
            try: buf += os.read(fd, 65536)
            except OSError: return

def requests():
    out = []
    try:
        for line in open(DUMP):
            line = line.strip()
            if not line: continue
            try: out.append(json.loads(line))
            except Exception: pass
    except FileNotFoundError:
        pass
    return out

pump(14)                                        # let the TUI boot
os.write(fd, PROMPT.encode())
pump(1.5)
os.write(fd, b"\r")                             # submit
main_seen = False
for _ in range(60):                             # up to ~60 s for the main turn
    pump(1)
    msgs = [r for r in requests() if r["url"].startswith("/v1/messages")]
    if any((r.get("body") or {}).get("system") for r in msgs):
        main_seen = True
        break
pump(8)                                         # linger: auxiliary requests (titles, suggestions …)
try: os.kill(pid, signal.SIGKILL)
except Exception: pass
pump(0.5)
text = re.sub(rb"\x1b\[[0-9;?]*[A-Za-z]", b"", buf).decode("utf-8", "replace")
print(json.dumps({"tag": os.environ.get("CLI_TAG"), "model": MODEL, "mainSeen": main_seen,
                  "requests": len(requests()), "screenTail": " ".join(text.split())[-300:]}))
sys.exit(0 if main_seen else 1)
