// Cloud session supply (CCR, docs/ccr-supply.md): executor=ccr accounts served
// through the gateway translation layer against the mock session API, plus
// subscription-window scheduling. Mock event shape is provisional (Appendix A).
import { createTeamFixture, genuineCcRequest } from "./team-fixture.mjs";
import { readFileSync } from "node:fs";
const seed = readFileSync(process.argv[2], "utf8");
const pick = (label) => seed.split("\n").find((l) => l.startsWith(label)).split(":")[1].trim().split(" ")[0];
const C = `http://127.0.0.1:${process.env.E2E_CONSOLE_PORT ?? 18401}`, G = `http://127.0.0.1:${process.env.E2E_GATEWAY_PORT ?? 18400}`;
const MOCK = `http://127.0.0.1:${process.env.E2E_MOCK_PORT ?? 19101}`;
let fails = 0;
const check = (name, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"} ${name} ${cond ? "" : JSON.stringify(extra).slice(0, 600)}`); if (!cond) fails++; };
async function session(key) {
  const r = await fetch(C + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key }) });
  const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
  const call = async (method, path, body) => {
    const res = await fetch(C + path, { method, headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const j = await res.json().catch(() => ({}));
    return { status: res.status, ...j };
  };
  return { status: r.status, call };
}
let seq = 0;
const uniq = () => `${Date.now()}-${seq++}`;
const post = async (key, path, body, headers = {}) => {
  const r = await fetch(G + path, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: r.status, text: await r.text() };
};
const CC_UA = { "user-agent": "claude-cli/2.1.300 (external, cli)" };
const messages = (key, extra = {}) => post(key, "/v1/messages", { model: "claude-sonnet-5", max_tokens: 64, messages: [{ role: "user", content: `ccr ${uniq()}` }], ...extra });
const chat = (key, extra = {}) => post(key, "/v1/chat/completions", { model: "claude-sonnet-5", messages: [{ role: "user", content: `ccr ${uniq()}` }], ...extra });
const tools = [{ type: "function", function: { name: "get_weather", description: "w", parameters: { type: "object", properties: { city: { type: "string" } } } } }];
const lastUsage = async (admin) => (await admin.call("GET", "/api/admin/usage?pageSize=1")).data.items[0];

const admin = await session(pick("admin    login key"));
const consumer = await session(pick("consumer login key"));
check("logins", admin.status === 200 && consumer.status === 200);
const keys = await consumer.call("GET", "/api/user/keys");
const demoKey = (await consumer.call("POST", `/api/user/keys/${keys.data.find((k) => k.name === "demo").id}/reveal`)).data.key;

const fixture=await createTeamFixture({admin:admin.call,providerKey:pick("provider login key"),consoleBase:C,upstreamBase:MOCK});
const createAccount=(data)=>fixture.createAccount(data);

// ---- account with executor=ccr (environment provisioned lazily by the gateway) ----
const acc = await createAccount({
  name: "ccr-mock", platform: "anthropic", type: "oauth", protocol: "anthropic", baseUrl: MOCK,
  accessToken: "ccr-ok", orgUuid: fixture.orgUuid, executor: "ccr", priority: 0, groupIds: ["default"],
});
check("create ccr account", acc.status === 201 && acc.data.executor === "ccr" && acc.data.windowUsed === null, acc);
const badExec = await admin.call("POST", "/api/admin/accounts", { name: "x", platform: "openai", type: "apikey", apiKey: "k", executor: "ccr" });
check("executor=ccr rejected for non-oauth-anthropic", badExec.status === 400, badExec);

// ---- Messages API, non-stream ----
let r = await messages(demoKey);
let j = JSON.parse(r.text);
check("messages via ccr", r.status === 200 && j.content?.[0]?.text === "Hello from mock upstream." && j.model === "claude-sonnet-5" && j.id.startsWith("msg_") && j.id!=="msg_mock", r.text);
// Cloud defaults remove the 28000-token identity baseline and count cache creation as input: 10+1200 input, 5725 reads, zero writes.
check("usage from session events (cache minus identity baseline)", j.usage?.input_tokens === 1210 && j.usage?.output_tokens === 6 && j.usage?.cache_read_input_tokens === 5725 && j.usage?.cache_creation_input_tokens === 0, j.usage);
let u = await lastUsage(admin);
check("served by ccr account and billed", u.accountName === "ccr-mock" && u.actualCost > 0 && u.inputTokens === 1210 && u.cacheReadTokens === 5725 && u.cacheWriteTokens === 0 && u.mode === "ccr-anthropic" && u.usageEstimated === false, u);

// ---- Messages API, stream ----
r = await messages(demoKey, { stream: true });
check("messages stream via ccr", r.status === 200 && r.text.includes("event: message_start") && r.text.includes('"text":"Hello from "') && r.text.includes('"text":"mock upstream."') && r.text.includes("event: message_stop") && r.text.includes('"output_tokens":6'), r.text);

// ---- Chat Completions (ccr-chat) ----
r = await chat(demoKey);
j = JSON.parse(r.text);
// OpenAI prompt_tokens includes cached tokens: 10 input + 5725 cache read (33725 − 28000 baseline) + 1200 cache creation.
check("chat via ccr", r.status === 200 && j.choices?.[0]?.message?.content === "Hello from mock upstream." && j.usage?.prompt_tokens === 6935 && j.usage?.prompt_tokens_details?.cached_tokens === 5725, r.text);
r = await chat(demoKey, { stream: true });
check("chat stream via ccr", r.status === 200 && r.text.includes('"content":"Hello from "') && r.text.trim().endsWith("data: [DONE]"), r.text);

// ---- simulated tools ----
r = await chat(demoKey, { tools });
j = JSON.parse(r.text);
check("chat tools via ccr -> tool_calls", j.choices?.[0]?.finish_reason === "tool_calls" && j.choices[0].message.tool_calls?.[0]?.function?.name === "get_weather" && JSON.parse(j.choices[0].message.tool_calls[0].function.arguments).city === "Paris", r.text);
r = await messages(demoKey, { tools: [{ name: "get_weather", description: "w", input_schema: { type: "object", properties: { city: { type: "string" } } } }] });
j = JSON.parse(r.text);
check("messages tools via ccr -> tool_use", j.stop_reason === "tool_use" && j.content?.some((b) => b.type === "tool_use" && b.name === "get_weather" && b.input?.city === "Paris"), r.text);
r = await messages(demoKey, { stream: true, tools: [{ name: "get_weather", description: "w", input_schema: { type: "object" } }] });
check("messages stream tools (buffered replay)", r.status === 200 && r.text.includes('"type":"tool_use"') && r.text.includes("event: message_stop"), r.text);

// ---- capability matrix on a ccr-only group ----
const grp = await admin.call("POST", "/api/admin/groups", { name: "ccr-only" });
await admin.call("PATCH", `/api/admin/accounts/${acc.data.id}`, { groupIds: ["default", grp.data.id] });
const ccrKey = (await consumer.call("POST", "/api/user/keys", { name: "ccr-key", groupId: grp.data.id })).data.key;
r = await messages(ccrKey, { messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } }] }] });
check("image -> 400 ccr_unsupported_content", r.status === 400 && r.text.includes("ccr_unsupported_content"), r.text);
r = await messages(ccrKey, { tools: [{ name: "t", input_schema: { type: "object" } }], tool_choice: { type: "any" } });
check("tool_choice any -> 400 ccr_unsupported_tool_choice", r.status === 400 && r.text.includes("ccr_unsupported_tool_choice"), r.text);
r = await post(ccrKey, "/v1/responses", { model: "claude-sonnet-5", input: `ccr ${uniq()}` });
check("responses -> 400 unsupported_endpoint", r.status === 400 && r.text.includes("unsupported_endpoint"), r.text);
const directFallback=await createAccount({name:"ccr-direct-fallback",platform:"anthropic",type:"oauth",baseUrl:MOCK,
  accessToken:"direct-fallback",executor:"direct",priority:100,groupIds:["default"]});
