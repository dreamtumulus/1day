// WP7 organization budgets / circuit breaker and WP6 telemetry evidence (spec §6.4), against a temp DB.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "1dayapi-orgguard-"));
process.env.DATA_DIR = dir;
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
const core = await import("../dist/index.js");
const { orgLevelErrorCode, suspendTeam, resumeTeam, teamGuardRow, teamBudgetState, teamUsageToday, run, one, all, setSetting,
  recordTelemetryEvidence, listTelemetryEvidence, telemetryEvidenceLevel, accountHealthyDays } = core;

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-10T12:00:00Z");
let seq = 0;
const usage = (o) => {
  seq++;
  run(
    `INSERT INTO usage_logs (id, request_id, user_id, api_key_id, group_id, account_id, team_id, model, endpoint, stream, status_code, error_code, error_message, input_tokens, output_tokens, actual_cost, mode, created_at)
     VALUES (?, ?, 'u1', 'k1', 'g1', ?, ?, 'claude-sonnet-5-5', '/v1/messages', 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
    `log-${seq}`, `req-${seq}`, o.account ?? null, o.team ?? null, o.status ?? 200, o.errorCode ?? null, o.errorMessage ?? null, o.input ?? 1000, o.output ?? 100, o.cost ?? 0.01, o.mode ?? null, new Date(o.at ?? NOW).toISOString(),
  );
};

test("orgLevelErrorCode: whole-organization texts trip, per-model time-boxed suspension and ordinary errors do not", () => {
  assert.equal(orgLevelErrorCode('{"error":{"type":"permission_error","message":"Your organization has disabled Claude subscription access."}}'), "organization_disabled");
  assert.equal(orgLevelErrorCode("ccr_worker: Failed to authenticate. API Error: 403 This account is suspended for this organization."), "organization_suspended");
  assert.equal(orgLevelErrorCode('{"error":{"type":"oauth_not_allowed_for_organization","message":"OAuth is not allowed"}}'), "oauth_not_allowed_for_organization");
  assert.equal(orgLevelErrorCode("403 model: claude-opus-5-5 is suspended for this organization until 2026-11-02T00:00:00Z"), null, "per-model → model cooldown, not the breaker");
  assert.equal(orgLevelErrorCode("OAuth access token has been revoked"), null);
  assert.equal(orgLevelErrorCode(""), null);
});

test("circuit breaker: suspendTeam takes the organization out of scheduling at once; resume is an operator act", () => {
  run("INSERT INTO upstream_teams (id, name, status) VALUES ('t1', 'org one', 'active'), ('t2', 'org two', 'active')");
  run("INSERT INTO groups (id, name) VALUES ('g1', 'orgguard-test')");
  for (const [id, team] of [["a1", "t1"], ["a2", "t1"], ["b1", "t2"]]) {
    run("INSERT INTO accounts (id, name, platform, type, protocol, credential_enc, status, review_status, team_id) VALUES (?, ?, 'anthropic', 'oauth', 'anthropic', 'x', 'active', 'approved', ?)", id, id, team);
    run("INSERT INTO account_groups (account_id, group_id, priority) VALUES (?, 'g1', 50)", id);
  }
  // listCandidates schedules an OAuth account only when `upstream_teams.status = 'active'` (accounts.ts) — the predicate the breaker flips.
  const schedulable = (team) => !!one("SELECT 1 FROM upstream_teams WHERE id = ? AND status = 'active'", team);
  assert.ok(schedulable("t1") && schedulable("t2"));
  assert.equal(suspendTeam("t1", "organization_disabled", "Your organization has disabled Claude subscription access."), true, "first suspension → event");
  assert.equal(suspendTeam("t1", "organization_disabled", "again"), false, "idempotent: no second event");
  const t = teamGuardRow("t1");
  assert.equal(t.status, "suspended"); assert.equal(t.last_error_code, "organization_disabled"); assert.match(t.suspended_reason, /organization_disabled/);
  assert.equal(schedulable("t1"), false, "every account of the suspended organization is out of scheduling");
  assert.equal(schedulable("t2"), true, "the other organization serves");
  assert.equal(all("SELECT 1 FROM proxy_team_events WHERE team_id = 't1' AND event = 'team_suspended_org_error'").length, 1);
  resumeTeam("t1", "admin-1", "upstream confirmed re-enabled");
  assert.equal(teamGuardRow("t1").status, "active"); assert.equal(teamGuardRow("t1").suspended_reason, null);
  assert.ok(schedulable("t1"));
  assert.equal(all("SELECT 1 FROM proxy_team_events WHERE team_id = 't1' AND event = 'team_resumed'").length, 1);
});

test("budgets: null = unlimited; token / cost / concurrency caps block NEW conversations only (teamBudgetState), usage from today's usage_logs", () => {
  assert.equal(teamBudgetState("t1", 0, NOW).ok, true, "no budgets set");
  usage({ account: "a1", team: "t1", input: 60_000, output: 5_000, cost: 1.5 });
  usage({ account: "a2", team: "t1", input: 30_000, output: 5_000, cost: 0.5 });
  usage({ account: "a1", team: "t1", input: 99_000, output: 1, cost: 9, at: NOW - 2 * DAY }, "yesterday does not count");
  usage({ account: "a1", team: "t1", input: 99_000, output: 1, cost: 9, status: 500, errorCode: "upstream_error" }, "failed requests do not count");
  const u = teamUsageToday("t1", NOW);
  assert.equal(u.requests, 2); assert.equal(u.tokens, 100_000); assert.equal(u.costUsd, 2);
  run("UPDATE upstream_teams SET daily_token_budget = 100000 WHERE id = 't1'");
  assert.match(teamBudgetState("t1", 0, NOW).reason, /daily_token_budget 100000\/100000/);
  run("UPDATE upstream_teams SET daily_token_budget = 200000, daily_cost_budget = 1.99 WHERE id = 't1'");
  assert.match(teamBudgetState("t1", 0, NOW).reason, /daily_cost_budget/);
  run("UPDATE upstream_teams SET daily_cost_budget = NULL, max_concurrency = 3 WHERE id = 't1'");
  assert.equal(teamBudgetState("t1", 2, NOW).ok, true);
  assert.match(teamBudgetState("t1", 3, NOW).reason, /max_concurrency 3\/3/);
  assert.equal(teamBudgetState("t2", 0, NOW).ok, true, "the other organization is unaffected");
  assert.equal(teamBudgetState("nope", 0, NOW).reason, "unknown_team");
});

test("telemetry evidence: real > secondary (structural + N healthy days) > unknown; health breaks on 429 \"Error\" / org errors / quiet days", () => {
  setSetting("telemetry_health_days", "3");
  const P = "cc-2.1.312-restricted";
  assert.equal(telemetryEvidenceLevel("b1", P, NOW).level, "unknown");
  // structural evidence for the profile (account-less, G10-A)
  recordTelemetryEvidence({ accountId: null, profileId: P, source: "controlled", endpoint: "/api/event_logging/v2/batch", status: null, note: "G10-A probe 2026-11-01", expiresAt: new Date(NOW + 30 * DAY).toISOString() });
  assert.equal(listTelemetryEvidence(null, P).length, 1);
  let v = telemetryEvidenceLevel("b1", P, NOW);
  assert.equal(v.level, "unknown"); assert.equal(v.structural, true); assert.equal(v.healthDays, 0); assert.match(v.basis, /no traffic/);
  // three healthy days (today, -1, -2)
  for (let d = 0; d < 3; d++) usage({ account: "b1", team: "t2", at: NOW - d * DAY });
  assert.deepEqual(accountHealthyDays("b1", 3, NOW), { days: 3, brokenBy: null });
  v = telemetryEvidenceLevel("b1", P, NOW);
  assert.equal(v.level, "secondary"); assert.equal(v.healthDays, 3);
  // a request-level rejection today breaks it
  usage({ account: "b1", team: "t2", status: 429, errorCode: "upstream_request_rejected", errorMessage: "Error" });
  v = telemetryEvidenceLevel("b1", P, NOW);
  assert.equal(v.level, "unknown"); assert.match(v.basis, /429/);
  // another account: healthy streak with a quiet day in the middle → streak stops there
  for (const d of [0, 1, 3]) usage({ account: "a2", team: "t1", at: NOW - d * DAY });
  assert.equal(accountHealthyDays("a2", 3, NOW).days, 2);
  assert.match(accountHealthyDays("a2", 3, NOW).brokenBy, /no traffic/);
  // org-level error text in a failed row breaks the streak
  usage({ account: "a2", team: "t1", status: 403, errorCode: "upstream_client_error", errorMessage: "Your organization has disabled Claude subscription access.", at: NOW - 1 * DAY });
  assert.match(accountHealthyDays("a2", 3, NOW).brokenBy, /organization_disabled/);
  // real evidence wins regardless of health, until it expires
  recordTelemetryEvidence({ accountId: "b1", profileId: P, source: "real", endpoint: "/api/event_logging/v2/batch", status: 200, expiresAt: new Date(NOW + DAY).toISOString() });
  assert.equal(telemetryEvidenceLevel("b1", P, NOW).level, "real");
  assert.equal(telemetryEvidenceLevel("b1", P, NOW + 2 * DAY).level, "unknown", "expired real evidence does not count");
  assert.equal(telemetryEvidenceLevel("b1", "cc-2.1.312-cli", NOW).level, "unknown", "evidence is per profile");
  assert.equal(telemetryEvidenceLevel("a1", P, NOW).level, "unknown", "and per account: nothing is extrapolated (I10)");
  assert.equal(listTelemetryEvidence("b1").length, 1);
  setSetting("telemetry_health_days", "7");
});
