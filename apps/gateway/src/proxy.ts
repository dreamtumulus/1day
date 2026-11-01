import crypto from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  accountBaseUrl,
  accountTeamId,
  getConversation,
  getConversationByExternalKey,
  getConversationBoundary,
  saveBranchBoundary,
  isConversationGenerationActive,
  type ConversationBoundary,
  acquireConversationLease,
  renewConversationLease,
  releaseConversationLease,
  conversationLeaseHeld,
  bindConversationTeam,
  resetConversationGeneration,
  saveConversationBoundary,
  type ConversationRow,
  one,
  boundProxyDown,
  getModelEntry,
  getSetting,
  hasSubscriptionWindow,
  isModelAllowed,
  listCandidates,
  markFailure,
  nowIso,
  parseUnifiedRateLimitHeaders,
  recordWindowUsage,
  rejectedWindow,
  settleRequestDurably as settleRequest,
  acquireRequestBudget, renewRequestBudget, releaseRequestBudget,
  sha256Hex,
  sessionUuidFromHash,
  sessionMetadataUserId,
  touchAccount,
  upstreamModelFor,
  groupIsRawPassthrough,
  type AccountRow,
  type Candidate,
  type WindowSnapshot,
  classifyCcRequest,
  parseCcShapePolicy,
  isClaudeCodeUa,
  fableRejectedWindow,
  isCreditsRequired,
  ccLimitReset,
  modelScope,
  modelSuspensionSummary,
  parseModelSuspension,
  clearAffinityBindings,
  countAffinityBindings,
  loadDeviceBinding,
  loadStickyBinding,
  saveDeviceBinding,
  saveStickyBinding,
  sweepAffinityBindings,
  refreshCooldownUntil,
  classifyDirectRateLimit,
  classifyTransportFailure,
  upstreamMessage,
  type UpstreamFailure,
  featureFor,
} from "@1dayapi/core";
import { authenticate, type CallerContext } from "./auth.js";
import { PROBE_WINDOW_MS, detectProbe, poolHealth, probeReply, type ProbeVerdict } from "./probe.js";
import { AUTH_FAILURE_COOLDOWN_MS, AuthFailureTracker, isCcAccountOnHold, isCcAuthFailure } from "./ccr/auth-failure.js";
import { classifyCcRequestError, isCcModelUnavailable } from "./ccr/model-unavailable.js";
import { config } from "./config.js";
import {
  AnthropicToOpenaiStream,
  OpenaiToAnthropicStream,
  anthropicMessageToOpenai,
  openaiChatToAnthropicMessage,
} from "./convert.js";
import { CORS_HEADERS, conversationResponseHeaders, clientIp, errorBody, makeTeeProof, sendError, teeProofRequested } from "./http.js";
import { armNonStreamHeartbeat, beginEarlyStream, endEarlyJson, endEarlyJsonWithError, endEarlyStreamWithError, stopEarlyKeepalive, stopNonStreamHeartbeat } from "./heartbeat.js";
import { runCcr, retireCcrConversation } from "./ccr/executor.js";
import { runCcrWorker } from "./ccr/worker.js";
import { ccrUnsupportedReason, type CcrUnsupported } from "./ccr/translate.js";
import { openaiChatToAnthropic } from "./convert.js";
import { postRaw } from "./rawhttp.js";
import { SharedAccountGates, type AccountLease } from "./limits.js";
import { TunnelRequestError, fetchViaTunnel, resetConversationWorkers, type IsolationContext } from "./tunnel.js";
import { applyResetBoundary, isToolContinuation, latestQuestion, resetBody, requestMessages, resolveConversationIdentity, conversationBranchKey, RESET_NOTICE } from "./conversation.js";
import {
  buildUpstreamRequest,
  outgoingProfileCheck,
  canRefresh,
  freshCredential,
  isCcrMode,
  modeFor,
  wireModeFor,
  type ClientFormat,
  type Mode,
  shapingFor,
} from "./upstream.js";
import { wait, responseBytes } from "./lifecycle.js";
import { bump } from "./metrics.js";
import { UsageAccumulator, collectText, estimateRequestTokens } from "./usage.js";
import { orderByMerklePrefix, rememberMerklePrefix } from "./merkle-affinity.js";

type Json = Record<string, any>;

// ---------- per-account gates: concurrency + RPM + bound-proxy liveness ----------
// (in-process, docs/v3-design.md §7.5 and docs/onboarding.md §6.1/§6.3).
// A gate rejection is a skip, never a failure: no cooldown is recorded.

const gates = new SharedAccountGates();
export function accountInFlight(id: string): number {
  return gates.inFlightCount(id);
}
export function inFlightSnapshot(): Record<string, number> {
  return gates.snapshot();
}
// ---------- sticky sessions (sub2api GenerateSessionHash) ----------
//
// Key sources, highest priority first:
//   1. metadata.user_id → the client's own session id (Claude Code sends
//      `user_<hash>_account_<uuid>_session_<uuid>` or a JSON {device_id, session_id})
//   2. content blocks marked cache_control (the prompt-cache prefix the client wants kept warm)
//   3. api key + client ip + user-agent + system text + all message texts
// TTL from settings.sticky_session_ttl_sec (default 30 min).
//
// Persistence (2026-10-21, core/affinity.ts): the Map is only the hot cache.
// Every binding is written through to the affinity_bindings table and a miss
// is looked up there, so a blue/green release (ops/bin/gateway-switch) does not
// start with empty maps and re-deal every live conversation and device to a
// new account — that made Anthropic see devices hop between accounts, rebuilt
// prompt caches, and (because the new process had no "previous" binding) the
// hop was never flagged account_switched, so never refunded.

const sticky = new Map<string, { accountId: string; expiresAt: number }>();

/** Live sticky binding: process cache first, then the shared table (the other instance may have written it). */
function getSticky(key: string, now = Date.now()): { accountId: string; expiresAt: number } | undefined {
  const hit = sticky.get(key);
  if (hit && hit.expiresAt >= now) return hit;
  if (hit) sticky.delete(key);
  const stored = loadStickyBinding(key, now);
  if (stored) sticky.set(key, stored);
  return stored;
}

function stickyTtlMs(): number {
  const sec = Number(getSetting("sticky_session_ttl_sec"));
  return (Number.isFinite(sec) && sec > 0 ? sec : 1800) * 1000;
}

function blockTexts(content: unknown, onlyCacheable: boolean): string {
  if (typeof content === "string") return onlyCacheable ? "" : content;
  if (!Array.isArray(content)) return "";
  const out: string[] = [];
  for (const b of content as Json[]) {
    if (!b || typeof b !== "object") continue;
    if (onlyCacheable && !b.cache_control) continue;
    if (typeof b.text === "string") out.push(b.text);
    else if (b.type === "tool_result") out.push(blockTexts(b.content, false));
    else if (b.type === "tool_use") out.push(JSON.stringify(b.input ?? {}));
  }
  return out.join("\n");
}

/** Session id from Claude Code's metadata.user_id (legacy string or JSON form). */
export function sessionIdFromMetadata(userId: unknown): string | null {
  if (typeof userId !== "string" || !userId) return null;
  const raw = userId.trim();
  if (raw.startsWith("{")) {
    try {
      const j = JSON.parse(raw) as Json;
      return typeof j.session_id === "string" && j.session_id ? j.session_id : null;
    } catch {
      return null;
    }
  }
  const m = /session_([0-9a-fA-F-]{8,})/.exec(raw);
  return m ? m[1] : null;
}

export function stickyKey(caller: Pick<CallerContext, "apiKeyId">, body: Json, req: Pick<FastifyRequest, "headers" | "ip">): string | null {
  // The prompt cache is per account *and per model*: Claude Code runs its side
  // tasks (titles, summaries) on Sonnet/Haiku inside the same session, and when
  // such a call had to move accounts it used to drag the Opus binding along —
  // the next Opus turn then rewrote a 900K-token prefix on the new account
  // (安安, 2026-10-20 06:56). One binding per session × model keeps them apart.
  const model = typeof body.model === "string" ? body.model.trim() : "";
  const sid = sessionIdFromMetadata(body.metadata?.user_id);
  if (sid) return `s:${caller.apiKeyId}:${sid}:${model}`;
  const msgs: Json[] = Array.isArray(body.messages) ? body.messages : [];
  // Only the conversation root's breakpoints count (system + first user turn). Clients such as
  // opencode put cache_control on the *last* messages as well, so a key over every marked block
  // changed each turn: the conversation landed on a new account every request, never hit the
  // account-scoped prompt cache and never continued its worker process (reseller customer
  // conversation, 2026-10-23: 35 turns on 30 accounts, cache_read flat at the identity prefix).
  // The first user turn's own marking is not stable either (it is the last message, hence marked,
  // only on turn 1), so its text counts whether marked or not.
  const firstUser = msgs.find((m) => m?.role === "user");
  const cachedSystem = blockTexts(body.system, true);
  if (cachedSystem) return `c:${sha256Hex(`${caller.apiKeyId}|${model}|${cachedSystem}|${firstUser ? blockTexts(firstUser.content, false) : ""}`)}`;
  const ua = String(req.headers["user-agent"] ?? "").replace(/[\d.]+/g, "");
  // Conversation root only (system + first user turn): hashing the whole history
  // changed the key every turn, so multi-turn conversations hopped accounts and
  // never hit the account-scoped prompt cache (2026-10-17).
  const parts = [caller.apiKeyId, model, clientIp(req as FastifyRequest), ua, blockTexts(body.system, false)];
  if (firstUser) parts.push(blockTexts(firstUser.content, false));
  if (msgs.length === 0 && body.input !== undefined) parts.push(typeof body.input === "string" ? body.input : JSON.stringify(body.input));
  const text = parts.join("|");
  if (text.length <= caller.apiKeyId.length + 3) return null;
  return `f:${sha256Hex(text)}`;
}

function orderBySticky(cands: Candidate[], key: string | null): Candidate[] {
  if (!key) return cands;
  const hit = getSticky(key);
  if (!hit) return cands;
  const i = cands.findIndex((c) => c.id === hit.accountId);
  if (i <= 0) return cands;
  return [cands[i], ...cands.slice(0, i), ...cands.slice(i + 1)];
}

function rememberSticky(key: string | null, accountId: string): void {
  if (!key) return;
  if (sticky.size > 20_000) {
    const now = Date.now();
    for (const [k, v] of sticky) if (v.expiresAt < now) sticky.delete(k);
  }
  const expiresAt = Date.now() + stickyTtlMs();
  sticky.set(key, { accountId, expiresAt });
  saveStickyBinding(key, accountId, expiresAt);
}

// ---------- device affinity (2026-10-19) ----------
//
// A session key keeps one conversation on one account but says nothing about the
// other conversations of the same client machine, so a busy customer spread one
// device over dozens of accounts and every account served many devices, Claude
// Code versions and OSes in the same hour. The device key (api key + the client's
// metadata.user_id device_id) remembers the few accounts a device has recently
// used; they rank right after the sticky account, so a new conversation or a moved
// session lands on an account that already serves this device (and often still
// holds its warm prompt-cache prefix). Overflow beyond the pool behaves as before:
// the pool is a preference, not a cap.
// Settings: device_affinity_pool_size (default 3, 0 = off), device_affinity_ttl_sec (default 7200).

const devicePool = new Map<string, { accounts: string[]; expiresAt: number }>();

/** Live device pool: process cache first, then the shared table. */
function getDevicePool(key: string, now = Date.now()): { accounts: string[]; expiresAt: number } | undefined {
  const hit = devicePool.get(key);
  if (hit && hit.expiresAt >= now) return hit;
  if (hit) devicePool.delete(key);
  const stored = loadDeviceBinding(key, now);
  if (stored) devicePool.set(key, stored);
  return stored;
}

function devicePoolSize(): number {
  const n = Number(getSetting("device_affinity_pool_size"));
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 3;
}

function deviceTtlMs(): number {
  const sec = Number(getSetting("device_affinity_ttl_sec"));
  return (Number.isFinite(sec) && sec > 0 ? sec : 7200) * 1000;
}

/** Client device id from Claude Code's metadata.user_id (JSON `device_id` or legacy `user_<hex>`). */
export function deviceIdFromMetadata(userId: unknown): string | null {
  if (typeof userId !== "string" || !userId) return null;
  const raw = userId.trim();
  if (raw.startsWith("{")) {
    try {
      const j = JSON.parse(raw) as Json;
      return typeof j.device_id === "string" && /^[0-9a-f]{16,}$/i.test(j.device_id) ? j.device_id.toLowerCase() : null;
    } catch {
      return null;
    }
  }
  const m = /^user_([0-9a-fA-F]{16,})/.exec(raw);
  return m ? m[1].toLowerCase() : null;
}

export function deviceKey(caller: Pick<CallerContext, "apiKeyId">, body: Json): string | null {
  const id = deviceIdFromMetadata(body?.metadata?.user_id);
  return id ? `d:${caller.apiKeyId}:${id}` : null;
}

/** Sticky account first, then the device's recent accounts in recorded order, then everything else. */
export function orderByAffinity(cands: Candidate[], sessionKey: string | null, devKey: string | null, now = Date.now()): Candidate[] {
  const bySticky = orderBySticky(cands, sessionKey);
  if (!devKey) return bySticky;
  const pool = getDevicePool(devKey, now);
  if (!pool || pool.accounts.length === 0) return bySticky;
  const stickyHit = sessionKey ? getSticky(sessionKey, now) : undefined;
  const stickyId = stickyHit ? stickyHit.accountId : null;
  const rank = new Map(pool.accounts.map((id, i) => [id, i]));
  const head: Candidate[] = [];
  const known: Candidate[] = [];
  const rest: Candidate[] = [];
  for (const c of bySticky) {
    if (c.id === stickyId) head.push(c);
    else if (rank.has(c.id)) known.push(c);
    else rest.push(c);
  }
  known.sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  return [...head, ...known, ...rest];
}

