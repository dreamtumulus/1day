// Cross-node proxy sharing (operator rule 2026-11-08, docs/onboarding.md §1 原则 8): a proxy already in another node's
// pool is shared into the requesting node instead of being dropped as "on another node"; the home row stays; both pools
// list it (annotated); removing the share never touches the home row; a home row other nodes use cannot be removed.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "1dayapi-proxy-share-"));
process.env.DATA_DIR = dir;
process.env.CCR_WINDOW_POLL = "0";
process.env.ALLOW_UNTRUSTED_EXECUTION = "1";
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

const core = await import("@1dayapi/core");
const { addNodeProxies, replaceNodeProxies, removeNodeProxies, listNodeProxies, listProxiesForPicker, nodeProxyUrls, nodeProxyConfig,
  listNodeProxyGroups, resolveTeamProxy, resolveSuppliedProxy, recordNodeProxyExit } = await import("../dist/node/proxies.js");
const { createUser } = await import("../dist/session.js");
const { run, one, all, nowIso, sha256Hex, boundProxyDown, setSetting } = core;

const owner = createUser("provider", "share-fixture");
for (const [id, name] of [["home-node", "worker-02"], ["tui-node", "ccr-tui"]]) {
  run("INSERT INTO nodes(node_id,provider_id,secret_hash,deploy_meta,online,accepting_sessions,created_at) VALUES (?,?,'h',?,1,1,?)", id, owner.id, JSON.stringify({ name }), nowIso());
}
const urls = ["socks5://u:p@198.51.100.31:1080", "socks5://u:p@198.51.100.32:1080", "socks5://u:p@198.51.100.33:1080"];
const ids = urls.map((u) => sha256Hex(u).slice(0, 12));
replaceNodeProxies("home-node", urls.map((url) => ({ url, group: "uk" })));

test("append on another node shares the rows instead of dropping them; both pools list them", () => {
  const r = addNodeProxies("tui-node", [...urls, "socks5://u:p@198.51.100.99:1080"].map((url) => ({ url })));
  assert.equal(r.added, 1);
  assert.equal(r.shared, 3);
  assert.equal(r.skipped.onOtherNode, 0);
  assert.equal(one("SELECT COUNT(*) n FROM node_proxy_shares WHERE node_id='tui-node'").n, 3);
  assert.equal(one("SELECT COUNT(*) n FROM node_proxies WHERE node_id='home-node'").n, 3, "home rows untouched");
  const tui = listNodeProxies("tui-node");
  assert.equal(tui.length, 4);
  const shared = tui.filter((p) => p.shared);
  assert.equal(shared.length, 3);
  assert.equal(shared[0].homeNodeId, "home-node");
  assert.equal(shared[0].homeNodeName, "worker-02");
  assert.equal(shared[0].group, "uk", "a share shows the home row's group");
  assert.deepEqual(shared[0].sharedWith, []);
  const home = listNodeProxies("home-node");
  assert.equal(home.length, 3);
  assert.equal(home[0].shared, false);
  assert.deepEqual(home[0].sharedWith, [{ nodeId: "tui-node", name: "ccr-tui" }]);
  assert.equal(nodeProxyUrls("tui-node").length, 4);
  assert.equal(Object.keys(nodeProxyConfig("tui-node").proxyTeams).length, 4);
  assert.equal(listProxiesForPicker("tui-node", false).length, 4);
  assert.equal(listNodeProxyGroups("tui-node").find((g) => g.group === "uk")?.total, 3);
  // Appending the same lines again: already in this node's pool.
  const again = addNodeProxies("tui-node", urls.map((url) => ({ url })));
  assert.equal(again.shared, 0);
  assert.equal(again.skipped.alreadyInPool, 3);
  assert.equal(one("SELECT COUNT(*) n FROM proxy_team_events WHERE event='proxy_shared'").n, 3);
});

