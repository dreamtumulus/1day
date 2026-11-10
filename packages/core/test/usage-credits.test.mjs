// Usage credits (docs/usage-credits.md): the pure parser + creditsUsable, and the scheduling integration in
// listCandidates / markFailure / recordWindowUsage. Temp DATA_DIR; fixtures only, nothing leaves the process.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "1dayapi-core-usage-credits-"));
process.env.DATA_DIR = dir;
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

const core = await import("../dist/index.js");
const { run, one, parseUsageCredits, creditsUsable } = core;

// The real stored body of a production account (2026-11, credits disabled) — the only verified shape.
const REAL_DISABLED = {
  five_hour: { utilization: 0, resets_at: "2026-11-09T15:00:00Z", limit_dollars: null, used_dollars: null, remaining_dollars: null, locked_reason: null },
  seven_day: { utilization: 5, resets_at: "2026-11-14T09:00:00Z" },
  promo_credits: null,
  extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null, currency: null, decimal_places: null, disabled_reason: null, user_disabled: false, spend_limit_reached: false, credits_ever_enabled: false, daily: null, weekly: null },
  limits: [
    { kind: "session", group: "session", percent: 0, severity: "normal", resets_at: "2026-11-09T15:00:00Z", scope: null, is_active: false },
    { kind: "weekly_all", group: "weekly", percent: 5, severity: "normal", resets_at: "2026-11-14T09:00:00Z", scope: null, is_active: false },
    { kind: "weekly_scoped", group: "weekly", percent: 7, severity: "normal", resets_at: "2026-11-14T09:00:00Z", scope: { model: { id: null, display_name: "Fable" }, surface: null }, is_active: true },
  ],
  spend: { used: { amount_minor: 0, currency: "USD", exponent: 2 }, limit: null, percent: 0, severity: "normal", enabled: false, disabled_reason: null, cap: null, balance: null, auto_reload: null, disclaimer: "Usage credits cover you when you hit your plan limits. …", can_purchase_credits: false, can_toggle: false },
  member_dashboard_available: false,
  seven_day_breakdown: null,
  weekly_scoped_shares: [{ limit_index: 2, used_percent_of_weekly: 4, allowance_percent_of_weekly: 50 }],
};

const usd = (amountMinor) => ({ amountMinor, currency: "USD", exponent: 2 });
/** REAL_DISABLED with the spend / extra_usage blocks patched — the inferred enabled variants. */
// A real body would flip both blocks together, so extra_usage.is_enabled follows spend.enabled unless a case overrides it.
const variant = (spend = {}, extra = {}, more = {}) => ({
  ...REAL_DISABLED,
  ...more,
  spend: { ...REAL_DISABLED.spend, ...spend },
  extra_usage: { ...REAL_DISABLED.extra_usage, ...("enabled" in spend ? { is_enabled: spend.enabled } : {}), ...extra },
});

test("parseUsageCredits: the real production body (credits disabled)", () => {
  const c = parseUsageCredits(REAL_DISABLED);
  assert.deepEqual(c, {
    known: true,
    enabled: false,
    everEnabled: false,
    canToggle: false,
    canPurchase: false,
    balance: null,
    monthlyCap: null,
    used: usd(0),
    spendLimitReached: false,
    autoReload: null,
    disabledReason: null,
    promo: null,
    fableShare: { usedPercent: 7, allowancePercentOfWeekly: 50, resetsAt: "2026-11-14T09:00:00Z", active: true },
  });
  assert.equal(creditsUsable(c), false);
  assert.ok(!JSON.stringify(c).includes("cover you"), "the disclaimer text is not carried over");
  // the stored form is the JSON text
  assert.deepEqual(parseUsageCredits(JSON.stringify(REAL_DISABLED)), c);
});