check("same-team direct fallback created",directFallback.status===201,directFallback);
r = await messages(demoKey, { messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } }] }] });
u = await lastUsage(admin);
check("image on mixed group falls through to same-team direct account", r.status === 200 && u.accountName === "ccr-direct-fallback", { status: r.status, u });

// ---- subscription window scheduling ----
const full = await createAccount({
  name: "ccr-full", platform: "anthropic", type: "oauth", protocol: "anthropic", baseUrl: MOCK,
  accessToken: "mock-window-full", orgUuid: fixture.orgUuid, environmentId: "env_mock", executor: "ccr", priority: 0, groupIds: [grp.data.id],
});
await admin.call("PATCH", `/api/admin/accounts/${acc.data.id}`, { priority: 10 });
let w = await admin.call("POST", `/api/admin/accounts/${full.data.id}/window`);
check("window probe: full", w.status === 200 && w.data.windowUsed === 1 && !!w.data.windowExhaustedUntil && !!w.data.windowResetAt && !!w.data.windowCheckedAt, w);
r = await messages(ccrKey);
u = await lastUsage(admin);
check("exhausted window skipped -> next ccr account", r.status === 200 && u.accountName === "ccr-mock", { status: r.status, u });
w = await admin.call("POST", `/api/admin/accounts/${acc.data.id}/window`);
check("window probe: headroom", w.status === 200 && w.data.windowUsed === 0.125 && w.data.windowExhaustedUntil === null, w);
const direct = (await admin.call("GET", "/api/admin/accounts")).data.items.find((a) => a.name === "mock-anthropic");
w = await admin.call("POST", `/api/admin/accounts/${direct.id}/window`);
check("window probe on direct account -> 400", w.status === 400, w);
const reen = await admin.call("PATCH", `/api/admin/accounts/${full.data.id}`, { status: "active" });
check("re-enable clears window cooldown", reen.data?.windowExhaustedUntil === null && reen.data?.windowUsed === 1, reen);
r = await messages(ccrKey);
u = await lastUsage(admin);
check("still skipped by stale full snapshot until reset", u.accountName === "ccr-mock", u);

