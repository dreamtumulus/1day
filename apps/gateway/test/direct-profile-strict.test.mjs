// spec WP1 (docs/canonical-implementation-spec-2026-11-01.md §6.1 / §8): direct_profile_strict — no cross-version pin,
// key-allowlisted custom entrypoints normalised, and the outgoing request re-gated against the same profile.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "1dayapi-gw-profile-"));
process.env.DATA_DIR = dir;
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
const core = await import("@1dayapi/core");
const { buildUpstreamRequest, outgoingProfileCheck, shapingFor } = await import("../dist/upstream.js");
const { classifyCcRequest, ccBuildSuffix, setSetting } = core;

const SID = "3f2c1a4e-5b6d-4c7e-8f90-a1b2c3d4e5f6";
const account = { id: "acc-p", name: "sub", platform: "anthropic", type: "oauth", protocol: "anthropic", executor: "ccr_worker", base_url: null, models: null, model_mapping: null, route: "node", raw_passthrough: 0, device_id: "d".repeat(64), account_uuid: "11111111-2222-4333-8444-555555555555" };
const headersFor = (version, entrypoint, runtime) => ({
  "user-agent": `claude-cli/${version} (external, ${entrypoint})`, "x-app": "cli",
  "anthropic-beta": "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14", "anthropic-version": "2023-06-01", accept: "application/json",
  "x-stainless-lang": "js", "x-stainless-runtime": "node", "x-stainless-runtime-version": runtime, "x-stainless-package-version": "0.128.0", "x-claude-code-session-id": SID,
});
const CLI = "You are Claude Code, Anthropic's official CLI for Claude.";
const bodyFor = (version, entrypoint) => {
  const messages = [{ role: "user", content: [{ type: "text", text: "Please refactor the parser module and add tests." }] }];
  return {
    model: "claude-sonnet-5-5", max_tokens: 64, stream: true, messages,
    system: [{ type: "text", text: `x-anthropic-billing-header: cc_version=${version}.${ccBuildSuffix(messages, version)}; cc_entrypoint=${entrypoint};` }, { type: "text", text: CLI, cache_control: { type: "ephemeral" } }, { type: "text", text: "y".repeat(5000), cache_control: { type: "ephemeral" } }],
    metadata: { user_id: JSON.stringify({ device_id: "c".repeat(64), account_uuid: "", session_id: SID }) },
    tools: [{ name: "Agent" }, { name: "Read" }], thinking: { type: "adaptive" }, context_management: { edits: [] },
  };
};
const OFF = { normalizeEntrypoint: false, stripUserEmail: false, canonicalFields: false, strictProfile: false };
const STRICT = { ...OFF, strictProfile: true };
const build = (h, b, shaping) => buildUpstreamRequest(account, { accessToken: "tok" }, "passthrough-anthropic", b, "claude-sonnet-5-5", h, "", undefined, shaping);

test("default is the old behaviour: direct_profile_strict=0, a 2.1.300 client is pinned to 2.1.312 (cross-version mix)", () => {
  setSetting("direct_cc_version_pin", "2.1.312");
  assert.equal(shapingFor({ groupId: "g" }).strictProfile, false);
  assert.equal(shapingFor({ groupId: "g" }).normalizeEntrypoint, false);
  const r = build(headersFor("2.1.300", "cli", "v26.3.0"), bodyFor("2.1.300", "cli"), OFF);
  assert.equal(r.headers["user-agent"], "claude-cli/2.1.312 (external, cli)");
  assert.match(JSON.parse(r.body).system[0].text, /cc_version=2\.1\.312\./);
  // and the outgoing request is a different profile than the inbound one — exactly what strict mode refuses
  const inbound = classifyCcRequest(headersFor("2.1.300", "cli", "v26.3.0"), bodyFor("2.1.300", "cli"));
  assert.equal(inbound.profileId, "cc-2.1.300-cli");
  const out = outgoingProfileCheck(r, inbound);
  assert.equal(out.verdict, "genuine"); assert.equal(out.profileId, "cc-2.1.312-cli"); assert.equal(out.sameProfile, false);
});

