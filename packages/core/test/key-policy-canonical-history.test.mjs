// Canonical worker keys forward their history whole unless a layer names a historyPolicy (2026-11-05).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "1dayapi-canon-hist-"));
process.env.DATA_DIR = dir;
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
const { parseKeyPolicy, setSetting } = await import("../dist/index.js");

test("canonical workerMode defaults historyPolicy to passthrough; a named policy wins; legacy keeps reset", () => {
  assert.equal(parseKeyPolicy(null).historyPolicy, "reset");
  assert.equal(parseKeyPolicy(JSON.stringify({ auto: {}, override: { workerMode: "canonical" } })).historyPolicy, "passthrough");
  assert.equal(parseKeyPolicy(JSON.stringify({ auto: {}, override: { workerMode: "canonical", historyPolicy: "reset" } })).historyPolicy, "reset");
  assert.equal(parseKeyPolicy(JSON.stringify({ auto: {}, override: { workerMode: "canonical", historyPolicy: "reject" } })).historyPolicy, "reject");
  assert.equal(parseKeyPolicy(JSON.stringify({ auto: {}, override: { workerMode: "legacy" } })).historyPolicy, "reset");
  // auto layer: canonical only counts when the auto layer is in force
  const autoDoc = JSON.stringify({ auto: { workerMode: "canonical" }, override: {} });
  setSetting("key_policy_auto", "0");
  assert.equal(parseKeyPolicy(autoDoc).historyPolicy, "reset");
  setSetting("key_policy_auto", "1");
  assert.equal(parseKeyPolicy(autoDoc).historyPolicy, "passthrough");
  setSetting("key_policy_auto", "0");
});

test("worker_mode_default setting supplies the base workerMode; layers still win", () => {
  setSetting("worker_mode_default", "canonical");
  assert.equal(parseKeyPolicy(null).workerMode, "canonical");
  assert.equal(parseKeyPolicy(null).historyPolicy, "passthrough", "canonical default carries the passthrough default");
  assert.equal(parseKeyPolicy(JSON.stringify({ auto: {}, override: { workerMode: "legacy" } })).workerMode, "legacy");
  setSetting("worker_mode_default", "bogus");
  assert.equal(parseKeyPolicy(null).workerMode, "legacy", "unknown value falls back to legacy");
  setSetting("worker_mode_default", "legacy");
  assert.equal(parseKeyPolicy(null).historyPolicy, "reset");
});
