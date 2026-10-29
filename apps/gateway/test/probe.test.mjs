// Liveness-probe interception (src/probe.ts, docs/gateway.md §2c, 2026-10-29): a repeated tiny body or an
// x-1day-probe header is answered from pool state and never reaches an account.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import Fastify from "fastify";

const dataDir = mkdtempSync(join(tmpdir(), "1dayapi-probe-"));
process.env.DATA_DIR = dataDir;
process.env.CONSOLE_BASE = "http://127.0.0.1:9"; // never reached: probes stop before any tunnel
const core = await import("@1dayapi/core");
const { proxy } = await import("../dist/proxy.js");
const { probeShape, detectProbe, recordProbeShape, resetProbeMemory, poolHealth, PROBE_MIN_REPEATS } = await import("../dist/probe.js");
const gateway = Fastify();
gateway.post("/v1/messages", (req, reply) => proxy(req, reply, "anthropic", "/v1/messages"));
gateway.post("/v1/chat/completions", (req, reply) => proxy(req, reply, "openai-chat", "/v1/chat/completions"));
await gateway.ready();
after(async () => { await gateway.close(); core.db.close(); rmSync(dataDir, { recursive: true, force: true }); });

const MODEL = "claude-sonnet-5";
const TEAM = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
let n = 0;
function seed({ accounts = 0, policy = null } = {}) {
  const id = `probe-${++n}`;
  core.run("INSERT INTO users(id,role,name,login_key_hash,login_key_preview,balance_usd) VALUES (?,'consumer',?,?,?,100)", id, id, `login-${id}`, "login");
  core.run("INSERT INTO groups(id,name) VALUES (?,?)", id, id);
  core.run("INSERT INTO api_keys(id,user_id,name,key_hash,key_preview,group_id,policy_json) VALUES (?,?,?,?,?,?,?)", id, id, id, core.sha256Hex(id), id, id, policy);
  core.ensureUpstreamTeam(TEAM);
  for (let i = 0; i < accounts; i++) {
    const aid = `${id}-${i}`;
    const pid = `proxy-${aid}`;
    core.run("INSERT INTO node_proxies(id,node_id,url_enc,status,team_id,isolation_version,resource_key) VALUES (?,?,?,'live',?,1,?)", pid, `node-${id}`, "test", TEAM, `ip:${pid}`);
    core.claimProxyResource(`ip:${pid}`, TEAM);
    core.run(`INSERT INTO accounts(id,name,platform,type,protocol,credential_enc,route,node_id,team_id,bound_proxy_id,review_status,priority,models)
      VALUES (?,?,'anthropic','oauth','anthropic',?,'node',?,?,?,'approved',?,?)`, aid, aid, core.encryptJson({ accessToken: `t-${aid}`, orgUuid: TEAM }), `node-${id}`, TEAM, pid, i, JSON.stringify([MODEL]));
    core.run("INSERT INTO account_groups(account_id,group_id,priority) VALUES (?,?,?)", aid, id, i);
  }
  return { id, headers: { authorization: `Bearer ${id}` } };
}
const tiny = (text = "hi", extra = {}) => ({ model: MODEL, max_tokens: 16, messages: [{ role: "user", content: text }], ...extra });
const post = (f, body, headers = {}, url = "/v1/messages") => gateway.inject({ method: "POST", url, headers: { ...f.headers, ...headers }, payload: body });

test("shape: tiny text-only requests qualify; tools, images, long prompts and big outputs do not", () => {
  assert.ok(probeShape(tiny(), "anthropic"));
  assert.ok(probeShape({ model: MODEL, messages: [{ role: "system", content: "be terse" }, { role: "user", content: [{ type: "text", text: "ping" }] }] }, "openai-chat"));
  assert.equal(probeShape(tiny("hi", { tools: [{ name: "x" }] }), "anthropic"), null);
  assert.equal(probeShape(tiny("x".repeat(65)), "anthropic"), null);
  assert.equal(probeShape(tiny("hi", { max_tokens: 4096 }), "anthropic"), null);
  assert.equal(probeShape({ model: MODEL, max_tokens: 8, messages: [{ role: "user", content: [{ type: "image", source: {} }] }] }, "anthropic"), null);
  assert.equal(probeShape({ model: MODEL, max_tokens: 8, messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }] }, "anthropic"), null, "three turns is a conversation");
  assert.notEqual(probeShape(tiny("hi"), "anthropic").hash, probeShape(tiny("hi", { model: "claude-opus-5" }), "anthropic").hash, "model is part of the identity");
});

test("detection: the Nth identical tiny body within the window is a probe; the header is one immediately", () => {
  resetProbeMemory();
  const body = tiny("ping");
  assert.equal(detectProbe("k1", body, "anthropic", {}), null, "first sight goes upstream");
  const second = detectProbe("k1", body, "anthropic", {});
  assert.equal(second?.reason, "repeat");
  assert.equal(second?.repeats, PROBE_MIN_REPEATS);
  assert.equal(detectProbe("k2", body, "anthropic", {}), null, "counted per key");
  assert.equal(detectProbe("k2", tiny("something else"), "anthropic", { "x-1day-probe": "1" })?.reason, "header");
  // window expiry: a sighting older than the window does not count
  resetProbeMemory();
  recordProbeShape("k3", "h", Date.now() - 3_600_000);
  assert.equal(recordProbeShape("k3", "h"), 1);
});

