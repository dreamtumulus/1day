// Claude Code profiles (spec §6.1) and the two-layer key policy (spec §6.2) — WP1.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "1dayapi-ccprofile-"));
process.env.DATA_DIR = dir;
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
const core = await import("../dist/index.js");
const { CC_PROFILES, CC_KNOWN_VERSIONS, knownCcProfile, ccProfileFor, ccTransportFor, sameCcProfile, classifyCcRequest, ccBuildSuffix,
  parseKeyPolicy, parseKeyPolicyDoc, effectiveKeyPolicy, withKeyPolicyOverride, invalidKeyPolicyField, sanitizeKeyPolicyLayer, keyPolicyAutoActive, setSetting, run } = core;

const SID = "3f2c1a4e-5b6d-4c7e-8f90-a1b2c3d4e5f6";
const headersFor = (version, entrypoint, runtime = "v26.12.1") => ({
  "user-agent": `claude-cli/${version} (external, ${entrypoint})`, "x-app": "cli",
  "anthropic-beta": "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14", "anthropic-version": "2023-06-01", accept: "application/json",
  "x-stainless-lang": "js", "x-stainless-runtime": "node", "x-stainless-runtime-version": runtime, "x-stainless-package-version": "0.128.0", "x-claude-code-session-id": SID,
});
const CLI = "You are Claude Code, Anthropic's official CLI for Claude.";
const SDK = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const bodyFor = (version, entrypoint, identity = CLI) => {
  const messages = [{ role: "user", content: [{ type: "text", text: "Reply with the single word OK." }] }];
  return {
    model: "claude-sonnet-5-5", max_tokens: 64, stream: true, messages,
    system: [{ type: "text", text: `x-anthropic-billing-header: cc_version=${version}.${ccBuildSuffix(messages, version)}; cc_entrypoint=${entrypoint};` }, { type: "text", text: identity, cache_control: { type: "ephemeral" } }, { type: "text", text: "x".repeat(5000), cache_control: { type: "ephemeral" } }],
    metadata: { user_id: JSON.stringify({ device_id: "c".repeat(64), account_uuid: "", session_id: SID }) },
    tools: [{ name: "Agent" }, { name: "Read" }], thinking: { type: "adaptive" }, context_management: { edits: [] },
  };
};

