// Review 2026-11-09 E: stream settlement (and, at the end, F: a conversation whose ownership changed mid-request). The decision table (one test per cell), the partial-usage rule, and the
// whole path through the gateway against a fake tunnel that streams in frames. Nothing leaves the machine.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import net from "node:net";
import { after, test } from "node:test";
import Fastify from "fastify";

const dataDir = mkdtempSync(join(tmpdir(), "1dayapi-stream-settle-"));
process.env.DATA_DIR = dataDir;
process.env.PROBE_INTERCEPT = "0";
process.env.ACCOUNT_BUSY_WAIT_MS = "300";
process.env.CLIENT_WRITE_STALL_MS = "300";

const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === "string" ? input : input.url ?? String(input));
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") return Promise.reject(new Error(`test tried to reach ${url.hostname}`));
  return realFetch(input, init);
};

// ---------- fake tunnel: a response is a list of frames, each optionally delayed ----------
const sessions = new Map();
const behaviors = new Map();   // accountId → (request) => [{ data: string, delay?: number }]
const closed = [];             // accountIds whose upstream session the gateway closed
let nextSession = 0;
const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
const HEAD = `${JSON.stringify({ status: 200, headers: { "content-type": "text/event-stream" } })}\n`;
const start = (model, input = 10) => [{ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model, content: [], usage: { input_tokens: input, output_tokens: 1 } } }, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }];
const delta = (text) => ({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
const thinking = (text) => ({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: text } });
const finish = (output) => [{ type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: output } }, { type: "message_stop" }];
const consoleServer = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  const path = new URL(req.url, "http://local").pathname;
  res.setHeader("content-type", "application/json");
  if (path === "/internal/tunnel/reset" || path === "/internal/tunnel/archive") { res.end('{"ok":true}'); return; }
  if (path === "/internal/tunnel/open") {
    const sid = `session-${++nextSession}`;
    sessions.set(sid, { accountId: body.accountId, seq: 0, frames: null, next: 0, closedByGateway: false });
    res.end(JSON.stringify({ sessionId: sid })); return;
  }
  const [, , , sid, action] = path.split("/");
  const session = sessions.get(sid);
  if (!session) { res.statusCode = 404; res.end("{}"); return; }
  if (action === "close") { session.closedByGateway = true; closed.push(session.accountId); session.wake?.(); res.end("{}"); return; }
  if (action === "data") {
    const spec = JSON.parse(Buffer.from(body.payloadBase64, "base64").toString());
    const request = JSON.parse(Buffer.from(spec.bodyBase64, "base64").toString() || "{}");
    session.frames = behaviors.get(session.accountId)(request);
    session.wake?.();
    res.end("{}"); return;
  }
  if (action === "read") {
    if (!session.frames) await new Promise((resolve) => { session.wake = resolve; });
    if (session.closedByGateway || !session.frames) { res.end(JSON.stringify({ chunks: [], closed: true })); return; }
    const frame = session.frames[session.next++];
    if (frame?.delay) await new Promise((resolve) => { const t = setTimeout(resolve, frame.delay); session.wake = () => { clearTimeout(t); resolve(); }; });
    if (session.closedByGateway || !frame) { res.end(JSON.stringify({ chunks: [], closed: true })); return; }
    res.end(JSON.stringify({ chunks: [{ seq: session.seq++, payloadBase64: Buffer.from(frame.data).toString("base64") }], closed: session.next >= session.frames.length })); return;
  }
  res.end("{}");
});
await new Promise((resolve) => consoleServer.listen(0, "127.0.0.1", resolve));
process.env.CONSOLE_BASE = `http://127.0.0.1:${consoleServer.address().port}`;
const core = await import("@1dayapi/core");
const { proxy } = await import("../dist/proxy.js");
const { decideStreamSettlement, LocalStreamError } = await import("../dist/stream-settlement.js");
const { UsageAccumulator } = await import("../dist/usage.js");
const { RESET_NOTICE } = await import("../dist/conversation.js");
const gateway = Fastify({ bodyLimit: 32 * 1024 * 1024 });
gateway.post("/v1/messages", (req, reply) => proxy(req, reply, "anthropic", "/v1/messages"));
await gateway.listen({ port: 0, host: "127.0.0.1" });
const PORT = gateway.server.address().port;
after(async () => { await gateway.close(); await new Promise((resolve) => consoleServer.close(resolve)); core.db.close(); rmSync(dataDir, { recursive: true, force: true }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- the table: one test per cell ----------

const F = (o) => ({ completed: false, clientGone: false, upstreamError: false, readError: false, localFault: null, leaseLost: false, firstByteSent: true, ...o });
const CELLS = [
  // completed × clientGone × upstreamError — the nine-cell core the review asked for
  ["completed, client there, no error", F({ completed: true }), "success", "full", false],
  ["completed, client gone, no error", F({ completed: true, clientGone: true }), "success", "full", false],
  ["completed, client there, upstream error", F({ completed: true, upstreamError: true }), "upstream_failure", "none", true],
  ["completed, client gone, upstream error", F({ completed: true, clientGone: true, upstreamError: true }), "upstream_failure", "none", true],
  ["not completed, client there, no error (no terminator)", F({}), "upstream_failure", "none", true],
  ["not completed, client gone, no error", F({ clientGone: true }), "partial", "partial", false],
  ["not completed, client there, upstream error", F({ upstreamError: true }), "upstream_failure", "none", true],
  ["not completed, client gone, upstream error — NEVER a success", F({ clientGone: true, upstreamError: true }), "upstream_failure", "none", true],
  ["not completed, client gone before the first byte, upstream error", F({ clientGone: true, upstreamError: true, firstByteSent: false }), "upstream_failure", "none", true],
  // before the first byte
  ["client gone before the first byte", F({ clientGone: true, firstByteSent: false }), "client_unserved", "none", false],
  ["client gone before the first byte, upstream completed meanwhile", F({ clientGone: true, completed: true, firstByteSent: false }), "client_unserved", "none", false],
  // read errors
  ["upstream read error, client there", F({ readError: true }), "upstream_failure", "none", true],
  ["upstream read error before the first byte", F({ readError: true, firstByteSent: false }), "upstream_failure", "none", true],
  ["read error after the client left (our own cancel)", F({ readError: true, clientGone: true }), "partial", "partial", false],
  // faults on this side of the upstream
  ["client not reading for 30 s", F({ localFault: "client" }), "partial", "partial", false],
  ["client closed during backpressure", F({ localFault: "client", clientGone: true }), "partial", "partial", false],
  ["client fault after the terminator", F({ localFault: "client", completed: true }), "success", "full", false],
  ["tee proof over 8 MiB", F({ localFault: "gateway" }), "partial", "partial", false],
  ["SSE event over 2 MiB mid-stream", F({ localFault: "gateway" }), "partial", "partial", false],
  ["SSE event over 2 MiB as the very first event", F({ localFault: "gateway", firstByteSent: false }), "gateway_unserved", "none", false],
  ["gateway fault AND an upstream error seen before it", F({ localFault: "gateway", upstreamError: true }), "upstream_failure", "none", true],
  // lease
  ["scheduling lease lost mid-stream", F({ leaseLost: true }), "lease_lost", "none", false],
  ["scheduling lease lost with an upstream error pending", F({ leaseLost: true, upstreamError: true }), "lease_lost", "none", false],
  ["scheduling lease lost after the terminator", F({ leaseLost: true, completed: true }), "lease_lost", "none", false],
];
for (const [name, facts, outcome, charge, coolAccount] of CELLS) {
  test(`E: table — ${name} → ${outcome} / charge ${charge}${coolAccount ? " / cool" : ""}`, () => {
    assert.deepEqual(decideStreamSettlement(facts), { outcome, charge, coolAccount });
  });
}

test("E: table invariants over every combination of facts (192 cells)", () => {
  let cells = 0;
  for (const completed of [false, true]) for (const clientGone of [false, true]) for (const upstreamError of [false, true]) for (const readError of [false, true])
    for (const leaseLost of [false, true]) for (const firstByteSent of [false, true]) for (const localFault of [null, "client", "gateway"]) {
      const f = { completed, clientGone, upstreamError, readError, leaseLost, firstByteSent, localFault };
      const d = decideStreamSettlement(f);
      const at = JSON.stringify(f);
      cells++;
      if (upstreamError) assert.equal(d.charge, "none", `an upstream error is never charged: ${at}`);
      if (upstreamError) assert.notEqual(d.outcome, "success", `…and never a success: ${at}`);
      if (d.charge === "full") assert.ok(completed && d.outcome === "success", `full charge only for a completed stream: ${at}`);
      if (d.charge !== "none" && (clientGone || localFault)) assert.ok(firstByteSent, `a client / gateway fault before the first byte charges nothing: ${at}`);
      if (d.coolAccount) assert.equal(d.outcome, "upstream_failure", `only an upstream failure cools: ${at}`);
      if (localFault && !upstreamError && !leaseLost) assert.equal(d.coolAccount, false, `a client / gateway fault never cools the account: ${at}`);
      if (clientGone && !upstreamError) assert.equal(d.coolAccount, false, `a client leaving never cools the account: ${at}`);
      if (leaseLost) assert.deepEqual(d, { outcome: "lease_lost", charge: "none", coolAccount: false }, at);
      assert.equal(d.charge === "none", ["client_unserved", "gateway_unserved", "lease_lost", "upstream_failure"].includes(d.outcome), at);
    }
  assert.equal(cells, 192);
});

// ---------- partial usage: max(reported, estimate of what was forwarded) ----------

for (const c of [
  { name: "message_start placeholder (1) vs 400 chars forwarded", reported: 1, text: "x".repeat(400), partial: true, output: 100, estimated: true },
  { name: "reported above the estimate stands", reported: 500, text: "x".repeat(400), partial: true, output: 500, estimated: false },
  { name: "nothing forwarded yet", reported: 1, text: "", partial: true, output: 1, estimated: false },
  { name: "a completed stream is never re-estimated", reported: 1, text: "x".repeat(400), partial: false, output: 1, estimated: false },
  { name: "odd lengths round up", reported: 1, text: "x".repeat(401), partial: true, output: 101, estimated: true },
]) {
  test(`E: finalize — ${c.name}`, () => {
    const acc = new UsageAccumulator();
    acc.addAnthropic({ input_tokens: 10, output_tokens: c.reported });
    acc.addText(c.text);
    const r = acc.finalize({}, { partial: c.partial });
    assert.equal(r.usage.output_tokens, c.output);
    assert.equal(r.usage.input_tokens, 10, "input is the upstream's own count");
    assert.equal(r.estimated, c.estimated);
  });
}

test("E: LocalStreamError carries which side broke the stream", () => {
  const e = new LocalStreamError("gateway", "proof response exceeds 8 MiB");
  assert.ok(e instanceof Error);
  assert.equal(e.fault, "gateway");
});

// ---------- through the gateway ----------

const TEAM = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const MODEL = "claude-sonnet-5";
let scenario = 0;
function seed(frames) {
  const id = `ss-${++scenario}`, aid = `${id}-0`, pid = `proxy-${aid}`;
  core.run("INSERT INTO users(id,role,name,login_key_hash,login_key_preview,balance_usd) VALUES (?,'consumer',?,?,?,100)", id, id, `login-${id}`, "login");
  core.run("INSERT INTO groups(id,name) VALUES (?,?)", id, id);
  core.run("INSERT INTO api_keys(id,user_id,name,key_hash,key_preview,group_id) VALUES (?,?,?,?,?,?)", id, id, id, core.sha256Hex(id), id, id);
  core.ensureUpstreamTeam(TEAM);
  core.run("INSERT INTO node_proxies(id,node_id,url_enc,status,team_id,isolation_version,resource_key) VALUES (?,?,?,'live',?,1,?)", pid, `node-${id}`, "test", TEAM, `ip:${pid}`);
  core.claimProxyResource(`ip:${pid}`, TEAM);
  core.run(`INSERT INTO accounts(id,name,platform,type,protocol,credential_enc,route,node_id,team_id,bound_proxy_id,priority,models)
    VALUES (?,?,'anthropic','oauth','anthropic',?,'node',?,?,?,0,?)`, aid, aid, core.encryptJson({ accessToken: `token-${aid}`, orgUuid: TEAM }), `node-${id}`, TEAM, pid, JSON.stringify([MODEL]));
  core.run("INSERT INTO account_groups(account_id,group_id,priority) VALUES (?,?,0)", aid, id);
  behaviors.set(aid, frames);
  return { id, aid };
}
const requestBody = JSON.stringify({ model: MODEL, max_tokens: 4096, stream: true, messages: [{ role: "user", content: "go" }] });
/** A real socket: `onData(text, socket)` sees what has arrived; resolves with everything received when the socket closes. */
function call(f, { onData, pause = false, headers = {} } = {}) {
  return new Promise((resolve) => {
    let received = "";
    const socket = net.connect(PORT, "127.0.0.1", () => {
      const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join("");
      socket.write(`POST /v1/messages HTTP/1.1\r\nhost: 127.0.0.1\r\nauthorization: Bearer ${f.id}\r\nx-claude-code-session-id: session-${f.id}\r\ncontent-type: application/json\r\n${extra}content-length: ${Buffer.byteLength(requestBody)}\r\nconnection: close\r\n\r\n${requestBody}`);
      if (pause) socket.pause();
    });
    // The gateway answers SSE with `connection: keep-alive`: the end of the chunked body is the end of the response.
    socket.on("data", (d) => { received += d.toString(); onData?.(received, socket); if (received.endsWith("\r\n0\r\n\r\n")) socket.destroy(); });
    socket.on("error", () => {});
    socket.on("close", () => resolve(received));
  });
}
async function row(f) {
  for (let i = 0; i < 100; i++) {
    const r = core.one("SELECT status_code status, error_code code, input_tokens input, output_tokens output, usage_estimated estimated, stream_truncated truncated, actual_cost cost, error_message message FROM usage_logs WHERE user_id=?", f.id);
    if (r) return r;
    await sleep(30);
  }
  return null;
}
const cooled = (aid) => { const a = core.one("SELECT status, temp_unschedulable_until t, overload_until o, rate_limited_until r FROM accounts WHERE id=?", aid); return a.status !== "active" || !!(a.t || a.o || a.r); };

test("E: a completed stream is billed with the upstream's own usage, not estimated", async () => {
  const f = seed((req) => [{ data: HEAD + sse([...start(req.model), delta("Hello there."), ...finish(7)]) }]);
  const out = await call(f);
  assert.ok(out.includes("message_stop"));
  const r = await row(f);
  assert.deepEqual({ status: r.status, input: r.input, output: r.output, estimated: r.estimated, truncated: r.truncated }, { status: 200, input: 10, output: 7, estimated: 0, truncated: 0 });
  assert.ok(r.cost > 0);
  assert.equal(cooled(f.aid), false);
});

test("E(1): client disconnects mid-stream — billed max(reported, forwarded text + thinking), flagged estimated, upstream cancelled, account not cooled", async () => {
  const f = seed((req) => [
    { data: HEAD + sse([...start(req.model), thinking("t".repeat(200)), delta("A".repeat(400))]) },
    { delay: 3_000, data: sse([delta("never forwarded"), ...finish(999)]) },
  ]);
  const before = closed.length;
  await call(f, { onData: (text, socket) => { if (text.includes("AAAA")) socket.destroy(); } });
  const r = await row(f);
  assert.equal(r.status, 200);
  assert.equal(r.output, 150, "ceil((200 thinking + 400 text) / 4), not message_start's 1");
  assert.equal(r.input, 10);
  assert.equal(r.estimated, 1, "flagged as estimated");
  assert.equal(r.truncated, 1);
  assert.ok(r.cost > 0, "what was produced is charged");
  assert.equal(cooled(f.aid), false);
  await sleep(100);
  assert.ok(closed.slice(before).includes(f.aid), "the upstream body was cancelled");
});

test("E(2): an SSE event over 2 MiB mid-stream is the gateway's limit — produced output settled, client told, account not cooled, upstream cancelled", async () => {
  const f = seed((req) => [
    { data: HEAD + sse([...start(req.model), delta("B".repeat(800))]) },
    { delay: 100, data: sse([delta("C".repeat(2_200_000))]) },
    { delay: 3_000, data: sse(finish(5)) },
  ]);
  const before = closed.length;
  const out = await call(f);
  assert.ok(out.includes("gateway: upstream SSE event exceeds 2 MiB"), "the client is told, in its dialect");
  assert.ok(!out.includes("message_stop"));
  const r = await row(f);
  assert.deepEqual({ status: r.status, output: r.output, estimated: r.estimated, truncated: r.truncated }, { status: 200, output: 200, estimated: 1, truncated: 1 });
  assert.equal(cooled(f.aid), false, "an innocent account is not cooled");
  await sleep(100);
  assert.ok(closed.slice(before).includes(f.aid), "the upstream reader was cancelled, not left open");
});

test("E(2): an oversized first event — nothing reached the client: failure row, no charge, account not cooled", async () => {
  const f = seed(() => [{ data: HEAD + sse([{ type: "message_start", message: { id: "m", model: MODEL, usage: { input_tokens: 10, output_tokens: 1 }, padding: "P".repeat(2_200_000) } }]) }, { delay: 3_000, data: "" }]);
  const out = await call(f);
  assert.ok(out.includes("gateway: upstream SSE event exceeds 2 MiB"));
  const r = await row(f);
  assert.deepEqual({ status: r.status, code: r.code, cost: r.cost }, { status: 502, code: "gateway_stream_limit", cost: 0 });
  assert.equal(cooled(f.aid), false);
});

test("E(2): a client that stops reading — its stream is given up after CLIENT_WRITE_STALL_MS, produced output settled, account not cooled, upstream cancelled", async () => {
  const big = sse(Array.from({ length: 400 }, () => delta("D".repeat(60_000))));
  const f = seed((req) => [{ data: HEAD + sse(start(req.model)) + big }, { delay: 10_000, data: sse(finish(5)) }]);
  const before = closed.length;
  const done = call(f, { pause: true });
  const r = await row(f);
  assert.ok(r, "settled without waiting for the client");
  assert.deepEqual({ status: r.status, estimated: r.estimated, truncated: r.truncated }, { status: 200, estimated: 1, truncated: 1 });
  assert.ok(r.output > 1_000, `billed for what was produced (${r.output})`);
  assert.ok(r.cost > 0);
  assert.equal(cooled(f.aid), false, "the client's behaviour is not the account's failure");
  await sleep(150);
  assert.ok(closed.slice(before).includes(f.aid), "the upstream body was cancelled");
  await Promise.race([done, sleep(2_000)]);
});

test("E(2): a tee proof over 8 MiB is the gateway's limit — settled, not an upstream failure", async () => {
  const big = sse(Array.from({ length: 150 }, () => delta("E".repeat(60_000))));
  const f = seed((req) => [{ data: HEAD + sse(start(req.model)) + big + sse(finish(5)) }]);
  const out = await call(f, { headers: { "x-1dayapi-tee-proof-mode": "stream" } });
  assert.ok(out.includes("gateway: proof response exceeds 8 MiB"));
  const r = await row(f);
  assert.deepEqual({ status: r.status, estimated: r.estimated, truncated: r.truncated }, { status: 200, estimated: 1, truncated: 1 });
  assert.ok(r.output > 100_000);
  assert.equal(cooled(f.aid), false);
});

test("E(3): an upstream error event after partial output is a failure — no charge, account cooled (unchanged)", async () => {
  const f = seed((req) => [{ data: HEAD + sse([...start(req.model), delta("partial"), { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }]) }]);
  const out = await call(f);
  assert.ok(out.includes("Overloaded"));
  const r = await row(f);
  assert.deepEqual({ status: r.status, code: r.code, cost: r.cost, output: r.output }, { status: 502, code: "upstream_stream_error", cost: 0, output: 0 });
  assert.equal(cooled(f.aid), true);
});

test("E(3): an upstream error event, then the client disconnects — still a failure row, never a settled success", async () => {
  const f = seed((req) => [
    { data: HEAD + sse([...start(req.model), delta("F".repeat(400)), { type: "error", error: { type: "api_error", message: "upstream exploded" } }]) },
    { delay: 400, data: sse([delta("more")]) },
  ]);
  await call(f, { onData: (text, socket) => { if (text.includes("upstream exploded")) socket.destroy(); } });
  const r = await row(f);
  assert.deepEqual({ status: r.status, code: r.code, cost: r.cost }, { status: 502, code: "upstream_stream_error", cost: 0 });
});

test("E: a stream that just ends without its terminator, client still there — upstream failure, no charge, cooled (unchanged)", async () => {
  const f = seed((req) => [{ data: HEAD + sse([...start(req.model), delta("cut")]) }]);
  const out = await call(f);
  assert.ok(out.includes("upstream stream ended without a terminator"));
  const r = await row(f);
  assert.deepEqual({ status: r.status, code: r.code, cost: r.cost }, { status: 502, code: "upstream_stream_error", cost: 0 });
  assert.equal(cooled(f.aid), true);
});

test("E: client gone before the first byte — 499, no charge, not cooled (unchanged)", async () => {
  const f = seed((req) => [{ delay: 400, data: HEAD + sse([...start(req.model), delta("late"), ...finish(3)]) }]);
  await call(f, { onData: (_text, socket) => socket.destroy() });
  const r = await row(f);
  assert.deepEqual({ status: r.status, code: r.code, cost: r.cost }, { status: 499, code: "client_closed", cost: 0 });
  assert.equal(cooled(f.aid), false);
});

// ---------- F: the conversation's ownership changed while an account was answering ----------

const jsonBody = (stream) => JSON.stringify({ model: MODEL, max_tokens: 64, stream, messages: [{ role: "user", content: "go" }] });
function post(f, stream) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, method: "POST", path: "/v1/messages", agent: false, headers: { authorization: `Bearer ${f.id}`, "x-claude-code-session-id": `session-${f.id}`, "content-type": "application/json", connection: "close" } }, (res) => {
      let body = "";
      res.on("data", (d) => { body += d; if (body.includes("message_stop") || body.includes("[DONE]")) req.destroy(); });
      const done = () => resolve({ status: res.statusCode, headers: res.headers, body });
      res.on("end", done); res.on("close", done);
    });
    req.on("error", (err) => { if (err.code !== "ECONNRESET") reject(err); });
    req.end(jsonBody(stream));
  });
}
for (const stream of [false, true]) {
  test(`F: generation reset by another request while the account answers (${stream ? "stream" : "non-stream"}) — upstream body cancelled, 409 context_reset row at zero cost, client contract unchanged`, async () => {
    const f = seed((req) => {
      // "another request" resets the conversation while this one is at the upstream
      core.run("UPDATE conversations SET generation = generation + 1 WHERE api_key_id = ?", f.id);
      const answer = stream
        ? HEAD + sse([...start(req.model), delta("SECRET ANSWER OF THE OLD GENERATION")])
        : `${JSON.stringify({ status: 200, headers: { "content-type": "application/json" } })}\n${JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: req.model, content: [{ type: "text", text: "SECRET ANSWER OF THE OLD GENERATION" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 10 } })}`;
      return [{ data: answer }, { delay: 5_000, data: stream ? sse(finish(9)) : "" }];
    });
    const before = closed.length;
    const res = await post(f, stream);
    // unchanged customer contract: HTTP 200 with the platform's reset notice in the place of an answer
    assert.equal(res.status, 200);
    assert.ok(!res.body.includes("SECRET ANSWER"), "the old generation's answer is not delivered");
    assert.ok(res.body.includes(JSON.stringify(RESET_NOTICE).slice(1, 25)), "the platform's reset notice, as before");
    const r = await row(f);
    assert.deepEqual({ status: r.status, code: r.code, cost: r.cost, output: r.output }, { status: 409, code: "context_reset", cost: 0, output: 0 });
    assert.match(r.message, /ownership changed/);
    assert.match(r.message, new RegExp(`account ${f.aid}`), "the row names the account whose answer was discarded");
    await sleep(150);
    assert.ok(closed.slice(before).includes(f.aid), "the upstream body was cancelled instead of being left to run");
    assert.equal(cooled(f.aid), false, "not the account's failure");
  });
}
