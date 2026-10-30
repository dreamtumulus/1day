import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { after, test } from "node:test";
import Fastify from "fastify";

const dataDir = mkdtempSync(join(tmpdir(), "1dayapi-team-route-"));
process.env.DATA_DIR = dataDir;
process.env.PROBE_INTERCEPT = "0"; // fixtures repeat identical tiny prompts on purpose (docs/gateway.md §2c)
process.env.ACCOUNT_BUSY_WAIT_MS = "800";
const sessions = new Map();
const attempts = [];
const resets = [];
const closedSessions = [];
const behaviors = new Map();
let nextSession = 0;
let activeRequests = 0;
let maxActiveRequests = 0;
const cloudSessions = new Map();
let nextCloudSession = 0;
const consoleServer = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  const path = new URL(req.url, "http://local").pathname;
  res.setHeader("content-type", "application/json");
  if (path === "/internal/tunnel/archive") { const cloud = cloudSessions.get(body.sessionId); if (cloud) cloud.archived = true; res.end(JSON.stringify({status:200})); return; }
  if (path === "/internal/tunnel/reset") { resets.push(body.isolation); res.end('{"ok":true}'); return; }
  if (path === "/internal/tunnel/open") {
    const sid = `session-${++nextSession}`;
    sessions.set(sid, { accountId: body.accountId, isolation: body.isolation, seq: 0 });
    if (body.kind === "cc_worker") attempts.push({sid,accountId:body.accountId,isolation:body.isolation,body});
    res.end(JSON.stringify({ sessionId: sid })); return;
  }
  const [, , , sid, action] = path.split("/");
  if (action === "close") closedSessions.push(sid);
  const session = sessions.get(sid);
  if (!session) { res.statusCode = 404; res.end('{}'); return; }
  if (action === "close") { session.payload ??= Buffer.alloc(0); session.ready?.(); }
  if (action === "data") {
    const spec = JSON.parse(Buffer.from(body.payloadBase64, "base64").toString());
    const rawRequest = Buffer.from(spec.bodyBase64, "base64").toString();
    const request = rawRequest ? JSON.parse(rawRequest) : {};
    attempts.push({ sid, accountId: session.accountId, isolation: session.isolation, body: request, headers: spec.headers });
    const behavior = behaviors.get(session.accountId) ?? {};
    const status = behavior.status ?? 200;
    let output = status === 200 ? { id: `msg-${sid}`, type: "message", role: "assistant", model: request.model, content: [{ type: "text", text: `reply:${session.accountId}` }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } } : { error: { message: "quota exhausted" } };
    if (behavior.cloud) {
      const upstream = new URL(spec.url).pathname;
      if (upstream.endsWith("/environment_providers/cloud/create")) output = { environment_id: `env-${session.accountId}` };
      else if (upstream.endsWith("/code/sessions")) {
        const id = `cloud-${++nextCloudSession}`;
        cloudSessions.set(id, { accountId: session.accountId, archived: false, turns: 0 });
        output = { id };
      } else {
        const id = upstream.split("/").at(-2);
        const cloud = cloudSessions.get(id);
        if (!cloud) throw new Error(`unknown cloud session ${upstream}`);
        if (upstream.endsWith("/archive")) { cloud.archived = true; output = {}; }
        else if (spec.method === "GET") output = { events: Array.from({length:cloud.turns}, (_,i) => [
          { id: `${id}-${i+1}-assistant`, payload: { type: "assistant", message: { id: `msg-${id}-${i+1}`, content: [{ type: "text", text: `cloud reply turn ${i+1}` }], usage: { input_tokens: 1, output_tokens: 1 } } } },
          { id: `${id}-${i+1}-result`, payload: { type: "result", subtype: "success", result: `cloud reply turn ${i+1}`, usage: { input_tokens: 1, output_tokens: 1 } } },
        ]).flat() };
        else { cloud.turns++; output = {}; }
      }
    }
    activeRequests++; maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
    if (behavior.delay) await new Promise((resolve) => setTimeout(resolve, behavior.delay));
    activeRequests--;
    let wire = JSON.stringify(output);
    if (behavior.stream) {
      const events = [{ type: "message_start", message: { ...output, content: [] } }, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: behavior.partial ? "PARTIAL_A" : `reply:${session.accountId}` } }];
      if (behavior.partial) events.push({ type: "error", error: { type: "api_error", message: "quota exhausted after partial output" } });
      else if (!behavior.truncated) events.push({ type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }, { type: "message_stop" });
      wire = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
    }
    const payload = Buffer.from(JSON.stringify({ status, headers: { "content-type": behavior.stream ? "text/event-stream" : "application/json" } }) + "\n" + wire);
    session.payload = payload;
    session.ready?.();
    res.end('{}'); return;
  }
  if (action === "read") {
    if (!session.payload) await new Promise((resolve) => { session.ready = resolve; });
    res.end(JSON.stringify({ chunks: [{ seq: session.seq++, payloadBase64: session.payload.toString("base64") }], closed: true })); return;
  }
  res.end('{}');
});
await new Promise((resolve) => consoleServer.listen(0, "127.0.0.1", resolve));
process.env.CONSOLE_BASE = `http://127.0.0.1:${consoleServer.address().port}`;
const core = await import("@1dayapi/core");
const { proxy } = await import("../dist/proxy.js");
const { resolveConversationIdentity, resetBody, latestQuestion, applyResetBoundary, isToolContinuation, RESET_NOTICE } = await import("../dist/conversation.js");
const gateway = Fastify();
gateway.post("/v1/messages", (req, reply) => proxy(req, reply, "anthropic", "/v1/messages"));
await gateway.ready();
after(async () => { await gateway.close(); await new Promise((resolve) => consoleServer.close(resolve)); core.db.close(); rmSync(dataDir, { recursive: true, force: true }); });

