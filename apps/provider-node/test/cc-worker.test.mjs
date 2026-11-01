// CcWorkerManager (docs/ccr-supply.md §8.1): spawn of the real Claude Code
// binary (fixture script stands in), credential materialization, pinned-proxy
// hard reject, concurrency guardrail + FIFO queue, timeout kill.
//   bun apps/provider-node/test/cc-worker.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CcWorkerManager, defaultMaxConcurrency } from "../dist/cc-worker.js";
import { ProxyPool, proxyId } from "../dist/proxy-pool.js";

const FIXTURE = new URL("./fake-claude.mjs", import.meta.url).pathname;
const PROXY = "http://user:pass@127.0.0.1:9009";
const PIN = proxyId(PROXY);

const waitFor = async (cond, ms = 8000, label = "") => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`waitFor timeout${label ? `: ${label}` : ""}`);
};

function setup(opts = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-worker-test-"));
  const store = { data: {}, save() {} };
  const pool = new ProxyPool(store, { autoCheck: false });
  pool.replaceAll([PROXY]);
  const frames = [];
  const manager = new CcWorkerManager({
    send: (m) => (frames.push(m), true),
    identity: () => ({ nodeId: "n1", providerId: "p1" }),
    isDraining: () => false,
    pool,
    dataDir,
    claudeBin: process.execPath,
    claudeArgsPrefix: [FIXTURE],
    ...opts,
  });
  return { manager, frames, dataDir, pool };
}

const openMsg = (sessionId, extra = {}) => ({
  type: "cc_worker.open",
  sessionId,
  routeMode: "cc_worker",
  providerId: "p1",
  nodeId: "n1",
  credentialBindingId: "acct-1",
  accountId: "acct-1",
  proxyId: PIN,
  model: "claude-sonnet-5-5",
  prompt: "say hi",
  stream: true,
  cred: { accessToken: "sk-ant-oat-test", refreshToken: "sk-ant-ort-test", expiresAt: Date.now() + 3600_000, subscriptionType: "pro" },
  deadlineMs: 15_000,
  ...extra,
});

const framesFor = (frames, sid) => frames.filter((f) => f.sessionId === sid);
const stdoutOf = (frames, sid) =>
  Buffer.concat(framesFor(frames, sid).filter((f) => f.type === "cc_worker.data").map((f) => Buffer.from(f.payloadBase64, "base64"))).toString("utf8");

// ---- happy path: accepted, stdout streams back, close=complete, creds materialized ----
{
  const { manager, frames, dataDir } = setup();
  assert.ok(manager.claudeVersion?.includes("2.1.312"), "fixture answers --version");
  manager.handleOpen(openMsg("s1"));
  await waitFor(() => framesFor(frames, "s1").some((f) => f.type === "cc_worker.close"));
  assert.equal(framesFor(frames, "s1")[0].type, "cc_worker.open_response");
  assert.equal(framesFor(frames, "s1")[0].accepted, true);
  assert.equal(framesFor(frames, "s1").at(-1).reasonCode, "complete");
  const out = stdoutOf(frames, "s1");
  assert.ok(out.includes('"type":"result"') && out.includes("Hello from fake claude."), out.slice(0, 300));
  assert.ok(out.includes(`"https_proxy":"${PROXY}"`), "pinned proxy injected as HTTPS_PROXY");

  const dir = path.join(dataDir, "cc-accounts", "acct-1");
  assert.equal((fs.statSync(dir).mode & 0o777).toString(8), "700");
  const credFile = path.join(dir, ".credentials.json");
  assert.equal((fs.statSync(credFile).mode & 0o777).toString(8), "600");
  const cred = JSON.parse(fs.readFileSync(credFile, "utf8"));
  assert.equal(cred.claudeAiOauth.accessToken, "sk-ant-oat-test");
  assert.equal(cred.claudeAiOauth.subscriptionType, "pro");
  assert.deepEqual(cred.claudeAiOauth.scopes.length, 5);
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8")).hasCompletedOnboarding);
  manager.closeAll();
}

