import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "worker0-console-"));
process.env.DATA_DIR = dir;
process.env.CCR_WINDOW_POLL = "0";
process.env.WORKER0_CONTROL_TOKEN = "worker0-test-token";
const core = await import("@1dayapi/core");
const { buildApp } = await import("../dist/app.js");
const { createUser } = await import("../dist/session.js");
const { run, one, encryptJson, readCredential, computeCost } = core;
const app = await buildApp();
await app.ready();
after(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(path, body, token = true) {
  const response = await app.inject({ method: "POST", url: `/internal/worker0/${path}`, headers: { "x-worker0-token": token ? "worker0-test-token" : "" }, payload: body });
  return { status: response.statusCode, ...response.json() };
}

const user = createUser("consumer", "worker0-user");
run("UPDATE users SET balance_usd=100 WHERE id=?", user.id);
run("INSERT INTO groups (id,name,rate_multiplier,status) VALUES ('worker0-group','worker0-group',1,'active')");
run("INSERT INTO users (id,role,name,login_key_hash,login_key_preview) VALUES ('worker0-owner','consumer','worker0-owner','owner-hash','owner-preview')");
run("INSERT INTO accounts (id,name,platform,type,protocol,base_url,credential_enc,owner_id,status,review_status) VALUES ('worker0-account','worker0-account','anthropic','apikey','anthropic','https://api.anthropic.com',?,'worker0-owner','active','approved')", encryptJson({ apiKey: "upstream-key" }));
run("INSERT INTO account_groups (account_id,group_id) VALUES ('worker0-account','worker0-group')");
const login = await app.inject({ method: "POST", url: "/auth/login", payload: { key: user.loginKey } });
const cookie = login.headers["set-cookie"].split(";")[0];
const created = await (await app.inject({ method: "POST", url: "/api/user/keys", headers: { cookie }, payload: { name: "worker0-key", groupId: "worker0-group" } })).json();
const clientKey = created.data.key;
assert.ok(clientKey, JSON.stringify(created));
const model = "claude-sonnet-4-5-20250929";

await test("worker0 admission, durable billing, windows and credential rotation", async () => {
  const forbidden = await call("admission", { clientKey, model }, false);
  assert.equal(forbidden.status, 403);

  const admission = await call("admission", { requestId: crypto.randomUUID(), clientKey, model, endpoint: "/v1/messages", stream: false });
  assert.equal(admission.status, 200, JSON.stringify(admission));
  assert.deepEqual(admission.data.accountIds, ["worker0-account"]);
  const requestId = crypto.randomUUID();
  const usage = { input_tokens: 100, output_tokens: 20, cache_read_tokens: 50, cache_write_tokens: 30, cache_write_5m_tokens: 20, cache_write_1h_tokens: 10 };
  const payload = { requestId, clientKey, accountId: "worker0-account", model, endpoint: "/v1/messages", stream: false, statusCode: 200, usage, usageEstimated: false, mode: "worker0-native" };
  const first = await call("settle", payload);
  assert.equal(first.status, 200, JSON.stringify(first));
  assert.equal(first.data.settled, true);
  const second = await call("settle", payload);
  assert.equal(second.data.settled, false);
  assert.equal(one("SELECT count(*) n FROM usage_logs WHERE request_id=?", requestId).n, 1);
  assert.equal(one("SELECT cache_write_5m_tokens a,cache_write_1h_tokens b FROM usage_logs WHERE request_id=?", requestId).a, 20);
  assert.equal(one("SELECT cache_write_5m_tokens a,cache_write_1h_tokens b FROM usage_logs WHERE request_id=?", requestId).b, 10);
  assert.ok(Math.abs(one("SELECT used_usd n FROM api_keys WHERE key_hash=?", core.sha256Hex(clientKey)).n - computeCost(model, usage)) < 1e-9);

  const reset5 = new Date(Date.now() + 2 * 3600000).toISOString();
  const sample5 = await call("account-event", { accountId: "worker0-account", model, statusCode: 200, headers: { "anthropic-ratelimit-unified-5h-utilization": "0.99", "anthropic-ratelimit-unified-5h-reset": String(Math.floor(Date.parse(reset5) / 1000)) }, body: "" });
  assert.equal(sample5.status, 200, JSON.stringify(sample5));
  const paused = one("SELECT window_exhausted_until u,window_5h_used used FROM accounts WHERE id='worker0-account'");
  assert.ok(Date.parse(paused.u) > Date.parse(reset5) + 90 * 60000);
  await call("account-event", { accountId: "worker0-account", model, statusCode: 200, headers: { "anthropic-ratelimit-unified-5h-utilization": "0.50", "anthropic-ratelimit-unified-5h-reset": String(Math.floor(Date.parse(reset5) / 1000)) }, body: "" });
  assert.equal(one("SELECT window_exhausted_until u FROM accounts WHERE id='worker0-account'").u, paused.u);
  assert.equal(one("SELECT window_5h_used used FROM accounts WHERE id='worker0-account'").used, 0.99);
  const denied = await call("admission", { requestId: crypto.randomUUID(), clientKey, model, endpoint: "/v1/messages", stream: false });
  assert.equal(denied.status, 503);
  const reset7 = new Date(Date.now() + 3 * 86400000).toISOString();
  await call("account-event", { accountId: "worker0-account", model, statusCode: 429, headers: { "anthropic-ratelimit-unified-7d-utilization": "1", "anthropic-ratelimit-unified-7d-reset": String(Math.floor(Date.parse(reset7) / 1000)), "anthropic-ratelimit-unified-7d-status": "rejected" }, body: "rate limited" });
  assert.equal(Math.floor(Date.parse(one("SELECT rate_limited_until u FROM accounts WHERE id='worker0-account'").u) / 1000), Math.floor(Date.parse(reset7) / 1000));

  run("UPDATE accounts SET credential_enc=? WHERE id='worker0-account'", encryptJson({ accessToken: "current-a", refreshToken: "current-r", expiresAt: new Date(Date.now() + 3600000).toISOString() }));
  const credential = { accessToken: "next-a", refreshToken: "next-r", expiresAt: new Date(Date.now() + 7200000).toISOString() };
  const rotated = await call("credential-rotation", { accountId: "worker0-account", expectedRefreshToken: "current-r", credential });
  assert.equal(rotated.data.rotated, true);
  const stale = await call("credential-rotation", { accountId: "worker0-account", expectedRefreshToken: "current-r", credential: { accessToken: "stale-a", refreshToken: "stale-r", expiresAt: credential.expiresAt } });
  assert.equal(stale.data.conflict, true);
  assert.equal(stale.data.credential.accessToken, "next-a");
  assert.equal(readCredential(one("SELECT credential_enc FROM accounts WHERE id='worker0-account'")).accessToken, "next-a");
});
