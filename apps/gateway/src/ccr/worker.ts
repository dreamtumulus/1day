// CCR worker mode (docs/ccr-supply.md §8.1): the provider node runs the real
// Claude Code binary (`claude -p --output-format stream-json`); its stdout
// line-JSON family (system/assistant/stream_event/result) is the same shape
// the cloud session translator consumes, so the response side is the shared
// SessionTranslator and the request side is the shared messagesToPrompt
// folding (including the ```tool_call prompt-level tool protocol).
//
// Failure semantics mirror fetchViaTunnel: null return = infrastructure (no
// worker-capable node / no_proxy_available / worker_overloaded) — the
// candidate loop tries the next account without counting a failure.

import { getSetting, sha256Hex, type AccountRow, type Credential, deleteTurnMemory, loadTurnMemory, saveTurnMemory, featureFor, CC_VERSION, recordRateLimitEvent } from "@1dayapi/core";
import { StreamDemand } from "../lifecycle.js";
import { config } from "../config.js";
import { TunnelRequestError, openCcWorker, type IsolationContext } from "../tunnel.js";
import { SessionMemory, blockHash, blockTail, blockTails, diffContext, firstDiffOffset, planToolResult, planTurn, type TurnMemory, type TurnPlan } from "./session-memory.js";
import { SessionTranslator, callerSystemText, contentText, isSuggestionRequest, messagesToBlocks, messagesToBlocksWithRoles, messagesToPrompt, toolChoiceInstruction, workerSystemPrompt } from "./translate.js";
import { bump } from "../metrics.js";
import { randomUUID } from "node:crypto";
import { buildNativeTranscript, countStrippedThinking } from "./native-session.js";
import type { EventPayload, TurnFacts } from "./types.js";
import { TurnCapture, captureWanted } from "./capture.js";

type Json = Record<string, any>;

/**
 * Canonical worker turn (spec WP2, invariants I1 no replaced identity / I3 no folded history): what one request may
 * send to the native process. `history_import_unsupported` = the request carries turns no live process holds (an
 * external multi-turn history, or a tool round without a live session) — lane B imports nothing in R2 (G3 importer is
 * WP3). The caller's system text is appended; the turn is the client's last user message, raw.
 */
/**
 * Worker path window bookkeeping (2026-11-02): no unified rate-limit headers reach the platform here, but Claude Code
 * emits a `rate_limit_event` per API call (status / rateLimitType / utilization / resetsAt). Fold it into the account's
 * window columns and window_model so a worker account is no longer blind between usage probes.
 */
/** Turn end: hand the translator's facts (upstream retries) to proxy.ts via input.facts, log and count the retries. */
export function noteTurnFacts(input: { facts?: TurnFacts; requestId: string }, translator: SessionTranslator, accountName: string, lane: string): void {
  const f = translator.turnFacts;
  if (input.facts) Object.assign(input.facts, f);
  if (f.upstreamRetries > 0) {
    bump("ccr_upstream_retry_total", { lane });
    console.log(`[${lane}] ${input.requestId} upstream retried ${f.upstreamRetries}× on ${accountName} (statuses ${f.retryStatuses.join(",") || "-"}, backoff ${Math.round(f.retryDelayMs / 1000)}s): the client saw it as latency`);
  }
}

function noteRateLimit(account: AccountRow, translator: SessionTranslator, requestId: string): void {
  const info = translator.rateLimit;
  if (!info) return;
  try {
    const snap = recordRateLimitEvent(account.id, info);
    const status = String((info as Json).status ?? "-");
    if (status !== "allowed" || (snap?.used ?? 0) >= 0.9) console.log(`[ccr-worker] ${requestId} rate_limit_event on ${account.name}: ${status} ${String((info as Json).rateLimitType ?? "-")} ${snap ? Math.round(snap.used * 100) + "%" : ""} reset=${snap?.resetAt ?? "-"}`);
  } catch (err) {
    console.warn(`[ccr-worker] ${requestId} rate_limit_event bookkeeping failed: ${(err as Error).message}`);
  }
}

/**
 * Appended after the caller's system text on the canonical lane (2026-11-05, 测试BOOK: "I run on a Linux machine and cannot
 * reach your directory"). The node's Claude Code describes ITS environment first (cwd under cc-sessions/cwd, Linux); the
 * caller's own environment arrives second, so the model trusted the sandbox and refused paths that live on the caller's
 * machine — although every caller tool (mcp__caller__*) executes there. Constant text: part of the cached prefix.
 */
export const CANONICAL_ENV_NOTE = [
  "Environment note: the working directory, platform and OS described at the start of this system prompt belong to the",
  "sandbox this process runs in — they are NOT the user's environment. The user's files, shell and working directory are on",
  "the user's own machine; any path the user mentions refers to that machine. When caller tools are available (tool names",
  "starting with mcp__caller__), read, list, edit and run things through them exactly as you would with built-in tools.",
  "When no such tools are available, ask the user to paste what you need instead of describing this sandbox.",
].join(" ");

/**
 * Stronger wording, used with settings canonical_caller_tools_isolation (2026-11-08, X-42). The 11-08 incident: a Windows
 * VS Code user's second turn ran canonical; the model reached for the process's own built-in Read / Glob (restricted to
 * the node cwd) instead of mcp__caller__Read, every attempt failed inside the sandbox, the internal rounds were consumed
 * by the translator, and the user was told "I run in a remote Linux sandbox" plus the node's install path. With the
 * switch on the built-in tools are gone (--tools ""); this text covers the model's remaining knowledge of the sandbox.
 */
