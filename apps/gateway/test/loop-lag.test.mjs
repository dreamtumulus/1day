// X-72: the event-loop delay monitor sees a synchronous block and reports it on the snapshot, the gauge and the log.
import assert from "node:assert/strict";
import { test } from "node:test";

process.env.LOOP_LAG_SAMPLE_MS = "150";
process.env.LOOP_LAG_WARN_MS = "100";
const { loopLagSnapshot, startLoopLagMonitor } = await import("../dist/loop-lag.js");
const { countersSnapshot, counterValue } = await import("../dist/metrics.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("a 300 ms synchronous block shows up as max >= 250 ms, a warn line and the counter", async () => {
  const lines = [];
  startLoopLagMonitor((l) => lines.push(l));
  startLoopLagMonitor((l) => lines.push(l)); // idempotent
  await sleep(200);
  const quiet = loopLagSnapshot();
  assert.ok(quiet.sampledAt !== null && quiet.windowMs === 150, JSON.stringify(quiet));
  const until = Date.now() + 300;
  while (Date.now() < until) { /* hold the loop */ }
  await sleep(400);
  // Windows are 150 ms here, so the block's own window may already have rolled past: the five-minute worst keeps it.
  const busy = loopLagSnapshot();
  assert.ok(busy.p99Max5mMs >= 250, `5-minute worst p99 after a 300 ms block: ${JSON.stringify(busy)}`);
  assert.ok(lines.some((l) => /\[loop-lag\] event loop delay .* max=\d+ms/.test(l)), lines.join("\n"));
  assert.ok(counterValue("event_loop_lag_warn_total") >= 1);
  const g = countersSnapshot();
  assert.ok(g.event_loop_delay_max_ms >= 0 && typeof g.event_loop_delay_p99_5m_max_ms === "number", JSON.stringify(g));
});
