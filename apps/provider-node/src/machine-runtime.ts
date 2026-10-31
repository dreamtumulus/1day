import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { accountMachine, machineKernelRelease, machineOsRelease, machineProcVersion, machineUnameArch } from "./machine.js";
import type { RunAs } from "./cc-worker.js";

const CC_MACHINE_SOURCE = String.raw`
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/utsname.h>

int uname(struct utsname *buf) {
  static int (*real_uname)(struct utsname *) = NULL;
  if (!real_uname) real_uname = dlsym(RTLD_NEXT, "uname");
  if (!real_uname) return -1;
  int rc = real_uname(buf);
  if (rc != 0) return rc;
  const char *release = getenv("CC_MACHINE_KERNEL");
  const char *arch = getenv("CC_MACHINE_ARCH");
  if (release && *release) snprintf(buf->release, sizeof(buf->release), "%s", release);
  if (arch && *arch) snprintf(buf->machine, sizeof(buf->machine), "%s", arch);
  return 0;
}
`;

const CC_MACHINE_LAUNCHER = `#!/bin/bash
set -euo pipefail
if [ "\${1:-}" = "--enter" ]; then
  shift
  mount --bind "$CC_MACHINE_OS_RELEASE" /etc/os-release
  mount --bind "$CC_MACHINE_PROC_VERSION" /proc/version
  export LD_PRELOAD="$CC_MACHINE_LIBRARY\${LD_PRELOAD:+:$LD_PRELOAD}"
  if [ -n "\${CC_WORKER_TARGET_UID:-}" ]; then
    exec setpriv --reuid "$CC_WORKER_TARGET_UID" --regid "$CC_WORKER_TARGET_GID" --clear-groups "$@"
  fi
  exec "$@"
fi
exec unshare --mount --propagation private "$0" --enter "$@"
`;

export interface MachineRuntime {
  directory: string;
  library: string;
  launcher: string;
}

function writeIfChanged(file: string, content: string, mode: number): void {
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === content) {
    fs.chmodSync(file, mode);
    return;
  }
  fs.writeFileSync(file, content, { mode });
  fs.chmodSync(file, mode);
}

export function prepareMachineRuntime(directory: string): MachineRuntime {
  fs.mkdirSync(directory, { recursive: true, mode: 0o755 });
  fs.chmodSync(directory, 0o755);
  const source = path.join(directory, "cc-machine.c");
  const library = path.join(directory, "cc-machine.so");
  const launcher = path.join(directory, "cc-worker-launcher.sh");
  writeIfChanged(source, CC_MACHINE_SOURCE, 0o644);
  writeIfChanged(launcher, CC_MACHINE_LAUNCHER, 0o755);

  const compiler = spawnSync("cc", ["--version"], { stdio: "ignore", timeout: 5_000 });
  if (compiler.error || compiler.status !== 0) throw new Error("machine_identity_compiler_missing: install gcc and libc6-dev");
  const unshare = spawnSync("unshare", ["--version"], { stdio: "ignore", timeout: 5_000 });
  if (unshare.error || unshare.status !== 0) throw new Error("machine_identity_unshare_missing: install util-linux");
  const setpriv = spawnSync("setpriv", ["--version"], { stdio: "ignore", timeout: 5_000 });
  if (setpriv.error || setpriv.status !== 0) throw new Error("machine_identity_setpriv_missing: install util-linux");

  const output = path.join(directory, `.cc-machine-${process.pid}.so`);
  const built = spawnSync("cc", ["-shared", "-fPIC", "-O2", "-Wall", "-Wextra", "-o", output, source, "-ldl"], {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (built.error || built.status !== 0) {
    fs.rmSync(output, { force: true });
    throw new Error(`machine_identity_compile_failed: ${built.error?.message ?? (built.stderr || built.stdout || `cc exited ${built.status}`)}`.slice(0, 600));
  }
  fs.renameSync(output, library);
  fs.chmodSync(library, 0o755);

  const probeKernel = "0.0.0-machine-selftest";
  const probe = spawnSync("uname", ["-r"], {
    encoding: "utf8",
    timeout: 5_000,
    env: { PATH: process.env.PATH ?? "", LD_PRELOAD: library, CC_MACHINE_KERNEL: probeKernel, CC_MACHINE_ARCH: "x86_64" },
  });
  if (probe.error || probe.status !== 0 || probe.stdout.trim() !== probeKernel) {
    throw new Error(`machine_identity_uname_selftest_failed: ${probe.error?.message ?? probe.stderr ?? probe.stdout}`.slice(0, 400));
  }
  return { directory, library, launcher };
}

export function machineEnvironment(accountId: string, configDir: string, runtime: MachineRuntime, identity: RunAs | null): NodeJS.ProcessEnv {
  const machine = accountMachine(accountId);
  const osRelease = path.join(configDir, "machine-os-release");
  const procVersion = path.join(configDir, "machine-proc-version");
  fs.writeFileSync(osRelease, machineOsRelease(machine), { mode: 0o600 });
  fs.writeFileSync(procVersion, machineProcVersion(machine), { mode: 0o600 });
  if (identity) {
    fs.chownSync(osRelease, identity.uid, identity.gid);
    fs.chownSync(procVersion, identity.uid, identity.gid);
  }
  const env: NodeJS.ProcessEnv = {
    CC_MACHINE_OS_RELEASE: osRelease,
    CC_MACHINE_PROC_VERSION: procVersion,
    CC_MACHINE_KERNEL: machineKernelRelease(machine),
    CC_MACHINE_ARCH: machineUnameArch(machine),
    CC_MACHINE_LIBRARY: runtime.library,
    SHELL: machine.shell === "zsh" ? "/bin/zsh" : "/bin/bash",
  };
  if (identity) {
    env.CC_WORKER_TARGET_UID = String(identity.uid);
    env.CC_WORKER_TARGET_GID = String(identity.gid);
  }
  return env;
}