// ---- pinned proxy missing / dead => hard reject ----
{
  const { manager, frames } = setup();
  manager.handleOpen(openMsg("s2", { proxyId: "000000000000" }));
  const r = framesFor(frames, "s2")[0];
  assert.equal(r.accepted, false);
  assert.equal(r.reasonCode, "no_proxy_available");
  manager.closeAll();
}
{
  const { manager, frames, pool } = setup();
  for (let i = 0; i < pool.deadAfter; i++) pool.markDead(PROXY, "test: dead"); // consecutive failures -> dead
  manager.handleOpen(openMsg("s3"));
  assert.equal(framesFor(frames, "s3")[0].reasonCode, "no_proxy_available", "dead pin rejected");
  manager.closeAll();
}

// ---- claude binary missing => claude_not_installed ----
{
  const { manager, frames } = setup({ claudeBin: "/nonexistent/claude", claudeArgsPrefix: [] });
  assert.equal(manager.claudeVersion, null);
  manager.handleOpen(openMsg("s4"));
  assert.equal(framesFor(frames, "s4")[0].reasonCode, "claude_not_installed");
  manager.closeAll();
}

// ---- nonzero exit => worker_failed with stderr tail ----
{
  const { manager, frames } = setup();
  process.env.FAKE_CLAUDE_MODE = "fail";
  try {
    manager.handleOpen(openMsg("s5"));
    await waitFor(() => framesFor(frames, "s5").some((f) => f.type === "cc_worker.error"));
    const err = framesFor(frames, "s5").find((f) => f.type === "cc_worker.error");
    assert.equal(err.errorCode, "worker_failed");
    assert.ok(err.errorMessage.includes("invalid session credentials"), err.errorMessage);
  } finally {
    delete process.env.FAKE_CLAUDE_MODE;
  }
  manager.closeAll();
}

// ---- concurrency guardrail: 1 active, 1 queued, 3rd rejected; queue drains ----
{
  const { manager, frames } = setup({ maxConcurrency: 1, maxQueue: 1 });
  process.env.FAKE_CLAUDE_MODE = "slow";
  try {
    manager.handleOpen(openMsg("q1"));
    manager.handleOpen(openMsg("q2"));
    manager.handleOpen(openMsg("q3"));
    assert.equal(framesFor(frames, "q3")[0].reasonCode, "worker_overloaded");
    assert.equal(framesFor(frames, "q2")[0].accepted, true, "second open accepted into the queue");
    await waitFor(() => framesFor(frames, "q2").some((f) => f.type === "cc_worker.close"), 15000);
    const q1FirstData = frames.findIndex((f) => f.sessionId === "q1" && f.type === "cc_worker.data");
    const q1Close = frames.findIndex((f) => f.sessionId === "q1" && f.type === "cc_worker.close");
    const q2FirstData = frames.findIndex((f) => f.sessionId === "q2" && f.type === "cc_worker.data");
    assert.ok(q1FirstData !== -1 && q1Close !== -1 && q2FirstData > q1Close, "queued worker starts only after the active one finishes");
  } finally {
    delete process.env.FAKE_CLAUDE_MODE;
  }
  manager.closeAll();
}

// ---- timeout kill ----
{
  const { manager, frames } = setup({ timeoutMs: 400 });
  process.env.FAKE_CLAUDE_MODE = "hang";
  try {
    manager.handleOpen(openMsg("t1"));
    await waitFor(() => framesFor(frames, "t1").some((f) => f.type === "cc_worker.error"));
    assert.equal(framesFor(frames, "t1").find((f) => f.type === "cc_worker.error").errorCode, "worker_timeout");
  } finally {
    delete process.env.FAKE_CLAUDE_MODE;
  }
  manager.closeAll();
}

// ---- default concurrency from free memory ----
assert.equal(defaultMaxConcurrency(4096 * 1_048_576), 11); // floor((4096-512)/320)
assert.equal(defaultMaxConcurrency(600 * 1_048_576), 1, "floor 1");


// ---- image request: content blocks -> --input-format stream-json, one user message on stdin ----
{
  const { manager, frames } = setup();
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  manager.handleOpen(
    openMsg("s-img", {
      prompt: "what colour is this?",
      content: [
        { type: "text", text: "what colour is this?" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: png } },
      ],
    }),
  );
  await waitFor(() => framesFor(frames, "s-img").some((f) => f.type === "cc_worker.close"));
  assert.equal(framesFor(frames, "s-img").at(-1).reasonCode, "complete");
  const out = stdoutOf(frames, "s-img");
  assert.ok(out.includes('"input_format":"stream-json"'), "node switched claude to stream-json input: " + out.slice(0, 200));
  assert.ok(out.includes('"images":1'), "the image block reached the worker");
  assert.ok(out.includes('"prompt_chars":20'), "text block carried the folded prompt");
}