const TEAM_A = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const TEAM_B = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const MODEL = "claude-sonnet-5";
let scenario = 0;
function seed(accountSpecs) {
  const id = `case-${++scenario}`;
  core.run("INSERT INTO users(id,role,name,login_key_hash,login_key_preview,balance_usd) VALUES (?,'consumer',?,?,?,100)", id, id, `login-${id}`, "login");
  core.run("INSERT INTO groups(id,name) VALUES (?,?)", id, id);
  core.run("INSERT INTO api_keys(id,user_id,name,key_hash,key_preview,group_id) VALUES (?,?,?,?,?,?)", id, id, id, core.sha256Hex(id), id, id);
  const ids = [];
  accountSpecs.forEach((spec, index) => {
    const aid = `${id}-${index}`;
    const pid = `proxy-${aid}`;
    core.ensureUpstreamTeam(spec.team);
    core.run("INSERT INTO node_proxies(id,node_id,url_enc,status,team_id,isolation_version,resource_key) VALUES (?,?,?,'live',?,1,?)", pid, `node-${id}`, "test", spec.team, `ip:${pid}`);
    core.claimProxyResource(`ip:${pid}`, spec.team);
    core.run(`INSERT INTO accounts(id,name,platform,type,protocol,credential_enc,route,node_id,team_id,bound_proxy_id,priority,models)
      VALUES (?,?,'anthropic','oauth','anthropic',?,'node',?,?,?,?,?)`, aid, aid, core.encryptJson({ accessToken: `token-${aid}`, orgUuid: spec.team }), `node-${id}`, spec.team, pid, index, JSON.stringify([MODEL, "claude-opus-5-5"]));
    core.run("INSERT INTO account_groups(account_id,group_id,priority) VALUES (?,?,?)", aid, id, index);
    behaviors.set(aid, spec);
    ids.push(aid);
  });
  return { id, ids, headers: { authorization: `Bearer ${id}`, "x-claude-code-session-id": `session-${id}` } };
}
const question = (text) => ({ role: "user", content: text });
const answer = (text) => ({ role: "assistant", content: text });
const payload = (messages, extra = {}) => ({ model: MODEL, max_tokens: 30, messages, ...extra });
async function request(fixture, body, headers = {}) { return gateway.inject({ method: "POST", url: "/v1/messages", headers: { ...fixture.headers, ...headers }, payload: body }); }

test("real gateway retries another account inside A without touching B", async () => {
  const f = seed([{ team: TEAM_A, status: 402 }, { team: TEAM_A }, { team: TEAM_B }]);
  const start = attempts.length;
  const response = await request(f, payload([question("current task")]));
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(attempts.slice(start).map((a) => a.accountId), f.ids.slice(0, 2));
  assert.ok(attempts.slice(start).every((a) => a.isolation.teamId === TEAM_A && a.isolation.generation === 1));
});

test("A exhausted: B sees only the newest question; repeated old history remains cut after gateway state reload", async () => {
  const f = seed([{ team: TEAM_A }, { team: TEAM_B }]);
  await request(f, payload([question("OLD SECRET ROOT")], { system: "OLD SYSTEM SECRET" }));
  behaviors.set(f.ids[0], { team: TEAM_A, status: 402 });
  const history = [question("OLD SECRET ROOT"), answer("OLD ASSISTANT SECRET"), question("fresh independent question")];
  const start = attempts.length;
  const switched = await request(f, payload(history, { system: "OLD SYSTEM SECRET", metadata: { previous: "OLD META" }, previous_response_id: "OLD HANDLE", tools: [{ name: "lookup", description: "OLD DESCRIPTION", input_schema: { type: "object", properties: { q: { type: "string", description: "OLD FIELD DESCRIPTION" } } } }] }));
  assert.equal(switched.statusCode, 200, switched.body);
  const b = attempts.slice(start).find((a) => a.accountId === f.ids[1]);
  assert.ok(b);
  assert.equal(b.isolation.teamId, TEAM_B);
  assert.equal(b.isolation.generation, 2);
  assert.deepEqual(b.body.messages, [question("fresh independent question")]);
  assert.ok(!JSON.stringify(b.body).includes("OLD"), JSON.stringify(b.body));
  const sessionBefore = attempts.slice(start).find((a) => a.accountId === f.ids[0]).headers["x-claude-code-session-id"];
  const sessionAfter = b.headers["x-claude-code-session-id"];
  assert.notEqual(sessionBefore, sessionAfter);
  assert.notEqual(sessionAfter, f.headers["x-claude-code-session-id"]);
  assert.equal(JSON.parse(b.body.metadata.user_id).session_id, sessionAfter);
  assert.ok(resets.some((r) => r.conversationId === b.isolation.conversationId && r.teamId === TEAM_A && r.generation === 1));
  const next = await request(f, payload([...history, answer("reply from B"), question("new B turn")], { system: "OLD SYSTEM SECRET" }));
  assert.equal(next.statusCode, 200, next.body);
  const last = attempts.at(-1);
  assert.equal(last.isolation.generation, 2);
  assert.deepEqual(last.body.messages, [question("fresh independent question"), answer("reply from B"), question("new B turn")]);
  assert.ok(!JSON.stringify(last.body).includes("OLD"));
  const stored = core.getConversation(b.isolation.conversationId);
  assert.equal(stored.team_id, TEAM_B);
  assert.equal(stored.reset_active, 1);
});

