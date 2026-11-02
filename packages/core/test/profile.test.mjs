import assert from "node:assert/strict";
import { test } from "node:test";
import { parseOAuthProfile, planLabel, expectedFiveHourWindow, scrubProfileJson } from "../dist/profile.js";

test("OAuth profile: email + plan flags + org", () => {
  const p = parseOAuthProfile({ account: { uuid: "a-1", email: "x@y.us", display_name: "X", has_claude_max: true, has_claude_pro: false }, organization: { uuid: "o-1", billing_type: "stripe_subscription", rate_limit_tier: "default_claude_max_5x" } });
  const { details, rawJson, planLabel: label, ...flat } = p;
  assert.deepEqual(flat, { email: "x@y.us", accountUuid: "a-1", orgUuid: "o-1", orgName:null,subscriptionType: "max", rateLimitTier: "default_claude_max_5x", displayName: "X" });
  assert.equal(label, "Max (ex Max 5x)");
  assert.equal(details.account.hasClaudeMax, true);
  assert.equal(details.organization.billingType, "stripe_subscription");
  assert.equal(JSON.parse(rawJson).organization.rate_limit_tier, "default_claude_max_5x");
  assert.equal(parseOAuthProfile({organization:{uuid:"org",name:"Actual team name"}}).orgName,"Actual team name");
  assert.equal(parseOAuthProfile({ account: { email: "p@q.us", has_claude_pro: true } }).subscriptionType, "pro");
  // live Team seat shape (2026-10-16): flags false, plan comes from organization_type
  const team = parseOAuthProfile({ account: { email: "t@q.us", has_claude_max: false, has_claude_pro: false }, organization: { organization_type: "claude_team", billing_type: "stripe_subscription", rate_limit_tier: "default_claude_max_5x", seat_tier: "team_tier_1" } });
  assert.equal(team.subscriptionType, "team");
  assert.equal(team.rateLimitTier, "default_claude_max_5x");
  assert.equal(parseOAuthProfile({ account: { email: "e@q.us" }, organization: { organization_type: "claude_enterprise" } }).subscriptionType, "enterprise");
  assert.equal(parseOAuthProfile({ account: { email: "f@q.us" }, organization: { rate_limit_tier: "default_claude_ai" } }).subscriptionType, "free");
  assert.equal(parseOAuthProfile({ account: { email: "m@q.us" }, organization: { rate_limit_tier: "default_claude_max_20x" } }).subscriptionType, "max");
  assert.equal(parseOAuthProfile({ email: "flat@q.us" }).email, "flat@q.us", "flat shape tolerated");
  assert.equal(parseOAuthProfile({}), null);
  assert.equal(parseOAuthProfile("nope"), null);
});

test("OAuth profile: every field kept, secrets scrubbed, plan label separates Ultra from Max (2026-11-02)", () => {
  const live = { account: { uuid: "acc", email: "m@q.us", full_name: "Maya", display_name: "maya", has_claude_max: true, has_claude_pro: false, created_at: "2026-10-01T00:00:00Z" },
    organization: { uuid: "org", name: "Discovery", organization_type: "claude_max", billing_type: "stripe_subscription", rate_limit_tier: "default_claude_max_20x", seat_tier: null, subscription_status: "active", some_new_flag: true, api_token: "SECRET" },
    application: { uuid: "app", name: "Claude Code" } };
  const p = parseOAuthProfile(live);
  assert.equal(p.planLabel, "Ultra (ex Max 20x)");
  assert.equal(p.details.organization.subscriptionStatus, "active");
  assert.deepEqual(p.details.organization.extra, { some_new_flag: true });
  assert.equal(p.details.application.name, "Claude Code");
  assert.equal(p.details.account.createdAt, "2026-10-01T00:00:00Z");
  assert.ok(!p.rawJson.includes("SECRET"), "secret-looking keys never reach storage");
  assert.equal(planLabel("default_claude_max_5x", "claude_team", "team_tier_1"), "Team · Max (ex Max 5x) (team_tier_1)");
  assert.equal(planLabel("default_claude_pro"), "Pro");
  assert.equal(planLabel("default_claude_ultra"), "Ultra");
  assert.equal(planLabel(null, "claude_enterprise"), "Enterprise");
  assert.equal(planLabel(null, null, null, "max"), "Max");
  // Pro / Max / Team keep the five-hour window; Ultra is unknown until a usage probe or rate_limit_event settles it
  assert.equal(expectedFiveHourWindow("default_claude_pro"), true);
  assert.equal(expectedFiveHourWindow("default_claude_max_5x", "claude_team"), true);
  assert.equal(expectedFiveHourWindow("default_claude_max_20x"), null);
  assert.equal(expectedFiveHourWindow("default_claude_ultra"), null);
  assert.deepEqual(scrubProfileJson({ a: 1, refresh_token: "x", nested: { session_key: "y", ok: "z" } }), { a: 1, nested: { ok: "z" } });
});