// ---- isolation: private scratch cwd/HOME per session, removed afterwards; no tools, no transcript ----
{
  const { manager, frames, dataDir } = setup();
  manager.handleOpen(openMsg("s-iso"));
  await waitFor(() => framesFor(frames, "s-iso").some((f) => f.type === "cc_worker.close"));
  const out = stdoutOf(frames, "s-iso");
  const init = JSON.parse(out.split("\n").find((l) => l.includes('"subtype":"init"')));
  const sessionsDir = path.join(dataDir, "cc-sessions");
  assert.ok(init.cwd.startsWith(sessionsDir), `worker cwd is a per-session scratch dir: ${init.cwd}`);
  assert.equal(init.home, init.cwd, "HOME points at the scratch dir too");
  assert.ok(init.argv.includes("--tools") && init.argv.includes("--no-session-persistence"), `isolation flags passed: ${init.argv.join(" ")}`);
  await waitFor(() => !fs.existsSync(init.cwd));
  assert.ok(!fs.existsSync(init.cwd), "scratch dir removed after the session");
  assert.equal(manager.runAs, null, "tests do not run as root: no privilege drop");
}

// ---- startup self-test: a binary that cannot run under isolation disables worker mode with a clear reason ----
{
  // Binary present but unable to run under isolation (stands in for EACCES on the scratch dir, bad uid, …).
  const { manager, frames } = setup({ claudeArgsPrefix: ["-e", "console.error('boom'); process.exit(3)", "--"] });
  assert.equal(manager.claudeVersion, null);
  assert.match(manager.selfTestError ?? "", /^self_test_failed: .*--version exited 3 as node user in .*cc-sessions\/selftest: boom/);
  assert.equal(manager.stats().enabled, false);
  assert.equal(manager.stats().selfTestError, manager.selfTestError);
  manager.handleOpen(openMsg("s-selftest"));
  const resp = framesFor(frames, "s-selftest").find((f) => f.type === "cc_worker.open_response");
  assert.equal(resp.accepted, false);
  assert.match(resp.reasonCode, /^self_test_failed:/);
}
{
  const missing = setup({ claudeBin: "/nonexistent/claude", claudeArgsPrefix: [] }).manager;
  assert.equal(missing.selfTestError, "claude_not_installed", "no binary at all keeps the historical reason code");
  const { manager, dataDir } = setup();
  assert.equal(manager.selfTestError, null, "fixture passes the self-test");
  assert.ok(!fs.existsSync(path.join(dataDir, "cc-sessions", "selftest")), "self-test scratch dir removed");
}

// ---- system prompt travels as a file in the scratch dir and reaches claude via --system-prompt-file ----
{
  const { manager, frames } = setup();
  manager.handleOpen({ ...openMsg("s-sys"), systemPrompt: "You are a terse assistant." });
  await waitFor(() => framesFor(frames, "s-sys").some((f) => f.type === "cc_worker.close"));
  const out = stdoutOf(frames, "s-sys");
  const init = JSON.parse(out.split("\n").find((l) => l.includes('"subtype":"init"')));
  assert.ok(init.argv.includes("--system-prompt-file"), `system prompt flag passed: ${init.argv.join(" ")}`);
  assert.equal(init.systemPrompt, "You are a terse assistant.");
  await waitFor(() => !fs.existsSync(init.cwd));
}

// ---- device identity: fresh config dir seeded from the platform's deviceId; identities reported as a heartbeat delta ----
{
  const { manager, frames, dataDir } = setup();
  const dev = "e".repeat(64);
  manager.handleOpen({ ...openMsg("s-dev"), deviceId: dev });
  await waitFor(() => framesFor(frames, "s-dev").some((f) => f.type === "cc_worker.close"));
  const cfg = JSON.parse(fs.readFileSync(path.join(dataDir, "cc-accounts", openMsg("s-dev").accountId, ".claude.json"), "utf8"));
  assert.equal(cfg.userID, dev, "seeded .claude.json userID");
  const delta = manager.identityDelta();
  assert.deepEqual(delta[openMsg("s-dev").accountId], { deviceId: dev, accountUuid: null });
  assert.deepEqual(manager.identityDelta(), {}, "delta drained");
  manager.scanIdentities();
  assert.ok(manager.identityDelta()[openMsg("s-dev").accountId], "scan re-reports everything");
}

