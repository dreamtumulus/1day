import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CC_AUX_ACCEPT, CC_AUX_UA, REFRESH_UA,
  oauthTokenHeaders, oauthProfileHeaders, oauthRolesHeaders, oauthUsageHeaders,
  classifyDirectRateLimit,
} from "../dist/index.js";

test("2.1.312 token, profile, roles and usage headers stay endpoint-specific", () => {
  assert.deepEqual(oauthTokenHeaders(REFRESH_UA), {
    accept: CC_AUX_ACCEPT, "content-type": "application/json", "user-agent": "axios/1.15.2", "accept-encoding": "gzip, compress, deflate, br",
  });
  assert.deepEqual(Object.keys(oauthProfileHeaders("profile-token")), ["accept", "content-type", "authorization", "cache-control", "user-agent", "accept-encoding"]);
  assert.deepEqual(Object.keys(oauthRolesHeaders("roles-token")), ["accept", "authorization", "user-agent", "accept-encoding"]);
  assert.equal(oauthProfileHeaders("profile-token")["cache-control"], "no-cache");
  assert.equal(oauthRolesHeaders("roles-token")["content-type"], undefined);
  assert.equal(oauthProfileHeaders("profile-token")["user-agent"], CC_AUX_UA);
  assert.equal(oauthUsageHeaders("usage-token").authorization, "Bearer usage-token");
  assert.equal(oauthTokenHeaders(REFRESH_UA, "Bearer session")["user-agent"], REFRESH_UA);
  assert.equal("user-agent" in oauthTokenHeaders(""), false, "diagnostic empty UA override sends no UA header");
});

test("direct 429 classification separates request, model quota and account quota", () => {
  const request = classifyDirectRateLimit(JSON.stringify({ error: { code: "claude_code_version_too_old", message: "newer client required" } }), false);
  assert.equal(request.scope, "request");
  assert.equal(request.retryable, false);
  const model = classifyDirectRateLimit(JSON.stringify({ error: { details: { error_code: "credits_required" }, message: "model quota exhausted" } }), false);
  assert.equal(model.scope, "account_model");
  assert.equal(model.retryable, true);
  const account = classifyDirectRateLimit(JSON.stringify({ error: { type: "rate_limit_error", message: "ordinary rate limit" } }), false);
  assert.equal(account.scope, "account");
  const window = classifyDirectRateLimit("rate limited", true);
  assert.equal(window.code, "upstream_window_exhausted");
});