/** Record that `accountId` served this device; a full pool is kept as is (overflow is not sticky). */
export function rememberDevice(devKey: string | null, accountId: string, now = Date.now()): void {
  if (!devKey) return;
  const size = devicePoolSize();
  if (size === 0) return;
  if (devicePool.size > 20_000) {
    for (const [k, v] of devicePool) if (v.expiresAt < now) devicePool.delete(k);
  }
  const prev = getDevicePool(devKey, now);
  const accounts = prev ? prev.accounts : [];
  if (!accounts.includes(accountId) && accounts.length < size) accounts.push(accountId);
  const expiresAt = now + deviceTtlMs();
  devicePool.set(devKey, { accounts, expiresAt });
  saveDeviceBinding(devKey, accounts, expiresAt);
}

// Expired bindings leave the table every 10 min (the process maps prune themselves on size).
const AFFINITY_SWEEP_MS = 10 * 60_000;
setInterval(() => {
  try {
    const n = sweepAffinityBindings();
    if (n > 0) console.log(`[affinity] swept ${n} expired bindings`);
  } catch (err) {
    console.warn(`[affinity] sweep failed: ${(err as Error).message}`);
  }
}, AFFINITY_SWEEP_MS).unref();

/** Startup line: how many live bindings this instance inherits from the previous one. */
export function affinityBindingsSummary(): string {
  const c = countAffinityBindings();
  return `${c.session} session / ${c.device} device bindings, ${c.turn} worker turn memories carried over`;
}

/** Test hooks: forget every binding / bind a session key the way a real hit would. */
export function resetAffinityForTests(): void {
  devicePool.clear();
  sticky.clear();
  clearAffinityBindings();
}
/** Tests only: forget the process maps but keep the table — what a gateway restart looks like. */
export function forgetAffinityMemoryForTests(): void {
  devicePool.clear();
  sticky.clear();
}
export function rememberStickyForTests(key: string, accountId: string): void {
  rememberSticky(key, accountId);
}

// ---------- passive subscription-window sampling (sub2api) ----------

/** Read anthropic-ratelimit-unified-* from an upstream response into the account row. */
function sampleWindow(account: AccountRow, headers: Headers): WindowSnapshot | null {
  if (!hasSubscriptionWindow(account)) return null;
  const snap = parseUnifiedRateLimitHeaders(headers);
  if (!snap) return null;
  try {
    recordWindowUsage(account.id, snap);
  } catch (err) {
    console.warn(`[window] sample write failed for ${account.id}: ${(err as Error).message}`);
  }
  return snap;
}

// ---------- main entry ----------

interface Ctx {
  req: FastifyRequest;
  reply: FastifyReply;
  format: ClientFormat;
  endpoint: string;
  caller: CallerContext;
  body: Json;
  model: string;
  stream: boolean;
  requestId: string;
  startedAt: number;
  selectionMs: number | null;
  executionSequence: number;
  credentialVersion: number | null;
  streamTruncated: boolean;
  /** Claude Code shape verdict (docs/gateway.md §2a); null = not a CC-UA request. */
  ccShape: "genuine" | "suspect" | null;
  /** settings cc_client_response_profile (spec WP1 §6): a Claude Code client gets no x-1day-* diagnostic headers. */
  hideDiagHeaders: boolean;
  /** Observability trace for the usage row: last path tried, its node, what upstream answered. */
  trace: { mode: Mode | null; nodeId: string | null; upstreamStatus: number | null; upstreamMessage: string | null; failure: UpstreamFailure | null };
  /**
   * sub2api ForceCacheBilling: the request had a live sticky binding but had to
   * run on a different account (cooldown / failover / proxy down), so its prompt
   * cache was rebuilt through no fault of the client. Settlement bills this
   * request's input_tokens at the cache-read price instead.
   */
  forceCacheBilling: boolean;
  /** The client's socket closed before the response finished (set by the listener attached at request start). */
  clientGone: boolean;
  /** Fired when the client goes away: whoever holds an upstream body cancels it. */
  abort: AbortController;
  /**
   * Streaming requests: response headers + a keepalive comment go out as soon as the first
   * upstream attempt starts (earlyStream), so neither Cloudflare's 125 s origin timeout nor a
   * client's time-to-first-byte timeout fires while upstream (or a failover chain) is still
   * working on it. Once started, errors are SSE `error` events, not HTTP statuses.
   */
  early: { keepalive: NodeJS.Timeout | null } | null;
  /**
   * Non-stream requests: the real HTTP status stays available for the first
   * NON_STREAM_HEARTBEAT_AFTER_MS; after that a 200 + JSON headers is committed and padded with
   * whitespace so Cloudflare / nginx / the client keep waiting for the body (heartbeat.ts).
   */
  jsonArm: NodeJS.Timeout | null;
  jsonEarly: { keepalive: NodeJS.Timeout | null } | null;
  scope?: ConversationScope;
  accountLease?: AccountLease;
}

const PASSTHROUGH_STATUSES = new Set([400, 404, 413, 422]);

interface ConversationScope {
  row: ConversationRow;
  token: string;
  reliable: boolean;
  originalBody: Json;
  triedTeams: Set<string>;
  lost: boolean;
  abort?: AbortController;
  responseCtx?: Ctx;
  justReset?: boolean;
  released?: boolean;
  branch: string;
  boundary?: ConversationBoundary;
}

function assertRequestLeases(ctx: Ctx): void {
  ctx.abort.signal.throwIfAborted();
  let budget;
  try { budget = one("SELECT 1 FROM gateway_request_budgets WHERE request_id = ? AND expires_at > ?", ctx.requestId, Date.now()); }
  catch (err) { ctx.abort.abort(err); throw err; }
  if (!budget || (ctx.accountLease && !ctx.accountLease.isValid())) {
    ctx.abort.abort(new Error("request scheduling lease lost"));
    throw new Error("request scheduling lease lost");
  }
}

function scopeContext(scope?: ConversationScope): IsolationContext | undefined {
  return scope?.row.team_id ? { teamId: scope.row.team_id, conversationId: scope.row.id, generation: scope.row.generation } : undefined;
}

function assertScope(scope?: ConversationScope): void {
  if (!scope) return;
  const current = scope.row.team_id ? isConversationGenerationActive(scope.row.id, scope.row.team_id, scope.row.generation) : conversationLeaseHeld(scope.row.id, scope.token, scope.row.generation);
  if (scope.lost || !current) throw new Error("conversation ownership changed");
}

function sendResetNotice(reply: FastifyReply, format: ClientFormat, body: Json, hideDiag = false): void {
  if (!reply.raw.headersSent && !hideDiag) reply.header("x-1day-context-reset", "1");
  sendSyntheticMessage(reply, format, body, RESET_NOTICE);
}

/** A platform-authored assistant message in the client's wire format (zero usage), non-stream or stream. */
function sendSyntheticMessage(reply: FastifyReply, format: ClientFormat, body: Json, text: string): void {
  const id = crypto.randomUUID();
  const send = (payload: unknown) => reply.raw.headersSent ? reply.raw.end(typeof payload === "string" ? payload : JSON.stringify(payload)) : reply.send(payload);
  const message = { id: `msg_${id}`, type: "message", role: "assistant", model: body.model ?? "", content: [{ type: "text", text: text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } };
  const chat = { id: `chatcmpl_${id}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: body.model ?? "", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
  if (body.stream === true) {
    reply.header("content-type", "text/event-stream; charset=utf-8");
    if (format === "anthropic") send(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { ...message, content: [], stop_reason: null } })}\n\nevent: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\nevent: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text } })}\n\nevent: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":0}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`);
    else if (format === "openai-chat") send(`data: ${JSON.stringify({ ...chat, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...chat, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    else send(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: `resp_${id}`, object: "response", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: text, annotations: [] }] }] } })}\n\n`);
  } else if (format === "anthropic") send(message);
  else if (format === "openai-chat") send(chat);
  else send({ id: `resp_${id}`, object: "response", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: text, annotations: [] }] }], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } });
}

/** Gateways take short metadata leases; normal execution remains parallel and epoch-fenced. */
const lifecycles = new WeakMap<FastifyRequest, { requestId: string; abort: AbortController }>();
export async function proxy(req: FastifyRequest, reply: FastifyReply, format: ClientFormat, endpoint: string): Promise<void> {
  const caller = authenticate(req, reply, format, true);
  if (!caller) return;
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Json;
  const requestId = crypto.randomUUID();
  const modelEntry = getModelEntry(String(body.model ?? ""));
  const prices = modelEntry?.prices;
  const maxOut = Number(body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens ?? 4096);
  const estimatedOutput = Math.min(modelEntry?.maxOutputTokens ?? 128_000, Number.isFinite(maxOut) && maxOut > 0 ? Math.ceil(maxOut) : 4096);
  const estimate = prices ? (estimateRequestTokens(body) * prices.inputPerM + estimatedOutput * prices.outputPerM) / 1_000_000 * caller.rateMultiplier : 0.01;
  if (!acquireRequestBudget(requestId, caller.userId, caller.apiKeyId, estimate)) {
    sendError(reply, format, 429, "user_inflight_limit", "Concurrent requests or reserved spending reached the account limit. Retry after an active request finishes.", "rate_limit_error");
    return;
  }
  const abort = new AbortController();
  lifecycles.set(req, { requestId, abort });
  const onClose = () => { if (!reply.raw.writableFinished) abort.abort(); };
  reply.raw.once("close", onClose);
  const renew = setInterval(() => { try { renewRequestBudget(requestId); } catch (err) { console.error("[budget] renewal failed", err); abort.abort(err); } }, 30_000);
  renew.unref();
  try { await proxyAuthorized(req, reply, format, endpoint, caller); }
  catch (err) { if (!abort.signal.aborted) throw err; }
  finally {
    clearInterval(renew);
    try { releaseRequestBudget(requestId); } catch (err) { console.error("[budget] release failed", err); }
    if (abort.signal.aborted && !reply.raw.destroyed && !reply.raw.writableEnded) {
      if (reply.raw.headersSent) reply.raw.end(format === "anthropic" ? `event: error\ndata: ${JSON.stringify({type:"error",error:{type:"api_error",message:"Request scheduling lease expired. Retry shortly."}})}\n\n` : `data: ${JSON.stringify({error:{code:"scheduling_lease_lost",message:"Request scheduling lease expired. Retry shortly."}})}\n\n`);
      else sendError(reply,format,503,"scheduling_lease_lost","Request scheduling lease expired. Retry shortly.","upstream_error");
    }
    reply.raw.off("close", onClose); lifecycles.delete(req);
  }
}

/**
 * Platform answer for a liveness probe (docs/gateway.md §2c): 200 "ok" when the key's group has an
 * account ready for the model, 503 no_available_account otherwise; an unknown model is left to the
 * normal path (its 404). Logged as a zero-cost usage row with mode "probe". Returns false when not handled.
 */
function answerProbe(req: FastifyRequest, reply: FastifyReply, format: ClientFormat, endpoint: string, caller: CallerContext, body: Json, verdict: ProbeVerdict): boolean {
  const model = typeof body.model === "string" ? body.model.trim() : "";
  if (!getModelEntry(model)) return false;
  const health = poolHealth(caller.groupId, model);
  const ok = health.ready > 0;
  const why = verdict.reason === "header" ? "x-1day-probe header" : `identical tiny request ×${verdict.repeats} within ${Math.round(PROBE_WINDOW_MS / 60_000)} min`;
  // Outward and in the log: the model's status only — never how many accounts stand behind it (operator rule 2026-10-29).
  const summary = `probe answered by the platform (${why}): ${probeReply(model, ok)}`;
  try {
    settleRequest({
      requestId: crypto.randomUUID(), userId: caller.userId, apiKeyId: caller.apiKeyId, groupId: caller.groupId, rateMultiplier: caller.rateMultiplier,
      accountId: null, providerId: null, payoutRate: 0, model, upstreamModel: null, endpoint, stream: body.stream === true,
      statusCode: ok ? 200 : 503, errorCode: ok ? null : "no_available_account", usage: { input_tokens: 0, output_tokens: 0 }, usageEstimated: false,
      durationMs: 0, clientIp: clientIp(req), errorMessage: summary, mode: "probe",
    });
  } catch (err) {
    console.error("[probe] failed to log the probe:", err);
  }
  reply.header("x-1day-probe", "platform").header("x-1day-model", model).header("x-1day-model-status", ok ? "ok" : "unavailable");
  if (!ok) { sendError(reply, format, 503, "no_available_account", `Model '${model}' is currently unavailable on this platform; retry later.`, "upstream_error"); return true; }
  sendSyntheticMessage(reply, format, body, probeReply(model, ok));
  return true;
}