test("pool health counts schedulable accounts and excludes cooled ones", () => {
  const f = seed({ accounts: 2 });
  assert.deepEqual(poolHealth(f.id, MODEL), { total: 2, ready: 2, cooling: 0 });
  // a window-exhausted account is not a candidate at all; a plain 429 cooldown keeps it as a cooling candidate
  core.run("UPDATE accounts SET window_exhausted_until = ? WHERE id = ?", new Date(Date.now() + 3_600_000).toISOString(), `${f.id}-0`);
  assert.deepEqual(poolHealth(f.id, MODEL), { total: 1, ready: 1, cooling: 0 });
  core.run("UPDATE accounts SET rate_limited_until = ? WHERE id = ?", new Date(Date.now() + 3_600_000).toISOString(), `${f.id}-1`);
  const h = poolHealth(f.id, MODEL);
  assert.equal(h.ready, 0);
  assert.equal(h.cooling, 1);
});

test("gateway: header probe answered 200 'ok' from the platform with pool headers, zero-cost usage row, no account touched", async () => {
  resetProbeMemory();
  const f = seed({ accounts: 2 });
  const r = await post(f, tiny("ping"), { "x-1day-probe": "1" });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.headers["x-1day-probe"], "platform");
  assert.equal(r.headers["x-1day-pool-ready"], "2");
  const j = r.json();
  assert.equal(j.content[0].text, "ok");
  assert.equal(j.usage.output_tokens, 0);
  const row = core.one("SELECT mode, status_code, actual_cost, account_id, error_code FROM usage_logs WHERE api_key_id = ? ORDER BY created_at DESC LIMIT 1", f.id);
  assert.equal(row.mode, "probe", JSON.stringify(row));
  assert.equal(row.status_code, 200, JSON.stringify(row));
  assert.equal(row.actual_cost, 0, JSON.stringify(row));
  assert.equal(row.account_id, null, JSON.stringify(row));
  assert.equal(row.error_code, null, JSON.stringify(row));
  assert.equal(core.one("SELECT last_used_at FROM accounts WHERE id = ?", `${f.id}-0`).last_used_at, null, "no account was used");
  // streaming + openai-chat shape
  const s = await post(f, { ...tiny("ping"), stream: true }, { "x-1day-probe": "1" }, "/v1/chat/completions");
  assert.equal(s.statusCode, 200);
  assert.equal(s.headers["x-1day-probe"], "platform");
  assert.match(s.body, /"content":"ok"/);
  assert.match(s.body, /\[DONE\]/);
});

test("gateway: repeated tiny body is intercepted from the second sighting; empty pool answers 503; policy can switch it off", async () => {
  resetProbeMemory();
  const f = seed({ accounts: 0 }); // nothing schedulable: the first request fails on the normal path
  const first = await post(f, tiny("hello"));
  assert.equal(first.statusCode, 503);
  assert.equal(first.headers["x-1day-probe"], undefined, "first sighting is not a probe");
  const second = await post(f, tiny("hello"));
  assert.equal(second.statusCode, 503);
  assert.equal(second.headers["x-1day-probe"], "platform");
  assert.equal(second.headers["x-1day-pool-ready"], "0");
  assert.equal(second.json().error.code ?? second.json().error.type, second.json().error.code ?? "upstream_error");
  assert.equal(core.one("SELECT mode, error_code FROM usage_logs WHERE api_key_id = ? ORDER BY created_at DESC LIMIT 1", f.id).mode, "probe");
  // a different tiny body starts its own count
  const other = await post(f, tiny("hey"));
  assert.equal(other.headers["x-1day-probe"], undefined);
  // policy off: never intercepted
  const g = seed({ accounts: 0, policy: JSON.stringify({ historyPolicy: "reset", directOnly: false, probeIntercept: false }) });
  await post(g, tiny("hello")); const again = await post(g, tiny("hello"));
  assert.equal(again.headers["x-1day-probe"], undefined);
  // unknown model: left to the normal 404
  const u = await post(f, tiny("hello", { model: "no-such-model" }), { "x-1day-probe": "1" });
  assert.equal(u.statusCode, 404);
  assert.equal(u.headers["x-1day-probe"], undefined);
});

test("key policy parse: probeIntercept defaults on, only an explicit false turns it off", () => {
  assert.equal(core.parseKeyPolicy(null).probeIntercept, true);
  assert.equal(core.parseKeyPolicy('{"historyPolicy":"passthrough","directOnly":false}').probeIntercept, true);
  assert.equal(core.parseKeyPolicy('{"probeIntercept":false}').probeIntercept, false);
});
