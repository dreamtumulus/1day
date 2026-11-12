import crypto from "node:crypto";
import type { TurnFacts } from "./ccr/types.js";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  accountBaseUrl,
  accountTeamId,
  orgLevelErrorCode,
  suspendTeam,
  teamBudgetState,
  telemetryEvidenceLevel,
  CC_VERSION,
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
  advanceConversationGeneration,
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
  acquireRequestBudgetDetailed, renewRequestBudget, releaseRequestBudget, type AdmissionRefusal,
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
  loadTuiThirdPartyRefusal,
  saveTuiThirdPartyRefusal,
} from "@1dayapi/core";
import { inspectThirdPartyResponse, thirdPartyPromptKey, THIRD_PARTY_FALLBACK_TTL_MS } from "./ccr/third-party-fallback.js";
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
import { ccrUnsupportedReason, requestAsksForCaching, requestCacheTier, type CcrUnsupported } from "./ccr/translate.js";
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
import { wait, responseBytes, renewWithRetry } from "./lifecycle.js";
import { bump } from "./metrics.js";
import { NETWORK_FAILURE_CLASS, capBeforeAttempt, httpFailureClass, newRetryState, noteFailureClass, upstreamErrorType, type CapReason, type RetryState } from "./retry-policy.js";
import { credentialProblem, directAuthSignal } from "./direct-auth.js";
import { LocalStreamError, decideStreamSettlement } from "./stream-settlement.js";
import { disposalKinds, failureSignals, requestEchoText, signalText, workerFailureEvidence, type DisposalKind, type FailureSource, type SignalDecision } from "./ccr/failure-evidence.js";
// Canonical worker turns the legacy worker takes over (2026-11-05, probe toolround-import): a tool round no live native
// session holds / an external history canonical may not import, or canonical needing the persistent pool. The legacy
// fold carries any history, so these are a hand-over, not a 409.
const CANONICAL_FALLBACK_CODES = new Set(["history_import_unsupported", "canonical_requires_persistent_session", "canonical_node_unavailable"]);
import { AnthropicToResponsesStream, ResponsesUnsupported, anthropicMessageToResponses, responsesToAnthropic, strictUnsupportedParams } from "./adapters/responses.js";
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
  /** Worker/cloud turn facts (upstream retries inside Claude Code), filled by the executor, recorded with usage. */
  turnFacts: TurnFacts;
  /** Claude Code shape verdict (docs/gateway.md §2a); null = not a CC-UA request. */
  ccShape: "genuine" | "suspect" | null;
  /** settings cc_client_response_profile (spec WP1 §6): a Claude Code client gets no x-1day-* diagnostic headers. */
  hideDiagHeaders: boolean;
  /** Observability trace for the usage row: last path tried, its node, what upstream answered. */
  trace: { mode: Mode | null; nodeId: string | null; upstreamStatus: number | null; upstreamMessage: string | null; failure: UpstreamFailure | null };
  /** Current canonical attempt's third-party fallback state; reset before every account. */
  tuiThirdParty?: { promptKey: string; enabled: boolean; canonicalAttempt: boolean };
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
  /** Retry caps of this client request (retry-policy.ts); kept across organisation switches. */
  retry: RetryState;
  /** The account whose answer was in hand when the conversation's ownership turned out to have changed (F). */
  scopeLossAccount?: AccountRow | null;
}

