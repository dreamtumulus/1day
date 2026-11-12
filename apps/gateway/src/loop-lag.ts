// Event-loop delay of this gateway process (X-72, 2026-11-12). The gateway is one Node thread: a synchronous job that
// takes seconds (X-71: the organization budget check ran 330 SUM queries per new conversation, ~3 s) freezes every
// request in flight, and until now the only trace was a gap between journal lines. Every LOOP_LAG_SAMPLE_MS the
// histogram of `monitorEventLoopDelay` is read and reset: p50 / p99 / max of the window are a gauge on
// /internal/metrics, the p99 and max also ride on the public /health (plain numbers, nothing sensitive) so that
// ops/bin/gateway-watchdog can treat a frozen loop like a dead process, and a window whose p99 reaches
// LOOP_LAG_WARN_MS is logged (at most once a minute) and counted.
import { monitorEventLoopDelay } from "node:perf_hooks";
import { bump, registerGauge } from "./metrics.js";

const SAMPLE_MS = Math.max(100, Number(process.env.LOOP_LAG_SAMPLE_MS ?? 10_000) || 10_000);
const WARN_MS = Math.max(1, Number(process.env.LOOP_LAG_WARN_MS ?? 500) || 500);
const RING = 30; // 30 × 10 s = the worst p99 of the last five minutes

export interface LoopLagSnapshot {
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
  /** Highest window p99 of the last RING windows (five minutes at the default rate). */
  p99Max5mMs: number;
  sampledAt: string | null;
  windowMs: number;
}

const histogram = monitorEventLoopDelay({ resolution: 20 });
let last = { p50Ms: 0, p99Ms: 0, maxMs: 0, at: 0 };
const ring: number[] = [];
let lastWarnAt = 0;
let started = false;

function sample(log: (line: string) => void): void {
  const ms = (nanos: number) => (Number.isFinite(nanos) && nanos > 0 ? Math.round(nanos / 1e6) : 0);
  last = { p50Ms: ms(histogram.percentile(50)), p99Ms: ms(histogram.percentile(99)), maxMs: ms(histogram.max), at: Date.now() };
  histogram.reset();
  ring.push(last.p99Ms);
  if (ring.length > RING) ring.shift();
  if (last.p99Ms >= WARN_MS) {
    bump("event_loop_lag_warn_total");
    if (Date.now() - lastWarnAt >= 60_000) {
      lastWarnAt = Date.now();
      log(`[loop-lag] event loop delay p50=${last.p50Ms}ms p99=${last.p99Ms}ms max=${last.maxMs}ms over the last ${Math.round(SAMPLE_MS / 1000)}s (warn at ${WARN_MS}ms): something synchronous is holding the gateway`);
    }
  }
}

/** Idempotent; the sampling timer never keeps the process alive. */
export function startLoopLagMonitor(log: (line: string) => void = console.warn): void {
  if (started) return;
  started = true;
  histogram.enable();
  setInterval(() => sample(log), SAMPLE_MS).unref();
  registerGauge("event_loop", () => ({
    event_loop_delay_p50_ms: last.p50Ms,
    event_loop_delay_p99_ms: last.p99Ms,
    event_loop_delay_max_ms: last.maxMs,
    event_loop_delay_p99_5m_max_ms: ring.length ? Math.max(...ring) : 0,
  }));
}

export function loopLagSnapshot(): LoopLagSnapshot {
  return {
    p50Ms: last.p50Ms,
    p99Ms: last.p99Ms,
    maxMs: last.maxMs,
    p99Max5mMs: ring.length ? Math.max(...ring) : 0,
    sampledAt: last.at ? new Date(last.at).toISOString() : null,
    windowMs: SAMPLE_MS,
  };
}