// ---- failover: session API 401 marks the account error, request still served ----
const bad = await createAccount({
  name: "ccr-401", platform: "anthropic", type: "oauth", protocol: "anthropic", baseUrl: MOCK,
  accessToken: "mock-401", orgUuid: fixture.orgUuid, environmentId: "env_mock", executor: "ccr", priority: 0, groupIds: [grp.data.id],
});
r = await messages(ccrKey);
const badNow = (await admin.call("GET", "/api/admin/accounts")).data.items.find((a) => a.id === bad.data.id);
check("401 on session api -> account error + failover", r.status === 200 && badNow.status === "error", { status: r.status, badNow });

// ---- dual-mode routing (docs/ccr-supply.md §5.2): CC clients take the direct path ----
const dualGrp = await admin.call("POST", "/api/admin/groups", { name: "dual-only" });
const dual = await createAccount({
  name: "ccr-dual", platform: "anthropic", type: "oauth", protocol: "anthropic", baseUrl: MOCK,
  accessToken: "ccr-ok", orgUuid: fixture.orgUuid, environmentId: "env_mock", executor: "ccr", priority: 0, groupIds: [dualGrp.data.id],
});
check("create dual-mode ccr account", dual.status === 201, dual);
const dualKey = (await consumer.call("POST", "/api/user/keys", { name: "dual-key", groupId: dualGrp.data.id })).data.key;

// Genuine CC shape with a stable session takes the account's direct Messages path.
const directSession=crypto.randomUUID();
const directRoot=`dual root ${uniq()}`;
const cc=(messages,extra={})=>genuineCcRequest({sessionId:directSession,messages,max_tokens:64,...extra});
let request=cc([{role:"user",content:directRoot}]);
r=await post(dualKey,"/v1/messages",request.body,request.headers);
j=JSON.parse(r.text);
check("genuine CC + ccr account -> direct mode",r.status===200 && j.id==="msg_mock" && j.content?.[0]?.text==="Hello from mock upstream.",r.text);
u=await lastUsage(admin);
check("genuine direct request billed on ccr account",u.accountName==="ccr-dual" && u.inputTokens===10 && u.ccShape==="genuine" && u.mode==="passthrough-anthropic",u);
request=cc([{role:"user",content:directRoot},{role:"assistant",content:"Hello from mock upstream."},{role:"user",content:"stream continuation"}],{stream:true});
r=await post(dualKey,"/v1/messages",request.body,request.headers);
check("genuine CC stream -> direct SSE",r.status===200 && r.text.includes('"id":"msg_mock"') && r.text.includes("event: message_stop"),r.text.slice(0,300));
request=cc([{role:"user",content:directRoot},{role:"assistant",content:"Hello from mock upstream."},{role:"user",content:"chat continuation"}]);
r=await post(dualKey,"/v1/chat/completions",request.body,request.headers);
j=JSON.parse(r.text);
check("genuine CC chat -> chat-via-anthropic direct",r.status===200 && j.choices?.[0]?.message?.content==="Hello from mock upstream.",r.text);
// A UA by itself remains insufficient; both it and plain HTTP take cloud execution.
r=await post(dualKey,"/v1/messages",{model:"claude-sonnet-5",max_tokens:64,messages:[{role:"user",content:`ua-only ${uniq()}`}]},CC_UA);
u=await lastUsage(admin);
check("UA-only request remains cloud",r.status===200 && u.mode==="ccr-anthropic",{r,u});
r=await messages(dualKey);
j=JSON.parse(r.text);
u=await lastUsage(admin);
check("plain UA + ccr account -> cloud session",r.status===200 && j.id.startsWith("msg_") && j.id!=="msg_mock" && u.mode==="ccr-anthropic",{r,u});
check("cloud request billed on same account",u.accountName==="ccr-dual",u);

