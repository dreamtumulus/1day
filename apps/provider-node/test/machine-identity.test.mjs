import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { accountMachine, machineKernelRelease, machineUnameArch, machineOsRelease } from "../dist/machine.js";
import { prepareMachineRuntime, machineEnvironment } from "../dist/machine-runtime.js";

const { accountMachine: coreAccountMachine } = await import("../../../packages/core/dist/fingerprint.js");

for (const accountId of ["acct-1", "acct-2", "selftest", "org-example-account"]) {
  assert.deepEqual(accountMachine(accountId), coreAccountMachine(accountId), `direct/worker machine profile mismatch for ${accountId}`);
}

const machine = accountMachine("acct-1");
assert.match(machineKernelRelease(machine), /^\d+\.\d+\.\d+-\d+-generic$/);
assert.equal(machineUnameArch(machine), "x86_64");
assert.match(machineOsRelease(machine), /^NAME="Ubuntu"\nID=ubuntu\nVERSION_ID="\d+\.\d+"/);

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "machine-identity-test-"));
try {
  const runtime = prepareMachineRuntime(path.join(dataDir, "runtime"));
  const env = machineEnvironment("acct-1", dataDir, runtime, null);
  assert.equal(env.CC_MACHINE_KERNEL, machineKernelRelease(machine));
  assert.equal(env.CC_MACHINE_ARCH, "x86_64");
  assert.equal(env.SHELL, machine.shell === "zsh" ? "/bin/zsh" : "/bin/bash");
  assert.equal(fs.readFileSync(env.CC_MACHINE_OS_RELEASE, "utf8"), machineOsRelease(machine));
  assert.ok(fs.readFileSync(env.CC_MACHINE_PROC_VERSION, "utf8").includes(machineKernelRelease(machine)));

  const uname = spawnSync("uname", ["-r"], { encoding: "utf8", env: { ...process.env, LD_PRELOAD: runtime.library, CC_MACHINE_KERNEL: env.CC_MACHINE_KERNEL } });
  assert.equal(uname.status, 0, uname.stderr);
  assert.equal(uname.stdout.trim(), env.CC_MACHINE_KERNEL);

  const unameArch = spawnSync("uname", ["-m"], { encoding: "utf8", env: { ...process.env, LD_PRELOAD: runtime.library, CC_MACHINE_ARCH: env.CC_MACHINE_ARCH } });
  assert.equal(unameArch.status, 0, unameArch.stderr);
  assert.equal(unameArch.stdout.trim(), "x86_64");

  const osRelease = spawnSync(process.execPath, ["-e", "console.log(require('os').release())"], { encoding: "utf8", env: { ...process.env, LD_PRELOAD: runtime.library, CC_MACHINE_KERNEL: env.CC_MACHINE_KERNEL } });
  assert.equal(osRelease.status, 0, osRelease.stderr);
  assert.equal(osRelease.stdout.trim(), env.CC_MACHINE_KERNEL, "Claude Code's # Environment block uses the same account kernel");
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log("machine-identity: ALL PASSED");
