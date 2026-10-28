// Billing on upstream failures that arrive inside a 200 (docs/gateway.md §5 / errors.md):
// a stream that ends in an upstream error event and a non-stream body cut
// mid-way must NOT be charged, must write a 502 usage row and must cool the
// account; the client must see an error in its own dialect, never a clean end.
import { readFileSync } from "node:fs";
const seed = readFileSync(process.argv[2], "utf8");
const pick = (label) => seed.split("\n").find((l) => l.startsWith(label)).split(":")[1].trim().split(" ")[0];
const C = `http://127.0.0.1:${process.env.E2E_CONSOLE_PORT ?? 18401}`, G = `http://127.0.0.1:${process.env.E2E_GATEWAY_PORT ?? 18400}`;
const MOCK = process.env.E2E_MOCK ?? `http://127.0.0.1:${process.env.E2E_MOCK_PORT ?? 19101}`;
let fails = 0;
const check = (name, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"} ${name} ${cond ? "" : JSON.stringify(extra).slice(0, 500)}`); if (!cond) fails++; };
async function session(key) {
  const r = await fetch(C + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key }) });
  const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
  return async (method, path, body) => {
    const res = await fetch(C + path, { method, headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, ...(await res.json().catch(() => ({}))) };
  };
}
const admin = await session(pick("admin    login key"));
const KEY = pick("consumer API key");
let seq = 0;
const call = async (path, body) => {
  const r = await fetch(G + path, { method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, text: await r.text() };
};
const lastUsage = async () => (await admin("GET", "/api/admin/usage?pageSize=1")).data.items[0];
const account = async (id) => (await admin("GET", `/api/admin/accounts?pageSize=100`)).data.items.find((a) => a.id === id);
const balance = async () => (await admin("GET", "/api/admin/users?role=consumer&pageSize=50")).data.items.find((u) => u.name === "demo-consumer").balanceUsd;
const user = (n) => [{ role: "user", content: `billing ${Date.now()} ${seq++} ${n}` }];

// Park the seeded accounts so our failure accounts are the only candidates.
const seeded = (await admin("GET", "/api/admin/accounts?pageSize=100")).data.items;
for (const a of seeded) await admin("PATCH", `/api/admin/accounts/${a.id}`, { status: "disabled" });

const errA = await admin("POST", "/api/admin/accounts", { name: "stream-err-anthropic", platform: "anthropic", type: "upstream", protocol: "anthropic", baseUrl: MOCK, apiKey: "mock-stream-error", priority: 0, groupIds: ["default"] });
const errO = await admin("POST", "/api/admin/accounts", { name: "stream-err-openai", platform: "openai", type: "upstream", protocol: "openai", baseUrl: MOCK + "/v1", apiKey: "mock-stream-error", priority: 0, groupIds: ["default"] });
const cut = await admin("POST", "/api/admin/accounts", { name: "body-cut", platform: "anthropic", type: "upstream", protocol: "anthropic", baseUrl: MOCK, apiKey: "mock-body-cut", priority: 0, groupIds: ["default"] });
check("accounts created", errA.status === 201 && errO.status === 201 && cut.status === 201, { errA, errO, cut });
// one candidate at a time
await admin("PATCH", `/api/admin/accounts/${errO.data.id}`, { status: "disabled" });
await admin("PATCH", `/api/admin/accounts/${cut.data.id}`, { status: "disabled" });

const b0 = await balance();

// 1. Anthropic passthrough stream ending in `event: error`
let r = await call("/v1/messages", { model: "claude-sonnet-5", max_tokens: 20, stream: true, messages: user(1) });
check("anthropic stream: error event forwarded, no message_stop", r.status === 200 && r.text.includes("event: error") && r.text.includes("overloaded mid-stream") && !r.text.includes("message_stop"), r.text);
let u = await lastUsage();
check("anthropic stream: 502 row, zero cost", u.statusCode === 502 && u.errorCode === "upstream_stream_error" && u.actualCost === 0 && u.accountName === "stream-err-anthropic", u);
let a = await account(errA.data.id);
check("anthropic stream: account cooling", !!a.coolingUntil, a);

// 2. chat-via-anthropic stream (converter) must surface the error in OpenAI dialect, no [DONE]
await admin("PATCH", `/api/admin/accounts/${errA.data.id}`, { status: "active" }); // clears the cooldown
r = await call("/v1/chat/completions", { model: "claude-sonnet-5", stream: true, messages: user(2) });
check("chat-via-anthropic stream: {error} chunk, no [DONE]", r.status === 200 && r.text.includes('"error"') && r.text.includes("overloaded mid-stream") && !r.text.includes("[DONE]"), r.text);
u = await lastUsage();
check("chat-via-anthropic stream: 502 row, zero cost", u.statusCode === 502 && u.actualCost === 0, u);

// 3. anthropic-via-chat + passthrough-openai: OpenAI {error} chunk
await admin("PATCH", `/api/admin/accounts/${errA.data.id}`, { status: "disabled" });
await admin("PATCH", `/api/admin/accounts/${errO.data.id}`, { status: "active" });
r = await call("/v1/messages", { model: "gpt-5.5", max_tokens: 20, stream: true, messages: user(3) });
check("anthropic-via-chat stream: event: error, no message_stop", r.status === 200 && r.text.includes("event: error") && r.text.includes("failed mid-stream") && !r.text.includes("message_stop"), r.text);
u = await lastUsage();
check("anthropic-via-chat stream: 502 row, zero cost", u.statusCode === 502 && u.actualCost === 0, u);
await admin("PATCH", `/api/admin/accounts/${errO.data.id}`, { status: "active" });
r = await call("/v1/chat/completions", { model: "gpt-5.5", stream: true, messages: user(4) });
check("openai passthrough stream: error chunk, no [DONE]", r.status === 200 && r.text.includes("failed mid-stream") && !r.text.includes("[DONE]"), r.text);
u = await lastUsage();
check("openai passthrough stream: 502 row, zero cost", u.statusCode === 502 && u.actualCost === 0, u);

// 4. non-stream body cut: 502 + usage row (not an unlogged 500)
await admin("PATCH", `/api/admin/accounts/${errO.data.id}`, { status: "disabled" });
await admin("PATCH", `/api/admin/accounts/${cut.data.id}`, { status: "active" });
r = await call("/v1/messages", { model: "claude-sonnet-5", max_tokens: 20, messages: user(5) });
check("body cut: 502 upstream_error", r.status === 502 && r.text.includes("upstream_error"), r.text);
u = await lastUsage();
check("body cut: 502 row, zero cost, account recorded", u.statusCode === 502 && u.actualCost === 0 && u.accountName === "body-cut", u);
a = await account(cut.data.id);
check("body cut: account cooling", !!a.coolingUntil, a);

check("balance unchanged by failed requests", Math.abs((await balance()) - b0) < 1e-12, { b0, b1: await balance() });

// 5. A stream that completes normally must settle. Regression: 144faa3 (2026-10-17) put the
// completed case in its own branch ahead of settleSuccess and every finished stream went unbilled.
for (const acc of [errA, errO, cut]) await admin("PATCH", `/api/admin/accounts/${acc.data.id}`, { status: "disabled" });
const healthy = seeded.find((a) => a.platform === "anthropic");
await admin("PATCH", `/api/admin/accounts/${healthy.id}`, { status: "active" });
const b2 = await balance();
r = await call("/v1/messages", { model: "claude-sonnet-5", max_tokens: 20, stream: true, messages: user(6) });
check("completed stream: 200 ending in message_stop", r.status === 200 && r.text.includes("event: message_stop"), r.text.slice(-300));
u = await lastUsage();
check("completed stream: settled as a 200 stream row with output tokens and a charge", u.statusCode === 200 && (u.stream === true || u.stream === 1) && u.outputTokens > 0 && u.actualCost > 0, u);
check("completed stream: balance charged", (await balance()) < b2, { b2, b3: await balance() });

console.log(fails ? `BILLING: ${fails} FAILED` : "BILLING: ALL PASSED");
process.exit(fails ? 1 : 0);
