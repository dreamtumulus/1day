// Review 2026-11-09, items A (retry caps on the organisation-scoped path) and C (direct-lane 401 / 403 handling).
// The only "upstream" is the fake console tunnel below (a local HTTP server): nothing leaves the machine.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { after, beforeEach, test } from "node:test";
import Fastify from "fastify";

const dataDir = mkdtempSync(join(tmpdir(), "1dayapi-retry-caps-"));
process.env.DATA_DIR = dataDir;
process.env.PROBE_INTERCEPT = "0";
process.env.ACCOUNT_BUSY_WAIT_MS = "300";

// Safety net: any fetch that is not to this machine fails the test run instead of reaching a real service.
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === "string" ? input : input.url ?? String(input));
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") return Promise.reject(new Error(`test tried to reach ${url.hostname}`));
  return realFetch(input, init);
};

const sessions = new Map();
const attempts = [];      // upstream model calls, in order: { accountId, isolation }
const tokenCalls = [];    // token-endpoint calls (forced refresh), by account
const behaviors = new Map();
let nextSession = 0;
const ok = (accountId, model) => ({ status: 200, body: JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model, content: [{ type: "text", text: `reply:${accountId}` }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }) });
const errorBody = (type, message) => JSON.stringify({ type: "error", error: { type, message } });
const consoleServer = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  const path = new URL(req.url, "http://local").pathname;
  res.setHeader("content-type", "application/json");
  if (path === "/internal/tunnel/reset" || path === "/internal/tunnel/archive") { res.end('{"ok":true}'); return; }
  if (path === "/internal/tunnel/open") {
    const sid = `session-${++nextSession}`;
    sessions.set(sid, { accountId: body.accountId, isolation: body.isolation, seq: 0 });
    res.end(JSON.stringify({ sessionId: sid })); return;
  }
  const [, , , sid, action] = path.split("/");
  const session = sessions.get(sid);
  if (!session) { res.statusCode = 404; res.end("{}"); return; }
  if (action === "close") { session.payload ??= Buffer.alloc(0); session.ready?.(); }
  if (action === "data") {
    const spec = JSON.parse(Buffer.from(body.payloadBase64, "base64").toString());
    const raw = Buffer.from(spec.bodyBase64, "base64").toString();
    let out;
    if (new URL(spec.url).pathname.endsWith("/oauth/token")) {
      tokenCalls.push(session.accountId);
      out = { status: 200, body: JSON.stringify({ access_token: `at-${tokenCalls.length}`, refresh_token: `rt-${tokenCalls.length}`, expires_in: 28800 }) };
    } else {
      const request = raw ? JSON.parse(raw) : {};
      const n = attempts.filter((a) => a.accountId === session.accountId).length;
      attempts.push({ accountId: session.accountId, isolation: session.isolation });
      const b = behaviors.get(session.accountId);
      const spec2 = typeof b === "function" ? b(n) : b;
      if (spec2?.delay) await new Promise((r) => setTimeout(r, spec2.delay));
      out = !spec2 || spec2.status === 200 || spec2.status === undefined ? ok(session.accountId, request.model) : spec2;
    }
    session.payload = Buffer.from(JSON.stringify({ status: out.status, headers: { "content-type": out.contentType ?? "application/json", ...(out.headers ?? {}) } }) + "\n" + (out.body ?? ""));
    session.ready?.();
    res.end("{}"); return;
  }
  if (action === "read") {
    if (!session.payload) await new Promise((resolve) => { session.ready = resolve; });
    res.end(JSON.stringify({ chunks: [{ seq: session.seq++, payloadBase64: session.payload.toString("base64") }], closed: true })); return;
  }
  res.end("{}");
});
await new Promise((resolve) => consoleServer.listen(0, "127.0.0.1", resolve));
process.env.CONSOLE_BASE = `http://127.0.0.1:${consoleServer.address().port}`;
const core = await import("@1dayapi/core");
const { proxy, resetAuthFailureTrackersForTests } = await import("../dist/proxy.js");
const { config } = await import("../dist/config.js");
const metrics = await import("../dist/metrics.js");
const policy = await import("../dist/retry-policy.js");
const { directAuthSignal, credentialProblem } = await import("../dist/direct-auth.js");
const gateway = Fastify();
gateway.post("/v1/messages", (req, reply) => proxy(req, reply, "anthropic", "/v1/messages"));
await gateway.ready();
after(async () => { await gateway.close(); await new Promise((resolve) => consoleServer.close(resolve)); core.db.close(); rmSync(dataDir, { recursive: true, force: true }); });
const DEFAULTS = { maxTotalAttempts: config.maxTotalAttempts, retryDeadlineMs: config.retryDeadlineMs, sameFailureStreak: config.sameFailureStreak };
beforeEach(() => { Object.assign(config, DEFAULTS); metrics.resetCounters(); resetAuthFailureTrackersForTests(); });