test("missing ids uses a conservative content boundary and the real Claude Code header is model-independent", async () => {
  const f = seed([{ team: TEAM_A }]);
  const original = payload([question("unknown legacy history"), answer("old reply"), question("only current question")], { system: "legacy secret" });
  const headers = { ...f.headers }; delete headers["x-claude-code-session-id"];
  const response = await gateway.inject({ method: "POST", url: "/v1/messages", headers, payload: original });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(attempts.at(-1).body.messages, [question("only current question")]);
  assert.ok(!JSON.stringify(attempts.at(-1).body).includes("legacy secret"));
  const a = resolveConversationIdentity("k", { "x-claude-code-session-id": "abc" }, { model: "x" }, "anthropic");
  const b = resolveConversationIdentity("k", { "x-claude-code-session-id": "abc" }, { model: "y", system: "changed" }, "anthropic");
  assert.deepEqual(a, b);
  assert.equal(a.reliable, true);
});

test("simultaneous requests for one session share a durable team and generation across models", async () => {
  const f = seed([{ team: TEAM_A, delay: 70 }, { team: TEAM_B }]);
  const start = attempts.length;
  maxActiveRequests = 0;
  const [one, two] = await Promise.all([request(f, payload([question("parallel root")])), request(f, payload([question("parallel root")], { model: "claude-opus-5-5" }))]);
  assert.equal(one.statusCode, 200, one.body); assert.equal(two.statusCode, 200, two.body);
  const calls = attempts.slice(start);
  assert.equal(calls.length, 2);
  assert.ok(maxActiveRequests >= 2, "network execution must be parallel; only metadata updates take a lease");
  assert.equal(calls[0].isolation.conversationId, calls[1].isolation.conversationId);
  assert.ok(calls.every((c) => c.isolation.teamId === TEAM_A && c.isolation.generation === 1));
  assert.equal(core.getConversation(calls[0].isolation.conversationId).lease_token, null);
});

const toolUse = (id, name = "lookup") => ({ role: "assistant", content: [{ type: "tool_use", id, name, input: { q: id } }] });
const toolResult = (id, text) => ({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] });

// 2026-10-30: a tool round whose tool_use the other organization issued cannot be continued in B. The answer
// is a real 409, never a 200 "assistant message" the client would read as the model's reply.
test("team switch mid tool round: 409 tool_continuation_after_reset, never a synthetic 200, no orphan results to B", async () => {
  const f = seed([{ team: TEAM_A }, { team: TEAM_B }]);
  await request(f, payload([question("tool task")]));
  behaviors.set(f.ids[0], { team: TEAM_A, status: 402 });
  const start = attempts.length;
  const response = await request(f, payload([question("tool task"), toolUse("old-call"), toolResult("old-call", "OLD TOOL SECRET")]));
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().error.code ?? response.json().error.type, "tool_continuation_after_reset");
  assert.ok(!response.body.includes(RESET_NOTICE));
  assert.ok(!attempts.slice(start).some((a) => a.accountId === f.ids[1]));
  const row = core.one("SELECT status_code, error_code, actual_cost FROM usage_logs WHERE api_key_id=? ORDER BY created_at DESC LIMIT 1", f.id);
  assert.equal(row.status_code, 409); assert.equal(row.error_code, "tool_continuation_after_reset"); assert.equal(row.actual_cost, 0);
  // The generation did move to B; the next independent question is served there with only itself.
  const next = await request(f, payload([question("tool task"), toolUse("old-call"), toolResult("old-call", "OLD TOOL SECRET"), answer("gave up"), question("fresh start in B")]));
  assert.equal(next.statusCode, 200, next.body);
  assert.equal(attempts.at(-1).accountId, f.ids[1]);
  assert.deepEqual(attempts.at(-1).body.messages, [question("fresh start in B")]);
});