// ---- session pool (docs/ccr-supply.md §5.3) ----
const dbg = async () => (await fetch(`${MOCK}/ccr/debug`)).json();
const before = await dbg();
const poolRoot=`pool root ${uniq()}`;
const meta={metadata:{user_id:JSON.stringify({device_id:"a".repeat(64),session_id:crypto.randomUUID()})}};
const poolMsg=(history)=>post(ccrKey,"/v1/messages",{model:"claude-sonnet-5",max_tokens:64,...meta,messages:history});
r=await poolMsg([{role:"user",content:poolRoot}]);
check("pooled request 1 ok",r.status===200,r.text);
r=await poolMsg([{role:"user",content:poolRoot},{role:"assistant",content:"Hello from mock upstream."},{role:"user",content:"second turn on the same root"}]);
check("pooled request 2 ok",r.status===200,r.text);
let after=await dbg();
let fresh=after.sessions.filter(s=>!before.sessions.some(b=>b.id===s.id));
check("same-root history shares one session (set_model once, two user turns)",fresh.length===1 && fresh[0].userEvents===2 && fresh[0].setModelEvents===1,fresh);

// No sticky key -> never reuse (pollution guard); stateless sessions are archived on completion.
const stateless1=await messages(ccrKey);
const stateless2=await messages(ccrKey);
check("both stateless requests succeed",stateless1.status===200 && stateless2.status===200,{stateless1,stateless2});
await new Promise((r2) => setTimeout(r2, 300)); // archive is fire-and-forget
const after2 = await dbg();
const fresh2 = after2.sessions.filter((s) => !after.sessions.some((b) => b.id === s.id));
check("stateless requests create one session each", fresh2.length === 2, fresh2);
check("stateless sessions archived after completion", fresh2.every((s) => s.archived), fresh2);

// Deleting an account retires local handles. It cannot authorize a new tunnel
// merely to archive remotely; the next turn must use another same-team account.
const tmpGroup=await admin.call("POST","/api/admin/groups",{name:"ccr-delete-only"});
const tmp=await createAccount({name:"ccr-pooltmp",platform:"anthropic",type:"oauth",baseUrl:MOCK,
  accessToken:"ccr-ok",executor:"ccr",priority:0,groupIds:[tmpGroup.data.id]});
const fallback=await createAccount({name:"ccr-poolfallback",platform:"anthropic",type:"oauth",baseUrl:MOCK,
  accessToken:"ccr-ok",executor:"ccr",priority:50,groupIds:[tmpGroup.data.id]});
const tmpKey=(await consumer.call("POST","/api/user/keys",{name:"pooltmp-key",groupId:tmpGroup.data.id})).data.key;
const deletionRoot=`delete root ${uniq()}`;
const deletionMeta={metadata:{user_id:JSON.stringify({device_id:"b".repeat(64),session_id:crypto.randomUUID()})}};
await post(tmpKey,"/v1/messages",{model:"claude-sonnet-5",max_tokens:64,...deletionMeta,messages:[{role:"user",content:deletionRoot}]});
const usedBeforeDelete=await lastUsage(admin);
check("deletion fixture used target account",usedBeforeDelete.accountName==="ccr-pooltmp",usedBeforeDelete);
const beforeDel=await dbg();
const doomed=beforeDel.sessions.filter(s=>!after2.sessions.some(b=>b.id===s.id) && !s.archived);
await admin.call("DELETE",`/api/admin/accounts/${tmp.data.id}`);
await new Promise(resolve=>setTimeout(resolve,800));
r=await post(tmpKey,"/v1/messages",{model:"claude-sonnet-5",max_tokens:64,...deletionMeta,
  messages:[{role:"user",content:deletionRoot},{role:"assistant",content:"Hello from mock upstream."},{role:"user",content:"continue after account deletion"}]});
const usedAfterDelete=await lastUsage(admin);
const afterDel=await dbg();
const replacements=afterDel.sessions.filter(s=>!beforeDel.sessions.some(b=>b.id===s.id));
check("deleted account's session is never reused",r.status===200 && usedAfterDelete.accountName==="ccr-poolfallback" && doomed.length===1 &&
  doomed.every(d=>afterDel.sessions.find(s=>s.id===d.id)?.userEvents===d.userEvents) && replacements.length===1,
  {usedAfterDelete,doomed,replacements});

await fixture.stop();
console.log(fails ? `CCR: ${fails} FAILED` : "CCR: ALL PASSED");
process.exit(fails ? 1 : 0);
