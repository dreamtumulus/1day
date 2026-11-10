// X-56 (2026-11-10): a conversation that left for another upstream and came back with more history must not be
// continued on the live canonical session with its last message alone (customer report: the turns in between were
// dropped, HTTP 200, reported input the size of turn 1).
import test from "node:test";
import assert from "node:assert/strict";
import { planTurn, blockHash } from "../dist/ccr/session-memory.js";
import { closeContinueGap } from "../dist/ccr/worker.js";

const t = (text) => ({ type: "text", text });
const turn1 = [t("user: remember the code X2-COBALT-05")];
const mem = { hashes: turn1.map(blockHash), assistantFold: "OK", turn: 1, expiresAt: Date.now() + 60_000 };

test("one new turn after the remembered answer stays a continue", () => {
  const blocks = [...turn1, t("OK"), t("user: what was the code?")];
  const plan = closeContinueGap(planTurn(mem, blocks), blocks);
  assert.equal(plan.mode, "continue");
  assert.equal(plan.content.length, 1);
});

test("history that grew elsewhere opens fresh over the whole conversation", () => {
  const blocks = [...turn1, t("OK"), t("user: elsewhere 1"), t("assistant: elsewhere answer 1"), t("user: elsewhere 2"), t("assistant: elsewhere answer 2"), t("user: what was the code in the first message?")];
  const raw = planTurn(mem, blocks);
  assert.equal(raw.mode, "continue", "the prefix and the echo still match: the planner alone calls it a continue");
  const plan = closeContinueGap(raw, blocks);
  assert.equal(plan.mode, "fresh");
  assert.equal(plan.reason, "continue_gap:4");
  assert.deepEqual(plan.content, blocks, "the whole conversation is what gets sent");
  assert.deepEqual(plan.hashes, raw.hashes);
});

test("fresh and tool_result plans pass through untouched", () => {
  const fresh = planTurn(undefined, turn1);
  assert.equal(closeContinueGap(fresh, turn1), fresh);
  const tr = { mode: "tool_result", content: [t("a"), t("b")], hashes: [] };
  assert.equal(closeContinueGap(tr, []), tr);
});
