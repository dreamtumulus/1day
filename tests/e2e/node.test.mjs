import { readFileSync } from "node:fs";
import { createTeamFixture } from "./team-fixture.mjs";
const seed = readFileSync(process.argv[2], "utf8");
const pick = (label) => seed.split("\n").find((l) => l.startsWith(label)).split(":")[1].trim().split(" ")[0];
const C = `http://127.0.0.1:${process.env.E2E_CONSOLE_PORT ?? 18401}`, G = `http://127.0.0.1:${process.env.E2E_GATEWAY_PORT ?? 18400}`;
let fails = 0;
const check = (n, c, e = "") => { console.log(`${c ? "PASS" : "FAIL"} ${n} ${c ? "" : JSON.stringify(e).slice(0, 400)}`); if (!c) fails++; };
async function session(key) {
  const r = await fetch(C + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key }) });
  const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
  return async (method, path, body) => {
    const res = await fetch(C + path, { method, headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, ...(await res.json().catch(() => ({}))) };
  };
}
const admin = await session(pick("admin    login key"));
const prov = await session(pick("provider login key"));
const fixture = await createTeamFixture({ admin, provider: prov, consoleBase: C, upstreamBase: `http://127.0.0.1:${process.env.E2E_MOCK_PORT ?? 19101}` });
const nodes = await prov("GET", "/api/provider/nodes");
check("node online", nodes.data.length === 1 && nodes.data[0].online, { nodes, nodeLog: fixture.log() });
const pid = (await admin("GET", "/api/admin/users?role=provider")).data.items[0].id;
const acc = await fixture.createAccount({ name: "node-oauth", platform: "anthropic", type: "oauth", accessToken: "oauth-token", route: "node", ownerId: pid, priority: 0, payoutRate: 0.6, groupIds: ["default"] });
check("node account", acc.status === 201, acc);
// Pinning a node: owner is derived from the node's provider, route defaults to node.
const nodeId = nodes.data[0].nodeId;
const pinned = await fixture.createAccount({ name: "node-pinned", platform: "anthropic", type: "oauth", accessToken: "oauth-token-2", nodeId, priority: 5, groupIds: ["default"] });
check("account pinned to node derives owner", pinned.status === 201 && pinned.data.ownerId === pid && pinned.data.nodeId === nodeId && pinned.data.route === "node", pinned);
const other = await admin("POST", "/api/admin/users", { role: "provider", name: "other-prov" });
const mismatch = await admin("POST", "/api/admin/accounts", { name: "x", platform: "anthropic", type: "oauth", accessToken: "t", nodeId, ownerId: other.data.id });
check("nodeId of another provider -> 400", mismatch.status === 400, mismatch);
const nodeRow = (await admin("GET", "/api/admin/nodes")).data.find((n) => n.nodeId === nodeId);
check("provider node is not a platform node", nodeRow && nodeRow.platformNode === false, nodeRow);
const noOwner = await admin("POST", "/api/admin/accounts", { name: "x", platform: "anthropic", type: "oauth", accessToken: "t", route: "node" });
check("route=node without owner or node -> 400", noOwner.status === 400, noOwner);
const unknown = await admin("POST", "/api/admin/accounts", { name: "x", platform: "anthropic", type: "oauth", accessToken: "t", nodeId: "node_nope" });
check("unknown nodeId -> 400 node_not_found", unknown.status === 400 && unknown.error?.code === "node_not_found", unknown);
await admin("DELETE", `/api/admin/accounts/${pinned.data.id}`);
// disable mock-anthropic so only the tunnel can serve
const all = await admin("GET", "/api/admin/accounts");
await admin("PATCH", `/api/admin/accounts/${all.data.items.find((a) => a.name === "mock-anthropic").id}`, { status: "disabled" });
const key = pick("consumer API key");
for (const stream of [false, true]) {
  const r = await fetch(G + "/v1/messages", { method: "POST", headers: { "x-api-key": key, "content-type": "application/json" }, body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 20, stream, messages: [{ role: "user", content: `tunnel ${stream}` }] }) });
  const t = await r.text();
  check(`via tunnel stream=${stream}`, r.status === 200 && t.includes("mock upstream"), t);
}
const ov = await prov("GET", "/api/provider/overview");
check("provider earning via tunnel", ov.data.today.requests === 2 && ov.data.balanceUsd > 0, ov.data);
await fixture.stop();
await new Promise((r) => setTimeout(r, 800));
const r = await fetch(G + "/v1/messages", { method: "POST", headers: { "x-api-key": key, "content-type": "application/json" }, body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 20, messages: [{ role: "user", content: "offline" }] }) });
check("node offline -> 503", r.status === 503, await r.text());
console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exit(fails ? 1 : 0);
