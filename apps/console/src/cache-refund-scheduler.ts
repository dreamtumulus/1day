import type { FastifyBaseLogger } from "fastify";
import {
  cacheRefundEnabled,
  cacheRefundIntervalSec,
  lastScheduledCacheRefundAt,
  markScheduledCacheRefundRun,
  nowIso,
  runCacheRefundsForAll,
} from "@1dayapi/core";

// Periodic cache-rebuild refund (docs/data-model.md §3 cache_refunds; user 2026-10-21:
// "not real time, once every 24 h is fine, credited automatically"). The timer wakes
// every CHECK_MS, and when the last scheduled run is older than
// settings.cache_refund_interval_sec (default 24 h) it pays every user with pending
// switched requests. The run instant is persisted (settings key
// cache_refund_last_run_at) so a console restart neither skips nor doubles a run.
// A never-run installation pays on its first tick, then settles into the interval.
// Manual admin runs (POST /api/admin/cache-refund/run) do not move the schedule.

const CHECK_MS = 10 * 60_000;

export function cacheRefundDue(now = Date.now()): boolean {
  const last = lastScheduledCacheRefundAt();
  if (!last) return true;
  const t = Date.parse(last);
  if (!Number.isFinite(t)) return true;
  return now - t >= cacheRefundIntervalSec() * 1000;
}

export function startCacheRefundScheduler(log: FastifyBaseLogger): void {
  if (process.env.CACHE_REFUND_SCHEDULER === "0") return;
  log.info(`cache refund scheduler: checking every ${CHECK_MS / 60_000} min, paying every ${cacheRefundIntervalSec()}s (enabled=${cacheRefundEnabled()})`);
  let running = false;
  const tick = () => {
    if (running) return;
    if (!cacheRefundEnabled() || !cacheRefundDue()) return;
    running = true;
    try {
      const at = nowIso();
      const s = runCacheRefundsForAll({ createdBy: "scheduler" });
      markScheduledCacheRefundRun(at);
      if (s.users) {
        log.info(
          `[cache-refund] paid ${s.users} user(s), ${s.rows} request(s): excess ${s.excessUsd.toFixed(4)} → refund ${s.refundUsd.toFixed(4)} (credit ${s.toCreditUsd.toFixed(4)}, balance ${s.toBalanceUsd.toFixed(4)})`,
        );
      } else {
        log.info("[cache-refund] scheduled run: nothing pending");
      }
    } catch (err) {
      log.warn(`[cache-refund] scheduled run failed: ${(err as Error).message}`);
    } finally {
      running = false;
    }
  };
  setInterval(tick, CHECK_MS).unref();
  setTimeout(tick, 60_000).unref();
}
