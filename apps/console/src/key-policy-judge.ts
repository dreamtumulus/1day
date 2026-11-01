import type { FastifyBaseLogger } from "fastify";
import { judgeAllKeys, lastKeyPolicyJudgeRunAt, markKeyPolicyJudgeRun, nowIso } from "@1dayapi/core";

// Daily key-policy judge (docs/canonical-implementation-spec-2026-11-01.md §6.2 / WP8, core/key-policy-auto.ts).
// Recomputes the `auto` layer of every key with ≥50 non-probe requests in the last 14 days; flips are written to
// key_policy_events. Whether the auto layer is in force is settings `key_policy_auto` (0 = record only, the first
// week). The run instant is persisted (settings key key_policy_judge_last_run_at) so a restart neither skips nor
// doubles a run; a manual run (POST /api/admin/key-policy/judge/run) does not move the schedule.

const CHECK_MS = 60 * 60_000;
const INTERVAL_MS = 24 * 60 * 60_000;

export function keyPolicyJudgeDue(now = Date.now()): boolean {
  const last = lastKeyPolicyJudgeRunAt();
  if (!last) return true;
  const t = Date.parse(last);
  return !Number.isFinite(t) || now - t >= INTERVAL_MS;
}

export function startKeyPolicyJudge(log: FastifyBaseLogger): void {
  if (process.env.KEY_POLICY_JUDGE === "0") return;
  log.info(`key-policy judge: checking hourly, judging every ${INTERVAL_MS / 3_600_000} h (auto layer in force per settings key_policy_auto)`);
  let running = false;
  const tick = () => {
    if (running || !keyPolicyJudgeDue()) return;
    running = true;
    try {
      const at = nowIso();
      const s = judgeAllKeys();
      markKeyPolicyJudgeRun(at);
      log.info(`[key-policy] judged ${s.judged} key(s): ${s.flipped} flipped (${s.events} field change(s)), ${s.pending} pending a stable 3 days`);
      for (const r of s.results) if (r.changes.length) log.info(`[key-policy] key ${r.apiKeyId}: ${r.changes.map((c) => `${c.field} ${JSON.stringify(c.old)}→${JSON.stringify(c.new)}`).join(", ")} (${r.basis})`);
    } catch (err) {
      log.warn(`[key-policy] scheduled run failed: ${(err as Error).message}`);
    } finally {
      running = false;
    }
  };
  setInterval(tick, CHECK_MS).unref();
  setTimeout(tick, 120_000).unref();
}