// The bug this fixes: after a reset the boundary matched, the rebuilt body ended in B's own tool_result,
// and "no latest question" turned a normal tool round into the 200 reset notice — mid-session, zero usage.
test("after a reset, this generation's own tool rounds are forwarded whole (tool_use + tool_result chain), never short-circuited", async () => {
  const f = seed([{ team: TEAM_A }, { team: TEAM_B }]);
  await request(f, payload([question("OLD ROOT")]));
  behaviors.set(f.ids[0], { team: TEAM_A, status: 402 });
  const switched = await request(f, payload([question("OLD ROOT"), answer("OLD ANSWER"), question("list the files")]));
  assert.equal(switched.statusCode, 200, switched.body);
  assert.equal(switched.headers["x-1day-context-reset"], "1");
  const history = [question("OLD ROOT"), answer("OLD ANSWER"), question("list the files"), toolUse("call-1", "ls")];
  const start = attempts.length;
  for (const variant of ["plain", "stream", "with-reminder", "second-round"]) {
    const extra = variant === "stream" ? { stream: true } : {};
    const tail = variant === "with-reminder"
      ? [{ role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "a.ts b.ts" }, { type: "text", text: "<system-reminder>budget low</system-reminder>" }] }]
      : variant === "second-round"
        ? [toolResult("call-1", "a.ts b.ts"), toolUse("call-2", "cat"), toolResult("call-2", "file body"), { role: "system", content: "per-turn control" }]
        : [toolResult("call-1", "a.ts b.ts")];
    if (variant === "stream") behaviors.set(f.ids[1], { team: TEAM_B, stream: true });
    const r = await request(f, payload([...history, ...tail], extra));
    behaviors.set(f.ids[1], { team: TEAM_B });
    assert.equal(r.statusCode, 200, `${variant}: ${r.body}`);
    assert.ok(!r.body.includes(RESET_NOTICE), `${variant}: no synthetic reset notice`);
    assert.ok(r.body.includes(`reply:${f.ids[1]}`), `${variant}: the real upstream answer`);
    const call = attempts.at(-1);
    assert.equal(call.accountId, f.ids[1], variant);
    assert.equal(call.isolation.generation, 2, variant);
    assert.deepEqual(call.body.messages, [question("list the files"), toolUse("call-1", "ls"), ...tail.filter((m) => m.role !== "system")], variant);
    assert.ok(!JSON.stringify(call.body).includes("OLD"), variant);
  }
  assert.equal(attempts.length - start, 4, "every tool round reached B");
  assert.equal(core.one("SELECT COUNT(*) AS n FROM usage_logs WHERE api_key_id=? AND error_code IN ('tool_continuation_after_reset','no_forwardable_question')", f.id).n, 0);
});

test("pre-boundary drift (Claude Code clears old tool_result bodies) does not lose the generation's history", async () => {
  const f = seed([{ team: TEAM_A }, { team: TEAM_B }]);
  await request(f, payload([question("OLD ROOT")]));
  behaviors.set(f.ids[0], { team: TEAM_A, status: 402 });
  const oldRound = [question("OLD ROOT"), toolUse("old-call"), toolResult("old-call", "2301 chars of OLD output")];
  const switched = await request(f, payload([...oldRound, question("fresh question")]));
  assert.equal(switched.statusCode, 200, switched.body);
  const cleared = [question("OLD ROOT"), toolUse("old-call"), toolResult("old-call", "[Old tool result content cleared]")];
  const r = await request(f, payload([...cleared, question("fresh question"), toolUse("call-1"), toolResult("call-1", "result")]));
  assert.equal(r.statusCode, 200, r.body);
  assert.ok(!r.body.includes(RESET_NOTICE));
  assert.deepEqual(attempts.at(-1).body.messages, [question("fresh question"), toolUse("call-1"), toolResult("call-1", "result")]);
  assert.ok(!JSON.stringify(attempts.at(-1).body).includes("OLD"));
  // The anchor at another index is not the boundary: the conservative restart at the latest question applies.
  const shifted = await request(f, payload([...cleared, answer("INSERTED OLD TURN"), question("fresh question"), answer("x"), question("another question")]));
  assert.equal(shifted.statusCode, 200, shifted.body);
  assert.deepEqual(attempts.at(-1).body.messages, [question("another question")]);
  assert.ok(!JSON.stringify(attempts.at(-1).body).includes("OLD"));
});

test("unknown earlier history arriving mid tool round (history policy reset): 409, nothing forwarded; an empty latest turn: 400", async () => {
  const f = seed([{ team: TEAM_A }]);
  const start = attempts.length;
  const r = await request(f, payload([question("served elsewhere"), toolUse("foreign-call"), toolResult("foreign-call", "FOREIGN RESULT")]));
  assert.equal(r.statusCode, 409, r.body);
  assert.match(r.body, /tool_continuation_after_reset/);
  assert.ok(!r.body.includes(RESET_NOTICE));
  assert.equal(attempts.length, start);
  const empty = await request(f, payload([question("served elsewhere"), answer("x"), { role: "user", content: [{ type: "text", text: "<system-reminder>only a reminder</system-reminder>" }] }]));
  assert.equal(empty.statusCode, 400, empty.body);
  assert.match(empty.body, /no_forwardable_question/);
  assert.equal(attempts.length, start);
  // The same key then starts the conversation here: served normally.
  const ok = await request(f, payload([question("served elsewhere"), toolUse("foreign-call"), toolResult("foreign-call", "FOREIGN RESULT"), answer("x"), question("start here")]));
  assert.equal(ok.statusCode, 200, ok.body);
  assert.deepEqual(attempts.at(-1).body.messages, [question("start here")]);
});