async function proxyAuthorized(req: FastifyRequest, reply: FastifyReply, format: ClientFormat, endpoint: string, caller: CallerContext): Promise<void> {
  const originalBody = (req.body && typeof req.body === "object" ? req.body : {}) as Json;
  // Liveness probes are answered from pool state, never from an account (docs/gateway.md §2c).
  if (caller.policy.probeIntercept) {
    const verdict = detectProbe(caller.apiKeyId, originalBody, format, req.headers as Record<string, unknown>);
    if (verdict && answerProbe(req, reply, format, endpoint, caller, originalBody, verdict)) return;
  }
  const hasSubscriptions = !!one(`SELECT 1 FROM account_groups ag JOIN accounts a ON a.id = ag.account_id WHERE ag.group_id = ? AND a.type = 'oauth' AND a.platform = 'anthropic' LIMIT 1`, caller.groupId);
  let identity = resolveConversationIdentity(caller.apiKeyId, req.headers, originalBody, format);
  const returnedId = req.headers["x-1day-conversation-id"];
  if (typeof returnedId === "string") {
    const known = getConversation(returnedId);
    if (known?.api_key_id === caller.apiKeyId) identity = { key: known.external_key, reliable: true };
  }
  const existing = getConversationByExternalKey(caller.apiKeyId, identity.key);
  const requestedModel = typeof originalBody.model === "string" ? originalBody.model.trim() : "";
  const newTeamSupply = hasSubscriptions && listCandidates(caller.groupId, requestedModel).some((a) => !!accountTeamId(a) && modeFor(format, a, false) !== null);
  if (!existing?.team_id && !newTeamSupply) return proxyRequest(req, reply, format, endpoint, caller);
  const token = crypto.randomUUID();
  const deadline = Date.now() + 60_000;
  let row: ConversationRow | null = null;
  while (!row && Date.now() < deadline) {
    row = acquireConversationLease(caller.apiKeyId, identity.key, token);
    if (!row) await wait(25, lifecycles.get(req)?.abort.signal);
  }
  if (!row) { sendError(reply, format, 503, "conversation_busy", "Another request for this conversation is still running. Retry shortly.", "upstream_error"); return; }
  const scope: ConversationScope = { row, token, reliable: identity.reliable, originalBody, triedTeams: new Set(), lost: false, branch: conversationBranchKey(originalBody, format) };
  const renewal = setInterval(() => {
    if (scope.released) return;
    try { if (renewConversationLease(scope.row.id, token)) return; } catch { /* fence on DB failure */ }
    scope.lost = true;
    scope.abort?.abort();
  }, 20_000);
  renewal.unref();
  try { await proxyRequest(req, reply, format, endpoint, caller, scope); }
  catch (err) {
    if ((err as Error).message !== "conversation ownership changed") throw err;
    if (scope.responseCtx) { stopEarlyKeepalive(scope.responseCtx); stopNonStreamHeartbeat(scope.responseCtx); }
    if (!reply.raw.writableEnded) sendResetNotice(reply, format, originalBody);
  }
  finally { clearInterval(renewal); releaseConversationLease(scope.row.id, token); }
}

async function lockScope(scope: ConversationScope): Promise<void> {
  if (!scope.released) return;
  const deadline = Date.now() + 10_000;
  let row: ConversationRow | null = null;
  while (!row && Date.now() < deadline) {
    row = acquireConversationLease(scope.row.api_key_id, scope.row.external_key, scope.token);
    if (!row) await wait(10, scope.abort?.signal);
  }
  if (!row) throw new Error("conversation ownership changed");
  scope.row = row;
  scope.released = false;
}

function unlockScope(scope?: ConversationScope): void {
  if (!scope || scope.released) return;
  releaseConversationLease(scope.row.id, scope.token);
  scope.released = true;
}

async function switchTeam(scope: ConversationScope, nextTeam: string, format: ClientFormat, reason: string): Promise<void> {
  const previous = scopeContext(scope);
  const generation = scope.row.generation;
  await lockScope(scope);
  // Another request won the reset. Follow that winner; never overwrite its generation.
  if (scope.row.generation !== generation) { scope.boundary = undefined; return; }
  assertScope(scope);
  const question = latestQuestion(scope.originalBody, format);
  scope.row = resetConversationGeneration(scope.row.id, scope.token, scope.row.generation, nextTeam, question.anchor, question.prefix, reason);
  scope.boundary = saveBranchBoundary(scope.row.id, scope.token, scope.row.generation, scope.branch, question.anchor, question.prefix);
  scope.justReset = true;
  unlockScope(scope);
  if (previous) {
    retireCcrConversation(previous);
    await resetConversationWorkers(previous);
  }
}