test("parseUsageCredits never throws and reports unknown shapes as unknown", () => {
  const junk = [undefined, null, "", "not json", '{"spend":{"enabled":tr', 0, 42, true, [], [1, 2], {}, { spend: null, extra_usage: null }, { spend: "yes", extra_usage: 7 }, { limits: "x", weekly_scoped_shares: {} }, { spend: [] }];
  for (const j of junk) {
    const c = parseUsageCredits(j);
    assert.equal(c.known, false, `known for ${JSON.stringify(j)}`);
    assert.equal(c.enabled, false);
    assert.equal(creditsUsable(c), false);
  }
  // hostile field types inside a present block: still an object back, nothing usable by accident
  const odd = parseUsageCredits({ spend: { enabled: "true", balance: { amount_minor: "abc" }, cap: -5, auto_reload: "on", used: [], percent: "NaN" }, extra_usage: { is_enabled: 1 }, limits: [null, 3, { scope: { model: 5 } }], weekly_scoped_shares: [null, "x"] });
  assert.equal(odd.known, true);
  assert.equal(odd.enabled, false, "only a boolean true enables");
  assert.equal(odd.balance, null);
  assert.equal(odd.monthlyCap, null);
  assert.equal(odd.autoReload, null);
  assert.equal(creditsUsable(odd), false);
  // a body cut at 8000 chars (window-poll stores slice(0, 8000)) is unknown, not an exception
  assert.equal(parseUsageCredits(JSON.stringify(variant({ enabled: true })).slice(0, 900)).known, false);
});

test("parseUsageCredits: plausible enabled variants (inferred shapes)", () => {
  const cases = [
    {
      name: "spend block, minor-unit objects, balance left",
      body: variant({ enabled: true, balance: { amount_minor: 2550, currency: "USD", exponent: 2 }, cap: { amount_minor: 10000, currency: "USD", exponent: 2 }, used: { amount_minor: 1234, currency: "USD", exponent: 2 }, percent: 12, auto_reload: false, can_toggle: true, can_purchase_credits: true }, { is_enabled: true, credits_ever_enabled: true }),
      want: { enabled: true, everEnabled: true, canToggle: true, canPurchase: true, balance: usd(2550), monthlyCap: usd(10000), used: usd(1234), spendLimitReached: false, autoReload: false },
      usable: true,
    },
    {
      name: "spend block, decimal amounts",
      body: variant({ enabled: true, balance: { amount: 25.5, currency: "USD" }, limit: { value: "100.00" }, used: { amount: 12.34 } }),
      want: { enabled: true, balance: usd(2550), monthlyCap: usd(10000), used: usd(1234) },
      usable: true,
    },
    {
      name: "bare numbers: non-integer = decimal, integer = minor units",
      body: variant({ enabled: true, balance: 25.5, cap: 10000 }),
      want: { balance: usd(2550), monthlyCap: usd(10000) },
      usable: true,
    },
    {
      name: "older extra_usage block only (cents)",
      body: { extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1250.0, utilization: 25, currency: "USD", decimal_places: 2, spend_limit_reached: false, credits_ever_enabled: true } },
      want: { known: true, enabled: true, everEnabled: true, monthlyCap: usd(5000), used: usd(1250), balance: null, spendLimitReached: false, autoReload: null, fableShare: null },
      usable: true, // balance not reported, cap not reached
    },
    {
      name: "extra_usage: spend limit reached",
      body: { extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 5000, utilization: 100, spend_limit_reached: true } },
      want: { enabled: true, spendLimitReached: true },
      usable: false,
    },
    {
      name: "cap reached by amounts although the flag is not set",
      body: variant({ enabled: true, balance: { amount_minor: 900 }, cap: { amount_minor: 5000 }, used: { amount_minor: 5000, currency: "USD", exponent: 2 } }),
      want: { spendLimitReached: true, balance: usd(900) },
      usable: false,
    },
    {
      name: "cap reached by percent",
      body: variant({ enabled: true, cap: { amount_minor: 5000 }, percent: 100 }),
      want: { spendLimitReached: true },
      usable: false,
    },
    {
      name: "percent 100 without any cap is not a reached limit",
      body: variant({ enabled: true, percent: 100, balance: { amount_minor: 100 } }),
      want: { spendLimitReached: false },
      usable: true,
    },
    {
      name: "balance 0, auto-reload off",
      body: variant({ enabled: true, balance: { amount_minor: 0 }, auto_reload: false }),
      want: { balance: usd(0), autoReload: false },
      usable: false,
    },
    {
      name: "balance 0, auto-reload not reported",
      body: variant({ enabled: true, balance: { amount_minor: 0 } }),
      want: { balance: usd(0), autoReload: null },
      usable: false,
    },
    {
      name: "balance 0, auto-reload on (boolean)",
      body: variant({ enabled: true, balance: { amount_minor: 0 }, auto_reload: true }),
      want: { autoReload: true },
      usable: true,
    },
    {
      name: "auto-reload as an object",
      body: variant({ enabled: true, balance: 0, auto_reload: { enabled: true, threshold: { amount_minor: 500 }, amount: { amount_minor: 2500 } } }),
      want: { autoReload: true, balance: usd(0) },
      usable: true,
    },
    {
      name: "enabled, nothing else reported",
      body: variant({ enabled: true }),
      want: { enabled: true, balance: null, monthlyCap: null },
      usable: true,
    },
    {
      name: "blocks disagree: an explicit false wins",
      body: variant({ enabled: true, balance: { amount_minor: 5000 } }, { is_enabled: false }),
      want: { enabled: false, balance: usd(5000) },
      usable: false,
    },
    {
      name: "disabled by the user after having been on",
      body: variant({ enabled: false, disabled_reason: null }, { is_enabled: false, user_disabled: true, credits_ever_enabled: true }),
      want: { enabled: false, everEnabled: true, disabledReason: "user_disabled" },
      usable: false,
    },
    {
      name: "disabled with a reason, long text clipped",
      body: variant({ enabled: false, disabled_reason: "org_admin_disabled" + "x".repeat(300) }),
      want: { enabled: false },
      usable: false,
      check: (c) => assert.equal(c.disabledReason.length, 120),
    },
    {
      name: "promo credits alone do not make credits usable",
      body: variant({ enabled: false }, {}, { promo_credits: { balance: { amount_minor: 5000, currency: "USD", exponent: 2 }, expires_at: "2026-12-01T00:00:00Z" } }),
      want: { promo: usd(5000), enabled: false },
      usable: false,
    },
    {
      name: "non-USD currency and exponent follow the body",
      body: variant({ enabled: true, used: { amount_minor: 1500, currency: "JPY", exponent: 0 }, balance: { amount_minor: 3000 } }),
      want: { used: { amountMinor: 1500, currency: "JPY", exponent: 0 }, balance: { amountMinor: 3000, currency: "JPY", exponent: 0 } },
      usable: true,
    },
  ];
  for (const { name, body, want, usable, check } of cases) {
    const c = parseUsageCredits(body);
    for (const [k, v] of Object.entries(want)) assert.deepEqual(c[k], v, `${name}: ${k}`);
    assert.equal(creditsUsable(c), usable, `${name}: creditsUsable`);
    check?.(c);
  }
});

