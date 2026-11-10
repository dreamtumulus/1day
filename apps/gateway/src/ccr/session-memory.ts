// Persistent worker sessions, gateway side (docs/worker-sessions.md §1): remember,
// per reuse key, what the node's live claude process has already been fed (one
// hash per content block) and the answer it gave, so the next request of the
// same conversation reduces to "only the new turn" when the client echoes the
// history back verbatim. Any mismatch → fresh (never a wrong reuse).

import { sha256Hex } from "@1dayapi/core";
import type { TranslatedUsage } from "./translate.js";

type Json = Record<string, any>;

export interface TurnMemory {
  /** sha256 per content block the process has seen (whole history incl. the last turn fed). */
  hashes: string[];
  /** The `[assistant]\n<text>` block the client is expected to echo back for the last answer. */
  assistantFold: string;
  /** Completed turns on the node; sent as `expectedTurn` with the next continue. */
  turn: number;
  /** Cumulative result usage of the process after the last turn (Claude Code reports totals, not increments). */
  usage: TranslatedUsage | null;
  /** Native tools: the turn is parked on the node waiting for these tool results (client tool_use id → node callId). */
  pendingCalls?: Array<{ toolUseId: string; callId: string; name: string }>;
  /** Upstream message ids already delivered to the client (last 16): a whole row of one told on a later tunnel is not a new message. */
  messageIds?: string[];
  /** X-54: the execution lane of the live process ("p" | "tui" | "legacy"), so a continuation is keyed like the process it continues. */
  overheadLane?: string;
  /** Diagnostics (2026-10-23): shape of the last blocks fed, so a prefix miss can be explained in the log. */
  tails?: BlockTail[];
  /** Canonical native session (spec §6.3 / WP3): what `--resume` needs and where the session stands. */
  native?: NativeSessionState;
  expiresAt: number;
}

export type NativeSessionStatus = "READY" | "RUNNING" | "COMMITTED" | "AWAITING_CALLER" | "DIRTY" | "LOST";
export interface NativeSessionState {
  sessionId: string;
  profileId: string;
  /** Committed turns (monotonic). */
  revision: number;
  state: NativeSessionStatus;
  /** Resumes performed on this conversation (diagnostics). */
  resumes: number;
  imported?: boolean;
}

export type TurnMemoryInput = Omit<TurnMemory, "expiresAt">;

/** Compact description of one content block: role heading, length and the first characters. */
export interface BlockTail {
  type: string;
  len: number;
  head: string;
  /** Last characters of the block (where appended reminders / truncation show up). */
  tail?: string;
}

export function blockTail(b: Json): BlockTail {
  const text = typeof b?.text === "string" ? b.text : "";
  return { type: b?.type === "text" ? text.split("\n", 1)[0].slice(0, 16) : String(b?.type ?? "?"), len: text.length, head: text.slice(0, 100).replace(/\s+/g, " "), tail: text.slice(-120).replace(/\s+/g, " ") };
}

/** Where two texts diverge, with context on both sides (for the echo / prefix miss logs). */
export function diffContext(a: string, b: string, around = 60): string {
  const i = firstDiffOffset(a, b);
  const ctx = (s: string) => s.slice(Math.max(0, i - around), i + around).replace(/\s+/g, " ");
  return `@${i} (len ${a.length} vs ${b.length}) stored "…${ctx(a)}…" vs request "…${ctx(b)}…"`;
}

/** The last `n` blocks of a request as tails (for the memory and the prefix-miss log). */
export function blockTails(blocks: Json[], n = 3): BlockTail[] {
  return blocks.slice(-n).map(blockTail);
}

/** First offset at which two block texts differ (or the shorter length). */
export function firstDiffOffset(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

export interface TurnPlan {
  mode: "fresh" | "continue" | "tool_result";
  /** Blocks to send: the new turn only (continue) or the whole history (fresh / tool_result fallback). */
  content: Json[];
  expectedTurn?: number;
  /** Hashes of the full history as sent (stored after a successful turn). */
  hashes: string[];
  /** tool_result mode: the client's results mapped to the node's parked calls. */
  results?: Array<{ callId: string; content: string; isError: boolean }>;
  /** Why a fresh plan was chosen (diagnostics): no_memory | expired | prefix@<i>/<n> | echo | no_tail. */
  reason?: string;
  /** prefix@: index of the first block that differs from what the process has seen. */
  diffAt?: number;
}

/** Text of a tool_result block's content (string or text blocks). */
export function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b: Json) => (typeof b?.text === "string" ? b.text : typeof b === "string" ? b : "")).join("\n");
  return content == null ? "" : JSON.stringify(content);
}