async function proxyRequest(req: FastifyRequest, reply: FastifyReply, format: ClientFormat, endpoint: string, caller: CallerContext, scope?: ConversationScope): Promise<void> {
  assertScope(scope);
  let body = scope ? scope.originalBody : (req.body && typeof req.body === "object" ? req.body : {}) as Json;
  // Response profile for Claude Code clients (spec WP1 §6, settings cc_client_response_profile, three-state): a real
  // Claude Code sees an Anthropic-shaped answer — no x-1day-* diagnostic headers (request-id / retry-after stay).
  // Decided on the UA before the shape gate so the conversation headers set below follow the same rule.
  const hideDiag = isClaudeCodeUa(req.headers["user-agent"]) && featureFor("cc_client_response_profile", { groupId: caller.groupId });
  // Admission rejections after auth are logged as zero-cost usage rows so the
  // error log is complete (who asked for what, and why it was refused).
  const reject = (status: number, code: string, message: string, type: Parameters<typeof sendError>[5]): void => {
    try {
      settleRequest({
        requestId: crypto.randomUUID(),
        userId: caller.userId,
        apiKeyId: caller.apiKeyId,
        groupId: caller.groupId,
        rateMultiplier: caller.rateMultiplier,
        accountId: null,
        providerId: null,
        payoutRate: 0,
        model: (typeof body.model === "string" && body.model.trim()) || "-",
        upstreamModel: null,
        endpoint,
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
      console.error("[proxy] failed to log admission failure:", err);
    }
    sendError(reply, format, status, code, message, type);
  };
  let rejectUnknownHistory = false;
  /** The conversation was reset earlier, but this request's post-boundary history is this generation's own and is forwarded whole. */
  let resetHistoryIntact = false;
  if (scope) {
    await lockScope(scope);
    const question = latestQuestion(body, format);
    const unknownInitialHistory = !scope.row.team_id && (!scope.reliable || requestMessages(body, format).filter((m) => m?.role && !["system", "developer"].includes(m.role)).length > 1 || !!body.previous_response_id);
    // Per-key history policy (docs/gateway.md §2b, customer report 2026-10-29): `reset` is the isolation
    // default (boundary saved, only the latest question forwarded, x-1day-context-reset: 1); `reject`
    // answers 409 so a multi-upstream client can route the turn elsewhere; `passthrough` forwards the
    // history as-is and binds the conversation to whichever organization serves it.
    if (unknownInitialHistory && !scope.row.reset_active) {
      if (caller.policy.historyPolicy === "reject") rejectUnknownHistory = true;
      else if (caller.policy.historyPolicy === "reset") scope.row = saveConversationBoundary(scope.row.id, scope.token, scope.row.generation, question.anchor, question.prefix);
    }
    if (scope.row.reset_active) {
      scope.boundary = getConversationBoundary(scope.row.id, scope.row.generation, scope.branch);
      const prepared = scope.boundary ? applyResetBoundary(body, format, { ...scope.row, reset_anchor: scope.boundary.anchor, reset_prefix: scope.boundary.prefix }) : null;
      const justReset = scope.justReset === true;
      scope.justReset = false;
      if (prepared?.matched && !justReset) {
        // The history after the boundary is this generation's own: forward it whole, whatever its last
        // message is. A tool round (assistant tool_use + user tool_result) is answerable only with its
        // chain intact; cutting it to "the latest question" here is what used to end a session mid-task.
        body = prepared.body;
        resetHistoryIntact = true;
      } else if (question.message) {
        // No boundary this generation recognizes: a new conversation starts at the latest question.
        scope.boundary = saveBranchBoundary(scope.row.id, scope.token, scope.row.generation, scope.branch, question.anchor, question.prefix);
        body = resetBody(body, format, [question.message]);
      } else {
        // Nothing forwardable. A fake 200 would be read by the client as the model's answer, so this is a
        // real error unless the generation really was just reset and the client only needs to be told.
        unlockScope(scope);
        if (scope.responseCtx) { stopEarlyKeepalive(scope.responseCtx); stopNonStreamHeartbeat(scope.responseCtx); }
        const toolRound = isToolContinuation(body, format);
        if (!toolRound && justReset) { sendResetNotice(reply, format, scope.originalBody, hideDiag); return; }
        const [status, code, message] = toolRound
          ? [409, "tool_continuation_after_reset", justReset
            ? "This conversation's context was reset while a tool round was in progress (the previous upstream organization ran out of capacity); the pending tool_use was issued by that context and cannot be continued here. Start the task again with a new independent question; already executed tool actions are not redone."
            : "This request continues a tool round that this platform did not serve (no recognized conversation boundary): its tool_use came from another context and cannot be continued here. Start the task again with a new independent question."]
          : [400, "no_forwardable_question", "This conversation's context was reset and the latest message carries nothing that can be forwarded as a new question (no text, image, or document content). Send a new independent question."];
        if (scope.responseCtx) fail(scope.responseCtx, null, status, code, message, "invalid_request_error");
        else reject(status, code, message, "invalid_request_error");
        return;
      }
    }
    if (!reply.raw.headersSent && !hideDiag) {
      reply.header("x-1day-conversation-id", scope.row.id).header("x-1day-conversation-generation", String(scope.row.generation));
      if (scope.row.reset_active) reply.header("x-1day-context-reset", "1");
    }
  }
  const model = typeof body.model === "string" ? body.model.trim() : "";
  if (rejectUnknownHistory) {
    unlockScope(scope);
    if (scope?.responseCtx) { stopEarlyKeepalive(scope.responseCtx); stopNonStreamHeartbeat(scope.responseCtx); }
    reject(409, "history_unknown", "This conversation's earlier turns were not served by this platform and the key's history policy is 'reject'. Start the conversation here (a first turn without prior history) or route this turn back to the upstream that holds its context.", "invalid_request_error");
    return;
  }
  // Raw passthrough group (gateway.md §4a, user rule 2026-10-26 "直接透传，不做任何判断"): no admission
  // checks — a missing model / max_tokens or an unknown model id is the relay's call, not ours. The
  // group's own model allowlist (an operator rule, not a judgement about the request) still applies.
  const rawGroup = groupIsRawPassthrough(caller.groupId);
  let upstreamBaseModel = model;
  if (!rawGroup) {
    if (!model) {
      reject(400, "missing_required_parameter", "Missing required parameter: model", "invalid_request_error");
      return;
    }
    if (format === "anthropic" && typeof body.max_tokens !== "number") {
      reject(400, "missing_required_parameter", "Missing required parameter: max_tokens", "invalid_request_error");
      return;
    }
    const entry = getModelEntry(model);
    if (!entry || !entry.enabled) {
      reject(404, "model_not_found", `Model '${model}' does not exist or is not available.`, "not_found_error");
      return;
    }
    // Billing/logging keep the client's spelling; the upstream gets the canonical id (claude-opus-5.5 → claude-opus-5-5).
    upstreamBaseModel = entry.upstreamModelId ?? model;
  }
  if (!isModelAllowed(caller.allowlist, model)) {
    reject(403, "model_not_allowed", `Model '${model}' is not allowed for group '${caller.groupName}'.`, "permission_error");
    return;
  }

  const firstResponse = !scope?.responseCtx;
  const ctx: Ctx = scope?.responseCtx ?? {
    req,
    reply,
    format,
    endpoint,
    caller,
    body,
    model,
    stream: body.stream === true,
    requestId: lifecycles.get(req)?.requestId ?? crypto.randomUUID(),
    startedAt: Date.now(),
    selectionMs: null,
    executionSequence: 0,
    credentialVersion: null,
    streamTruncated: false,
    ccShape: null,
    hideDiagHeaders: hideDiag,
    trace: { mode: null, nodeId: null, upstreamStatus: null, upstreamMessage: null, failure: null },
    forceCacheBilling: false,
    clientGone: false,
    abort: lifecycles.get(req)?.abort ?? new AbortController(),
    early: null,
    jsonArm: null,
    jsonEarly: null,
    scope,
  };
  ctx.body = body;
  if (scope) { scope.abort = ctx.abort; scope.responseCtx = ctx; }
  // The platform's own request id, on every answer (success or error), like a real API's `request-id`. The
  // upstream's id and `anthropic-ratelimit-*` are deliberately not relayed: they describe the subscription account
  // behind this one call, not the customer's key (operator rule 2026-10-29; audit 2026-11-01 B2).
  if (firstResponse && !reply.raw.headersSent) reply.header("request-id", ctx.requestId);
  // Attached now, not when the stream starts: a client that gives up during account selection,
  // a slow upstream head or a failover chain used to go unnoticed, so the request ran to the end
  // and was billed (2026-10-22: 816 requests a customer never received).
  if (firstResponse) reply.raw.once("close", () => {
    if (reply.raw.writableFinished) return;
    ctx.clientGone = true;
    stopEarlyKeepalive(ctx);
    stopNonStreamHeartbeat(ctx);
    ctx.abort.abort();
  });

  // Dual-mode routing (docs/ccr-supply.md §5.2): Claude Code clients are
  // served by executor=ccr subscription accounts in DIRECT mode instead.
  // The gate (docs/gateway.md §2a): a Claude Code UA alone is not enough — the
  // request must be *shaped* like Claude Code, otherwise the subscription
  // account would carry a forged, anomalous request (Anthropic answers 429).
  // A raw passthrough group gets no shape classification either (§4a): nothing is judged, nothing logged.
  // A customer-made entrypoint is admitted only when `direct_cc_entrypoint_normalize=1`, the same switch that makes
  // `normalizeCcSoftware` rewrite it to `(external, cli)` on the way out (one setting, both ends; 2026-11-01).
  // A reset conversation whose post-boundary history is forwarded intact is still classified — on the client's
  // original body, since the forwarded one starts mid-conversation — so a genuine Claude Code client is not
  // locked onto the worker path for the rest of the conversation by one reset (2026-11-01, audit B4).
  const strictProfile = featureFor("direct_profile_strict", { groupId: caller.groupId });
  const shape = rawGroup || (!!scope?.row.reset_active && !resetHistoryIntact)
    ? null
    : classifyCcRequest(req.headers as Record<string, string | string[] | undefined>, resetHistoryIntact && scope ? scope.originalBody : body, {
        // three-state setting (铁律 2): "canary" admits custom entrypoints only for keys of the 灰度 group
        allowCustomEntrypoint: featureFor("direct_cc_entrypoint_normalize", { groupId: caller.groupId }),
        // spec §6.2 / WP1: the key's own allowlist of customer-made entrypoints (admin override), independent of the switch
        allowedCustomEntrypoints: caller.policy.allowedCustomEntrypoints,
        // spec §6.1 / WP1 (direct_profile_strict): a version × entrypoint without a sampled profile is not forwarded as genuine
        requireKnownProfile: strictProfile,
      });
  let ccClient = shape?.verdict === "genuine";
  if (shape && shape.verdict !== "not_cc") {
    ctx.ccShape = shape.verdict;
    if (shape.customEntrypointDenied) bump("custom_entrypoint_denied_total", { entrypoint: shape.entrypoint });
    if (shape.missing.includes("cc_profile_unknown")) bump("cc_profile_unknown_total", { version: shape.version });
    if (shape.verdict === "suspect") {
      const policy = parseCcShapePolicy(getSetting("cc_shape_policy"));
      console.warn(
        `[cc-shape] ${ctx.requestId} key=${caller.apiKeyId} ua=${JSON.stringify(req.headers["user-agent"] ?? "")} suspect missing=${shape.missing.join(",")} soft=${shape.soft.join(",") || "-"} policy=${policy}`,
      );
      if (policy === "reject") {
        fail(
          ctx,
          null,
          400,
          "cc_shape_mismatch",
          `Request claims a Claude Code client but is not shaped like one (missing: ${shape.missing.join(", ")}). Send a genuine Claude Code request or drop the Claude Code user-agent.`,
          "invalid_request_error",
        );
        return;
      }
      // observe: keep today's behaviour (direct path) but record the verdict.
      // downgrade: treat as a non-CC client → ccr / worker path, never the subscription direct path.
      ccClient = policy === "observe";
    } else if (shape.soft.length > 0) {
      // Genuine but drifting from the canonical build: surfaces CC upgrades early.
      console.info(`[cc-shape] ${ctx.requestId} genuine v${shape.version} soft=${shape.soft.join(",")}`);
    }
  }

  // Direct-only key (docs/gateway.md §2b): nothing may fall back to the worker path. A request that is not
  // a genuine Claude Code request is refused up front, naming the missing items, instead of being served
  // by a worker whose output differs (system additions, identity line, token counts, 200-wrapped refusals).
  if (caller.policy.directOnly && !rawGroup && !ccClient) {
    unlockScope(scope);
    const why = !shape || shape.verdict === "not_cc" ? "no Claude Code user-agent" : `missing: ${shape.missing.join(", ")}`;
    fail(ctx, null, 400, "direct_only", `This key is direct-only: the request must be a genuine Claude Code request (${why}); it was not forwarded to the worker path.`, "invalid_request_error");
    return;
  }
  let all = listCandidates(caller.groupId, model);
  let usable = all.filter((a) => modeFor(format, a, ccClient) !== null);
  if (scope) {
    // A generation has exactly one verified upstream organization. Non-subscription relays
    // cannot silently become a fallback for a subscription conversation.
    const teams = usable.filter((a) => !!accountTeamId(a));
    if (!scope.row.team_id && teams.length) {
      // Which organization a new conversation joins (2026-11-01, audit "小组织" A1/A3): by capacity — free
      // concurrency slots × subscription-window headroom — with the key's teamAffinity as the first-order
      // preference, instead of whichever organization's account happened to sort first.
      const pick = pickTeam(teams, caller.policy.teamAffinity);
      scope.row = bindConversationTeam(scope.row.id, scope.token, scope.row.generation, pick.teamId);
      console.info(`[team-pick] ${ctx.requestId} conv=${scope.row.id.slice(0, 8)} team=${pick.teamId.slice(0, 8)} ${pick.why}`);
    }
    const current = scope.row.team_id;
    if (current) scope.triedTeams.add(current);
    all = all.filter((a) => current ? accountTeamId(a) === current : a.type !== "oauth");
    usable = all.filter((a) => modeFor(format, a, ccClient) !== null);
    if (current && usable.length === 0) {
      if (isToolContinuation(scope.originalBody, format)) {
        // A tool round is answerable only by the organization whose model issued its tool_use: moving the
        // generation elsewhere could only end in 409 tool_continuation_after_reset (2026-10-30/31: 771 in two
        // days, 98% from Agent/SDK callers). Keep the team and its context: wait for one of its accounts to
        // become schedulable again, otherwise fail retryably so the client resends this same round.
        unlockScope(scope);
        const deadline = Date.now() + busyWaitMs(all.length);
        while (usable.length === 0 && Date.now() < deadline && !ctx.clientGone) {
          try { await wait(Math.min(500, deadline - Date.now()), ctx.abort.signal); } catch { break; }
          all = listCandidates(caller.groupId, model).filter((a) => accountTeamId(a) === current);
          usable = all.filter((a) => modeFor(format, a, ccClient) !== null);
        }
        if (usable.length === 0) {
          if (ctx.clientGone) { logFailure(ctx, null, 499, "client_closed", "Client closed while waiting for the conversation's organization"); return; }
          failTeamCapacity(ctx, null);
          return;
        }
        await lockScope(scope);
        if (scope.row.team_id !== current) return proxyRequest(req, reply, format, endpoint, caller, scope);
      } else {
        const next = teams.find((a) => !scope.triedTeams.has(accountTeamId(a)!));
        if (next) { await switchTeam(scope, accountTeamId(next)!, format, "team_pool_exhausted"); return proxyRequest(req, reply, format, endpoint, caller, scope); }
      }
    }
  }
  unlockScope(scope);
  // "No account" must say why when the reason is upstream: an organization-level
  // model suspension (403 "suspended for this organization until …") takes whole
  // orgs out at once (2026-10-20: 96 accounts for an hour) — the client should
  // read that it is Anthropic's limit with a lift time, not a dead platform.
  const failNoAccount = (): void => {
    const susp = scope ? { accounts: 0, liftsAt: null } : modelSuspensionSummary(caller.groupId, upstreamBaseModel);
    if (susp.accounts > 0) {
      const lifts = susp.liftsAt ? ` The earliest suspension lifts at ${susp.liftsAt}.` : "";
      fail(
        ctx,
        null,
        503,
        "upstream_model_suspended",
        `Anthropic has temporarily suspended '${upstreamBaseModel}' for the organizations behind ${susp.accounts} of our subscription accounts (upstream 403 "model is suspended for this organization"), and no other account is free right now.${lifts} Retry later or use another model; this is an upstream limit, not a platform outage.`,
        "upstream_error",
      );
      return;
    }
    fail(ctx, null, 503, "no_available_account", `No upstream account is currently available for '${model}'.`, "upstream_error");
  };
  if (usable.length === 0) {
    if (all.length > 0) {
      fail(ctx, null, 400, "unsupported_endpoint", `No account in this group serves '${model}' through ${endpoint}.`, "invalid_request_error");
    } else {
      failNoAccount();
    }
    return;
  }

  const isolation = scopeContext(scope);
  const namespace = isolation ? `team:${isolation.teamId}:conversation:${isolation.conversationId}:generation:${isolation.generation}:branch:${scope!.branch}:${scope!.boundary?.nonce ?? "original"}` : null;
  const hash = namespace ? sha256Hex(namespace) : null;
  const upstreamSession = hash ? sessionUuidFromHash(hash) : undefined;
  const upstreamHeaders = { ...req.headers };
  if (upstreamSession) {
    for (const key of Object.keys(upstreamHeaders)) if (/^(?:x-(?:1day-)?conversation-|x-(?:claude-code-|claude-)?session-id$|session_id$)/i.test(key)) delete upstreamHeaders[key];
    upstreamHeaders["x-claude-code-session-id"] = upstreamSession;
    if (format !== "responses") {
      body = { ...body, metadata: { user_id: sessionMetadataUserId(upstreamSession) } };
      ctx.body = body;
    }
  }
  const sKey = namespace ? `${namespace}:model:${model}` : stickyKey(caller, body, req);
  // §5.3 污染防护: pool reuse requires the strongest conversation identity —
  // metadata.user_id's session_id only; weaker fingerprints stay stateless.
  // A content fingerprint can fence history but cannot identify a particular caller's
  // live cloud session. Unidentified calls must remain one-shot and be archived.
  const ccrPoolKey = scope ? (scope.reliable ? namespace : null) : sessionIdFromMetadata(body.metadata?.user_id);
  // Soft 429 cooldown (core listCandidates): accounts inside a plain Retry-After
  // cooldown stay last, even when the sticky session points at one of them.
  const rawDeviceKey = deviceKey(caller, scope?.originalBody ?? body);
  const dKey = namespace && rawDeviceKey ? `${namespace}:${rawDeviceKey}` : rawDeviceKey;
  const merkleNamespace = scope && !scope.reliable ? sKey : null;
  let ordered = orderByMerklePrefix(
    [...orderByAffinity(usable.filter((a) => !a.cooling), sKey, dKey), ...usable.filter((a) => a.cooling)],
    merkleNamespace,
    scope?.originalBody ?? body,
    format,
  );
  let attempts = 0;
  let lastStatus = 0;
  /** The node refused the request itself (spec_too_large …): answered once, no further candidates. */
  let requestError: TunnelRequestError | null = null;
  let lastMessage = "";
  let lastAccount: AccountRow | null = null;
  // CCR capability check is per request, not per account (docs/ccr-supply.md §6).
  let ccrBody: Json | null = null;
  let ccrUnsupported: CcrUnsupported | null = null;
  const ccrRequest = (): Json => {
    if (!ccrBody) ccrBody = format === "openai-chat" ? openaiChatToAnthropic(body, model) : body;
    return ccrBody;
  };

  const busyDeadline = Date.now() + busyWaitMs(scope?.row.team_id ? all.length : Number.POSITIVE_INFINITY);
  let busy: Candidate[] = [];
  for (;;) {
  busy = [];
  for (const account of ordered) {
    if (!scope && attempts >= config.maxAttempts) break;
    assertScope(scope);
    if (ctx.clientGone) {
      logFailure(ctx, lastAccount, 499, "client_closed", "Client closed the connection before an upstream answer");
      return;
    }
    // Bound proxy down (docs/onboarding.md §6.1): skip without counting a
    // failure; the account rejoins scheduling when the proxy recovers.
    if (boundProxyDown(account)) continue;
    const mode0 = modeFor(format, account, ccClient)!;
    if (isCcrMode(mode0)) {
      ccrUnsupported = ccrUnsupportedReason(ccrRequest(), { images: account.executor === "ccr_worker", documents: account.executor === "ccr_worker", toolChoice: account.executor === "ccr_worker" });
      if (ccrUnsupported) continue; // this request can never run on a cloud session; try other accounts
    }
    const lease = gates.acquireLease(account.id, account.concurrency, account.rpm_limit, () => ctx.abort.abort(new Error("account scheduling lease lost")));
    if (!lease) { busy.push(account); continue; }
    ctx.accountLease = lease;
    if (ctx.selectionMs === null) ctx.selectionMs = Date.now() - ctx.startedAt;
    if (account.cooling) {
      console.warn(`[proxy] ${ctx.requestId} account ${account.name} is 429-cooling until ${account.rate_limited_until}; no other candidate, trying anyway`);
    }
    lastAccount = account;
    let released = false;
    const done = () => {
      if (!released) {
        released = true;
        lease.release();
        if (ctx.accountLease === lease) ctx.accountLease = undefined;
      }
    };
    try {
      const mode = modeFor(format, account, ccClient)!;
      ctx.trace.mode = mode;
      ctx.trace.nodeId = account.node_id;
      ctx.trace.upstreamStatus = null;
      ctx.trace.upstreamMessage = null;
      ctx.trace.failure = null;
      // Raw passthrough relay on a same-protocol request (§4a): the client's model spelling travels as-is
      // (no canonical id, no account model mapping), upstream errors come back verbatim, no cooldown.
      const raw = account.raw_passthrough === 1 && mode.startsWith("passthrough-");
      const upstreamModel = raw ? model : upstreamModelFor(account, upstreamBaseModel);
      let refreshed = false;
      for (;;) {
        ctx.executionSequence++;
        assertRequestLeases(ctx);
        if (ctx.clientGone) {
          logFailure(ctx, account, 499, "client_closed", "Client closed the connection before an upstream answer");
          return;
        }
        // Path transparency (audit 2026-11-01 B14): which execution path answers — the client could only guess from
        // the message id prefix before. Set before the early 200 so hijacked SSE/JSON heads carry it too.
        if (!ctx.reply.raw.headersSent && !ctx.hideDiagHeaders) {
          ctx.reply.header("x-1day-mode", isCcrMode(mode) ? "worker" : raw ? "relay" : "direct");
          const ignored = ignoredParams(ctx.body, format, mode);
          if (ignored.length > 0) ctx.reply.header("x-1day-ignored-params", ignored.join(","));
        }
        // responseMode=strict (spec §6.2 / WP5): no early 200, no heartbeat filler — the real status reaches the client,
        // at the price of CDN idle timeouts on long non-stream requests. keepalive (default) = today's behaviour.
        if (caller.policy.responseMode !== "strict") {
          beginEarlyStream(ctx);
          // Multipart tee-proof answers cannot start before the body is in; everything else may.
          if (teeProofRequested(req) !== "multipart") armNonStreamHeartbeat(ctx);
        }
        let cred;
        try {
          cred = await freshCredential(account, refreshed, isolation, ctx.abort.signal);
          ctx.credentialVersion = one<{ credential_version: number }>("SELECT credential_version FROM accounts WHERE id = ?", account.id)?.credential_version ?? account.credential_version;
        } catch (err) {
          if (ctx.abort.signal.aborted) { logFailure(ctx, account, 499, "client_closed", "Client closed during credential refresh"); return; }
          markFailure(account.id, { kind: "auth", message: `credential unreadable: ${(err as Error).message}` });
          break;
        }
        let res: Response | null;
        let upstreamHost: string;
        try {
          if (isCcrMode(mode)) {
            // Cloud session / on-node worker: the executor returns an
            // Anthropic-wire Response (JSON or SSE).
            const ccrReq = { ...ccrRequest(), model: upstreamModel };
            upstreamHost = new URL(accountBaseUrl(account) ?? "https://api.anthropic.com").host;
            if (account.executor === "ccr_worker") {
              // Worker mode (docs/ccr-supply.md §8.1): real Claude Code on the node.
              res = await runCcrWorker({
                account,
                cred,
                body: ccrReq,
                clientModel: model,
                upstreamModel,
                stream: ctx.stream,
                requestId: ctx.requestId,
                stickyKey: sKey,
                isolation,
                signal: ctx.abort.signal,
              });
              if (!res) break; // no worker-capable node accepted: infra state, try next account without counting
            } else {
              res = await runCcr({
                account,
                cred,
                body: ccrReq,
                clientModel: model,
                upstreamModel,
                stream: ctx.stream,
                requestId: ctx.requestId,
                clientHeaders: upstreamHeaders,
                stickyKey: ccrPoolKey ? `s:${caller.apiKeyId}:${ccrPoolKey}` : null,
                isolation,
                signal: ctx.abort.signal,
              });
            }
          } else {
            const ureq = buildUpstreamRequest(account, cred, mode, body, upstreamModel, upstreamHeaders, req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "", upstreamSession, shapingFor({ groupId: caller.groupId, accountId: account.id, customEntrypointAdmitted: !!shape && shape.verdict === "genuine" && shape.customEntrypoint }));
            if (!ureq) {
              markFailure(account.id, { kind: "auth", message: "account has no base URL" });
              break;
            }
            // Second gate (spec WP1 §2, I11's sibling): what leaves must still be a genuine request of the SAME profile
            // the client sent. Normalisation may touch transport / device / machine / entrypoint only; anything that
            // makes the outgoing body un-genuine or changes its profile is refused here, never sent upstream.
            if (strictProfile && ccClient && !raw && mode === "passthrough-anthropic" && shape?.verdict === "genuine") {
              const out = outgoingProfileCheck(ureq, shape);
              if (!out.sameProfile) {
                bump("cc_profile_mismatch_total", { in: shape.profileId, out: out.profileId });
                console.error(`[cc-profile] ${ctx.requestId} key=${caller.apiKeyId} outgoing request is not genuine ${shape.profileId} → ${out.profileId ?? "unknown"} missing=${out.missing.join(",") || "-"}; not forwarded`);
                fail(ctx, null, 400, "cc_profile_mismatch", `The normalised request no longer matches Claude Code profile ${shape.profileId} (${out.missing.join(", ") || "profile changed"}); it was not forwarded.`, "invalid_request_error");
                return;
              }
            }
            upstreamHost = ureq.url.host;
            if (account.route === "node") {
              // Bound proxy (docs/onboarding.md §1/§6.2): all platform-side
              // requests of a bound account egress on that proxy.
              res = await fetchViaTunnel(account.id, ureq.url, ureq.headers, ureq.body, account.bound_proxy_id ?? undefined, undefined, isolation, ctx.abort.signal);
              if (!res) break; // no online node: infra state, try next account without counting
            } else {
              // 原生 http 而非 fetch：避免 undici 强加 accept-language/sec-fetch-mode。
              res = await postRaw(ureq.url, ureq.headers, ureq.body, config.upstreamTimeoutMs, ctx.abort.signal);
            }
          }
        } catch (err) {
          if (ctx.abort.signal.aborted) { logFailure(ctx, account, 499, "client_closed", "Client closed before upstream response"); return; }
          if (err instanceof TunnelRequestError) {
            // Not this account's fault and no other account can take it either.
            requestError = err;
            ctx.trace.upstreamMessage = `node: ${err.nodeCode}`;
            ctx.trace.failure = { ...classifyTransportFailure(err.message, err.nodeCode.includes("proxy")), credentialVersion: ctx.credentialVersion ?? undefined, executionSequence: ctx.executionSequence };
            break;
          }
          attempts++;
          lastStatus = 502;
          lastMessage = (err as Error).message;
          ctx.trace.upstreamStatus = null;
          ctx.trace.upstreamMessage = `network: ${lastMessage}`.slice(0, 500);
          ctx.trace.failure = { ...classifyTransportFailure(lastMessage), credentialVersion: ctx.credentialVersion ?? undefined, executionSequence: ctx.executionSequence };
          console.warn(`[proxy] ${ctx.requestId} account ${account.name}: network error ${lastMessage}`);
          if (raw) {
            // Raw passthrough: no cooldown, no failover — answer once.
            fail(ctx, account, 502, "upstream_error", `Upstream unreachable (${lastMessage}).`, "upstream_error");
            return;
          }
          markFailure(account.id, { kind: "transient", message: `network: ${lastMessage}` });
          break;
        }

        if (ctx.abort.signal.aborted) {
          await res.body?.cancel().catch(() => {});
          logFailure(ctx, account, ctx.clientGone ? 499 : 503, ctx.clientGone ? "client_closed" : "scheduling_lease_lost", "Request cancelled before upstream delivery");
          return;
        }
        if (res.ok) {
          if (!lease.isValid()) { await res.body?.cancel().catch(() => {}); throw new Error("account scheduling lease lost"); }
          assertScope(scope);
          touchAccount(account.id);
          const prev = sKey ? getSticky(sKey) : undefined;
          if (prev && prev.accountId !== account.id) {
            ctx.forceCacheBilling = true;
            console.log(`[proxy] ${ctx.requestId} sticky session moved off its account to ${account.name}: billing input at cache-read price (sub2api ForceCacheBilling)`);
          }
          rememberSticky(sKey, account.id);
          rememberMerklePrefix(merkleNamespace, scope?.originalBody ?? body, format, account.id, Date.now() + stickyTtlMs());
          rememberDevice(dKey, account.id);
          sampleWindow(account, res.headers);
          console.log(`[proxy] ${ctx.requestId} ${endpoint} ${model} -> ${account.name} (${account.route}/${mode}) headers +${((Date.now() - ctx.startedAt) / 1000).toFixed(1)}s`);
          await deliver(ctx, res, account, wireModeFor(mode), upstreamModel, upstreamHost, done, isCcrMode(mode));
          return;
        }

        const status = res.status;
        const text = (await responseBytes(res, 4000, ctx.abort.signal, true)).toString("utf8");
        attempts++;
        lastStatus = status;
        lastMessage = text;
        ctx.trace.upstreamStatus = status;
        ctx.trace.upstreamMessage = text.replace(/\s+/g, " ").slice(0, 500);
        // Body excerpt makes shape-caused 4xx diagnosable (e.g. an OAuth account answers 429
        // to a Claude Code UA request that lacks the billing system block, docs/claude-code-compat.md §5).
        console.warn(`[proxy] ${ctx.requestId} account ${account.name} -> HTTP ${status} ${text.replace(/\s+/g, " ").slice(0, 240)}`);
        ctx.trace.failure = {
          scope: status === 401 || status === 402 || status === 403 ? "account" : status >= 500 ? "transport" : "request",
          code: status === 429 ? "upstream_rate_limited" : `upstream_http_${status}`,
          message: upstreamMessage(text) || `Upstream returned HTTP ${status}`,
          retryable: status === 429 || status >= 500,
          status,
          credentialVersion: ctx.credentialVersion ?? undefined,
          executionSequence: ctx.executionSequence,
        };

        if (raw) {
          // Raw passthrough (§4a): every upstream status and body goes back verbatim — 429 and 5xx included —
          // with no failover; the relay's own scheduling is the only one that applies. Since 2026-10-28 a
          // 503/529 still cools the relay account (escalating 1–10 min, core markFailure) so that, when
          // another candidate exists for the model, the next request goes there instead of hitting a
          // relay that answered "no capacity" 915 times in 24 h; with no alternative the account stays
          // selectable and the status is passed through as before.
          if ((status === 503 || status === 529) && listCandidates(caller.groupId, model).some((a) => a.id !== account.id)) {
            markFailure(account.id, { kind: "overloaded" });
            console.warn(`[proxy] ${ctx.requestId} relay ${account.name} answered ${status}; cooled, other candidates remain`);
          }
          passUpstreamError(ctx, account, wireModeFor(mode), status, text, res.headers.get("retry-after"));
          return;
        }
        const reqErr = isCcrMode(mode) ? classifyCcRequestError(text) : null;
        if (reqErr) {
          ctx.trace.failure = { scope: "request", code: reqErr.code, message: reqErr.message, retryable: false, status: 400, credentialVersion: ctx.credentialVersion ?? undefined, executionSequence: ctx.executionSequence };
          // Context overflow / safety-classifier refusal inside Claude Code: the request is the problem.
          // 400 with Claude Code's own sentence (clients auto-compact on "prompt is too long"), no failover/cooldown.
          console.warn(`[proxy] ${ctx.requestId} ${reqErr.code} on Claude Code (${account.name}): 400 to client, no failover/cooldown`);
          fail(ctx, account, 400, reqErr.code, reqErr.message, "invalid_request_error");
          return;
        }
        if (isCcrMode(mode) && isCcModelUnavailable(text)) {
          ctx.trace.failure = { scope: "account_model", code: "model_not_found", message: upstreamMessage(text), retryable: true, status: 404, credentialVersion: ctx.credentialVersion ?? undefined, executionSequence: ctx.executionSequence };
          // A retired or unlicensed model is scoped to this account/model pair, not a dead credential.
          console.warn(`[proxy] ${ctx.requestId} model ${upstreamModel} unavailable on Claude Code (${account.name}): 404 to client, no failover/cooldown`);
          fail(ctx, account, 404, "model_not_found", `Model '${model}' is not available on the subscription path (Claude Code: model may not exist or the account has no access).`, "not_found_error");
          return;
        }
        if (PASSTHROUGH_STATUSES.has(status) && !isCcrMode(mode)) {
          passUpstreamError(ctx, account, wireModeFor(mode), status, text);
          return;
        }
        if (PASSTHROUGH_STATUSES.has(status)) {
          // Cloud session / environment API rejected the call: the account's
          // CCR state is bad (stale environment, unsupported config), never the
          // consumer's request. Cool it and fail over; never echo the session-API body.
          markCcrFailure(ctx, account, `ccr ${status}: ${text.slice(0, 300)}`);
          break;
        }
        // Per-model org suspension (403, time-boxed): cool that model only and let the
        // next account (another org) serve; never treat it as a dead credential.
        // The worker path wraps the same 403 text in a 502 body ("ccr_worker: Failed to authenticate. API Error:
        // 403 model: … is suspended for this organization until …"); 2026-10-29/31 that fell through to the short
        // transient cooldown and one account was re-picked four times in eight minutes (39 client 502s), so on the
        // worker path the text is parsed whatever the status.
        const suspended = status === 403 || isCcrMode(mode) ? parseModelSuspension(text) : null;
        if (suspended) {
          ctx.trace.failure = { scope: "account_model", code: "upstream_model_suspended", message: upstreamMessage(text), retryable: true, status: 403, credentialVersion: ctx.credentialVersion ?? undefined, executionSequence: ctx.executionSequence, resetAt: suspended.until };
          markFailure(account.id, { kind: "model_suspended", model: suspended.model, until: suspended.until });
          console.warn(`[proxy] ${ctx.requestId} account ${account.name}: model ${suspended.model} suspended for its organization until ${suspended.until} → model cooldown, trying next account`);
          break;
        }
        if ((status === 401 || status === 403) && !refreshed && canRefresh(account)) {
          refreshed = true;
          continue; // retry once with a forced token refresh
        }
        if (status === 401 || status === 403) {
          const authText = `upstream ${status}: ${text.slice(0, 300)}`;
          // The token endpoint rate-limited our refresh (back-off running): this is the expected expiry of a
          // token we were not allowed to renew, so park the account until the back-off ends instead of retiring
          // it. The 401 text cannot be used to tell a dead grant apart — Anthropic answers an expired access
          // token with the same "OAuth access token has been revoked" (2026-10-29 evening: three accounts were
          // retired on that wording inside their back-off). A genuinely revoked grant surfaces once the back-off
          // ends: its refresh fails with 400/401 (no new back-off) and the next 401 retires it.
          const cooling = refreshCooldownUntil(account.id);
          if (cooling) {
            markFailure(account.id, { kind: "transient", message: `${authText} (refresh back-off until ${cooling})`, cooldownMs: Math.max(30_000, Date.parse(cooling) - Date.now()) });
            console.warn(`[proxy] ${ctx.requestId} account ${account.name}: ${status} while the token endpoint back-off runs until ${cooling} → cooldown, not status error`);
          } else {
            markFailure(account.id, { kind: "auth", message: authText });
          }
        } else if (status === 402) {
          markFailure(account.id, { kind: "payment" });
        } else if (status === 429) {
          const now429 = nowIso();
          const snap429 = sampleWindow(account, res.headers);
          const fab = fableRejectedWindow(snap429, now429);
          const credits = isCreditsRequired(text);
          const rej = rejectedWindow(snap429, now429);
          const classified = classifyDirectRateLimit(text, !!rej);
          ctx.trace.failure = { ...classified, credentialVersion: ctx.credentialVersion ?? undefined, executionSequence: ctx.executionSequence, resetAt: rej?.resetAt };
          if (classified.scope === "request") {
            fail(ctx, account, 429, classified.code, classified.message, "rate_limit_error");
            return;
          }
          if ((fab || credits) && modelScope(upstreamModel) === "fable") {
            const resetAt = fab?.resetAt ?? snap429?.resetAt ?? new Date(Date.now() + 86_400_000).toISOString().slice(0, 19) + "Z";
            markFailure(account.id, { kind: "model_window_rejected", scope: "fable", resetAt, reason: credits ? "credits_required (429)" : "7d_oi rejected (429)" });
          } else if (rej) {
            markFailure(account.id, { kind: "window_rejected", window: rej.window, resetAt: rej.resetAt });
          } else if (classified.scope === "account_model") {
            const ra = Number(res.headers.get("retry-after"));
            markFailure(account.id, { kind: "model_rate_limited", model: upstreamModel, retryAfterSec: Number.isFinite(ra) && ra > 0 ? ra : undefined, reason: classified.code });
          } else {
            const ra = Number(res.headers.get("retry-after"));
            markFailure(account.id, { kind: "rate_limited", retryAfterSec: Number.isFinite(ra) && ra > 0 ? ra : undefined });
          }
        } else if (status === 529 || status === 503) {
          markFailure(account.id, { kind: "overloaded" });
        } else {
          markFailure(account.id, { kind: "transient", message: `upstream ${status}` });
        }
        break;
      }
    } finally {
      done();
    }
  }

  if (!busy.length || requestError || ctx.clientGone) break;
  if (Date.now() >= busyDeadline) {
    fail(ctx, null, 503, "account_pool_busy", "Accounts in this conversation are temporarily busy. Retry shortly; its team and context are retained.", "upstream_error");
    return;
  }
  if (caller.policy.responseMode !== "strict") beginEarlyStream(ctx);
  try { await wait(Math.min(100, busyDeadline - Date.now()), ctx.abort.signal); }
  catch { logFailure(ctx, lastAccount, 499, "client_closed", "Client closed while waiting for an account slot"); return; }
  const currentCandidates = new Set(listCandidates(caller.groupId, model).map(a => a.id));
  ordered = busy.filter(a => currentCandidates.has(a.id));
  if (!ordered.length) break;
  }

  // Every account in this generation was tried before changing organizations. The new
  // generation receives a rebuilt body, never the failed generation's full transcript.
  const toolRound = scope ? isToolContinuation(scope.originalBody, format) : false;
  if (scope?.row.team_id && !toolRound && !requestError && !ctx.clientGone && !ccrUnsupported) {
    const next = listCandidates(caller.groupId, model).find((a) => accountTeamId(a) && !scope.triedTeams.has(accountTeamId(a)!) && modeFor(format, a, ccClient) !== null);
    if (next) {
      // Heartbeats may have committed HTTP headers, but no model output was delivered.
      // Reuse the existing response state rather than opening a second SSE response.
      await switchTeam(scope, accountTeamId(next)!, format, "team_pool_exhausted");
      return proxyRequest(req, reply, format, endpoint, caller, scope);
    }
  }

  if (requestError) {
    const tooLarge = requestError.nodeCode === "spec_too_large";
    // Node-side codes (spec_too_large, bad_spec …) name the node; platform-side ones (console_*, empty_prompt) carry their own text.
    const fromNode = !requestError.nodeCode.startsWith("console_") && requestError.nodeCode !== "empty_prompt";
    fail(
      ctx,
      lastAccount,
      tooLarge ? 413 : 400,
      tooLarge ? "request_too_large" : "invalid_request",
      tooLarge ? `Request body is too large for the node egress path (${requestError.message}); Anthropic's own limit is 32 MB.` : fromNode ? `The node rejected the request: ${requestError.message}` : requestError.message,
      "invalid_request_error",
    );
  } else if (lastStatus === 429) {
    fail(ctx, lastAccount, 429, "upstream_rate_limited", "All upstream accounts are rate limited. Retry later.", "rate_limit_error");
  } else if (toolRound && scope?.row.team_id && attempts > 0 && !ctx.clientGone) {
    // Every account of the organization failed this tool round; it is not moved elsewhere (see above).
    failTeamCapacity(ctx, lastAccount);
  } else if (attempts === 0 && ccrUnsupported) {
    fail(ctx, null, 400, ccrUnsupported.code, ccrUnsupported.message, "invalid_request_error");
  } else if (attempts === 0) {
    failNoAccount();
  } else {
    fail(ctx, lastAccount, 502, "upstream_error", `Upstream request failed (last status ${lastStatus || "network"}).`, "upstream_error");
  }
}

// ---------- failure paths ----------

/**
 * A CCR executor failure: Claude Code's own limit text ("You've hit your
 * session limit · resets 8:50am (Europe/Berlin)") is the worker path's 429 —
 * no unified headers ever reach us there — so it pauses the account until the
 * quoted reset (core window_exhausted; 1h fallback when unparseable) instead of
 * the generic transient cooldown, which let one exhausted account be re-picked
 * every few seconds (2026-10-17, mirasim: 6 × 502 + 10 × 503 in 3 minutes).
 */
const authFailures = new AuthFailureTracker();

function markCcrFailure(ctx: Ctx, account: AccountRow, message: string): void {
  const limit = ccLimitReset(message);
  if (limit) {
    markFailure(account.id, { kind: "window_exhausted", resetAt: limit.resetAt, window: limit.window });
    console.warn(`[proxy] ${ctx.requestId} account ${account.name}: cc ${limit.window} limit → window_exhausted until ${limit.resetAt ?? "(fallback 1h)"}`);
    return;
  }
  const suspended = parseModelSuspension(message);
  if (suspended) {
    markFailure(account.id, { kind: "model_suspended", model: suspended.model, until: suspended.until });
    console.warn(`[proxy] ${ctx.requestId} account ${account.name}: model ${suspended.model} suspended for its organization until ${suspended.until} → model cooldown`);
    return;
  }
  const reqErr = classifyCcRequestError(message);
  if (isCcModelUnavailable(message) || reqErr) {
    console.warn(`[proxy] ${ctx.requestId} account ${account.name}: ${reqErr ? reqErr.code : "model unavailable"} on Claude Code — request problem, account not cooled`);
    return;
  }
  if (isCcAccountOnHold(message)) {
    // Account put on hold by Anthropic (claude.ai/restricted): unusable at once, no threshold (user rule 2026-10-20).
    markFailure(account.id, { kind: "auth", message: `account on hold: ${message.slice(0, 400)}` });
    console.error(`[proxy] ${ctx.requestId} account ${account.name}: account on hold → status error (${message.slice(0, 160)})`);
    return;
  }
  if (isCcAuthFailure(message)) {
    // Claude Code's "Failed to authenticate …" is the worker path's 401: one hit
    // may be a refresh race (2026-10-17), repeated hits mean the OAuth session is gone.
    const hit = authFailures.record(account.id);
    // Any authentication failure while our own refresh is parked by a token-endpoint 429 is the same blocked
    // renewal seen from Claude Code, not a dead grant: never escalate on it (2026-10-29: three accounts retired
    // this way; the wording "revoked" does not distinguish an expired token, see the direct-path branch).
    const cooling = refreshCooldownUntil(account.id);
    if (hit.escalate && !cooling) {
      markFailure(account.id, { kind: "auth", message: `cc auth failure ×${hit.count}: ${message.slice(0, 400)}` });
      console.error(`[proxy] ${ctx.requestId} account ${account.name}: cc auth failure ×${hit.count} → status error (${message.slice(0, 160)})`);
    } else {
      const cooldownMs = cooling ? Math.max(AUTH_FAILURE_COOLDOWN_MS, Date.parse(cooling) - Date.now()) : AUTH_FAILURE_COOLDOWN_MS;
      markFailure(account.id, { kind: "transient", message, cooldownMs });
      console.warn(`[proxy] ${ctx.requestId} account ${account.name}: cc auth failure ×${hit.count} → cooldown ${Math.round(cooldownMs / 1000)}s${cooling ? ` (token endpoint back-off until ${cooling})` : ""} (${message.slice(0, 160)})`);
    }
    return;
  }
  markFailure(account.id, { kind: "transient", message });
}

function logFailure(ctx: Ctx, account: AccountRow | null, status: number, code: string, message?: string): void {
  try {
    const up = ctx.trace.upstreamMessage ? `upstream ${ctx.trace.upstreamStatus ?? "-"}: ${ctx.trace.upstreamMessage}` : null;
    const errorMessage = [message, up].filter(Boolean).join(" | ") || null;
    settleRequest({
      requestId: ctx.requestId,
      userId: ctx.caller.userId,
      apiKeyId: ctx.caller.apiKeyId,
      groupId: ctx.caller.groupId,
      rateMultiplier: ctx.caller.rateMultiplier,
      accountId: account?.id ?? null,
      providerId: null,
      payoutRate: 0,
      model: ctx.model,
      upstreamModel: null,
      endpoint: ctx.endpoint,
      stream: ctx.stream,
      statusCode: status,
      errorCode: code,
      errorScope: ctx.trace.failure?.scope ?? (status >= 500 ? "transport" : "request"),
      retryable: ctx.trace.failure?.retryable ?? (status === 429 || status >= 500),
      credentialVersion: ctx.credentialVersion,
      executionSequence: ctx.executionSequence,
      usage: { input_tokens: 0, output_tokens: 0 },
      usageEstimated: false,
      durationMs: Date.now() - ctx.startedAt,
      selectionMs: ctx.selectionMs,
      streamTruncated: ctx.streamTruncated,
      clientIp: clientIp(ctx.req),
      ccShape: ctx.ccShape,
      errorMessage,
      mode: ctx.trace.mode,
      upstreamStatus: ctx.trace.upstreamStatus,
      nodeId: account?.node_id ?? ctx.trace.nodeId,
      teamId: account?.team_id ?? null,
      proxyId: account?.bound_proxy_id ?? null,
    });
  } catch (err) {
    console.error("[proxy] failed to log failed request:", err);
  }
}

/**
 * Request fields this execution path accepts but cannot honour (audit 2026-11-01 B5/B7) — named in
 * `x-1day-ignored-params` instead of being dropped silently, without breaking the request (a 400 would).
 * Worker (real Claude Code on a node): no sampling flags, no OpenAI-only knobs; `max_tokens`, `stop_sequences`,
 * `tool_choice` (prompted), thinking, images, documents and tools are honoured. Chat→Anthropic conversion:
 * `temperature`/`top_p` (one of them), `stop`, tools and `tool_choice` are mapped, the rest is not.
 */
const WORKER_IGNORED_ANTHROPIC = ["temperature", "top_p", "top_k", "service_tier", "context_management", "mcp_servers", "container"];
const WORKER_IGNORED_CHAT = ["temperature", "top_p", "n", "logprobs", "top_logprobs", "seed", "presence_penalty", "frequency_penalty", "logit_bias", "service_tier", "response_format", "parallel_tool_calls", "reasoning_effort", "prediction", "web_search_options"];
const CONVERT_IGNORED_CHAT = ["n", "logprobs", "top_logprobs", "seed", "presence_penalty", "frequency_penalty", "logit_bias", "service_tier", "response_format", "parallel_tool_calls", "reasoning_effort", "prediction", "web_search_options"];
const CONVERT_IGNORED_ANTHROPIC = ["top_k", "thinking", "context_management", "service_tier", "mcp_servers", "container"];
export function ignoredParams(body: Json, format: ClientFormat, mode: Mode): string[] {
  let names: string[];
  if (isCcrMode(mode)) names = format === "anthropic" ? WORKER_IGNORED_ANTHROPIC : WORKER_IGNORED_CHAT;
  else if (mode === "chat-via-anthropic") names = CONVERT_IGNORED_CHAT;
  else if (mode === "anthropic-via-chat") names = CONVERT_IGNORED_ANTHROPIC;
  else return [];
  return names.filter((n) => body[n] !== undefined && body[n] !== null);
}

/**
 * How long a request waits for a busy / momentarily unschedulable organization (env, 0–60 s, default 15 s).
 * Small organizations (≤ ACCOUNT_SMALL_TEAM_MAX_ACCOUNTS accounts, default 2 — a one-account organization in
 * particular) get ACCOUNT_BUSY_WAIT_SMALL_TEAM_MS (default 2 × base = 30 s): with one account, "busy" is the normal state
 * between two turns, not a sign of trouble (2026-11-01, A2).
 */
function busyWaitMs(teamAccounts = Number.POSITIVE_INFINITY): number {
  const base = Math.max(0, Math.min(60_000, Number(process.env.ACCOUNT_BUSY_WAIT_MS ?? 15_000)));
  const smallMax = Math.max(1, Number(process.env.ACCOUNT_SMALL_TEAM_MAX_ACCOUNTS ?? 2));
  if (teamAccounts > smallMax) return base;
  // default: twice the base wait (15 s → 30 s in production; tests that shrink the base shrink this too)
  const small = process.env.ACCOUNT_BUSY_WAIT_SMALL_TEAM_MS !== undefined ? Math.max(0, Math.min(60_000, Number(process.env.ACCOUNT_BUSY_WAIT_SMALL_TEAM_MS))) : base * 2;
  return Math.max(base, small);
}

/** Slots an account without a concurrency cap is assumed to offer when organizations are compared. */
const UNCAPPED_SLOTS = 20;

/**
 * Organization choice for a new conversation (A1/A3, 2026-11-01). `teams` = the usable candidate accounts that
 * carry an organization, in listCandidates order (group priority, account priority, least recently used).
 * Score = free concurrency slots of the non-cooling accounts × (0.25 + 0.75 × average window headroom).
 * teamAffinity "spread" ranks larger organizations first, "pack" smaller ones; both fall back to the score.
 */
export function pickTeam(
  teams: Array<{ id: string; team_id?: string | null; concurrency: number; window_used: number | null; cooling?: boolean; temp_unschedulable_until?: string | null; overload_until?: string | null }>,
  affinity: "spread" | "pack" | null | undefined,
  inFlight: (accountId: string) => number = accountInFlight,
): { teamId: string; why: string } {
  const now = nowIso();
  const byTeam = new Map<string, { n: number; free: number; headroom: number; order: number }>();
  teams.forEach((a, i) => {
    const t = accountTeamId(a);
    if (!t) return;
    const e = byTeam.get(t) ?? { n: 0, free: 0, headroom: 0, order: i };
    e.n += 1;
    const cooling = !!a.cooling || (!!a.temp_unschedulable_until && a.temp_unschedulable_until > now) || (!!a.overload_until && a.overload_until > now);
    if (!cooling) e.free += a.concurrency > 0 ? Math.max(0, a.concurrency - inFlight(a.id)) : UNCAPPED_SLOTS;
    e.headroom += 1 - Math.min(1, Math.max(0, a.window_used ?? 0));
    byTeam.set(t, e);
  });
  const rows = [...byTeam.entries()].map(([teamId, e]) => ({ teamId, n: e.n, free: e.free, headroom: e.headroom / e.n, order: e.order, score: e.free * (0.25 + 0.75 * (e.headroom / e.n)) }));
  rows.sort((x, y) => {
    if (affinity === "spread" && x.n !== y.n) return y.n - x.n;
    if (affinity === "pack" && x.n !== y.n) return x.n - y.n;
    if (y.score !== x.score) return y.score - x.score;
    return x.order - y.order;
  });
  const w = rows[0];
  return { teamId: w.teamId, why: `affinity=${affinity ?? "capacity"} accounts=${w.n} freeSlots=${w.free} headroom=${w.headroom.toFixed(2)} score=${w.score.toFixed(1)} of ${rows.length} org(s)` };
}

/**
 * A tool round whose organization has no schedulable account, or whose accounts all failed (2026-11-01): the
 * generation is not reset and nothing is forwarded to another organization — the client gets a retryable 503
 * with its team and context retained, instead of the 409 that threw the task away.
 */
function failTeamCapacity(ctx: Ctx, account: AccountRow | null): void {
  if (!ctx.reply.raw.headersSent) ctx.reply.header("retry-after", "30");
  fail(
    ctx,
    account,
    503,
    "team_capacity_exhausted",
    "The organization serving this conversation has no schedulable account right now (cooldown, usage window or upstream failure), and a tool round cannot be continued by another organization. The conversation's context is retained: retry this same request shortly.",
    "upstream_error",
  );
}

function fail(
  ctx: Ctx,
  account: AccountRow | null,
  status: number,
  code: string,
  message: string,
  type: Parameters<typeof sendError>[5],
): void {
  logFailure(ctx, account, status, code, message);
  if (ctx.early) {
    endEarlyStreamWithError(ctx, code, message, type);
    return;
  }
  if (ctx.jsonEarly) {
    endEarlyJsonWithError(ctx, status, code, message, type);
    return;
  }
  stopNonStreamHeartbeat(ctx);
  sendError(ctx.reply, ctx.format, status, code, message, type);
}

/**
 * Hand an upstream error back to the client: same dialect → status + body verbatim; otherwise the
 * upstream message wrapped in the client's dialect. 4xx (400/404/413/422) on the normal path; every
 * status on a raw passthrough relay (§4a), where `retryAfter` is relayed too.
 */
function passUpstreamError(ctx: Ctx, account: AccountRow, mode: Mode, status: number, text: string, retryAfter: string | null = null): void {
  const code = status === 429 ? "upstream_rate_limited" : status >= 500 ? "upstream_error" : "upstream_client_error";
  const type: Parameters<typeof sendError>[5] = status === 429 ? "rate_limit_error" : status >= 500 ? "upstream_error" : "invalid_request_error";
  logFailure(ctx, account, status, code, `Upstream returned ${status} (passed through)`);
  const sameDialect = mode.startsWith("passthrough");
  if (ctx.early) {
    let m = text;
    try {
      const j = JSON.parse(text) as Json;
      m = String(j.error?.message ?? j.message ?? text);
    } catch {
      /* keep raw text */
    }
    endEarlyStreamWithError(ctx, code, m || `Upstream returned ${status}`, type);
    return;
  }
  if (ctx.jsonEarly) {
    let m = text;
    try {
      const j = JSON.parse(text) as Json;
      m = String(j.error?.message ?? j.message ?? text);
    } catch {
      /* keep raw text */
    }
    endEarlyJsonWithError(ctx, status, code, m || `Upstream returned ${status}`, type, sameDialect && text ? text : undefined);
    return;
  }
  stopNonStreamHeartbeat(ctx);
  if (retryAfter) ctx.reply.header("retry-after", retryAfter);
  if (sameDialect && text) {
    ctx.reply.status(status).header("content-type", "application/json").send(text);
    return;
  }
  let message = text;
  try {
    const j = JSON.parse(text) as Json;
    message = j.error?.message ?? j.message ?? text;
  } catch {
    /* keep raw text */
  }
  ctx.reply
    .status(status)
    .header("content-type", "application/json")
    .send(errorBody(ctx.format, code, String(message || `Upstream returned ${status}`), type));
}

// ---------- success paths ----------

function settleSuccess(
  ctx: Ctx,
  account: AccountRow,
  upstreamModel: string,
  acc: UsageAccumulator,
  firstTokenMs: number | null,
  /**
   * Unused since 2026-10-16: CCR rows carry the upstream meter minus the identity
   * baseline (docs/ccr-supply.md §7.1); `usage_estimated` now means only "upstream
   * reported no usage, tokens are chars/4". Kept so call sites stay unchanged.
   */
  _ccrExecuted = false,
): void {
  try {
    acc.observeRequest(ctx.body);
    const { usage, estimated } = acc.finalize(ctx.body);
    if (ctx.forceCacheBilling && usage.input_tokens > 0) {
      usage.cache_read_tokens = (usage.cache_read_tokens ?? 0) + usage.input_tokens;
      usage.input_tokens = 0;
    }
    settleRequest({
      requestId: ctx.requestId,
      userId: ctx.caller.userId,
      apiKeyId: ctx.caller.apiKeyId,
      groupId: ctx.caller.groupId,
      rateMultiplier: ctx.caller.rateMultiplier,
      accountId: account.id,
      providerId: account.owner_id,
      payoutRate: account.owner_id ? account.payout_rate : 0,
      model: ctx.model,
      upstreamModel,
      actualModel: acc.actualModel ?? upstreamModel,
      endpoint: ctx.endpoint,
      stream: ctx.stream,
      statusCode: 200,
      credentialVersion: ctx.credentialVersion,
      executionSequence: ctx.executionSequence,
      usage,
      usageEstimated: estimated,
      durationMs: Date.now() - ctx.startedAt,
      firstTokenMs,
      selectionMs: ctx.selectionMs,
      streamTruncated: ctx.streamTruncated,
      toolCalls: acc.toolCalls,
      toolResults: acc.toolResults,
      clientIp: clientIp(ctx.req),
      ccShape: ctx.ccShape,
      mode: ctx.trace.mode,
      nodeId: account.node_id,
      accountSwitched: ctx.forceCacheBilling,
      teamId: account.team_id ?? null,
      proxyId: account.bound_proxy_id ?? null,
    });
  } catch (err) {
    console.error(`[billing] settle failed for ${ctx.requestId}:`, err);
    throw err;
  }
}

function upstreamWire(mode: Mode): "anthropic" | "chat" | "responses" {
  if (mode === "passthrough-anthropic" || mode === "chat-via-anthropic") return "anthropic";
  if (mode === "passthrough-responses") return "responses";
  return "chat";
}

async function deliver(
  ctx: Ctx,
  res: Response,
  account: AccountRow,
  mode: Mode,
  upstreamModel: string,
  upstreamHost: string,
  done: () => void,
  ccrExecuted = false,
): Promise<void> {
  const contentType = res.headers.get("content-type") ?? "";
  if (ctx.stream && contentType.includes("text/event-stream")) {
    await deliverStream(ctx, res, account, mode, upstreamModel, upstreamHost, done, ccrExecuted);
    return;
  }
  if (ctx.early) {
    // Headers already went out as SSE but upstream answered a plain body: nothing sensible to stream.
    done();
    res.body?.cancel().catch(() => {});
    console.warn(`[proxy] ${ctx.requestId} account ${account.name}: non-SSE upstream body (${contentType || "no content-type"}) on a streaming request`);
    fail(ctx, account, 502, "upstream_error", "Upstream answered a streaming request with a non-streaming body.", "upstream_error");
    return;
  }

  const acc = new UsageAccumulator();
  let raw: Buffer;
  // The client hung up while upstream was still generating: stop the generation (a worker
  // stream's cancel kills the remote process) instead of running it to the end unheard.
  const onAbort = () => res.body?.cancel().catch(() => {});
  if (ctx.clientGone) onAbort();
  else ctx.abort.signal.addEventListener("abort", onAbort, { once: true });
  try {
    raw = await responseBytes(res, 16_777_216, ctx.abort.signal);
  } catch (err) {
    done();
    ctx.abort.signal.removeEventListener("abort", onAbort);
    if (ctx.clientGone) {
      console.warn(`[proxy] ${ctx.requestId} account ${account.name}: client closed before the upstream body arrived; cancelled, not billed`);
      logFailure(ctx, account, 499, "client_closed", "Client closed the connection before the response was complete");
      return;
    }
    // Tunnel closed by the node, socket reset, truncated compressed body…:
    // the account answered 200 but we never got the message. Log a failure
    // row (no charge), cool the account briefly, answer 502.
    const message = (err as Error).message;
    console.warn(`[proxy] ${ctx.requestId} account ${account.name}: body read failed: ${message}`);
    if (account.raw_passthrough !== 1) markFailure(account.id, { kind: "transient", message: `body read: ${message}` });
    fail(ctx, account, 502, "upstream_error", `Upstream response could not be read (${message}).`, "upstream_error");
    return;
  }
  done();
  ctx.abort.signal.removeEventListener("abort", onAbort);
  if (ctx.clientGone) {
    // Complete upstream answer, nobody to give it to. The account did the work, but the
    // customer never saw it (Cloudflare 524 at 125 s on long non-stream generations, 2026-10-22).
    console.warn(`[proxy] ${ctx.requestId} account ${account.name}: client closed before the response was sent; not billed`);
    logFailure(ctx, account, 499, "client_closed", "Client closed the connection before the response was complete");
    return;
  }
  let out: Buffer = raw;
  try {
    const json = JSON.parse(raw.toString("utf8")) as Json;
    const wire = upstreamWire(mode);
    acc.observeModel(json.model);
    if (wire === "anthropic") {
      acc.addAnthropic(json.usage);
      acc.addAnthropicContent(json.content);
    } else if (wire === "chat") {
      acc.addOpenaiChat(json.usage);
      for (const choice of Array.isArray(json.choices) ? json.choices : []) acc.addOpenAIToolCalls(choice?.message?.tool_calls);
    } else {
      acc.addResponses(json.usage);
      for (const item of Array.isArray(json.output) ? json.output : []) acc.addResponsesItem(item);
    }
    acc.addText(collectText(json));
    let transformed: Json = json;
    if (mode === "chat-via-anthropic") transformed = anthropicMessageToOpenai(json, ctx.model);
    else if (mode === "anthropic-via-chat") transformed = openaiChatToAnthropicMessage(json, ctx.model);
    else if (upstreamModel !== ctx.model && typeof json.model === "string") transformed = { ...json, model: ctx.model };
    if (transformed !== json) out = Buffer.from(JSON.stringify(transformed), "utf8");
  } catch {
    /* non-JSON body: pass through untouched */
  }
  assertScope(ctx.scope);
  try { settleSuccess(ctx, account, upstreamModel, acc, null, ccrExecuted); }
  catch { fail(ctx, account, 503, "settlement_unavailable", "The response could not be safely recorded. Contact the administrator with the request time before retrying.", "api_error"); return; }

  if (ctx.jsonEarly) {
    // 200 + headers went out during the wait (heartbeat.ts): the body follows the padding.
    endEarlyJson(ctx, out);
    return;
  }
  stopNonStreamHeartbeat(ctx);
  if (teeProofRequested(ctx.req) === "multipart") {
    const boundary = `1dayapi-${crypto.randomBytes(12).toString("hex")}`;
    const proof = JSON.stringify(makeTeeProof(upstreamHost, out));
    ctx.reply
      .status(200)
      .header("content-type", `multipart/mixed; boundary=${boundary}`)
      .send(
        Buffer.concat([
          Buffer.from(`--${boundary}\r\ncontent-type: application/json\r\n\r\n`),
          out,
          Buffer.from(
            `\r\n--${boundary}\r\ncontent-type: application/json\r\nx-1dayapi-part: tee.proof\r\n\r\n${proof}\r\n--${boundary}--\r\n`,
          ),
        ]),
      );
    return;
  }
  ctx.reply.status(200).header("content-type", "application/json").send(out);
}

interface SseEvent {
  raw: string;
  event: string | null;
  data: string;
}

function parseSseEvent(raw: string): SseEvent {
  let event: string | null = null;
  const data: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  return { raw, event, data: data.join("\n") };
}

async function deliverStream(
  ctx: Ctx,
  res: Response,
  account: AccountRow,
  mode: Mode,
  upstreamModel: string,
  upstreamHost: string,
  done: () => void,
  ccrExecuted = false,
): Promise<void> {
  const { reply } = ctx;
  if (!ctx.early) {
    reply.hijack();
    reply.raw.writeHead(200, {
      ...CORS_HEADERS,
      ...conversationResponseHeaders(reply),
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
  }

  const acc = new UsageAccumulator();
  const forwarded: Buffer[] = [];
  const wantProof = !!teeProofRequested(ctx.req);
  let firstTokenMs: number | null = null;
  let clientGone = ctx.clientGone;
  /** Upstream signalled failure inside the 200 stream (Anthropic `error` event, OpenAI `{error}` chunk, CCR executor error). */
  let streamError: string | null = null;
  /** The upstream stream reached its normal terminator (message_stop / [DONE] / response.completed). */
  let completed = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const onGone = () => {
    if (ctx.clientGone || reply.raw.destroyed) clientGone = true;
    else streamError = "request scheduling lease lost";
    // Stop reading upstream right away so the account's concurrency slot is
    // not held by a stream nobody is listening to.
    reader?.cancel().catch(() => {});
  };
  if (clientGone) onGone();
  else ctx.abort.signal.addEventListener("abort", onGone, { once: true });

  let proofBytes = 0;
  const write = async (s: string): Promise<void> => {
    if (!s || clientGone) return;
    assertRequestLeases(ctx);
    if (ctx.scope?.row.team_id && !isConversationGenerationActive(ctx.scope.row.id, ctx.scope.row.team_id, ctx.scope.row.generation)) {
      const notice = ctx.format === "anthropic" ? `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: RESET_NOTICE, code: "context_reset" } })}\n\n` : `data: ${JSON.stringify({ error: { message: RESET_NOTICE, code: "context_reset" } })}\n\n`;
      reply.raw.end(notice); clientGone = true; reader?.cancel().catch(() => {}); return;
    }
    if (firstTokenMs === null) {
      firstTokenMs = Date.now() - ctx.startedAt;
      stopEarlyKeepalive(ctx);
    }
    const b = Buffer.from(s, "utf8");
    if (wantProof) {
      proofBytes += b.length;
      if (proofBytes > 8_388_608) throw new Error("proof response exceeds 8 MiB");
      forwarded.push(b);
    }
    if (!reply.raw.write(b)) {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); reply.raw.off("drain", ready); reply.raw.off("close", closed); ctx.abort.signal.removeEventListener("abort", closed); };
        const ready = () => { cleanup(); resolve(); };
        const closed = () => { cleanup(); reject(new Error("client closed during backpressure")); };
        const timer = setTimeout(() => { cleanup(); reject(new Error("client write stalled for 30s")); }, 30_000);
        reply.raw.once("drain", ready); reply.raw.once("close", closed); ctx.abort.signal.addEventListener("abort", closed, { once: true });
        if (ctx.abort.signal.aborted || reply.raw.destroyed) closed();
      });
    }
  };

  const clientWantsUsage = ctx.body.stream_options?.include_usage === true;
  const toOpenai = mode === "chat-via-anthropic" ? new AnthropicToOpenaiStream(ctx.model, clientWantsUsage) : null;
  const toAnthropic = mode === "anthropic-via-chat" ? new OpenaiToAnthropicStream(ctx.model) : null;
  const rewriteModel = upstreamModel !== ctx.model;

  const handle = async (ev: SseEvent): Promise<void> => {
    if (!ev.data) {
      if (!toOpenai && !toAnthropic) await write(`${ev.raw}\n\n`);
      return;
    }
    if (ev.data === "[DONE]" && (mode === "passthrough-openai" || mode === "anthropic-via-chat")) {
      completed = true;
      if (mode === "passthrough-openai") await write("data: [DONE]\n\n");
      return; // converters emit their own terminators
    }
    let j: Json | null = null;
    try {
      j = JSON.parse(ev.data) as Json;
    } catch {
      j = null;
    }
    switch (mode) {
      case "passthrough-anthropic":
      case "chat-via-anthropic": {
        if (j) {
          if (j.type === "message_start") {
            acc.observeModel(j.message?.model);
            acc.addAnthropic(j.message?.usage);
          } else if (j.type === "message_delta") acc.addAnthropic(j.usage);
          else if (j.type === "content_block_start") acc.addAnthropicContent([j.content_block]);
          else if (j.type === "content_block_delta") acc.addText(j.delta?.text ?? j.delta?.partial_json);
          else if (j.type === "message_stop") completed = true;
          else if (j.type === "error" || ev.event === "error") streamError = String(j.error?.message ?? j.message ?? "upstream error");
        }
        if (toOpenai) {
          if (j) for (const s of toOpenai.push(j)) await write(s);
        } else if (rewriteModel && j?.type === "message_start" && j.message) {
          await write(`event: message_start\ndata: ${JSON.stringify({ ...j, message: { ...j.message, model: ctx.model } })}\n\n`);
        } else {
          await write(`${ev.raw}\n\n`);
        }
        break;
      }
      case "passthrough-openai":
      case "anthropic-via-chat": {
        if (j) {
          acc.observeModel(j.model);
          if (j.usage) acc.addOpenaiChat(j.usage);
          for (const choice of Array.isArray(j.choices) ? j.choices : []) {
            acc.addText(choice?.delta?.content);
            acc.addOpenAIToolCalls(choice?.delta?.tool_calls ?? choice?.message?.tool_calls);
          }
          if (j.error && !(Array.isArray(j.choices) && j.choices.length)) streamError = String(j.error?.message ?? j.error ?? "upstream error");
          else if (j.choices?.[0]?.finish_reason) completed = true;
        }
        if (toAnthropic) {
          if (j) for (const s of toAnthropic.push(j)) await write(s);
          break;
        }
        const usageOnly = j && Array.isArray(j.choices) && j.choices.length === 0 && j.usage;
        if (usageOnly && !clientWantsUsage) break;
        if (j && rewriteModel) await write(`data: ${JSON.stringify({ ...j, model: ctx.model })}\n\n`);
        else await write(`${ev.raw}\n\n`);
        break;
      }
      case "passthrough-responses": {
        if (j) {
          acc.observeModel(j.response?.model);
          if (j.type === "response.output_item.done") acc.addResponsesItem(j.item);
          if ((j.type === "response.completed" || j.type === "response.done") && j.response) {
            acc.addResponses(j.response.usage);
            for (const item of Array.isArray(j.response.output) ? j.response.output : []) acc.addResponsesItem(item);
            completed = !j.response.status || j.response.status === "completed";
            if (!completed) streamError = `upstream response ended with status ${j.response.status}`;
          }
          if (j.type === "response.incomplete" || j.type === "response.cancelled") streamError = "upstream response was incomplete";
          if (j.type === "response.output_text.delta") acc.addText(j.delta);
          if (j.type === "error" || j.type === "response.failed") streamError = String(j.error?.message ?? j.response?.error?.message ?? "upstream error");
        }
        await write(`${ev.raw}\n\n`);
        break;
      }
    }
  };

  let readError: string | null = null;
  try {
    if (!res.body) throw new Error("upstream stream has no body");
    reader = res.body.getReader();
    if (clientGone) await reader.cancel().catch(() => {});
    const decoder = new TextDecoder();
    let pending = "";
    const boundary = /\r?\n\r?\n/;
    for (;;) {
      if (clientGone) {
        await reader.cancel().catch(() => {});
        break;
      }
      // Idle guard: a silently stalled upstream (dead socket, node gone
      // without a close frame) must not hold the slot forever.
      const r = reader;
      const idle = setTimeout(() => r.cancel(new Error(`upstream idle for ${config.streamIdleTimeoutMs} ms`)).catch(() => {}), config.streamIdleTimeoutMs);
      let chunk;
      try {
        chunk = await reader.read();
      } finally {
        clearTimeout(idle);
      }
      const { done: finished, value } = chunk;
      if (finished) break;
      pending += decoder.decode(value, { stream: true });
      let m: RegExpExecArray | null;
      while ((m = boundary.exec(pending)) !== null) {
        const chunk = pending.slice(0, m.index);
        pending = pending.slice(m.index + m[0].length);
        if (Buffer.byteLength(chunk) > 2_097_152) throw new Error("upstream SSE event exceeds 2 MiB");
        if (chunk.trim()) await handle(parseSseEvent(chunk));
      }
      if (Buffer.byteLength(pending) > 2_097_152) throw new Error("upstream SSE event exceeds 2 MiB");
    }
    pending += decoder.decode();
    if (pending.trim()) await handle(parseSseEvent(pending));
    if (completed && !streamError && toOpenai) for (const s of toOpenai.end()) await write(s);
    if (completed && !streamError && toAnthropic) for (const s of toAnthropic.end()) await write(s);
    if (wantProof) {
      const proof = makeTeeProof(upstreamHost, Buffer.concat(forwarded));
      await write(`event: tee.proof\ndata: ${JSON.stringify(proof)}\n\n`);
    }
  } catch (err) {
    readError = (err as Error).message;
    console.error(`[proxy] ${ctx.requestId} stream error:`, readError);
  } finally {
    done();
    stopEarlyKeepalive(ctx);
    ctx.abort.signal.removeEventListener("abort", onGone);
    // A stream that failed before reaching its terminator is not a served
    // request: no charge, a failure row, a short cooldown (unless the client
    // simply went away — then whatever upstream reported is billed as usual).
    const failed = !clientGone && (streamError !== null || readError !== null || !completed);
    if (clientGone && firstTokenMs === null) {
      // Nothing ever reached the client: not a served request (the upstream work was cancelled above).
      console.warn(`[proxy] ${ctx.requestId} account ${account.name}: client closed before the first byte; not billed`);
      logFailure(ctx, account, 499, "client_closed", "Client closed the connection before the first byte");
    } else if (failed) {
      const message = streamError ?? readError ?? "upstream stream ended without a terminator";
      console.warn(`[proxy] ${ctx.requestId} account ${account.name}: stream failed: ${message}`);
      const schedulingLost = ctx.abort.signal.aborted && !clientGone;
      if (!schedulingLost && account.raw_passthrough !== 1) markCcrFailure(ctx, account, `stream: ${message.slice(0, 300)}`); // raw relay (§4a): no cooldown
      // Claude Code's context overflow / safety refusal is the request's fault: log it as such and hand
      // the client Claude Code's own sentence (the auto-compact trigger) as an invalid_request_error.
      // `mode` here is the wire mode (passthrough-anthropic for a worker stream too): the CCR flag is ccrExecuted.
      const reqErr = ccrExecuted || isCcrMode(mode) ? classifyCcRequestError(message) : null;
      ctx.streamTruncated = true;
      ctx.trace.failure = {
        scope: reqErr ? "request" : "transport",
        code: schedulingLost ? "scheduling_lease_lost" : reqErr?.code ?? "upstream_stream_error",
        message,
        retryable: !reqErr,
        status: schedulingLost ? 503 : reqErr ? 400 : 502,
        credentialVersion: ctx.credentialVersion ?? undefined,
        executionSequence: ctx.executionSequence,
      };
      if (schedulingLost) logFailure(ctx, account, 503, "scheduling_lease_lost", message);
      else if (reqErr) logFailure(ctx, account, 400, reqErr.code, reqErr.message);
      else logFailure(ctx, account, 502, "upstream_stream_error", `Stream failed before its terminator: ${message.slice(0, 300)}`);
      if (readError !== null || (!streamError && !completed) || reqErr) {
        // Nothing upstream-shaped was forwarded for this failure: tell the client in its dialect.
        const text = reqErr ? reqErr.message : `upstream: ${message}`;
        const type = reqErr ? "invalid_request_error" : "api_error";
        await write(
          ctx.format === "anthropic"
            ? `event: error\ndata: ${JSON.stringify({ type: "error", error: { type, message: text } })}\n\n`
            : `data: ${JSON.stringify({ error: { message: text, type, param: null, code: null } })}\n\n`,
        ).catch(() => {});
      }
    } else {
      // A stream that reached its terminator is proof the account's credentials work.
      if (completed) authFailures.clear(account.id);
      // Settle before ending the response so a client that sees the stream
      // finish can immediately observe the charge. (144faa3 put the completed
      // case in its own branch above this call: completed streams went unbilled
      // for ~10 h on 2026-10-17 — see docs/issues-and-decisions.md.)
      try { settleSuccess(ctx, account, upstreamModel, acc, firstTokenMs, ccrExecuted); }
      catch { await write(ctx.format === "anthropic" ? `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: "Settlement recording unavailable; contact the administrator before retrying." } })}\n\n` : `data: ${JSON.stringify({ error: { message: "Settlement recording unavailable; contact the administrator before retrying.", code: "settlement_unavailable" } })}\n\n`).catch(() => {}); }
    }
    if (!clientGone) reply.raw.end();
  }
}