test("fableShare: from limits[] + weekly_scoped_shares, tolerant of partial data", () => {
  assert.deepEqual(parseUsageCredits({ weekly_scoped_shares: [{ limit_index: 0, used_percent_of_weekly: 25, allowance_percent_of_weekly: 50 }] }).fableShare, { usedPercent: 50, allowancePercentOfWeekly: 50, resetsAt: null, active: false });
  const noShares = parseUsageCredits({ ...REAL_DISABLED, weekly_scoped_shares: null }).fableShare;
  assert.deepEqual(noShares, { usedPercent: 7, allowancePercentOfWeekly: null, resetsAt: "2026-11-14T09:00:00Z", active: true });
  // a scoped limit for another family is not the Fable share
  const other = { limits: [{ kind: "weekly_scoped", percent: 80, scope: { model: { id: null, display_name: "Sonnet" } }, is_active: true }], weekly_scoped_shares: [] };
  assert.equal(parseUsageCredits(other).fableShare, null);
  assert.equal(parseUsageCredits({ limits: [], weekly_scoped_shares: [] }).fableShare, null);
  // matched by model id as well
  assert.equal(parseUsageCredits({ limits: [{ percent: 100, scope: { model: { id: "claude-fable-5-2", display_name: null } }, is_active: true }] }).fableShare.usedPercent, 100);
});

test("parseUsageCreditsPolicy: anything unknown is off", () => {
  for (const [v, want] of [["off", "off"], ["fable_only", "fable_only"], [" ALL ", "all"], ["", "off"], ["on", "off"], [undefined, "off"], [1, "off"]]) assert.equal(core.parseUsageCreditsPolicy(v), want);
});

