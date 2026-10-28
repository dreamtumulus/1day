import {
  EXECUTORS,
  PLATFORMS,
  defaultProtocol,
  getPlatform,
  isCcrExecutor,
  isValidHttpUrl,
  readCredential,
  type AccountRow,
  type Credential,
  type Executor,
  type Protocol,
} from "@1dayapi/core";
import { bad, oneOf, str, strArray, strMap, type Body } from "./http.js";

// Validation of upstream-account input shared by admin and provider routes
// (docs/v3-design.md §5).

export const ACCOUNT_TYPES = ["apikey", "upstream", "oauth"] as const;
export const PROTOCOLS = ["anthropic", "openai"] as const;
const PLATFORM_IDS = PLATFORMS.map((p) => p.id);

export interface AccountFields {
  name?: string;
  platform?: string;
  type?: AccountRow["type"];
  executor?: Executor;
  protocol?: Protocol;
  baseUrl?: string | null;
  credential?: Credential;
  models?: string[];
  modelMapping?: Record<string, string> | null;
}

/** Decode the JWT payload (no verification) — used to read ChatGPT account ids / emails. */
export function jwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function chatgptAccountId(accessToken: string): string | undefined {
  const auth = jwtPayload(accessToken)?.["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
  return typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined;
}

/**
 * Parse account fields from a request body. `existing` is the current row
 * for PATCH (credential fields merge onto the stored credential).
 */
export function parseAccountFields(b: Body, existing: AccountRow | null, allowOauth: boolean): AccountFields {
  const out: AccountFields = {};
  const name = str(b, "name", { max: 80 });
  if (name !== undefined) out.name = name;
  else if (!existing) bad("invalid_request", "name is required");

  const platform = oneOf(b, "platform", PLATFORM_IDS, !existing);
  if (platform) out.platform = platform;
  const type = oneOf(b, "type", ACCOUNT_TYPES, !existing);
  if (type) {
    if (type === "oauth" && !allowOauth) bad("invalid_request", "OAuth accounts are uploaded through a provider node");
    out.type = type;
  }
  const effPlatform = out.platform ?? existing?.platform ?? "openai";
  const effType = out.type ?? existing?.type ?? "apikey";
  if (effType === "oauth" && effPlatform !== "anthropic" && effPlatform !== "openai") {
    bad("invalid_request", "OAuth accounts are only supported for anthropic and openai");
  }

  const executor = oneOf(b, "executor", EXECUTORS);
  if (executor && isCcrExecutor(executor) && !(effType === "oauth" && effPlatform === "anthropic")) {
    bad("invalid_request", "executor=ccr/ccr_worker requires an anthropic OAuth account");
  }
  if (executor) out.executor = executor;
  else if (!existing) out.executor = "direct";
  // PATCH that moves a ccr account away from anthropic OAuth without naming an
  // executor: fall back to direct rather than keeping an impossible combination.
  else if (isCcrExecutor(existing.executor) && !(effType === "oauth" && effPlatform === "anthropic")) out.executor = "direct";

  const protocol = oneOf(b, "protocol", PROTOCOLS);
  if (protocol) out.protocol = protocol;
  else if (!existing || out.platform) out.protocol = defaultProtocol(effPlatform);

  if ("baseUrl" in b) {
    const raw = b.baseUrl === null ? "" : (str(b, "baseUrl", { max: 300 }) ?? "");
    if (raw && !isValidHttpUrl(raw)) bad("invalid_request", "baseUrl must be an http(s) URL");
    out.baseUrl = raw ? raw.replace(/\/+$/, "") : null;
  }
  const effBase = out.baseUrl !== undefined ? out.baseUrl : (existing?.base_url ?? null);
  if (effType !== "oauth" && !effBase && !getPlatform(effPlatform)?.baseUrl) {
    bad("invalid_request", `baseUrl is required for platform '${effPlatform}'`);
  }
  if (effType === "upstream" && !effBase) bad("invalid_request", "baseUrl is required for upstream (relay) accounts");

  // credential
  const prev: Credential = existing ? safeCredential(existing) : {};
  if (effType === "oauth") {
    const accessToken = str(b, "accessToken", { max: 8000 });
    const refreshToken = str(b, "refreshToken", { max: 8000 });
    const expiresAt = str(b, "expiresAt", { max: 40 });
    const accountId = str(b, "accountId", { max: 120 });
    const orgUuid = str(b, "orgUuid", { max: 80 });
    const environmentId = str(b, "environmentId", { max: 120 });
    if (accessToken || refreshToken || expiresAt || accountId || orgUuid || environmentId || !existing) {
      const next: Credential = {
        accessToken: accessToken ?? prev.accessToken,
        refreshToken: refreshToken ?? prev.refreshToken,
        expiresAt: expiresAt ?? prev.expiresAt,
        accountId: accountId ?? prev.accountId,
        orgUuid: orgUuid ?? prev.orgUuid,
        environmentId: environmentId ?? prev.environmentId,
      };
      if (!next.accessToken) bad("invalid_request", "accessToken is required for OAuth accounts");
      if (effPlatform === "openai" && !next.accountId) next.accountId = chatgptAccountId(next.accessToken);
      out.credential = next;
    }
  } else {
    const apiKey = str(b, "apiKey", { max: 4000 });
    if (apiKey) out.credential = { apiKey };
    else if (!existing) bad("invalid_request", "apiKey is required");
  }

  const models = strArray(b, "models");
  if (models !== undefined) out.models = models;
  if (effType === "upstream" && !existing && (!out.models || out.models.length === 0) && effPlatform === "custom") {
    bad("invalid_request", "models is required for custom upstream accounts");
  }
  const mapping = strMap(b, "modelMapping");
  if (mapping !== undefined) out.modelMapping = mapping && Object.keys(mapping).length ? mapping : null;
  return out;
}

function safeCredential(a: AccountRow): Credential {
  try {
    return readCredential(a);
  } catch {
    return {};
  }
}

/** True when the change touches what the account connects to (provider edits -> re-review). */
export function touchesConnection(f: AccountFields): boolean {
  return (
    f.credential !== undefined ||
    f.baseUrl !== undefined ||
    f.platform !== undefined ||
    f.type !== undefined ||
    f.protocol !== undefined
  );
}
