// Organization budgets and the organization-level circuit breaker (docs/canonical-implementation-spec-2026-11-01.md
// WP7; docs/iron-rules.md 附 "组织级熔断"). Budgets are checked BEFORE a new conversation is bound to an organization
// (never kills in-flight work); an organization-level upstream error text stops scheduling the whole organization at
// once (status 'suspended' — listCandidates already schedules only status='active' organizations) and is lifted by an
// operator (PATCH /api/admin/teams/:id status=active). No retry, no re-auth: the platform does not claim it can rescue
// a disabled organization (2026-11-01: the disabling took 3 minutes and several hundred 502s to surface account by account).
import { all, one, run } from "./db.js";
import { nowIso } from "./time.js";
import { recordProxyTeamEvent } from "./teams.js";

export const ORG_LEVEL_ERROR_PATTERNS: ReadonlyArray<{ code: string; re: RegExp }> = [
  { code: "organization_disabled", re: /organization has disabled/i },
  { code: "oauth_not_allowed_for_organization", re: /oauth_not_allowed_for_organization/i },
  // whole-organization suspension; the per-model, time-boxed "model: X is suspended for this organization until T" is
  // handled as a model cooldown (accounts.ts parseModelSuspension) and must not trip the breaker.
  { code: "organization_suspended", re: /suspended for this organization/i },
];
const MODEL_SUSPENSION_RE = /model[:\s][^\n]{0,120}suspended for this organization until/i;

/** The organization-level error code an upstream error text carries, or null (request / account / model level). */
export function orgLevelErrorCode(text: string): string | null {
  if (!text) return null;
  if (MODEL_SUSPENSION_RE.test(text)) return null;
  for (const p of ORG_LEVEL_ERROR_PATTERNS) if (p.re.test(text)) return p.code;
  return null;
}

export interface TeamGuardRow {
  id: string;
  status: string;
  daily_token_budget: number | null;
  daily_cost_budget: number | null;
  max_concurrency: number | null;
  suspended_reason: string | null;
  suspended_until: string | null;
  last_error_code: string | null;
}

export function teamGuardRow(teamId: string): TeamGuardRow | undefined {
  return one<TeamGuardRow>("SELECT id, status, daily_token_budget, daily_cost_budget, max_concurrency, suspended_reason, suspended_until, last_error_code FROM upstream_teams WHERE id = ?", teamId);
}

/** Stop scheduling the whole organization (new sessions); in-flight requests finish on their own. Idempotent. */
export function suspendTeam(teamId: string, code: string, message: string, actorId: string | null = null, until: string | null = null): boolean {
  const t = teamGuardRow(teamId);
  if (!t) return false;
  const at = nowIso();
  run("UPDATE upstream_teams SET status = 'suspended', suspended_reason = ?, suspended_until = ?, last_error_code = ? WHERE id = ?", `${at} ${code}: ${message}`.slice(0, 500), until, code, teamId);
  if (t.status !== "suspended") recordProxyTeamEvent({ resourceKey: `team:${teamId}`, teamId, actorId, event: "team_suspended_org_error", reason: `${code}: ${message.slice(0, 300)}` });
  return t.status !== "suspended";
}

/** Operator lifts the suspension (or a budget pause); clears the reason fields. */
export function resumeTeam(teamId: string, actorId: string | null, reason: string | null): void {
  run("UPDATE upstream_teams SET status = 'active', suspended_reason = NULL, suspended_until = NULL WHERE id = ?", teamId);
  recordProxyTeamEvent({ resourceKey: `team:${teamId}`, teamId, actorId, event: "team_resumed", reason: reason ?? "operator" });
}

export interface TeamUsageToday { requests: number; tokens: number; costUsd: number }

export function teamUsageToday(teamId: string, now = Date.now()): TeamUsageToday {
  const dayStart = new Date(now).toISOString().slice(0, 10) + "T00:00:00.000Z";
  const r = one<{ n: number; tokens: number; cost: number }>(
    `SELECT COUNT(*) AS n,
            COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0) AS tokens,
            COALESCE(SUM(actual_cost), 0) AS cost
       FROM usage_logs WHERE team_id = ? AND created_at >= ? AND status_code < 400`,
    teamId, dayStart,
  )!;
  return { requests: r.n, tokens: r.tokens, costUsd: r.cost };
}

export interface TeamBudgetState { ok: boolean; reason: string | null; usage: TeamUsageToday; inFlight: number }

/**
 * Pre-check for binding a NEW conversation to an organization (spec WP7.1): daily token / cost budget (UTC day, from
 * usage_logs) and organization-wide concurrency. Null budgets = unlimited. `inFlight` is supplied by the gateway.
 */
export function teamBudgetState(teamId: string, inFlight: number, now = Date.now()): TeamBudgetState {
  const t = teamGuardRow(teamId);
  const usage = teamUsageToday(teamId, now);
  if (!t) return { ok: false, reason: "unknown_team", usage, inFlight };
  if (t.status !== "active") return { ok: false, reason: `status_${t.status}`, usage, inFlight };
  if (t.daily_token_budget !== null && t.daily_token_budget > 0 && usage.tokens >= t.daily_token_budget) return { ok: false, reason: `daily_token_budget ${usage.tokens}/${t.daily_token_budget}`, usage, inFlight };
  if (t.daily_cost_budget !== null && t.daily_cost_budget > 0 && usage.costUsd >= t.daily_cost_budget) return { ok: false, reason: `daily_cost_budget ${usage.costUsd.toFixed(4)}/${t.daily_cost_budget}`, usage, inFlight };
  if (t.max_concurrency !== null && t.max_concurrency > 0 && inFlight >= t.max_concurrency) return { ok: false, reason: `max_concurrency ${inFlight}/${t.max_concurrency}`, usage, inFlight };
  return { ok: true, reason: null, usage, inFlight };
}

export function listTeamAccountIds(teamId: string): string[] {
  return all<{ id: string }>("SELECT id FROM accounts WHERE team_id = ?", teamId).map((r) => r.id);
}
