// Claude Code 2.1.312 fingerprint constants and prompt-derived billing flag.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CC_VERSION, CC_RUNTIME_VERSION, CC_SDK_VERSION, CC_BETAS, CC_AUX_UA, ccBuildSuffix, ccBillingBlock, ccCanonicalBetas, normalizeCcSoftware, anthropicFingerprintHeaders } from "../dist/fingerprint.js";

const capturedPrompt = "Reply with the single word OK.";
const capturedMessages = [{ role: "user", content: [{ type: "text", text: capturedPrompt }] }];

test("2.1.312 constants and billing derivation match the official capture", () => {
  assert.equal(CC_VERSION, "2.1.312");
  assert.equal(CC_RUNTIME_VERSION, "v26.12.1", "Bun 1.4.4 runtime identifier");
  assert.equal(CC_SDK_VERSION, "0.128.0", "unchanged between 2.1.300 and 2.1.312");
  assert.equal(ccBuildSuffix(capturedMessages), "6b4");
  const withReminder = [{ role: "user", content: [{ type: "text", text: "<system-reminder>injected context</system-reminder>" }, { type: "text", text: capturedPrompt }] }];
  assert.equal(ccBuildSuffix(withReminder), "6b4", "injected reminder attachments are not the user's prompt");
  assert.equal(ccBillingBlock(capturedMessages), "x-anthropic-billing-header: cc_version=2.1.312.6b4; cc_entrypoint=cli;");
  assert.equal(CC_AUX_UA, "claude-code/2.1.312");
  assert.deepEqual(CC_BETAS, ["claude-code-20250219", "interleaved-thinking-2025-05-14", "context-management-2025-06-27", "thinking-token-count-2026-05-13"]);
  assert.ok(!CC_BETAS.includes("prompt-caching-scope-2026-01-05"), "2.1.312 no longer sends it (12/12 captures)");
});

test("billing flag varies with the first non-meta user text", () => {
  assert.equal(ccBuildSuffix([{ role: "user", content: "ping" }]), "0cd");
  assert.equal(ccBuildSuffix([{ role: "user", isMeta: true, content: capturedPrompt }]), "0cd");
  assert.notEqual(ccBuildSuffix(capturedMessages), ccBuildSuffix([{ role: "user", content: "a different prompt" }]));
});

test("canonical beta order: oauth right after claude-code, absent for API-key accounts", () => {
  assert.deepEqual(ccCanonicalBetas(true), ["claude-code-20250219", "oauth-2025-04-20", "interleaved-thinking-2025-05-14", "context-management-2025-06-27", "thinking-token-count-2026-05-13"]);
  assert.deepEqual(ccCanonicalBetas(false), CC_BETAS);
});

test("canonical header set advertises the 2.1.312 runtime and UA", () => {
  const h = anthropicFingerprintHeaders({ "user-agent": "curl/8.0" });
  assert.equal(h["user-agent"], "claude-cli/2.1.312 (external, cli)");
  assert.equal(h["x-stainless-runtime-version"], "v26.12.1");
  assert.equal(h["x-stainless-package-version"], "0.128.0");
});

test("version pin to the node's build recomputes the billing flag; other pins keep the client's flag", () => {
  const billing = (v) => ({ type: "text", text: `x-anthropic-billing-header: cc_version=${v}; cc_entrypoint=cli;` });
  const body = { system: [billing("2.1.300.f23"), { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }], messages: [] };
  const ua = { "user-agent": "claude-cli/2.1.300 (external, cli)" };
  const toNode = normalizeCcSoftware(ua, body, { normalizeEntrypoint: false, versionPin: "2.1.312" });
  assert.equal(toNode.headers["user-agent"], "claude-cli/2.1.312 (external, cli)");
  assert.equal(toNode.headers["x-stainless-runtime-version"], "v26.12.1");
  assert.equal(toNode.body.system[0].text, "x-anthropic-billing-header: cc_version=2.1.312.0cd; cc_entrypoint=cli;");
  const toOther = normalizeCcSoftware(ua, body, { normalizeEntrypoint: false, versionPin: "2.1.303" });
  assert.equal(toOther.body.system[0].text, "x-anthropic-billing-header: cc_version=2.1.303.f23; cc_entrypoint=cli;");
  const same = normalizeCcSoftware({ "user-agent": "claude-cli/2.1.312 (external, cli)" }, { system: [billing("2.1.312.6b4")] }, { normalizeEntrypoint: false, versionPin: "2.1.312" });
  assert.deepEqual(same.changed, [], "a client already on the node's version is untouched");
});
