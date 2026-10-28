import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type Vendor = "anthropic" | "openai";

export interface DetectedCredential {
  vendor: Vendor;
  source: string;
  accessToken: string;
  refreshToken?: string;
  /** ISO 8601 */
  expiresAt?: string;
  tokenType?: string;
  scope?: string;
  accountEmail?: string;
  subscriptionType?: string;
  /** ChatGPT account id (Codex OAuth), sent as chatgpt-account-id upstream. */
  accountId?: string;
}

/** Decodes a JWT payload without verifying the signature (display metadata only). */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

function isoFromEpochMs(ms: unknown): string | undefined {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

function isoFromEpochSec(sec: unknown): string | undefined {
  if (typeof sec !== "number" || !Number.isFinite(sec)) return undefined;
  return new Date(sec * 1000).toISOString();
}

function claudeCredentialsPath(): string {
  const fromEnv = process.env.PROVIDER_CLAUDE_CREDENTIALS_PATH;
  if (fromEnv && fromEnv.trim()) return fromEnv;
  return path.join(os.homedir(), ".claude", ".credentials.json");
}

function codexAuthPath(): string {
  const fromEnv = process.env.PROVIDER_CODEX_AUTH_PATH;
  if (fromEnv && fromEnv.trim()) return fromEnv;
  return path.join(os.homedir(), ".codex", "auth.json");
}

function readJson(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function detectClaude(): DetectedCredential | null {
  const source = claudeCredentialsPath();
  const root = readJson(source);
  const oauth = root?.claudeAiOauth as Record<string, unknown> | undefined;
  const accessToken = oauth?.accessToken;
  if (typeof accessToken !== "string" || !accessToken) return null;
  const payload = decodeJwtPayload(accessToken);
  const scopes = Array.isArray(oauth?.scopes) ? (oauth.scopes as unknown[]).filter((s) => typeof s === "string").join(" ") : undefined;
  return {
    vendor: "anthropic",
    source,
    accessToken,
    refreshToken: typeof oauth.refreshToken === "string" ? oauth.refreshToken : undefined,
    expiresAt: isoFromEpochMs(oauth.expiresAt) ?? isoFromEpochSec(payload?.exp),
    tokenType: "Bearer",
    scope: scopes,
    accountEmail: typeof payload?.email === "string" ? payload.email : undefined,
    subscriptionType:
      typeof oauth.subscriptionType === "string" ? oauth.subscriptionType : undefined,
  };
}

function detectCodex(): DetectedCredential | null {
  const source = codexAuthPath();
  const root = readJson(source);
  const tokens = root?.tokens as Record<string, unknown> | undefined;
  if (!tokens) return null;
  const accessToken =
    typeof tokens.access_token === "string" ? tokens.access_token : undefined;
  const idToken = typeof tokens.id_token === "string" ? tokens.id_token : undefined;
  if (!accessToken && !idToken) return null;
  const payload =
    (idToken ? decodeJwtPayload(idToken) : null) ??
    (accessToken ? decodeJwtPayload(accessToken) : null);
  const authClaim = payload?.["https://api.openai.com/auth"] as
    | Record<string, unknown>
    | undefined;
  const plan =
    (typeof authClaim?.chatgpt_plan_type === "string" && authClaim.chatgpt_plan_type) ||
    (typeof payload?.plan === "string" && payload.plan) ||
    undefined;
  return {
    vendor: "openai",
    source,
    accessToken: (accessToken ?? idToken) as string,
    refreshToken: typeof tokens.refresh_token === "string" ? tokens.refresh_token : undefined,
    accountId:
      typeof tokens.account_id === "string"
        ? tokens.account_id
        : typeof authClaim?.chatgpt_account_id === "string"
          ? authClaim.chatgpt_account_id
          : undefined,
    expiresAt: isoFromEpochSec(payload?.exp),
    tokenType: "Bearer",
    accountEmail:
      typeof payload?.email === "string"
        ? payload.email
        : typeof payload?.["https://api.openai.com/profile"] === "object" &&
            payload["https://api.openai.com/profile"] !== null &&
            typeof (payload["https://api.openai.com/profile"] as Record<string, unknown>).email ===
              "string"
          ? ((payload["https://api.openai.com/profile"] as Record<string, unknown>)
              .email as string)
          : undefined,
    subscriptionType: plan,
  };
}

/** Probes this machine for locally installed vendor CLI credentials. */
export function detectLocalCredentials(): DetectedCredential[] {
  const out: DetectedCredential[] = [];
  const claude = detectClaude();
  if (claude) out.push(claude);
  const codex = detectCodex();
  if (codex) out.push(codex);
  return out;
}

export function maskToken(token: string): string {
  if (token.length <= 12) return "***";
  return `${token.slice(0, 8)}…${token.slice(-4)}`;
}

/** Redacted view safe for the local console / status API. */
export function redactCredential(cred: DetectedCredential): Omit<DetectedCredential, "accessToken" | "refreshToken"> & { accessTokenMasked: string; hasRefreshToken: boolean } {
  const { accessToken, refreshToken, ...rest } = cred;
  return { ...rest, accessTokenMasked: maskToken(accessToken), hasRefreshToken: Boolean(refreshToken) };
}
