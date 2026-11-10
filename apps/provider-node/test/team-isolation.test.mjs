import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { CcWorkerManager } from "../dist/cc-worker.js";
import { HttpEgressManager } from "../dist/http-egress.js";
import { IsolationGuard } from "../dist/isolation.js";
import { ProxyPool, proxyId } from "../dist/proxy-pool.js";

const TEAM_A = "11111111-1111-4111-8111-111111111111";
const TEAM_B = "22222222-2222-4222-8222-222222222222";
const PROXY_A = "http://u:p@127.0.0.1:9009";
const PROXY_B = "http://u:p@127.0.0.1:9010";
const PA = proxyId(PROXY_A), PB = proxyId(PROXY_B);
const context = (teamId = TEAM_A, conversationId = "conversation-a", generation = 1) => ({ teamId, conversationId, generation });
const waitFor = async (fn, label) => {
  const until = Date.now() + 8000;
  while (Date.now() < until) { if (fn()) return; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error(`Timed out: ${label}`);
};
function setup(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "1day-team-worker-"));
  const pool = new ProxyPool({ data: {}, save() {} }, { autoCheck: false });
  pool.replaceAll([PROXY_A, PROXY_B], {
    proxyTeams: { [PA]: TEAM_A, [PB]: TEAM_B },
    proxyAccounts: { [PA]: ["a1", "a2", "a3"], [PB]: ["b1"] },
  });
  const frames = [];
  const options = { send: (m) => (frames.push(m), true), identity: () => ({ nodeId: "n", providerId: "p" }), isDraining: () => false,
    isolationGuard: new IsolationGuard(), pool, dataDir: dir, workerRoot: dir, runAsUser: null, allowRoot: true, maxConcurrency: 4,
    claudeBin: process.execPath, claudeArgsPrefix: [new URL("./fake-claude.mjs", import.meta.url).pathname], ...extra };
  const manager = new CcWorkerManager(options);
  const egress = new HttpEgressManager(options);
  return { dir, manager, egress, frames, pool, close() { manager.closeAll(); egress.closeAll(); pool.stopHealthChecks(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
function open(sessionId, extra = {}) {
  return { type: "cc_worker.open", sessionId, routeMode: "cc_worker", providerId: "p", nodeId: "n", credentialBindingId: "a1", accountId: "a1",
    proxyId: PA, deviceId: "a".repeat(64), isolation: context(), model: "claude-sonnet-5-5", prompt: "hello", stream: true,
    cred: { accessToken: "fixture-token", expiresAt: Date.now() + 3600000 }, deadlineMs: 15000, ...extra };
}
const data = (frames, sid) => frames.filter((f) => f.sessionId === sid && f.type === "cc_worker.data")
  .flatMap((f) => Buffer.from(f.payloadBase64, "base64").toString().trim().split("\n").map((x) => JSON.parse(x)));

// A team proxy can serve three fixed accounts from that team, with separate devices/configs.
{
  const s = setup();
  try {
    assert.equal(s.pool.getPinned(PA, "b1", TEAM_B), null);
    assert.equal(s.pool.getPinned(PA), null, "legacy caller cannot borrow a team proxy");
    assert.equal(s.pool.pickForAccount("a1"), null, "a fixed account never rehashes across a node pool");
    for (const [i, accountId] of ["a1", "a2", "a3"].entries()) s.manager.handleOpen(open(`ok-${i}`, { accountId, deviceId: String(i + 1).repeat(64) }));
    await waitFor(() => [0, 1, 2].every((i) => s.frames.some((f) => f.sessionId === `ok-${i}` && f.reasonCode === "complete")), "same-team accounts complete");
    const teamDir = createHash("sha256").update(TEAM_A).digest("hex");
    for (const [i, id] of ["a1", "a2", "a3"].entries()) {
      const cfg = JSON.parse(fs.readFileSync(path.join(s.dir, "teams", teamDir, "cc-accounts", id, ".claude.json")));
      assert.equal(cfg.userID, String(i + 1).repeat(64));
    }
    s.manager.handleOpen(open("wrong-team", { isolation: context(TEAM_B) }));
    assert.equal(s.frames.find((f) => f.sessionId === "wrong-team").accepted, false);
    s.manager.handleOpen(open("missing-context", { isolation: undefined }));
    assert.equal(s.frames.find((f) => f.sessionId === "missing-context").reasonCode, "isolation_required");
    s.manager.handleOpen(open("reuse-device", { accountId: "b1", proxyId: PB, deviceId: "1".repeat(64), isolation: context(TEAM_B, "other-conversation") }));
    await waitFor(() => s.frames.some((f) => f.sessionId === "reuse-device" && f.type === "cc_worker.error"), "cross-team device reuse refused");
  } finally { s.close(); }
}

// Privilege-dropped workers can traverse the namespaced parent dirs, but account configs remain 0700.
if (process.getuid?.() === 0 && fs.readFileSync("/etc/passwd", "utf8").includes("nobody:")) {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "team-worker-exec-"));
  fs.chmodSync(fixtureDir, 0o755);
  const fixture = path.join(fixtureDir, "fake.mjs");
  fs.copyFileSync(new URL("./fake-claude.mjs", import.meta.url), fixture);
  fs.chmodSync(fixture, 0o644);
  const s = setup({ runAsUser: "nobody", claudeArgsPrefix: [fixture] });
  try {
    s.manager.handleOpen(open("different-uid"));
    await waitFor(() => s.frames.some((f) => f.sessionId === "different-uid" && f.reasonCode === "complete"), "privilege-dropped namespaced worker");
  } finally { s.close(); fs.rmSync(fixtureDir, { recursive: true, force: true }); }
}

// Strong reset kills parked native tools, removes its credentials-bearing process scratch,
// rejects late opens, and allows a fresh generation in another team with its own identity.
{
  const s = setup();
  try {
    s.manager.handleOpen(open("tools", { persist: true, reuseKey: "same-caller-key", turnMode: "fresh", expectedTurn: 0,
      tools: [{ name: "lookup", input_schema: { type: "object" } }], prompt: '[TOOL]lookup {"q":"old-team-secret"}',
      content: [{ type: "text", text: '[TOOL]lookup {"q":"old-team-secret"}' }] }));
    await waitFor(() => data(s.frames, "tools").some((x) => x.type === "1dayapi_tool_call"), "tool parked");
    const init = data(s.frames, "tools").find((x) => x.subtype === "init");
    const mcpUrl = JSON.parse(fs.readFileSync(path.join(init.home, "mcp-config.json"))).mcpServers.caller.url;
    s.manager.handleClose({ type: "cc_worker.close", sessionId: "tools", reasonCode: "gateway_closed" });
    assert.equal(s.manager.stats().pool.awaitingTools, 1, "ordinary close deliberately parks the old process");
    s.manager.resetConversation(context());
    assert.equal(s.manager.stats().pool.live, 0);
    assert.equal(s.manager.stats().pool.awaitingTools, 0);
    await waitFor(() => !fs.existsSync(init.home), "old scratch removed");
    const deadTool = await fetch(mcpUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }) });
    assert.equal(deadTool.status, 404, "old MCP capability is revoked");
    s.manager.handleOpen(open("late"));
    assert.equal(s.frames.find((f) => f.sessionId === "late").reasonCode, "isolation_retired");
    s.manager.handleOpen(open("new", { accountId: "b1", proxyId: PB, deviceId: "b".repeat(64), isolation: context(TEAM_B, "conversation-a", 2), reuseKey: "same-caller-key", persist: true }));
    await waitFor(() => s.frames.some((f) => f.sessionId === "new" && f.reasonCode === "complete"), "new team starts fresh");
    assert.equal(data(s.frames, "new").find((x) => x.subtype === "init").https_proxy, PROXY_B);
  } finally { s.close(); }
}