const TEAMS = ["aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb", "cccccccc-cccc-4ccc-cccc-cccccccccccc"];
const MODEL = "claude-sonnet-5";
let scenario = 0;
/** accountSpecs: [{ team: 0|1|2, ...behavior } | { team, behave: fn }], in scheduling order. */
function seed(accountSpecs) {
  const id = `rc-${++scenario}`;
  core.run("INSERT INTO users(id,role,name,login_key_hash,login_key_preview,balance_usd) VALUES (?,'consumer',?,?,?,100)", id, id, `login-${id}`, "login");
  core.run("INSERT INTO groups(id,name) VALUES (?,?)", id, id);
  core.run("INSERT INTO api_keys(id,user_id,name,key_hash,key_preview,group_id) VALUES (?,?,?,?,?,?)", id, id, id, core.sha256Hex(id), id, id);
  const ids = [];
  accountSpecs.forEach((spec, index) => {
    const aid = `${id}-${index}`, pid = `proxy-${aid}`, team = TEAMS[spec.team];
    core.ensureUpstreamTeam(team);
    core.run("INSERT INTO node_proxies(id,node_id,url_enc,status,team_id,isolation_version,resource_key) VALUES (?,?,?,'live',?,1,?)", pid, `node-${id}`, "test", team, `ip:${pid}`);
    core.claimProxyResource(`ip:${pid}`, team);
    core.run(`INSERT INTO accounts(id,name,platform,type,protocol,credential_enc,route,node_id,team_id,bound_proxy_id,priority,models)
      VALUES (?,?,'anthropic','oauth','anthropic',?,'node',?,?,?,?,?)`, aid, aid, core.encryptJson(spec.cred ?? { accessToken: `token-${aid}`, orgUuid: team }), `node-${id}`, team, pid, index, JSON.stringify([MODEL]));
    core.run("INSERT INTO account_groups(account_id,group_id,priority) VALUES (?,?,?)", aid, id, index);
    behaviors.set(aid, spec.behave ?? spec);
    ids.push(aid);
  });
  return { id, ids, headers: { authorization: `Bearer ${id}`, "x-claude-code-session-id": `session-${id}` } };
}
const send = (f, text = "question") => gateway.inject({ method: "POST", url: "/v1/messages", headers: f.headers, payload: { model: MODEL, max_tokens: 30, messages: [{ role: "user", content: text }] } });
const tried = (f, start) => attempts.slice(start).map((a) => a.accountId.replace(`${f.id}-`, "")).join(",");
const account = (id) => core.one("SELECT status, temp_unschedulable_until t, overload_until o, rate_limited_until r, error_message m FROM accounts WHERE id=?", id);
const cooled = (id) => { const a = account(id); return !!(a.t || a.o || a.r) || a.status !== "active"; };
const uncool = (id) => core.run("UPDATE accounts SET temp_unschedulable_until=NULL, overload_until=NULL, rate_limited_until=NULL WHERE id=?", id);
const E500 = { status: 500, body: errorBody("api_error", "Internal server error") };
const E529 = { status: 529, body: errorBody("overloaded_error", "Overloaded") };
const HTML403 = { status: 403, contentType: "text/html", body: "<html><head><title>403 Forbidden</title></head><body>Access denied by proxy. authentication_error OAuth token has been revoked</body></html>" };

// ---------- A: pure tables ----------

const LIMITS = { maxTotalAttempts: 6, retryDeadlineMs: 120_000, sameFailureStreak: 3 };
for (const [name, attemptsDone, elapsed, expected] of [
  ["first attempt, no time passed", 0, 0, null],
  ["first attempt is never refused by the deadline (long account wait)", 0, 500_000, null],
  ["a retry inside both caps", 3, 60_000, null],
  ["fifth failure, sixth attempt still allowed", 5, 1_000, null],
  ["sixth attempt done → attempt cap", 6, 1_000, "attempt_cap"],
  ["past the deadline after one failure", 1, 120_000, "deadline"],
  ["attempt cap wins when both hold", 6, 130_000, "attempt_cap"],
]) {
  test(`A: capBeforeAttempt — ${name}`, () => {
    const s = policy.newRetryState();
    s.attempts = attemptsDone;
    assert.equal(policy.capBeforeAttempt(s, 1_000_000, 1_000_000 + elapsed, LIMITS), expected);
  });
}

