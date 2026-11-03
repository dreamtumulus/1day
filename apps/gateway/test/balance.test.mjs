// GET /v1/balance — self-service balance lookup by API key (docs/gateway.md §1).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
const dir = mkdtempSync(join(tmpdir(), "1dayapi-balance-"));
process.env.DATA_DIR = dir;
after(() => rmSync(dir, { recursive: true, force: true }));
const c = await import("@1dayapi/core");
const { handleBalance } = await import("../dist/routes.js");
function reply() { return { statusCode: 200, status(n) { this.statusCode=n; return this; }, header() { return this; }, send(body) { this.body=body; return this; } }; }

function fixture({ balance = 10, limit = 0, used = 0, quota = 0, keyUsed = 0 } = {}) {
  const user = c.newId(), key = c.newId(), group = c.newId(), token = `bal-${key}`;
  c.run("INSERT INTO groups(id,name,rate_multiplier) VALUES (?,?,1.5)", group, "g-" + group);
  c.run("INSERT INTO users(id,role,name,login_key_hash,login_key_preview,balance_usd,credit_limit_usd,credit_used_usd) VALUES (?,'consumer','fixture',?,'p',?,?,?)", user, user, balance, limit, used);
  c.run("INSERT INTO api_keys(id,user_id,name,key_hash,key_preview,group_id,quota_usd,used_usd) VALUES (?,?,'my-key',?,'p',?,?,?)", key, user, c.sha256Hex(token), group, quota, keyUsed);
  return { key, group, req: { headers: { authorization: `Bearer ${token}` }, url: "/v1/balance", ip: "127.0.0.1", body: {} } };
}

test("reports prepaid balance, credit line and per-key quota", async () => {
  const f = fixture({ balance: 12.5, limit: 100, used: 40.25, quota: 20, keyUsed: 5 });
  const r = reply();
  const body = await handleBalance(f.req, r);
  assert.equal(r.statusCode, 200);
  assert.equal(body.object, "balance");
  assert.equal(body.balance_usd, 12.5);
  assert.equal(body.credit_limit_usd, 100);
  assert.equal(body.credit_used_usd, 40.25);
  assert.equal(body.available_usd, 72.25, "limit − used + balance");
  assert.deepEqual(body.key, { id: f.key, name: "my-key", quota_usd: 20, used_usd: 5, remaining_usd: 15, expires_at: null });
  assert.equal(body.group.id, f.group);
  assert.equal(body.group.rate_multiplier, 1.5);
});

test("unlimited key quota is reported as null; zero balance is still readable", async () => {
  const f = fixture({ balance: 0 });
  const r = reply();
  const body = await handleBalance(f.req, r);
  assert.equal(r.statusCode, 200);
  assert.equal(body.available_usd, 0);
  assert.equal(body.key.quota_usd, null);
  assert.equal(body.key.remaining_usd, null);
});

test("rejects a bad key with the usual 401 envelope", async () => {
  const r = reply();
  await handleBalance({ headers: { authorization: "Bearer sk-1d-nope" }, url: "/v1/balance", ip: "127.0.0.1", body: {} }, r);
  assert.equal(r.statusCode, 401);
  assert.equal(r.body.error.code, "invalid_api_key");
  const a = reply();
  await handleBalance({ headers: { "anthropic-version": "2023-06-01" }, url: "/v1/balance", ip: "127.0.0.1", body: {} }, a);
  assert.equal(a.statusCode, 401);
  assert.equal(a.body.type, "error", "Anthropic envelope when anthropic-version is present");
});