test("isToolContinuation: tool_result / tool role / function_call_output in every dialect; a new question is not one", () => {
  assert.equal(isToolContinuation({ messages: [question("q"), toolUse("c"), toolResult("c", "r")] }, "anthropic"), true);
  assert.equal(isToolContinuation({ messages: [question("q"), toolUse("c"), toolResult("c", "r"), { role: "system", content: "per-turn" }] }, "anthropic"), true, "trailing system messages do not hide it");
  assert.equal(isToolContinuation({ messages: [question("q"), toolUse("c"), toolResult("c", "r"), { role: "assistant", content: "prefill" }] }, "anthropic"), true, "assistant prefill is skipped like latestQuestion does");
  assert.equal(isToolContinuation({ messages: [question("q"), toolUse("c"), toolResult("c", "r"), question("next")] }, "anthropic"), false);
  assert.equal(isToolContinuation({ messages: [question("q")] }, "anthropic"), false);
  assert.equal(isToolContinuation({ messages: [{ role: "user", content: "q" }, { role: "assistant", tool_calls: [{ id: "c", type: "function", function: { name: "f", arguments: "{}" } }] }, { role: "tool", tool_call_id: "c", content: "r" }] }, "openai-chat"), true);
  assert.equal(isToolContinuation({ messages: [{ role: "user", content: "q" }, { role: "assistant", content: "a" }, { role: "user", content: "b" }] }, "openai-chat"), false);
  assert.equal(isToolContinuation({ input: [{ role: "user", content: "q" }, { type: "function_call", call_id: "c", name: "f", arguments: "{}" }, { type: "function_call_output", call_id: "c", output: "r" }] }, "responses"), true);
  assert.equal(isToolContinuation({ input: "plain" }, "responses"), false);
  assert.equal(latestQuestion({ messages: [question("q"), toolUse("c"), toolResult("c", "r")] }, "anthropic").message, null, "a tool result is still never a question");
});

test("reset body removes Responses handles, developer summaries, remote tool resources, and schema descriptions", () => {
  const original = { model: "m", previous_response_id: "old", conversation: "old", instructions: "OLD INSTRUCTIONS", input: [{ role: "developer", content: "OLD SUMMARY" }, { role: "user", content: [{ type: "input_text", text: "new question" }, { type: "input_image", image_url: "data:image/png;base64,AA" }] }], tools: [{ type: "mcp", server_url: "https://old" }, { type: "function", name: "f", description: "OLD DESCRIPTION", parameters: { type: "object", description: "OLD SCHEMA", properties: { x: { type: "string" } } } }] };
  const q = latestQuestion(original, "responses");
  const clean = resetBody(original, "responses", [q.message]);
  assert.ok(!JSON.stringify(clean).includes("OLD"));
  assert.equal(clean.previous_response_id, undefined);
  assert.equal(clean.conversation, undefined);
  assert.equal(clean.tools.length, 1);
  assert.equal(clean.input[0].content.length, 2);
  const row = { reset_active: 1, reset_anchor: q.anchor, reset_prefix: q.prefix };
  assert.equal(applyResetBoundary(original, "responses", row).matched, true);
});


test("the global max-attempts cap never skips remaining accounts of the same team", async () => {
  const f = seed([{ team: TEAM_A, status: 402 }, { team: TEAM_A, status: 402 }, { team: TEAM_A, status: 402 }, { team: TEAM_A, status: 402 }, { team: TEAM_A }, { team: TEAM_B }]);
  const start = attempts.length;
  const response = await request(f, payload([question("use all A candidates")]));
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(attempts.slice(start).map((a) => a.accountId), f.ids.slice(0, 5));
});

test("concurrent A exhaustion has exactly one generation winner; both fresh questions execute in B", async () => {
  const f = seed([{ team: TEAM_A }, { team: TEAM_B }]);
  await request(f, payload([question("concurrent old root")]));
  behaviors.set(f.ids[0], { team: TEAM_A, status: 402, delay: 60 });
  const start = attempts.length;
  const old = [question("concurrent old root"), answer("OLD CONCURRENT SECRET")];
  const [one, two] = await Promise.all([request(f, payload([...old, question("fresh one")])), request(f, payload([...old, question("fresh two")]))]);
  assert.equal(one.statusCode, 200, one.body); assert.equal(two.statusCode, 200, two.body);
  const b = attempts.slice(start).filter((a) => a.accountId === f.ids[1]);
  assert.equal(b.length, 2);
  assert.ok(b.every((a) => a.isolation.generation === 2 && !JSON.stringify(a.body).includes("OLD")));
  const events = core.all("SELECT * FROM conversation_generations WHERE conversation_id=?", b[0].isolation.conversationId);
  assert.equal(events.length, 2, "initial generation plus one unique CAS reset");
});

test("streaming cross-team failover reuses heartbeats and never emits a second response header", async () => {
  const f = seed([{ team: TEAM_A, status: 402 }, { team: TEAM_B, stream: true }]);
  const response = await request(f, payload([question("stream clean question")], { stream: true }));
  assert.equal(response.statusCode, 200, response.body);
  assert.match(response.body, /event: message_stop/);
  assert.ok(response.body.includes(`reply:${f.ids[1]}`));
  assert.ok(!response.body.includes("ERR_HTTP_HEADERS_SENT"));
  assert.ok(response.headers["x-1day-conversation-id"], "SSE heartbeat must preserve the platform conversation header");
});

test("a partial model stream is terminated without replaying or appending another team's answer", async () => {
  const f = seed([{ team: TEAM_A, stream: true, partial: true }, { team: TEAM_B, stream: true }]);
  const start = attempts.length;
  const response = await request(f, payload([question("partial generation")], { stream: true }));
  assert.equal(response.statusCode, 200, response.body);
  assert.ok(response.body.includes("PARTIAL_A"));
  assert.deepEqual(attempts.slice(start).map((a) => a.accountId), [f.ids[0]]);
});

