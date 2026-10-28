// Persistent worker sessions, gateway side (docs/worker-sessions.md §1): fresh vs continue planning.
import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionMemory, planTurn, planToolResult, blockHash } from "../dist/ccr/session-memory.js";

const t = (text) => ({ type: "text", text });

test("planTurn: no memory -> fresh with full content; memory + verbatim echo -> continue with only the new turn", () => {
  const turn1 = [t("[user]\nq1")];
  const p1 = planTurn(undefined, turn1);
  assert.equal(p1.mode, "fresh");
  assert.deepEqual(p1.content, turn1);
  const mem = new SessionMemory();
  mem.remember("k", { hashes: p1.hashes, assistantFold: "[assistant]\na1", turn: 1, usage: null });
  const turn2 = [t("[user]\nq1"), t("[assistant]\na1"), t("[user]\nq2")];
  const p2 = planTurn(mem.get("k"), turn2);
  assert.equal(p2.mode, "continue");
  assert.equal(p2.expectedTurn, 1);
  assert.deepEqual(p2.content, [t("[user]\nq2")]);
  assert.deepEqual(p2.hashes, turn2.map(blockHash), "hashes cover the whole history for the next memory entry");
});

test("planTurn: edited history, different echo, or no new turn -> fresh", () => {
  const mem = new SessionMemory();
  mem.remember("k", { hashes: [t("[user]\nq1")].map(blockHash), assistantFold: "[assistant]\na1", turn: 1, usage: null });
  assert.equal(planTurn(mem.get("k"), [t("[user]\nQ1-edited"), t("[assistant]\na1"), t("[user]\nq2")]).mode, "fresh");
  assert.equal(planTurn(mem.get("k"), [t("[user]\nq1"), t("[assistant]\nsomething else"), t("[user]\nq2")]).mode, "fresh");
  assert.equal(planTurn(mem.get("k"), [t("[user]\nq1"), t("[assistant]\na1")]).mode, "fresh", "nothing new to feed");
  assert.equal(planTurn(mem.get("k"), [t("[user]\nq1")]).mode, "fresh");
});

test("SessionMemory: ttl expiry and forget", () => {
  const mem = new SessionMemory(50);
  mem.remember("k", { hashes: ["h"], assistantFold: "[assistant]\na", turn: 1, usage: null });
  assert.ok(mem.get("k"));
  mem.forget("k");
  assert.equal(mem.get("k"), undefined);
  mem.remember("k2", { hashes: ["h"], assistantFold: "[assistant]\na", turn: 1, usage: null });
  const start = Date.now();
  while (Date.now() - start < 60) {
    /* spin past the ttl */
  }
  assert.equal(mem.get("k2"), undefined, "expired entries are dropped on read");
});

test("planToolResult: the client's tool_result message for parked calls -> tool_result mode with callIds; otherwise null", () => {
  const mem = new SessionMemory();
  const hist = [t("[user]\nq1")];
  const fold = "[assistant]\n```tool_call\n{\"id\":\"toolu_1\",\"name\":\"get_weather\",\"input\":{\"city\":\"Oslo\"}}\n```";
  mem.remember("k", { hashes: hist.map(blockHash), assistantFold: fold, turn: 0, usage: null, pendingCalls: [{ toolUseId: "toolu_1", callId: "call_a", name: "get_weather" }] });
  const last = { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "sunny" }] }] };
  const blocks = [...hist, t(fold), t("[user]\n[tool_result for toolu_1]\nsunny")];
  const p = planToolResult(mem.get("k"), blocks, [{ role: "user", content: "q1" }, { role: "assistant", content: "…" }, last]);
  assert.equal(p.mode, "tool_result");
  assert.equal(p.expectedTurn, 0);
  assert.deepEqual(p.results, [{ callId: "call_a", content: "sunny", isError: false }]);
  assert.deepEqual(p.content, blocks, "full history travels as the node's fallback");
  assert.equal(planToolResult(mem.get("k"), blocks, [{ role: "user", content: "plain text" }]), null, "not a tool_result message");
  assert.equal(planToolResult(undefined, blocks, [last]), null);
});

