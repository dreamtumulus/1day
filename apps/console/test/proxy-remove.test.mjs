// POST /api/admin/nodes/:id/proxies/remove (2026-10-28): bulk removal by id; bound / reserved rows stay and are reported.
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "1dayapi-proxy-remove-"));
process.env.DATA_DIR = dir;
process.env.CCR_WINDOW_POLL = "0";
process.env.ALLOW_UNTRUSTED_EXECUTION = "1";
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

const core = await import("@1dayapi/core");
const { buildApp } = await import("../dist/app.js");
const { replaceNodeProxies } = await import("../dist/node/proxies.js");
const { createUser } = await import("../dist/session.js");
const { run, one } = core;

const app = await buildApp();
await app.listen({ port: 0, host: "127.0.0.1" });
const BASE = `http://127.0.0.1:${app.server.address().port}`;
async function login(key) {
  const r = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key }) });
  const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
  return async (method, path, body) => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, ...(await res.json().catch(() => ({}))) };
  };
}
const admin = await login(readFileSync(join(dir, "admin-key.txt"), "utf8").trim());
const owner = createUser("provider", "rm-fixture");
run("INSERT INTO nodes(node_id,provider_id,secret_hash,online,accepting_sessions,created_at) VALUES ('rm-node',?,'h',1,1,?)", owner.id, core.nowIso());
const urls = ["http://u:p@198.51.100.21:8000", "http://u:p@198.51.100.22:8000", "http://u:p@198.51.100.23:8000"];
replaceNodeProxies("rm-node", urls.map((url) => ({ url })));
const ids = urls.map((u) => core.sha256Hex(u).slice(0, 12));
run(`INSERT INTO accounts(id,name,platform,type,protocol,executor,credential_enc,owner_id,route,node_id,review_status,bound_proxy_id)
  VALUES ('rm-acc','rm-acc','anthropic','oauth','anthropic','ccr_worker',?,?,'node','rm-node','approved',?)`, core.encryptJson({ accessToken: "x" }), owner.id, ids[2]);

test("remove: free rows deleted, bound row reported, unknown id reported, pool count updated", async () => {
  const r = await admin("POST", "/api/admin/nodes/rm-node/proxies/remove", { proxyIds: [ids[0], ids[1], ids[2], "000000000000"] });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.deepEqual(r.data.removed.sort(), [ids[0], ids[1]].sort());
  assert.deepEqual(r.data.bound, [ids[2]]);
  assert.deepEqual(r.data.notFound, ["000000000000"]);
  assert.equal(r.data.remaining, 1);
  assert.equal(one("SELECT COUNT(*) n FROM node_proxies WHERE node_id='rm-node'").n, 1);
  assert.equal(one("SELECT COUNT(*) n FROM proxy_team_events WHERE event='proxy_removed'").n, 2);
  const empty = await admin("POST", "/api/admin/nodes/rm-node/proxies/remove", { proxyIds: [] });
  assert.equal(empty.status, 400);
  const prov = await (await login(owner.loginKey))("POST", "/api/admin/nodes/rm-node/proxies/remove", { proxyIds: [ids[2]] });
  assert.equal(prov.status, 403);
});
test.after(async () => { await app.close(); });
