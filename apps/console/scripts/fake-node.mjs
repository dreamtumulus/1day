#!/usr/bin/env node
// Fake provider node for local E2E testing of the provider protocol
// (docs/provider-protocol.md). Speaks the node side of the contract:
// WS handshake headers, provider.hello, heartbeats, official_exit.open ->
// net.connect to the target, byte shuttling via official_exit.data, and the
// protocol v2 http_egress frames (spec line in -> head line + body out),
// executed with plain fetch (no proxy pool, no fingerprint: test double only),
// and cc_worker frames (spawn the fake claude fixture, stream stdout back).
//
//   # direct credentials (e.g. from scripts/seed-provider.mjs):
//   node scripts/fake-node.mjs --node-id node_localdev --secret <hex>
//
//   # full bind flow:
//   node scripts/fake-node.mjs --bind-code bind_... [--platform http://127.0.0.1:8401]
//
// FAKE_NODE_TARGET=host:port forces the egress target (else the open
// message's targetHost/targetPort are used).
// FAKE_CLAUDE=<path> overrides the fake claude fixture (default: sibling fake-claude.mjs).
import net from "node:net";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import WebSocket from "ws";

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const platform = arg("platform", "http://127.0.0.1:8401");
const bindCode = arg("bind-code", "");
let nodeId = arg("node-id", "");
let secret = arg("secret", "");
let wsUrl = "";
const heartbeatMs = Number(process.env.FAKE_NODE_HEARTBEAT_MS ?? 10_000);
const forcedTarget = process.env.FAKE_NODE_TARGET ?? "";
const upstreamBase = process.env.FAKE_NODE_UPSTREAM_BASE;
const orgUuid = process.env.FAKE_NODE_ORG_UUID ?? "11111111-1111-4111-8111-111111111111";
const proxyUrls = new Map();
let proxyTeams = {}, proxyAccounts = {};
const retired = new Map();
const deviceOwners = new Map();
const proxyId = (url) => createHash("sha256").update(url).digest("hex").slice(0, 12);
const sameContext = (a, b) => a && a.teamId === b.teamId && a.conversationId === b.conversationId && a.generation === b.generation;
const stale = (c) => c && (!c.teamId || !c.conversationId || !Number.isSafeInteger(c.generation) || c.generation <= (retired.get(c.conversationId) ?? 0));
function authorized(msg) {
  if (stale(msg.isolation)) return false;
  const team = msg.isolation?.teamId ?? msg.teamId;
  if (team) return proxyTeams[msg.proxyId] === team && proxyAccounts[msg.proxyId]?.includes(msg.accountId);
  return !proxyTeams[msg.proxyId] && !Object.values(proxyAccounts).some((ids) => ids.includes(msg.accountId));
}
function tokenUuid(headers) {
  const bearer = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === "authorization")?.[1] ?? "";
  const h = createHash("sha256").update(String(bearer)).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
function localTarget(raw) {
  const u = new URL(raw);
  if (upstreamBase && ["api.anthropic.com", "console.anthropic.com", "claude.ai"].includes(u.hostname)) {
    const base = new URL(upstreamBase); u.protocol = base.protocol; u.host = base.host;
  }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) throw new Error("fake-node refuses external network; configure a loopback mock upstream");
  return u;
}

if (bindCode) {
  nodeId = nodeId || `node_${Math.random().toString(16).slice(2, 10)}`;
  const res = await fetch(`${platform}/internal/provider/bind`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      bindingCode: bindCode,
      nodeId,
      nodeVersion: "fake-node/0.1",
      runtimeIdentity: { osType: "linux", osVersion: "dev", osArch: "x64" },
    }),
  });
  const json = await res.json();
  if (!res.ok) {
    console.error("[fake-node] bind failed:", res.status, json);
    process.exit(1);
  }
  secret = json.providerNodeSecret;
  wsUrl = json.platformWsUrl;
  console.log(`[fake-node] bound: providerId=${json.providerId} nodeId=${nodeId}`);
} else {
  if (!nodeId || !secret) {
    console.error("need --bind-code or --node-id + --secret");
    process.exit(1);
  }
  wsUrl = platform.replace(/^http/, "ws") + "/internal/provider/connect";
}