// ---------- scheduling ----------

const SONNET = "claude-sonnet-5";
const FABLE = "claude-fable-5-2";
const ENABLED = JSON.stringify(variant({ enabled: true, balance: { amount_minor: 2550, currency: "USD", exponent: 2 } }, { is_enabled: true }));
const DISABLED = JSON.stringify(REAL_DISABLED);

const t0 = core.nowIso();
for (const id of ["plan", "cred", "nocred"]) {
  run(
    `INSERT INTO accounts (id, name, platform, type, protocol, credential_enc, created_at, updated_at)
     VALUES (?, ?, 'anthropic', 'apikey', 'anthropic', ?, ?, ?)`,
    id, id, core.encryptJson({ apiKey: "k" }), t0, t0,
  );
  run("INSERT INTO account_groups (account_id, group_id, priority) VALUES (?, 'default', 50)", id);
}
const past = (ms) => new Date(Date.now() - ms).toISOString().slice(0, 19) + "Z";
const setUsage = (id, json, checkedAt = core.nowIso()) => run("UPDATE accounts SET usage_json = ?, usage_checked_at = ? WHERE id = ?", json, checkedAt, id);
const reset = () => {
  for (const id of ["plan", "cred", "nocred"]) {
    core.clearAccountState(id);
    run("UPDATE accounts SET window_used = NULL, window_reset_at = NULL, window_exhausted_until = NULL, window_reason = NULL, last_used_at = NULL WHERE id = ?", id);
  }
  setUsage("plan", DISABLED, past(60_000));
  setUsage("cred", ENABLED, past(60_000));
  setUsage("nocred", DISABLED, past(60_000));
};
const policy = (p) => core.setSetting("usage_credits_policy", p);
const ids = (m) => core.listCandidates("default", m).map((a) => `${a.id}${a.onCredits ? "$" : ""}${a.cooling ? "*" : ""}`);
const row = (id) => one("SELECT * FROM accounts WHERE id = ?", id);
const snap5h = (used, extra = {}) => ({ used, resetAt: core.isoIn(3_600_000), window: "five_hour", fiveHour: { used, resetAt: core.isoIn(3_600_000) }, sevenDay: null, ...extra });
const fableSnap = (used) => ({ used: 0.1, resetAt: core.isoIn(3_600_000), window: "five_hour", fiveHour: { used: 0.1, resetAt: core.isoIn(3_600_000) }, sevenDay: null, fable: { used, resetAt: core.isoIn(3 * 86_400_000) } });

test("policy off (default): exhausted accounts are skipped whatever their credits say", () => {
  reset();
  assert.equal(core.getSetting("usage_credits_policy"), "off");
  for (const id of ["cred", "nocred"]) core.recordWindowUsage(id, snap5h(0.99), 95);
  assert.deepEqual(ids(SONNET), ["plan"]);
  assert.ok(!row("cred").window_reason.includes("usage credits"));
  reset();
  for (const id of ["cred", "nocred"]) core.recordWindowUsage(id, fableSnap(1), 95);
  assert.deepEqual(ids(FABLE), ["plan"]);
  assert.deepEqual(ids(SONNET).sort(), ["cred", "nocred", "plan"]);
  assert.equal(core.onCredits(row("cred"), FABLE), false);
  assert.deepEqual(core.creditsServing(row("cred")), { window: false, fable: false });
});