export const CANONICAL_ENV_NOTE_V2 = [
  "Environment note: the working directory, platform and OS described at the start of this system prompt belong to the",
  "sandbox this process runs in — they are NOT the user's environment. The user's files, shell and working directory are on",
  "the user's own machine; any path the user mentions (including Windows paths such as F:\\project) refers to that machine.",
  "Tools whose names start with mcp__caller__ run on the user's machine: use them for every read, list, search, edit and",
  "command exactly as you would use built-in tools, and trust their results over anything you know about this sandbox.",
  "Never try to reach the user's files through this sandbox, never conclude that a path does not exist because this",
  "sandbox cannot see it, and never mention this sandbox, its paths, platform or e-mail address to the user.",
  "When no mcp__caller__ tools are available, ask the user to paste what you need.",
].join(" ");

/**
 * Which built-in tool profile a canonical process gets (node: `--restricted`, plus `--tools ""` for tools-disabled).
 * With caller tools present and settings canonical_caller_tools_isolation on, the process keeps none of its own tools:
 * a built-in Read beside an mcp__caller__Read is a trap the model fell into on 2026-11-08 (X-42).
 */
export function canonicalBuiltInToolProfile(isolation: boolean, hasCallerTools: boolean): "restricted-default" | "tools-disabled-canonical" {
  return isolation && hasCallerTools ? "tools-disabled-canonical" : "restricted-default";
}

export function canonicalTurn(body: Json, planMode: "fresh" | "continue" | "tool_result", hasLiveSession: boolean, allowHistoryImport = false, isolation = false): { appendSystemPrompt: string; content: Json[] | null; importHistory: Json[] | null; error: { code: string; message: string } | null } {
  const msgs: Json[] = Array.isArray(body.messages) ? body.messages : [];
  const appendSystemPrompt = [callerSystemText(body), isolation ? CANONICAL_ENV_NOTE_V2 : CANONICAL_ENV_NOTE].filter(Boolean).join("\n\n");
  // Claude Code 2.1.31x closes a request with `role:"system"` messages after the live user turn (# Environment on the
  // first request, environment updates and task notifications later). They are not history: the live turn is the last
  // user message, and the trailing system text rides along as text blocks after the user's own (older Claude Code
  // rendered the same attachments inside the user message). Until 2026-11-08 a first request shaped [user, system] was
  // refused as history_import_unsupported and served by the legacy worker; the second turn then switched lanes (X-42).
  let end = msgs.length;
  const trailingSystem: Json[] = [];
  while (end > 0 && msgs[end - 1]?.role === "system") trailingSystem.unshift(msgs[--end]);
  const last = msgs[end - 1];
  const history = msgs.slice(0, Math.max(0, end - 1));
  // Canonical sends the caller's live turn raw to the native process, which forwards it upstream as-is. The caller's
  // own cache_control markers must not ride along (legacy drops them too, translate.ts): Claude Code sets its own, and
  // the upstream rejects a caller `ttl` and more than 4 marked blocks in total (2026-11-05: 8 × 400 → 502 on the pilot key).
  const stripCacheControl = (b: Json): Json => {
    if (!b || typeof b !== "object" || !("cache_control" in b)) return b;
    const { cache_control: _dropped, ...rest } = b;
    return rest;
  };
  const own: Json[] = typeof last?.content === "string" ? [{ type: "text", text: last.content }] : Array.isArray(last?.content) ? last.content.filter((b: Json) => b && typeof b === "object" && b.type !== "tool_result").map(stripCacheControl) : [];
  const systemText = (m: Json): Json[] =>
    typeof m?.content === "string"
      ? (m.content ? [{ type: "text", text: m.content }] : [])
      : Array.isArray(m?.content)
        ? m.content.filter((b: Json) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string" && b.text).map(stripCacheControl)
        : [];
  const raw: Json[] = [...own, ...trailingSystem.flatMap(systemText)];
  const hasToolResult = Array.isArray(last?.content) && last.content.some((b: Json) => b?.type === "tool_result");
  // G3 import (settings canonical_history_import): everything before the live turn becomes a native transcript; the
  // live turn must be a plain user message (a tool round nobody holds cannot be resumed into a generation).
  if (planMode === "fresh" && history.length > 0 && allowHistoryImport && last?.role === "user" && !hasToolResult && own.length > 0) {
    return { appendSystemPrompt, content: raw, importHistory: history, error: null };
  }
  if (planMode === "fresh" && history.length > 0) {
    return { appendSystemPrompt, content: null, importHistory: null, error: { code: "history_import_unsupported", message: "This key runs on the canonical Claude Code worker, which carries only conversations it started: the request brings earlier turns no live session holds (a history from another upstream, or a resumed conversation). Start a new conversation here (one user message) and keep the same conversation going; external history import is not available yet." } };
  }
  if (planMode === "fresh" && hasToolResult) {
    return { appendSystemPrompt, content: null, importHistory: null, error: { code: "history_import_unsupported", message: "This tool round belongs to a conversation no live canonical session holds; its tool_use cannot be continued here. Start the task again with a new independent question." } };
  }
  if (planMode === "tool_result" && !hasLiveSession) {
    return { appendSystemPrompt, content: null, importHistory: null, error: { code: "history_import_unsupported", message: "The canonical session holding this tool round is gone; start the task again." } };
  }
  return { appendSystemPrompt, content: planMode === "tool_result" ? null : raw, importHistory: null, error: null };
}

export interface CcrWorkerInput {
  account: AccountRow;
  cred: Credential;
  /** Anthropic Messages body (chat clients are converted before this point). */
  body: Json;
  clientModel: string;
  upstreamModel: string;
  stream: boolean;
  requestId: string;
  /** Conversation affinity key (proxy.ts stickyKey); null = anonymous single shot, never pooled. */
  stickyKey?: string | null;
  isolation?: IsolationContext;
  signal?: AbortSignal;
  /** Canonical worker (spec WP2): key workerMode=canonical and settings worker_canonical on for this key/account. */
  canonical?: boolean;
  /** The key's group (three-state switches resolved per key group). */
  groupId?: string | null;
  /** Caller identity for the sampled turn capture (ccr/capture.ts); optional, diagnostics only. */
  apiKeyId?: string | null;
  userId?: string | null;
  /** Filled by the worker at turn end (upstream retries …); proxy.ts records it with the usage row. */
  facts?: TurnFacts;
}

/** Gateway-side memory of live node sessions (docs/worker-sessions.md §1), written through to core worker_turn_memory. */
export const sessionMemory = new SessionMemory(config.ccrPoolIdleMs, undefined, {
  load: (key, now) => loadTurnMemory<TurnMemory>(key, now),
  save: (key, entry) => saveTurnMemory(key, entry, entry.expiresAt),
  delete: (key) => deleteTurnMemory(key),
});

/** One stdout line -> one event payload; malformed lines are skipped. */
export function parseStreamJsonLine(line: string): EventPayload | null {
  const t = line.trim();
  if (!t) return null;
  try {
    const j = JSON.parse(t) as Json;
    return j && typeof j.type === "string" ? (j as EventPayload) : null;
  } catch {
    return null;
  }
}

/** Incremental UTF-8 line splitter for the worker's stream-json stdout. */
export class StreamJsonLines {
  private buf = "";

  push(text: string): EventPayload[] {
    this.buf += text;
    if (this.buf.length > 8_388_608) throw new Error("worker event exceeds 8 MiB");
    const out: EventPayload[] = [];
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) !== -1) {
      const p = parseStreamJsonLine(this.buf.slice(0, nl));
      this.buf = this.buf.slice(nl + 1);
      if (p) out.push(p);
    }
    return out;
  }

  /** Trailing partial line at EOF. */
  end(): EventPayload[] {
    const p = parseStreamJsonLine(this.buf);
    this.buf = "";
    return p ? [p] : [];
  }
}