for (const [name, sequence, expectedTripAt] of [
  ["three of the same in a row", ["x", "x", "x"], 3],
  ["two of the same", ["x", "x"], null],
  ["a different class restarts the count", ["x", "x", "y", "x", "x"], null],
  ["an account-own failure (null) ends the streak", ["x", "x", null, "x", "x"], null],
  ["…and the streak can build again afterwards", ["x", null, "x", "x", "x"], 5],
  ["alternating classes never trip", ["x", "y", "x", "y", "x", "y"], null],
]) {
  test(`A: noteFailureClass — ${name}`, () => {
    const s = policy.newRetryState();
    let trippedAt = null;
    sequence.forEach((cls, i) => { if (trippedAt === null && policy.noteFailureClass(s, cls, LIMITS)) trippedAt = i + 1; });
    assert.equal(trippedAt, expectedTripAt);
  });
}

for (const [status, body, lane, expected] of [
  [500, errorBody("api_error", "boom"), "direct", "direct:http_500:api_error"],
  [529, errorBody("overloaded_error", "Overloaded"), "direct", "direct:http_529:overloaded_error"],
  [429, errorBody("rate_limit_error", "slow down"), "direct", "direct:http_429:rate_limit_error"],
  [403, "<html>blocked</html>", "direct", "direct:http_403:non_json"],
  [502, "", "direct", "direct:http_502:non_json"],
  [500, JSON.stringify({ error: { code: "server_error", message: "x" } }), "direct", "direct:http_500:server_error"],
  [502, errorBody("api_error", "ccr_worker: claude exited 1: anything the customer typed"), "worker", "worker:http_502"],
]) {
  test(`A: httpFailureClass ${status} ${lane} → ${expected}`, () => assert.equal(policy.httpFailureClass(status, body, lane), expected));
}

// ---------- A: through the gateway ----------

test("A: total attempt cap holds across organisations — 9 failing accounts in 3 organisations, 6 attempts, then stop", async () => {
  // alternating failure classes so the same-failure rule stays out of the way
  const f = seed([0, 0, 0, 1, 1, 1, 2, 2, 2].map((team, i) => ({ team, ...(i % 2 ? E529 : E500) })));
  const start = attempts.length;
  const res = await send(f);
  assert.equal(res.statusCode, 502, res.body);
  assert.equal(tried(f, start), "0,1,2,3,4,5", "exactly maxTotalAttempts upstream calls");
  assert.equal(metrics.counterValue("retry_cap_tripped_total{reason=attempt_cap}"), 1);
  for (const id of f.ids.slice(6)) assert.equal(cooled(id), false, `${id} was never tried, never cooled`);
  assert.equal(new Set(attempts.slice(start).map((a) => a.isolation.teamId)).size, 2, "the third organisation was not entered");
});

test("A: the cap is configurable (GATEWAY_MAX_TOTAL_ATTEMPTS)", async () => {
  config.maxTotalAttempts = 2;
  const f = seed([0, 0, 0, 1].map((team, i) => ({ team, ...(i % 2 ? E529 : E500) })));
  const start = attempts.length;
  const res = await send(f);
  assert.equal(res.statusCode, 502);
  assert.equal(tried(f, start), "0,1");
});

test("A: same failure on 3 consecutive accounts → upstream error to the client, third account not cooled, no organisation switch", async () => {
  const f = seed([{ team: 0, ...E500 }, { team: 0, ...E500 }, { team: 0, ...E500 }, { team: 0, ...E500 }, { team: 1 }]);
  const start = attempts.length;
  const res = await send(f);
  assert.equal(res.statusCode, 500, "the upstream's own status");
  assert.deepEqual(res.json(), JSON.parse(E500.body), "and its own body");
  assert.equal(tried(f, start), "0,1,2");
  assert.equal(cooled(f.ids[0]) && cooled(f.ids[1]), true, "what was recorded before the rule tripped stays recorded");
  assert.equal(cooled(f.ids[2]), false, "the account that confirmed the pattern is not cooled");
  assert.equal(cooled(f.ids[3]), false);
  assert.equal(metrics.counterValue("retry_cap_tripped_total{reason=same_failure}"), 1);
  assert.ok(attempts.slice(start).every((a) => a.isolation.teamId === TEAMS[0]), "organisation B (healthy) was not switched to");
  const row = core.one("SELECT status_code s FROM usage_logs WHERE user_id=? ORDER BY created_at DESC LIMIT 1", f.id);
  assert.equal(row.s, 500, "a failure row is written");
});