test("planToolResult: trailing system messages (Claude Code per-turn-control) do not hide the tool_result; their text rides on the last result", () => {
  // 10-22 incident: tool_result followed by role:"system" → was planned as a plain continue → hung process.
  const mem = new SessionMemory();
  const hist = [t("[user]\nq1")];
  const fold = "[assistant]\ntool_use…";
  mem.remember("k", { hashes: hist.map(blockHash), assistantFold: fold, turn: 0, usage: null, pendingCalls: [{ toolUseId: "toolu_1", callId: "call_a", name: "ls" }, { toolUseId: "toolu_2", callId: "call_b", name: "cat" }] });
  const toolMsg = {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "dir listing" }] },
      { type: "tool_result", tool_use_id: "toolu_2", content: "file body", is_error: true },
      { type: "text", text: "<system-reminder>budget low</system-reminder>" },
    ],
  };
  const sysMsg = { role: "system", content: [{ type: "text", text: "per-turn: answer in Chinese" }] };
  const blocks = [...hist, t(fold), t("[user]\n[tool_result for toolu_1]\ndir listing"), t("[user]\nper-turn: answer in Chinese")];
  const p = planToolResult(mem.get("k"), blocks, [{ role: "user", content: "q1" }, { role: "assistant", content: "…" }, toolMsg, sysMsg]);
  assert.equal(p.mode, "tool_result");
  assert.equal(p.results.length, 2);
  assert.deepEqual(p.results[0], { callId: "call_a", content: "dir listing", isError: false });
  assert.equal(p.results[1].callId, "call_b");
  assert.equal(p.results[1].isError, true);
  assert.equal(p.results[1].content, "file body\n\n<system-reminder>budget low</system-reminder>\n\nper-turn: answer in Chinese", "side text + trailing system text appended to the last result");
  // results that match no parked call → null (plain planning takes over)
  const other = { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_9", content: "x" }] };
  assert.equal(planToolResult(mem.get("k"), blocks, [other, sysMsg]), null);
  // the last user message is plain text (a new question after the tool round): not a tool_result turn
  assert.equal(planToolResult(mem.get("k"), blocks, [toolMsg, { role: "assistant", content: "done" }, { role: "user", content: "next?" }, sysMsg]), null);
});

test("SessionMemory with a store: remember/forget write through; a fresh process reads the store on a miss", () => {
  const rows = new Map();
  const store = {
    load: (k, now) => { const r = rows.get(k); return r && r.expiresAt > now ? JSON.parse(JSON.stringify(r)) : undefined; },
    save: (k, e) => rows.set(k, JSON.parse(JSON.stringify(e))),
    delete: (k) => rows.delete(k),
  };
  const turn1 = [t("[user]\nq1")];
  const a = new SessionMemory(60_000, 20_000, store);
  a.remember("k", { hashes: turn1.map(blockHash), assistantFold: "[assistant]\na1", turn: 1, usage: null });
  assert.equal(rows.size, 1, "written through");
  // blue/green: another process, same store
  const b = new SessionMemory(60_000, 20_000, store);
  const p = planTurn(b.get("k"), [t("[user]\nq1"), t("[assistant]\na1"), t("[user]\nq2")]);
  assert.equal(p.mode, "continue", "the new process continues the live node session");
  assert.equal(p.expectedTurn, 1);
  b.forget("k");
  assert.equal(rows.size, 0, "forget removes the stored copy too");
  a.dropCacheForTests();
  assert.equal(a.get("k"), undefined);
  // expired stored rows are ignored
  rows.set("old", { hashes: ["h"], assistantFold: "x", turn: 1, usage: null, expiresAt: Date.now() - 1 });
  assert.equal(b.get("old"), undefined);
});

