import { readFileSync } from "node:fs";
const seed = readFileSync(process.argv[2], "utf8");
const pick = (label) => seed.split("\n").find((l) => l.startsWith(label)).split(":")[1].trim().split(" ")[0];
const C = `http://127.0.0.1:${process.env.E2E_CONSOLE_PORT ?? 18401}`, G = `http://127.0.0.1:${process.env.E2E_GATEWAY_PORT ?? 18400}`;
const MOCK = `http://127.0.0.1:${process.env.E2E_MOCK_PORT ?? 19101}`;
let fails = 0;
const check = (name, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"} ${name} ${cond ? "" : JSON.stringify(extra).slice(0, 400)}`); if (!cond) fails++; };
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
const infer = async (key, model, extra = {}) => {
  const r = await fetch(G + "/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ model, messages: [{ role: "user", content: `hi ${Date.now()} ${seq++}` }], ...extra }) });
  return { status: r.status, text: await r.text() };
};

const admin = await session(pick("admin    login key"));
const consumer = await session(pick("consumer login key"));
const provider = await session(pick("provider login key"));
const ops = await session(pick("ops      login key"));
check("logins", admin.status === 200 && consumer.status === 200 && provider.status === 200 && ops.status === 200);
check("bad login", (await session("1dk_consumer_nope")).status === 401);
check("role gate", (await consumer.call("GET", "/api/admin/users")).status === 403);
// ops (账号管理员, docs/auth.md §2): account pool only.
check("ops sees accounts", (await ops.call("GET", "/api/admin/accounts")).status === 200);
check("ops has no users/finance/settings", (await ops.call("GET", "/api/admin/users")).status === 403 && (await ops.call("GET", "/api/admin/dashboard")).status === 403 && (await ops.call("GET", "/api/admin/settings")).status === 403);
check("ops cannot infer", (await ops.call("GET", "/api/user/keys")).status === 403);
const opsUser = await admin.call("POST", "/api/admin/users", { role: "ops", name: "ops-2" });
check("admin creates ops user", opsUser.status === 201 && opsUser.data.loginKey.startsWith("1dk_ops_") && opsUser.data.role === "ops", opsUser);

// groups + keys
const vip = await admin.call("POST", "/api/admin/groups", { name: "vip", rateMultiplier: 0.5, modelAllowlist: { enabled: true, models: ["claude-*"] } });
check("create group", vip.status === 201, vip);
const secret = await admin.call("POST", "/api/admin/groups", { name: "secret", isExclusive: true });
let groups = await consumer.call("GET", "/api/user/groups");
check("exclusive group hidden", groups.data.some((g) => g.name === "vip") && !groups.data.some((g) => g.name === "secret"), groups);
const badKey = await consumer.call("POST", "/api/user/keys", { name: "x", groupId: secret.data.id });
check("cannot use exclusive group", badKey.status === 400, badKey);
const vipKey = await consumer.call("POST", "/api/user/keys", { name: "vip-key", groupId: vip.data.id, quotaUsd: 1 });
check("create key", vipKey.status === 201 && vipKey.data.key.startsWith("sk-1d-"), vipKey);
const reveal = await consumer.call("POST", `/api/user/keys/${vipKey.data.id}/reveal`);
check("reveal key", reveal.data?.key === vipKey.data.key, reveal);
let r = await infer(vipKey.data.key, "claude-sonnet-5");
check("group without accounts -> 503", r.status === 503, r.text);
const all0 = await admin.call("GET", "/api/admin/accounts");
check("accounts list is paged with kind counts", Array.isArray(all0.data.items) && typeof all0.data.total === "number" && typeof all0.data.counts?.api === "number", all0.data);
const subsOnly = await admin.call("GET", "/api/admin/accounts?kind=subscription");
check("kind=subscription filters to oauth", subsOnly.data.items.every((a) => a.type === "oauth"), subsOnly.data);
const apiOnly = await admin.call("GET", "/api/admin/accounts?kind=api&pageSize=1");
check("kind=api paged", apiOnly.data.items.length === 1 && apiOnly.data.items[0].type !== "oauth" && apiOnly.data.pageSize === 1 && typeof apiOnly.data.items[0].usage?.d30?.requests === "number", apiOnly.data);
const mockA = all0.data.items.find((a) => a.name === "mock-anthropic");
await admin.call("PATCH", `/api/admin/accounts/${mockA.id}`, { groupIds: ["default", vip.data.id] });
r = await infer(vipKey.data.key, "gpt-5.5");
check("allowlist blocks gpt", r.status === 403 && r.text.includes("model_not_allowed"), r.text);
r = await infer(vipKey.data.key, "claude-sonnet-5");
check("vip claude ok", r.status === 200, r.text);
const usage = await consumer.call("GET", "/api/user/usage?pageSize=1");
check("vip rate 0.5 applied", usage.data.items[0].rateMultiplier === 0.5 && Math.abs(usage.data.items[0].actualCost - 0.0000606) < 1e-9, usage.data.items[0]);

// failover: 429 account in front of mock-anthropic
const acc429 = await admin.call("POST", "/api/admin/accounts", { name: "rl-429", platform: "anthropic", type: "upstream", protocol: "anthropic", baseUrl: MOCK, apiKey: "mock-429", priority: 1, groupIds: ["default"] });
check("create account", acc429.status === 201, acc429);
const ck = await consumer.call("GET", "/api/user/keys");
const demoKey = (await consumer.call("POST", `/api/user/keys/${ck.data.find((k) => k.name === "demo").id}/reveal`)).data.key;
r = await infer(demoKey, "claude-sonnet-5");
check("failover after 429", r.status === 200, r.text);
let accs = await admin.call("GET", "/api/admin/accounts");
const a429 = accs.data.items.find((a) => a.name === "rl-429");
check("429 account cooling", !!a429.rateLimitedUntil && !!a429.coolingUntil, a429);

const acc400 = await admin.call("POST", "/api/admin/accounts", { name: "bad-400", platform: "openai", type: "upstream", baseUrl: `${MOCK}/v1`, apiKey: "mock-400", priority: 0, groupIds: ["default"] });
r = await infer(demoKey, "gpt-5.5");
check("400 passthrough", r.status === 400 && r.text.includes("mock bad request"), r.text);
await admin.call("PATCH", `/api/admin/accounts/${acc400.data.id}`, { status: "disabled" });
r = await infer(demoKey, "gpt-5.5");
check("disabled account skipped", r.status === 200, r.text);

// test endpoint
const t = await admin.call("POST", `/api/admin/accounts/${a429.id}/test`, {});
check("account test reports 429", t.data.statusCode === 429, t);

// provider flow
const pacc = await provider.call("POST", "/api/provider/accounts", { name: "my-relay", platform: "openai", type: "upstream", baseUrl: `${MOCK}/v1`, apiKey: "relay-key" });
check("provider submits pending", pacc.status === 201 && pacc.data.reviewStatus === "pending", pacc);
const rev = await admin.call("POST", `/api/admin/accounts/${pacc.data.id}/review`, { action: "approve", groupIds: ["default"], priority: 0, payoutRate: 0.5 });
check("admin approves", rev.data?.reviewStatus === "approved" && rev.data.payoutRate === 0.5, rev);
r = await infer(demoKey, "gpt-5.5");
const pov = await provider.call("GET", "/api/provider/overview");
check("provider earned", pov.data.balanceUsd > 0 && pov.data.accounts.active === 1, pov.data);
const earn = await provider.call("GET", "/api/provider/earnings");
check("earnings list", earn.data.items.length === 1 && Math.abs(earn.data.items[0].providerEarning - Math.round(earn.data.items[0].totalCost * 0.5 * 1e8) / 1e8) < 1e-12, earn.data);
const edit = await provider.call("PATCH", `/api/provider/accounts/${pacc.data.id}`, { apiKey: "new-key" });
check("credential change -> pending", edit.data.reviewStatus === "pending", edit);
const users = await admin.call("GET", "/api/admin/users?role=provider");
const pid = users.data.items[0].id;
const tooMuch = await admin.call("POST", `/api/admin/users/${pid}/payout`, { amountUsd: 999 });
check("payout over balance rejected", tooMuch.status === 400, tooMuch);
const pay = await admin.call("POST", `/api/admin/users/${pid}/payout`, { amountUsd: pov.data.balanceUsd, ref: "tx-1" });
check("payout ok", pay.status === 200 && Math.abs(pay.data.balanceUsd) < 1e-9, pay);
check("provider cannot infer", (await provider.call("GET", "/api/user/keys")).status === 403);

// redeem
const codes = await admin.call("POST", "/api/admin/redeem-codes", { valueUsd: 10, count: 2, batch: "t1" });
check("gen codes", codes.data.codes.length === 2, codes);
const before = (await consumer.call("GET", "/api/user/overview")).data.balanceUsd;
const red = await consumer.call("POST", "/api/user/redeem", { code: codes.data.codes[0].toLowerCase() });
check("redeem", red.status === 200 && Math.abs(red.data.balanceUsd - before - 10) < 1e-9, red);
check("double redeem fails", (await consumer.call("POST", "/api/user/redeem", { code: codes.data.codes[0] })).status === 400);
await admin.call("PATCH", `/api/admin/redeem-codes/${codes.data.codes[1]}`, { status: "disabled" });
check("disabled code fails", (await consumer.call("POST", "/api/user/redeem", { code: codes.data.codes[1] })).status === 400);
const ledger = await consumer.call("GET", "/api/user/ledger");
check("ledger has redeem", ledger.data.items.some((l) => l.kind === "redeem" && l.amountUsd === 10), ledger.data);

// quota / disable / dashboards
await consumer.call("PATCH", `/api/user/keys/${vipKey.data.id}`, { quotaUsd: 0.000001 });
r = await infer(vipKey.data.key, "claude-sonnet-5");
check("quota exhausted", r.status === 429 && r.text.includes("quota_exhausted"), r.text);
const dash = await admin.call("GET", "/api/admin/dashboard");
check("admin dashboard", dash.data.daily.length === 30 && dash.data.today.requests > 0 && dash.data.accounts.pending === 1, dash.data);
const stats = await admin.call("GET", "/api/admin/usage/stats");
check("usage stats", stats.data.byModel.length >= 2 && stats.data.byAccount.length >= 2, stats.data);
const cu = (await admin.call("GET", "/api/admin/users?role=consumer")).data.items[0];
await admin.call("PATCH", `/api/admin/users/${cu.id}`, { status: "disabled" });
r = await infer(demoKey, "gpt-5.5");
check("disabled user key rejected", r.status === 401 && r.text.includes("user_disabled"), r.text);
check("disabled user session dropped", (await consumer.call("GET", "/auth/me")).status === 401);
const rk = await admin.call("POST", `/api/admin/users/${cu.id}/reset-login-key`);
check("reset login key", rk.data.loginKey.startsWith("1dk_consumer_"), rk);

// models / settings
const mp = await admin.call("PUT", "/api/admin/models/my-custom-model", { platform: "openai", inputPerM: 1, outputPerM: 2 });
check("custom model", mp.data.source === "custom", mp);
const pub = await fetch(C + "/api/models/pricing").then((x) => x.json());
check("custom model public", pub.data.some((p) => p.id === "my-custom-model"));
const beforeSettings = (await admin.call("GET", "/api/admin/settings")).data;
check("settings require revision", (await admin.call("PUT", "/api/admin/settings", { announcement: "missing revision" })).status === 428);
const st = await admin.call("PUT", "/api/admin/settings", { announcement: "hello", provider_default_payout_rate: 0.7, _revision: beforeSettings._revision });
check("settings", st.data.announcement === "hello" && st.data.provider_default_payout_rate === "0.7" && st.data._revision === beforeSettings._revision + 1, st);
check("stale settings revision conflict", (await admin.call("PUT", "/api/admin/settings", { announcement: "stale", _revision: beforeSettings._revision })).status === 409);
check("bad setting", (await admin.call("PUT", "/api/admin/settings", { provider_default_payout_rate: 3, _revision: st.data._revision })).status === 400);
console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exit(fails ? 1 : 0);
