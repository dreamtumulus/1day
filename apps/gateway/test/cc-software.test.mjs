// One account = one software (docs/gateway.md §3): direct-path UA entrypoint / version alignment — pure, against core dist.
import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeCcSoftware, CC_SDK_VERSION } from "@1dayapi/core";

const billing = (v, ep) => ({ type: "text", text: `x-anthropic-billing-header: cc_version=${v}; cc_entrypoint=${ep};` });
const opts = { normalizeEntrypoint: true, versionPin: "2.1.303" };

test("customer-made entrypoint → (external, cli), billing cc_entrypoint follows; version pinned in UA, stainless and billing", () => {
  const headers = { "user-agent": "claude-cli/2.1.296 (external, mirasim)", "x-stainless-package-version": "0.120.0", "x-app": "cli" };
  const body = { model: "m", system: [billing("2.1.296.f23", "mirasim"), { type: "text", text: "You are Claude Code" }], messages: [] };
  const n = normalizeCcSoftware(headers, body, opts);
  assert.deepEqual(n.changed, ["entrypoint", "version"]);
  assert.equal(n.headers["user-agent"], "claude-cli/2.1.303 (external, cli)");
  assert.equal(n.headers["x-stainless-package-version"], CC_SDK_VERSION);
  assert.equal(n.headers["x-stainless-runtime-version"], "v26.12.1");
  assert.equal(n.headers["x-app"], "cli");
  // the client's build flag (".f23") is kept: real Claude Code sends it and the cc-shape gate allows it
  assert.equal(n.body.system[0].text, "x-anthropic-billing-header: cc_version=2.1.303.f23; cc_entrypoint=cli;");
  assert.equal(n.body.system[1].text, "You are Claude Code", "other blocks untouched");
  assert.equal(body.system[0].text.includes("2.1.296"), true, "input not mutated");
});

test("real entrypoints pass through; only the version is aligned", () => {
  for (const ua of ["claude-cli/2.1.299 (external, cli)", "claude-cli/2.1.237 (external, sdk-ts, agent-sdk/0.3.237)", "claude-cli/2.1.304 (external, claude-vscode, agent-sdk/0.3.304)"]) {
    const n = normalizeCcSoftware({ "user-agent": ua }, { system: [billing("2.1.299", "cli")] }, opts);
    assert.deepEqual(n.changed, ["version"], ua);
    assert.equal(n.headers["user-agent"], ua.replace(/\d+\.\d+\.\d+(?= )/, "2.1.303"));
    assert.equal(n.body.system[0].text, "x-anthropic-billing-header: cc_version=2.1.303; cc_entrypoint=cli;");
  }
});

test("already aligned → untouched; non-CC UA → untouched; pin off → entrypoint only", () => {
  const same = normalizeCcSoftware({ "user-agent": "claude-cli/2.1.303 (external, cli)" }, { system: [billing("2.1.303", "cli")] }, opts);
  assert.deepEqual(same.changed, []);
  const curl = normalizeCcSoftware({ "user-agent": "curl/8.0" }, { system: "x" }, opts);
  assert.deepEqual(curl.changed, []);
  const epOnly = normalizeCcSoftware({ "user-agent": "claude-cli/2.1.241 (external, mirasim)" }, { system: [billing("2.1.241", "mirasim")] }, { normalizeEntrypoint: true, versionPin: null });
  assert.deepEqual(epOnly.changed, ["entrypoint"]);
  assert.equal(epOnly.headers["user-agent"], "claude-cli/2.1.241 (external, cli)");
  assert.equal(epOnly.body.system[0].text, "x-anthropic-billing-header: cc_version=2.1.241; cc_entrypoint=cli;");
  const off = normalizeCcSoftware({ "user-agent": "claude-cli/2.1.241 (external, mirasim)" }, { system: [billing("2.1.241", "mirasim")] }, { normalizeEntrypoint: false, versionPin: null });
  assert.deepEqual(off.changed, []);
});

test("string system / no billing block: headers still aligned, body untouched", () => {
  const n = normalizeCcSoftware({ "user-agent": "claude-cli/2.1.296 (external, foo)" }, { system: "plain prompt", messages: [] }, opts);
  assert.deepEqual(n.changed, ["entrypoint", "version"]);
  assert.equal(n.headers["user-agent"], "claude-cli/2.1.303 (external, cli)");
  assert.equal(n.body.system, "plain prompt");
});
