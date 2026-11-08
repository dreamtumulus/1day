// Canonical worker keys forward their history whole unless a layer names a historyPolicy (2026-11-05).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "1dayapi-canon-hist-"));
process.env.DATA_DIR = dir;
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
const core = await import("../dist/index.js");
const { parseKeyPolicy, setSetting } = core;

test("canonical workerMode defaults historyPolicy to passthrough; a named policy wins; legacy keeps reset", () => {
  assert.equal(parseKeyPolicy(null).historyPolicy, "reset");
  assert.equal(parseKeyPolicy(JSON.stringify({ auto: {}, override: { workerMode: "canonical" } })).historyPolicy, "passthrough");
  assert.equal(parseKeyPolicy(JSON.stringify({ auto: {}, override: { workerMode: "canonical", historyPolicy: "reset" } })).historyPolicy, "reset");
  assert.equal(parseKeyPolicy(JSON.stringify({ auto: {}, override: { workerMode: "canonical", historyPolicy: "reject" } })).historyPolicy, "reject");
  assert.equal(parseKeyPolicy(JSON.stringify({ auto: {}, override: { workerMode: "legacy" } })).historyPolicy, "reset");
  // auto layer: canonical only counts when the auto layer is in force
  const autoDoc = JSON.stringify({ auto: { workerMode: "canonical" }, override: {} });
  setSetting("key_policy_auto", "0");
  assert.equal(parseKeyPolicy(autoDoc).historyPolicy, "reset");
  setSetting("key_policy_auto", "1");
  assert.equal(parseKeyPolicy(autoDoc).historyPolicy, "passthrough");
  setSetting("key_policy_auto", "0");
});

test("worker_mode_default setting supplies the base workerMode; layers still win", () => {
  setSetting("worker_mode_default", "canonical");
  assert.equal(parseKeyPolicy(null).workerMode, "canonical");
  assert.equal(parseKeyPolicy(null).historyPolicy, "passthrough", "canonical default carries the passthrough default");
  assert.equal(parseKeyPolicy(JSON.stringify({ auto: {}, override: { workerMode: "legacy" } })).workerMode, "legacy");
  setSetting("worker_mode_default", "bogus");
  assert.equal(parseKeyPolicy(null).workerMode, "legacy", "unknown value falls back to legacy");
  setSetting("worker_mode_default", "legacy");
  assert.equal(parseKeyPolicy(null).historyPolicy, "reset");
});

test("account_freeze_on_proxy=0: freezeAccountForProxy is a no-op; boundProxyDown ignores the organization tag/claim when the binding is off", () => {
  const { freezeAccountForProxy, boundProxyDown, run } = core;
  run("INSERT INTO upstream_teams (id, name, status, created_at) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','A','active','2026-11-06T00:00:00Z'),('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','B','active','2026-11-06T00:00:00Z')");
  run("INSERT INTO node_proxies (id, node_id, url_enc, status, isolation_version, exit_ip, resource_key, team_id) VALUES ('p1','node_x','x','live',1,'203.0.113.5','ip:203.0.113.5','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')");
  run("INSERT INTO proxy_team_claims (resource_key, team_id) VALUES ('ip:203.0.113.5','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')");
  const acct = { bound_proxy_id: "p1", team_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", node_id: "node_x" };
  setSetting("proxy_org_binding_enforce", "1");
  assert.equal(boundProxyDown(acct), true, "enforced: another organization's exit gates the account");
  setSetting("proxy_org_binding_enforce", "0");
  assert.equal(boundProxyDown(acct), false, "binding off: live exit of another organization is schedulable");
  run("UPDATE node_proxies SET status='dead' WHERE id='p1'");
  assert.equal(boundProxyDown(acct), true, "a dead exit still gates");
  run("UPDATE node_proxies SET status='live' WHERE id='p1'");
  setSetting("proxy_org_binding_enforce", "1");
  run("INSERT INTO accounts (id, name, type, platform, protocol, status, review_status, credential_enc, created_at, updated_at, bound_proxy_id, team_id) VALUES ('acc-f','f','oauth','anthropic','anthropic','active','approved','x','2026-11-06T00:00:00Z','2026-11-06T00:00:00Z','p1','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')");
  setSetting("account_freeze_on_proxy", "0");
  assert.equal(freezeAccountForProxy("acc-f", { proxyId: "p1", reason: "test" }), false, "freezing off: no-op");
  assert.equal(core.one("SELECT status FROM accounts WHERE id='acc-f'").status, "active");
  setSetting("account_freeze_on_proxy", "1");
  assert.equal(freezeAccountForProxy("acc-f", { proxyId: "p1", reason: "test" }), true, "freezing on: frozen");
  assert.equal(core.one("SELECT status FROM accounts WHERE id='acc-f'").status, "proxy_down");
});
