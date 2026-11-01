// 铁律 2 (docs/iron-rules.md): three-state upstream-visible switches resolved against the canary group.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "1dayapi-canary-"));
process.env.DATA_DIR = dir;
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
const core = await import("../dist/index.js");
const { featureFor, isCanaryGroup, isCanaryAccount, parseFeatureValue, defaultHistoryPolicy, parseKeyPolicy, setSetting, run } = core;

test("feature values: 0 / canary / 1, anything else reads as 0", () => {
  assert.equal(parseFeatureValue("1"), "1"); assert.equal(parseFeatureValue("canary"), "canary");
  assert.equal(parseFeatureValue("0"), "0"); assert.equal(parseFeatureValue("yes"), "0"); assert.equal(parseFeatureValue(undefined), "0");
});

test("defaults are the old behaviour: every upstream-visible switch is off, history policy reset", () => {
  for (const k of ["direct_cc_entrypoint_normalize", "direct_strip_user_email", "direct_cc_canonical_fields", "worker_prompt_hide_platform_path"]) {
    assert.equal(featureFor(k), false, k);
    assert.equal(featureFor(k, { groupId: "g-any", accountId: "a-any" }), false, k);
  }
  assert.equal(defaultHistoryPolicy(), "reset");
  assert.equal(parseKeyPolicy(null).historyPolicy, "reset");
});

test("canary tier: only the canary group's keys and accounts; 1 = everyone", () => {
  run("INSERT INTO groups(id,name) VALUES ('g-canary','灰度测试'),('g-other','other')");
  run("INSERT INTO accounts(id,name,platform,type,protocol,credential_enc) VALUES ('acc-c','c','anthropic','oauth','anthropic','x'),('acc-o','o','anthropic','oauth','anthropic','x')");
  run("INSERT INTO account_groups(account_id,group_id,priority) VALUES ('acc-c','g-canary',50),('acc-o','g-other',50)");
  setSetting("direct_strip_user_email", "canary");
  assert.equal(featureFor("direct_strip_user_email"), false, "no canary group configured → canary means off");
  setSetting("canary_group_id", "g-canary");
  assert.equal(isCanaryGroup("g-canary"), true); assert.equal(isCanaryGroup("g-other"), false);
  assert.equal(isCanaryAccount("acc-c"), true); assert.equal(isCanaryAccount("acc-o"), false);
  assert.equal(featureFor("direct_strip_user_email", { groupId: "g-canary" }), true);
  assert.equal(featureFor("direct_strip_user_email", { accountId: "acc-c" }), true);
  assert.equal(featureFor("direct_strip_user_email", { groupId: "g-other", accountId: "acc-o" }), false);
  assert.equal(featureFor("direct_strip_user_email"), false, "no context → not canary");
  setSetting("direct_strip_user_email", "1");
  assert.equal(featureFor("direct_strip_user_email", { groupId: "g-other" }), true);
  setSetting("direct_strip_user_email", "0");
  assert.equal(featureFor("direct_strip_user_email", { groupId: "g-canary" }), false);
});

test("history policy default and canary override come from settings", () => {
  setSetting("history_policy_default", "reject");
  assert.equal(defaultHistoryPolicy("g-other"), "reject");
  assert.equal(parseKeyPolicy(JSON.stringify({ directOnly: true }), "g-other").historyPolicy, "reject");
  setSetting("history_policy_canary", "passthrough");
  assert.equal(defaultHistoryPolicy("g-canary"), "passthrough");
  assert.equal(defaultHistoryPolicy("g-other"), "reject");
  assert.equal(parseKeyPolicy(JSON.stringify({ historyPolicy: "reset" }), "g-canary").historyPolicy, "reset", "explicit key policy always wins");
  setSetting("history_policy_default", "bogus");
  assert.equal(defaultHistoryPolicy("g-other"), "reset", "invalid setting → reset");
  setSetting("history_policy_default", "reset"); setSetting("history_policy_canary", "");
});
