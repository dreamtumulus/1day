// 2026-11-01 incident (docs/iron-rules.md): the billing suffix is Anthropic's checksum over the first user text of
// the body it RECEIVES. Whatever the gateway edits, the outgoing body's suffix must equal ccBuildSuffix(outgoing
// messages, version). Matrix: first-message layouts × every shaping switch combination; plus the real failing shape.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "1dayapi-gw-suffix-"));
process.env.DATA_DIR = dir;
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
const core = await import("@1dayapi/core");
const { buildUpstreamRequest } = await import("../dist/upstream.js");
const { CC_VERSION, ccBuildSuffix, billingSuffixOf, billingVersionOf } = core;

const SID = "3f2c1a4e-5b6d-4c7e-8f90-a1b2c3d4e5f6";
const account = { id: "acc-s", name: "sub", platform: "anthropic", type: "oauth", protocol: "anthropic", executor: "ccr_worker", base_url: null, models: null, model_mapping: null, route: "node", raw_passthrough: 0, device_id: "d".repeat(64), account_uuid: "11111111-2222-4333-8444-555555555555" };
const reminder = "<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# userEmail\nThe user's email address is dev@customer.example. Use it only to identify the user.\n</system-reminder>";
const headersFor = (version, entrypoint = "cli") => ({
  "user-agent": `claude-cli/${version} (external, ${entrypoint})`, "x-app": "cli",
  "anthropic-beta": "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14", "anthropic-version": "2023-06-01", accept: "application/json",
  "x-stainless-lang": "js", "x-stainless-runtime": "node", "x-stainless-runtime-version": "v26.12.1", "x-stainless-package-version": "0.128.0", "x-claude-code-session-id": SID,
});
const bodyFor = (version, messages, entrypoint = "cli") => ({
  model: "claude-opus-5-5", max_tokens: 64, stream: true, messages,
  system: [{ type: "text", text: `x-anthropic-billing-header: cc_version=${version}.${ccBuildSuffix(messages, version)}; cc_entrypoint=${entrypoint};` }, { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude.", cache_control: { type: "ephemeral" } }],
  metadata: { user_id: JSON.stringify({ device_id: "c".repeat(64), account_uuid: "", session_id: SID }) },
});
const layouts = {
  "one block, short prompt then reminder (the 2026-11-01 failing shape)": [{ role: "user", content: [{ type: "text", text: `hi\n${reminder}` }] }],
  "one block, reminder then short prompt": [{ role: "user", content: [{ type: "text", text: `${reminder}\nhi` }] }],
  "separate blocks, reminder first": [{ role: "user", content: [{ type: "text", text: reminder }, { type: "text", text: "Please refactor the parser module and add tests." }] }],
  "separate blocks, prompt first": [{ role: "user", content: [{ type: "text", text: "Refactor it." }, { type: "text", text: reminder }] }],
  "no reminder, string content": [{ role: "user", content: "Reply with the single word OK." }],
  "reminder only (nothing else in the turn)": [{ role: "user", content: [{ type: "text", text: reminder }] }],
  "two turns, reminder in the second": [{ role: "user", content: "first" }, { role: "assistant", content: "a" }, { role: "user", content: [{ type: "text", text: `go\n${reminder}` }] }],
};
const shapings = [];
for (const normalizeEntrypoint of [false, true]) for (const stripUserEmail of [false, true]) for (const canonicalFields of [false, true]) shapings.push({ normalizeEntrypoint, stripUserEmail, canonicalFields });

test("invariant: outgoing billing suffix == ccBuildSuffix(outgoing messages) for every layout × shaping, pinned to 2.1.312", () => {
  core.setSetting("direct_cc_version_pin", "2.1.312");
  for (const clientVersion of ["2.1.293", "2.1.312", "2.1.316"]) for (const entrypoint of ["cli", "mirasim"]) for (const [name, messages] of Object.entries(layouts)) for (const shaping of shapings) {
    const r = buildUpstreamRequest(account, { accessToken: "tok" }, "passthrough-anthropic", bodyFor(clientVersion, messages, entrypoint), "claude-opus-5-5", headersFor(clientVersion, entrypoint), "", undefined, shaping);
    const sent = JSON.parse(r.body);
    assert.equal(billingVersionOf(sent), CC_VERSION, `${name} v${clientVersion}`);
    assert.equal(billingSuffixOf(sent), ccBuildSuffix(sent.messages, CC_VERSION), `${name} v${clientVersion} ${entrypoint} ${JSON.stringify(shaping)}`);
    // a turn that is nothing but the reminder is left alone by design (never empty a message)
    if (shaping.stripUserEmail && !name.startsWith("reminder only")) assert.equal(JSON.stringify(sent).includes("dev@customer.example"), false, `${name}: reminder stripped`);
  }
});

test("the exact 2026-11-01 failure: suffix hashed before the reminder was stripped → now recomputed after", () => {
  core.setSetting("direct_cc_version_pin", "2.1.312");
  const messages = layouts["one block, short prompt then reminder (the 2026-11-01 failing shape)"];
  const r = buildUpstreamRequest(account, { accessToken: "tok" }, "passthrough-anthropic", bodyFor("2.1.293", messages, "mirasim"), "claude-opus-5-5", headersFor("2.1.293", "mirasim"), "", undefined, { normalizeEntrypoint: true, stripUserEmail: true, canonicalFields: true });
  const sent = JSON.parse(r.body);
  const stale = ccBuildSuffix(messages, CC_VERSION); // what the 09:40 build wrote (pre-strip text)
  assert.notEqual(stale, ccBuildSuffix(sent.messages, CC_VERSION), "fixture: stripping changes the hashed characters");
  assert.equal(billingSuffixOf(sent), ccBuildSuffix(sent.messages, CC_VERSION));
  assert.equal(sent.messages[0].content[0].text, "hi");
});

test("unknown outgoing version (pin off, client 2.1.314, not sampled): the first user text is never edited, the client's suffix travels untouched", () => {
  core.setSetting("direct_cc_version_pin", "");
  try {
    const messages = layouts["one block, short prompt then reminder (the 2026-11-01 failing shape)"];
    const body = bodyFor("2.1.314", messages, "cli");
    const r = buildUpstreamRequest(account, { accessToken: "tok" }, "passthrough-anthropic", body, "claude-opus-5-5", headersFor("2.1.314"), "", undefined, { normalizeEntrypoint: true, stripUserEmail: true, canonicalFields: true });
    const sent = JSON.parse(r.body);
    assert.equal(billingVersionOf(sent), "2.1.314");
    assert.equal(billingSuffixOf(sent), ccBuildSuffix(messages, "2.1.314"), "client's own suffix kept");
    assert.equal(sent.messages[0].content[0].text, `hi\n${reminder}`, "reminder NOT stripped: we cannot recompute a 2.1.314 suffix");
  } finally {
    core.setSetting("direct_cc_version_pin", "2.1.312");
  }
});

test("verified outgoing version (pin off, client 2.1.316 — WP0 batch 4): the reminder may be stripped and the suffix is recomputed for 2.1.316", () => {
  core.setSetting("direct_cc_version_pin", "");
  try {
    const messages = layouts["one block, short prompt then reminder (the 2026-11-01 failing shape)"];
    const body = bodyFor("2.1.316", messages, "cli");
    const r = buildUpstreamRequest(account, { accessToken: "tok" }, "passthrough-anthropic", body, "claude-opus-5-5", headersFor("2.1.316"), "", undefined, { normalizeEntrypoint: true, stripUserEmail: true, canonicalFields: true });
    const sent = JSON.parse(r.body);
    assert.equal(billingVersionOf(sent), "2.1.316", "version kept (no cross-version pin)");
    assert.equal(sent.messages[0].content[0].text, "hi", "reminder stripped: the 2.1.316 algorithm is verified");
    assert.equal(billingSuffixOf(sent), ccBuildSuffix(sent.messages, "2.1.316"), "suffix recomputed over the OUTGOING messages");
  } finally {
    core.setSetting("direct_cc_version_pin", "2.1.312");
  }
});