test("fable_only: a used-up Fable share stays schedulable on credits, last in order; windows are untouched", () => {
  reset();
  policy("fable_only");
  for (const id of ["cred", "nocred"]) core.recordWindowUsage(id, fableSnap(1), 95);
  const before = core.usageCreditsCounters().fable;
  // run the listing several times: random tie-breaks must never put the credits account first
  for (let i = 0; i < 20; i++) assert.deepEqual(ids(FABLE), ["plan", "cred$"]);
  assert.equal(core.usageCreditsCounters().fable, before + 20, "each decision is counted");
  assert.ok(core.usageCreditsCounters().accounts.cred.fable >= 20);
  assert.deepEqual(ids(SONNET).sort(), ["cred", "nocred", "plan"], "other models: plain plan quota, no credits flag");
  const cd = core.parseModelCooldowns(row("cred").model_cooldowns).fable;
  assert.ok(cd.until > core.nowIso(), "the cooldown itself is still recorded");
  assert.ok(cd.reason.endsWith(core.ON_CREDITS_SUFFIX), cd.reason);
  assert.ok(!core.parseModelCooldowns(row("nocred").model_cooldowns).fable.reason.includes("usage credits"));
  assert.equal(core.onCredits(row("cred"), FABLE), true);
  assert.equal(core.onCredits(row("cred"), SONNET), false);
  assert.equal(core.onCredits(row("cred"), null), true);
  assert.equal(core.onCredits(row("nocred"), FABLE), false);
  // fable_only does not bridge the account-wide window
  core.recordWindowUsage("cred", snap5h(0.99), 95);
  assert.deepEqual(ids(SONNET).sort(), ["nocred", "plan"]);
  assert.deepEqual(ids(FABLE), ["plan"]);
  assert.ok(!row("cred").window_reason.includes("usage credits"));
  // a priority that would normally put the credits account first does not outrank plan quota
  reset();
  for (const id of ["cred"]) core.recordWindowUsage(id, fableSnap(1), 95);
  run("UPDATE accounts SET priority = 1 WHERE id = 'cred'");
  assert.equal(ids(FABLE).at(-1), "cred$");
  run("UPDATE accounts SET priority = 50 WHERE id = 'cred'");
});

test("all: a used-up 5h / weekly window stays schedulable on credits; no credits → paused as before", () => {
  reset();
  policy("all");
  for (const id of ["cred", "nocred"]) core.recordWindowUsage(id, snap5h(0.99), 95);
  assert.ok(row("cred").window_exhausted_until > core.nowIso(), "pause columns are written exactly as without the policy");
  assert.ok(row("cred").window_reason.endsWith(core.ON_CREDITS_SUFFIX), row("cred").window_reason);
  assert.ok(!row("nocred").window_reason.includes("usage credits"));
  for (let i = 0; i < 10; i++) assert.deepEqual(ids(SONNET), ["plan", "cred$"]);
  assert.ok(core.usageCreditsCounters().window >= 10);
  assert.deepEqual(core.creditsServing(row("cred")), { window: true, fable: false });
  // both exhausted at once
  core.recordWindowUsage("cred", snap5h(1, { fable: { used: 1, resetAt: core.isoIn(86_400_000) } }), 95);
  assert.deepEqual(ids(FABLE), ["plan", "cred$"]);
  assert.deepEqual(core.creditsServing(row("cred")), { window: true, fable: true });
  // a plain-429-cooling account with plan quota still sorts after everything (Candidate.cooling contract)
  core.markFailure("plan", { kind: "rate_limited" });
  assert.deepEqual(ids(SONNET), ["cred$", "plan*"]);
  // turning the policy off is effective at once: the stored pause applies again
  policy("off");
  assert.deepEqual(ids(SONNET), ["plan*"]);
  policy("all");
});

test("all: over the threshold but not yet paused → pause recorded with the credits note, account kept", () => {
  reset();
  policy("all");
  for (const id of ["cred", "nocred"]) run("UPDATE accounts SET window_used = 0.99, window_reset_at = ? WHERE id = ?", core.isoIn(3_600_000), id);
  assert.deepEqual(ids(SONNET), ["plan", "cred$"]);
  assert.ok(row("cred").window_exhausted_until > core.nowIso());
  assert.ok(row("cred").window_reason.endsWith(core.ON_CREDITS_SUFFIX));
  assert.ok(row("nocred").window_exhausted_until > core.nowIso());
  assert.ok(!row("nocred").window_reason.includes("usage credits"));
});

test("all: the post-reset rest is not a credits case", () => {
  reset();
  policy("all");
  // window rolled over a minute ago, the rest period still runs
  run("UPDATE accounts SET window_used = 1, window_reset_at = ?, window_exhausted_until = ?, window_reason = 'five_hour 100% ≥ 95% until x' WHERE id = 'cred'", past(60_000), core.isoIn(3_600_000));
  assert.deepEqual(ids(SONNET).sort(), ["nocred", "plan"]);
  assert.equal(core.onCredits(row("cred"), SONNET), false);
});

