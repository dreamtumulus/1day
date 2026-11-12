import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AccountConfig, AccountCredential, AccountState, GatewayState, RuntimeAccount } from "./types.js";

const PREFIX = "enc:v1:";

function masterKey(keyPath: string): Buffer {
  try {
    const bytes = Buffer.from(fs.readFileSync(keyPath, "utf8").trim(), "base64url");
    if (bytes.length !== 32) throw new Error("invalid key length");
    fs.chmodSync(keyPath, 0o600);
    return crypto.createHash("sha256").update(bytes).digest();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const bytes = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(keyPath, bytes.toString("base64url"), { mode: 0o600 });
  return crypto.createHash("sha256").update(bytes).digest();
}

function encrypt(value: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return PREFIX + [iv, cipher.getAuthTag(), body].map((b) => b.toString("base64url")).join(".");
}

function decrypt(value: string, key: Buffer): string {
  if (!value.startsWith(PREFIX)) return value;
  const [iv, tag, body] = value.slice(PREFIX.length).split(".").map((v) => Buffer.from(v, "base64url"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

export class StateStore {
  readonly statePath: string;
  private readonly key: Buffer;
  private state: GatewayState = { accounts: {} };

  constructor(configPath: string) {
    this.statePath = path.join(path.dirname(configPath), "state.json");
    this.key = masterKey(path.join(path.dirname(configPath), "config.key"));
    if (fs.existsSync(this.statePath)) {
      const raw = JSON.parse(fs.readFileSync(this.statePath, "utf8")) as { accounts?: Record<string, Record<string, unknown>> };
      for (const [id, value] of Object.entries(raw.accounts ?? {})) {
        const out = { ...value } as Record<string, unknown>;
        for (const field of ["accessToken", "refreshToken", "apiKey"] as const) {
          if (typeof out[field] === "string") out[field] = decrypt(out[field], this.key);
        }
        this.state.accounts[id] = out as unknown as AccountState;
      }
      fs.chmodSync(this.statePath, 0o600);
    }
  }

  account(config: AccountConfig, nodeName: string): RuntimeAccount {
    const existing = this.state.accounts[config.id];
    const deviceId = config.deviceId ?? existing?.deviceId ?? crypto.createHash("sha256").update(`1dayapi-direct:${nodeName}:${config.id}`).digest("hex");
    const state: AccountState = {
      deviceId,
      accountUuid: config.accountUuid ?? existing?.accountUuid,
      accessToken: existing?.accessToken ?? config.accessToken,
      refreshToken: existing?.refreshToken ?? config.refreshToken,
      expiresAt: existing?.expiresAt ?? config.expiresAt,
      apiKey: existing?.apiKey ?? config.apiKey,
    };
    this.state.accounts[config.id] = state;
    this.save();
    return { ...config, ...state, baseUrl: (config.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "") };
  }

  updateCredential(accountId: string, credential: AccountCredential): void {
    const current = this.state.accounts[accountId];
    if (!current) throw new Error(`Unknown account state: ${accountId}`);
    this.state.accounts[accountId] = { ...current, ...credential };
    this.save();
  }

  private save(): void {
    const accounts: Record<string, Record<string, unknown>> = {};
    for (const [id, value] of Object.entries(this.state.accounts)) {
      const out = { ...value } as Record<string, unknown>;
      for (const field of ["accessToken", "refreshToken", "apiKey"] as const) {
        if (typeof out[field] === "string") out[field] = encrypt(out[field], this.key);
      }
      accounts[id] = out;
    }
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true, mode: 0o700 });
    const tmp = `${this.statePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ accounts }, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, this.statePath);
    fs.chmodSync(this.statePath, 0o600);
  }
}