console.log(`[fake-node] connecting ${wsUrl} as ${nodeId}`);
const ws = new WebSocket(wsUrl, {
  headers: { "x-provider-node-id": nodeId, "x-provider-node-secret": secret },
});

const upstreamSockets = new Map(); // sessionId -> net.Socket
const egress = new Map(); // sessionId -> { chunks: Buffer[], done: boolean, abort: AbortController, seq: number }
const workers = new Map(); // sessionId -> ChildProcess
const fakeClaude = process.env.FAKE_CLAUDE ?? new URL("./fake-claude.mjs", import.meta.url).pathname;

async function runEgress(sessionId, line) {
  const s = egress.get(sessionId);
  if (!s) return;
  const data = (buf) => { if (egress.get(sessionId) === s && !stale(s.envelope.isolation)) send({ type: "http_egress.data", sessionId, seq: ++s.seq, payloadBase64: buf.toString("base64") }); };
  const finish = (reasonCode) => {
    if (egress.delete(sessionId)) send({ type: "http_egress.close", sessionId, reasonCode });
  };
  let spec;
  try {
    spec = JSON.parse(line);
  } catch {
    data(Buffer.from(JSON.stringify({ error: "bad_spec", message: "invalid JSON" }) + "\n"));
    return finish("bad_spec");
  }
  try {
    if (!authorized(s.envelope) || (spec.proxyId && spec.proxyId !== s.envelope.proxyId)) throw new Error("proxy_team_mismatch");
    const target = localTarget(spec.url);
    const bodyBuffer = spec.bodyBase64 ? Buffer.from(spec.bodyBase64, "base64") : undefined;
    const body = bodyBuffer?.length ? bodyBuffer : undefined;
    const accountUuid = tokenUuid(spec.headers);
    // The OAuth identity endpoint is an upstream test double; the console still
    // reserves a measured proxy and verifies this response through the real tunnel.
    const identity = target.pathname === "/api/oauth/validate" ? { organization_uuid: orgUuid, account_uuid: accountUuid }
      : target.pathname === "/api/oauth/profile" ? { account: { uuid: accountUuid, email: `${accountUuid}@fixture.invalid` }, organization: { uuid: orgUuid, name: "E2E team", organization_type: "claude_team" } }
      : target.pathname === "/api/oauth/claude_cli/roles" ? { organization_role: "member", workspace_role: "developer", organization_name: "E2E team" } : null;
    const res = identity ? Response.json(identity) : await fetch(target, { method: spec.method ?? (body ? "POST" : "GET"), headers: spec.headers ?? {}, body, redirect: "manual", signal: s.abort.signal });
    const headers = {};
    res.headers.forEach((v, k) => { if (!["content-encoding", "content-length", "transfer-encoding"].includes(k)) headers[k] = v; });
    data(Buffer.from(JSON.stringify({ status: res.status, headers }) + "\n"));
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.length) data(Buffer.from(value));
      }
    }
    finish("complete");
  } catch (err) {
    if (!egress.has(sessionId)) return;
    data(Buffer.from(JSON.stringify({ error: "upstream_connect_failed", message: err.message }) + "\n"));
    finish("upstream_connect_failed");
  }
}

