// Saved organizations for the onboarding form (docs/onboarding.md §3 常用组织) and the
// sessionKey shape check: CRUD + validation + admin-only scope, against a real console
// app on a temp DATA_DIR. ONBOARD_MOCK is deliberately NOT set here so the format
// check is live (mock mode accepts fixture strings).
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "1dayapi-onboard-orgs-"));
process.env.DATA_DIR = dir;
process.env.CCR_WINDOW_POLL = "0";
process.env.ALLOW_UNTRUSTED_EXECUTION = "1";
delete process.env.ONBOARD_MOCK;
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

const core = await import("@1dayapi/core");
const { buildApp } = await import("../dist/app.js");
const { createUser } = await import("../dist/session.js");
void core;

const app = await buildApp();
await app.listen({ port: 0, host: "127.0.0.1" });
const BASE = `http://127.0.0.1:${app.server.address().port}`;

async function login(key) {
  const r = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key }),
  });
  assert.equal(r.status, 200);
  const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
  return async (method, path, body) => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await res.json().catch(() => ({}));
    return { status: res.status, ...j };
  };
}

const adminKey = readFileSync(join(dir, "admin-key.txt"), "utf8").trim();
const admin = await login(adminKey);
const ops = createUser("ops", "orgs-ops");
const opsCall = await login(ops.loginKey);
const provider = createUser("provider", "orgs-provider");
const prov = await login(provider.loginKey);

const ORG_A = "aaaaaaaa-1111-4111-8111-111111111111";
const ORG_B = "bbbbbbbb-2222-4222-8222-222222222222";

test("saved organizations: create, list, edit, delete", async () => {
  const empty = await admin("GET", "/api/admin/onboard/orgs");
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.data, []);

  const created = await admin("POST", "/api/admin/onboard/orgs", { name: "Customer A", orgUuid: ORG_A.toUpperCase(), note: "batch 1" });
  assert.equal(created.status, 201, JSON.stringify(created));
  assert.equal(created.data.name, "Customer A");
  assert.equal(created.data.orgUuid, ORG_A, "UUID is stored lowercased");
  assert.equal(created.data.note, "batch 1");

  const second = await admin("POST", "/api/admin/onboard/orgs", { name: "Customer B", orgUuid: ORG_B });
  assert.equal(second.status, 201);

  const list = await admin("GET", "/api/admin/onboard/orgs");
  assert.deepEqual(list.data.map((o) => o.name), ["Customer A", "Customer B"]);

  const edited = await admin("PATCH", `/api/admin/onboard/orgs/${created.data.id}`, { name: "Customer A (renamed)", note: null });
  assert.equal(edited.status, 200, JSON.stringify(edited));
  assert.equal(edited.data.name, "Customer A (renamed)");
  assert.equal(edited.data.orgUuid, ORG_A, "UUID unchanged when not sent");
  assert.equal(edited.data.note, null);

  const gone = await admin("DELETE", `/api/admin/onboard/orgs/${second.data.id}`);
  assert.equal(gone.status, 200);
  assert.deepEqual(gone.data, { ok: true });
  const after = await admin("GET", "/api/admin/onboard/orgs");
  assert.equal(after.data.length, 1);
  const missing = await admin("DELETE", `/api/admin/onboard/orgs/${second.data.id}`);
  assert.equal(missing.status, 404);
});

test("saved organizations: validation", async () => {
  const noName = await admin("POST", "/api/admin/onboard/orgs", { orgUuid: ORG_B });
  assert.equal(noName.status, 400);
  assert.equal(noName.error.code, "invalid_request");

  const badUuid = await admin("POST", "/api/admin/onboard/orgs", { name: "x", orgUuid: "not-a-uuid" });
  assert.equal(badUuid.status, 400);
  assert.equal(badUuid.error.code, "invalid_request");

  const dup = await admin("POST", "/api/admin/onboard/orgs", { name: "dup", orgUuid: ORG_A });
  assert.equal(dup.status, 400);
  assert.equal(dup.error.code, "org_exists");

  // Editing one row onto another row's UUID is also a duplicate.
  const b = await admin("POST", "/api/admin/onboard/orgs", { name: "B again", orgUuid: ORG_B });
  assert.equal(b.status, 201);
  const clash = await admin("PATCH", `/api/admin/onboard/orgs/${b.data.id}`, { orgUuid: ORG_A });
  assert.equal(clash.status, 400);
  assert.equal(clash.error.code, "org_exists");
});

test("saved organizations: admin only", async () => {
  for (const call of [opsCall, prov]) {
    const r = await call("GET", "/api/admin/onboard/orgs");
    assert.equal(r.status, 403, JSON.stringify(r));
    const w = await call("POST", "/api/admin/onboard/orgs", { name: "nope", orgUuid: ORG_B });
    assert.equal(w.status, 403);
  }
});

test("onboard: malformed sessionKey is rejected before any node or proxy work", async () => {
  // No node exists in this DB: a shape failure must win over node lookup, so nothing is reserved.
  for (const sessionKey of ["s", "sk-ant-sid01-short", "sk-ant-sid01-" + "a".repeat(50) + " trailing", "sessionKey=sk-ant-sid01-" + "b".repeat(60), "\"sk-ant-sid01-" + "c".repeat(60) + "\""]) {
    const r = await admin("POST", "/api/admin/accounts/onboard", { method: "session_key", sessionKey, nodeId: "node_missing" });
    assert.equal(r.status, 400, `${sessionKey} → ${JSON.stringify(r)}`);
    assert.equal(r.error.code, "session_key_format");
  }
  // A well-formed key passes the shape check and proceeds to the (missing) node.
  const ok = await admin("POST", "/api/admin/accounts/onboard", { method: "session_key", sessionKey: "sk-ant-sid01-" + "d".repeat(95) + "-AA", nodeId: "node_missing" });
  assert.equal(ok.status, 404, JSON.stringify(ok));
  // The provider route applies the same check.
  const p = await prov("POST", "/api/provider/accounts/onboard", { method: "session_key", sessionKey: "nope", nodeId: "node_missing" });
  assert.equal(p.status, 400);
  assert.equal(p.error.code, "session_key_format");
});

test.after(async () => {
  await app.close();
});
