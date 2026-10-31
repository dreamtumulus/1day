import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SERVICE_NAME = "1dayapi-provider-node.service";

export function unitDir(): string {
  return (
    process.env.PROVIDER_SYSTEMD_USER_DIR ??
    path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "systemd", "user")
  );
}

export function unitPath(): string {
  return path.join(unitDir(), SERVICE_NAME);
}

/** The wrapper the unit should exec; the installer-baked wrapper exports this. */
function nodeBinWrapper(): string {
  return process.env.PROVIDER_NODE_BIN ?? "/usr/local/bin/1dayapi-node";
}

function renderUnit(): string {
  return `[Unit]
Description=1DayAPI Provider Node
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${nodeBinWrapper()} serve
Restart=always
RestartSec=5
Environment=PROVIDER_CONSOLE_HOST=127.0.0.1
Environment=PROVIDER_CONSOLE_PORT=16889
${process.getuid?.() === 0 ? "Environment=CC_WORKER_MACHINE_IDENTITY=1" : ""}

[Install]
WantedBy=default.target
`;
}

export function systemdUserAvailable(): boolean {
  const r = spawnSync("systemctl", ["--user", "is-system-running"], {
    stdio: "pipe",
    timeout: 5_000,
  });
  if (r.error) return false;
  const err = r.stderr?.toString() ?? "";
  // No user manager (WSL without systemd, containers): "Failed to connect to bus".
  if (err.includes("Failed to connect to bus") || err.includes("No such file")) return false;
  const out = r.stdout?.toString().trim() ?? "";
  // "offline" = systemd is not PID 1 at all (e.g. this WSL). Anything else
  // ("running"/"degraded"/"starting"/...) means a live manager.
  return ["running", "degraded", "starting", "activating", "maintenance"].includes(out);
}

function systemctlUser(args: string[]): { ok: boolean; output: string } {
  const r = spawnSync("systemctl", ["--user", ...args], { stdio: "pipe", timeout: 15_000 });
  const output = `${r.stdout?.toString() ?? ""}${r.stderr?.toString() ?? ""}`.trim();
  return { ok: r.status === 0, output };
}

function failWith(message: string): never {
  console.error(`error: ${message || "command failed"}`);
  process.exit(1);
}

export async function cmdInstallService(): Promise<void> {
  fs.mkdirSync(unitDir(), { recursive: true });
  fs.writeFileSync(unitPath(), renderUnit());
  console.log(`wrote ${unitPath()}`);
  if (!systemdUserAvailable()) {
    console.log("warning: systemd --user is not reachable on this machine (unit file installed only).");
    console.log(`on a systemd host run: systemctl --user daemon-reload && systemctl --user enable ${SERVICE_NAME}`);
    return;
  }
  let r = systemctlUser(["daemon-reload"]);
  if (!r.ok) failWith(r.output);
  r = systemctlUser(["enable", SERVICE_NAME]);
  if (!r.ok) failWith(r.output);
  console.log(`enabled ${SERVICE_NAME}`);
  const linger = spawnSync("loginctl", ["show-user", os.userInfo().username, "-p", "Linger", "--value"], {
    stdio: "pipe",
    timeout: 5_000,
  });
  if (linger.status !== 0 || linger.stdout?.toString().trim() !== "yes") {
    console.log(`hint: to keep the node running after logout: sudo loginctl enable-linger ${os.userInfo().username}`);
  }
  console.log("next: 1dayapi-node restart");
}