test("pure API relays and mixed groups without a matching subscription preserve their original body", async () => {
  const f = seed([{ team: TEAM_A }, { team: TEAM_B }]);
  core.run("UPDATE accounts SET models = ? WHERE id = ?", JSON.stringify(["unrequested-model"]), f.ids[0]);
  core.run("UPDATE accounts SET type='upstream',team_id=NULL WHERE id=?", f.ids[1]);
  const original = payload([question("OLD RELAY ROOT"), answer("OLD RELAY ANSWER"), question("relay new question")], { system: "RELAY ORIGINAL SYSTEM", previous_response_id: "relay-original-handle" });
  const response = await request(f, original);
  assert.equal(response.statusCode, 200, response.body);
  const call = attempts.at(-1);
  assert.equal(call.accountId, f.ids[1]);
  assert.equal(call.isolation, undefined);
  assert.equal(call.body.system, original.system);
  assert.deepEqual(call.body.messages, original.messages);
  assert.equal(call.body.previous_response_id, original.previous_response_id);
  assert.equal(core.one("SELECT COUNT(*) AS n FROM conversations WHERE api_key_id=?", f.id).n, 0);
  core.run("DELETE FROM account_groups WHERE account_id=?", f.ids[0]);
  const pure = await request(f, original);
  assert.equal(pure.statusCode, 200, pure.body);
  assert.deepEqual(attempts.at(-1).body.messages, original.messages);
});


test("parallel subagent roots after a reset keep separate boundaries without advancing the shared epoch", async () => {
  const f = seed([{ team: TEAM_A }, { team: TEAM_B }]);
  await request(f, payload([question("main root")]));
  behaviors.set(f.ids[0], { team: TEAM_A, status: 402 });
  await request(f, payload([question("main root"), answer("old main history"), question("main fresh question")]));
  const start = attempts.length;
  const [one, two] = await Promise.all([
    request(f, payload([question("subagent root one"), answer("OLD CHILD ONE"), question("child one fresh")])),
    request(f, payload([question("subagent root two"), answer("OLD CHILD TWO"), question("child two fresh")], { model: "claude-opus-5-5" })),
  ]);
  assert.equal(one.statusCode, 200, one.body); assert.equal(two.statusCode, 200, two.body);
  const calls = attempts.slice(start);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.isolation.generation === 2 && c.isolation.teamId === TEAM_B));
  assert.ok(calls.every((c) => !JSON.stringify(c.body).includes("OLD")));
  assert.equal(core.one("SELECT COUNT(*) AS n FROM conversation_boundaries WHERE conversation_id=? AND generation=2", calls[0].isolation.conversationId).n, 3);
  const returned = one.headers["x-1day-conversation-id"];
  const headers = { authorization: f.headers.authorization, "x-1day-conversation-id": returned };
  const continued = await gateway.inject({ method: "POST", url: "/v1/messages", headers, payload: payload([question("subagent root one"), answer("OLD CHILD ONE"), question("child one fresh"), answer("B child answer"), question("child one next")]) });
  assert.equal(continued.statusCode, 200, continued.body);
  assert.equal(attempts.at(-1).isolation.conversationId, returned);
  assert.deepEqual(attempts.at(-1).body.messages, [question("child one fresh"), answer("B child answer"), question("child one next")]);
});


test("cloud CCR without a reliable client id creates and archives a fresh upstream session for identical roots", async () => {
  const f = seed([{ team: TEAM_A, cloud: true }]);
  core.run("UPDATE accounts SET executor='ccr' WHERE id=?", f.ids[0]);
  const headers = { authorization: f.headers.authorization };
  for (let i = 0; i < 2; i++) {
    const response = await gateway.inject({ method: "POST", url: "/v1/messages", headers, payload: payload([question("identical stateless prompt")]) });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().content[0].text, "cloud reply turn 1");
  }
  for (let i = 0; i < 50 && [...cloudSessions.values()].filter((s) => s.accountId === f.ids[0] && s.archived).length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  const created = [...cloudSessions.values()].filter((s) => s.accountId === f.ids[0]);
  assert.equal(created.length, 2, "a shared root fingerprint is not a reusable cloud session identity");
  assert.ok(created.every((s) => s.archived && s.turns === 1));
});

test("cloud CCR with a reliable header id reuses the same branch session for extended history", async () => {
  const f = seed([{ team: TEAM_A, cloud: true }]);
  core.run("UPDATE accounts SET executor='ccr' WHERE id=?", f.ids[0]);
  const first = await request(f, payload([question("reliable cloud root")]));
  assert.equal(first.statusCode, 200, first.body);
  const next = await request(f, payload([question("reliable cloud root"), answer("cloud reply"), question("follow up")]));
  assert.equal(next.statusCode, 200, next.body);
  assert.equal(next.json().content[0].text, "cloud reply turn 2");
  const created = [...cloudSessions.values()].filter((s) => s.accountId === f.ids[0]);
  assert.equal(created.length, 1);
  assert.equal(created[0].archived, false);
  assert.equal(created[0].turns, 2);
});

