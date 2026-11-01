// Claude Code request-shape gate (docs/gateway.md §2a). Pure, against dist/.
import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyCcRequest, parseCcShapePolicy, ccMinVersionForModel, compareVersions } from "../dist/cc-shape.js";

const UA = "claude-cli/2.1.300 (external, cli)";
const genuineHeaders = {
  "user-agent": UA,
  "x-app": "cli",
  "anthropic-beta": "claude-code-20250219,interleaved-thinking-2025-05-14,oauth-2025-04-20",
  "anthropic-version": "2023-06-01",
  accept: "application/json",
  "x-stainless-lang": "js",
  "x-stainless-runtime": "node",
  "x-stainless-runtime-version": "v26.3.0",
  "x-stainless-package-version": "0.128.0",
  "x-claude-code-session-id": "3f2c1a4e-5b6d-4c7e-8f90-a1b2c3d4e5f6",
};
const userId = JSON.stringify({ device_id: "a".repeat(64), account_uuid: "", session_id: "3f2c1a4e-5b6d-4c7e-8f90-a1b2c3d4e5f6" });
const genuineBody = {
  model: "claude-sonnet-5-5",
  messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }],
  system: [
    { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.300.f23; cc_entrypoint=cli;" },
    { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude.", cache_control: { type: "ephemeral" } },
    { type: "text", text: "x".repeat(5000), cache_control: { type: "ephemeral" } },
  ],
  tools: [{ name: "Agent" }, { name: "Bash" }, { name: "Read" }],
  metadata: { user_id: userId },
  max_tokens: 32000,
  thinking: { type: "enabled", budget_tokens: 31999 },
  context_management: { edits: [] },
  stream: true,
};

test("canonical Claude Code request is genuine with no soft drift", () => {
  const r = classifyCcRequest(genuineHeaders, genuineBody);
  assert.equal(r.verdict, "genuine");
  assert.equal(r.version, "2.1.300");
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.soft, []);
});

test("non-CC user agent is not_cc and untouched", () => {
  assert.equal(classifyCcRequest({ "user-agent": "curl/8.5.0" }, genuineBody).verdict, "not_cc");
  assert.equal(classifyCcRequest({}, genuineBody).verdict, "not_cc");
  assert.equal(classifyCcRequest({ "user-agent": "x-claude-cli/2.1.300" }, genuineBody).verdict, "not_cc", "anchored at start");
});

test("UA-only forgery (the 2026-10-16 probe) is suspect with every hard check missing", () => {
  const r = classifyCcRequest({ "user-agent": UA, "anthropic-version": "2023-06-01" }, { model: "claude-sonnet-5-5", max_tokens: 16, messages: [{ role: "user", content: "hi" }] });
  assert.equal(r.verdict, "suspect");
  assert.deepEqual(r.missing.sort(), ["accept_json", "beta_claude_code", "billing_header", "metadata_user_id", "session_id_header", "stainless_js_node", "stainless_package_version", "stainless_runtime_version", "x_app_cli"]);
});

test("each hard check is individually enforced", () => {
  const miss = (h, b) => classifyCcRequest({ ...genuineHeaders, ...h }, { ...genuineBody, ...b }).missing;
  assert.deepEqual(miss({ "x-app": "web" }, {}), ["x_app_cli"]);
  assert.deepEqual(miss({ "anthropic-beta": "oauth-2025-04-20" }, {}), ["beta_claude_code"]);
  assert.deepEqual(miss({}, { system: "be terse" }), ["billing_header"]);
  assert.deepEqual(miss({}, { system: [{ type: "text", text: "You are Claude Code" }] }), ["billing_header"]);
  assert.deepEqual(miss({}, { system: [{ type: "text", text: "x-anthropic-billing-header: cc_version=2.1.241.f10; cc_entrypoint=cli;" }, ...genuineBody.system.slice(1)] }), ["billing_version_mismatch"]);
  assert.deepEqual(miss({}, { metadata: {} }), ["metadata_user_id"]);
  assert.deepEqual(miss({}, { metadata: { user_id: "user_abc_session_123" } }), ["metadata_user_id"], "legacy concatenated format is not the current shape");
  assert.deepEqual(miss({}, { metadata: { user_id: JSON.stringify({ device_id: "short", session_id: "nope" }) } }), ["metadata_user_id"]);
});

test("soft checks are reported but never change the verdict", () => {
  const r = classifyCcRequest(genuineHeaders, { ...genuineBody, stream: false, thinking: undefined, tools: [{ name: "Read" }, { name: "Bash", strict: true }] });
  assert.equal(r.verdict, "genuine");
  assert.deepEqual(r.soft.sort(), ["stream_true", "thinking", "tools_no_strict", "tools_sorted"]);
});