test("heartbeat from the sharing node writes the one row; both nodes may pick it; carriers are annotated with their node and organization", () => {
  const TEAM = "44444444-4444-4444-8444-444444444444";
  core.ensureUpstreamTeam(TEAM);
  run("UPDATE upstream_teams SET name='Org A' WHERE id=?", TEAM);
  assert.equal(recordNodeProxyExit("tui-node", ids[0], "203.0.113.10"), true, "exit recorded through the share");
  run("UPDATE node_proxies SET status='live', last_check_at=? WHERE id=?", nowIso(), ids[0]);
  assert.equal(one("SELECT exit_ip FROM node_proxies WHERE id=?", ids[0]).exit_ip, "203.0.113.10");
  assert.equal(resolveTeamProxy("tui-node", TEAM, ids[0]).id, ids[0]);
  assert.equal(resolveTeamProxy("home-node", TEAM, ids[0]).id, ids[0]);
  run(`INSERT INTO accounts(id,name,platform,type,protocol,executor,credential_enc,owner_id,route,node_id,review_status,bound_proxy_id,team_id,status)
    VALUES ('sh-acc','sh-acc','anthropic','oauth','anthropic','ccr_worker',?,?,'node','tui-node','approved',?,?,'active')`, core.encryptJson({ accessToken: "x" }), owner.id, ids[0], TEAM);
  const home = listNodeProxies("home-node").find((p) => p.id === ids[0]);
  assert.equal(home.carriers.length, 1);
  assert.equal(home.carriers[0].nodeName, "ccr-tui");
  assert.equal(home.carriers[0].teamName, "Org A");
  assert.equal(home.boundAccounts, 1, "capacity is one global count");
  assert.equal(listProxiesForPicker("tui-node", false).find((p) => p.id === ids[0]).carriers[0].teamName, null, "picker hides organizations unless asked");
  assert.equal(listProxiesForPicker("tui-node", false, { includeTeams: true }).find((p) => p.id === ids[0]).carriers[0].teamName, "Org A");
  // Scheduling gate: the account's node holds a share of the live proxy -> not down. Another node without a share -> down.
  setSetting("proxy_org_binding_enforce", "0");
  assert.equal(boundProxyDown({ bound_proxy_id: ids[0], team_id: TEAM, node_id: "tui-node" }), false);
  assert.equal(boundProxyDown({ bound_proxy_id: ids[0], team_id: TEAM, node_id: "home-node" }), false);
  assert.equal(boundProxyDown({ bound_proxy_id: ids[0], team_id: TEAM, node_id: "elsewhere" }), true);
});

test("removal: a share carrying this node's account stays; a free share goes without touching the home; a home row shared out is refused", () => {
  const r1 = removeNodeProxies("tui-node", [ids[0], ids[1]], null);
  assert.deepEqual(r1.bound, [ids[0]]);
  assert.deepEqual(r1.removed, [ids[1]]);
  assert.equal(one("SELECT COUNT(*) n FROM node_proxies WHERE id=?", ids[1]).n, 1, "home row kept");
  assert.equal(one("SELECT COUNT(*) n FROM node_proxy_shares WHERE proxy_id=?", ids[1]).n, 0);
  const r2 = removeNodeProxies("home-node", [ids[0], ids[2], ids[1]], null);
  assert.deepEqual(r2.bound, [ids[0]]);
  assert.deepEqual(r2.shared, [ids[2]]);
  assert.deepEqual(r2.removed, [ids[1]]);
  // Replacing the home pool without a shared-out row is refused; the sharing node may drop its own share by replace.
  assert.throws(() => replaceNodeProxies("home-node", [{ url: urls[0] }]), /shared with other nodes/);
  const rep = replaceNodeProxies("tui-node", [{ url: urls[0] }, { url: "socks5://u:p@198.51.100.99:1080" }]);
  assert.equal(rep.shared, 1);
  assert.equal(one("SELECT COUNT(*) n FROM node_proxy_shares WHERE node_id='tui-node'").n, 1);
  assert.equal(one("SELECT COUNT(*) n FROM node_proxies WHERE node_id='home-node'").n, 2, "home pool untouched by the other node's replace");
  assert.throws(() => replaceNodeProxies("tui-node", [{ url: "socks5://u:p@198.51.100.99:1080" }]), /shared proxy\(ies\) still bound/);
});

test("a supplied proxy known on another node is shared into the requested node (no node switch)", () => {
  // ids[2] lives on home-node; its share into tui-node was dropped by the replace above.
  const res = resolveSuppliedProxy("tui-node", "198.51.100.33:1080:u:p", { teamId: null, dryRun: true });
  assert.equal(res.existed, true);
  assert.equal(res.nodeId, "tui-node");
  assert.equal(res.homeNodeId, "home-node");
  assert.equal(res.shared, true);
  assert.equal(one("SELECT COUNT(*) n FROM node_proxy_shares WHERE proxy_id=?", ids[2]).n, 0, "dry run writes nothing");
  const pushed = [];
  const real = resolveSuppliedProxy("tui-node", "198.51.100.33:1080:u:p", { teamId: null, push: (n) => { pushed.push(n); return true; } });
  assert.equal(real.nodeId, "tui-node");
  assert.equal(real.pushed, true);
  assert.deepEqual(pushed, ["tui-node"]);
  assert.equal(one("SELECT COUNT(*) n FROM node_proxy_shares WHERE proxy_id=? AND node_id='tui-node'", ids[2]).n, 1);
  // A provider restricted to their own nodes may still share a proxy that lives on someone else's node.
  const other = resolveSuppliedProxy("tui-node", urls[2], { teamId: null, allowedNodes: new Set(["tui-node"]) });
  assert.equal(other.shared, true);
  assert.throws(() => resolveSuppliedProxy("tui-node", urls[2], { teamId: null, allowedNodes: new Set(["home-node"]) }), /proxy_on_other_node/);
  assert.equal(all("SELECT node_id FROM node_proxy_shares WHERE proxy_id=?", ids[2]).length, 1);
});