/** Plain text of a message's content (string or text blocks); tool_result / media blocks are skipped. */
function plainText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b: Json) => (b?.type === "text" && typeof b.text === "string" ? b.text : ""))
    .filter(Boolean)
    .join("\n");
}

/**
 * Native tools: the previous response ended with tool_use blocks whose MCP calls are
 * parked on the node. If this request is the same history plus the client's
 * tool_result message, answer the parked calls instead of feeding text.
 *
 * The tool_result message is the last `user` message, but it need not be the last
 * message: Claude Code (per-turn-control, 2.1.x) appends `role: "system"` messages
 * after it. Before 2026-10-22 only the very last message was inspected, so such a
 * request became a plain `continue` and its text was written to a process blocked
 * inside an MCP call — the request hung until the client gave up (10-22 incident).
 * Text riding along (text blocks beside the results, trailing system messages) is
 * appended to the last result so the model still sees it.
 */
export function planToolResult(mem: TurnMemory | undefined, blocks: Json[], messages: Json[], now = Date.now()): TurnPlan | null {
  if (!mem || mem.expiresAt <= now || !mem.pendingCalls?.length) return null;
  const msgs = Array.isArray(messages) ? messages : [];
  let i = msgs.length - 1;
  const trailing: string[] = [];
  while (i >= 0 && msgs[i]?.role !== "user" && msgs[i]?.role !== "assistant") {
    const t = plainText(msgs[i]?.content);
    if (t) trailing.unshift(t);
    i--;
  }
  const last = i >= 0 ? msgs[i] : undefined;
  const content = Array.isArray(last?.content) ? (last!.content as Json[]) : [];
  const results = content.filter((b) => b?.type === "tool_result" && typeof b.tool_use_id === "string");
  if (last?.role !== "user" || results.length === 0) return null;
  const base = planTurn(mem, blocks, now);
  if (base.mode !== "continue") return null;
  const byUse = new Map(mem.pendingCalls.map((c) => [c.toolUseId, c.callId]));
  const mapped: Array<{ callId: string; content: string; isError: boolean }> = [];
  for (const r of results) {
    const callId = byUse.get(String(r.tool_use_id));
    if (callId) mapped.push({ callId, content: toolResultText(r.content), isError: r.is_error === true });
  }
  if (mapped.length === 0) return null;
  const extra = [plainText(content), ...trailing].filter(Boolean).join("\n\n");
  if (extra) mapped[mapped.length - 1].content += `\n\n${extra}`;
  return { mode: "tool_result", content: blocks, expectedTurn: mem.turn, hashes: base.hashes, results: mapped };
}

/**
 * Text that must not decide whether a history still matches: Claude Code attaches
 * `<system-reminder>…</system-reminder>` notes inside tool_result / user content
 * on some requests and not on others (the same tool_result block came back 509–578
 * chars longer on alternate requests, 2026-10-23), so hashes are taken over the
 * text with those notes removed. The block itself is sent untouched.
 */
export function normalizeForHash(text: string): string {
  // A tool_result message is identified by its result ids alone: Claude Code later replaces old
  // result bodies with a short placeholder (2301 → 17 chars, 2026-10-23), and the live process
  // already holds the full text from the turn that delivered it.
  if (text.startsWith("[user]\n[tool_result for ")) {
    const ids = text.match(/^\[tool_result for [^\]]*\]$/gm);
    if (ids && ids.length) return `[user]\n${ids.join("\n")}`;
  }
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").replace(/\s+$/, "");
}

/**
 * The echoed assistant message vs. the fold the gateway remembered: tool_use
 * inputs are compared by id + name only. Claude Code echoes a tool call with
 * its defaults filled in and keys reordered (`{"replace_all":false,"file_path":…}`
 * for an Edit the model emitted as `{"file_path":…}`, 2026-10-23), which is the
 * same call.
 */