// A queued old generation is removed before another completion can drain the queue.
{
  const s = setup({ maxConcurrency: 1, maxQueue: 4 });
  process.env.FAKE_CLAUDE_MODE = "hang";
  try {
    s.manager.handleOpen(open("busy-old"));
    s.manager.handleOpen(open("queued-old"));
    assert.equal(s.manager.stats().queued, 1);
    s.manager.resetConversation(context());
    assert.equal(s.manager.stats().queued, 0);
    assert.equal(s.manager.stats().active, 0);
    assert.ok(s.frames.some((f) => f.sessionId === "queued-old" && f.reasonCode === "isolation_retired"));
    assert.equal(data(s.frames, "queued-old").length, 0);
  } finally { delete process.env.FAKE_CLAUDE_MODE; s.close(); }
}

// Egress cannot override the team pin in the request spec; reset fences a late spec/open.
{
  const s = setup();
  try {
    const envelope = { type: "http_egress.open", sessionId: "e1", routeMode: "http_egress", providerId: "p", nodeId: "n", accountId: "a1", credentialBindingId: "a1", proxyId: PA, isolation: context(), deadlineMs: 15000 };
    s.egress.handleOpen(envelope);
    s.egress.handleData({ type: "http_egress.data", sessionId: "e1", seq: 0, payloadBase64: Buffer.from(JSON.stringify({ url: "https://api.anthropic.com/v1/messages", headers: {}, proxyId: PB }) + "\n").toString("base64") });
    await waitFor(() => s.frames.some((f) => f.sessionId === "e1" && f.reasonCode === "proxy_team_mismatch"), "spec pin override rejected before network");
    s.egress.resetConversation(context());
    s.egress.handleOpen({ ...envelope, sessionId: "late-egress" });
    assert.equal(s.frames.find((f) => f.sessionId === "late-egress").accepted, false);
    const pinned = new IsolationGuard(TEAM_A);
    assert.equal(pinned.allows(context(TEAM_B)), false, "dedicated runtime rejects another team");
  } finally { s.close(); }
}
console.log("team-isolation: ALL PASSED");