// ---- persistent session pool: fresh -> continue reuses the same process; turn mismatch -> fresh replaces; retireIdle empties ----
{
  const { manager, frames } = setup();
  const key = "k".repeat(64);
  manager.handleOpen({ ...openMsg("p1"), persist: true, reuseKey: key, turnMode: "fresh", content: [{ type: "text", text: "q1" }] });
  await waitFor(() => framesFor(frames, "p1").some((f) => f.type === "cc_worker.close"));
  assert.equal(framesFor(frames, "p1").at(-1).reasonCode, "complete");
  let pool = manager.stats().pool;
  assert.deepEqual([pool.live, pool.idle, pool.busy], [1, 1, 0], `process kept alive and idle: ${JSON.stringify(pool)}`);
  assert.ok(stdoutOf(frames, "p1").includes('"subtype":"init"'), "first turn saw init");

  manager.handleOpen({ ...openMsg("p2"), persist: true, reuseKey: key, turnMode: "continue", expectedTurn: 1, content: [{ type: "text", text: "q2" }] });
  await waitFor(() => framesFor(frames, "p2").some((f) => f.type === "cc_worker.close"));
  const out2 = stdoutOf(frames, "p2");
  assert.ok(!out2.includes('"subtype":"init"'), "second turn reused the process (no init)");
  assert.ok(out2.includes("Turn 2 reply"), "second turn answered by the same process");
  pool = manager.stats().pool;
  assert.deepEqual([pool.live, pool.idle], [1, 1]);

  // Gateway thinks it is turn 7 (e.g. gateway restarted elsewhere): mismatch -> fresh process from the FULL history, never the tail.
  const history3 = [{ type: "text", text: "[user]\nq1" }, { type: "text", text: "[assistant]\na1" }, { type: "text", text: "[user]\nq2" }, { type: "text", text: "[assistant]\na2" }, { type: "text", text: "q3" }];
  manager.handleOpen({ ...openMsg("p3"), persist: true, reuseKey: key, turnMode: "continue", expectedTurn: 7, content: [{ type: "text", text: "q3" }], history: history3 });
  await waitFor(() => framesFor(frames, "p3").some((f) => f.type === "cc_worker.close"));
  assert.ok(stdoutOf(frames, "p3").includes('"subtype":"init"'), "mismatch -> fresh process");
  const init3 = JSON.parse(stdoutOf(frames, "p3").split("\n").find((l) => l.includes('"subtype":"init"')));
  assert.equal(init3.prompt_chars, history3.map((b) => b.text).join("\n").length, "the fresh process was fed the whole history, not the 2-char tail");
  pool = manager.stats().pool;
  assert.deepEqual([pool.live, pool.idle], [1, 1], "old process replaced, not accumulated");
  assert.equal(pool.evictions.replaced, 1);

  // After the fresh-on-mismatch the node adopted expectedTurn, so the gateway's next continue (turn 8) hits.
  manager.handleOpen({ ...openMsg("p4"), persist: true, reuseKey: key, turnMode: "continue", expectedTurn: 8, content: [{ type: "text", text: "q4" }] });
  await waitFor(() => framesFor(frames, "p4").some((f) => f.type === "cc_worker.close"));
  assert.ok(!stdoutOf(frames, "p4").includes('"subtype":"init"'), "counter re-synced: reused again");

  manager.retireIdle("test");
  await waitFor(() => manager.stats().pool.live === 0);
  assert.equal(manager.stats().pool.evictions.test, 1);
}