/**
 * How the client's `thinking` request maps onto the Claude Code process
 * (docs/worker-sessions.md §4). `enabled` + budget_tokens → `--max-thinking-tokens`
 * (Claude 4.x and still honoured by 5.x in CC). `adaptive` is the Claude 5 API:
 * its switch inside Claude Code is `--effort`, so an adaptive request without
 * an explicit effort gets the API's default level ("high"); otherwise the model
 * would think but the translator (thinking: false) would drop the signed blocks
 * — veridrop 思维签名 "no_thinking_block" on Claude 5 models, 2026-10-17.
 */
export function planThinking(body: Json): { thinkingBudget: number; thinkingWanted: boolean; effort: string } {
  const t = body.thinking && typeof body.thinking === "object" ? (body.thinking as Json) : null;
  const type = typeof t?.type === "string" ? t.type : "";
  const thinkingBudget = type === "enabled" ? Math.max(1024, Math.min(Number(t!.budget_tokens) || 1024, 128_000)) : 0;
  const thinkingWanted = type === "enabled" || type === "adaptive";
  // Claude 5 `effort` (client field or output_config.effort) → `--effort`; part of the reuse key.
  const effortRaw = typeof body.effort === "string" ? body.effort : typeof body.output_config?.effort === "string" ? body.output_config.effort : "";
  let effort = ["low", "medium", "high", "xhigh", "max"].includes(effortRaw) ? effortRaw : "";
  if (type === "adaptive" && !effort) effort = "high";
  return { thinkingBudget, thinkingWanted, effort };
}

