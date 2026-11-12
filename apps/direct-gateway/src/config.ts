import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AccountConfig, GatewayConfig } from "./types.js";

export function defaultConfigPath(): string {
  return path.join(os.homedir(), ".config", "1dayapi-direct", "config.json");
}

function resolveSecret(value: string): string {
  if (!value.startsWith("env:")) return value;
  const name = value.slice(4);
  const resolved = process.env[name];
  if (!resolved) throw new Error(`Missing required environment variable: ${name}`);
  return resolved;
}

function account(value: unknown, index: number): AccountConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`accounts[${index}] must be an object`);
  const a = value as Record<string, unknown>;
  if (typeof a.id !== "string" || !/^[a-zA-Z0-9._-]+$/.test(a.id)) throw new Error(`accounts[${index}].id is invalid`);
  if (typeof a.proxy !== "string" || !a.proxy) throw new Error(`accounts[${index}].proxy is required; direct egress is forbidden`);
  const out = { ...a, proxy: resolveSecret(a.proxy) } as unknown as AccountConfig;
  for (const key of ["accessToken", "refreshToken", "apiKey"] as const) {
    const v = a[key];
    if (typeof v === "string" && v) out[key] = resolveSecret(v);
  }
  if (!out.accessToken && !out.apiKey) throw new Error(`accounts[${index}] requires accessToken or apiKey`);
  if (out.baseUrl) {
    const url = new URL(out.baseUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`accounts[${index}].baseUrl must be HTTP(S)`);
  }
  return out;
}

export function loadConfig(configPath = process.env.DIRECT_GATEWAY_CONFIG ?? defaultConfigPath()): GatewayConfig {
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
  const keys = Array.isArray(raw.clientApiKeys) ? raw.clientApiKeys.map((v) => typeof v === "string" ? resolveSecret(v) : "").filter(Boolean) : [];
  if (keys.length === 0) throw new Error("clientApiKeys must contain at least one key");
  if (!Array.isArray(raw.accounts) || raw.accounts.length === 0) throw new Error("accounts must contain at least one account");
  const accounts = raw.accounts.map(account);
  if (new Set(accounts.map((a) => a.id)).size !== accounts.length) throw new Error("account ids must be unique");
  const listen = (raw.listen ?? {}) as Record<string, unknown>;
  const companion = (raw.companion ?? {}) as Record<string, unknown>;
  return {
    nodeName: typeof raw.nodeName === "string" && raw.nodeName ? raw.nodeName : "worker-0",
    listen: {
      host: typeof listen.host === "string" && listen.host ? listen.host : "127.0.0.1",
      port: Number.isInteger(listen.port) ? Number(listen.port) : 8410,
    },
    clientApiKeys: keys,
    accounts,
    companion: {
      enabled: companion.enabled === true,
      claudeBin: typeof companion.claudeBin === "string" && companion.claudeBin ? companion.claudeBin : "claude",
      restartDelayMs: Number.isFinite(companion.restartDelayMs) ? Math.max(0, Number(companion.restartDelayMs)) : 5000,
      startupStaggerMs: Number.isFinite(companion.startupStaggerMs) ? Math.max(0, Number(companion.startupStaggerMs)) : 500,
    },
  };
}
