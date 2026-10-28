import assert from "node:assert/strict";
import { test } from "node:test";
import { parseOAuthProfile } from "../dist/profile.js";

test("OAuth profile: email + plan flags + org", () => {
  const p = parseOAuthProfile({ account: { uuid: "a-1", email: "x@y.us", display_name: "X", has_claude_max: true, has_claude_pro: false }, organization: { uuid: "o-1", billing_type: "stripe_subscription", rate_limit_tier: "default_claude_max_5x" } });
  assert.deepEqual(p, { email: "x@y.us", accountUuid: "a-1", orgUuid: "o-1", orgName:null,subscriptionType: "max", rateLimitTier: "default_claude_max_5x", displayName: "X" });
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