function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ type: "error", error: { type: "api_error", message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function runCcrWorker(input: CcrWorkerInput): Promise<Response | null> {
  const { account, cred, body, stream } = input;
  if (!cred.accessToken) return errorResponse(401, "ccr_worker: credential has no accessToken");
  // System text goes to the node as the worker's own system prompt (replaces Claude Code's); the prompt holds the rest.
  // Persistent session (docs/worker-sessions.md): same conversation → same live process on the node.
  // Claude Code's suggestion side request is answered one-shot: it must not take a turn of the live process.
  const oneShot = isSuggestionRequest(body);
  const persistent = getSetting("ccr_worker_persistent") === "1" && !!input.stickyKey && !oneShot;
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  // Native tools (§3): only with a persistent process, which can hold the turn open across two client requests.
  const canonical = input.canonical === true;
  // Canonical: caller tools are always native (MCP); a tool round needs a live process to hold the turn across
  // requests, so canonical with tools requires the persistent session pool.
  if (canonical && hasTools && !persistent) throw new TunnelRequestError("canonical_requires_persistent_session", "This key runs on the canonical Claude Code worker; tool use there needs the persistent session pool (settings ccr_worker_persistent=1), which is off.");
  const nativeTools = canonical ? hasTools : persistent && hasTools && getSetting("ccr_worker_native_tools") === "1";
  // Legacy: the platform's replacement system prompt (I1 forbids it for canonical: the native identity stays).
  const systemPrompt = canonical ? "" : workerSystemPrompt(body, { nativeTools, hidePlatformPath: featureFor("worker_prompt_hide_platform_path", { accountId: account.id }) });
  let prompt = messagesToPrompt(body, { omitSystem: true, omitTools: nativeTools });
  // Per-turn content blocks (cache-friendly, images in place); null for a bare single-turn request → plain prompt.
  const blocks = messagesToBlocks(body, { omitSystem: true, omitTools: nativeTools });
  if (!prompt.trim()) {
    // The open envelope needs a non-empty prompt (console + node validate it). An image/document-only
    // turn rides on the content blocks, so a placeholder is enough; a turn with nothing at all is the
    // request's fault → answer once (was: console 400 per account → 503 no_available_account).
    const hasMedia = Array.isArray(blocks) && blocks.some((b) => b && typeof b === "object" && b.type !== "text");
    if (!hasMedia) throw new TunnelRequestError("empty_prompt", "The messages carry no text to send: at least one message must contain non-empty text.");
    prompt = " ";
  }
  const { thinkingBudget, thinkingWanted, effort } = planThinking(body);
  const toolDefs = nativeTools
    ? (body.tools as Json[]).filter((t) => t && typeof t.name === "string").map((t) => ({ name: String(t.name), description: typeof t.description === "string" ? t.description : undefined, input_schema: t.input_schema ?? { type: "object" } }))
    : undefined;
  // Client sampling controls Claude Code has no flag for (docs/ccr-supply.md §6): max_tokens becomes the
  // process's CLAUDE_CODE_MAX_OUTPUT_TOKENS (one cap per live process → part of the reuse key), stop_sequences
  // are applied by the translator, and a forced tool_choice becomes an instruction block on this turn.
  const maxTokens = Number.isInteger(body.max_tokens) && body.max_tokens > 0 ? Math.min(Number(body.max_tokens), 128_000) : 0;
  const stopSequences: string[] = Array.isArray(body.stop_sequences) ? body.stop_sequences.filter((s: unknown): s is string => typeof s === "string" && s.length > 0).slice(0, 16) : [];
  const toolChoice = hasTools ? toolChoiceInstruction(body, { nativeTools }) : null;
  // Persistent sessions fold turn 1 exactly like later history ("[user]\n…" block), so turn 2 can match it as a prefix.
  const withRoles = persistent ? messagesToBlocksWithRoles(body, { omitSystem: true, omitTools: nativeTools, alwaysBlocks: true }) : null;
  const fullBlocks = persistent ? (withRoles?.blocks ?? [{ type: "text", text: prompt }]) : (blocks ?? [{ type: "text", text: prompt }]);
  const roles = withRoles?.roles ?? fullBlocks.map(() => "user" as const);
  // The conversation root (first block) is part of the key: Claude Code subagents share the main thread's
  // session id, and interleaved on one key every turn of both missed the prefix (2026-10-23).
  const reuseKey = persistent
    ? sha256Hex([account.id, input.stickyKey, input.upstreamModel, canonical ? `canonical:${callerSystemText(body)}` : systemPrompt, JSON.stringify(body.tools ?? null), nativeTools ? "native" : "fence", `think:${thinkingBudget}:${thinkingWanted ? 1 : 0}`, `effort:${effort}`, `max:${maxTokens}`, `root:${blockHash(fullBlocks[0] ?? {})}`].join("|"))
    : null;
  // System-role blocks (per-turn-control) are fed in place but never hashed: later requests keep, rewrite or drop them.
  const persistentIdx: number[] = [];
  roles.forEach((r, i) => {
    if (r !== "system") persistentIdx.push(i);
  });
  const ephemeral = fullBlocks.length - persistentIdx.length;
  const persistentBlocks = ephemeral ? persistentIdx.map((i) => fullBlocks[i]) : fullBlocks;
  const mem = reuseKey ? sessionMemory.get(reuseKey) : undefined;
  const msgs: Json[] = Array.isArray(body.messages) ? body.messages : [];
  const plan: TurnPlan = reuseKey
    ? (nativeTools ? planToolResult(mem, persistentBlocks, msgs) : null) ?? planTurn(mem, persistentBlocks)
    : { mode: "fresh", content: fullBlocks, hashes: [] };
  if (plan.mode === "fresh" && plan.diffAt !== undefined && mem) {
    // Why did the history stop matching? (2026-10-23: 1090 of 4186 opens in 15 min were prefix misses, mostly at the
    // last stored block.) Log the stored tails next to the request's blocks around the miss, text heads only.
    const n = mem.hashes.length;
    const stored = (mem.tails ?? []).map((t, i) => `[${n - (mem.tails!.length - i)}]${t.type} len=${t.len} "${t.head.slice(0, 60)}"`).join(" | ");
    const around = persistentBlocks.slice(Math.max(0, plan.diffAt - 1), plan.diffAt + 3).map((b, i) => {
      const t = blockTail(b);
      return `[${Math.max(0, plan.diffAt! - 1) + i}]${t.type} len=${t.len} "${t.head.slice(0, 60)}"`;
    });
    const storedLast = mem.tails?.[mem.tails.length - 1];
    const newAt = persistentBlocks[plan.diffAt];
    let off = "";
    if (storedLast && plan.diffAt === n - 1 && typeof newAt?.text === "string") {
      const newTail = blockTail(newAt);
      const headDiff = firstDiffOffset(storedLast.head, newTail.head);
      // Same head: the change is further in — show both ends (an appended reminder / a truncated result shows here).
      off = headDiff < Math.min(storedLast.head.length, newTail.head.length) ? ` first-diff@${headDiff}(of head)` : ` same head; ends: stored "…${(storedLast.tail ?? "").slice(-80)}" vs request "…${(newTail.tail ?? "").slice(-80)}"`;
    }
    console.log(`[ccr-worker] ${input.requestId} prefix miss ${reuseKey!.slice(0, 8)} at ${plan.diffAt}/${n} (${fullBlocks.length} blocks, memory turn ${mem.turn}${mem.pendingCalls?.length ? `, ${mem.pendingCalls.length} parked` : ""})${off}; stored: ${stored}; request: ${around.join(" | ")}`);
  }
  if (plan.mode === "fresh" && plan.reason === "echo" && mem) {
    // The client did not echo the last answer the way the gateway folded it: where does it differ?
    const n = mem.hashes.length;
    const got = persistentBlocks[n];
    const text = typeof got?.text === "string" ? got.text : `<${String(got?.type ?? "none")}>`;
    console.log(`[ccr-worker] ${input.requestId} echo miss ${reuseKey!.slice(0, 8)} (${fullBlocks.length} blocks, memory turn ${mem.turn}${mem.pendingCalls?.length ? `, ${mem.pendingCalls.length} parked` : ""}): ${diffContext(mem.assistantFold, text)}`);
  }
  // continue: everything after the echoed answer in request order (new turn + system blocks around it);
  // fresh / tool_result: the whole conversation.
  const echoAt = plan.mode === "continue" && mem ? persistentIdx[mem.hashes.length] ?? fullBlocks.length - 1 : -1;
  const content = reuseKey ? (plan.mode === "continue" ? (ephemeral ? fullBlocks.slice(echoAt + 1) : plan.content) : fullBlocks) : blocks;
  // Canonical (I3): never the folded transcript — the raw last user turn (or nothing for a parked tool round);
  // anything the live process does not hold is refused up front, not re-folded.
  // Caller-tools isolation (X-42): no built-in tools beside the caller's MCP tools, stronger environment note.
  const callerToolsIsolation = canonical && featureFor("canonical_caller_tools_isolation", { groupId: input.groupId, accountId: account.id });
  const canon = canonical ? canonicalTurn(body, plan.mode, !!mem && !!reuseKey, featureFor("canonical_history_import", { groupId: input.groupId, accountId: account.id }), callerToolsIsolation) : null;
  if (canon?.error) throw new TunnelRequestError(canon.error.code, canon.error.message);
  // Native session (spec §6.3 / WP3): fresh = new id; continue / tool_result = the remembered session, resumed by the
  // node if its live process is gone; import = transcript built here, written and resumed on the node.
  const nativeSessionId = canonical ? (plan.mode !== "fresh" && mem?.native?.sessionId ? mem.native.sessionId : randomUUID()) : null;
  const historyImport = canon?.importHistory ? buildNativeTranscript(canon.importHistory, nativeSessionId!, { model: input.upstreamModel }) : null;
  if (historyImport) {
    const stripped = countStrippedThinking(canon!.importHistory!);
    bump("native_history_import_total", { lines: historyImport.length > 50 ? "50+" : String(historyImport.length) });
    console.log(`[ccr-worker] ${input.requestId} canonical import: ${historyImport.length} transcript line(s) into ${nativeSessionId!.slice(0, 8)}${stripped ? ` (${stripped} thinking block(s) stripped)` : ""}`);
  }
  const nativeSession = canonical ? { id: nativeSessionId!, action: (plan.mode !== "fresh" && mem?.native) || historyImport ? ("resume" as const) : ("start" as const), revision: mem?.native?.revision ?? 0 } : null;
  const turnContent = canon ? canon.content : content;
  // The tool_choice instruction rides on this turn only: it is not part of the hashes the next request must echo.
  const sendContent = turnContent ? (toolChoice ? [...turnContent, { type: "text", text: toolChoice }] : turnContent) : null;
  const sendPrompt = canonical ? " " : !sendContent && toolChoice ? `${prompt}\n\n${toolChoice}` : prompt;
  const prevUsage = plan.mode === "fresh" ? null : (mem?.usage ?? null);
  const addUsage = (a: NonNullable<typeof prevUsage> | null, b: NonNullable<typeof prevUsage>) =>
    a ? { input_tokens: a.input_tokens + b.input_tokens, output_tokens: a.output_tokens + b.output_tokens, cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens, cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens } : b;
  const rememberTurn = (translator: SessionTranslator): void => {
    if (!reuseKey) return;
    if (plan.mode !== "fresh" && translator.freshProcess) {
      // The node could not continue the live process and restarted from the full history; the
      // translator already dropped the usage baseline on init. Turn counters stay aligned (the
      // node adopts expectedTurn), so the memory below is still right.
      console.log(`[ccr-worker] ${input.requestId} node restarted ${reuseKey.slice(0, 8)} from full history (plan was ${plan.mode})`);
    }
    const awaiting = translator.awaitingTools;
    // Canonical (spec §6.3): a node restart on a continue = a native --resume happened (G4); its outcome is the turn's.
    const resumed = canonical && plan.mode !== "fresh" && translator.freshProcess;
    if (resumed) bump("native_resume_total", { result: translator.error ? "failed" : "ok" });
    // cutShort: the turn is cancelled mid-generation (max_tokens / stop_sequence) and the node retires the process.
    if (translator.error || translator.cutShort || (!translator.finished && !awaiting)) {
      if (canonical && translator.error) console.warn(`[ccr-worker] ${input.requestId} native session ${nativeSessionId?.slice(0, 8)} ${resumed ? "LOST after resume" : "DIRTY"}: ${translator.error.slice(0, 160)}`);
      sessionMemory.forget(reuseKey);
      return;
    }
    const native = canonical
      ? { sessionId: translator.nativeSessionId ?? nativeSessionId!, profileId: `cc-${CC_VERSION}-restricted`, revision: (mem?.native?.revision ?? 0) + (awaiting ? 0 : 1), state: awaiting ? ("AWAITING_CALLER" as const) : ("COMMITTED" as const), resumes: (mem?.native?.resumes ?? 0) + (resumed ? 1 : 0), ...(historyImport || mem?.native?.imported ? { imported: true } : {}) }
      : undefined;
    const fold = `[assistant]\n${contentText(translator.message().content, nativeTools ? "plain" : "fence")}`;
    if (awaiting) {
      // Turn parked on the node: same turn counter; what this response already billed is added to the
      // process total so the resumed turn's increment covers only the continuation.
      sessionMemory.remember(reuseKey, {
        hashes: plan.hashes,
        assistantFold: fold,
        turn: plan.mode === "fresh" ? 0 : (plan.expectedTurn ?? 0),
        usage: addUsage(prevUsage, translator.rawUsage),
        pendingCalls: awaiting,
        tails: blockTails(persistentBlocks),
        ...(native ? { native } : {}),
      });
      return;
    }
    sessionMemory.remember(reuseKey, { hashes: plan.hashes, assistantFold: fold, turn: plan.mode === "fresh" ? 1 : (plan.expectedTurn ?? 0) + 1, usage: translator.cumulativeUsage, tails: blockTails(persistentBlocks), ...(native ? { native } : {}) });
  };
  // Sampled turn capture (docs/worker-sessions.md 2026-11-03): request half now, response half at every exit below.
  const capture = captureWanted(input.apiKeyId, input.requestId)
    ? new TurnCapture({ requestId: input.requestId, apiKeyId: input.apiKeyId, userId: input.userId, groupId: input.groupId, account: { id: account.id, name: account.name }, clientModel: input.clientModel, upstreamModel: input.upstreamModel, stream, canonical, persistent, nativeTools, body, systemText: canonical ? callerSystemText(body) : systemPrompt, plan, sent: canonical ? canon?.content : content, maxTokens, stopSequences, thinking: { thinkingWanted, thinkingBudget, effort } })
    : null;
  const translator = new SessionTranslator({
    model: input.clientModel,
    simulateTools: hasTools && !nativeTools,
    nativeTools,
    thinking: thinkingWanted,
    cacheBaseline: Number(getSetting("ccr_cache_baseline_worker")),
    cacheWriteAsInput: getSetting("ccr_cache_write_as_input") !== "0",
    // Continued / resumed turn: bill only the increment over what the process already reported.
    usageBaseline: plan.mode === "fresh" ? null : (mem?.usage ?? null),
    stopSequences,
    // Canonical: no folded transcript to guard, and the process's own --restricted tools are internal rounds.
    transcriptGuard: !canonical,
    internalTools: canonical,
    ...(toolDefs ? { toolNames: toolDefs.map((t) => t.name) } : {}),
  });
  const logGuard = (): void => {
    if (translator.guardHits.length) console.log(`[ccr-worker] ${input.requestId} transcript guard on ${account.name} (${plan.mode}${plan.reason ? ` ${plan.reason}` : ""}, ${fullBlocks.length} blocks): ${translator.guardHits.join(",")}`);
  };

  const opened = await openCcWorker(account.id, {
    model: input.upstreamModel,
    isolation: input.isolation,
    prompt: sendPrompt,
    systemPrompt,
    ...(canonical ? { mode: "canonical" as const, profileId: `cc-${CC_VERSION}-restricted`, appendSystemPrompt: canon!.appendSystemPrompt, nativeSessionId: nativeSessionId!, nativeSession: nativeSession!, ...(historyImport ? { historyImport } : {}), builtInToolProfile: canonicalBuiltInToolProfile(callerToolsIsolation, !!toolDefs && toolDefs.length > 0) } : {}),
    ...(thinkingBudget > 0 ? { thinkingBudget } : {}),
    ...(effort ? { effort } : {}),
    ...(maxTokens > 0 ? { maxTokens } : {}),
    ...(reuseKey ? { persist: true, reuseKey, turnMode: plan.mode, expectedTurn: plan.expectedTurn, ...(toolDefs ? { tools: toolDefs } : {}), ...(plan.results ? { results: plan.results } : {}) } : {}),
    ...(sendContent ? { content: sendContent } : {}),
    // continue: the node needs the whole conversation in hand in case its live process cannot
    // take the turn (busy / parked / gone); it must never start a process from the tail (10-22).
    // Canonical: no history — a live-process miss must fail (session_lost), never restart from a folded transcript (I3/I9).
    ...(plan.mode === "continue" && !canonical ? { history: fullBlocks } : {}),
    stream,
    cred: {
      accessToken: cred.accessToken,
      refreshToken: cred.refreshToken,
      expiresAt: cred.expiresAt,
      subscriptionType: account.subscription_type ?? undefined,
    },
    proxyId: account.bound_proxy_id ?? undefined,
  }, input.signal).catch((err: unknown) => {
    if (input.signal?.aborted) throw input.signal.reason;
    if (err instanceof TunnelRequestError) throw err; // request-level: answered once by proxy.ts
    return null;
  });
  if (canonical) bump("canonical_worker_open_total", { profile: `cc-${CC_VERSION}-restricted`, result: opened ? "accepted" : "no_node" });
  // No node may take a canonical open for this account (its node lacks canonical_v1, or is away): the legacy worker on
  // the same account serves the turn (proxy.ts CANONICAL_FALLBACK_CODES, 2026-11-05 canonical-by-default rollout).
  if (!opened && canonical) throw new TunnelRequestError("canonical_node_unavailable", `No canonical-capable node is available for ${account.name}`);
  if (!opened) return null;

  console.log(`[ccr-worker] ${input.requestId} on ${account.name} (${canonical ? "canonical, " : ""}session ${opened.sessionId}${reuseKey ? `, ${plan.mode} ${reuseKey.slice(0, 8)}${plan.mode === "continue" ? ` turn ${(plan.expectedTurn ?? 0) + 1}` : plan.reason ? ` (${plan.reason}, ${fullBlocks.length} blocks${ephemeral ? `, ${ephemeral} system` : ""})` : ""}` : oneShot ? ", one-shot suggestion" : ""})`);
  const deadline = Date.now() + config.ccrSessionTimeoutMs;
  const startedAt = Date.now();
  const lines = new StreamJsonLines();
  const reader = opened.stream.getReader();
  const decoder = new TextDecoder();
  const onAbort = () => { if (reuseKey) sessionMemory.forget(reuseKey); void reader.cancel(input.signal?.reason).catch(() => {}); };
  input.signal?.addEventListener("abort", onAbort, { once: true });
  if (input.signal?.aborted) onAbort();

  // Native tools: the turn is handed to the client once every tool_use block has its parked MCP
  // call. If Claude Code does not issue them all promptly (a tool it refuses to run, or more
  // parallel calls than it will start at once), stop waiting after a grace period: the client
  // still gets the complete tool_use message, and its next request simply starts a fresh
  // process (no live session to continue). Before 2026-10-17 the gateway waited for Claude
  // Code's own MCP timeout (60 s per call) here.
  const PARK_GRACE_MS = 3_000;
  const SLOW_TURN_LOG_MS = 60_000;
  let pendingRead: Promise<Awaited<ReturnType<typeof reader.read>>> | null = null;
  /** Next stdout chunk, or null after `ms` without one; a read left pending is picked up by the next call, nothing is lost. */
  const readFor = async (ms: number): Promise<Awaited<ReturnType<typeof reader.read>> | null> => {
    pendingRead ??= reader.read();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<null>((r) => {
      timer = setTimeout(() => r(null), ms);
    });
    try {
      const res = await Promise.race([pendingRead, timeout]);
      if (res === null) return null;
      pendingRead = null;
      return res;
    } finally {
      clearTimeout(timer);
    }
  };
  const parkStalled = (): boolean => nativeTools && translator.toolUseStopAt !== null && !translator.awaitingTools && !translator.finished && Date.now() - translator.toolUseStopAt > PARK_GRACE_MS;
  let stalled = false;
  const noteStalled = (): void => {
    const p = translator.parkProgress;
    console.log(`[ccr-worker] ${input.requestId} tool_use turn handed over with ${p.parked}/${p.toolUses} parked call(s) after ${PARK_GRACE_MS}ms; no live session kept`);
    if (reuseKey) sessionMemory.forget(reuseKey);
  };

  if (!stream) {
    try {
      for (;;) {
        input.signal?.throwIfAborted();
        if (Date.now() > deadline) throw new Error(`worker timed out after ${config.ccrSessionTimeoutMs}ms`);
        const r = await readFor(1_000);
        if (r === null) {
          if (parkStalled()) {
            stalled = true;
            break;
          }
          continue;
        }
        if (r.done) break;
        for (const p of lines.push(decoder.decode(r.value, { stream: true }))) translator.push(p);
        if (translator.finished || translator.awaitingTools) break;
        if (parkStalled()) {
          stalled = true;
          break;
        }
      }
      if (!stalled) for (const p of lines.end()) translator.push(p);
    } catch (err) {
      input.signal?.removeEventListener("abort", onAbort);
      await reader.cancel().catch(() => {});
      capture?.finish(translator, { status: input.signal?.aborted ? 499 : 502, error: input.signal?.aborted ? "client_closed" : (err as Error).message });
      if (input.signal?.aborted) throw input.signal.reason;
      return errorResponse(502, `ccr_worker: ${(err as Error).message}`);
    }
    input.signal?.removeEventListener("abort", onAbort);
    await reader.cancel().catch(() => {});
    input.signal?.throwIfAborted();
    if (stalled) noteStalled();
    else { rememberTurn(translator); noteRateLimit(account, translator, input.requestId); noteTurnFacts(input, translator, account.name, "ccr-worker"); }
    logGuard();
    // Slow non-stream turns (customer 524s, 2026-10-22): what did Claude Code emit, and when.
    if (Date.now() - startedAt > SLOW_TURN_LOG_MS) console.log(`[ccr-worker] ${input.requestId} slow turn ${Math.round((Date.now() - startedAt) / 1000)}s on ${account.name}: ${translator.eventTimeline}`);
    if (translator.error) {
      logResult(input.requestId, translator);
      noteTurnFacts(input, translator, account.name, "ccr-worker");
      capture?.finish(translator, { status: 502 });
      return errorResponse(502, `ccr_worker: ${translator.error}`);
    }
    if (!translator.finished && !translator.awaitingTools && !stalled) {
      capture?.finish(translator, { status: 502, error: "worker exited without a result" });
      return errorResponse(502, "ccr_worker: worker exited without a result");
    }
    if (translator.awaitingTools) console.log(`[ccr-worker] ${input.requestId} parked on ${translator.awaitingTools.length} native tool call(s)`);
    if (translator.cutShort) console.log(`[ccr-worker] ${input.requestId} cut short: ${translator.stopReasonOut} (session cancelled)`);
    if (translator.upstreamUsage) console.log(`[ccr-worker] ${input.requestId} upstream modelUsage: ${JSON.stringify(translator.upstreamUsage).slice(0, 400)}`);
    capture?.finish(translator, { status: 200, stalled });
    return new Response(JSON.stringify(translator.message()), { status: 200, headers: { "content-type": "application/json" } });
  }

  // Streaming: SSE produced as stdout lines arrive. Failures mid-stream
  // surface as an SSE `error` event (same convention as the cloud executor).
  const encoder = new TextEncoder();
  const demand = new StreamDemand();
  const bodyStream = new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
      const write = (s: string) => demand.write(controller, encoder.encode(s));
      try {
        for (;;) {
          input.signal?.throwIfAborted();
        if (Date.now() > deadline) throw new Error("worker timed out");
          const r = await readFor(1_000);
          if (r === null) {
            if (parkStalled()) {
              stalled = true;
              break;
            }
            continue;
          }
          if (r.done) break;
          for (const p of lines.push(decoder.decode(r.value, { stream: true }))) await write(translator.push(p));
          if (translator.finished || translator.awaitingTools) break;
          if (parkStalled()) {
            stalled = true;
            break;
          }
        }
        if (!stalled) for (const p of lines.end()) await write(translator.push(p));
        if (stalled) noteStalled();
        else { rememberTurn(translator); noteRateLimit(account, translator, input.requestId); noteTurnFacts(input, translator, account.name, "ccr-worker"); }
        logGuard();
        if (Date.now() - startedAt > SLOW_TURN_LOG_MS) console.log(`[ccr-worker] ${input.requestId} slow turn ${Math.round((Date.now() - startedAt) / 1000)}s on ${account.name}: ${translator.eventTimeline}`);
        if (translator.error) {
          logResult(input.requestId, translator);
          await write(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: `ccr_worker: ${translator.error}` } })}\n\n`);
        } else if (translator.awaitingTools || stalled) {
          if (translator.awaitingTools) console.log(`[ccr-worker] ${input.requestId} parked on ${translator.awaitingTools.length} native tool call(s)`);
          await write(translator.end());
        } else if (!translator.finished) {
          await write(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: "ccr_worker: worker exited without a result" } })}\n\n`);
        } else {
          if (translator.cutShort) console.log(`[ccr-worker] ${input.requestId} cut short: ${translator.stopReasonOut} (session cancelled)`);
          if (translator.upstreamUsage) console.log(`[ccr-worker] ${input.requestId} upstream modelUsage: ${JSON.stringify(translator.upstreamUsage).slice(0, 400)}`);
          await write(translator.end());
        }
      } catch (err) {
        await write(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: `ccr_worker: ${(err as Error).message}` } })}\n\n`).catch(() => {});
      } finally {
        input.signal?.removeEventListener("abort", onAbort);
        await reader.cancel().catch(() => {});
        capture?.finish(translator, { status: translator.error ? 502 : 200, error: input.signal?.aborted ? "client_closed" : (!translator.finished && !translator.awaitingTools && !stalled ? "worker exited without a result" : null), stalled });
        demand.close(controller);
      }
      })();
    },
    pull() { demand.pull(); },
    cancel() {
      demand.cancel();
      if (reuseKey) sessionMemory.forget(reuseKey);
      void reader.cancel().catch(() => {});
    },
  });
  return new Response(bodyStream, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } });
}

/** One line per failed session result: subtype / is_error / text head (no prompt content beyond what claude echoed). */
function logResult(requestId: string, translator: SessionTranslator): void {
  const r = translator.result;
  console.log(`[ccr-worker] ${requestId} result ${r ? `subtype=${r.subtype} is_error=${r.isError}` : "missing"}: ${(translator.error ?? "").replace(/\s+/g, " ").slice(0, 300)}`);
}