// ---- continue miss without history: refused (session_lost), nothing spawned; busy miss with history: one-shot over the full history ----
{
  const { manager, frames } = setup();
  const key = "m".repeat(64);
  // No live process for the key and the open carries no history → error frame, no process.
  manager.handleOpen({ ...openMsg("m1"), persist: true, reuseKey: key, turnMode: "continue", expectedTurn: 3, content: [{ type: "text", text: "tail only" }] });
  await waitFor(() => framesFor(frames, "m1").some((f) => f.type === "cc_worker.error"), 8000, "m1 error frame; frames=" + JSON.stringify(framesFor(frames, "m1").map((f) => f.type)));
  const err = framesFor(frames, "m1").find((f) => f.type === "cc_worker.error");
  assert.equal(err.errorCode, "session_lost");
  assert.equal(err.retryable, true);
  assert.equal(stdoutOf(frames, "m1"), "", "no process was started from the tail");
  assert.equal(manager.stats().pool.live, 0);

  // A process busy on a slow turn (fixture pauses 300 ms mid-stream); the next continue for the same key arrives before it finishes.
  process.env.FAKE_CLAUDE_MODE = "slow";
  try {
    manager.handleOpen({ ...openMsg("m2"), persist: true, reuseKey: key, turnMode: "fresh", content: [{ type: "text", text: "q1" }] });
    await waitFor(() => stdoutOf(frames, "m2").includes('"subtype":"init"'), 8000, "m2 init");
    assert.equal(manager.stats().pool.busy, 1, "first process is mid-turn");
    const history = [{ type: "text", text: "[user]\nq1" }, { type: "text", text: "[assistant]\na1" }, { type: "text", text: "q2" }];
    manager.handleOpen({ ...openMsg("m3"), persist: true, reuseKey: key, turnMode: "continue", expectedTurn: 1, content: [{ type: "text", text: "q2" }], history });
    await waitFor(() => framesFor(frames, "m3").some((f) => f.type === "cc_worker.close"), 8000, "m3 close; m3 frames=" + JSON.stringify(framesFor(frames, "m3").map((f) => f.type + (f.reasonCode ? ":" + f.reasonCode : "") + (f.errorCode ? ":" + f.errorCode : ""))));
    const init = JSON.parse(stdoutOf(frames, "m3").split("\n").find((l) => l.includes('"subtype":"init"')));
    assert.equal(init.prompt_chars, history.map((b) => b.text).join("\n").length, "busy miss → one-shot fresh process over the full history");
    assert.equal(framesFor(frames, "m3").at(-1).reasonCode, "complete");
    await waitFor(() => framesFor(frames, "m2").some((f) => f.type === "cc_worker.close"), 8000, "m2 close");
    assert.equal(framesFor(frames, "m2").at(-1).reasonCode, "complete", "the busy process finished its own turn undisturbed");
  } finally {
    delete process.env.FAKE_CLAUDE_MODE;
  }
  manager.retireIdle("test");
  await waitFor(() => manager.stats().pool.live === 0);
}

// ---- continue aimed at a process parked on tool calls: never written to its stdin; fresh over the history, parked process replaced ----
{
  const { manager, frames } = setup();
  const key = "a".repeat(64);
  const tools = [{ name: "get_weather", description: "weather", input_schema: { type: "object", properties: { city: { type: "string" } } } }];
  manager.handleOpen({ ...openMsg("a1"), persist: true, reuseKey: key, turnMode: "fresh", tools, content: [{ type: "text", text: '[TOOL]get_weather {"city":"Oslo"}' }] });
  await waitFor(() => stdoutOf(frames, "a1").includes('"type":"1dayapi_tool_call"'));
  manager.handleClose({ type: "cc_worker.close", sessionId: "a1", reasonCode: "gateway_closed" });
  await waitFor(() => manager.stats().pool.awaitingTools === 1, 8000, "a1 parked");
  // 10-22 incident shape: the gateway failed to recognise the tool_result and sent a plain continue.
  // (history text deliberately without the fixture's [TOOL] trigger: the fresh process must answer, not park again)
  const history = [{ type: "text", text: "[user]\nweather in Oslo?" }, { type: "text", text: "[assistant]\ntool_use get_weather" }, { type: "text", text: "[user]\n[tool_result]\nsunny" }];
  manager.handleOpen({ ...openMsg("a2"), persist: true, reuseKey: key, turnMode: "continue", expectedTurn: 0, tools, content: [{ type: "text", text: "[user]\n[tool_result]\nsunny" }], history });
  await waitFor(() => framesFor(frames, "a2").some((f) => f.type === "cc_worker.close"), 10000, "a2 close; frames=" + JSON.stringify(framesFor(frames, "a2").map((f) => f.type + (f.reasonCode ? ":" + f.reasonCode : "") + (f.errorCode ? ":" + f.errorCode : ""))));
  assert.equal(framesFor(frames, "a2").at(-1).reasonCode, "complete", "the request completed instead of hanging");
  const init = JSON.parse(stdoutOf(frames, "a2").split("\n").find((l) => l.includes('"subtype":"init"')));
  assert.equal(init.prompt_chars, history.map((b) => b.text).join("\n").length, "fresh over the full history");
  const pool = manager.stats().pool;
  assert.equal(pool.awaitingTools, 0, "the parked process is gone");
  assert.equal(pool.evictions.replaced, 1);
  manager.retireIdle("test");
  await waitFor(() => manager.stats().pool.live === 0);
  manager.closeAll("test");
}