test("transport fingerprint is hard since 2026-10-19: foreign runtime / accept / version / session header → suspect", () => {
  const miss = (h, b = {}) => classifyCcRequest({ ...genuineHeaders, ...h }, { ...genuineBody, ...b }).missing.sort();
  assert.deepEqual(miss({ "x-stainless-runtime": "bun", accept: "*/*" }), ["accept_json", "stainless_js_node"]);
  assert.deepEqual(miss({ "x-stainless-lang": "python" }), ["stainless_js_node"]);
  assert.deepEqual(miss({ "anthropic-version": "2024-01-01" }), ["anthropic_version"]);
  assert.deepEqual(miss({ "x-claude-code-session-id": "" }), ["session_id_header"]);
  assert.deepEqual(miss({ "x-claude-code-session-id": "11111111-2222-4333-8444-555555555555" }), ["session_id_mismatch"], "header must match metadata.user_id.session_id");
  // header absent from the fixture entirely
  const { "x-claude-code-session-id": _drop, ...noSession } = genuineHeaders;
  assert.deepEqual(classifyCcRequest(noSession, genuineBody).missing, ["session_id_header"]);
});

test("Anthropic's per-model minimum Claude Code version is enforced before the direct path", () => {
  const ua = (v) => ({ ...genuineHeaders, "user-agent": `claude-cli/${v} (external, cli)` });
  const bill = (v, model) => ({ ...genuineBody, model, system: [{ type: "text", text: `x-anthropic-billing-header: cc_version=${v}.f1; cc_entrypoint=cli;` }, ...genuineBody.system.slice(1)] });
  assert.deepEqual(classifyCcRequest(ua("2.1.266"), bill("2.1.266", "claude-opus-5-5")).missing, ["version_below_model_minimum"]);
  assert.deepEqual(classifyCcRequest(ua("2.1.266"), bill("2.1.266", "claude-opus-5-5-20260901")).missing, ["version_below_model_minimum"], "dated snapshot shares the gate");
  assert.deepEqual(classifyCcRequest(ua("2.1.280"), bill("2.1.280", "claude-opus-5-5")).missing, []);
  assert.deepEqual(classifyCcRequest(ua("2.1.237"), bill("2.1.237", "claude-fable-5-1")).missing, ["version_below_model_minimum"]);
  assert.deepEqual(classifyCcRequest(ua("2.1.237"), bill("2.1.237", "claude-fable-5")).missing, [], "no gate known for fable-5");
  assert.deepEqual(classifyCcRequest(ua("2.1.266"), bill("2.1.266", "claude-sonnet-5-5")).missing, []);
  assert.equal(ccMinVersionForModel("claude-opus-5-5"), "2.1.280");
  assert.equal(ccMinVersionForModel("claude-opus-5"), null, "prefix match must not bleed into other ids");
  assert.ok(compareVersions("2.1.9", "2.1.10") < 0);
  assert.ok(compareVersions("2.2.0", "2.1.300") > 0);
  assert.equal(compareVersions("2.1.300", "2.1.300"), 0);
});

