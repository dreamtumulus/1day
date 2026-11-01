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
let r = await messages(wkey);
let j = JSON.parse(r.text);
check("messages via worker", r.status === 200 && j.content?.[0]?.text === "Hello from fake claude." && /^msg_[A-Za-z0-9_-]+$/.test(j.id ?? ""), r.text);
// Default billing folds 1200 cache-write tokens into input; identity cache baseline is excluded.
check("worker usage from result.modelUsage (default cache-write-as-input)", j.usage?.input_tokens === 1212 && j.usage?.output_tokens === 7 && j.usage?.cache_read_input_tokens === 17125 && j.usage?.cache_creation_input_tokens === 0, j.usage);
let u = await lastUsage();
check("billed on the worker account", u.accountName === "ccr-worker-1" && u.actualCost > 0 && u.inputTokens === 1212 && u.cacheReadTokens === 17125 && u.cacheWriteTokens === 0 && u.usageEstimated === false, u);

r = await messages(wkey, { stream: true });
check("stream via worker", r.status === 200 && r.text.includes("event: message_start") && r.text.includes("Hello from fake claude.") && r.text.includes("event: message_stop") && r.text.includes('"output_tokens":7'), r.text.slice(0, 400));

r = await post(wkey, "/v1/chat/completions", { model: "claude-sonnet-5", messages: [{ role: "user", content: `worker ${uniq()}` }] });
j = JSON.parse(r.text);
// OpenAI prompt_tokens includes cached tokens: 1212 input + 17125 cache read.
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
