import type { FastifyReply, FastifyRequest } from "fastify";
import { nowIso, one, parseAllowlist, settleRequestDurably, settlementHealthy, sha256Hex, type ModelAllowlist, parseKeyPolicy, type KeyPolicy } from "@1dayapi/core";
import { clientIp } from "./http.js";
import { sendError } from "./http.js";
import type { ClientFormat } from "./upstream.js";

// API-key authentication for inference (docs/v3-design.md §4).

export interface CallerContext {
  apiKeyId: string;
  apiKeyName: string;
  userId: string;
  role: string;
  balanceUsd: number;
  /** limit − used + prepaid balance (docs/data-model.md §4); admission requires > 0. */
  availableUsd: number;
  groupId: string;
  groupName: string;
  rateMultiplier: number;
  allowlist: ModelAllowlist;
  /** Per-key routing policy (docs/gateway.md §2b). */
  policy: KeyPolicy;
}

interface Row {
  key_id: string;
  key_name: string;
  key_status: string;
  quota_usd: number;
  used_usd: number;
  expires_at: string | null;
  user_id: string;
  role: string;
  user_status: string;
  balance_usd: number;
  credit_limit_usd: number;
  credit_used_usd: number;
  group_id: string;
  group_name: string | null;
  group_status: string | null;
  rate_multiplier: number | null;
  model_allowlist: string | null;
  is_exclusive: number;
  policy_json: string | null;
}

export function extractKey(req: FastifyRequest): string | null {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    const t = auth.slice(7).trim();
    if (t) return t;
  }
  const x = req.headers["x-api-key"];
  if (typeof x === "string" && x.trim()) return x.trim();
  return null;
}

/**
 * Resolve the caller. When `forInference` is set, also enforce balance and
 * quota. Sends the error reply and returns null on failure.
 */
export function authenticate(
  req: FastifyRequest,
  reply: FastifyReply,
  format: ClientFormat,
  forInference: boolean,
): CallerContext | null {
  const key = extractKey(req);
  if (!key) {
    sendError(reply, format, 401, "invalid_api_key", "Missing API key. Use 'Authorization: Bearer sk-1d-…' or 'x-api-key'.", "authentication_error");
    return null;
  }
  const r = one<Row>(
    `SELECT k.id AS key_id, k.name AS key_name, k.status AS key_status, k.quota_usd, k.used_usd, k.expires_at,
            u.id AS user_id, u.role, u.status AS user_status, u.balance_usd, u.credit_limit_usd, u.credit_used_usd,
            k.group_id, g.name AS group_name, g.status AS group_status, g.rate_multiplier, g.model_allowlist, g.is_exclusive, k.policy_json
     FROM api_keys k JOIN users u ON u.id = k.user_id LEFT JOIN groups g ON g.id = k.group_id
     WHERE k.key_hash = ?`,
    sha256Hex(key),
  );
  if (!r) {
    sendError(reply, format, 401, "invalid_api_key", "Invalid API key.", "authentication_error");
    return null;
  }
  if (r.key_status !== "active") {
    sendError(reply, format, 401, "key_disabled", "This API key is disabled.", "authentication_error");
    return null;
  }
  if (r.expires_at && r.expires_at <= nowIso()) {
    sendError(reply, format, 401, "key_expired", "This API key has expired.", "authentication_error");
    return null;
  }
  if (r.user_status !== "active") {
    sendError(reply, format, 401, "user_disabled", "This account is disabled.", "authentication_error");
    return null;
  }
  if (r.role === "provider" || r.role === "ops") {
    sendError(reply, format, 403, "role_not_permitted", "Provider and account-ops accounts cannot call inference.", "permission_error");
    return null;
  }
  if (!r.group_name || r.group_status !== "active") {
    sendError(reply, format, 403, "group_disabled", "The group bound to this API key is unavailable.", "permission_error");
    return null;
  }
  if (r.is_exclusive === 1 && r.role !== "admin" && !one("SELECT 1 FROM user_allowed_groups WHERE user_id = ? AND group_id = ?", r.user_id, r.group_id)) {
    sendError(reply, format, 403, "group_access_revoked", "Access to this exclusive group has been revoked.", "permission_error");
    return null;
  }
  if (forInference) {
    if (!settlementHealthy()) {
      sendError(reply, format, 503, "settlement_unavailable", "Accounting is recovering pending settlements. Retry shortly.", "billing_error");
      return null;
    }
    const reject = (status: number, code: string, message: string, type: Parameters<typeof sendError>[5]) => {
      // Admission failure after the caller is known: write a zero-cost usage row so the
      // error log shows it (docs/console-api.md 错误日志). Never throws.
      try {
        const body = (req.body && typeof req.body === "object" ? req.body : {}) as { model?: unknown; stream?: unknown };
        settleRequestDurably({
          requestId: crypto.randomUUID(),
          userId: r.user_id,
          apiKeyId: r.key_id,
          groupId: r.group_id,
          rateMultiplier: r.rate_multiplier ?? 1,
          accountId: null,
          providerId: null,
          payoutRate: 0,
          model: typeof body.model === "string" && body.model ? body.model : "-",
          upstreamModel: null,
          endpoint: req.url.split("?")[0],
          stream: body.stream === true,
          statusCode: status,
          errorCode: code,
          usage: { input_tokens: 0, output_tokens: 0 },
          usageEstimated: false,
          durationMs: 0,
          clientIp: clientIp(req),
          errorMessage: message,
        });
      } catch (err) {
        console.error("[auth] failed to log admission failure:", err);
      }
      sendError(reply, format, status, code, message, type);
    };
    const available = r.credit_limit_usd - r.credit_used_usd + r.balance_usd;
    if (available <= 0) {
      if (r.credit_limit_usd > 0) {
        reject(402, "credit_exhausted", `Credit line exhausted (used ${r.credit_used_usd.toFixed(2)} of ${r.credit_limit_usd.toFixed(2)} USD). Settle with the administrator to restore it.`, "billing_error");
      } else {
        reject(402, "insufficient_balance", "Insufficient balance. Redeem a code or contact the administrator.", "billing_error");
      }
      return null;
    }
    if (r.quota_usd > 0 && r.used_usd >= r.quota_usd) {
      reject(429, "quota_exhausted", "This API key has used up its quota.", "billing_error");
      return null;
    }
  }
  return {
    apiKeyId: r.key_id,
    apiKeyName: r.key_name,
    userId: r.user_id,
    role: r.role,
    balanceUsd: r.balance_usd,
    availableUsd: r.credit_limit_usd - r.credit_used_usd + r.balance_usd,
    groupId: r.group_id,
    groupName: r.group_name,
    rateMultiplier: r.rate_multiplier ?? 1,
    allowlist: parseAllowlist(r.model_allowlist),
    policy: parseKeyPolicy(r.policy_json, r.group_id),
  };
}