// ---- native tools: tool_use -> parked MCP call -> gateway closes -> client's tool_result resumes the same turn ----
{
  const { manager, frames } = setup();
  const key = "t".repeat(64);
  const tools = [{ name: "get_weather", description: "weather", input_schema: { type: "object", properties: { city: { type: "string" } } } }];
  manager.handleOpen({ ...openMsg("n1"), persist: true, reuseKey: key, turnMode: "fresh", tools, content: [{ type: "text", text: '[TOOL]get_weather {"city":"Oslo"}' }] });
  // The fake emits a native tool_use, then calls our MCP server; the node surfaces the parked call as a synthetic line.
  await waitFor(() => stdoutOf(frames, "n1").includes('"type":"1dayapi_tool_call"'));
  const out1 = stdoutOf(frames, "n1");
  assert.ok(out1.includes('"name":"mcp__caller__get_weather"'), "native tool_use streamed");
  const callLine = JSON.parse(out1.split("\n").find((l) => l.includes('"1dayapi_tool_call"')));
  assert.equal(callLine.name, "get_weather");
  assert.deepEqual(callLine.input, { city: "Oslo" });
  // Gateway hands the tool_use to the client and closes this request: the process must stay, parked.
  manager.handleClose({ type: "cc_worker.close", sessionId: "n1", reasonCode: "gateway_closed" });
  await waitFor(() => framesFor(frames, "n1").some((f) => f.type === "cc_worker.close"));
  assert.equal(framesFor(frames, "n1").at(-1).reasonCode, "awaiting_tool_result");
  let pool = manager.stats().pool;
  assert.deepEqual([pool.live, pool.awaitingTools, pool.busy], [1, 1, 0], JSON.stringify(pool));
  // Client comes back with the result (same turn counter: no result event happened yet).
  manager.handleOpen({ ...openMsg("n2"), persist: true, reuseKey: key, turnMode: "tool_result", expectedTurn: 0, results: [{ callId: callLine.callId, content: "sunny, 7°C", isError: false }] });
  await waitFor(() => framesFor(frames, "n2").some((f) => f.type === "cc_worker.close"));
  const out2 = stdoutOf(frames, "n2");
  assert.ok(out2.includes("Tool said: sunny, 7°C"), `turn resumed with the tool result: ${out2.slice(0, 200)}`);
  assert.ok(out2.includes('"type":"result"'), "turn completed after the tool result");
  assert.equal(framesFor(frames, "n2").at(-1).reasonCode, "complete");
  pool = manager.stats().pool;
  assert.deepEqual([pool.live, pool.idle, pool.awaitingTools], [1, 1, 0], "back to idle, process kept");
  manager.retireIdle("test");
  await waitFor(() => manager.stats().pool.live === 0);
  manager.closeAll("test"); // stops the loopback MCP server so the test process can exit
}

// ---- thinking budget reaches claude as --max-thinking-tokens ----
{
  const { manager, frames } = setup();
  manager.handleOpen({ ...openMsg("s-think"), thinkingBudget: 4096 });
  await waitFor(() => framesFor(frames, "s-think").some((f) => f.type === "cc_worker.close"));
  const init = JSON.parse(stdoutOf(frames, "s-think").split("\n").find((l) => l.includes('"subtype":"init"')));
  assert.ok(init.argv.includes("--max-thinking-tokens"), `thinking flag passed: ${init.argv.join(" ")}`);
  manager.closeAll("test");
}


