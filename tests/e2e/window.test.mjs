// Subscription-window logic ported from sub2api (docs/gateway.md §3):
// passive sampling of anthropic-ratelimit-unified-* headers, 429 cooldown to
// the rejected window's reset, threshold pause, on-demand probe, sticky
// sessions keyed by the client's session id.
import { createTeamFixture } from "./team-fixture.mjs";
import { readFileSync } from "node:fs";
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
let seq = 0;
const admin = await session(pick("admin    login key"));
const key = pick("consumer API key");
const messages = async (extra = {}) => {
  const r = await fetch(G + "/v1/messages", { method: "POST", headers: { "x-api-key": key, "content-type": "application/json" }, body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 20, messages: [{ role: "user", content: `win ${Date.now()} ${seq++}` }], ...extra }) });
  return { status: r.status, text: await r.text() };
};
const accounts = async () => (await admin("GET", "/api/admin/accounts?pageSize=100")).data.items;
const lastUsage = async () => (await admin("GET", "/api/admin/usage?pageSize=1")).data.items[0];
const hoursFromNow = (iso) => (new Date(iso).getTime() - Date.now()) / 3_600_000;

const fixture=await createTeamFixture({admin,providerKey:pick("provider login key"),consoleBase:C,upstreamBase:MOCK});
const createAccount=(data)=>fixture.createAccount(data);

// Direct subscription account in front of the seeded apikey accounts.
const sub = await createAccount({ name: "sub-a", platform: "anthropic", type: "oauth", baseUrl: MOCK, accessToken: "oauth-a", priority: 0, groupIds: ["default"] });
check("create subscription account", sub.status === 201 && sub.data.windowUsed === null, sub);

let r = await messages();
let u = await lastUsage();
check("served by subscription account", r.status === 200 && u.accountName === "sub-a", { status: r.status, u });
let a = (await accounts()).find((x) => x.name === "sub-a");
check("passive sampling from response headers", a.windowUsed === 0.42 && a.window5hUsed === 0.42 && a.window7dUsed === 0.1 && !!a.windowResetAt && !!a.windowCheckedAt, a);
check("below threshold -> no cooldown", a.windowExhaustedUntil === null && a.windowReason === null, a);

// The upstream 5h reset is ~2h away. Scheduling resumes after its configured rest period, never at Retry-After.
const full = await createAccount({ name: "sub-429", platform: "anthropic", type: "oauth", baseUrl: MOCK, accessToken: "mock-window-429", priority: 0, groupIds: ["default"] });
await admin("PATCH", `/api/admin/accounts/${sub.data.id}`, { priority: 10 });
r = await messages();
u = await lastUsage();
const f = (await accounts()).find((x) => x.id === full.data.id);
const windowSettings=(await admin("GET","/api/admin/settings")).data;
const restSeconds=(new Date(f.rateLimitedUntil)-new Date(f.window5hResetAt))/1000;
check("429 window -> failover + reset plus configured rest",r.status===200 && u.accountName==="sub-a" &&
  hoursFromNow(f.window5hResetAt)>1.9 && hoursFromNow(f.window5hResetAt)<2.1 &&
  restSeconds>=Number(windowSettings.window_rest_min_sec)-1 && restSeconds<=Number(windowSettings.window_rest_max_sec)+1,
  {account:u.accountName,rateLimitedUntil:f.rateLimitedUntil,window5hResetAt:f.window5hResetAt,restSeconds});
check("window reason records rejected 5h window",/five_hour.*rejected \(429\)/.test(f.windowReason??"") && f.window5hUsed===1,
  {reason:f.windowReason,window5hUsed:f.window5hUsed});

// Threshold pause: lower the threshold below the sampled 42% -> next sample pauses the account until reset.
let st = await admin("PUT", "/api/admin/settings", { anthropic_window_threshold_percent: "40" });
check("settings accept window keys", st.status === 200 && st.data.anthropic_window_threshold_percent === "40", st);
r = await messages();
u = await lastUsage();
a = (await accounts()).find((x) => x.name === "sub-a");
check("over threshold -> skipped, falls through to apikey account", r.status === 200 && u.accountName === "mock-anthropic", u);
check("pause recorded with reason until window reset", hoursFromNow(a.windowExhaustedUntil) > 2.5 && /42% ≥ 40%/.test(a.windowReason ?? ""), a);
await admin("PUT", "/api/admin/settings", { anthropic_window_threshold_percent: "95" });
const re = await admin("PATCH", `/api/admin/accounts/${sub.data.id}`, { status: "active" });
check("re-enable clears window cooldown + reason", re.data.windowExhaustedUntil === null && re.data.windowReason === null, re.data);

// On-demand probe (GET /api/oauth/usage) for any Anthropic OAuth account.
const probe = await admin("POST", `/api/admin/accounts/${sub.data.id}/window`);
check("usage probe on direct oauth account", probe.status === 200 && probe.data.windowUsed === 0.125 && probe.data.window5hUsed === 0.125, probe);
const apikeyAcc = (await accounts()).find((x) => x.name === "mock-anthropic");
const bad = await admin("POST", `/api/admin/accounts/${apikeyAcc.id}/window`);
check("usage probe on apikey account -> 400", bad.status === 400, bad);

// Sticky sessions: same client session id -> same account across requests, even with equal priority.
const subB = await createAccount({ name: "sub-b", platform: "anthropic", type: "oauth", baseUrl: MOCK, accessToken: "oauth-b", priority: 10, groupIds: ["default"] });
await admin("PATCH", `/api/admin/accounts/${apikeyAcc.id}`, { status: "disabled" });
const sid=crypto.randomUUID();
const sessionMeta=(id)=>({user_id:JSON.stringify({device_id:"f".repeat(64),session_id:id})});
const served=[];
const history=[{role:"user",content:`sticky root ${crypto.randomUUID()}`}];
for(let i=0;i<5;i++){
  r=await messages({metadata:sessionMeta(sid),messages:history});
  served.push((await lastUsage()).accountName);
  history.push({role:"assistant",content:"Hello from mock upstream."},{role:"user",content:`follow up ${i}`});
}
check("same session and expanding history stay on one account",r.status===200 && new Set(served).size===1,served);
const other=crypto.randomUUID();
const served2=[];
const otherHistory=[{role:"user",content:`other root ${crypto.randomUUID()}`}];
for(let i=0;i<4;i++){
  r=await messages({metadata:sessionMeta(other),messages:otherHistory});
  served2.push((await lastUsage()).accountName);
  otherHistory.push({role:"assistant",content:"Hello from mock upstream."},{role:"user",content:`other follow up ${i}`});
}
check("another independent session also sticks",r.status===200 && new Set(served2).size===1,served2);
await admin("PATCH", `/api/admin/accounts/${apikeyAcc.id}`, { status: "active" });
await admin("DELETE", `/api/admin/accounts/${subB.data.id}`);

await fixture.stop();
console.log(fails ? `WINDOW: ${fails} FAILED` : "WINDOW: ALL PASSED");
process.exit(fails ? 1 : 0);