function rememberTuiThirdParty(ctx: Ctx, from: "retry" | "started"): boolean {
  const state = ctx.tuiThirdParty;
  if (!state?.enabled || !state.canonicalAttempt || !state.promptKey) return false;
  saveTuiThirdPartyRefusal(state.promptKey, Date.now() + THIRD_PARTY_FALLBACK_TTL_MS);
  state.canonicalAttempt = false;
  bump("ccr_tui_third_party_remembered_total", { from });
  console.warn(`[ccr-worker] ${ctx.requestId} third-party refusal on canonical/TUI; system ${state.promptKey.slice(0, 12)} uses legacy -p for 12h (${from})`);
  return true;
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
  // A failed read is retried in place before the request is fenced (G); a missing row is a real loss.
  for (let attempt = 1; ; attempt++) {
    try { budget = one("SELECT 1 FROM gateway_request_budgets WHERE request_id = ? AND expires_at > ?", ctx.requestId, Date.now()); break; }
    catch (err) { if (attempt >= config.leaseRenewTries) { ctx.abort.abort(err); throw err; } }
  }
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

const usd = (v: number | null): string => (v === null ? "-" : !Number.isFinite(v) ? "unlimited" : v.toFixed(v !== 0 && Math.abs(v) < 0.01 ? 6 : 2));

/** `in_flight=<n>/<cap> reserved=<usd>/<cap>` (+ balance and key quota when they decided). */
export function admissionRefusalNumbers(r: AdmissionRefusal): string {
  return [
    `in_flight=${r.inFlight ?? "-"}/${r.maxInflight ?? "-"}`,
    `reserved=${usd(r.reservedUsd)}/${usd(r.capUsd)}`,
    `available=${usd(r.availableUsd)}`,
    ...(r.keyRemainingUsd !== null ? [`key_remaining=${usd(r.keyRemainingUsd)}`, `key_reserved=${usd(r.keyReservedUsd)}`] : []),
    `wanted=${usd(r.wantedUsd)}`,
  ].join(" ");
}

/** The 429 `user_inflight_limit` message: which limit refused the request and what to do about it, in plain words. */
export function admissionRefusalMessage(r: AdmissionRefusal): string {
  switch (r.reason) {
    case "insufficient_funds":
      return "Your balance and remaining credit are used up, so no new request can be started. Top up (or settle your credit line) and retry.";
    case "key_quota_exhausted":
      return "This API key has used up its quota, so no new request can be started. Raise the key's quota or use another key.";
    case "concurrency_cap":
      return `Too many requests at the same time: ${r.inFlight} are already in flight and your limit is ${r.maxInflight} concurrent requests. Lower your concurrency or retry when one of them finishes.`;
    case "reserved_spending_cap":
      return r.capIsBalance
        ? `The requests you already have in flight reserve your whole available balance (${usd(r.reservedUsd)} of ${usd(r.capUsd)} USD reserved; this request needs about ${usd(r.wantedUsd)} USD more). Top up, lower your concurrency or max_tokens, or retry when a request finishes.`
        : `The requests you already have in flight reserve your in-flight spending limit (${usd(r.reservedUsd)} of ${usd(r.capUsd)} USD reserved; this request needs about ${usd(r.wantedUsd)} USD more). Lower your concurrency or max_tokens, or retry when a request finishes.`;
    case "key_quota_reserved":
      return `The requests already in flight on this API key reserve what is left of its quota (${usd(r.keyReservedUsd)} of ${usd(r.keyRemainingUsd)} USD remaining; this request needs about ${usd(r.wantedUsd)} USD more). Raise the key's quota, lower your concurrency or max_tokens, or retry when a request finishes.`;
  }
}

const admissionLogAt = new Map<string, number>();
const ADMISSION_LOG_INTERVAL_MS = 60_000;

/** Counter for every refusal; one log line per user per minute (with the number of refusals it stands for). */
export function noteAdmissionRefusal(userId: string, apiKeyId: string, r: AdmissionRefusal, now = Date.now(), log: (line: string) => void = console.warn): boolean {
  bump("admission_refused_total", { reason: r.reason });
  const last = admissionLogAt.get(userId);
  if (last !== undefined && now - last < ADMISSION_LOG_INTERVAL_MS) return false;
  if (admissionLogAt.size > 5000) for (const [k, t] of admissionLogAt) if (now - t >= ADMISSION_LOG_INTERVAL_MS) admissionLogAt.delete(k);
  admissionLogAt.set(userId, now);
  log(`[admission] user=${userId.slice(0, 8)} key=${apiKeyId.slice(0, 8)} refused: ${r.reason} ${admissionRefusalNumbers(r)}`);
  return true;
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
  const admission = acquireRequestBudgetDetailed(requestId, caller.userId, caller.apiKeyId, estimate);
  if (!admission.ok) {
    // X-55: say why (to the customer, the log, a counter and a zero-cost usage row) — until 2026-11-10 these 429s were
    // only visible in nginx.
    const message = admissionRefusalMessage(admission);
    noteAdmissionRefusal(caller.userId, caller.apiKeyId, admission);
    try {
      settleRequest({
        requestId,
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
        statusCode: 429,
        errorCode: "user_inflight_limit",
        usage: { input_tokens: 0, output_tokens: 0 },
        usageEstimated: false,
        durationMs: 0,
        clientIp: clientIp(req),
        errorMessage: `${admission.reason}: ${message} [${admissionRefusalNumbers(admission)}]`,
      });
    } catch (err) {
      console.error("[proxy] failed to log admission refusal:", err);
    }
    sendError(reply, format, 429, "user_inflight_limit", message, "rate_limit_error");
    return;
  }
  const abort = new AbortController();
  lifecycles.set(req, { requestId, abort });
  const onClose = () => { if (!reply.raw.writableFinished) abort.abort(); };
  reply.raw.once("close", onClose);
  // A failed renewal write is retried before the request is aborted; a reservation that is really gone aborts at once (G).
  let budgetDone = false;
  const renew = setInterval(() => renewWithRetry(
    () => renewRequestBudget(requestId),
    (err) => abort.abort(err),
    { tries: config.leaseRenewTries, backoffMs: config.leaseRenewBackoffMs, label: "request budget", isLoss: (err) => /lease lost/.test((err as Error)?.message ?? ""), stopped: () => budgetDone },
  ), 30_000);
  renew.unref();
  try { await proxyAuthorized(req, reply, format, endpoint, caller); }
  catch (err) { if (!abort.signal.aborted) throw err; }
  finally {
    clearInterval(renew);
    budgetDone = true;
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
  let conversationDone = false;
  const renewal = setInterval(() => {
    if (scope.released) return;
    // false = another request owns the conversation now (fence at once); a failed database call is retried first (G).
    renewWithRetry(
      () => scope.released || renewConversationLease(scope.row.id, token),
      () => { if (scope.released) return; scope.lost = true; scope.abort?.abort(); },
      { tries: config.leaseRenewTries, backoffMs: config.leaseRenewBackoffMs, label: "conversation", stopped: () => conversationDone },
    );
  }, 20_000);
  renewal.unref();
  try { await proxyRequest(req, reply, format, endpoint, caller, scope); }
  catch (err) {
    if ((err as Error).message !== "conversation ownership changed") throw err;
    if (scope.responseCtx) { stopEarlyKeepalive(scope.responseCtx); stopNonStreamHeartbeat(scope.responseCtx); }
    // Visible in the usage log and the journal (review 2026-11-09 F): before this the event left no trace at all.
    logOwnershipChange(req, caller, endpoint, originalBody, scope);
    // Client-visible behaviour is unchanged in this pass: the platform's reset notice, sent as an assistant message
    // (HTTP 200, x-1day-context-reset: 1) — i.e. a platform-authored text in the place of a model answer.
    if (!reply.raw.writableEnded) sendResetNotice(reply, format, originalBody);
  }
  finally { clearInterval(renewal); conversationDone = true; releaseConversationLease(scope.row.id, token); }
}

/**
 * The conversation's generation moved on (another request reset it, or its lease was lost) while this request was
 * running: a zero-cost 409 `context_reset` failure row and one log line. Whatever upstream answer was in hand has
 * been cancelled by the caller and is not billed.
 */
function logOwnershipChange(req: FastifyRequest, caller: CallerContext, endpoint: string, originalBody: Json, scope: ConversationScope): void {
  const ctx = scope.responseCtx;
  const account = ctx?.scopeLossAccount ?? null;
  const message = `Conversation ownership changed while this request was running (conversation ${scope.row.id}, generation ${scope.row.generation}): ${account ? `the answer of account ${account.name} was discarded and its upstream body cancelled` : "no upstream answer was in hand"}; the client received the platform's reset notice as an assistant message, not a model answer.`;
  bump("conversation_ownership_changed_total", { answer_in_hand: account ? "yes" : "no" });
  console.warn(`[proxy] ${ctx?.requestId ?? lifecycles.get(req)?.requestId ?? "-"} key=${caller.apiKeyId} ${message}`);
  if (ctx) {
    ctx.trace.failure = { scope: "request", code: "context_reset", message: "conversation ownership changed", retryable: true, status: 409, credentialVersion: ctx.credentialVersion ?? undefined, executionSequence: ctx.executionSequence };
    ctx.trace.upstreamStatus = null;
    ctx.trace.upstreamMessage = null;
    logFailure(ctx, account, 409, "context_reset", message);
    return;
  }
  try {
    settleRequest({
      requestId: lifecycles.get(req)?.requestId ?? crypto.randomUUID(), userId: caller.userId, apiKeyId: caller.apiKeyId, groupId: caller.groupId, rateMultiplier: caller.rateMultiplier,
      accountId: null, providerId: null, payoutRate: 0, model: (typeof originalBody.model === "string" && originalBody.model.trim()) || "-", upstreamModel: null, endpoint,
      stream: originalBody.stream === true, statusCode: 409, errorCode: "context_reset", errorScope: "request", retryable: true,
      usage: { input_tokens: 0, output_tokens: 0 }, usageEstimated: false, durationMs: 0, clientIp: clientIp(req), errorMessage: message,
    });
  } catch (err) {
    console.error("[proxy] failed to log the ownership change:", err);
  }
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

async function switchTeam(scope: ConversationScope, nextTeam: string, format: ClientFormat, reason: string, carryHistory = false): Promise<void> {
  const previous = scopeContext(scope);
  const generation = scope.row.generation;
  await lockScope(scope);
  // Another request won the reset. Follow that winner; never overwrite its generation.
  if (scope.row.generation !== generation) { scope.boundary = undefined; return; }
  assertScope(scope);
  if (carryHistory) {
    // historyPolicy `passthrough` (2026-11-05, 测试BOOK: 13 team switches in an hour each cut the conversation to
    // its latest question): the key asked for its history to be forwarded as-is, so the new organization gets
    // the whole transcript — canonical imports it, the legacy fold carries it — and no boundary is written.
    scope.row = advanceConversationGeneration(scope.row.id, scope.token, scope.row.generation, nextTeam, `${reason}:carried`);
    scope.boundary = undefined;
    scope.justReset = false;
    console.log(`[proxy] conv ${scope.row.id.slice(0, 8)} -> team ${nextTeam.slice(0, 8)} (${reason}), history carried (passthrough)`);
  } else {
    const question = latestQuestion(scope.originalBody, format);
    scope.row = resetConversationGeneration(scope.row.id, scope.token, scope.row.generation, nextTeam, question.anchor, question.prefix, reason);
    scope.boundary = saveBranchBoundary(scope.row.id, scope.token, scope.row.generation, scope.branch, question.anchor, question.prefix);
    scope.justReset = true;
  }
  unlockScope(scope);
  if (previous) {
    retireCcrConversation(previous);
    await resetConversationWorkers(previous);
  }
}

async function proxyRequest(req: FastifyRequest, reply: FastifyReply, format: ClientFormat, endpoint: string, caller: CallerContext, scope?: ConversationScope): Promise<void> {
  assertScope(scope);
  let body = scope ? scope.originalBody : (req.body && typeof req.body === "object" ? req.body : {}) as Json;
  // X-57: decided on the request as the caller sent it — the body is rebuilt from the stored conversation further down
  // and loses the caller's cache_control markers on the way.
  const callerAsksForCaching = requestAsksForCaching((req.body && typeof req.body === "object" ? req.body : {}) as Json) || requestAsksForCaching(body);
  const callerCacheTier = requestCacheTier((req.body && typeof req.body === "object" ? req.body : {}) as Json) ?? requestCacheTier(body);
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
      } else if (caller.policy.historyPolicy === "passthrough") {
        // passthrough (2026-11-05): a boundary this generation does not recognise (a row reset before the key's
        // policy changed, or by an earlier team switch) is not a reason to cut — the whole history is forwarded.
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
  // Responses API first tier (spec WP4.3): validate → map before any account is touched; what the tier does not
  // implement is a named 400, never a silent drop (I: strict 零静默).
  if (format === "responses" && !rawGroup) {
    // Validate what the CLIENT sent: a reset conversation forwards a rebuilt body (scope.originalBody keeps the original).
    try { responsesToAnthropic(scope?.originalBody ?? body, model); }
    catch (err) {
      if (err instanceof ResponsesUnsupported) {
        bump("unsupported_parameter_total", { parameter: err.parameter });
        reject(400, "unsupported_parameter", `Unsupported parameter '${err.parameter}': ${err.reason}.`, "invalid_request_error");
        return;
      }
      throw err;
    }
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
    turnFacts: {},
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
    retry: newRetryState(),
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
    // Organization budgets (spec WP7.1): an organization over its daily token / cost budget or at its concurrency cap
    // takes no NEW conversation; in-flight work is untouched. Suspended organizations are already out of listCandidates.
    // One budget check per organization, not per account (X-71, 2026-11-12): the day's usage SUM ran once for every
    // candidate account (~330 accounts × ~10 ms) plus an O(n²) in-flight reduce — ~3 s of synchronous work for each new
    // conversation, which froze the gateway's event loop (every request 499 for minutes at a time).
    const budgetBlocked = new Map<string, string>();
    const budgetOk = new Set<string>();
    const inFlightByTeam = new Map<string, number>();
    if (!scope.row.team_id) for (const b of usable) { const t = accountTeamId(b); if (t) inFlightByTeam.set(t, (inFlightByTeam.get(t) ?? 0) + accountInFlight(b.id)); }
    const teams = usable.filter((a) => {
      const t = accountTeamId(a);
      if (!t) return false;
      if (budgetBlocked.has(t)) return false;
      if (!scope.row.team_id && !budgetOk.has(t)) {
        const st = teamBudgetState(t, inFlightByTeam.get(t) ?? 0);
        if (!st.ok) { budgetBlocked.set(t, st.reason ?? "budget"); bump("org_budget_exhausted_total", { team: t }); console.warn(`[proxy] ${ctx.requestId} organization ${t} takes no new conversation: ${st.reason}`); return false; }
        budgetOk.add(t);
      }
      return true;
    });
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
        // No organisation switch once the request's retry caps are used up (A).
        const capped = next ? capBeforeAttempt(ctx.retry, ctx.startedAt, Date.now(), config) : null;
        if (capped) tripRetryCap(ctx, capped, null, "before an organisation switch");
        else if (next) { await switchTeam(scope, accountTeamId(next)!, format, "team_pool_exhausted", caller.policy.historyPolicy === "passthrough"); return proxyRequest(req, reply, format, endpoint, caller, scope); }
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
    // accounts kept schedulable only by usage credits (usage_credits_policy) go after every account with plan quota left,
    // sticky or not: a request on credits is billed to the account owner at API rates (docs/usage-credits.md)
    [...orderByAffinity(usable.filter((a) => !a.cooling && !a.onCredits), sKey, dKey), ...usable.filter((a) => !a.cooling && a.onCredits), ...usable.filter((a) => a.cooling)],
    merkleNamespace,
    scope?.originalBody ?? body,
    format,
  );
  let attempts = 0;
  let lastStatus = 0;
  /** The node refused the request itself (spec_too_large …): answered once, no further candidates. */
  let requestError: TunnelRequestError | null = null;
  /** spec WP6: every canonical-capable account was skipped for missing telemetry evidence (→ 503 native_telemetry_unverified). */
  let telemetryUnverified = false;
  let lastMessage = "";
  let lastAccount: AccountRow | null = null;
  // CCR capability check is per request, not per account (docs/ccr-supply.md §6).
  let ccrBody: Json | null = null;
  let ccrUnsupported: CcrUnsupported | null = null;
  const ccrRequest = (): Json => {
    if (!ccrBody) ccrBody = format === "openai-chat" ? openaiChatToAnthropic(body, model) : format === "responses" ? responsesToAnthropic(body, model) : body;
    return ccrBody;
  };

  const busyDeadline = Date.now() + busyWaitMs(scope?.row.team_id ? all.length : Number.POSITIVE_INFINITY);
  let busy: Candidate[] = [];
  for (;;) {
  busy = [];
  for (const account of ordered) {
    if (!scope && attempts >= config.maxAttempts) break;
    // Total caps (A): they hold with a conversation scope too, and across organisation switches.
    const cap = capBeforeAttempt(ctx.retry, ctx.startedAt, Date.now(), config);
    if (cap) { tripRetryCap(ctx, cap, lastAccount, `last status ${lastStatus || "network"}`); break; }
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
      ctx.tuiThirdParty = undefined;
      // Raw passthrough relay on a same-protocol request (§4a): the client's model spelling travels as-is
      // (no canonical id, no account model mapping), upstream errors come back verbatim, no cooldown.
      const raw = account.raw_passthrough === 1 && mode.startsWith("passthrough-");
      const upstreamModel = raw ? model : upstreamModelFor(account, upstreamBaseModel);
      let refreshed = false;
      for (;;) {
        ctx.executionSequence++;
        ctx.turnFacts.failure = undefined;
        assertRequestLeases(ctx);
        if (ctx.clientGone) {
          logFailure(ctx, account, 499, "client_closed", "Client closed the connection before an upstream answer");
          return;
        }
        // Path transparency (audit 2026-11-01 B14): which execution path answers — the client could only guess from
        // the message id prefix before. Set before the early 200 so hijacked SSE/JSON heads carry it too.
        // Strict parameter contract (spec WP4.2, key parameterPolicy=strict): nothing a path cannot honour is dropped silently.
        if (caller.policy.parameterPolicy === "strict" && !raw) {
          const bad = strictUnsupportedParams(ctx.body, format, ignoredParams(ctx.body, format, mode), isCcrMode(mode));
          if (bad.length) {
            bump("unsupported_parameter_total", { parameter: bad[0].parameter });
            fail(ctx, null, 400, "unsupported_parameter", `Unsupported parameter${bad.length > 1 ? "s" : ""}: ${bad.map((b) => `'${b.path}' (${b.reason})`).join("; ")}. This key uses the strict parameter contract; remove the parameter or ask for parameterPolicy=warn.`, "invalid_request_error");
            return;
          }
        }
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
          // Not an upstream auth verdict (C): the stored credential cannot be decrypted, or its organisation is not the
          // conversation's. Skip the account for this request and alert; its status is the operator's call.
          alertCredentialProblem(ctx, account, err);
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
              // Canonical worker (spec WP2) + telemetry evidence gate (spec WP6 / §6.4): a native-required key opens a
              // canonical session only on an account whose evidence for the node's profile is real or secondary.
              const canonicalWorker = caller.policy.workerMode === "canonical" && featureFor("worker_canonical", { groupId: caller.groupId, accountId: account.id });
              if (canonicalWorker && caller.policy.telemetryPolicy === "native-required" && featureFor("telemetry_evidence_required", { groupId: caller.groupId, accountId: account.id })) {
                const ev = telemetryEvidenceLevel(account.id, `cc-${CC_VERSION}-restricted`);
                if (ev.level === "unknown") {
                  bump("native_telemetry_unverified_total", { account: account.id });
                  console.warn(`[proxy] ${ctx.requestId} account ${account.name}: telemetry evidence unknown for ${ev.profileId} (${ev.basis}); not opening a canonical session`);
                  telemetryUnverified = true;
                  break;
                }
              }
              const workerInput = {
                account,
                cred,
                body: ccrReq,
                callerAsksForCaching,
                callerCacheTier,
                clientModel: model,
                upstreamModel,
                stream: ctx.stream,
                requestId: ctx.requestId,
                stickyKey: sKey,
                isolation,
                signal: ctx.abort.signal,
                groupId: caller.groupId,
                apiKeyId: caller.apiKeyId,
                userId: caller.userId,
                facts: ctx.turnFacts,
                // X-69: the retry of a request whose client left must find the account that still runs its turn.
                onParked: () => rememberSticky(sKey, account.id),
              };
              const thirdPartyPrompt = thirdPartyPromptKey(ccrReq);
              const thirdPartyEnabled = canonicalWorker && !!thirdPartyPrompt && featureFor("canonical_third_party_fallback", { groupId: caller.groupId, accountId: account.id });
              const thirdPartyRemembered = thirdPartyEnabled && loadTuiThirdPartyRefusal(thirdPartyPrompt) !== undefined;
              const canonicalAttempt = canonicalWorker && !thirdPartyRemembered;
              ctx.tuiThirdParty = { promptKey: thirdPartyPrompt, enabled: thirdPartyEnabled, canonicalAttempt };
              if (thirdPartyRemembered) {
                bump("ccr_tui_third_party_fallback_total", { from: "memory" });
                console.log(`[proxy] ${ctx.requestId} system ${thirdPartyPrompt.slice(0, 12)} was refused on canonical/TUI within 12h: starting on legacy -p`);
              }
              let lostRerun = false;
              for (;;) {
              try {
                // Canonical worker (spec WP2): the key's effective workerMode (override ?? judge ?? legacy) AND the
                // three-state master switch for this key group / account (铁律 2).
                res = await runCcrWorker({ ...workerInput, canonical: canonicalAttempt });
                if (res && canonicalAttempt && thirdPartyEnabled) {
                  const inspected = await inspectThirdPartyResponse(res, ctx.stream);
                  if (inspected.refused) {
                    rememberTuiThirdParty(ctx, "retry");
                    bump("ccr_tui_third_party_fallback_total", { from: "refusal" });
                    res = await runCcrWorker({ ...workerInput, canonical: false });
                  } else {
                    res = inspected.response;
                  }
                }
                break;
              } catch (err) {
                // session_lost rerun (2026-11-10): the node holds no live process for this continue / tool_result (process
                // gone, parked tool round abandoned by the client, turn counters apart). runCcrWorker dropped the
                // conversation memory; the same turn runs once more as a fresh open, where 方案 A renders the whole
                // conversation into a new native session — the client gets its answer instead of a 502.
                if (canonicalWorker && err instanceof TunnelRequestError && err.nodeCode === "session_lost" && !lostRerun) {
                  lostRerun = true;
                  bump("canonical_session_lost_rerun_total");
                  console.log(`[proxy] ${ctx.requestId} no live canonical session for this turn on ${account.name}: rerunning it as a fresh open`);
                  continue;
                }
                // Canonical fallback (2026-11-05): canonicalTurn refuses before any node session is opened, so the same
                // account can serve this turn on the legacy worker. The 2.1.312 probe showed a tool round cannot be cold-
                // imported into a new native session (the binary marks the pending tool_use interrupted), so hand it over.
                if (canonicalWorker && err instanceof TunnelRequestError && CANONICAL_FALLBACK_CODES.has(err.nodeCode)) {
                  // legacy 退场 (2026-11-09): settings canonical_no_legacy_fallback — for the canary group (TUI stability test)
                  // or site-wide, the refusal reaches the client as it is instead of a silent legacy -p run.
                  if (featureFor("canonical_no_legacy_fallback", { groupId: caller.groupId, accountId: account.id })) {
                    bump("canonical_fallback_suppressed_total", { code: err.nodeCode });
                    console.log(`[proxy] ${ctx.requestId} canonical cannot carry this turn (${err.nodeCode}) on ${account.name}: legacy fallback is off for this group, refusing`);
                    throw err;
                  }
                  bump("canonical_fallback_legacy_total", { code: err.nodeCode });
                  console.log(`[proxy] ${ctx.requestId} canonical cannot carry this turn (${err.nodeCode}) on ${account.name}: legacy worker takes it`);
                  if (ctx.tuiThirdParty) ctx.tuiThirdParty.canonicalAttempt = false;
                  res = await runCcrWorker({ ...workerInput, canonical: false });
                  break;
                } else throw err;
              }
              }
              if (!res) break; // no worker-capable node accepted: infra state, try next account without counting
            } else {
              res = await runCcr({
                account,
                cred,
                body: ccrReq,
                callerAsksForCaching,
                callerCacheTier,
                clientModel: model,
                upstreamModel,
                stream: ctx.stream,
                requestId: ctx.requestId,
                clientHeaders: upstreamHeaders,
                stickyKey: ccrPoolKey ? `s:${caller.apiKeyId}:${ccrPoolKey}` : null,
                isolation,
                signal: ctx.abort.signal,
                facts: ctx.turnFacts,
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
                // Diagnostic (2026-11-02, mirasim billing_header outbound mismatch we could not reproduce synthetically):
                // the billing header must be at the very start of system[0] (BILLING_RE is `^`-anchored). Log the
                // inbound vs outbound system[0] head — billing header carries no secret — so the next occurrence names
                // exactly which transform moved/dropped it. Capped and scrubbed.
                const sys0Head = (b: unknown): string => {
                  try {
                    const s = (typeof b === "string" ? (JSON.parse(b) as Json) : (b as Json))?.system;
                    if (Array.isArray(s)) { const t = typeof s[0] === "string" ? s[0] : (s[0] as Json)?.text; return `arr[${s.length}] ${JSON.stringify(String(t ?? "").slice(0, 120))}`; }
                    if (typeof s === "string") return `str ${JSON.stringify(s.slice(0, 120))}`;
                    return `<${s === undefined ? "none" : typeof s}>`;
                  } catch { return "?"; }
                };
                console.error(`[cc-profile] ${ctx.requestId} key=${caller.apiKeyId} outgoing request is not genuine ${shape.profileId} → ${out.profileId ?? "unknown"} missing=${out.missing.join(",") || "-"}; IN sys0=${sys0Head(body)} OUT sys0=${sys0Head(ureq.body)}; not forwarded`);
                fail(ctx, null, 400, "cc_profile_mismatch", `The normalised request no longer matches Claude Code profile ${shape.profileId} (${out.missing.join(", ") || "profile changed"}); it was not forwarded.`, "invalid_request_error");
                return;
              }
            }
            upstreamHost = ureq.url.host;
            if (account.route === "node") {
              // Bound proxy (docs/onboarding.md §1/§6.2): all platform-side
              // requests of a bound account egress on that proxy.
              // Raw passthrough (§4a) + raw_preserve_headers (spec WP5.4, three-state): the node relays the client's headers as
              // they are instead of filling in the Claude Code fingerprint. Default 0 = today's node behaviour.
              res = await fetchViaTunnel(account.id, ureq.url, ureq.headers, ureq.body, account.bound_proxy_id ?? undefined, undefined, isolation, ctx.abort.signal, raw && featureFor("raw_preserve_headers", { groupId: caller.groupId, accountId: account.id }));
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
          ctx.retry.attempts++;
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
          if (noteFailureClass(ctx.retry, NETWORK_FAILURE_CLASS, config)) {
            // The same network failure on K consecutive accounts is not theirs: stop, cool nothing further (A).
            tripRetryCap(ctx, "same_failure", account, `class ${NETWORK_FAILURE_CLASS}`);
            fail(ctx, account, 502, "upstream_error", `Upstream request failed with the same network error on ${ctx.retry.streakCount} consecutive accounts; it was not retried further.`, "upstream_error");
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
          // The conversation moved on while this account answered (F): stop the upstream body before giving up on it.
          try { assertScope(scope); }
          catch (err) { ctx.scopeLossAccount = account; await res.body?.cancel().catch(() => {}); throw err; }
          touchAccount(account.id);
          // A 200 proves the credential is accepted: earlier direct-lane auth hits are forgotten (C).
          if (!isCcrMode(mode)) directAuthFailures.clear(account.id);
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
        ctx.retry.attempts++;
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
        // The worker's 502 is a JSON error body: classify its message, not the raw JSON, or the client-facing sentence
        // ends in the body's closing `"}}` (2026-11-12: 75 prompt_too_long rows read `Prompt is too long"}}` after X-68
        // started failing worker streams through this path).
        const reqErr = isCcrMode(mode) ? classifyCcRequestError(workerErrorText(text)) : null;
        if (reqErr?.code === "third_party_extra_usage") rememberTuiThirdParty(ctx, "started");
        if (reqErr) {
          ctx.trace.failure = { scope: "request", code: reqErr.code, message: reqErr.message, retryable: false, status: 400, credentialVersion: ctx.credentialVersion ?? undefined, executionSequence: ctx.executionSequence };
          // Context overflow / safety-classifier refusal inside Claude Code: the request is the problem.
          // 400 with Claude Code's own sentence (clients auto-compact on "prompt is too long"), no failover/cooldown.
          bump("cc_request_error_total", { code: reqErr.code });
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
        const ccr = isCcrMode(mode);
        // Worker / cloud lane (D): which part of the failure text may decide the account's fate.
        const source: FailureSource = ccr ? workerFailureSource(ctx) : "http_body";
        const failureText = ccr ? workerErrorText(text) : text;
        const signals = ccr ? workerSignals(ctx, account, failureText, source) : null;
        const authSignal = !ccr && (status === 401 || status === 403) ? directAuthSignal(status, text) : null;
        // Same failure class on K consecutive accounts (A): the failure follows the request or the upstream, not the
        // accounts. Answer with the upstream error; this account is not cooled, the organisation is not switched.
        // Failures proven to be the account's own never count and end the streak.
        const cls = accountOwnFailure(account, status, text, res.headers, ccr, failureText, authSignal) ? null : httpFailureClass(status, text, ccr ? "worker" : "direct");
        if (noteFailureClass(ctx.retry, cls, config)) {
          tripRetryCap(ctx, "same_failure", account, `class ${cls}`);
          // A direct-lane JSON error is the upstream's own answer: hand it over as it is. A proxy / WAF page, a worker
          // wrapper or a 401 / 403 (which a client would read as its own key being refused) becomes a plain 502.
          if (!ccr && upstreamErrorType(text) !== null && status !== 401 && status !== 403) passUpstreamError(ctx, account, wireModeFor(mode), status, text, res.headers.get("retry-after"));
          else fail(ctx, account, 502, "upstream_error", `Upstream request failed with the same error on ${ctx.retry.streakCount} consecutive accounts (last status ${status}); it was not retried further.`, "upstream_error");
          return;
        }
        if (PASSTHROUGH_STATUSES.has(status)) {
          // Cloud session / environment API rejected the call: the account's
          // CCR state is bad (stale environment, unsupported config), never the
          // consumer's request. Cool it and fail over; never echo the session-API body.
          markCcrFailure(ctx, account, `ccr ${status}: ${failureText.slice(0, 300)}`, source, signals ?? undefined);
          break;
        }
        // Per-model org suspension (403, time-boxed): cool that model only and let the
        // next account (another org) serve; never treat it as a dead credential.
        // The worker path wraps the same 403 text in a 502 body ("ccr_worker: Failed to authenticate. API Error:
        // 403 model: … is suspended for this organization until …"); 2026-10-29/31 that fell through to the short
        // transient cooldown and one account was re-picked four times in eight minutes (39 client 502s), so on the
        // worker path the text is parsed whatever the status.
        // Organization-level error text (spec WP7.2, iron-rules 附 组织级熔断): stop scheduling the whole organization
        // now, alert, no retry / re-auth; this request moves on to another organization's account.
        // On the worker lane only trusted text may do either (D): a quote of the screen needs the threshold first.
        const orgCode = orgLevelErrorCode(signals ? signals.text("org") : text);
        if (orgCode) {
          const teamId = accountTeamId(account);
          ctx.trace.failure = { scope: "account", code: `org_${orgCode}`, message: upstreamMessage(text), retryable: false, status, credentialVersion: ctx.credentialVersion ?? undefined, executionSequence: ctx.executionSequence };
          if (teamId) {
            const first = suspendTeam(teamId, orgCode, upstreamMessage(text));
            bump("team_suspended_total", { code: orgCode });
            if (first) console.error(`[ALERT][org] ${ctx.requestId} organization ${teamId} suspended: ${orgCode} on account ${account.name} (upstream ${status}): ${upstreamMessage(text).slice(0, 200)} — operator action required (PATCH /api/admin/teams/${teamId} status=active)`);
          }
          markFailure(account.id, { kind: "transient", message: `organization-level ${orgCode}`, cooldownMs: 3_600_000 });
          break;
        }
        const suspended = status === 403 || ccr ? parseModelSuspension(signals ? signals.text("model_suspended") : text) : null;
        if (suspended) {
          ctx.trace.failure = { scope: "account_model", code: "upstream_model_suspended", message: upstreamMessage(text), retryable: true, status: 403, credentialVersion: ctx.credentialVersion ?? undefined, executionSequence: ctx.executionSequence, resetAt: suspended.until };
          markFailure(account.id, { kind: "model_suspended", model: suspended.model, until: suspended.until });
          console.warn(`[proxy] ${ctx.requestId} account ${account.name}: model ${suspended.model} suspended for its organization until ${suspended.until} → model cooldown, trying next account`);
          break;
        }
        // 401 / 403 (C). Direct lane: the body decides. Only an authentication verdict (`authentication_error`, a clear
        // OAuth-invalid message) concerns the account; a proxy / WAF page, `permission_error` or an unknown shape fails
        // this attempt only. Cloud / worker lane 401 / 403 bodies are our own wrappers (credential without a token …):
        // an auth verdict as before, under the same threshold.
        const authVerdict = (status === 401 || status === 403) && (ccr || authSignal === "auth");
        if (authVerdict && !refreshed && canRefresh(account)) {
          refreshed = true;
          continue; // retry once with a forced token refresh
        }
        if (authVerdict) {
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
            // `status = 'error'` needs N verdicts of this account inside the window (default 3 / 10 min); below that
            // the account only cools, so one stray 401 (refresh race, upstream hiccup) no longer retires it.
            const hit = directAuthFailures.record(account.id);
            if (hit.escalate) {
              markFailure(account.id, { kind: "auth", message: `auth failure ×${hit.count}: ${authText}` });
              console.error(`[proxy] ${ctx.requestId} account ${account.name}: upstream ${status} auth failure ×${hit.count} within ${Math.round(config.authFailureWindowMs / 60_000)} min → status error`);
            } else {
              markFailure(account.id, { kind: "transient", message: `auth failure ×${hit.count} of ${config.authFailureThreshold}: ${authText}`, cooldownMs: config.directAuthCooldownMs });
              console.warn(`[proxy] ${ctx.requestId} account ${account.name}: upstream ${status} auth failure ×${hit.count} of ${config.authFailureThreshold} → cooldown ${Math.round(config.directAuthCooldownMs / 1000)}s, status unchanged`);
            }
          }
        } else if (status === 401 || status === 403) {
          ctx.trace.failure = { ...ctx.trace.failure!, scope: "transport", retryable: true };
          bump("upstream_forbidden_transient_total", { status, shape: upstreamErrorType(text) ?? "non_json" });
          markFailure(account.id, { kind: "transient", message: `upstream ${status} without an auth verdict (${upstreamErrorType(text) ?? "non-JSON body"})` });
          console.warn(`[proxy] ${ctx.requestId} account ${account.name}: upstream ${status} is not an authentication verdict (${upstreamErrorType(text) ?? "non-JSON body: proxy / WAF?"}) → this attempt only, no refresh, status unchanged`);
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

  if (!busy.length || requestError || ctx.clientGone || ctx.retry.tripped) break;
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
  // A tripped retry cap ends the request here (A): the next organisation would only inherit the same failure —
  // and the switch itself resets the conversation, so it is not made when no attempt could follow it.
  if (scope?.row.team_id && !toolRound && !requestError && !ctx.clientGone && !ccrUnsupported && !ctx.retry.tripped && attempts > 0) {
    const capped = capBeforeAttempt(ctx.retry, ctx.startedAt, Date.now(), config);
    if (capped) tripRetryCap(ctx, capped, lastAccount, `last status ${lastStatus || "network"}, before an organisation switch`);
  }
  if (scope?.row.team_id && !toolRound && !requestError && !ctx.clientGone && !ccrUnsupported && !ctx.retry.tripped) {
    const next = listCandidates(caller.groupId, model).find((a) => accountTeamId(a) && !scope.triedTeams.has(accountTeamId(a)!) && modeFor(format, a, ccClient) !== null);
    if (next) {
      // Heartbeats may have committed HTTP headers, but no model output was delivered.
      // Reuse the existing response state rather than opening a second SSE response.
      await switchTeam(scope, accountTeamId(next)!, format, "team_pool_exhausted", caller.policy.historyPolicy === "passthrough");
      return proxyRequest(req, reply, format, endpoint, caller, scope);
    }
  }

  if (requestError) {
    const tooLarge = requestError.nodeCode === "spec_too_large";
    // Canonical worker refusals (spec WP2/WP3) keep their own code: the client can route the turn elsewhere.
    const canonicalCode = requestError.nodeCode === "history_import_unsupported" ? 409 : requestError.nodeCode === "canonical_requires_persistent_session" ? 400 : null;
    // Node-side codes (spec_too_large, bad_spec …) name the node; platform-side ones (console_*, empty_prompt, canonical) carry their own text.
    const fromNode = !requestError.nodeCode.startsWith("console_") && requestError.nodeCode !== "empty_prompt" && canonicalCode === null;
    fail(
      ctx,
      lastAccount,
      tooLarge ? 413 : canonicalCode ?? 400,
      tooLarge ? "request_too_large" : canonicalCode ? requestError.nodeCode : "invalid_request",
      tooLarge ? `Request body is too large for the node egress path (${requestError.message}); Anthropic's own limit is 32 MB.` : fromNode ? `The node rejected the request: ${requestError.message}` : requestError.message,
      "invalid_request_error",
    );
  } else if (lastStatus === 429) {
    fail(ctx, lastAccount, 429, "upstream_rate_limited", "All upstream accounts are rate limited. Retry later.", "rate_limit_error");
  } else if (toolRound && scope?.row.team_id && attempts > 0 && !ctx.clientGone) {
    // Every account of the organization failed this tool round; it is not moved elsewhere (see above).
    failTeamCapacity(ctx, lastAccount);
  } else if (ctx.retry.tripped && ctx.retry.attempts > 0) {
    // Ended by a retry cap, possibly in an organisation where nothing was tried any more: it is still an upstream failure.
    fail(ctx, lastAccount, 502, "upstream_error", `Upstream request failed (last status ${lastStatus || ctx.trace.upstreamStatus || "network"}); stopped after ${ctx.retry.attempts} attempt(s).`, "upstream_error");
  } else if (attempts === 0 && telemetryUnverified) {
    fail(ctx, null, 503, "native_telemetry_unverified", "No subscription account with verified native telemetry evidence is available for this key's canonical worker (spec §6.4: evidence must be real or secondary). Retry later or ask the operator.", "upstream_error");
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
/** Direct-lane 401 / 403 authentication verdicts per account (C): N inside the window before `status = 'error'`. */
const directAuthFailures = new AuthFailureTracker(config.authFailureThreshold, config.authFailureWindowMs);
/** Worker-lane verdicts seen only through a quote of process output, per account × kind (D): same threshold. */
const quotedSignals = new AuthFailureTracker(config.authFailureThreshold, config.authFailureWindowMs);
/** Tests only: forget every auth-failure count. */
export function resetAuthFailureTrackersForTests(): void {
  for (const t of [authFailures, directAuthFailures, quotedSignals]) t.reset();
}

/** One counter + one log line when a retry cap ends a request (A). */
function tripRetryCap(ctx: Ctx, reason: CapReason, account: AccountRow | null, detail: string): void {
  if (ctx.retry.tripped) return;
  ctx.retry.tripped = reason;
  bump("retry_cap_tripped_total", { reason });
  const limit = reason === "attempt_cap" ? `max ${config.maxTotalAttempts} attempts` : reason === "deadline" ? `deadline ${config.retryDeadlineMs} ms` : `same failure on ${config.sameFailureStreak} consecutive accounts`;
  console.warn(`[retry-cap] ${ctx.requestId} ${reason} (${limit}): ${ctx.retry.attempts} attempt(s) in ${Date.now() - ctx.startedAt} ms across ${ctx.scope ? ctx.scope.triedTeams.size : 0} organisation(s), ${detail}, last account ${account?.name ?? "-"}; no further account is tried or cooled, no organisation switch`);
}

const credentialAlerts = new Map<string, number>();
/** The stored credential is unusable for this request (C): alert (at most once per account and 10 min), status untouched. */
function alertCredentialProblem(ctx: Ctx, account: AccountRow, err: unknown): void {
  const reason = credentialProblem(err);
  bump("credential_unusable_total", { reason });
  const now = Date.now();
  if (now - (credentialAlerts.get(account.id) ?? 0) < 600_000) return;
  if (credentialAlerts.size > 5_000) credentialAlerts.clear();
  credentialAlerts.set(account.id, now);
  console.error(`[ALERT][credential] ${ctx.requestId} account ${account.name} (${account.id}) skipped for this request: ${reason === "org_mismatch" ? "its credential's organisation is not the conversation's" : "its stored credential cannot be read"} (${(err as Error)?.message ?? err}) — data problem, account status unchanged; operator action required`);
}

/** Provenance the executor recorded for this attempt's failure text; unknown = a process quote (the cautious tier). */
function workerFailureSource(ctx: Ctx): FailureSource {
  const facts: TurnFacts = ctx.turnFacts;
  return facts.failure?.source ?? "process";
}

/** The message inside an executor error body (`{type:"error",error:{message}}`), unescaped; the raw text otherwise. */
function workerErrorText(body: string): string {
  try {
    const j = JSON.parse(body) as Json;
    const m = j?.error?.message ?? j?.message;
    return typeof m === "string" && m ? m : body;
  } catch {
    return body;
  }
}

interface WorkerSignals {
  decide(kind: DisposalKind): SignalDecision;
  /** The text a parser for `kind` may read ("" when the signal is not allowed to act now). */
  text(kind: DisposalKind): string;
}

/**
 * Worker / cloud lane (D): per verdict kind, may this failure text act on the account? Trusted text (Claude Code's
 * structured result, an upstream HTTP body, the shim's own cause head) acts at once. A quote of the screen / stderr
 * or model text acts only after the threshold, and never when the customer's own request carries the same signal.
 */
function workerSignals(ctx: Ctx, account: AccountRow, message: string, source: FailureSource): WorkerSignals {
  const evidence = workerFailureEvidence(message, source);
  const decide = failureSignals(
    evidence,
    () => requestEchoText(ctx.req.body),
    (kind) => quotedSignals.record(`${account.id}:${kind}`).escalate,
  );
  const logged = new Set<DisposalKind>();
  const decideLogged = (kind: DisposalKind): SignalDecision => {
    const d = decide(kind);
    if (d.basis !== "trusted" && d.basis !== "none" && !logged.has(kind)) {
      logged.add(kind);
      bump("worker_quoted_signal_total", { kind, basis: d.basis });
      const what = d.basis === "prompt_echo" ? "also present in the customer's own request → ignored" : d.basis === "quote_pending" ? `seen only in a process-output quote, ×${quotedSignals.count(`${account.id}:${kind}`)} of ${config.authFailureThreshold} → not acted on yet` : kind === "auth" ? "seen only in a process-output quote → counted as one auth failure (threshold applies)" : `seen only in a process-output quote, threshold ${config.authFailureThreshold} reached → acted on`;
      console.warn(`[proxy] ${ctx.requestId} account ${account.name}: '${kind}' signal (source ${source}) ${what}`);
    }
    return d;
  };
  return { decide: decideLogged, text: (kind) => signalText(evidence, decideLogged(kind)) };
}

/**
 * Is this failed attempt proven to be the account's own problem (dead credential, payment, rejected usage window,
 * organisation / model suspension)? Such failures never feed the same-failure streak (A).
 */
function accountOwnFailure(account: AccountRow, status: number, text: string, headers: Headers, ccr: boolean, failureText: string, authSignal: ReturnType<typeof directAuthSignal> | null): boolean {
  if (status === 402) return true;
  if ((status === 401 || status === 403) && (ccr || authSignal === "auth")) return true;
  if (ccr) return disposalKinds(failureText).size > 0;
  if (orgLevelErrorCode(text) || (status === 403 && parseModelSuspension(text))) return true;
  if (status === 429) {
    const snap = hasSubscriptionWindow(account) ? parseUnifiedRateLimitHeaders(headers) : null;
    const now = nowIso();
    const rej = rejectedWindow(snap, now);
    if (rej || fableRejectedWindow(snap, now) || isCreditsRequired(text)) return true;
    return classifyDirectRateLimit(text, false).scope === "account_model";
  }
  return false;
}

function markCcrFailure(ctx: Ctx, account: AccountRow, message: string, source: FailureSource = "process", signals: WorkerSignals = workerSignals(ctx, account, message, source)): void {
  // Organization-level error text on the worker path (spec WP7.2): same breaker as the direct path.
  const orgCode = orgLevelErrorCode(signals.text("org"));
  if (orgCode) {
    const teamId = accountTeamId(account);
    if (teamId && suspendTeam(teamId, orgCode, message.slice(0, 300))) console.error(`[ALERT][org] ${ctx.requestId} organization ${teamId} suspended: ${orgCode} on account ${account.name} (worker): ${message.slice(0, 200)} — operator action required`);
    bump("team_suspended_total", { code: orgCode });
    markFailure(account.id, { kind: "transient", message: `organization-level ${orgCode}`, cooldownMs: 3_600_000 });
    return;
  }
  const limit = ccLimitReset(signals.text("limit"));
  if (limit) {
    markFailure(account.id, { kind: "window_exhausted", resetAt: limit.resetAt, window: limit.window });
    console.warn(`[proxy] ${ctx.requestId} account ${account.name}: cc ${limit.window} limit → window_exhausted until ${limit.resetAt ?? "(fallback 1h)"}`);
    return;
  }
  const suspended = parseModelSuspension(signals.text("model_suspended"));
  if (suspended) {
    markFailure(account.id, { kind: "model_suspended", model: suspended.model, until: suspended.until });
    console.warn(`[proxy] ${ctx.requestId} account ${account.name}: model ${suspended.model} suspended for its organization until ${suspended.until} → model cooldown`);
    return;
  }
  // Request-level texts only ever spare the account, so they are read from the whole message.
  const reqErr = classifyCcRequestError(message);
  if (isCcModelUnavailable(message) || reqErr) {
    console.warn(`[proxy] ${ctx.requestId} account ${account.name}: ${reqErr ? reqErr.code : "model unavailable"} on Claude Code — request problem, account not cooled`);
    return;
  }
  if (isCcAccountOnHold(signals.text("on_hold"))) {
    // Account put on hold by Anthropic (claude.ai/restricted): unusable at once, no threshold (user rule 2026-10-20) —
    // when Claude Code itself says so. Words that only stand in a quote of the screen wait for the threshold (D).
    markFailure(account.id, { kind: "auth", message: `account on hold: ${message.slice(0, 400)}` });
    console.error(`[proxy] ${ctx.requestId} account ${account.name}: account on hold (${signals.decide("on_hold").basis}) → status error (${message.slice(0, 160)})`);
    return;
  }
  if (isCcAuthFailure(signals.text("auth"))) {
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

/** Tests only: the worker-lane disposal exactly as a failed attempt runs it, for a request with this body. */
export function markWorkerFailureForTests(account: AccountRow, message: string, source: FailureSource | undefined, requestBody: unknown): void {
  markCcrFailure({ requestId: "test", req: { body: requestBody } } as unknown as Ctx, account, message, source ?? "process");
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
      upstreamRetries: ctx.turnFacts.upstreamRetries ?? null,
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
const WORKER_IGNORED_RESPONSES = ["temperature", "top_p", "reasoning", "truncation", "parallel_tool_calls", "service_tier", "user", "metadata", "include", "prompt_cache_key", "safety_identifier"];
const CONVERT_IGNORED_RESPONSES = ["reasoning", "truncation", "parallel_tool_calls", "service_tier", "user", "metadata", "include", "prompt_cache_key", "safety_identifier"];
const WORKER_IGNORED_CHAT = ["temperature", "top_p", "n", "logprobs", "top_logprobs", "seed", "presence_penalty", "frequency_penalty", "logit_bias", "service_tier", "response_format", "parallel_tool_calls", "reasoning_effort", "prediction", "web_search_options"];
const CONVERT_IGNORED_CHAT = ["n", "logprobs", "top_logprobs", "seed", "presence_penalty", "frequency_penalty", "logit_bias", "service_tier", "response_format", "parallel_tool_calls", "reasoning_effort", "prediction", "web_search_options"];
const CONVERT_IGNORED_ANTHROPIC = ["top_k", "thinking", "context_management", "service_tier", "mcp_servers", "container"];
export function ignoredParams(body: Json, format: ClientFormat, mode: Mode): string[] {
  let names: string[];
  if (isCcrMode(mode)) names = format === "anthropic" ? WORKER_IGNORED_ANTHROPIC : format === "responses" ? WORKER_IGNORED_RESPONSES : WORKER_IGNORED_CHAT;
  else if (mode === "chat-via-anthropic") names = CONVERT_IGNORED_CHAT;
  else if (mode === "responses-via-anthropic") names = CONVERT_IGNORED_RESPONSES;
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
  /** The stream stopped before its terminal event: bill max(reported, what was forwarded) and flag it estimated (E). */
  partial = false,
): void {
  try {
    acc.observeRequest(ctx.body);
    const { usage, estimated } = acc.finalize(ctx.body, { partial });
    if (partial) console.warn(`[billing] ${ctx.requestId} partial stream settled on ${account.name}: output_tokens=${usage.output_tokens}${estimated ? " (estimated from the forwarded text; the upstream's final count never arrived)" : " (as reported)"}`);
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
      upstreamRetries: ctx.turnFacts.upstreamRetries ?? null,
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
  if (mode === "passthrough-anthropic" || mode === "chat-via-anthropic" || mode === "responses-via-anthropic") return "anthropic";
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
    else if (mode === "responses-via-anthropic") transformed = anthropicMessageToResponses(json, ctx.model, ctx.body);
    else if (mode === "anthropic-via-chat") transformed = openaiChatToAnthropicMessage(json, ctx.model);
    else if (upstreamModel !== ctx.model && typeof json.model === "string") transformed = { ...json, model: ctx.model };
    if (transformed !== json) out = Buffer.from(JSON.stringify(transformed), "utf8");
  } catch {
    /* non-JSON body: pass through untouched */
  }
  // The whole body is already read here (nothing left to cancel); name the account for the failure row (F).
  try { assertScope(ctx.scope); }
  catch (err) { ctx.scopeLossAccount = account; throw err; }
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

/** How long a client may leave the socket's buffer full before its stream is given up (env CLIENT_WRITE_STALL_MS, default 30 s). */
const CLIENT_WRITE_STALL_MS = (() => { const n = Number(process.env.CLIENT_WRITE_STALL_MS); return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 30_000; })();

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
  let wantProof = !!teeProofRequested(ctx.req);
  let firstTokenMs: number | null = null;
  let clientGone = ctx.clientGone;
  /** Upstream signalled failure inside the 200 stream (Anthropic `error` event, OpenAI `{error}` chunk, CCR executor error). */
  let streamError: string | null = null;
  /** The upstream stream reached its normal terminator (message_stop / [DONE] / response.completed). */
  let completed = false;
  /** The request's scheduling lease was lost while the client was still there (not an upstream error). */
  let leaseLost = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const onGone = () => {
    if (ctx.clientGone || reply.raw.destroyed) clientGone = true;
    else leaseLost = true;
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
      if (proofBytes > 8_388_608) throw new LocalStreamError("gateway", "proof response exceeds 8 MiB");
      forwarded.push(b);
    }
    if (!reply.raw.write(b)) {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); reply.raw.off("drain", ready); reply.raw.off("close", closed); ctx.abort.signal.removeEventListener("abort", closed); };
        const ready = () => { cleanup(); resolve(); };
        const closed = () => { cleanup(); reject(ctx.abort.signal.aborted && !ctx.clientGone && !reply.raw.destroyed ? new Error("request scheduling lease lost") : new LocalStreamError("client", "client closed during backpressure")); };
        const timer = setTimeout(() => { cleanup(); reject(new LocalStreamError("client", `client write stalled for ${Math.round(CLIENT_WRITE_STALL_MS / 1000)}s`)); }, CLIENT_WRITE_STALL_MS);
        reply.raw.once("drain", ready); reply.raw.once("close", closed); ctx.abort.signal.addEventListener("abort", closed, { once: true });
        if (ctx.abort.signal.aborted || reply.raw.destroyed) closed();
      });
    }
  };

  const clientWantsUsage = ctx.body.stream_options?.include_usage === true;
  const toOpenai = mode === "chat-via-anthropic" ? new AnthropicToOpenaiStream(ctx.model, clientWantsUsage) : null;
  const toResponses = mode === "responses-via-anthropic" ? new AnthropicToResponsesStream(ctx.model, ctx.body) : null;
  const toAnthropic = mode === "anthropic-via-chat" ? new OpenaiToAnthropicStream(ctx.model) : null;
  const rewriteModel = upstreamModel !== ctx.model;

  /**
   * An upstream-signalled error. Recorded only while the client is still there: once it has left, the executor's own
   * "aborted" error event is the echo of our cancel, not an upstream failure, and nothing is forwarded any more.
   */
  const upstreamFailed = (message: string): void => { if (!clientGone) streamError = message; };
  const handle = async (ev: SseEvent): Promise<void> => {
    if (!ev.data) {
      if (!toOpenai && !toAnthropic && !toResponses) await write(`${ev.raw}\n\n`);
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
      case "chat-via-anthropic":
      case "responses-via-anthropic": {
        if (j) {
          if (j.type === "message_start") {
            acc.observeModel(j.message?.model);
            acc.addAnthropic(j.message?.usage);
          } else if (j.type === "message_delta") acc.addAnthropic(j.usage);
          else if (j.type === "content_block_start") acc.addAnthropicContent([j.content_block]);
          else if (j.type === "content_block_delta") acc.addText(j.delta?.text ?? j.delta?.partial_json ?? j.delta?.thinking);
          else if (j.type === "message_stop") completed = true;
          else if (j.type === "error" || ev.event === "error") upstreamFailed(String(j.error?.message ?? j.message ?? "upstream error"));
        }
        if (toOpenai) {
          if (j) for (const s of toOpenai.push(j)) await write(s);
        } else if (toResponses) {
          if (j) for (const s of toResponses.push(j)) await write(s);
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
          if (j.error && !(Array.isArray(j.choices) && j.choices.length)) upstreamFailed(String(j.error?.message ?? j.error ?? "upstream error"));
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
            if (!completed) upstreamFailed(`upstream response ended with status ${j.response.status}`);
          }
          if (j.type === "response.incomplete" || j.type === "response.cancelled") upstreamFailed("upstream response was incomplete");
          if (j.type === "response.output_text.delta") acc.addText(j.delta);
          if (j.type === "error" || j.type === "response.failed") upstreamFailed(String(j.error?.message ?? j.response?.error?.message ?? "upstream error"));
        }
        await write(`${ev.raw}\n\n`);
        break;
      }
    }
  };

  let readError: string | null = null;
  /** The stream was stopped by the client's behaviour or by a gateway limit — not by the upstream. */
  let localFault: LocalStreamError | null = null;
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
        if (Buffer.byteLength(chunk) > 2_097_152) throw new LocalStreamError("gateway", "upstream SSE event exceeds 2 MiB");
        if (chunk.trim()) await handle(parseSseEvent(chunk));
      }
      if (Buffer.byteLength(pending) > 2_097_152) throw new LocalStreamError("gateway", "upstream SSE event exceeds 2 MiB");
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
    if (err instanceof LocalStreamError) {
      localFault = err;
      // A client that stopped reading is treated as gone from here on: nothing more is written to it.
      if (err.fault === "client") clientGone = true;
      // No proof will be issued for a stream the gateway cut: stop accounting for it, so the closing error event gets out.
      else wantProof = false;
    } else readError = (err as Error).message;
    console.error(`[proxy] ${ctx.requestId} stream error:`, (err as Error).message);
  } finally {
    done();
    stopEarlyKeepalive(ctx);
    ctx.abort.signal.removeEventListener("abort", onGone);
    // Whatever ended the stream, the upstream body is not left open: a worker stream's cancel stops the remote
    // process, a direct one frees the socket (E — the local-fault paths used to leave the reader uncancelled).
    void reader?.cancel().catch(() => {});
    // The settlement table (stream-settlement.ts): one decision from the facts, then act on it.
    const decision = decideStreamSettlement({
      completed,
      clientGone,
      upstreamError: streamError !== null,
      readError: readError !== null,
      localFault: localFault?.fault ?? null,
      leaseLost: leaseLost || (ctx.abort.signal.aborted && !clientGone && localFault?.fault !== "client"),
      firstByteSent: firstTokenMs !== null,
    });
    const errorEvent = (text: string, type: string): string => ctx.format === "anthropic"
      ? `event: error\ndata: ${JSON.stringify({ type: "error", error: { type, message: text } })}\n\n`
      : `data: ${JSON.stringify({ error: { message: text, type, param: null, code: null } })}\n\n`;
    const settle = async (partial: boolean): Promise<boolean> => {
      // Settle before ending the response so a client that sees the stream
      // finish can immediately observe the charge. (144faa3 put the completed
      // case in its own branch above this call: completed streams went unbilled
      // for ~10 h on 2026-10-17 — see docs/issues-and-decisions.md.)
      try { settleSuccess(ctx, account, upstreamModel, acc, firstTokenMs, ccrExecuted, partial); return true; }
      catch { await write(ctx.format === "anthropic" ? `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: "Settlement recording unavailable; contact the administrator before retrying." } })}\n\n` : `data: ${JSON.stringify({ error: { message: "Settlement recording unavailable; contact the administrator before retrying.", code: "settlement_unavailable" } })}\n\n`).catch(() => {}); return false; }
    };
    switch (decision.outcome) {
      case "client_unserved":
        // Nothing ever reached the client: not a served request (the upstream work was cancelled above).
        console.warn(`[proxy] ${ctx.requestId} account ${account.name}: client closed before the first byte; not billed`);
        logFailure(ctx, account, 499, "client_closed", "Client closed the connection before the first byte");
        break;
      case "success":
        // A stream that reached its terminator is proof the account's credentials work.
        authFailures.clear(account.id);
        await settle(false);
        break;
      case "partial": {
        // Cut short by the client (gone, or not reading) or by one of the gateway's own limits: what was produced is
        // billed — at least the forwarded text and thinking — and the account, which did nothing wrong, is not cooled.
        const why = localFault ? localFault.message : "client closed the connection";
        console.warn(`[proxy] ${ctx.requestId} account ${account.name}: stream cut short (${why}); settling what was produced, account not cooled`);
        bump("stream_partial_settled_total", { cause: localFault ? localFault.fault : "client_closed" });
        ctx.streamTruncated = true;
        await settle(true);
        if (localFault?.fault === "gateway") await write(errorEvent(`gateway: ${localFault.message}`, "api_error")).catch(() => {});
        break;
      }
      case "gateway_unserved": {
        const message = localFault?.message ?? "gateway stream limit";
        console.warn(`[proxy] ${ctx.requestId} account ${account.name}: ${message} before anything was forwarded; not billed, account not cooled`);
        bump("stream_gateway_limit_total");
        ctx.streamTruncated = true;
        ctx.trace.failure = { scope: "request", code: "gateway_stream_limit", message, retryable: false, status: 502, credentialVersion: ctx.credentialVersion ?? undefined, executionSequence: ctx.executionSequence };
        logFailure(ctx, account, 502, "gateway_stream_limit", `Stream stopped by a gateway limit: ${message}`);
        await write(errorEvent(`gateway: ${message}`, "api_error")).catch(() => {});
        break;
      }
      case "lease_lost": {
        const message = "request scheduling lease lost";
        console.warn(`[proxy] ${ctx.requestId} account ${account.name}: stream failed: ${message}`);
        ctx.streamTruncated = true;
        ctx.trace.failure = { scope: "transport", code: "scheduling_lease_lost", message, retryable: true, status: 503, credentialVersion: ctx.credentialVersion ?? undefined, executionSequence: ctx.executionSequence };
        logFailure(ctx, account, 503, "scheduling_lease_lost", message);
        break;
      }
      case "upstream_failure": {
        // A stream that failed before reaching its terminator is not a served
        // request: no charge, a failure row, a short cooldown.
        const message = streamError ?? readError ?? "upstream stream ended without a terminator";
        console.warn(`[proxy] ${ctx.requestId} account ${account.name}: stream failed: ${message}`);
        // Claude Code's context overflow / safety refusal is the request's fault: log it as such and hand
        // the client Claude Code's own sentence (the auto-compact trigger) as an invalid_request_error.
        // `mode` here is the wire mode (passthrough-anthropic for a worker stream too): the CCR flag is ccrExecuted.
        const reqErr = ccrExecuted || isCcrMode(mode) ? classifyCcRequestError(message) : null;
        if (reqErr?.code === "third_party_extra_usage") rememberTuiThirdParty(ctx, "started");
        // A request-level refusal is not the account's fault: no cooldown (2026-11-08: 162 streamed safeguards refusals of one
        // key in three days each cooled the account that answered them). Raw relay (§4a): no cooldown either.
        // Worker / cloud stream: the provenance the executor recorded decides what the text may do (D). A direct-lane
        // `error` event is the upstream's own structured answer.
        if (reqErr) bump("cc_request_error_total", { code: reqErr.code });
        if (decision.coolAccount && !reqErr && account.raw_passthrough !== 1) markCcrFailure(ctx, account, `stream: ${message.slice(0, 300)}`, ccrExecuted ? workerFailureSource(ctx) : "http_body");
        ctx.streamTruncated = true;
        ctx.trace.failure = {
          scope: reqErr ? "request" : "transport",
          code: reqErr?.code ?? "upstream_stream_error",
          message,
          retryable: !reqErr,
          status: reqErr ? 400 : 502,
          credentialVersion: ctx.credentialVersion ?? undefined,
          executionSequence: ctx.executionSequence,
        };
        if (reqErr) logFailure(ctx, account, 400, reqErr.code, reqErr.message);
        else logFailure(ctx, account, 502, "upstream_stream_error", `Stream failed before its terminator: ${message.slice(0, 300)}`);
        if (readError !== null || (!streamError && !completed) || reqErr) {
          // Nothing upstream-shaped was forwarded for this failure: tell the client in its dialect.
          await write(errorEvent(reqErr ? reqErr.message : `upstream: ${message}`, reqErr ? "invalid_request_error" : "api_error")).catch(() => {});
        }
        break;
      }
    }
    // A client that stopped reading is still connected: end() would wait on it forever, so its socket is closed.
    if (localFault?.fault === "client" && !reply.raw.destroyed) reply.raw.destroy();
    else if (!clientGone) reply.raw.end();
  }
}
