#!/usr/bin/env bash
# v3 end-to-end suite: starts an isolated stack (temp DATA_DIR, mock upstream,
# console, gateway on spare ports), seeds it, runs every *.test.mjs with a
# fresh database each, then tears everything down.
#   bash tests/e2e/run.sh            (requires `pnpm build` first)
set -u
unset DB_PATH
export ALLOW_UNTRUSTED_EXECUTION=1
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
export E2E_GATEWAY_PORT=${E2E_GATEWAY_PORT:-18400} E2E_CONSOLE_PORT=${E2E_CONSOLE_PORT:-18401}
MOCK_PORT=${E2E_MOCK_PORT:-19101}
WORK=$(mktemp -d)
PIDS=()
cleanup() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done; rm -rf "$WORK"; }
command -v curl >/dev/null 2>&1 || { echo "tests/e2e/run.sh needs curl (health polling)" >&2; exit 2; }
trap cleanup EXIT

WAIT_SEC=${E2E_WAIT_SEC:-30}

# Stop the previous stack and wait (bounded) until every process is gone, so the ports are free again.
stop_stack() {
  local p i
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done
  for p in "${PIDS[@]}"; do
    for ((i = 0; i < 100; i++)); do kill -0 "$p" 2>/dev/null || break; sleep 0.05; done
    kill -9 "$p" 2>/dev/null
    wait "$p" 2>/dev/null
  done
  PIDS=()
}

# wait_ready <name> <pid> <url> <log>: poll the health endpoint until it answers 200, for at most WAIT_SEC seconds.
# Fails at once when the process has exited (a crash at startup is not worth the full wait).
wait_ready() {
  local name=$1 pid=$2 url=$3 log=$4 i
  for ((i = 0; i < WAIT_SEC * 20; i++)); do
    if curl -fsS --noproxy '*' -o /dev/null --max-time 2 "$url" 2>/dev/null; then return 0; fi
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "-- $name exited during startup; log tail:"; tail -20 "$log"
      return 1
    fi
    sleep 0.05
  done
  echo "-- $name did not answer $url within ${WAIT_SEC}s; log tail:"; tail -20 "$log"
  return 1
}

start_stack() {
  local mock_pid console_pid gateway_pid
  stop_stack
  rm -rf "$WORK/data" && mkdir -p "$WORK/data"
  export DATA_DIR="$WORK/data"
  MOCK_PORT=$MOCK_PORT node "$ROOT/apps/gateway/scripts/mock-upstream.mjs" > "$WORK/mock.log" 2>&1 & mock_pid=$!; PIDS+=($mock_pid)
  # CCR_WINDOW_POLL=0: the suites probe subscription windows explicitly (ccr.test.mjs).
  PORT=$E2E_CONSOLE_PORT HOST=127.0.0.1 CCR_WINDOW_POLL=0 GATEWAY_URL=http://127.0.0.1:$E2E_GATEWAY_PORT node --no-warnings "$ROOT/apps/console/dist/index.js" > "$WORK/console.log" 2>&1 & console_pid=$!; PIDS+=($console_pid)
  # The console creates the key files and migrates the fresh database; the gateway starts only once it is up.
  wait_ready console "$console_pid" "http://127.0.0.1:$E2E_CONSOLE_PORT/health" "$WORK/console.log" || return 1
  PORT=$E2E_GATEWAY_PORT HOST=127.0.0.1 CONSOLE_BASE=http://127.0.0.1:$E2E_CONSOLE_PORT CCR_POLL_INTERVAL_MS=50 \
    CCR_POOL_SWEEP_MS=200 \
    node --no-warnings "$ROOT/apps/gateway/dist/index.js" > "$WORK/gateway.log" 2>&1 & gateway_pid=$!; PIDS+=($gateway_pid)
  (cd "$ROOT/apps/console" && SEED_PRINT_KEYS=1 node --no-warnings scripts/seed.mjs --mock "http://127.0.0.1:$MOCK_PORT") > "$WORK/seed.txt"
  E2E_FIXTURE=1 node --no-warnings "$ROOT/tests/e2e/seed-models.mjs" || return 1
  wait_ready mock-upstream "$mock_pid" "http://127.0.0.1:$MOCK_PORT/health" "$WORK/mock.log" || return 1
  wait_ready gateway "$gateway_pid" "http://127.0.0.1:$E2E_GATEWAY_PORT/health" "$WORK/gateway.log" || return 1
}

FAILED=0
TEST_FILES=("$@")
if [ ${#TEST_FILES[@]} = 0 ]; then TEST_FILES=("$ROOT"/tests/e2e/*.test.mjs); fi
# One "SUITE-RESULT <file> <ok|failed|stack-failed>" line per suite: ops/bin/test-gate reads these together with
# the suites' own PASS / FAIL lines (tests/e2e/known-failures.txt).
for t in "${TEST_FILES[@]}"; do
  echo "== $(basename "$t")"
  if ! start_stack; then FAILED=1; echo "SUITE-RESULT $(basename "$t") stack-failed"; continue; fi
  if node "$t" "$WORK/seed.txt"; then
    echo "SUITE-RESULT $(basename "$t") ok"
  else
    FAILED=1
    echo "-- gateway log tail:"; tail -20 "$WORK/gateway.log"
    echo "SUITE-RESULT $(basename "$t") failed"
  fi
done
[ $FAILED = 0 ] && echo "E2E: ALL SUITES PASSED" || echo "E2E: FAILURES"
exit $FAILED
