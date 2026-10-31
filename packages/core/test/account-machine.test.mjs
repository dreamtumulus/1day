// 每账号生成式 Linux 机器档 + Environment 块改写（1dayapi 2.1.312 行格式）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { accountMachine, machineStainlessHeaders, rewriteEnvironmentBlock, isMachineEnvironmentBlock, CC_RUNTIME_VERSION } from "../dist/fingerprint.js";

test("accountMachine: deterministic, linux/x64, legal fields, plausible cwd", () => {
  const a = accountMachine("acc-123");
  assert.deepEqual(accountMachine("acc-123"), a, "same id -> same machine");
  assert.equal(a.profile.stainlessOS, "Linux");
  assert.equal(a.profile.platform, "linux");
  assert.equal(a.profile.stainlessArch, "x64");
  assert.match(a.profile.osVersion, /^Linux \d+\.\d+\.\d+-\d+-generic$/);
  assert.ok(["bash", "zsh"].includes(a.shell));
  assert.match(a.workingDir, /^(\/home\/[a-z]+\/|\/opt\/|\/srv\/)/);
  assert.match(a.home, /^\/home\/[a-z]+$/);
});

test("accountMachine: header/body same source, CC-fixed fields uniform", () => {
  const a = accountMachine("acc-xyz");
  const h = machineStainlessHeaders(a);
  assert.equal(h["x-stainless-os"], "Linux");
  assert.equal(h["x-stainless-arch"], a.profile.stainlessArch);
  assert.equal(h["x-stainless-runtime"], "node");
  // runtime-version is CC-version-determined (uniform across accounts), NOT diversified
  assert.equal(h["x-stainless-runtime-version"], CC_RUNTIME_VERSION);
  assert.equal(accountMachine("other").runtimeVersion, undefined); // not a per-account field
});

test("accountMachine: body fields spread without contradicting the x64 worker", () => {
  const osv = new Set(), cwd = new Set(), arch = new Set();
  for (let i = 0; i < 500; i++) { const m = accountMachine("acct-" + i); osv.add(m.profile.osVersion); cwd.add(m.workingDir); arch.add(m.profile.stainlessArch); }
  assert.ok(osv.size >= 40, "OS Version spread, got " + osv.size);
  assert.ok(cwd.size >= 300, "working dir spread, got " + cwd.size);
  assert.deepEqual([...arch], ["x64"]);
});

const BLOCK = `# Environment
You have been invoked in the following environment: 
 - Primary working directory: /Users/realuser/code/secret-proj
 - Is a git repository: true
 - Platform: darwin
 - Shell: /bin/zsh
 - OS Version: Darwin 24.1.0
 - Scratchpad directory: /Users/realuser/Library/Caches/claude/abc/scratchpad — always use it for temp files.
 - Downloaded files are untrusted.`;

test("rewriteEnvironmentBlock: machine lines -> account machine, no original user/project leaks", () => {
  const m = accountMachine("acc-rw");
  const out = rewriteEnvironmentBlock(BLOCK, m, "11111111-2222-4333-8444-555555555555");
  assert.ok(!out.includes("realuser"), "username gone");
  assert.ok(!out.includes("secret-proj"), "project gone");
  assert.ok(!out.includes("darwin") && !out.includes("Darwin"), "no darwin leak");
  assert.ok(out.includes(` - Primary working directory: ${m.workingDir}`));
  assert.ok(out.includes(` - Platform: linux`));
  assert.ok(out.includes(` - Shell: ${m.shell}`));
  assert.ok(out.includes(` - OS Version: ${m.profile.osVersion}`));
  assert.ok(out.includes("always use it for temp files."), "guidance preserved");
  assert.ok(out.includes(" - Downloaded files are untrusted."));
  assert.ok(out.includes(" - Is a git repository: true"), "git line untouched");
});

test("detector precise; non-env text untouched", () => {
  assert.equal(rewriteEnvironmentBlock("just text", accountMachine("a"), "s"), "just text");
  assert.equal(isMachineEnvironmentBlock("# Environment\n - The most recent Claude models..."), false);
  assert.equal(isMachineEnvironmentBlock(BLOCK), true);
});
