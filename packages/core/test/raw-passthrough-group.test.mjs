// Raw passthrough relay groups (gateway.md §4a, user rule 2026-10-26): a group whose schedulable
// accounts are all relays is judged by nobody but the relay — unknown model ids are still routed.
// Temp DATA_DIR, real migrations.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "1dayapi-core-raw-group-"));
process.env.DATA_DIR = dir;
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

const { run, groupIsRawPassthrough, supportsModel, listCandidates } = await import("../dist/index.js");

function mkAccount(id, raw, extra = {}) {
  const { status = "active", review = "approved", models = null } = extra;
  run(
    `INSERT INTO accounts (id, name, platform, type, protocol, base_url, credential_enc, models, raw_passthrough, status, review_status)
     VALUES (?, ?, 'anthropic', 'upstream', 'anthropic', 'https://relay.example/api', 'x', ?, ?, ?, ?)`,
    id, id, models, raw ? 1 : 0, status, review,
  );
}
function mkGroup(id, ...accountIds) {
  run("INSERT INTO groups (id, name) VALUES (?, ?)", id, id);
  for (const a of accountIds) run("INSERT INTO account_groups (account_id, group_id, priority) VALUES (?, ?, 50)", a, id);
}

mkAccount("relay1", true);
mkAccount("relay2", true);
mkAccount("relay-off", true, { status: "disabled" });
mkAccount("plain", false);
mkAccount("relay-pending", true, { review: "pending" });
mkGroup("g-raw", "relay1", "relay2", "relay-off");
mkGroup("g-mixed", "relay1", "plain");
mkGroup("g-plain", "plain");
mkGroup("g-empty");
mkGroup("g-pending-only", "relay-pending");

test("groupIsRawPassthrough: every schedulable account must be a relay", () => {
  assert.equal(groupIsRawPassthrough("g-raw"), true, "two active relays (a disabled one does not count)");
  assert.equal(groupIsRawPassthrough("g-mixed"), false, "a normal account in the group keeps the normal path");
  assert.equal(groupIsRawPassthrough("g-plain"), false);
  assert.equal(groupIsRawPassthrough("g-empty"), false, "nothing schedulable → not a raw group");
  assert.equal(groupIsRawPassthrough("g-pending-only"), false, "pending accounts are not schedulable");
  assert.equal(groupIsRawPassthrough("no-such-group"), false);
});

test("supportsModel: a relay without a model list serves any model id; a model list still filters", () => {
  const relay = { models: null, platform: "anthropic", raw_passthrough: 1 };
  assert.equal(supportsModel(relay, "claude-opus-5-5"), true);
  assert.equal(supportsModel(relay, "brand-new-model-2027"), true, "unknown to our catalog, still routed");
  assert.equal(supportsModel({ ...relay, raw_passthrough: 0 }, "brand-new-model-2027"), false, "normal account: catalog platform must match");
  assert.equal(supportsModel({ ...relay, models: JSON.stringify(["claude-*"]) }, "gpt-5.5"), false, "explicit list wins");
});

test("listCandidates routes an unknown model to the relay group", () => {
  const ids = listCandidates("g-raw", "brand-new-model-2027").map((a) => a.id).sort();
  assert.deepEqual(ids, ["relay1", "relay2"]);
  assert.deepEqual(listCandidates("g-plain", "brand-new-model-2027"), [], "normal account does not serve an unknown model");
});
