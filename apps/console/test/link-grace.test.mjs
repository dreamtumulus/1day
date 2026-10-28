// Link grace (docs/provider-protocol.md, 2026-10-19): a node whose control socket drops keeps its
// open tunnel sessions for NODE_LINK_GRACE_MS; frames written meanwhile are queued and flushed when
// the same node reconnects and names the session in its hello. Fake sockets, real registry + DB.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "1dayapi-link-grace-"));
process.env.DATA_DIR = dir;
process.env.ALLOW_UNTRUSTED_EXECUTION="1";
process.env.CCR_WINDOW_POLL = "0";
process.env.NODE_LINK_GRACE_MS = "400";
process.env.NODE_WAIT_MS = "0";
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

const core = await import("@1dayapi/core");
const { buildApp } = await import("../dist/app.js");
await buildApp(); // migrations + seed
const { createUser } = await import("../dist/session.js");
const reg = await import("../dist/node/registry.js");
const { run } = core;

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent = [];
  send(s) {
    this.sent.push(JSON.parse(s));
  }
  ping() {}
  terminate() {
    this.readyState = 3;
    this.emit("close");
  }
  close() {
    this.readyState = 3;
  }
  /** What the node would send: deliver a frame to the registry. */
  fromNode(msg) {
    this.emit("message", Buffer.from(JSON.stringify(msg)));
  }
  frames(type) {
    return this.sent.filter((m) => m.type === type);
  }
}

const providerId = createUser("provider", "grace-provider").id;
const now = core.nowIso();
let seq = 0;
function newNode() {
  const nodeId = `node_grace_${++seq}`;
  run("INSERT INTO nodes (node_id, provider_id, secret_hash, online, accepting_sessions, created_at) VALUES (?, ?, ?, 1, 1, ?)", nodeId, providerId, core.sha256Hex("s"), now);
  return nodeId;
}
function connect(nodeId, sessions) {
  const sock = new FakeSocket();
  reg.attachNode(nodeId, providerId, sock);
  sock.fromNode({ type: "provider.hello", nodeId, nodeVersion: "test", capabilities: [], acceptingSessions: true, ...(sessions ? { sessions } : {}) });
  return sock;
}
async function openOn(nodeId, sock) {
  const p = reg.openEgressOnNode(nodeId, "proxy1", "binding1");
  await new Promise((r) => setTimeout(r, 10));
  const open = sock.frames("http_egress.open").at(-1);
  assert.ok(open, "open frame reached the node");
  sock.fromNode({ type: "http_egress.open_response", sessionId: open.sessionId, accepted: true });
  const opened = await p;
  assert.ok(opened, "session opened");
  return opened.sessionId;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("session survives a short link loss: writes are queued and flushed, node data continues", async () => {
  const nodeId = newNode();
  const s1 = connect(nodeId);
  assert.equal(s1.frames("platform.ready").length, 1);
  const sid = await openOn(nodeId, s1);

  s1.terminate(); // link drops
  assert.equal(reg.isNodeOnline(nodeId), false);
  assert.equal(reg.writeTunnel(sid, Buffer.from("spec-line\n")), true, "write during grace is accepted (queued)");

  const s2 = connect(nodeId, [sid]); // node back within grace, still running the session
  const ready = s2.frames("platform.ready")[0];
  assert.deepEqual(ready.retainedSessions, [sid]);
  const flushed = s2.frames("http_egress.data");
  assert.equal(flushed.length, 1, "queued frame flushed on the new socket");
  assert.equal(Buffer.from(flushed[0].payloadBase64, "base64").toString(), "spec-line\n");

  s2.fromNode({ type: "http_egress.data", sessionId: sid, seq: 0, payloadBase64: Buffer.from("hello").toString("base64") });
  const r = await reg.readTunnel(sid, 50);
  assert.equal(r.closed, false);
  assert.equal(Buffer.from(r.chunks[0].payloadBase64, "base64").toString(), "hello");
  reg.closeTunnel(sid, "test_done");
});

test("node that lost the session (or an old bundle without the list) → session fails on reconnect", async () => {
  const nodeId = newNode();
  const s1 = connect(nodeId);
  const a = await openOn(nodeId, s1);
  const b = await openOn(nodeId, s1);
  s1.terminate();
  const s2 = connect(nodeId, [a]); // b is gone on the node
  assert.deepEqual(s2.frames("platform.ready")[0].retainedSessions, [a]);
  const rb = await reg.readTunnel(b, 50);
  assert.equal(rb.closed, true);
  assert.equal(rb.error, "node_lost_session");
  const ra = await reg.readTunnel(a, 20);
  assert.equal(ra.closed, false);
  reg.closeTunnel(a, "test_done");

  const nodeId2 = newNode();
  const t1 = connect(nodeId2);
  const c = await openOn(nodeId2, t1);
  t1.terminate();
  connect(nodeId2); // older bundle: no `sessions` in hello
  const rc = await reg.readTunnel(c, 50);
  assert.equal(rc.closed, true);
  assert.equal(rc.error, "node_reconnected");
});

test("grace expiry fails the held sessions with node_disconnected", async () => {
  const nodeId = newNode();
  const s1 = connect(nodeId);
  const sid = await openOn(nodeId, s1);
  s1.terminate();
  const early = await reg.readTunnel(sid, 20);
  assert.equal(early.closed, false, "still held right after the drop");
  await sleep(500);
  const late = await reg.readTunnel(sid, 20);
  assert.equal(late.closed, true);
  assert.equal(late.error, "node_disconnected");
  assert.equal(reg.writeTunnel(sid, Buffer.from("x")), false);
});
