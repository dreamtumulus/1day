// Worker mode (docs/ccr-supply.md §8.1) end-to-end: a fake provider node runs
// the fake claude fixture; the gateway drives it over the cc_worker tunnel and
// the SessionTranslator turns stream-json into Messages wire; billing lands on
// the worker account. A genuine Claude Code request takes the direct path.
import { readFileSync } from "node:fs";
import { createTeamFixture, genuineCcRequest } from "./team-fixture.mjs";
const seed = readFileSync(process.argv[2], "utf8");
const pick = (label) => seed.split("\n").find((l) => l.startsWith(label)).split(":")[1].trim().split(" ")[0];
const C = `http://127.0.0.1:${process.env.E2E_CONSOLE_PORT ?? 18401}`, G = `http://127.0.0.1:${process.env.E2E_GATEWAY_PORT ?? 18400}`;
const MOCK = `http://127.0.0.1:${process.env.E2E_MOCK_PORT ?? 19101}`;
let fails = 0;
const check = (n, c, e = "") => { console.log(`${c ? "PASS" : "FAIL"} ${n} ${c ? "" : JSON.stringify(e).slice(0, 500)}`); if (!c) fails++; };
async function session(key) {
  const r = await fetch(C + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key }) });
  const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
  return async (method, path, body) => {
    const res = await fetch(C + path, { method, headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, ...(await res.json().catch(() => ({}))) };
  };
}
const post = async (key, path, body, headers = {}) => {
  const r = await fetch(G + path, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  return { status: r.status, text: await r.text() };
};
let seq = 0;
const uniq = () => `${Date.now()}-${seq++}`;
const messages = (key, extra = {}, headers = {}) => post(key, "/v1/messages", { model: "claude-sonnet-5", max_tokens: 64, messages: [{ role: "user", content: `worker ${uniq()}` }], ...extra }, headers);

// X-54: a prompt of more than 400 estimated tokens. The fake claude reports ~34.9k upstream prompt tokens whatever was
// sent; for a one-sentence request the small-turn cap now shows only the customer's own few tokens (checked below), so
// the checks that pin the baseline arithmetic and the X-51 cache-write presentation send a prompt that is not "small".
const LONG = " The quick brown fox jumps over the lazy dog.".repeat(60);
// X-57: the caller asks for caching (cache_control), so the cache write beyond the platform baseline is its own line;
// plainLongMsg() is the same prompt without the marker: there the write stays plain input, as at the official API.
const longMsg = () => [{ role: "user", content: [{ type: "text", text: `worker ${uniq()}${LONG}`, cache_control: { type: "ephemeral" } }] }];
const plainLongMsg = () => [{ role: "user", content: `worker ${uniq()}${LONG}` }];

const admin = await session(pick("admin    login key"));
const prov = await session(pick("provider login key"));
const consumer = await session(pick("consumer login key"));
check("logins", typeof admin === "function" && typeof prov === "function" && typeof consumer === "function");

// ---- fake node up ----
const fixture = await createTeamFixture({ admin, provider: prov, consoleBase: C, upstreamBase: MOCK });
const nodes = await prov("GET", "/api/provider/nodes");
check("node online", nodes.data.length === 1 && nodes.data[0].online, { nodes: nodes.data, nodeLog: fixture.log() });
const nodeId = nodes.data[0].nodeId;

// ---- worker account (executor=ccr_worker, pinned to the node) ----
const grp = await admin("POST", "/api/admin/groups", { name: "worker-only" });
const acc = await fixture.createAccount({
  name: "ccr-worker-1", platform: "anthropic", type: "oauth", protocol: "anthropic", baseUrl: MOCK,
  accessToken: "worker-ok", executor: "ccr_worker", nodeId, priority: 0, groupIds: [grp.data.id],
});
check("create ccr_worker account", acc.status === 201 && acc.data.executor === "ccr_worker" && acc.data.route === "node", acc);
const badExec = await admin("POST", "/api/admin/accounts", { name: "x", platform: "openai", type: "apikey", apiKey: "k", executor: "ccr_worker" });
check("executor=ccr_worker rejected for non-oauth-anthropic", badExec.status === 400, badExec);
const wkey = (await consumer("POST", "/api/user/keys", { name: "worker-key", groupId: grp.data.id })).data.key;
const lastUsage = async () => (await admin("GET", "/api/admin/usage?pageSize=1")).data.items[0];

// ---- non-CC client -> worker mode ----
let r = await messages(wkey, { messages: longMsg() });
let j = JSON.parse(r.text);
check("messages via worker", r.status === 200 && j.content?.[0]?.text === "Hello from fake claude." && /^msg_[A-Za-z0-9_-]+$/.test(j.id ?? ""), r.text);
// X-51 (official cache presentation, ccr_cache_write_as_input default 0): the identity cache baseline is excluded and the
// 1200 cache-creation tokens are reported as cache creation, no longer folded into input (was: input 1212, cache
// creation 0). The fake's result carries only the total (modelUsage), so the split falls to the 5-minute tier.
check("worker usage from result.modelUsage (official cache presentation)", j.usage?.input_tokens === 12 && j.usage?.output_tokens === 7 && j.usage?.cache_read_input_tokens === 17125 && j.usage?.cache_creation_input_tokens === 1200 && j.usage?.cache_creation?.ephemeral_5m_input_tokens === 1200 && j.usage?.cache_creation?.ephemeral_1h_input_tokens === 0, j.usage);
let u = await lastUsage();
check("billed on the worker account", u.accountName === "ccr-worker-1" && u.actualCost > 0 && u.inputTokens === 12 && u.cacheReadTokens === 17125 && u.cacheWriteTokens === 1200 && u.cacheWrite5mTokens === 1200 && u.cacheWrite1hTokens === 0 && u.usageEstimated === false, u);
{
  // X-57: the same prompt without cache_control — the caller did not ask for caching, the write is plain input
  const pr = await messages(wkey, { messages: plainLongMsg() });
  const pj = JSON.parse(pr.text);
  check("no cache_control -> cache write stays input (X-57)", pr.status === 200 && pj.usage?.cache_creation_input_tokens === 0 && pj.usage?.input_tokens === 1212 && pj.usage?.cache_read_input_tokens === 17125, pj.usage);
}

r = await messages(wkey, { stream: true });
check("stream via worker", r.status === 200 && r.text.includes("event: message_start") && r.text.includes("Hello from fake claude.") && r.text.includes("event: message_stop") && r.text.includes('"output_tokens":7'), r.text.slice(0, 400));

// X-54: a one-sentence request shows the customer's own prompt, not Claude Code's prefix: the visible prompt total
// (input + cache read + cache creation) is capped at 6 × the local estimate + 64 tokens (was 18337 here), in the
// response and on the usage row alike; the sample it yields shows up in the admin overhead view under the turn's key
// (legacy lane, no caller tools, upstream model, the node's Claude Code version).
r = await messages(wkey);
j = JSON.parse(r.text);
{
  const vis = (j.usage?.input_tokens ?? 0) + (j.usage?.cache_read_input_tokens ?? 0) + (j.usage?.cache_creation_input_tokens ?? 0);
  u = await lastUsage();
  check("one-sentence request via worker: visible prompt is the customer's own (X-54 small-turn cap)", r.status === 200 && vis >= 1 && vis <= 400 && j.usage?.output_tokens === 7 && u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens === vis && u.actualCost > 0, { usage: j.usage, u });
  const ov = await admin("GET", "/api/admin/ccr-overhead");
  const k = ov.data?.keys?.find((x) => x.key === "legacy|none|claude-sonnet-5|2.1.300");
  check("overhead calibration sample recorded under lane|tools|model|version (admin view)", ov.status === 200 && ov.data.calibration === "on" && !!k && k.samples >= 1 && k.min > 30000 && k.source === "baseline", ov.data);
  check("overhead view is admin-only", (await consumer("GET", "/api/admin/ccr-overhead")).status === 403);
}

r = await post(wkey, "/v1/chat/completions", { model: "claude-sonnet-5", messages: longMsg() });
j = JSON.parse(r.text);
// OpenAI prompt_tokens = every billed prompt token: 12 input + 17125 cache read + 1200 cache creation (unchanged by X-51).
check("chat via worker (ccr-chat)", r.status === 200 && j.choices?.[0]?.message?.content === "Hello from fake claude." && j.usage?.prompt_tokens === 18337 && j.usage?.prompt_tokens_details?.cached_tokens === 17125, r.text);

// tools: prompt-level simulation, identical to cloud mode
r = await post(wkey, "/v1/chat/completions", { model: "claude-sonnet-5", messages: [{ role: "user", content: `worker ${uniq()}` }], tools: [{ type: "function", function: { name: "get_weather", description: "w", parameters: { type: "object", properties: { city: { type: "string" } } } } }] });
j = JSON.parse(r.text);
check("worker tools -> tool_calls", j.choices?.[0]?.finish_reason === "tool_calls" && j.choices[0].message.tool_calls?.[0]?.function?.name === "get_weather", r.text);

// Missing stable IDs and a UA-only claim still complete. This also catches a
// fast worker's open_response/stdout/close arriving together in one socket read.
r = await messages(wkey, {}, { "user-agent": "claude-cli/2.1.300 (external, cli)" });
j = JSON.parse(r.text);
check("UA-only request without stable ID completes through worker", r.status === 200 && j.content?.[0]?.text === "Hello from fake claude.", r.text);

// ---- genuine CC client -> direct mode (§5.2 R1), never the worker ----
const cc = genuineCcRequest({ messages: [{ role: "user", content: `worker-direct ${uniq()}` }] });
r = await post(wkey, "/v1/messages", cc.body, cc.headers);
j = JSON.parse(r.text);
check("genuine CC shape -> direct mode (mock messages, not the worker)", r.status === 200 && j.id === "msg_mock", r.text);
u = await lastUsage();
check("direct leg billed on the same account", u.accountName === "ccr-worker-1", u);

// Request-scoped worker failures must not inherit a transport scope in the ledger.
r = await messages(wkey, { messages: [{ role: "user", content: "fixture-safeguards-refusal" }] });
u = await lastUsage();
check("non-stream safeguards refusal is request-scoped and non-retryable", r.status === 400 && u.errorCode === "safeguards_refusal" && u.errorScope === "request" && u.retryable === false, { r, u });

// ---- X-55: a refused admission names its reason and leaves a usage row ----
{
  const me = (await admin("GET", "/api/admin/users?role=consumer&pageSize=50")).data.items.find((x) => x.name === "demo-consumer");
  const setCap = (maxInflight) => admin("PATCH", `/api/admin/users/${me.id}`, { maxInflight });
  check("set per-user concurrency cap to 1", (await setCap(1)).status === 200);
  const burst = await Promise.all(Array.from({ length: 5 }, () => messages(wkey)));
  const refused = burst.filter((x) => x.status === 429).map((x) => JSON.parse(x.text));
  const code = (e) => e.error?.code ?? e.error?.type;
  check("concurrent requests over the cap -> 429 user_inflight_limit that names the reason", burst.some((x) => x.status === 200) && refused.length >= 1 && refused.every((e) => JSON.stringify(e).includes("user_inflight_limit") && /already in flight and your limit is 1 concurrent requests/.test(e.error?.message ?? "")), burst.map((x) => [x.status, x.text.slice(0, 200)]));
  const rows = (await admin("GET", "/api/admin/usage?pageSize=10")).data.items.filter((x) => x.errorCode === "user_inflight_limit");
  check("refused admission leaves a zero-cost usage row with the reason", rows.length === refused.length && rows.every((x) => x.statusCode === 429 && x.actualCost === 0 && /^concurrency_cap: .*\[in_flight=1\/1 /.test(x.errorMessage ?? "")), rows.slice(0, 2));
  check("clear the per-user concurrency cap", (await setCap(null)).status === 200);
}

// ---- X-69: the client leaves before the first byte; the same request sent again takes over the turn it left ----
{
  const send = (content, stream, signal) => fetch(G + "/v1/messages", { method: "POST", headers: { authorization: `Bearer ${wkey}`, "content-type": "application/json" }, body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 64, stream, messages: [{ role: "user", content }] }), signal });
  const spawns = (marker) => fixture.log().split(marker).length - 1;
  for (const stream of [true, false]) {
    const marker = `fixture-slow-first:1500 ${uniq()}`;
    const before = (await admin("GET", "/api/admin/usage?pageSize=1")).data.total;
    const gone = new AbortController();
    const first = send(marker, stream, gone.signal).then((x) => x.text()).catch((e) => e.name);
    await new Promise((r2) => setTimeout(r2, 500));
    gone.abort();
    const firstOutcome = await first;
    const started = Date.now();
    const again = await send(marker, stream, AbortSignal.timeout(30_000));
    const text = await again.text();
    const took = Date.now() - started;
    u = await lastUsage();
    const total = (await admin("GET", "/api/admin/usage?pageSize=1")).data.total;
    check(`${stream ? "stream" : "non-stream"}: the retry of a request whose client left is answered by the turn already running`, firstOutcome === "AbortError" && again.status === 200 && text.includes("Hello from fake claude.") && took < 1400 && u.statusCode === 200 && u.actualCost > 0 && total === before + 2, { firstOutcome, status: again.status, took, u: { statusCode: u.statusCode, actualCost: u.actualCost }, rows: total - before, text: text.slice(0, 300) });
  }
}