// A transport that refuses data must stop its producer rather than keep a detached process.
{
  const frames=[];
  const {manager,dataDir}=setup({send:(frame)=>{frames.push(frame);return frame.type!=="cc_worker.data";}});
  manager.handleOpen(openMsg("send-refused"));
  await waitFor(()=>frames.some(f=>f.sessionId==="send-refused"&&f.type==="cc_worker.error"));
  assert.ok(frames.some(f=>f.sessionId==="send-refused"&&f.errorCode==="transport_backpressure"));
  assert.equal(manager.activeSessions,0);
  manager.closeAll();fs.rmSync(dataDir,{recursive:true,force:true});
}

// ---- canonical worker (spec WP2): native identity kept, --restricted, native session, caller system appended ----
{
  const { manager, frames } = setup({ canonical: true });
  manager.handleOpen(openMsg("s-canon", { mode: "canonical", appendSystemPrompt: "You are Acme's assistant.", nativeSessionId: "11111111-2222-4333-8444-555555555555", builtInToolProfile: "restricted-default" }));
  await waitFor(() => framesFor(frames, "s-canon").some((f) => f.type === "cc_worker.close"));
  const out = stdoutOf(frames, "s-canon");
  const init = JSON.parse(out.split("\n").find((l) => l.includes('"subtype":"init"')));
  const argv = init.argv;
  for (const f of ["--restricted", "--permission-prompts", "--session-id", "--append-system-prompt-file", "--include-partial-messages"]) assert.ok(argv.includes(f), `canonical passes ${f}: ${argv.join(" ")}`);
  for (const f of ["--tools", "--no-session-persistence", "--system-prompt-file"]) assert.ok(!argv.includes(f), `canonical never passes ${f}: ${argv.join(" ")}`);
  assert.equal(init.systemPrompt, null, "the native system prompt is not replaced (I1)");
  assert.ok(manager.stats().canonical.enabled);
  assert.deepEqual(manager.stats().canonical.profiles, ["cc-2.1.312-restricted"]);
  // tools-disabled variant adds --tools "" on top of --restricted
  manager.handleOpen(openMsg("s-canon-nt", { mode: "canonical", builtInToolProfile: "tools-disabled-canonical" }));
  await waitFor(() => framesFor(frames, "s-canon-nt").some((f) => f.type === "cc_worker.close"));
  const init2 = JSON.parse(stdoutOf(frames, "s-canon-nt").split("\n").find((l) => l.includes('"subtype":"init"')));
  assert.ok(init2.argv.includes("--tools") && init2.argv.includes("--restricted"));
  // a malformed native session id is refused (it would become a file name)
  manager.handleOpen(openMsg("s-canon-bad", { mode: "canonical", nativeSessionId: "../../etc" }));
  await waitFor(() => framesFor(frames, "s-canon-bad").some((f) => f.type === "cc_worker.open_response"));
  assert.deepEqual(framesFor(frames, "s-canon-bad").find((f) => f.type === "cc_worker.open_response"), { type: "cc_worker.open_response", sessionId: "s-canon-bad", accepted: false, reasonCode: "bad_native_session_id" });
}
// ---- canonical not enabled on the node: refused, never run as a legacy process (I9) ----
{
  const { manager, frames } = setup();
  assert.equal(manager.canonicalEnabled, false, "default off (env CC_WORKER_CANONICAL unset)");
  assert.equal(manager.stats().canonical.enabled, false);
  manager.handleOpen(openMsg("s-canon-off", { mode: "canonical" }));
  await waitFor(() => framesFor(frames, "s-canon-off").some((f) => f.type === "cc_worker.open_response"));
  assert.equal(framesFor(frames, "s-canon-off").find((f) => f.type === "cc_worker.open_response").reasonCode, "canonical_unsupported");
  // legacy opens unaffected
  manager.handleOpen(openMsg("s-legacy"));
  await waitFor(() => framesFor(frames, "s-legacy").some((f) => f.type === "cc_worker.close"));
  assert.ok(JSON.parse(stdoutOf(frames, "s-legacy").split("\n").find((l) => l.includes('"subtype":"init"'))).argv.includes("--no-session-persistence"));
}

