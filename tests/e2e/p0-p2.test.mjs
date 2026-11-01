import { createTeamFixture } from "./team-fixture.mjs";
import { readFileSync } from "node:fs";
const seed = readFileSync(process.argv[2], "utf8");
const pick = (label) => seed.split("\n").find((l) => l.startsWith(label)).split(":")[1].trim().split(" ")[0];
const C = `http://127.0.0.1:${process.env.E2E_CONSOLE_PORT ?? 18401}`, G = `http://127.0.0.1:${process.env.E2E_GATEWAY_PORT ?? 18400}`;
const MOCK = `http://127.0.0.1:${process.env.E2E_MOCK_PORT ?? 19101}`;
let fails = 0, seq = 0;
const check = (name, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"} ${name} ${cond ? "" : JSON.stringify(extra).slice(0, 600)}`); if (!cond) fails++; };
async function session(key) {
  const r = await fetch(C + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key }) });
  const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
  return async (method, path, body) => {
    const res = await fetch(C + path, { method, headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, ...(await res.json().catch(() => ({}))) };
  };
}
const admin = await session(pick("admin    login key"));
const key = pick("consumer API key");
const fixture = await createTeamFixture({ admin, providerKey: pick("provider login key"), consoleBase: C, upstreamBase: MOCK });
const create = (data) => fixture.createAccount(data);
const accounts = async () => (await admin("GET", "/api/admin/accounts?pageSize=100")).data.items;
const usage = async () => (await admin("GET", "/api/admin/usage?pageSize=1")).data.items[0];
async function messages(extra = {}) {
  const r = await fetch(G + "/v1/messages", { method: "POST", headers: { "x-api-key": key, "content-type": "application/json" }, body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 32, messages: [{ role: "user", content: `p0-p2 unique ${Date.now()} ${seq++}` }], ...extra }) });
  return { status: r.status, text: await r.text() };
}
try {
  const request = await create({ name: "p0-request-429", platform: "anthropic", type: "oauth", baseUrl: MOCK, accessToken: "mock-request-429", priority: 0, groupIds: ["default"] });
  const healthy = await create({ name: "p0-healthy", platform: "anthropic", type: "oauth", baseUrl: MOCK, accessToken: "mock-healthy", priority: 1, groupIds: ["default"] });

  const profile = await admin("POST", `/api/admin/accounts/${healthy.data.id}/test`, {});
  check("default account test is profile+roles, not inference", profile.status === 200 && profile.data.ok && profile.data.validation === "profile" && profile.data.roles.organizationRole === "member", profile);
  let row = (await accounts()).find((a) => a.id === healthy.data.id);
  check("profile validation records readiness", row.readiness === "profile_valid" && !!row.lastProfileAt, row);
  const inference = await admin("POST", `/api/admin/accounts/${healthy.data.id}/test`, { mode: "inference" });
  row = (await accounts()).find((a) => a.id === healthy.data.id);
  check("explicit minimal inference is separate and recorded", inference.status === 200 && inference.data.ok && inference.data.validation === "inference" && row.readiness === "inference_valid" && !!row.lastInferenceAt, { inference, row });

  let r = await messages();
  row = (await accounts()).find((a) => a.id === request.data.id);
  let u = await usage();
  check("request-scoped 429 returns once without account cooldown", r.status === 429 && r.text.includes("upstream_request_rejected") && !row.rateLimitedUntil && Object.keys(row.modelCooldowns).length === 0, { r, row });
  check("request error carries scope/version/sequence", u.errorScope === "request" && u.retryable === false && u.credentialVersion === 1 && u.executionSequence === 1, u);
  await admin("PATCH", `/api/admin/accounts/${request.data.id}`, { status: "disabled" });

  const model = await create({ name: "p0-model-429", platform: "anthropic", type: "oauth", baseUrl: MOCK, accessToken: "mock-model-429", priority: 0, groupIds: ["default"] });
  r = await messages();
  row = (await accounts()).find((a) => a.id === model.data.id);
  check("model-scoped 429 fails over and cools only that model", r.status === 200 && !!row.modelCooldowns["model:claude-sonnet-5"] && !row.rateLimitedUntil, { r, row });
  await admin("PATCH", `/api/admin/accounts/${model.data.id}`, { status: "disabled" });

  const ordinary = await create({ name: "p0-account-429", platform: "anthropic", type: "oauth", baseUrl: MOCK, accessToken: "mock-429", priority: 0, groupIds: ["default"] });
  r = await messages();
  row = (await accounts()).find((a) => a.id === ordinary.data.id);
  u = await usage();
  check("ordinary account 429 retains account cooldown and failover", r.status === 200 && !!row.rateLimitedUntil && u.accountName === "p0-healthy", { r, row, u });
  check("successful usage records actual model and selection/execution", u.actualModel === "claude-sonnet-5" && u.selectionMs >= 0 && u.executionSequence === 2 && u.credentialVersion === 1, u);

  r = await messages({ tools: [{ name: "get_weather", input_schema: { type: "object", properties: { city: { type: "string" } } } }] });
  u = await usage();
  check("usage records streamed tool calls; request tool results are unit-tested separately", r.status === 200 && u.toolCalls === 1 && u.toolResults === 0, { r, u });

  const count = await fetch(G + "/v1/messages/count_tokens", { method: "POST", headers: { "x-api-key": key, "content-type": "application/json" }, body: JSON.stringify({ model: "claude-sonnet-5", messages: [{ role: "user", content: `count ${Date.now()}` }], tools: [{ type: "web_search_20250305", name: "web_search" }] }) });
  check("count_tokens handles server-tool shape locally", count.status === 200 && (await count.json()).input_tokens > 0, count.status);

  const stream = await create({ name: "p0-stream-error", platform: "anthropic", type: "oauth", baseUrl: MOCK, accessToken: "mock-stream-error", priority: 0, groupIds: ["default"] });
  r = await messages({ stream: true });
  u = await usage();
  check("mid-stream failure is marked truncated transport failure", r.status === 200 && u.streamTruncated === true && u.errorScope === "transport" && u.statusCode === 502, { r, u, stream: stream.data.id });
} finally {
  await fixture.stop();
}
console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exit(fails ? 1 : 0);