test("profile table: 2.1.312 cli / sdk-cli / restricted + 2.1.300 cli / sdk-cli, suffix-v1 only, transport per build", () => {
  assert.deepEqual(Object.keys(CC_PROFILES).sort(), ["cc-2.1.300-cli", "cc-2.1.300-sdk-cli", "cc-2.1.312-cli", "cc-2.1.312-restricted", "cc-2.1.312-sdk-cli"]);
  assert.deepEqual([...CC_KNOWN_VERSIONS].sort(), ["2.1.300", "2.1.312"]);
  for (const p of Object.values(CC_PROFILES)) {
    assert.equal(p.billingAlgo, "suffix-v1");
    assert.equal(p.betaPolicy.base[0], "claude-code-20250219");
    assert.equal(p.betaPolicy.base[1], "oauth-2025-04-20", p.profileId);
    assert.ok(p.evidence.length > 0, `${p.profileId} has evidence`);
  }
  assert.equal(knownCcProfile("2.1.312", "cli").identityBlocks[0], CLI);
  assert.ok(knownCcProfile("2.1.312", "sdk-cli").identityBlocks.includes(SDK));
  // G9 (12 × cli): the interactive main request adds dangerous-tool-use + afk-mode over sdk-cli; mid-conversation-tool-changes
  // (seen in the 2026-10-28 capture) was absent in all 12 samples → a feature-dependent beta, not part of the base set.
  for (const b of ["dangerous-tool-use-2026-09-03", "afk-mode-2026-01-31"]) {
    assert.ok(knownCcProfile("2.1.312", "cli").betaPolicy.base.includes(b), b);
    assert.ok(!knownCcProfile("2.1.312", "sdk-cli").betaPolicy.base.includes(b), b);
  }
  assert.ok(!knownCcProfile("2.1.312", "cli").betaPolicy.base.includes("mid-conversation-tool-changes-2026-07-01"));
  // haiku-4-5 has its own (shorter, re-ordered) set on every 2.1.312 profile
  for (const ep of ["cli", "sdk-cli", "restricted"]) {
    const h = knownCcProfile("2.1.312", ep).betaPolicy.byModel["claude-haiku-4-5"];
    assert.equal(h.length, 8, ep); assert.equal(h[0], "oauth-2025-04-20"); assert.ok(h.includes("claude-code-20250219")); assert.ok(!h.includes("effort-2025-11-24"));
  }
  assert.equal(knownCcProfile("2.1.312", "cli").tools.length, 13); assert.equal(knownCcProfile("2.1.312", "restricted").tools.includes("Bash"), false);
  assert.ok(knownCcProfile("2.1.312", "cli").topLevelKeys.includes("safeguards"));
  assert.ok(knownCcProfile("2.1.312", "sdk-cli").evidence.every((e) => e.grade === "sampled") && knownCcProfile("2.1.312", "sdk-cli").evidence.length === 12);
  assert.ok(!knownCcProfile("2.1.312", "sdk-cli").betaPolicy.base.includes("prompt-caching-scope-2026-01-05"), "2.1.312 dropped it (12/12 captures)");
  assert.ok(knownCcProfile("2.1.300", "sdk-cli").betaPolicy.base.includes("prompt-caching-scope-2026-01-05"));
  assert.deepEqual(ccTransportFor("2.1.312"), { runtimeVersion: "v26.12.1", sdkVersion: "0.128.0" });
  assert.deepEqual(ccTransportFor("2.1.300"), { runtimeVersion: "v26.3.0", sdkVersion: "0.128.0" });
  assert.equal(ccTransportFor("2.1.316"), null);
  assert.equal(ccBuildSuffix([{ role: "user", content: "Reply with the single word OK." }], "2.1.300"), "f23", "the 2.1.300 capture reproduces → same algorithm");
});

test("ccProfileFor: official entrypoints by name, customer-made ones by identity sentence, unsampled SDKs → null", () => {
  assert.equal(ccProfileFor("2.1.312", "cli", CLI).profileId, "cc-2.1.312-cli");
  assert.equal(ccProfileFor("2.1.312", "sdk-cli", SDK).profileId, "cc-2.1.312-sdk-cli");
  assert.equal(ccProfileFor("2.1.312", "mirasim", CLI).profileId, "cc-2.1.312-cli");
  assert.equal(ccProfileFor("2.1.312", "mirasim", SDK).profileId, "cc-2.1.312-sdk-cli");
  assert.equal(ccProfileFor("2.1.312", "mirasim", "You are something else."), null);
  assert.equal(ccProfileFor("2.1.312", "sdk-ts", SDK), null);
  assert.equal(ccProfileFor("2.1.316", "cli", CLI), null, "no sampled profile for 2.1.316");
  assert.equal(sameCcProfile(knownCcProfile("2.1.312", "cli"), knownCcProfile("2.1.312", "cli")), true);
  assert.equal(sameCcProfile(knownCcProfile("2.1.312", "cli"), knownCcProfile("2.1.300", "cli")), false, "no cross-version");
  assert.equal(sameCcProfile(knownCcProfile("2.1.312", "cli"), null), false);
});

test("gate: profileId reported; unknown profile is soft by default and hard with requireKnownProfile", () => {
  const ok = classifyCcRequest(headersFor("2.1.312", "cli"), bodyFor("2.1.312", "cli"));
  assert.equal(ok.verdict, "genuine", ok.missing.join(","));
  assert.equal(ok.profileId, "cc-2.1.312-cli"); assert.equal(ok.entrypoint, "cli"); assert.equal(ok.customEntrypoint, false);
  assert.ok(!ok.soft.includes("cc_profile_unknown"));
  const old = classifyCcRequest(headersFor("2.1.300", "cli", "v26.3.0"), bodyFor("2.1.300", "cli"));
  assert.equal(old.verdict, "genuine", old.missing.join(",")); assert.equal(old.profileId, "cc-2.1.300-cli");
  const unknown = classifyCcRequest(headersFor("2.1.316", "cli"), bodyFor("2.1.316", "cli"));
  assert.equal(unknown.verdict, "genuine", "observe: an unsampled version is still forwarded as today"); assert.equal(unknown.profileId, null);
  assert.ok(unknown.soft.includes("cc_profile_unknown"));
  const strict = classifyCcRequest(headersFor("2.1.316", "cli"), bodyFor("2.1.316", "cli"), { requireKnownProfile: true });
  assert.equal(strict.verdict, "suspect"); assert.deepEqual(strict.missing, ["cc_profile_unknown"]);
});