test("strict: the client's version is kept, transport constants follow its build, suffix untouched, same profile out", () => {
  setSetting("direct_cc_version_pin", "2.1.312");
  const h = headersFor("2.1.300", "cli", "v26.3.0"); const b = bodyFor("2.1.300", "cli");
  const r = build(h, b, STRICT);
  assert.equal(r.headers["user-agent"], "claude-cli/2.1.300 (external, cli)");
  assert.equal(r.headers["x-stainless-runtime-version"], "v26.3.0", "not the node's v26.12.1");
  assert.equal(r.headers["x-stainless-package-version"], "0.128.0");
  const sent = JSON.parse(r.body);
  assert.equal(sent.system[0].text, b.system[0].text, "billing block byte-identical");
  const inbound = classifyCcRequest(h, b);
  const out = outgoingProfileCheck(r, inbound);
  assert.equal(out.verdict, "genuine", out.missing.join(","));
  assert.equal(out.sameProfile, true);
  // 2.1.312 as well: device/machine pinning does not break the profile
  const h2 = headersFor("2.1.312", "cli", "v26.12.1"); const b2 = bodyFor("2.1.312", "cli");
  const out2 = outgoingProfileCheck(build(h2, b2, STRICT), classifyCcRequest(h2, b2));
  assert.equal(out2.sameProfile, true, out2.missing.join(","));
  assert.equal(JSON.parse(build(h2, b2, STRICT).body).metadata.user_id.includes("d".repeat(64)), true, "device pinned to the account");
});

test("strict + key allowlist: a mirasim client is admitted, normalised to (external, cli) and leaves as the same cli profile", () => {
  const h = headersFor("2.1.312", "mirasim", "v26.12.1"); const b = bodyFor("2.1.312", "mirasim");
  const inbound = classifyCcRequest(h, b, { allowedCustomEntrypoints: ["mirasim"], requireKnownProfile: true });
  assert.equal(inbound.verdict, "genuine", inbound.missing.join(",")); assert.equal(inbound.customEntrypoint, true); assert.equal(inbound.profileId, "cc-2.1.312-cli");
  const shaping = shapingFor({ groupId: "g", customEntrypointAdmitted: inbound.verdict === "genuine" && inbound.customEntrypoint });
  assert.equal(shaping.normalizeEntrypoint, true, "allowlisted → rewritten even with the global switch off");
  const r = build(h, b, { ...shaping, strictProfile: true });
  assert.equal(r.headers["user-agent"], "claude-cli/2.1.312 (external, cli)");
  const sent = JSON.parse(r.body);
  assert.match(sent.system[0].text, /cc_entrypoint=cli;/);
  assert.equal(sent.system[0].text.match(/cc_version=2\.1\.312\.([0-9a-z]+)/)[1], ccBuildSuffix(sent.messages), "suffix matches the forwarded messages");
  const out = outgoingProfileCheck(r, inbound);
  assert.equal(out.sameProfile, true, out.missing.join(","));
  // not allowlisted: denied at the gate, nothing to normalise
  const denied = classifyCcRequest(h, b, { requireKnownProfile: true });
  assert.equal(denied.customEntrypointDenied, true);
  assert.equal(shapingFor({ groupId: "g", customEntrypointAdmitted: false }).normalizeEntrypoint, false);
});

test("strict: an unsampled version (2.1.316) is not a known profile and the outgoing check cannot vouch for it", () => {
  setSetting("direct_cc_version_pin", "2.1.312");
  const h = headersFor("2.1.316", "cli", "v26.12.1"); const b = bodyFor("2.1.316", "cli");
  const inbound = classifyCcRequest(h, b, { requireKnownProfile: true });
  assert.equal(inbound.verdict, "suspect"); assert.deepEqual(inbound.missing, ["cc_profile_unknown"]);
  const r = build(h, b, STRICT);
  assert.equal(r.headers["user-agent"], "claude-cli/2.1.316 (external, cli)", "never pinned to another build");
  assert.equal(JSON.parse(r.body).system[0].text, b.system[0].text, "first user text and suffix untouched for an unknown algorithm");
  assert.equal(outgoingProfileCheck(r, inbound).sameProfile, false);
});
