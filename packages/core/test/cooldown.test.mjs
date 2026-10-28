// Soft vs hard 429 cooldown in listCandidates (docs/gateway.md §3). Uses a temp
// DATA_DIR so nothing touches data/.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "1dayapi-core-cooldown-"));
process.env.DATA_DIR = dir;
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

const core = await import("../dist/index.js");
const { run, one } = core;

const now = core.nowIso();
for (const id of ["a1", "a2"]) {
  run(
    `INSERT INTO accounts (id, name, platform, type, protocol, credential_enc, created_at, updated_at)
     VALUES (?, ?, 'anthropic', 'apikey', 'anthropic', ?, ?, ?)`,
    id, id, core.encryptJson({ apiKey: "k" }), now, now,
  );
  run("INSERT INTO account_groups (account_id, group_id, priority) VALUES (?, 'default', 50)", id);
}
const cands = () => core.listCandidates("default", "claude-sonnet-5");
const order = () => cands().map((a) => `${a.id}${a.cooling ? "*" : ""}`);

test("plain 429 cooldown is soft: account stays a candidate, flagged and ordered last", () => {
  assert.deepEqual(cands().map((a) => a.cooling), [false, false]);
  core.markFailure("a1", { kind: "rate_limited" });
  assert.ok(one("SELECT rate_limited_until FROM accounts WHERE id='a1'").rate_limited_until > now);
  assert.deepEqual(order(), ["a2", "a1*"], "cooling account last");
  core.markFailure("a2", { kind: "rate_limited", retryAfterSec: 120 });
  assert.deepEqual(order(), ["a1*", "a2*"], "both cooling: soonest free first");
  core.clearAccountState("a1");
  core.clearAccountState("a2");
  assert.deepEqual(order().sort(), ["a1", "a2"]);
  assert.ok(cands().every((a) => !a.cooling));
});

test("rejected-window 429 stays a hard exclusion until a plain 429 overwrites it", () => {
  const reset = core.isoIn(60_000);
  core.markFailure("a1", { kind: "window_rejected", window: "five_hour", resetAt: reset });
  assert.deepEqual(order(), ["a2"], "window-rejected account is not a candidate");
  // A later plain 429 rewrites rate_limited_until alone: the reason no longer matches -> soft again.
  core.markFailure("a1", { kind: "rate_limited", retryAfterSec: 30 });
  assert.deepEqual(order(), ["a2", "a1*"]);
  core.clearAccountState("a1");
});

test("other cooldowns (overload / transient / payment / window) remain hard", () => {
  core.markFailure("a2", { kind: "overloaded" });
  assert.deepEqual(order(), ["a1"]);
  core.clearAccountState("a2");
  core.markFailure("a2", { kind: "transient", message: "x" });
  assert.deepEqual(order(), ["a1"]);
  core.clearAccountState("a2");
  core.markFailure("a2", { kind: "window_exhausted" });
  assert.deepEqual(order(), ["a1"]);
  core.clearAccountState("a2");
  assert.deepEqual(order().sort(), ["a1", "a2"]);
});

test("model-scoped cooldown (Fable 7d_oi / credits): hides the account only for that family", () => {
  const reset = core.isoIn(3_600_000);
  core.markFailure("a1", { kind: "model_window_rejected", scope: "fable", resetAt: reset, reason: "7d_oi rejected (429)" });
  const ids = (m) => core.listCandidates("default", m).map((a) => a.id).sort();
  assert.deepEqual(ids("claude-fable-5-1"), ["a2"], "fable requests skip the cooled account");
  assert.deepEqual(ids("claude-sonnet-5"), ["a1", "a2"], "other models still schedule on it");
  const cd = core.parseModelCooldowns(one("SELECT model_cooldowns FROM accounts WHERE id='a1'").model_cooldowns);
  assert.equal(cd.fable.until, reset);
  assert.match(cd.fable.reason, /7d_oi rejected/);
  // passive sample with room in the Fable window lifts the scoped cooldown
  core.recordWindowUsage("a1", { used: 0.1, resetAt: null, window: "five_hour", fable: { used: 0.5, resetAt: reset } });
  assert.deepEqual(ids("claude-fable-5-1"), ["a1", "a2"]);
  core.recordWindowUsage("a1", { used: 0.1, resetAt: null, window: "five_hour", fable: { used: 1, resetAt: reset } });
  assert.deepEqual(ids("claude-fable-5-1"), ["a2"], "exhausted fable window pauses the scope again");
  core.clearAccountState("a1");
  assert.deepEqual(ids("claude-fable-5-1"), ["a1", "a2"]);
});

test("5h window rest: exhaustion/rejection cools until reset + random 1h45m–2h05m; 7d rejection unchanged", () => {
  const reset = new Date(Date.now() + 3_600_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const sec = (iso) => Math.round((Date.parse(iso) - Date.parse(reset)) / 1000);
  core.markFailure("a1", { kind: "window_exhausted", resetAt: reset });
  const r1 = one("SELECT window_exhausted_until u, window_reason r FROM accounts WHERE id='a1'");
  assert.ok(sec(r1.u) >= 6300 && sec(r1.u) <= 7500, `rest after reset in [6300,7500]s, got ${sec(r1.u)}s`);
  assert.match(r1.r, /\+ rest/);
  core.markFailure("a2", { kind: "window_rejected", window: "five_hour", resetAt: reset });
  const r2 = one("SELECT rate_limited_until u, window_reason r FROM accounts WHERE id='a2'");
  assert.ok(sec(r2.u) >= 6300 && sec(r2.u) <= 7500, `5h rejection also rests: ${sec(r2.u)}s`);
  assert.ok(r2.r.endsWith(`rejected (429) until ${r2.u}`), "hard-exclusion marker still keyed on rate_limited_until");
  assert.deepEqual(core.listCandidates("default", "claude-sonnet-5").map((a) => a.id), [], "both excluded while resting");
  core.clearAccountState("a1");
  core.clearAccountState("a2");
  core.markFailure("a2", { kind: "window_rejected", window: "seven_day", resetAt: reset });
  assert.equal(one("SELECT rate_limited_until u FROM accounts WHERE id='a2'").u, reset, "7d window: no rest added");
  core.clearAccountState("a2");
});