test("a client can adopt the server conversation id after an unidentified first request without changing row, team or epoch", async () => {
  const f = seed([{ team: TEAM_A }]);
  const start = attempts.length;
  const first = await gateway.inject({ method: "POST", url: "/v1/messages", headers: { authorization: f.headers.authorization }, payload: payload([question("adopt server id root")]) });
  assert.equal(first.statusCode, 200, first.body);
  const returned = first.headers["x-1day-conversation-id"];
  assert.ok(returned);
  const original = core.getConversation(returned);
  assert.ok(original.external_key.startsWith("root:"), "first request really had no reliable id");
  const second = await gateway.inject({ method: "POST", url: "/v1/messages", headers: { authorization: f.headers.authorization, "x-1day-conversation-id": returned }, payload: payload([question("adopt server id root"), answer("reply from A"), question("second current question")]) });
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(second.headers["x-1day-conversation-id"], returned);
  const calls = attempts.slice(start);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.isolation.conversationId === returned && call.isolation.teamId === TEAM_A && call.isolation.generation === 1));
  assert.equal(core.one("SELECT COUNT(*) AS n FROM conversations WHERE api_key_id=?", f.id).n, 1);
  assert.equal(core.getConversation(returned).external_key, original.external_key);
  assert.deepEqual(calls[1].body.messages, [question("adopt server id root"), answer("reply from A"), question("second current question")]);

  const other = seed([{ team: TEAM_B }]);
  const foreign = await gateway.inject({ method: "POST", url: "/v1/messages", headers: { authorization: other.headers.authorization, "x-1day-conversation-id": returned }, payload: payload([question("different caller")]) });
  assert.equal(foreign.statusCode, 200, foreign.body);
  assert.notEqual(foreign.headers["x-1day-conversation-id"], returned, "a valid key cannot adopt another key's routing row");
  assert.equal(attempts.at(-1).isolation.teamId, TEAM_B);
  assert.equal(core.getConversation(returned).api_key_id, f.id);
});

test("reset retains the current text document attachment and removes old remote file handles", () => {
  const original = payload([question("OLD DOCUMENT HISTORY"), answer("OLD DOCUMENT ANSWER"), {
    role: "user", content: [
      { type: "text", text: "Read the current attachment" },
      { type: "document", source: { type: "text", media_type: "text/plain", text: "CURRENT DOCUMENT CONTENT" } },
      { type: "document", source: { type: "file", file_id: "OLD-TEAM-FILE" } },
    ],
  }], { system: "OLD CLIENT SYSTEM" });
  const current = latestQuestion(original, "anthropic");
  const clean = resetBody(original, "anthropic", [current.message]);
  assert.equal(clean.messages.length, 1);
  assert.deepEqual(clean.messages[0].content[1], { type: "document", source: { type: "text", media_type: "text/plain", text: "CURRENT DOCUMENT CONTENT" } });
  assert.equal(clean.messages[0].content.length, 2);
  assert.ok(!JSON.stringify(clean).includes("OLD"));
});


test("busy healthy team waits, preserves generation and leaves its main request intact", async () => {
  const f = seed([{team:TEAM_A, delay:120},{team:TEAM_B}]);
  core.run("UPDATE accounts SET concurrency=1 WHERE id=?",f.ids[0]);
  const start=attempts.length;
  const first=request(f,payload([question("busy root")]));
  for(let n=0;attempts.length===start && n<100;n++) await new Promise(r=>setTimeout(r,5));
  const second=request(f,payload([question("busy root"),answer("old answer"),question("parallel task")]));
  const responses=await Promise.all([first,second]);
  assert.ok(responses.every(r=>r.statusCode===200));
  const calls=attempts.slice(start);
  assert.equal(calls.length,2); assert.ok(calls.every(c=>c.accountId===f.ids[0]));
  assert.ok(calls.every(c=>c.isolation.generation===1));
  assert.ok(responses.every(r=>r.json().content[0].text===`reply:${f.ids[0]}`));
});

test("busy deadline returns retryable failure without switching teams or clearing context",async()=>{
 const f=seed([{team:TEAM_A},{team:TEAM_B}]);
 core.run("UPDATE accounts SET rpm_limit=1 WHERE id=?",f.ids[0]);
 await request(f,payload([question("rpm root")]));
 const start=attempts.length;
 const r=await request(f,payload([question("rpm root"),answer("previous"),question("second question")]));
 assert.equal(r.statusCode,503,r.body); assert.equal(r.json().error.code,"account_pool_busy");
 assert.equal(attempts.length,start);
 const row=core.getConversation(r.headers["x-1day-conversation-id"]);
 assert.equal(row.generation,1); assert.equal(row.team_id,TEAM_A);
});

test("usage plus EOF without Anthropic stop fails and charges zero",async()=>{
 const f=seed([{team:TEAM_A,stream:true,truncated:true}]);
 const r=await request(f,payload([question("truncated stream")],{stream:true}));
 assert.equal(r.body.includes("event: message_stop"),false);
 assert.match(r.body,/event: error/);
 const row=core.one("SELECT * FROM usage_logs WHERE api_key_id=?",f.id);
 assert.equal(row.status_code,502);assert.equal(row.actual_cost,0);assert.equal(row.error_code,"upstream_stream_error");
});

test("client cancellation before response headers closes remote tunnel and releases gate",async()=>{
 await gateway.listen({host:"127.0.0.1",port:0});
 const f=seed([{team:TEAM_A,delay:300}]);const start=attempts.length;
 const abort=new AbortController();
 const pending=fetch(`http://127.0.0.1:${gateway.server.address().port}/v1/messages`,{method:"POST",headers:{...f.headers,"content-type":"application/json"},body:JSON.stringify(payload([question("cancel before headers")])),signal:abort.signal});
 for(let n=0;attempts.length===start&&n<100;n++)await new Promise(r=>setTimeout(r,5));
 abort.abort();await assert.rejects(pending,{name:"AbortError"});
 const {accountInFlight}=await import("../dist/proxy.js");
 for(let n=0;accountInFlight(f.ids[0])&&n<100;n++)await new Promise(r=>setTimeout(r,5));
 assert.equal(accountInFlight(f.ids[0]),0);
 assert.ok(closedSessions.includes(attempts.at(-1).sid));
 await new Promise(r=>setTimeout(r,350));
});


