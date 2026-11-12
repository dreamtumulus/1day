import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Egress } from "./egress.js";
import type { StateStore } from "./state.js";
import type { GatewayConfig, RuntimeAccount } from "./types.js";

const SCOPES = ["user:profile", "user:inference", "user:sessions:claude_code", "user:mcp_servers", "user:file_upload"];

interface CompanionProcess {
  child: ChildProcess;
  hash: string;
  stopping: boolean;
  restartTimer: NodeJS.Timeout | null;
}

export class CompanionManager {
  private readonly processes = new Map<string, CompanionProcess>();
  private stopping = false;

  constructor(private readonly config: GatewayConfig, private readonly state: StateStore, private readonly egress: Egress) {}

  get enabled(): boolean {
    return this.config.companion?.enabled === true;
  }

  stats(): { enabled: boolean; running: number; startingOrFailed: number } {
    const running = [...this.processes.values()].filter((p) => p.child.exitCode === null && !p.child.killed).length;
    return { enabled: this.enabled, running, startingOrFailed: this.enabled ? this.config.accounts.filter((a) => a.enabled !== false).length - running : 0 };
  }

  async startAll(accounts: RuntimeAccount[]): Promise<void> {
    if (!this.enabled) return;
    for (const account of accounts) {
      await this.sync(account);
      const stagger = this.config.companion?.startupStaggerMs ?? 500;
      if (stagger > 0) await new Promise((resolve) => setTimeout(resolve, stagger));
    }
  }

  async sync(account: RuntimeAccount): Promise<void> {
    if (!this.enabled || this.stopping) return;
    const hash = this.hash(account);
    const existing = this.processes.get(account.id);
    if (existing?.hash === hash && existing.child.exitCode === null && !existing.child.killed) return;
    if (existing) await this.stop(account.id);
    if (existing?.restartTimer) clearTimeout(existing.restartTimer);
    const configDir = this.materialize(account);
    const proxy = await this.egress.proxyFor(account);
    this.launch(account, configDir, proxy, hash);
  }

  private hash(account: RuntimeAccount): string {
    return crypto.createHash("sha256").update(JSON.stringify({
      accessToken: account.accessToken,
      refreshToken: account.refreshToken,
      expiresAt: account.expiresAt,
      apiKey: account.apiKey,
      deviceId: account.deviceId,
      accountUuid: account.accountUuid,
      proxy: account.proxy,
      baseUrl: account.baseUrl,
    })).digest("hex");
  }

  private materialize(account: RuntimeAccount): string {
    const dir = path.join(path.dirname(this.state.statePath), "companions", account.id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    const claudeJson = path.join(dir, ".claude.json");
    if (!fs.existsSync(claudeJson)) {
      fs.writeFileSync(claudeJson, JSON.stringify({
        userID: account.deviceId,
        firstStartTime: new Date().toISOString(),
        ...(account.accountUuid ? { oauthAccount: { accountUuid: account.accountUuid, emailAddress: "", displayName: "", fullName: "", profileFetchedAt: Date.now() } } : {}),
      }), { mode: 0o600 });
    }
    const credentials = path.join(dir, ".credentials.json");
    if (account.accessToken) {
      fs.writeFileSync(credentials, JSON.stringify({
        claudeAiOauth: {
          accessToken: account.accessToken,
          refreshToken: account.refreshToken,
          expiresAt: Date.parse(account.expiresAt ?? "") || Date.now() + 8 * 3_600_000,
          scopes: SCOPES,
          subscriptionType: "pro",
        },
      }), { mode: 0o600 });
    } else if (fs.existsSync(credentials)) fs.rmSync(credentials);
    const settings = path.join(dir, "settings.json");
    if (!fs.existsSync(settings)) fs.writeFileSync(settings, JSON.stringify({ hasCompletedOnboarding: true }), { mode: 0o600 });
    return dir;
  }

  private launch(account: RuntimeAccount, configDir: string, proxy: string, hash: string): void {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "",
      HOME: configDir,
      TMPDIR: configDir,
      CLAUDE_CONFIG_DIR: configDir,
      ANTHROPIC_BASE_URL: account.baseUrl,
      HTTPS_PROXY: proxy,
      HTTP_PROXY: proxy,
      https_proxy: proxy,
      http_proxy: proxy,
      CLAUDE_CODE_NO_MODEL_FALLBACK: "1",
      CLAUDE_CODE_DISABLE_FILE_MENTIONS: "1",
      CLAUDE_CODE_DISABLE_ATTACHMENTS: "1",
    };
    if (account.apiKey && !account.accessToken) env.ANTHROPIC_API_KEY = account.apiKey;
    const child = spawn(this.config.companion?.claudeBin ?? "claude", [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--tools", "",
      "--no-session-persistence",
    ], {
      cwd: configDir,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    const record: CompanionProcess = { child, hash, stopping: false, restartTimer: null };
    this.processes.set(account.id, record);
    child.stdin?.on("error", () => {});
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", () => {});
    child.on("error", () => {});
    child.on("exit", (code, signal) => {
      if (this.processes.get(account.id) !== record) return;
      this.processes.delete(account.id);
      if (!record.stopping && !this.stopping) {
        console.warn(`[companion] account=${account.id} exited code=${code} signal=${signal}; restarting`);
        record.restartTimer = setTimeout(() => void this.sync(account).catch((error) => console.warn(`[companion] account=${account.id} restart failed: ${(error as Error).message}`)), this.config.companion?.restartDelayMs ?? 5000);
        record.restartTimer.unref?.();
      }
    });
    console.log(`[companion] account=${account.id} started pid=${child.pid}`);
  }

  private async stop(accountId: string): Promise<void> {
    const record = this.processes.get(accountId);
    if (!record) return;
    record.stopping = true;
    if (record.restartTimer) clearTimeout(record.restartTimer);
    this.processes.delete(accountId);
    if (record.child.exitCode === null && !record.child.killed) {
      try { if (record.child.pid) process.kill(-record.child.pid, "SIGTERM"); } catch { record.child.kill("SIGTERM"); }
    }
  }

  async stopAll(): Promise<void> {
    this.stopping = true;
    await Promise.all([...this.processes.keys()].map((id) => this.stop(id)));
  }
}