test("a newer CC build with a different beta list and prompt still passes the hard checks", () => {
  const r = classifyCcRequest(
    { ...genuineHeaders, "user-agent": "claude-cli/2.3.0 (external, sdk-cli, agent-sdk/0.9.0)", "anthropic-beta": "claude-code-20250219,effort-2025-11-24", "x-stainless-runtime-version": "v26.0.0", "x-stainless-package-version": "0.129.0" },
    { ...genuineBody, system: [{ type: "text", text: "x-anthropic-billing-header: cc_version=2.3.0.a1; cc_entrypoint=sdk-cli;" }, { type: "text", text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." }] },
  );
  assert.equal(r.verdict, "genuine");
  assert.equal(r.version, "2.3.0");
  assert.ok(r.soft.includes("main_prompt_cached"));
});

const official312Headers = {
  ...genuineHeaders,
  "user-agent": "claude-cli/2.1.312 (external, sdk-cli)",
  "x-stainless-runtime-version": "v26.12.1",
};
const official312Body = {
  ...genuineBody,
  messages: [{ role: "user", content: "Reply with the single word OK." }],
  system: [
    { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.312.6b4; cc_entrypoint=sdk-cli;" },
    { type: "text", text: "You are a Claude agent, built on Anthropic's Claude Agent SDK.", cache_control: { type: "ephemeral" } },
    genuineBody.system[2],
  ],
};

test("official CC 2.1.312 sdk-cli shape, including the prompt-derived suffix, is genuine", () => {
  const r = classifyCcRequest(official312Headers, official312Body);
  assert.equal(r.verdict, "genuine");
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.soft, []);
});

test("2.1.312 identity, entrypoint, runtime, suffix, stream and UUID consistency are hard checks", () => {
  const miss = (h, b) => classifyCcRequest({ ...official312Headers, ...h }, { ...official312Body, ...b }).missing.sort();
  assert.deepEqual(miss({}, { system: official312Body.system.filter((_, i) => i !== 1) }), ["identity_block"]);
  assert.deepEqual(miss({}, { system: official312Body.system.map((b, i) => i === 0 ? { ...b, text: b.text.replace("cc_entrypoint=sdk-cli", "cc_entrypoint=made-up") } : b) }), ["entrypoint_mismatch"]);
  assert.deepEqual(miss({ "x-stainless-runtime-version": "v20.0.0" }, {}), ["stainless_runtime_version"]);
  assert.deepEqual(miss({ "x-stainless-package-version": "0.120.0" }, {}), ["stainless_package_version"]);
  assert.deepEqual(miss({}, { system: official312Body.system.map((b, i) => i === 0 ? { ...b, text: b.text.replace("2.1.312.6b4", "2.1.312.foo") } : b) }), ["billing_suffix"]);
  assert.deepEqual(miss({}, { stream: false }), ["stream_true"]);
  const v1 = "550e8400-e29b-11d4-a716-446655440000";
  const uid = JSON.parse(official312Body.metadata.user_id);
  uid.session_id = v1;
  assert.deepEqual(miss({ "x-claude-code-session-id": v1 }, { metadata: { user_id: JSON.stringify(uid) } }), ["metadata_user_id", "session_id_header"]);
});

test("sdk-cli accepts the append-system identity, while mismatched and missing entrypoints are rejected", () => {
  const appended = official312Body.system.map((b, i) => i === 1 ? { ...b, text: "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK." } : b);
  assert.deepEqual(classifyCcRequest(official312Headers, { ...official312Body, system: appended }).missing, []);
  const wrongIdentity = official312Body.system.map((b, i) => i === 1 ? { ...b, text: "You are Claude Code, Anthropic's official CLI for Claude." } : b);
  assert.deepEqual(classifyCcRequest(official312Headers, { ...official312Body, system: wrongIdentity }).missing, ["identity_block"]);
  const unknownUa = { ...official312Headers, "user-agent": "claude-cli/2.1.312 (external, made-up)" };
  const unknownBilling = official312Body.system.map((b, i) => i === 0 ? { ...b, text: b.text.replace("cc_entrypoint=sdk-cli", "cc_entrypoint=made-up") } : b);
  assert.deepEqual(classifyCcRequest(unknownUa, { ...official312Body, system: unknownBilling }).missing, ["ua_entrypoint"]);
  const noBillingEntrypoint = official312Body.system.map((b, i) => i === 0 ? { ...b, text: b.text.replace("cc_entrypoint=sdk-cli;", "") } : b);
  assert.deepEqual(classifyCcRequest(official312Headers, { ...official312Body, system: noBillingEntrypoint }).missing, ["billing_entrypoint"]);
});

test("policy parsing defaults to observe", () => {
  assert.equal(parseCcShapePolicy("downgrade"), "downgrade");
  assert.equal(parseCcShapePolicy("reject"), "reject");
  assert.equal(parseCcShapePolicy("bogus"), "observe");
  assert.equal(parseCcShapePolicy(undefined), "observe");
});

test("custom entrypoint: hard-rejected by default, admitted as soft `ua_entrypoint_custom` with allowCustomEntrypoint (direct_cc_entrypoint_normalize=1)", () => {
  const mirasimUa = { ...official312Headers, "user-agent": "claude-cli/2.1.312 (external, mirasim)" };
  const mirasimBilling = official312Body.system.map((b, i) => i === 0 ? { ...b, text: b.text.replace("cc_entrypoint=sdk-cli", "cc_entrypoint=mirasim") } : b);
  const body = { ...official312Body, system: mirasimBilling };
  assert.deepEqual(classifyCcRequest(mirasimUa, body).missing, ["ua_entrypoint"], "default: the gate still refuses an unknown entrypoint");
  const r = classifyCcRequest(mirasimUa, body, { allowCustomEntrypoint: true });
  assert.equal(r.verdict, "genuine");
  assert.deepEqual(r.missing, []);
  assert.ok(r.soft.includes("ua_entrypoint_custom"));
  // consistency between UA and billing entrypoint stays hard, and an entrypoint-less UA is never admitted
  assert.deepEqual(classifyCcRequest(mirasimUa, official312Body, { allowCustomEntrypoint: true }).missing, ["entrypoint_mismatch"]);
  assert.deepEqual(classifyCcRequest({ ...official312Headers, "user-agent": "claude-cli/2.1.312" }, body, { allowCustomEntrypoint: true }).missing, ["ua_entrypoint"]);
});