test("gate: customer-made entrypoint — denied by default, admitted by the key allowlist or the global switch", () => {
  const h = headersFor("2.1.312", "mirasim"); const b = bodyFor("2.1.312", "mirasim");
  const denied = classifyCcRequest(h, b);
  assert.equal(denied.verdict, "suspect"); assert.deepEqual(denied.missing, ["ua_entrypoint"]);
  assert.equal(denied.customEntrypoint, true); assert.equal(denied.customEntrypointDenied, true); assert.equal(denied.entrypoint, "mirasim");
  const byKey = classifyCcRequest(h, b, { allowedCustomEntrypoints: ["mirasim"], requireKnownProfile: true });
  assert.equal(byKey.verdict, "genuine", byKey.missing.join(",")); assert.equal(byKey.customEntrypointDenied, false);
  assert.ok(byKey.soft.includes("ua_entrypoint_custom")); assert.equal(byKey.profileId, "cc-2.1.312-cli", "profile from the identity sentence");
  assert.equal(classifyCcRequest(h, b, { allowedCustomEntrypoints: ["other"] }).customEntrypointDenied, true, "allowlist is exact");
  assert.equal(classifyCcRequest(h, b, { allowCustomEntrypoint: true }).verdict, "genuine");
  // UA entrypoint and billing entrypoint must agree even when admitted
  assert.ok(classifyCcRequest(h, bodyFor("2.1.312", "cli"), { allowedCustomEntrypoints: ["mirasim"] }).missing.includes("entrypoint_mismatch"));
});

test("key policy: flat legacy document reads as the override layer; defaults are the old behaviour", () => {
  const d = parseKeyPolicyDoc(JSON.stringify({ historyPolicy: "passthrough", directOnly: true, probeIntercept: false, teamAffinity: "pack" }));
  assert.deepEqual(d.auto, {});
  assert.deepEqual(d.override, { historyPolicy: "passthrough", directOnly: true, probeIntercept: false, teamAffinity: "pack" });
  const p = parseKeyPolicy(JSON.stringify({ historyPolicy: "passthrough", directOnly: true }));
  assert.equal(p.historyPolicy, "passthrough"); assert.equal(p.directOnly, true); assert.equal(p.probeIntercept, true);
  assert.equal(p.workerMode, "legacy"); assert.equal(p.telemetryPolicy, "passthrough-isolated"); assert.equal(p.parameterPolicy, "warn"); assert.equal(p.responseMode, "keepalive");
  assert.deepEqual(p.allowedCustomEntrypoints, []);
  const none = parseKeyPolicy(null);
  assert.equal(none.historyPolicy, "reset"); assert.deepEqual(none.allowedCustomEntrypoints, []);
  assert.equal(parseKeyPolicy("not json").workerMode, "legacy");
  assert.equal(parseKeyPolicy(JSON.stringify({ workerMode: "bogus", allowedCustomEntrypoints: ["ok-1", "Bad Space", 7] })).workerMode, "legacy", "invalid stored values are dropped");
  assert.deepEqual(parseKeyPolicy(JSON.stringify({ allowedCustomEntrypoints: ["ok-1", "Bad Space", 7, "ok-1"] })).allowedCustomEntrypoints, ["ok-1"]);
});