export function normalizeFold(text: string): string {
  return text
    .replace(/^\[tool_use ([^\]]+)\]\n.*$/gm, "[tool_use $1]")
    .replace(/^```tool_call\n(\{.*\})\n```$/gm, (m, j: string) => {
      try {
        const o = JSON.parse(j) as Json;
        return `[tool_call ${String(o.id ?? "")} ${String(o.name ?? "")}]`;
      } catch {
        return m;
      }
    })
    .replace(/\s+$/, "");
}

export const blockHash = (b: Json): string => sha256Hex(b && b.type === "text" && typeof b.text === "string" ? JSON.stringify({ type: "text", text: normalizeForHash(b.text) }) : JSON.stringify(b));

/**
 * Decide fresh vs continue for the current request's content blocks.
 * Continue requires: memory present and live, the request's leading blocks
 * identical to everything the process has seen, the next block being the
 * client's verbatim echo of the last answer, and at least one new block after it.
 */
export function planTurn(mem: TurnMemory | undefined, blocks: Json[], now = Date.now()): TurnPlan {
  const hashes = blocks.map(blockHash);
  if (!mem) return { mode: "fresh", content: blocks, hashes, reason: "no_memory" };
  if (mem.expiresAt <= now) return { mode: "fresh", content: blocks, hashes, reason: "expired" };
  const n = mem.hashes.length;
  const firstDiff = mem.hashes.findIndex((h, i) => h !== hashes[i]);
  if (firstDiff >= 0) return { mode: "fresh", content: blocks, hashes, reason: `prefix@${firstDiff}/${n}`, diffAt: firstDiff };
  if (blocks.length < n + 2) return { mode: "fresh", content: blocks, hashes, reason: blocks.length === n + 1 ? "no_tail" : `short:${blocks.length}/${n}` };
  const echo = blocks[n];
  if (!(echo?.type === "text" && normalizeFold(String(echo.text)) === normalizeFold(mem.assistantFold))) return { mode: "fresh", content: blocks, hashes, reason: "echo" };
  return { mode: "continue", content: blocks.slice(n + 1), expectedTurn: mem.turn, hashes };
}

/**
 * Durable copy of the memory (core worker_turn_memory, 2026-10-22): the Map is the hot
 * cache, every remember/forget is written through, a miss is looked up here. A
 * blue/green release therefore continues conversations on their live node
 * processes instead of replaying every history into a fresh one.
 */
export interface TurnMemoryStore {
  load(key: string, now: number): TurnMemory | undefined;
  save(key: string, entry: TurnMemory): void;
  delete(key: string): void;
}

/** Per-gateway memory with an optional write-through store; entries expire with the node's idle TTL. */
export class SessionMemory {
  private readonly map = new Map<string, TurnMemory>();
  constructor(
    private readonly ttlMs = 600_000,
    private readonly maxEntries = 20_000,
    private readonly store?: TurnMemoryStore,
  ) {}

  get(key: string): TurnMemory | undefined {
    const now = Date.now();
    const m = this.map.get(key);
    if (m && m.expiresAt > now) return m;
    if (m) this.map.delete(key);
    if (!this.store) return undefined;
    const stored = this.store.load(key, now);
    if (stored && stored.expiresAt > now) {
      this.map.set(key, stored);
      return stored;
    }
    return undefined;
  }

  /** Record a turn: what was sent (all blocks) + the answer + the node's turn counter (+ parked tool calls). */
  remember(key: string, entry: TurnMemoryInput): void {
    if (this.map.size >= this.maxEntries) {
      const now = Date.now();
      for (const [k, v] of this.map) if (v.expiresAt <= now) this.map.delete(k);
      if (this.map.size >= this.maxEntries) this.map.delete(this.map.keys().next().value as string);
    }
    const full: TurnMemory = { ...entry, expiresAt: Date.now() + this.ttlMs };
    this.map.set(key, full);
    this.store?.save(key, full);
  }

  forget(key: string): void {
    this.map.delete(key);
    this.store?.delete(key);
  }

  /** Tests only: drop the process cache but keep the store — what a gateway restart looks like. */
  dropCacheForTests(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
