#!/bin/bash
# cc-capture2.sh <binary> <tag> <auth:oauth|apikey> <extra args...>
set -u
BIN="$1"; TAG="$2"; AUTH="$3"; shift 3; D=${CC_CAPTURE_DIR:-/root/cc-upgrade}; OUT=$D/capture-$TAG.ndjson; : > "$OUT"
node $D/capsrv.mjs "$OUT" & SRV=$!; sleep 0.5
H=$D/home-cap-$TAG; rm -rf "$H"; mkdir -p "$H/cfg"
if [ "$AUTH" = oauth ]; then A="CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-capture-dummy-token-0000000000000000000000000000000000000000"; else A="ANTHROPIC_API_KEY=sk-ant-api03-capture-dummy-key-000000000000000000000000000000000000000000000000"; fi
env -i PATH="$PATH" HOME="$H" TMPDIR="$H" CLAUDE_CONFIG_DIR="$H/cfg" ANTHROPIC_BASE_URL=http://127.0.0.1:18999 $A \
  CLAUDE_CODE_DISABLE_FILE_MENTIONS=1 CLAUDE_CODE_DISABLE_ATTACHMENTS=1 DISABLE_AUTOUPDATER=1 DISABLE_TELEMETRY=1 \
  timeout 25 "$BIN" -p --output-format stream-json --verbose --tools "" --no-session-persistence --include-partial-messages "$@" "Reply with the single word OK." \
  > "$D/run-$TAG.out" 2> "$D/run-$TAG.err"
kill $SRV 2>/dev/null; wait $SRV 2>/dev/null
python3 - "$OUT" "$TAG" <<'PY'
import json,sys
rows=[json.loads(l) for l in open(sys.argv[1])]
m=[r for r in rows if r["url"].startswith("/v1/messages")]
if not m: print(sys.argv[2], "NO /v1/messages request"); sys.exit()
h=m[0]["headers"]; b=json.loads(m[0]["body"])
print(sys.argv[2], "| ua:", h.get("user-agent"), "| betas:", h.get("anthropic-beta"))
print("   model:", b.get("model"), "| sys0:", (b.get("system") or [{}])[0].get("text","")[:70], "| cache_control in system:", any("cache_control" in s for s in (b.get("system") or []) if isinstance(s,dict)))
PY