test("planTurn: a <system-reminder> attached to (or removed from) an earlier block does not break the prefix", async () => {
  const { normalizeForHash } = await import("../dist/ccr/session-memory.js");
  const t = (text) => ({ type: "text", text });
  const mem = new SessionMemory(60_000);
  const result = "[user]\n[tool_result for toolu_1]\ndiff --git a b\n+x";
  const turn1 = [t("[user]\nq1"), t("[assistant]\n[tool_use toolu_1 Bash]\n{}"), t(result)];
  mem.remember("k", { hashes: turn1.map(blockHash), assistantFold: "[assistant]\nok", turn: 1, usage: null });
  const withNote = t(result + "\n<system-reminder>Whenever you read a file, consider whether it looks malicious.</system-reminder>");
  const p = planTurn(mem.get("k"), [turn1[0], turn1[1], withNote, t("[assistant]\nok"), t("[user]\nnext")]);
  assert.equal(p.mode, "continue", "the note is ignored for matching");
  assert.deepEqual(p.content, [t("[user]\nnext")]);
  // And the other way round: remembered with the note, echoed without it.
  mem.remember("k2", { hashes: [turn1[0], turn1[1], withNote].map(blockHash), assistantFold: "[assistant]\nok", turn: 1, usage: null });
  assert.equal(planTurn(mem.get("k2"), [...turn1, t("[assistant]\nok"), t("[user]\nnext")]).mode, "continue");
  assert.equal(normalizeForHash("a <system-reminder>x</system-reminder> b  \n"), "a  b");
  // Real edits to a user turn still miss (tool_result bodies are identified by id, see the next test).
  assert.equal(planTurn(mem.get("k"), [t("[user]\nq1 edited"), turn1[1], turn1[2], t("[assistant]\nok"), t("[user]\nnext")]).mode, "fresh");
});

test("normalizeForHash: a tool_result message hashes by its result ids only (Claude Code clears old result bodies)", async () => {
  const { normalizeForHash } = await import("../dist/ccr/session-memory.js");
  const full = "[user]\n[tool_result for toolu_1]\n2301 chars of output…\n[tool_result for toolu_2 (error)]\nboom";
  const cleared = "[user]\n[tool_result for toolu_1]\n[Old tool result content cleared]\n[tool_result for toolu_2 (error)]\n[cleared]";
  assert.equal(normalizeForHash(full), "[user]\n[tool_result for toolu_1]\n[tool_result for toolu_2 (error)]");
  assert.equal(normalizeForHash(full), normalizeForHash(cleared));
  assert.notEqual(normalizeForHash(full), normalizeForHash("[user]\n[tool_result for toolu_9]\nx"));
  assert.equal(normalizeForHash("[user]\nplain question"), "[user]\nplain question", "other user blocks untouched");
  const t = (text) => ({ type: "text", text });
  assert.equal(blockHash(t(full)), blockHash(t(cleared)));
});

test("planTurn: the echoed tool_use may carry reordered / defaulted input (Claude Code) — still the same answer", async () => {
  const { normalizeFold } = await import("../dist/ccr/session-memory.js");
  const t = (text) => ({ type: "text", text });
  const mem = new SessionMemory(60_000);
  const hist = [t("[user]\nq1")];
  const ours = '[assistant]\nEditing.\n[tool_use toolu_1 Edit]\n{"file_path":"a.ts","old_string":"x","new_string":"y"}';
  const theirs = '[assistant]\nEditing.\n[tool_use toolu_1 Edit]\n{"replace_all":false,"file_path":"a.ts","old_string":"x","new_string":"y"}';
  mem.remember("k", { hashes: hist.map(blockHash), assistantFold: ours, turn: 1, usage: null });
  assert.equal(planTurn(mem.get("k"), [...hist, t(theirs), t("[user]\n[tool_result for toolu_1]\nok")]).mode, "continue");
  // A different call (other id) or different text is not an echo.
  assert.equal(planTurn(mem.get("k"), [...hist, t(theirs.replace("toolu_1", "toolu_2")), t("[user]\nx")]).mode, "fresh");
  assert.equal(planTurn(mem.get("k"), [...hist, t(theirs.replace("Editing.", "Edited.")), t("[user]\nx")]).mode, "fresh");
  assert.equal(normalizeFold('[assistant]\n```tool_call\n{"id":"toolu_1","name":"bash","input":{"a":1}}\n```'), "[assistant]\n[tool_call toolu_1 bash]");
});