// "nocred" has plan quota in the next test and ties with "plan" at random: leave it out of the order checks
const ids2 = (m) => ids(m).filter((x) => x !== "nocred");

test("an upstream rejection after the last usage poll switches credits off until the next poll shows them usable", () => {
  reset();
  policy("all");
  // Fable: credits_required 429 (gateway proxy.ts → model_window_rejected)
  core.recordWindowUsage("cred", fableSnap(1), 95);
  assert.deepEqual(ids2(FABLE), ["plan", "cred$"]);
  core.markFailure("cred", { kind: "model_window_rejected", scope: "fable", resetAt: core.isoIn(86_400_000), reason: "credits_required (429)" });
  assert.deepEqual(ids2(FABLE), ["plan"], "cooled as today");
  assert.equal(core.creditsLive(row("cred")), false);
  assert.ok(core.parseModelCooldowns(row("cred").model_cooldowns).credits.rejectedAt);
  // a header sample that still shows the share exhausted does not bring the bypass back
  core.recordWindowUsage("cred", fableSnap(1), 95);
  assert.deepEqual(ids2(FABLE), ["plan"]);
  assert.ok(!core.parseModelCooldowns(row("cred").model_cooldowns).fable.reason.includes("usage credits"));
  // a usage poll OLDER than the rejection does not either
  setUsage("cred", ENABLED, past(30_000));
  assert.deepEqual(ids2(FABLE), ["plan"]);
  // a later poll that shows credits disabled: still cooled
  setUsage("cred", DISABLED, core.isoIn(2_000));
  assert.deepEqual(ids2(FABLE), ["plan"]);
  // a later poll that shows usable credits: bridged again
  setUsage("cred", ENABLED, core.isoIn(2_000));
  assert.deepEqual(ids2(FABLE), ["plan", "cred$"]);

  // Window: rejected-window 429 stays the hard exclusion it is today
  reset();
  core.recordWindowUsage("cred", snap5h(1), 95);
  assert.deepEqual(ids2(SONNET), ["plan", "cred$"]);
  core.markFailure("cred", { kind: "window_rejected", window: "five_hour", resetAt: core.isoIn(3_600_000) });
  assert.deepEqual(ids2(SONNET), ["plan"]);
  assert.equal(core.creditsLive(row("cred")), false);

  // Worker path: Claude Code's "hit your limit" text → window_exhausted
  reset();
  core.recordWindowUsage("cred", snap5h(1), 95);
  assert.deepEqual(ids2(SONNET), ["plan", "cred$"]);
  core.markFailure("cred", { kind: "window_exhausted", resetAt: core.isoIn(3_600_000), window: "five_hour" });
  assert.deepEqual(ids2(SONNET), ["plan"]);
  core.recordWindowUsage("cred", snap5h(1), 95); // header sample: still no bypass, no credits note
  assert.deepEqual(ids2(SONNET), ["plan"]);
  assert.ok(!row("cred").window_reason.includes("usage credits"));
  setUsage("cred", ENABLED, core.isoIn(2_000));
  assert.deepEqual(ids2(SONNET), ["plan", "cred$"]);

  // A plain 429 while being served on credits counts as a rejection too; one on plan quota does not
  reset();
  core.markFailure("cred", { kind: "rate_limited", retryAfterSec: 1 });
  assert.equal(core.parseModelCooldowns(row("cred").model_cooldowns).credits, undefined, "plan-quota 429 leaves no marker");
  reset();
  core.recordWindowUsage("cred", snap5h(1), 95);
  core.markFailure("cred", { kind: "rate_limited", retryAfterSec: 1 });
  assert.equal(core.creditsLive(row("cred")), false);
  assert.deepEqual(ids2(SONNET), ["plan"]);
});

test("credits never lift an organization suspension or other cooldowns", () => {
  reset();
  policy("all");
  core.markFailure("cred", { kind: "model_suspended", model: FABLE, until: core.isoIn(3_600_000) });
  assert.deepEqual(ids(FABLE).sort(), ["nocred", "plan"]);
  reset();
  core.recordWindowUsage("cred", snap5h(1), 95);
  core.markFailure("cred", { kind: "overloaded" });
  assert.deepEqual(ids(SONNET).sort(), ["nocred", "plan"]);
  reset();
  policy("off");
});