export async function cmdUninstallService(): Promise<void> {
  if (systemdUserAvailable()) {
    systemctlUser(["disable", "--now", SERVICE_NAME]); // best effort
  }
  try {
    fs.unlinkSync(unitPath());
    console.log(`removed ${unitPath()}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") console.log("service unit not installed");
    else throw err;
  }
  if (systemdUserAvailable()) systemctlUser(["daemon-reload"]);
}

async function waitConsoleReady(timeoutSeconds: number): Promise<boolean> {
  const base = process.env.PROVIDER_CONSOLE_URL ?? "http://127.0.0.1:16889";
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(base + "/api/status", { signal: AbortSignal.timeout(2_000) });
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

export async function cmdServiceControl(verb: "start" | "stop" | "restart"): Promise<void> {
  if (!systemdUserAvailable()) {
    throw new Error(
      "systemd --user is not reachable on this machine; run the node in the foreground with `1dayapi-node serve`",
    );
  }
  const r = systemctlUser([verb, SERVICE_NAME]);
  if (!r.ok) failWith(r.output);
  console.log(`${verb}: ok`);
  if (verb !== "stop") {
    const timeout = Number(process.env.PROVIDER_CONSOLE_READY_TIMEOUT ?? 15);
    const up = await waitConsoleReady(timeout);
    console.log(up ? `console ready at ${process.env.PROVIDER_CONSOLE_URL ?? "http://127.0.0.1:16889"}` : `warning: console did not come up within ${timeout}s — check 1dayapi-node logs`);
  }
}

export function cmdLogs(): void {
  const child = spawn("journalctl", ["--user-unit", SERVICE_NAME, "-f", "--output=short-iso"], {
    stdio: "inherit",
  });
  child.on("error", (err) => failWith(err.message));
  child.on("exit", (code) => process.exit(code ?? 0));
}

export async function cmdDoctor(): Promise<void> {
  const checks: Array<[string, string, boolean]> = [];
  const add = (name: string, detail: string, ok: boolean): void => {
    checks.push([name, detail, ok]);
  };

  const bunVersion = (globalThis as { Bun?: { version?: string } }).Bun?.version;
  add(
    "runtime",
    bunVersion ? `bun ${bunVersion} (${process.execPath})` : `node ${process.version} (${process.execPath}) — protocol v2 requires Bun 1.4.x`,
    Boolean(bunVersion),
  );

  const configPath =
    process.env.PROVIDER_CONFIG_PATH ??
    path.join(os.homedir(), ".config", "1dayapi-provider-node", "config.json");
  add("config", `${configPath} ${fs.existsSync(configPath) ? "(exists)" : "(will be created on first run)"}`, true);

  add("cli wrapper", nodeBinWrapper(), fs.existsSync(nodeBinWrapper()) || !process.env.PROVIDER_NODE_BIN);

  const systemdOk = systemdUserAvailable();
  add("systemd --user", systemdOk ? "available" : "unreachable (WSL/container? use foreground serve)", true);
  add("unit file", `${unitPath()} ${fs.existsSync(unitPath()) ? "(installed)" : "(not installed — run install-service)"}`, fs.existsSync(unitPath()) || !systemdOk);

  let dockerOk = false;
  try {
    dockerOk = spawnSync("docker", ["info"], { stdio: "pipe", timeout: 5_000 }).status === 0;
  } catch {
    dockerOk = false;
  }
  add("docker", dockerOk ? "available" : "unavailable (Dockerfile/compose.yaml untested at runtime)", true);

  const base = process.env.PROVIDER_CONSOLE_URL ?? "http://127.0.0.1:16889";
  let consoleOk = false;
  let consoleDetail = "unreachable (node not running)";
  try {
    const res = await fetch(base + "/api/status", { signal: AbortSignal.timeout(2_000) });
    if (res.ok) {
      const j = (await res.json()) as { bound?: boolean; nodeId?: string };
      consoleOk = true;
      consoleDetail = `${base} reachable, nodeId=${j.nodeId}, bound=${j.bound}`;
    }
  } catch {
    /* down */
  }
  add("local console", consoleDetail, true);

  let failed = 0;
  for (const [name, detail, ok] of checks) {
    if (!ok) failed += 1;
    console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${detail}`);
  }
  if (failed > 0) process.exit(1);
}
