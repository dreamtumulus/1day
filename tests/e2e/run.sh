#!/usr/bin/env bash
# v3 end-to-end suite: starts an isolated stack (temp DATA_DIR, mock upstream,
# console, gateway on spare ports), seeds it, runs every *.test.mjs with a
# fresh database each, then tears everything down.
#   bash tests/e2e/run.sh            (requires `pnpm build` first)
set -u
unset DB_PATH
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
export E2E_GATEWAY_PORT=${E2E_GATEWAY_PORT:-18400} E2E_CONSOLE_PORT=${E2E_CONSOLE_PORT:-18401}
MOCK_PORT=${E2E_MOCK_PORT:-19101}
WORK=$(mktemp -d)
PIDS=()
cleanup() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done; rm -rf "$WORK"; }
trap cleanup EXIT

start_stack() {
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done
  PIDS=()
  sleep 0.3
  rm -rf "$WORK/data" && mkdir -p "$WORK/data"
  export DATA_DIR="$WORK/data"
  MOCK_PORT=$MOCK_PORT node "$ROOT/apps/gateway/scripts/mock-upstream.mjs" > "$WORK/mock.log" 2>&1 & PIDS+=($!)
  # CCR_WINDOW_POLL=0: the suites probe subscription windows explicitly (ccr.test.mjs).
  PORT=$E2E_CONSOLE_PORT HOST=127.0.0.1 CCR_WINDOW_POLL=0 GATEWAY_URL=http://127.0.0.1:$E2E_GATEWAY_PORT node --no-warnings "$ROOT/apps/console/dist/index.js" > "$WORK/console.log" 2>&1 & PIDS+=($!)
  sleep 1.2
  PORT=$E2E_GATEWAY_PORT HOST=127.0.0.1 CONSOLE_BASE=http://127.0.0.1:$E2E_CONSOLE_PORT CCR_POLL_INTERVAL_MS=50 \
    CCR_POOL_SWEEP_MS=200 \
    node --no-warnings "$ROOT/apps/gateway/dist/index.js" > "$WORK/gateway.log" 2>&1 & PIDS+=($!)
  (cd "$ROOT/apps/console" && node --no-warnings scripts/seed.mjs --mock "http://127.0.0.1:$MOCK_PORT") > "$WORK/seed.txt"
  E2E_FIXTURE=1 node --no-warnings "$ROOT/tests/e2e/seed-models.mjs" || return 1
  sleep 0.8
}

FAILED=0
TEST_FILES=("$@")
if [ ${#TEST_FILES[@]} = 0 ]; then TEST_FILES=("$ROOT"/tests/e2e/*.test.mjs); fi
for t in "${TEST_FILES[@]}"; do
  echo "== $(basename "$t")"
  if ! start_stack; then FAILED=1; continue; fi
  if ! node "$t" "$WORK/seed.txt"; then
    FAILED=1
    echo "-- gateway log tail:"; tail -20 "$WORK/gateway.log"
  fi
done
[ $FAILED = 0 ] && echo "E2E: ALL SUITES PASSED" || echo "E2E: FAILURES"
exit $FAILED
