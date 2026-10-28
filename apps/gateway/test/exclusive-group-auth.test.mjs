import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
const dir = mkdtempSync(join(tmpdir(), "1dayapi-auth-grant-"));
process.env.DATA_DIR = dir;
after(() => rmSync(dir, { recursive: true, force: true }));
const c = await import("@1dayapi/core");
const { authenticate } = await import("../dist/auth.js");
function reply() { return { statusCode: 200, status(n) { this.statusCode=n; return this; }, header() { return this; }, send(body) { this.body=body; return this; } }; }

test("exclusive group grant revocation takes effect on an existing Key immediately", () => {
  const user = c.newId(), key = c.newId(), group = c.newId(), token = "audit-fixture-token";
  c.run("INSERT INTO groups(id,name,is_exclusive) VALUES (?,?,1)", group, group);
  c.run("INSERT INTO users(id,role,name,login_key_hash,login_key_preview,balance_usd) VALUES (?,'consumer','fixture',?,'p',10)", user, user);
  c.run("INSERT INTO api_keys(id,user_id,name,key_hash,key_preview,group_id) VALUES (?,?,'k',?,'p',?)", key, user, c.sha256Hex(token), group);
  c.run("INSERT INTO user_allowed_groups(user_id,group_id) VALUES (?,?)", user, group);
  const req = { headers: { authorization: `Bearer ${token}` }, url: "/v1/messages", ip: "127.0.0.1", body: {} };
  assert.equal(authenticate(req, reply(), "anthropic", true).apiKeyId, key);
  c.run("DELETE FROM user_allowed_groups WHERE user_id=? AND group_id=?", user, group);
  const denied = reply();
  assert.equal(authenticate(req, denied, "anthropic", true), null);
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.body.error.code, "group_access_revoked");
  assert.ok(c.one("SELECT 1 FROM api_keys WHERE id=?", key), "history and existing key are retained");
  c.run("INSERT INTO user_allowed_groups(user_id,group_id) VALUES (?,?)", user, group);
  assert.equal(authenticate(req, reply(), "anthropic", true).apiKeyId, key);
});