// ---- WP3: native session resume and history import ----
{
  const { manager, frames, dataDir } = setup({ canonical: true });
  const NS = "22222222-3333-4444-8555-666666666666";
  // explicit resume of a known native session
  manager.handleOpen(openMsg("s-resume", { mode: "canonical", nativeSession: { id: NS, action: "resume", revision: 2 }, content: [{ type: "text", text: "next turn" }] }));
  await waitFor(() => framesFor(frames, "s-resume").some((f) => f.type === "cc_worker.close"));
  const init = JSON.parse(stdoutOf(frames, "s-resume").split("\n").find((l) => l.includes('"subtype":"init"')));
  assert.ok(init.argv.includes("--resume"), `resume passes --resume: ${init.argv.join(" ")}`);
  assert.ok(!init.argv.includes("--session-id"), "not both");
  // history import: transcript written under the account config dir, then --resume
  const NS2 = "33333333-4444-4555-8666-777777777777";
  const lines = [{ type: "user", message: { role: "user", content: "imported question" }, uuid: "u1", parentUuid: null }, { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "imported answer" }] }, uuid: "u2", parentUuid: "u1" }];
  manager.handleOpen(openMsg("s-import", { mode: "canonical", nativeSession: { id: NS2, action: "resume", revision: 0 }, historyImport: lines, content: [{ type: "text", text: "live turn" }] }));
  await waitFor(() => framesFor(frames, "s-import").some((f) => f.type === "cc_worker.close"));
  const init2 = JSON.parse(stdoutOf(frames, "s-import").split("\n").find((l) => l.includes('"subtype":"init"')));
  assert.ok(init2.argv.includes("--resume"));
  const found = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name === `${NS2}.jsonl`) found.push(p); } };
  walk(dataDir);
  assert.equal(found.length, 1, `transcript written once under the account config dir: ${found.join(",")}`);
  assert.ok(found[0].includes(`${path.sep}projects${path.sep}`), found[0]);
  const written = fs.readFileSync(found[0], "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(written.length, 2);
  assert.ok(written.every((l) => l.sessionId === NS2 && typeof l.cwd === "string" && l.cwd.length > 0), "node stamps sessionId and its real cwd on every line");
  assert.equal(written[1].message.content[0].text, "imported answer");
  // malformed nativeSession / import without a session are refused
  manager.handleOpen(openMsg("s-bad-ns", { mode: "canonical", nativeSession: { id: "nope", action: "resume" } }));
  await waitFor(() => framesFor(frames, "s-bad-ns").some((f) => f.type === "cc_worker.open_response"));
  assert.equal(framesFor(frames, "s-bad-ns").find((f) => f.type === "cc_worker.open_response").reasonCode, "bad_native_session_id");
  manager.handleOpen(openMsg("s-bad-imp", { mode: "canonical", historyImport: lines }));
  await waitFor(() => framesFor(frames, "s-bad-imp").some((f) => f.type === "cc_worker.open_response"));
  assert.equal(framesFor(frames, "s-bad-imp").find((f) => f.type === "cc_worker.open_response").reasonCode, "bad_history_import");
  // canonical continue with no live process and nothing to resume → session_lost (never a fresh process over a tail)
  manager.handleOpen(openMsg("s-lost", { mode: "canonical", persist: true, reuseKey: "rk-canon-lost", turnMode: "continue", expectedTurn: 3, content: [{ type: "text", text: "tail" }] }));
  await waitFor(() => framesFor(frames, "s-lost").some((f) => f.type === "cc_worker.error" || f.type === "cc_worker.close"));
  assert.ok(framesFor(frames, "s-lost").some((f) => (f.type === "cc_worker.error" && f.errorCode === "session_lost") || (f.type === "cc_worker.close" && f.reasonCode === "session_lost")), JSON.stringify(framesFor(frames, "s-lost").map((f) => [f.type, f.errorCode ?? f.reasonCode])));
  // …but with a resumable native session the miss becomes --resume fed with the new turn only
  manager.handleOpen(openMsg("s-miss-resume", { mode: "canonical", persist: true, reuseKey: "rk-canon-miss", turnMode: "continue", expectedTurn: 1, nativeSession: { id: NS, action: "resume", revision: 1 }, content: [{ type: "text", text: "tail" }] }));
  await waitFor(() => framesFor(frames, "s-miss-resume").some((f) => f.type === "cc_worker.close"));
  const init3 = JSON.parse(stdoutOf(frames, "s-miss-resume").split("\n").find((l) => l.includes('"subtype":"init"')));
  assert.ok(init3.argv.includes("--resume"), `continue miss → --resume: ${init3.argv.join(" ")}`);
  manager.closeAll("test");
}
console.log("cc-worker: ALL PASSED");
