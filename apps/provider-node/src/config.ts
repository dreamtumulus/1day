import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decryptSecret, encryptSecret, isEncrypted, loadMasterKey } from "./crypto.js";
import { NODE_VERSION } from "./version.js";

export const DEFAULT_PLATFORM_WS_URL = "ws://localhost:8401/internal/provider/connect";

/** Config file path: PROVIDER_CONFIG_PATH overrides, else ~/.config/1dayapi-provider-node/config.json */
export function resolveConfigPath(): string {
  const fromEnv = process.env.PROVIDER_CONFIG_PATH;
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv);
  return path.join(os.homedir(), ".config", "1dayapi-provider-node", "config.json");
}

export interface NodeConfigData {
  nodeId: string;
  nodeVersion: string;
  providerId?: string;
  providerNodeSecret?: string;
  platformWsUrl?: string;
  platformHttpUrl?: string;
  boundAt?: string;
  /** v2 proxy pool (URLs may carry userinfo passwords; encrypted at rest). */
  proxies?: string[];
  /** v2 sticky proxy assignment: accountId -> proxyUrl (encrypted at rest). */
  proxyAssignments?: Record<string, string>;
  proxyTeams?: Record<string, string>;
  proxyAccounts?: Record<string, string[]>;
}

const SENSITIVE_FIELDS = ["providerNodeSecret"] as const;

/** Structured sensitive fields, stored as enc:v1:<aes-gcm(JSON.stringify(value))>. */
const SENSITIVE_JSON_FIELDS = ["proxies", "proxyAssignments", "proxyTeams", "proxyAccounts"] as const;

export class NodeConfigStore {
  readonly configPath: string;
  readonly keyPath: string;
  private masterKey: Buffer | null = null;
  data: NodeConfigData;

  constructor(configPath = resolveConfigPath()) {
    this.configPath = configPath;
    this.keyPath = path.join(path.dirname(configPath), "config.key");
    this.data = this.load();
    this.key(); // ensure config.key exists from first boot
  }

  private key(): Buffer {
    if (!this.masterKey) this.masterKey = loadMasterKey(this.keyPath);
    return this.masterKey;
  }

  private load(): NodeConfigData {
    let raw: Record<string, unknown> = {};
    try {
      raw = JSON.parse(fs.readFileSync(this.configPath, "utf8")) as Record<string, unknown>;
      fs.chmodSync(this.configPath, 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    for (const field of SENSITIVE_FIELDS) {
      const value = raw[field];
      if (isEncrypted(value)) raw[field] = decryptSecret(value, this.key());
    }
    for (const field of SENSITIVE_JSON_FIELDS) {
      const value = raw[field];
      if (isEncrypted(value)) {
        try {
          raw[field] = JSON.parse(decryptSecret(value, this.key())) as unknown;
        } catch {
          raw[field] = undefined;
        }
      }
    }
    const data: NodeConfigData = {
      nodeId: typeof raw.nodeId === "string" && raw.nodeId ? raw.nodeId : crypto.randomUUID(),
      nodeVersion: NODE_VERSION,
      providerId: typeof raw.providerId === "string" ? raw.providerId : undefined,
      providerNodeSecret:
        typeof raw.providerNodeSecret === "string" ? raw.providerNodeSecret : undefined,
      platformWsUrl: typeof raw.platformWsUrl === "string" ? raw.platformWsUrl : undefined,
      platformHttpUrl: typeof raw.platformHttpUrl === "string" ? raw.platformHttpUrl : undefined,
      boundAt: typeof raw.boundAt === "string" ? raw.boundAt : undefined,
      proxies: parseProxyList(raw.proxies),
      proxyAssignments: parseProxyAssignments(raw.proxyAssignments),
      proxyTeams: parseProxyAssignments(raw.proxyTeams),
      proxyAccounts: raw.proxyAccounts && typeof raw.proxyAccounts === "object" && !Array.isArray(raw.proxyAccounts)
        ? Object.fromEntries(Object.entries(raw.proxyAccounts as Record<string, unknown>).filter(([, v]) => Array.isArray(v) && v.every((x) => typeof x === "string"))) as Record<string, string[]>
        : undefined,
    };
    // Persist immediately so nodeId (and the master key) exist from first boot.
    this.data = data;
    this.save();
    return data;
  }

  save(): void {
    const dir = path.dirname(this.configPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    const out: Record<string, unknown> = { ...this.data };
    for (const field of SENSITIVE_FIELDS) {
      const value = this.data[field];
      if (typeof value === "string" && value) out[field] = encryptSecret(value, this.key());
    }
    for (const field of SENSITIVE_JSON_FIELDS) {
      const value = this.data[field];
      if (value === undefined) {
        delete out[field];
      } else {
        out[field] = encryptSecret(JSON.stringify(value), this.key());
      }
    }
    fs.writeFileSync(this.configPath, JSON.stringify(out, null, 2) + "\n", { mode: 0o600 });
  }

  get bound(): boolean {
    return Boolean(this.data.providerId && this.data.providerNodeSecret);
  }

  setBinding(binding: {
    providerId: string;
    providerNodeSecret: string;
    platformWsUrl?: string;
    platformHttpUrl?: string;
  }): void {
    this.data.providerId = binding.providerId;
    this.data.providerNodeSecret = binding.providerNodeSecret;
    if (binding.platformWsUrl) this.data.platformWsUrl = binding.platformWsUrl;
    if (binding.platformHttpUrl) this.data.platformHttpUrl = binding.platformHttpUrl;
    this.data.boundAt = new Date().toISOString();
    this.save();
  }

  /** Clears binding material; nodeId survives unbind (it identifies this installation). */
  resetBinding(): void {
    this.data.providerId = undefined;
    this.data.providerNodeSecret = undefined;
    this.data.platformWsUrl = undefined;
    this.data.platformHttpUrl = undefined;
    this.data.boundAt = undefined;
    this.save();
  }
}

function parseProxyList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const urls = value.filter((v): v is string => typeof v === "string" && v.length > 0);
  return urls.length > 0 ? urls : undefined;
}

function parseProxyAssignments(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "string" && v) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** ws:// -> http://, wss:// -> https:// */
export function httpBaseFromWsUrl(wsUrl: string): string {
  if (wsUrl.startsWith("wss://")) return "https://" + wsUrl.slice("wss://".length);
  if (wsUrl.startsWith("ws://")) return "http://" + wsUrl.slice("ws://".length);
  return wsUrl;
}

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

export function resolvePlatformWsUrl(store: NodeConfigStore): string {
  const fromEnv = process.env.PROVIDER_PLATFORM_WS_URL;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return store.data.platformWsUrl ?? DEFAULT_PLATFORM_WS_URL;
}

export function resolvePlatformHttpUrl(store: NodeConfigStore): string {
  const fromEnv = process.env.PROVIDER_PLATFORM_HTTP_URL;
  if (fromEnv && fromEnv.trim()) return stripTrailingSlash(fromEnv.trim());
  if (store.data.platformHttpUrl) return stripTrailingSlash(store.data.platformHttpUrl);
  const wsUrl = resolvePlatformWsUrl(store);
  // Strip the WS path to get the HTTP base for /internal/provider/* calls.
  const base = httpBaseFromWsUrl(wsUrl).replace(/\/internal\/provider\/connect$/, "");
  return stripTrailingSlash(base);
}