function send(msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function heartbeat() {
  send({ type: "provider.heartbeat", nodeId,
    inFlight: upstreamSockets.size + egress.size + workers.size, healthy: true,
    officialExit: { activeSessions: upstreamSockets.size }, acceptingSessions: true,
    proxies: [...proxyUrls].map(([id, url]) => ({ id, live: true, latencyMs: 1, exitIp: new URL(url).hostname, error: null })),
    assignments: {}, ccWorker: { enabled: true, claudeVersion: "2.1.300 (fake)", maxConcurrency: 2, active: workers.size, queued: 0 } });
}

ws.on("open", () => {
  send({
    type: "provider.hello",
    nodeId,
    nodeVersion: "fake-node/0.1",
    capabilities: ["official_exit", "http_egress", "cc_worker", "team_isolation_v1", ...(process.env.FAKE_NODE_CANONICAL === "1" ? ["canonical_v1", "tui_v1"] : [])],
    isolatedContexts: [],
    acceptingSessions: true,
  });
  setInterval(heartbeat, heartbeatMs).unref();
});

ws.on("message", (data) => {
  const msg = JSON.parse(data.toString("utf8"));
  switch (msg.type) {
    case "platform.ready":
      console.log(`[fake-node] platform.ready (nodeId=${msg.nodeId})`);
      break;
    case "proxies.set":
      proxyUrls.clear();
      for (const url of msg.proxies ?? []) proxyUrls.set(proxyId(url), url);
      proxyTeams = msg.proxyTeams ?? {}; proxyAccounts = msg.proxyAccounts ?? {};
      heartbeat();
      break;
    case "isolation.reset":
      retired.set(msg.isolation.conversationId, Math.max(retired.get(msg.isolation.conversationId) ?? 0, msg.isolation.generation));
      for (const [id, s] of egress) if (sameContext(s.envelope.isolation, msg.isolation)) { egress.delete(id); s.abort.abort(); }
      for (const [id, s] of workers) if (sameContext(s.isolation, msg.isolation)) { workers.delete(id); s.child.kill("SIGKILL"); }
      send({ type: "isolation.reset_ack", resetId: msg.resetId });
      break;
    case "official_exit.open": {
      const { sessionId } = msg;
      const target = forcedTarget || `${msg.targetHost}:${msg.targetPort}`;
      const [host, port] = target.split(":");
      console.log(`[fake-node] official_exit.open ${sessionId} -> ${host}:${port} (cred=${msg.credentialBindingId})`);
      const sock = net.connect(Number(port), host);
      const seqState = { next: 0 };
      sock.on("connect", () => {
        send({ type: "official_exit.open_response", sessionId, accepted: true });
        upstreamSockets.set(sessionId, sock);
      });
      sock.on("data", (chunk) => {
        send({
          type: "official_exit.data",
          sessionId,
          seq: seqState.next++,
          payloadBase64: chunk.toString("base64"),
        });
      });
      sock.on("error", (err) => {
        if (!upstreamSockets.has(sessionId)) {
          send({ type: "official_exit.open_response", sessionId, accepted: false, reasonCode: "connect_failed" });
        } else {
          send({ type: "official_exit.error", sessionId, errorCode: "upstream_error", errorMessage: err.message, retryable: true });
          upstreamSockets.delete(sessionId);
        }
      });
      sock.on("close", () => {
        if (upstreamSockets.delete(sessionId)) {
          send({ type: "official_exit.close", sessionId, reasonCode: "upstream_closed" });
        }
      });
      break;
    }
    case "official_exit.data": {
      const sock = upstreamSockets.get(msg.sessionId);
      if (sock) sock.write(Buffer.from(msg.payloadBase64, "base64"));
      break;
    }
    case "http_egress.open": {
      console.log(`[fake-node] http_egress.open ${msg.sessionId} (account=${msg.accountId})`);
      if (!authorized(msg)) { send({ type: "http_egress.open_response", sessionId: msg.sessionId, accepted: false, reasonCode: "proxy_team_mismatch" }); break; }
      egress.set(msg.sessionId, { envelope: msg, chunks: [], done: false, abort: new AbortController(), seq: 0 });
      send({ type: "http_egress.open_response", sessionId: msg.sessionId, accepted: true });
      break;
    }
    case "http_egress.data": {
      const s = egress.get(msg.sessionId);
      if (!s || s.done) break;
      s.chunks.push(Buffer.from(msg.payloadBase64, "base64"));
      const buf = Buffer.concat(s.chunks);
      const nl = buf.indexOf(0x0a);
      if (nl < 0) break;
      s.done = true;
      void runEgress(msg.sessionId, buf.subarray(0, nl).toString("utf8"));
      break;
    }
    case "http_egress.close": {
      const s = egress.get(msg.sessionId);
      if (s) {
        egress.delete(msg.sessionId);
        s.abort.abort();
      }
      break;
    }
    case "cc_worker.open": {
      const { sessionId } = msg;
      console.log(`[fake-node] cc_worker.open ${sessionId} (account=${msg.accountId} model=${msg.model} mode=${msg.mode ?? "legacy"} prompt=${(msg.prompt ?? "").length}ch)`);
      const owner = deviceOwners.get(msg.deviceId);
      if (!authorized(msg) || !msg.isolation || !/^[0-9a-f]{64}$/i.test(msg.deviceId ?? "") ||
        (owner && (owner.accountId !== msg.accountId || owner.teamId !== msg.isolation.teamId))) {
        send({ type: "cc_worker.open_response", sessionId, accepted: false, reasonCode: "isolation_mismatch" }); break;
      }
      deviceOwners.set(msg.deviceId, { accountId: msg.accountId, teamId: msg.isolation.teamId });
      const child = spawn("node", [fakeClaude, "-p", msg.prompt ?? "", "--model", msg.model ?? "", "--output-format", "stream-json", "--verbose"], {
        env: { ...process.env, FAKE_CLAUDE_MODE: msg.mode ?? "legacy", FAKE_CLAUDE_SYSTEM: msg.appendSystemPrompt ?? msg.systemPrompt ?? "" },
      });
      workers.set(sessionId, { child, isolation: msg.isolation });
      send({ type: "cc_worker.open_response", sessionId, accepted: true });
      let seq = 0;
      let errTail = "";
      child.stdout.on("data", (c) => { if (workers.has(sessionId) && !stale(msg.isolation)) send({ type: "cc_worker.data", sessionId, seq: ++seq, payloadBase64: c.toString("base64") }); });
      child.stderr.on("data", (c) => (errTail = (errTail + c.toString()).slice(-2000)));
      child.on("error", (err) => {
        if (workers.delete(sessionId)) send({ type: "cc_worker.error", sessionId, errorCode: "worker_spawn_failed", errorMessage: err.message });
      });
      child.on("close", (code) => {
        if (!workers.delete(sessionId)) return;
        if (code === 0) send({ type: "cc_worker.close", sessionId, reasonCode: "complete" });
        else send({ type: "cc_worker.error", sessionId, errorCode: "worker_failed", errorMessage: `exit ${code}: ${errTail.slice(-300)}` });
      });
      break;
    }
    case "cc_worker.close": {
      const worker = workers.get(msg.sessionId);
      if (worker) {
        workers.delete(msg.sessionId);
        worker.child.kill("SIGKILL");
        send({ type: "cc_worker.close", sessionId: msg.sessionId, reasonCode: "gateway_closed" });
      }
      break;
    }
    case "official_exit.close": {
      const sock = upstreamSockets.get(msg.sessionId);
      if (sock) {
        upstreamSockets.delete(msg.sessionId);
        sock.end();
      }
      break;
    }
  }
});

ws.on("close", (code, reason) => {
  console.log(`[fake-node] ws closed: code=${code} reason=${reason.toString()}`);
  process.exit(code === 1000 ? 0 : 1);
});
ws.on("error", (err) => {
  console.error("[fake-node] ws error:", err.message);
  process.exit(1);
});
process.on("SIGTERM", () => {
  for (const { child } of workers.values()) child.kill("SIGKILL");
  for (const s of egress.values()) s.abort.abort();
  for (const sock of upstreamSockets.values()) sock.destroy();
  ws.close();
  process.exit(0);
});