test("A: same HTML 403 (proxy / WAF page) on 3 accounts → 502, never the page itself, statuses untouched", async () => {
  const f = seed([{ team: 0, ...HTML403 }, { team: 0, ...HTML403 }, { team: 0, ...HTML403 }, { team: 0 }]);
  const start = attempts.length;
  const res = await send(f);
  assert.equal(res.statusCode, 502);
  assert.ok(!res.body.includes("<html>"));
  assert.equal(tried(f, start), "0,1,2");
  for (const id of f.ids) assert.equal(account(id).status, "active");
});

test("A: an account-own failure between them ends the streak — the request goes on and is served", async () => {
  const f = seed([{ team: 0, ...E500 }, { team: 0, ...E500 }, { team: 0, status: 402, body: errorBody("billing_error", "payment required") }, { team: 0, ...E500 }, { team: 0 }]);
  const start = attempts.length;
  const res = await send(f);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(tried(f, start), "0,1,2,3,4");
  assert.equal(metrics.counterValue("retry_cap_tripped_total{reason=same_failure}"), 0);
});

test("A: different failure classes do not trip the same-failure rule; a healthy account of the next organisation serves", async () => {
  const f = seed([{ team: 0, ...E500 }, { team: 0, ...E529 }, { team: 0, ...E500 }, { team: 1 }]);
  const start = attempts.length;
  const res = await send(f);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(tried(f, start), "0,1,2,3");
});

test("A: retry deadline — no further attempt is started once the request is older than GATEWAY_RETRY_DEADLINE_MS", async () => {
  config.retryDeadlineMs = 80;
  const f = seed([{ team: 0, delay: 120, ...E500 }, { team: 0, ...E529 }, { team: 1 }]);
  const start = attempts.length;
  const res = await send(f);
  assert.equal(res.statusCode, 502, res.body);
  assert.equal(tried(f, start), "0", "one attempt, then the deadline");
  assert.equal(metrics.counterValue("retry_cap_tripped_total{reason=deadline}"), 1);
  assert.equal(cooled(f.ids[1]), false);
});

test("A: within the caps nothing changes — one failing account, the next one of the organisation serves", async () => {
  const f = seed([{ team: 0, ...E529 }, { team: 0 }]);
  const res = await send(f);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().content[0].text, `reply:${f.ids[1]}`);
  assert.equal(Object.keys(metrics.countersSnapshot()).filter((k) => k.startsWith("retry_cap_tripped_total")).length, 0);
});

// ---------- C: body classification ----------

for (const [name, status, body, expected] of [
  ["401 authentication_error", 401, errorBody("authentication_error", "invalid x-api-key"), "auth"],
  ["403 authentication_error", 403, errorBody("authentication_error", "OAuth token has been revoked"), "auth"],
  ["401 OAuth revoked wording, other type", 401, errorBody("invalid_request_error", "OAuth access token has been revoked. Please log in again."), "auth"],
  ["401 OpenAI-style invalid_api_key code", 401, JSON.stringify({ error: { message: "Incorrect API key provided", type: "invalid_request_error", code: "invalid_api_key" } }), "auth"],
  ["403 permission_error", 403, errorBody("permission_error", "Your organization does not have access to this model"), "transient"],
  ["403 permission_error even when it mentions tokens", 403, errorBody("permission_error", "OAuth token is invalid for this resource"), "transient"],
  ["403 HTML page", 403, "<html><body>403 Forbidden</body></html>", "transient"],
  ["403 HTML page containing auth words", 403, HTML403.body, "transient"],
  ["403 empty body", 403, "", "transient"],
  ["403 plain text", 403, "Forbidden", "transient"],
  ["401 non-JSON", 401, "Unauthorized", "transient"],
  ["403 JSON of unknown shape", 403, JSON.stringify({ detail: "blocked by policy" }), "transient"],
  ["403 forbidden type from a relay", 403, errorBody("forbidden", "Request not allowed"), "transient"],
  ["401 JSON array", 401, "[]", "transient"],
  ["500 is never an auth signal", 500, errorBody("authentication_error", "x"), "transient"],
]) {
  test(`C: directAuthSignal — ${name} → ${expected}`, () => assert.equal(directAuthSignal(status, body), expected));
}

