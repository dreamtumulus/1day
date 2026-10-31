// 直连路径：按账号把 messages[] 里 role:system 的 # Environment 块改写成账号合成机器。
import assert from "node:assert/strict";
import { test } from "node:test";
import { pinMachineEnvironment } from "../dist/upstream.js";
import { accountMachine } from "@1dayapi/core";

const envText = `# Environment
You have been invoked in the following environment: 
 - Primary working directory: /Users/realperson/code/topsecret
 - Is a git repository: true
 - Platform: darwin
 - Shell: /bin/zsh
 - OS Version: Darwin 24.1.0`;

const body = () => ({
  model: "claude-opus-5-5",
  system: [{ type: "text", text: "x-anthropic-billing-header: cc_version=2.1.312.058;" }, { type: "text", text: "# Environment\n - The most recent Claude models are the Claude 5 family" }],
  messages: [
    { role: "user", content: "hi" },
    { role: "system", content: [{ type: "text", text: envText, cache_control: { type: "ephemeral" } }] },
  ],
});

test("pinMachineEnvironment rewrites the machine block, leaks nothing, keeps catalog + cache_control", () => {
  const m = accountMachine("acct-A");
  const out = pinMachineEnvironment(body(), m, "11111111-2222-4333-8444-555555555555");
  const sys = out.messages[1].content[0];
  assert.ok(!sys.text.includes("realperson") && !sys.text.includes("topsecret"), "no real user/project");
  assert.ok(!sys.text.toLowerCase().includes("darwin"), "no darwin");
  assert.ok(sys.text.includes(` - Platform: linux`));
  assert.ok(sys.text.includes(` - OS Version: ${m.profile.osVersion}`));
  assert.ok(sys.text.includes(` - Primary working directory: ${m.workingDir}`));
  assert.deepEqual(sys.cache_control, { type: "ephemeral" }, "cache_control preserved");
  // the model-catalog # Environment in system[] must be untouched
  assert.ok(out.system[1].text.includes("most recent Claude models"));
  // user message untouched
  assert.equal(out.messages[0].content, "hi");
});

test("different accounts -> different machines; same account stable", () => {
  const a = pinMachineEnvironment(body(), accountMachine("acct-A"), "u").messages[1].content[0].text;
  const b = pinMachineEnvironment(body(), accountMachine("acct-B"), "u").messages[1].content[0].text;
  const a2 = pinMachineEnvironment(body(), accountMachine("acct-A"), "u").messages[1].content[0].text;
  assert.equal(a, a2, "same account stable");
  assert.notEqual(a, b, "different accounts differ");
});

test("non-CC body (no env block) is a no-op", () => {
  const plain = { model: "m", messages: [{ role: "user", content: "hello" }] };
  const out = pinMachineEnvironment(plain, accountMachine("x"), "u");
  assert.deepEqual(out, plain);
});