test("key policy: override ?? auto ?? default, with the auto layer gated by key_policy_auto (0 / canary / 1)", () => {
  run("INSERT INTO groups(id,name) VALUES ('g-can','灰度'),('g-oth','other')");
  const json = JSON.stringify({
    auto: { workerMode: "canonical", telemetryPolicy: "native-required", parameterPolicy: "strict", historyPolicy: "passthrough", decidedAt: "2026-11-01T00:00:00Z", basis: "cc_genuine_ratio=0.98" },
    override: { telemetryPolicy: "passthrough-isolated", allowedCustomEntrypoints: ["mirasim"], by: "admin-1", reason: "低延迟", at: "2026-11-01T01:00:00Z" },
    teamAffinity: null,
  });
  const doc = parseKeyPolicyDoc(json);
  assert.equal(doc.auto.basis, "cc_genuine_ratio=0.98"); assert.equal(doc.override.by, "admin-1"); assert.equal(doc.override.teamAffinity, null);
  // 0 (default): auto recorded only
  assert.equal(keyPolicyAutoActive("g-can"), false);
  let p = parseKeyPolicy(json, "g-can");
  assert.equal(p.telemetryPolicy, "passthrough-isolated"); assert.equal(p.workerMode, "legacy"); assert.equal(p.parameterPolicy, "warn"); assert.equal(p.historyPolicy, "reset");
  assert.deepEqual(p.allowedCustomEntrypoints, ["mirasim"]);
  // canary: only the canary group's keys
  setSetting("key_policy_auto", "canary"); setSetting("canary_group_id", "g-can");
  assert.equal(keyPolicyAutoActive("g-can"), true); assert.equal(keyPolicyAutoActive("g-oth"), false);
  p = parseKeyPolicy(json, "g-can");
  assert.equal(p.workerMode, "canonical"); assert.equal(p.parameterPolicy, "strict"); assert.equal(p.historyPolicy, "passthrough");
  assert.equal(p.telemetryPolicy, "passthrough-isolated", "override wins field by field");
  assert.equal(parseKeyPolicy(json, "g-oth").workerMode, "legacy");
  // 1: everyone
  setSetting("key_policy_auto", "1");
  assert.equal(parseKeyPolicy(json, "g-oth").workerMode, "canonical");
  assert.equal(effectiveKeyPolicy(doc, "g-oth", false).workerMode, "legacy", "explicit autoActive=false");
  setSetting("key_policy_auto", "0"); setSetting("canary_group_id", "");
});

test("key policy: console override replaces only the override layer; admin input is validated strictly", () => {
  const stored = JSON.stringify({ auto: { workerMode: "canonical", basis: "b" }, override: { directOnly: true } });
  const next = withKeyPolicyOverride(stored, { telemetryPolicy: "native-required", by: "a" });
  const d = parseKeyPolicyDoc(next);
  assert.equal(d.auto.workerMode, "canonical"); assert.equal(d.auto.basis, "b");
  assert.deepEqual(d.override, { telemetryPolicy: "native-required", by: "a" }, "directOnly override gone, auto kept");
  assert.equal(withKeyPolicyOverride(null, null), null);
  assert.equal(parseKeyPolicyDoc(withKeyPolicyOverride(stored, null)).auto.workerMode, "canonical", "clearing the override keeps auto");
  assert.deepEqual(parseKeyPolicyDoc(withKeyPolicyOverride(stored, null)).override, {});
  assert.equal(withKeyPolicyOverride(JSON.stringify({ historyPolicy: "reset" }), null), null, "legacy flat doc cleared → null");
  assert.equal(invalidKeyPolicyField({ historyPolicy: "reset", allowedCustomEntrypoints: ["mirasim"] }), null);
  assert.equal(invalidKeyPolicyField({ historyPolicy: "nope" }), "historyPolicy");
  assert.equal(invalidKeyPolicyField({ telemetryPolicy: "x" }), "telemetryPolicy");
  assert.equal(invalidKeyPolicyField({ allowedCustomEntrypoints: ["Bad Space"] }), "allowedCustomEntrypoints");
  assert.equal(invalidKeyPolicyField({ allowedCustomEntrypoints: "mirasim" }), "allowedCustomEntrypoints");
  assert.equal(invalidKeyPolicyField({ teamAffinity: null }), null);
  assert.equal(invalidKeyPolicyField(null), "policy");
  assert.deepEqual(sanitizeKeyPolicyLayer({ teamAffinity: null, probeIntercept: false }), { teamAffinity: null, probeIntercept: false });
});