for (const [message, expected] of [
  ["account organization does not match conversation", "org_mismatch"],
  ["Unsupported state or unable to authenticate data", "unreadable"],
  ["Unexpected token in JSON", "unreadable"],
]) test(`C: credentialProblem — ${message} → ${expected}`, () => assert.equal(credentialProblem(new Error(message)), expected));

// ---------- C: through the gateway ----------

for (const c of [
  { name: "HTML 403 (proxy / WAF)", behavior: HTML403 },
  { name: "403 permission_error", behavior: { status: 403, body: errorBody("permission_error", "not allowed for this request") } },
  { name: "403 with an empty body", behavior: { status: 403, body: "" } },
]) {
  test(`C: ${c.name} fails that attempt only — no forced refresh, status stays active, next account serves`, async () => {
    const f = seed([{ team: 0, ...c.behavior, cred: { accessToken: "at", refreshToken: "rt", orgUuid: TEAMS[0], expiresAt: new Date(Date.now() + 3_600_000).toISOString() } }, { team: 0 }]);
    const start = attempts.length, tokens = tokenCalls.length;
    const res = await send(f);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(tried(f, start), "0,1", "one attempt on the failing account: no refresh-and-retry");
    assert.equal(tokenCalls.length, tokens, "the token endpoint was not called");
    assert.equal(account(f.ids[0]).status, "active");
    // ten more of them never change the status either
    for (let i = 0; i < 10; i++) { uncool(f.ids[0]); await send(f, `again ${i}`); }
    assert.equal(account(f.ids[0]).status, "active");
  });
}

test("C: 401 authentication_error — one forced refresh + one retry per request; status='error' only on the 3rd hit inside the window", async () => {
  const cred = { accessToken: "at", refreshToken: "rt", orgUuid: TEAMS[0], expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
  const f = seed([{ team: 0, cred, status: 401, body: errorBody("authentication_error", "OAuth token has been revoked") }, { team: 0 }]);
  for (const hit of [1, 2, 3]) {
    uncool(f.ids[0]);
    const start = attempts.length, tokens = tokenCalls.length;
    const res = await send(f, `turn ${hit}`);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(tried(f, start), "0,0,1", `hit ${hit}: tried, refreshed, retried once, then the next account`);
    assert.equal(tokenCalls.length, tokens + 1, `hit ${hit}: exactly one forced refresh`);
    assert.equal(account(f.ids[0]).status, hit < 3 ? "active" : "error", `after hit ${hit}`);
    if (hit < 3) assert.ok(account(f.ids[0]).t, "cooled meanwhile");
  }
  assert.match(account(f.ids[0]).m, /auth failure ×3/);
});

test("C: a served request between the hits clears the count", async () => {
  let mode = "fail";
  const f = seed([{ team: 0, behave: () => (mode === "fail" ? { status: 401, body: errorBody("authentication_error", "invalid bearer token") } : { status: 200 }) }, { team: 0 }]);
  for (const step of ["fail", "fail", "ok", "fail", "fail"]) {
    mode = step;
    uncool(f.ids[0]);
    await send(f, `turn ${step} ${Math.random()}`);
  }
  assert.equal(account(f.ids[0]).status, "active", "2 hits, a success, 2 hits: never 3 in a row inside the window");
  mode = "fail"; uncool(f.ids[0]);
  await send(f, "third");
  assert.equal(account(f.ids[0]).status, "error");
});

for (const c of [
  { name: "credential of another organisation (org mismatch)", cred: { accessToken: "at", orgUuid: TEAMS[1] }, reason: "org_mismatch" },
  { name: "credential that cannot be decrypted", corrupt: true, reason: "unreadable" },
]) {
  test(`C: ${c.name} — account skipped for the request, alert counted, status unchanged`, async () => {
    const f = seed([{ team: 0, ...(c.cred ? { cred: c.cred } : {}) }, { team: 0 }]);
    if (c.corrupt) core.run("UPDATE accounts SET credential_enc='not-a-ciphertext' WHERE id=?", f.ids[0]);
    const start = attempts.length;
    for (let i = 0; i < 4; i++) {
      const res = await send(f, `turn ${i}`);
      assert.equal(res.statusCode, 200, res.body);
    }
    assert.ok(attempts.slice(start).every((a) => a.accountId === f.ids[1]), "nothing was sent with the unusable credential");
    const a = account(f.ids[0]);
    assert.equal(a.status, "active");
    assert.equal(a.t, null, "not even cooled: a data problem is not a failure of the upstream");
    assert.equal(metrics.counterValue(`credential_unusable_total{reason=${c.reason}}`), 4);
  });
}
