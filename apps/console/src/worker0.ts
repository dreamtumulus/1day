import crypto from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { bad, body, str } from "./http.js";
import {
  availableUsd,
  classifyDirectRateLimit,
  fableRejectedWindow,
  getModelEntry,
  isModelAllowed,
  listCandidates,
  markFailure,
  nowIso,
  one,
  parseAllowlist,
  parseUnifiedRateLimitHeaders,
  readCredential,
  recordWindowUsage,
  rejectedWindow,
  settleRequestDurably,
  settlementHealthy,
  sha256Hex,
  touchAccount,
  tx,
  writeCredential,
  type Credential,
  type SettleInput,
  type TokenUsage,
} from "@1dayapi/core";

interface Caller {
  userId: string;
  apiKeyId: string;
  groupId: string;
  rateMultiplier: number;
  availableUsd: number;
  quotaUsd: number;
  usedUsd: number;
  role: string;
  allowlist: ReturnType<typeof parseAllowlist>;
  isExclusive: number;
}

function authorized(request: FastifyRequest): boolean {
  const expected = process.env.WORKER0_CONTROL_TOKEN;
  const provided = request.headers["x-worker0-token"];
  if (!expected || typeof provided !== "string") return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireWorker0(request: FastifyRequest): void {
  if (!authorized(request)) throw Object.assign(new Error("worker-0 control endpoint is disabled or the token is invalid"), { statusCode: 403, code: "worker0_forbidden" });
}

function caller(clientKey: string): Caller {
  const r = one<Record<string, any>>(
    `SELECT k.id AS key_id, k.status AS key_status, k.quota_usd, k.used_usd, k.expires_at,
            u.id AS user_id, u.role, u.status AS user_status, u.balance_usd, u.credit_limit_usd, u.credit_used_usd,
            k.group_id, g.status AS group_status, g.rate_multiplier, g.model_allowlist, g.is_exclusive
     FROM api_keys k JOIN users u ON u.id=k.user_id LEFT JOIN groups g ON g.id=k.group_id WHERE k.key_hash=?`,
    sha256Hex(clientKey),
  );
  if (!r) bad("invalid_api_key", "Invalid API key", 401);
  if (r.key_status !== "active") bad("key_disabled", "This API key is disabled", 401);
  if (r.expires_at && r.expires_at <= nowIso()) bad("key_expired", "This API key has expired", 401);
  if (r.user_status !== "active") bad("user_disabled", "This account is disabled", 401);
  if (r.role === "provider" || r.role === "ops") bad("role_not_permitted", "Provider and account-ops accounts cannot call inference", 403);
  if (!r.group_id || r.group_status !== "active") bad("group_disabled", "The group bound to this API key is unavailable", 403);
  if (r.is_exclusive === 1 && r.role !== "admin" && !one("SELECT 1 FROM user_allowed_groups WHERE user_id=? AND group_id=?", r.user_id, r.group_id)) bad("group_access_revoked", "Access to this exclusive group has been revoked", 403);
  return {
    userId: r.user_id,
    apiKeyId: r.key_id,
    groupId: r.group_id,
    rateMultiplier: r.rate_multiplier ?? 1,
    availableUsd: availableUsd({ credit_limit_usd: r.credit_limit_usd, credit_used_usd: r.credit_used_usd, balance_usd: r.balance_usd }),
    quotaUsd: r.quota_usd,
    usedUsd: r.used_usd,
    role: r.role,
    allowlist: parseAllowlist(r.model_allowlist),
    isExclusive: r.is_exclusive,
  };
}

function usage(value: unknown): TokenUsage {
  if (!value || typeof value !== "object" || Array.isArray(value)) bad("invalid_request", "usage must be an object");
  const u = value as Record<string, unknown>;
  return {
    input_tokens: Number(u.input_tokens ?? 0),
    output_tokens: Number(u.output_tokens ?? 0),
    cache_read_tokens: Number(u.cache_read_tokens ?? 0),
    cache_write_tokens: Number(u.cache_write_tokens ?? 0),
    cache_write_5m_tokens: Number(u.cache_write_5m_tokens ?? 0),
    cache_write_1h_tokens: Number(u.cache_write_1h_tokens ?? 0),
  };
}

function settleWithCaller(request: FastifyRequest, c: Caller): ReturnType<typeof settleRequestDurably> {
  const b = body(request);
  const accountId = str(b, "accountId") ?? null;
  const account = accountId ? one<Record<string, any>>("SELECT a.*, u.role AS owner_role FROM accounts a JOIN users u ON u.id=a.owner_id WHERE a.id=?", accountId) : null;
  if (accountId && !account) bad("account_not_found", "Serving account not found", 404);
  if (account && !one("SELECT 1 FROM account_groups WHERE account_id=? AND group_id=?", accountId, c.groupId)) bad("account_group_mismatch", "Serving account is not in the caller group", 403);
  const model = str(b, "model", { required: true })!;
  const input: SettleInput = {
    requestId: str(b, "requestId", { required: true })!,
    userId: c.userId,
    apiKeyId: c.apiKeyId,
    groupId: c.groupId,
    rateMultiplier: c.rateMultiplier,
    accountId,
    providerId: account?.owner_role === "provider" ? account.owner_id : null,
    payoutRate: account?.payout_rate ?? 0,
    model,
    upstreamModel: str(b, "upstreamModel") ?? model,
    actualModel: str(b, "actualModel") ?? null,
    endpoint: str(b, "endpoint", { required: true })!,
    stream: b.stream === true,
    statusCode: Number(b.statusCode),
    errorCode: str(b, "errorCode") ?? null,
    errorScope: str(b, "errorScope") as SettleInput["errorScope"],
    retryable: typeof b.retryable === "boolean" ? b.retryable : null,
    usage: usage(b.usage),
    usageEstimated: b.usageEstimated === true,
    durationMs: Number.isFinite(b.durationMs) ? Number(b.durationMs) : null,
    firstTokenMs: Number.isFinite(b.firstTokenMs) ? Number(b.firstTokenMs) : null,
    selectionMs: Number.isFinite(b.selectionMs) ? Number(b.selectionMs) : null,
    streamTruncated: b.streamTruncated === true,
    toolCalls: Number.isFinite(b.toolCalls) ? Number(b.toolCalls) : 0,
    toolResults: Number.isFinite(b.toolResults) ? Number(b.toolResults) : 0,
    clientIp: str(b, "clientIp") ?? null,
    ccShape: str(b, "ccShape") as SettleInput["ccShape"],
    errorMessage: str(b, "errorMessage") ?? null,
    mode: str(b, "mode") ?? "worker0",
    upstreamStatus: Number.isFinite(b.upstreamStatus) ? Number(b.upstreamStatus) : null,
    nodeId: str(b, "nodeId") ?? "worker-0",
    accountSwitched: b.accountSwitched === true,
    teamId: account?.team_id ?? null,
    proxyId: account?.bound_proxy_id ?? null,
  };
  return settleRequestDurably(input);
}

export function registerWorker0Routes(app: FastifyInstance): void {
  app.addHook("preHandler", async (request) => {
    if (request.url.startsWith("/internal/worker0/")) requireWorker0(request);
  });

  app.post("/internal/worker0/admission", async (request) => {
    const b = body(request);
    const clientKey = str(b, "clientKey", { required: true })!;
    const model = str(b, "model", { required: true })!;
    const c = caller(clientKey);
    const requestId = str(b, "requestId") ?? crypto.randomUUID();
    const reject = (status: number, code: string, message: string): never => {
      settleRequestDurably({
        requestId,
        userId: c.userId,
        apiKeyId: c.apiKeyId,
        groupId: c.groupId,
        rateMultiplier: c.rateMultiplier,
        accountId: null,
        providerId: null,
        payoutRate: 0,
        model,
        upstreamModel: model,
        endpoint: str(b, "endpoint") ?? "/v1/messages",
        stream: b.stream === true,
        statusCode: status,
        errorCode: code,
        errorMessage: message,
        usage: { input_tokens: 0, output_tokens: 0 },
        usageEstimated: false,
        mode: "worker0-admission",
        nodeId: "worker-0",
      });
      bad(code, message, status);
    };
    if (!settlementHealthy()) reject(503, "settlement_unavailable", "Accounting is recovering pending settlements");
    if (c.availableUsd <= 0) reject(402, "insufficient_balance", "Insufficient balance or credit");
    if (c.quotaUsd > 0 && c.usedUsd >= c.quotaUsd) reject(429, "quota_exhausted", "This API key has used up its quota");
    if (!getModelEntry(model)) reject(404, "model_not_found", "Unknown model");
    if (!isModelAllowed(c.allowlist, model)) reject(403, "model_not_allowed", "Model is not allowed for this group");
    const candidates = listCandidates(c.groupId, model);
    if (candidates.length === 0) reject(503, "no_available_account", "No account is currently schedulable");
    return { data: { requestId, accountIds: candidates.map((a) => a.id), coolingAccountIds: candidates.filter((a) => a.cooling).map((a) => a.id) } };
  });

  app.post("/internal/worker0/settle", async (request) => {
    const c = caller(str(body(request), "clientKey", { required: true })!);
    return { data: settleWithCaller(request, c) };
  });

  app.post("/internal/worker0/account-event", async (request) => {
    const b = body(request);
    const accountId = str(b, "accountId", { required: true })!;
    const model = str(b, "model", { required: true })!;
    const status = Number(b.statusCode);
    const headers = (b.headers && typeof b.headers === "object" ? b.headers : {}) as Record<string, string>;
    const text = typeof b.body === "string" ? b.body.slice(0, 64 * 1024) : "";
    const snap = parseUnifiedRateLimitHeaders(headers);
    if (snap) recordWindowUsage(accountId, snap);
    if (status >= 200 && status < 300) touchAccount(accountId);
    if (status === 402) markFailure(accountId, { kind: "payment" });
    else if (status === 401 || status === 403) {
      if (/account is on hold|can't use Claude Code|restricted/i.test(text)) markFailure(accountId, { kind: "auth", message: `account on hold: ${text.slice(0, 400)}` });
      else markFailure(accountId, { kind: "transient", message: `upstream auth HTTP ${status}`, cooldownMs: 300_000 });
    } else if (status === 429) {
      const rejected = rejectedWindow(snap, nowIso());
      const fable = /fable/i.test(model) ? fableRejectedWindow(snap, nowIso()) : null;
      const classified = classifyDirectRateLimit(text, !!rejected);
      if (fable) markFailure(accountId, { kind: "model_window_rejected", scope: "fable", resetAt: fable.resetAt, reason: "7d_oi rejected (429)" });
      else if (rejected) markFailure(accountId, { kind: "window_rejected", window: rejected.window, resetAt: rejected.resetAt });
      else if (classified.scope === "account_model") markFailure(accountId, { kind: "model_rate_limited", model, retryAfterSec: Number(b.retryAfterSec) || undefined, reason: classified.code });
      else if (classified.scope === "account") markFailure(accountId, { kind: "rate_limited", retryAfterSec: Number(b.retryAfterSec) || undefined });
    } else if (status === 503 || status === 529) markFailure(accountId, { kind: "overloaded" });
    else if (status >= 500) markFailure(accountId, { kind: "transient", message: `upstream HTTP ${status}` });
    return { data: { recorded: true } };
  });

  app.post("/internal/worker0/credential-rotation", async (request) => {
    const b = body(request);
    const accountId = str(b, "accountId", { required: true })!;
    const expected = str(b, "expectedRefreshToken", { required: true })!;
    const next = b.credential as Credential;
    if (!next || typeof next.accessToken !== "string" || typeof next.refreshToken !== "string" || typeof next.expiresAt !== "string") bad("invalid_request", "credential requires accessToken, refreshToken and expiresAt");
    return tx(() => {
      const row = one<{ credential_enc: string }>("SELECT credential_enc FROM accounts WHERE id=?", accountId);
      if (!row) bad("account_not_found", "Serving account not found", 404);
      const current = readCredential(row);
      if (current.refreshToken !== expected) return { data: { rotated: false, conflict: true, credential: current } };
      writeCredential(accountId, next);
      return { data: { rotated: true, conflict: false, credential: next } };
    });
  });
}
