// CCR session pool (docs/ccr-supply.md §5.3) — pure pool logic, plus
// CcrClient.archiveSession 200/409 semantics against a stub HTTP server.
// dist/ccr/client.js pulls in @1dayapi/core (opens the DB) — isolate DATA_DIR.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import assert from "node:assert/strict";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "1dayapi-gw-pool-"));
process.env.DATA_DIR = dir;
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

const { CcrSessionPool } = await import("../dist/ccr/session-pool.js");
const { CcrClient } = await import("../dist/ccr/client.js");

const mkPool = (opts = {}, cb = {}) => {
  const archived = [];
  const pool = new CcrSessionPool(
    { isAccountAlive: cb.alive ?? (() => true), archive: (e) => archived.push(e.sessionId) },
    { now: cb.now, ...opts },
  );
  return { pool, archived };
};

test("key match: same account+model+sticky reuses; different key misses; busy excluded", () => {
  const { pool } = mkPool();
  const e = pool.register("a1", "m1", "s:x", "cse_1", 4);
  pool.release(e, false);
  assert.equal(pool.acquire("a1", "m1", "s:x")?.sessionId, "cse_1", "exact key hits");
  assert.equal(pool.acquire("a1", "m1", "s:x"), null, "busy entry does not double-serve");
  pool.release(e, false);
  assert.equal(pool.acquire("a1", "m2", "s:x"), null, "model is part of the key");
  assert.equal(pool.acquire("a2", "m1", "s:x"), null, "account is part of the key");
  assert.equal(pool.stats.hit, 1);
});

test("pollution guard: requests without a sticky key never reuse", () => {
  const { pool } = mkPool();
  assert.equal(pool.acquire("a1", "m1", null), null);
  const e = pool.register("a1", "m1", null, "cse_stateless", 4);
  assert.equal(e, null, "stateless sessions stay unpooled");
  assert.equal(pool.size, 0);
  assert.equal(pool.stats.miss, 1);
});

test("turns cap retires + archives", () => {
  const { pool, archived } = mkPool({ maxTurns: 2 });
  const e = pool.register("a1", "m1", "s:x", "cse_1", 4);
  pool.release(e, false);
  assert.ok(pool.acquire("a1", "m1", "s:x"), "turn 2 still served");
  pool.release(e, false); // second turn completes -> maxTurns reached
  assert.equal(pool.size, 0, "retired at maxTurns");
  assert.deepEqual(archived, ["cse_1"]);
});

test("idle timeout retires on acquire and on sweep", () => {
  let now = 1_000_000;
  const { pool, archived } = mkPool({ idleMs: 30 * 60_000 }, { now: () => now });
  const e = pool.register("a1", "m1", "s:x", "cse_1", 4);
  pool.release(e, false);
  now += 29 * 60_000;
  assert.ok(pool.acquire("a1", "m1", "s:x"), "still warm at 29min");
  pool.release(e, false);
  now += 31 * 60_000;
  assert.equal(pool.acquire("a1", "m1", "s:x"), null, "idle >30min misses");
  pool.sweep();
  assert.deepEqual(archived, ["cse_1"], "sweep archives the idle entry");
});

test("error history retires; warm cap evicts LRU idle", () => {
  const { pool, archived } = mkPool();
  const bad = pool.register("a1", "m1", "s:bad", "cse_bad", 4);
  pool.release(bad, true);
  assert.equal(pool.size, 0);
  assert.deepEqual(archived, ["cse_bad"], "errored session archived");

  // warmCap 2: three sessions, LRU idle evicted on register
  const e1 = pool.register("a1", "m1", "s:1", "cse_1", 2);
  pool.release(e1, false);
  const e2 = pool.register("a1", "m1", "s:2", "cse_2", 2);
  pool.release(e2, false);
  pool.register("a1", "m1", "s:3", "cse_3", 2); // busy, counts toward the cap
  assert.equal(pool.size, 2);
  assert.ok(archived.includes("cse_1"), "oldest idle archived over the cap");
  assert.equal(pool.acquire("a1", "m1", "s:2")?.sessionId, "cse_2");
});

test("sweep archives every session of a deleted/disabled account", () => {
  const { pool, archived } = mkPool({}, { alive: (id) => id !== "a1" });
  const e1 = pool.register("a1", "m1", "s:1", "cse_1", 4);
  const e2 = pool.register("a2", "m1", "s:2", "cse_2", 4);
  pool.release(e1, false);
  pool.release(e2, false);
  pool.sweep();
  assert.deepEqual(archived, ["cse_1"], "only the dead account's sessions archived");
  assert.equal(pool.size, 1);
});

test("archiveSession: 200 and 409 both succeed; 500 throws", async () => {
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push(req.url);
    const first = seen.length === 1;
    res.writeHead(first ? 200 : seen.length === 2 ? 409 : 500, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  const client = new CcrClient({ baseUrl: `http://127.0.0.1:${port}`, cred: { accessToken: "t" }, clientHeaders: {}, timeoutMs: 5000 });
  await client.archiveSession("cse_1"); // 200
  await client.archiveSession("cse_1"); // 409 = already archived, still success
  assert.ok(seen[0].endsWith("/v1/code/sessions/cse_1/archive"), seen[0]);
  await assert.rejects(client.archiveSession("cse_2"), /HTTP 500/);
  srv.close();
});
