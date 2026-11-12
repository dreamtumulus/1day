import crypto from "node:crypto";
import type { Json, RuntimeAccount } from "./types.js";

export interface AccountMachine {
  profile: { stainlessOS: string; stainlessArch: string; platform: string; osVersion: string };
  shell: string;
  workingDir: string;
  home: string;
}

const USERS = ["dev", "alex", "chen", "sam", "jordan", "taylor", "morgan", "casey"];
const REPOS = ["api-server", "backend", "monorepo", "cli-tools", "scripts", "web-app", "infra", "core"];

function number(accountId: string, salt: string): number {
  return Number.parseInt(crypto.createHash("sha256").update(`${salt}${accountId}`).digest("hex").slice(0, 12), 16);
}

export function accountMachine(account: RuntimeAccount): AccountMachine {
  const user = USERS[number(account.id, "user:") % USERS.length];
  const repo = REPOS[number(account.id, "repo:") % REPOS.length];
  const kernel = 20 + number(account.id, "kernel:") % 60;
  return {
    profile: { stainlessOS: "Linux", stainlessArch: "x64", platform: "linux", osVersion: `Linux 6.8.0-${kernel}-generic` },
    shell: "bash",
    workingDir: `/home/${user}/projects/${repo}`,
    home: `/home/${user}`,
  };
}

export function machineHeaders(machine: AccountMachine): Record<string, string> {
  return { "x-stainless-os": machine.profile.stainlessOS, "x-stainless-arch": machine.profile.stainlessArch };
}

function environmentBlock(text: string, machine: AccountMachine, sessionId: string): string {
  if (!text.startsWith("# Environment") || !text.includes("invoked in the following environment")) return text;
  let out = text;
  out = out.replace(/^( - Primary working directory: ).*$/m, `$1${machine.workingDir}`);
  out = out.replace(/^( - Platform: ).*$/m, `$1${machine.profile.platform}`);
  out = out.replace(/^( - Shell: ).*$/m, `$1${machine.shell}`);
  out = out.replace(/^( - OS Version: ).*$/m, `$1${machine.profile.osVersion}`);
  const scratch = `${machine.home}/.claude/projects/${sessionId}/scratchpad`;
  out = out.replace(/^( - Scratchpad directory: )[^\n]*?( — )/m, `$1${scratch}$2`);
  return out;
}

function rewrite(content: unknown, machine: AccountMachine, sessionId: string): { content: unknown; changed: boolean } {
  if (typeof content === "string") return { content: environmentBlock(content, machine, sessionId), changed: content !== environmentBlock(content, machine, sessionId) };
  if (!Array.isArray(content)) return { content, changed: false };
  let changed = false;
  const next = content.map((block) => {
    if (block && typeof block === "object" && typeof block.text === "string") {
      const text = environmentBlock(block.text, machine, sessionId);
      if (text !== block.text) {
        changed = true;
        return { ...block, text };
      }
    }
    return block;
  });
  return { content: next, changed };
}

export function pinMachineEnvironment(body: Json, machine: AccountMachine, sessionId: string): Json {
  let out = body;
  if (Array.isArray(out.messages)) {
    let changed = false;
    const messages = out.messages.map((message: Json) => {
      if (!message || message.role !== "system") return message;
      const result = rewrite(message.content, machine, sessionId);
      if (result.changed) {
        changed = true;
        return { ...message, content: result.content };
      }
      return message;
    });
    if (changed) out = { ...out, messages };
  }
  if (out.system !== undefined) {
    const result = rewrite(out.system, machine, sessionId);
    if (result.changed) out = { ...out, system: result.content };
  }
  return out;
}
