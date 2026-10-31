// Vendored from packages/core/src/fingerprint.ts. Keep account-derived values in sync
// so a subscription's direct requests and its native workers present one machine.

import { createHash } from "node:crypto";

export interface MachineProfile {
  stainlessOS: string;
  stainlessArch: string;
  platform: string;
  osVersion: string;
}

export interface AccountMachine {
  profile: MachineProfile;
  shell: string;
  workingDir: string;
  home: string;
}

const MP_KERNEL_LINES = ["6.8.0", "6.8.0", "6.11.0", "6.5.0", "5.15.0", "6.2.0", "6.14.0", "6.12.0"];
const MP_SHELLS = ["bash", "bash", "bash", "bash", "zsh"];
const MP_USERNAMES = [
  "james", "mary", "robert", "patricia", "john", "jennifer", "michael", "linda",
  "david", "elizabeth", "william", "barbara", "richard", "susan", "joseph", "jessica",
  "thomas", "sarah", "charles", "karen", "daniel", "nancy", "matthew", "lisa",
  "anthony", "betty", "mark", "margaret", "donald", "sandra", "steven", "ashley",
  "paul", "kimberly", "andrew", "emily", "joshua", "michelle", "kevin", "amanda",
  "dev", "alex", "chen", "wei", "li", "yuki", "raj", "omar", "nina", "leo",
];
const MP_REPOS = [
  "website", "api-server", "mobile-app", "data-pipeline", "backend", "frontend",
  "dashboard", "cli-tools", "scripts", "ml-project", "web-app", "microservices",
  "monorepo", "infra", "auth-service", "payment-gateway", "analytics", "chatbot",
  "ecommerce", "blog-engine", "task-queue", "file-sync", "search-service", "cms",
  "app", "api", "server", "core", "platform", "sdk", "bot", "pipeline",
];
const MP_LAYOUTS = [
  "/home/{u}/projects/{r}", "/home/{u}/code/{r}", "/home/{u}/dev/{r}", "/home/{u}/work/{r}",
  "/home/{u}/src/{r}", "/home/{u}/repos/{r}", "/home/{u}/{r}", "/home/{u}/go/src/{r}",
  "/home/{u}/workspace/{r}", "/opt/{r}", "/srv/{r}",
];

function deriveN(salt: string, accountId: string): number {
  return parseInt(createHash("sha256").update(`${salt}${accountId}`).digest("hex").slice(0, 12), 16);
}

function pickFrom<T>(arr: readonly T[], salt: string, accountId: string): T {
  return arr[deriveN(salt, accountId) % arr.length];
}

export function accountMachine(accountId: string): AccountMachine {
  const line = pickFrom(MP_KERNEL_LINES, "cc-mach-kline::", accountId);
  const nn = 20 + (deriveN("cc-mach-knn::", accountId) % 60);
  const shell = pickFrom(MP_SHELLS, "cc-mach-shell::", accountId);
  const user = pickFrom(MP_USERNAMES, "cc-mach-user::", accountId);
  const repo = pickFrom(MP_REPOS, "cc-mach-repo::", accountId);
  const workingDir = pickFrom(MP_LAYOUTS, "cc-mach-layout::", accountId).replace("{u}", user).replace("{r}", repo);
  return {
    profile: {
      stainlessOS: "Linux",
      stainlessArch: "x64",
      platform: "linux",
      osVersion: `Linux ${line}-${nn}-generic`,
    },
    shell,
    workingDir,
    home: `/home/${user}`,
  };
}

export function machineKernelRelease(m: AccountMachine): string {
  return m.profile.osVersion.replace(/^Linux\s+/, "");
}

export function machineUnameArch(m: AccountMachine): string {
  return m.profile.stainlessArch === "arm64" ? "aarch64" : "x86_64";
}

export function machineDistro(m: AccountMachine): { id: string; version: string; pretty: string } {
  const kernel = machineKernelRelease(m);
  const line = kernel.split("-")[0];
  if (line === "6.11.0") return { id: "ubuntu", version: "24.10", pretty: "Ubuntu 24.10" };
  if (line === "6.14.0") return { id: "ubuntu", version: "25.04", pretty: "Ubuntu 25.04" };
  if (["5.15.0", "6.2.0", "6.5.0"].includes(line)) return { id: "ubuntu", version: "22.04", pretty: "Ubuntu 22.04.5 LTS" };
  return { id: "ubuntu", version: "24.04", pretty: "Ubuntu 24.04.5 LTS" };
}

export function machineOsRelease(m: AccountMachine): string {
  const d = machineDistro(m);
  return `NAME="Ubuntu"\nID=${d.id}\nVERSION_ID="${d.version}"\nPRETTY_NAME="${d.pretty}"\n`;
}

export function machineProcVersion(m: AccountMachine): string {
  return `Linux version ${machineKernelRelease(m)} (build@localhost) #1 SMP PREEMPT_DYNAMIC\n`;
}