test("nonstream worker cancelled before result closes worker session and releases the account",async()=>{
 const f=seed([{team:TEAM_A}]);core.run("UPDATE accounts SET executor='ccr_worker' WHERE id=?",f.ids[0]);
 const start=attempts.length;const abort=new AbortController();
 const pending=fetch(`http://127.0.0.1:${gateway.server.address().port}/v1/messages`,{method:"POST",headers:{...f.headers,"content-type":"application/json"},body:JSON.stringify(payload([question("cancel worker awaiting its result")])),signal:abort.signal});
 for(let n=0;attempts.length===start&&n<200;n++)await new Promise(r=>setTimeout(r,5));
 assert.equal(attempts.length,start+1,"worker opened");
 const sid=attempts.at(-1).sid;abort.abort();await assert.rejects(pending,{name:"AbortError"});
 const {accountInFlight}=await import("../dist/proxy.js");
 for(let n=0;(accountInFlight(f.ids[0]) || !closedSessions.includes(sid))&&n<200;n++)await new Promise(r=>setTimeout(r,5));
 assert.equal(accountInFlight(f.ids[0]),0);assert.ok(closedSessions.includes(sid));
 const row=core.one("SELECT status_code,actual_cost FROM usage_logs WHERE api_key_id=?",f.id);assert.equal(row.status_code,499);assert.equal(row.actual_cost,0);
});


test("cloud streaming consumes only the current turn from complete event history",async()=>{
 const f=seed([{team:TEAM_A,cloud:true}]);core.run("UPDATE accounts SET executor='ccr' WHERE id=?",f.ids[0]);
 const first=await request(f,payload([question("stream cloud root")],{stream:true}));
 assert.match(first.body,/cloud reply turn 1/);assert.match(first.body,/event: message_stop/);
 const second=await request(f,payload([question("stream cloud root"),answer("cloud reply turn 1"),question("next stream turn")],{stream:true}));
 assert.match(second.body,/cloud reply turn 2/);assert.doesNotMatch(second.body,/cloud reply turn 1/);assert.match(second.body,/event: message_stop/);
});


// ---------- per-key routing policy (docs/gateway.md §2b, 2026-10-29) ----------
test("history policy passthrough: unknown earlier turns are forwarded as-is, no context reset", async () => {
  const f = seed([{ team: TEAM_A }]);
  core.run("UPDATE api_keys SET policy_json=? WHERE id=?", JSON.stringify({ historyPolicy: "passthrough" }), f.id);
  const history = [question("code word is FIG-1"), answer("Noted."), question("what was my code word?")];
  const r = await request(f, payload(history, { system: "other upstream system" }));
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.headers["x-1day-context-reset"], undefined);
  assert.deepEqual(attempts.at(-1).body.messages, history);
  assert.equal(attempts.at(-1).body.system, "other upstream system");
  assert.equal(core.getConversation(attempts.at(-1).isolation.conversationId).reset_active, 0);
});

test("history policy reject: unknown earlier turns get 409 history_unknown and nothing reaches an account", async () => {
  const f = seed([{ team: TEAM_A }]);
  core.run("UPDATE api_keys SET policy_json=? WHERE id=?", JSON.stringify({ historyPolicy: "reject" }), f.id);
  const start = attempts.length;
  const r = await request(f, payload([question("old"), answer("old reply"), question("now")]));
  assert.equal(r.statusCode, 409, r.body);
  assert.equal(JSON.parse(r.body).error.code ?? JSON.parse(r.body).error.type, JSON.parse(r.body).error.code ?? "invalid_request_error");
  assert.match(r.body, /history_unknown/);
  assert.equal(attempts.length, start);
  // A first turn without history is normal; the next turn with the history this platform produced is fine too.
  const first = await request(f, payload([question("fresh start")]));
  assert.equal(first.statusCode, 200, first.body);
  const second = await request(f, payload([question("fresh start"), answer(`reply:${f.ids[0]}`), question("second turn")]));
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(attempts.at(-1).body.messages.length, 3);
});

test("direct-only key: a request without Claude Code shape is refused with 400 direct_only, never the worker", async () => {
  const f = seed([{ team: TEAM_A }]);
  core.run("UPDATE accounts SET executor='ccr_worker' WHERE id=?", f.ids[0]);
  core.run("UPDATE api_keys SET policy_json=? WHERE id=?", JSON.stringify({ directOnly: true }), f.id);
  const start = attempts.length;
  const r = await request(f, payload([question("plain client")]), { "user-agent": "curl/8.0" });
  assert.equal(r.statusCode, 400, r.body);
  assert.match(r.body, /direct_only/);
  assert.equal(attempts.length, start, "no worker session opened");
  const row = core.one("SELECT status_code, error_code FROM usage_logs WHERE api_key_id=? ORDER BY created_at DESC LIMIT 1", f.id);
  assert.equal(row.error_code, "direct_only");
});