// ---- X-68: a login that is gone before any output ----
{
  const acc2 = await fixture.createAccount({
    name: "ccr-worker-2", platform: "anthropic", type: "oauth", protocol: "anthropic", baseUrl: MOCK,
    accessToken: "worker-ok", executor: "ccr_worker", nodeId, priority: 0, groupIds: [grp.data.id],
  });
  check("second worker account", acc2.status === 201, acc2);
  const stream = (content) => messages(wkey, { stream: true, messages: [{ role: "user", content }] });
  r = await stream(`fixture-login-expired-once:${uniq()}`);
  check("stream: login gone on the first account -> answered by the other, Claude Code's sentence never forwarded", r.status === 200 && r.text.includes("Hello from fake claude.") && r.text.includes("event: message_stop") && !r.text.includes("Login expired") && !r.text.includes("event: error"), r.text.slice(0, 600));
  r = await stream("fixture-login-expired-always");
  u = await lastUsage();
  check("stream: login gone everywhere -> an error event, no answer text, no 'partial output'", !r.text.includes("text_delta") && !r.text.includes("message_start") && r.text.includes("event: error") && !r.text.includes("partial output") && u.statusCode >= 500, { text: r.text.slice(0, 600), u });
}

// ---- node deploy_meta carries ccWorker telemetry (from fake-node heartbeats) ----
await new Promise((r2) => setTimeout(r2, 1200));
const nodeRow = (await admin("GET", "/api/admin/nodes")).data.find((n) => n.nodeId === nodeId);
check("heartbeat ccWorker -> deploy_meta", nodeRow?.deployMeta?.ccWorker?.enabled === true && nodeRow.deployMeta.ccWorker.claudeVersion === "2.1.300 (fake)", nodeRow?.deployMeta);

// ---- node down -> 503 (no infra fallback to direct) ----
await fixture.stop();
await new Promise((r2) => setTimeout(r2, 800));
r = await messages(wkey);
check("node offline -> 503", r.status === 503, r.text.slice(0, 200));

console.log(fails ? `WORKER: ${fails} FAILED` : "WORKER: ALL PASSED");
process.exit(fails ? 1 : 0);
