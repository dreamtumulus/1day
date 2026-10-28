import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isoIn } from "@1dayapi/core";

// Authorize bot runner (docs/onboarding.md §8). The bot is a server-side
// python script executed via ONBOARD_BOT_CMD (xvfb + Chromium for the
// session_key full flow; pure token exchange for --callback). Protocol: the
// bot prints log lines and a final `RESULT {json}` line on stdout.
//
// ONBOARD_BOT_MOCK=1 returns a canned success without spawning (e2e / dev).

const BOT_TIMEOUT_MS = 300_000; // bot 内部截止 240s，留 60s 余量

export interface BotResult {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
  orgUuid?: string;
  accountUuid?: string;
  environmentId?: string;
  email?: string;
  error?: string;
}

function botCmd(): string[] {
  return (process.env.ONBOARD_BOT_CMD ?? "xvfb-run -a /opt/ccr-lab/venv/bin/python /opt/ccr-lab/onboard_bot.py")
    .split(/\s+/)
    .filter(Boolean);
}

/** Cheap preflight: every executable/script the command line names must exist. */
export function botAvailable(): boolean {
  if (process.env.ONBOARD_BOT_MOCK === "1") return true;
  for (const token of botCmd()) {
    if (token.startsWith("-")) continue;
    if (token.includes("/")) {
      if (!existsSync(token)) return false;
    } else if (spawnSync("which", [token], { stdio: "ignore" }).status !== 0) {
      return false;
    }
  }
  return true;
}

export class BotUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BotUnavailableError";
  }
}

function mockResult(): BotResult {
  return {
    accessToken: "sk-ant-oat-mock",
    refreshToken: "sk-ant-ort-mock",
    expiresAt: isoIn(8 * 3_600_000),
    orgUuid: "org_mock",
    accountUuid: "acct_mock",
    environmentId: "env_mock",
    email: "mock@example.com",
  };
}

/** Secrets the bot needs; sent as one JSON line on stdin (never on argv: /proc/<pid>/cmdline is world-readable). */
export interface BotInput {
  sk?: string;
  callback?: string;
  job_state?: { codeVerifier: string; state: string };
  proxy: string;
}

/** Spawn the bot (`--args-stdin`), feed it the JSON input; resolve with the parsed RESULT line. */
export function runBot(input: BotInput): Promise<BotResult> {
  if (process.env.ONBOARD_BOT_MOCK === "1") return Promise.resolve(mockResult());
  return new Promise((resolve, reject) => {
    const [cmd, ...base] = botCmd();
    // detached: the wrapper (xvfb-run) is a shell script; killing only it would
    // leave Xvfb + Chromium behind. Own process group → kill the whole tree.
    const child = spawn(cmd, [...base, "--args-stdin"], { stdio: ["pipe", "pipe", "pipe"], detached: true });
    const killTree = () => {
      if (child.exitCode !== null || !child.pid) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(input) + "\n");
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      killTree();
      reject(new Error(`onboard bot timed out after ${BOT_TIMEOUT_MS}ms`));
    }, BOT_TIMEOUT_MS);
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new BotUnavailableError(`onboard bot spawn failed: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const lines = stdout.trim().split("\n");
      const last = lines[lines.length - 1] ?? "";
      if (!last.startsWith("RESULT ")) {
        reject(new Error(`bot exited code=${code} without a RESULT line: ${stderr.trim().slice(-300)}`));
        return;
      }
      try {
        resolve(JSON.parse(last.slice(7)) as BotResult);
      } catch {
        reject(new Error(`bot RESULT line is not valid JSON: ${last.slice(0, 200)}`));
      }
    });
  });
}
