// Worker-path turn capture (2026-11-03): a sampled record of what the customer asked, what the gateway actually sent
// to the node's Claude Code process, and what came back — so "is the worker answering what the user asked?" can be
// reviewed on real traffic instead of inferred from status codes. Pure diagnostics: never changes the turn, never
// throws into the request path. Records are NDJSON under <DATA_DIR>/captures/worker-<UTC day>.ndjson (0600), swept
// after settings.worker_capture_keep_days. Review: ops/bin/worker-capture-review.
import { appendFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { dataDir, getSetting, sha256Hex } from "@1dayapi/core";
import type { SessionTranslator } from "./translate.js";
import type { TurnPlan } from "./session-memory.js";

type Json = Record<string, any>;

const TEXT_MAX = 6000;
const BLOCK_MAX = 3000;
const SYSTEM_MAX = 2000;
const LAST_MESSAGES = 4;
const SWEEP_EVERY_MS = 60 * 60 * 1000;

export function captureDir(): string {
  return join(dataDir, "captures");
}

/** Deterministic per request id: a retry of the same request on another account captures the same way. */
function fraction(requestId: string): number {
  return parseInt(sha256Hex(requestId).slice(0, 8), 16) / 0xffffffff;
}

/** settings.worker_capture_keys (comma-separated key ids or id prefixes) always capture; otherwise sample by rate. */
export function captureWanted(apiKeyId: string | null | undefined, requestId: string, settings: { sample: string; keys: string } = { sample: getSetting("worker_capture_sample"), keys: getSetting("worker_capture_keys") }): boolean {
  const keys = settings.keys.split(",").map((s) => s.trim()).filter(Boolean);
  if (apiKeyId && keys.some((k) => apiKeyId === k || apiKeyId.startsWith(k))) return true;
  const rate = Number(settings.sample);
  if (!Number.isFinite(rate) || rate <= 0) return false;
  if (rate >= 1) return true;
  return fraction(requestId) < rate;
}

export function clip(s: unknown, max: number): string {
  const t = typeof s === "string" ? s : s === undefined ? "" : JSON.stringify(s);
  return t.length <= max ? t : `${t.slice(0, max)}…[+${t.length - max} chars]`;
}

function blockText(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b) => (b && typeof b === "object" && typeof (b as Json).text === "string" ? (b as Json).text : b && typeof b === "object" ? `[${(b as Json).type ?? "block"}]` : "")).join("\n");
  return "";
}

/** One Anthropic content block, clipped: enough to judge the turn, not the whole payload. */
export function summarizeBlock(b: unknown, max = BLOCK_MAX): Json {
  if (typeof b === "string") return { type: "text", text: clip(b, max) };
  if (!b || typeof b !== "object") return { type: typeof b };
  const j = b as Json;
  switch (j.type) {
    case "text":
      return { type: "text", text: clip(j.text ?? "", max) };
    case "tool_use":
      return { type: "tool_use", id: j.id, name: j.name, input: clip(j.input ?? {}, max) };
    case "tool_result":
      return { type: "tool_result", tool_use_id: j.tool_use_id, is_error: j.is_error === true, content: clip(blockText(j.content), max) };
    case "thinking":
      return { type: "thinking", chars: typeof j.thinking === "string" ? j.thinking.length : 0, signature: typeof j.signature === "string" ? j.signature.length : 0 };
    case "redacted_thinking":
      return { type: "redacted_thinking" };
    case "image":
    case "document": {
      const src = j.source && typeof j.source === "object" ? (j.source as Json) : {};
      return { type: j.type, media_type: src.media_type, bytes: typeof src.data === "string" ? src.data.length : undefined };
    }
    default:
      return { type: j.type ?? "unknown", json: clip(j, Math.min(max, 400)) };
  }
}

function summarizeMessage(m: Json): Json {
  const content = Array.isArray(m.content) ? m.content.map((b: unknown) => summarizeBlock(b)) : [summarizeBlock(m.content)];
  return { role: m.role, content };
}

function lastUserText(messages: Json[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    const text = Array.isArray(m.content) ? m.content.filter((b: Json) => b && b.type === "text").map((b: Json) => b.text).join("\n") : typeof m.content === "string" ? m.content : "";
    if (text.trim()) return clip(text, 2000);
  }
  return "";
}

export interface CaptureStart {
  requestId: string;
  apiKeyId?: string | null;
  userId?: string | null;
  groupId?: string | null;
  account: { id: string; name: string };
  clientModel: string;
  upstreamModel: string;
  stream: boolean;
  canonical: boolean;
  persistent: boolean;
  nativeTools: boolean;
  body: Json;
  systemText: string;
  plan: TurnPlan;
  /** The folded blocks (or canonical raw content) handed to the node this turn. */
  sent: unknown;
  maxTokens: number;
  stopSequences: string[];
  thinking: { thinkingWanted: boolean; thinkingBudget: number; effort: string };
}

export interface CaptureFinish {
  status: number;
  error?: string | null;
  stalled?: boolean;
}

/** Build the request half now (before the node runs), the response half at `finish`. */
export class TurnCapture {
  private readonly startedAt = Date.now();
  private readonly rec: Json;
  private done = false;

  constructor(s: CaptureStart) {
    const msgs: Json[] = Array.isArray(s.body.messages) ? s.body.messages : [];
    const tools: Json[] = Array.isArray(s.body.tools) ? s.body.tools : [];
    const sentBlocks = Array.isArray(s.sent) ? s.sent : s.sent == null ? [] : [s.sent];
    const sentText = sentBlocks.map((b) => blockText([b]) || (typeof (b as Json)?.text === "string" ? (b as Json).text : ""));
    const sentChars = sentText.reduce((n, t) => n + t.length, 0);
    this.rec = {
      ts: new Date(this.startedAt).toISOString(),
      requestId: s.requestId,
      apiKeyId: s.apiKeyId ?? null,
      userId: s.userId ?? null,
      groupId: s.groupId ?? null,
      account: s.account,
      model: { client: s.clientModel, upstream: s.upstreamModel },
      stream: s.stream,
      lane: { canonical: s.canonical, persistent: s.persistent, nativeTools: s.nativeTools },
      request: {
        systemChars: s.systemText.length,
        systemHead: clip(s.systemText, SYSTEM_MAX),
        messages: msgs.length,
        roles: msgs.map((m) => (m?.role === "assistant" ? "a" : m?.role === "user" ? "u" : "s")).join(""),
        tools: tools.map((t) => t?.name).filter((n) => typeof n === "string"),
        maxTokens: s.maxTokens,
        stopSequences: s.stopSequences,
        thinking: s.thinking,
        last: msgs.slice(-LAST_MESSAGES).map(summarizeMessage),
        lastUserText: lastUserText(msgs),
      },
      plan: { mode: s.plan.mode, reason: s.plan.reason ?? null, diffAt: s.plan.diffAt ?? null, expectedTurn: s.plan.expectedTurn ?? null, results: s.plan.results?.length ?? 0 },
      sent: {
        blocks: sentBlocks.length,
        chars: sentChars,
        head: sentText.length ? clip(sentText[0], 1500) : "",
        tail: sentText.slice(-2).map((t) => clip(t, 2500)),
      },
      response: null,
    };
  }

  /** Response half; safe to call once, never throws. */
  finish(translator: SessionTranslator | null, f: CaptureFinish): void {
    if (this.done) return;
    this.done = true;
    let content: Json[] | null = null;
    let stopReason: string | null = null;
    let stopSequence: string | null = null;
    let usage: Json | null = null;
    try {
      if (translator) {
        const m = translator.message() as Json;
        content = Array.isArray(m.content) ? m.content.map((b: unknown) => summarizeBlock(b, TEXT_MAX)) : null;
        stopReason = m.stop_reason ?? null;
        stopSequence = m.stop_sequence ?? null;
        usage = m.usage ?? null;
      }
    } catch (err) {
      content = [{ type: "capture_error", text: (err as Error).message }];
    }
    const texts = (content ?? []).filter((b) => b.type === "text").map((b) => String(b.text ?? ""));
    this.rec.response = {
      status: f.status,
      error: f.error ?? translator?.error ?? null,
      durationMs: Date.now() - this.startedAt,
      stopReason,
      stopSequence,
      content,
      textChars: texts.reduce((n, t) => n + t.length, 0),
      toolUses: (content ?? []).filter((b) => b.type === "tool_use").length,
      guardHits: translator?.guardHits ?? [],
      cutShort: translator?.cutShort ?? false,
      awaitingTools: translator?.awaitingTools?.length ?? 0,
      stalled: f.stalled === true,
      freshProcess: translator?.freshProcess ?? null,
      result: translator?.result ? { subtype: translator.result.subtype, isError: translator.result.isError } : null,
      upstreamRetries: translator?.turnFacts.upstreamRetries ?? 0,
      usage,
    };
    void writeRecord(this.rec);
  }
}

let lastSweep = 0;
let writeFailed = false;

async function writeRecord(rec: Json): Promise<void> {
  try {
    const dir = captureDir();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const day = String(rec.ts).slice(0, 10);
    await appendFile(join(dir, `worker-${day}.ndjson`), `${JSON.stringify(rec)}\n`, { mode: 0o600 });
    writeFailed = false;
    if (Date.now() - lastSweep > SWEEP_EVERY_MS) {
      lastSweep = Date.now();
      void sweep(dir);
    }
  } catch (err) {
    if (!writeFailed) console.warn(`[capture] write failed: ${(err as Error).message}`);
    writeFailed = true;
  }
}

/** Delete capture files older than settings.worker_capture_keep_days (default 7). */
export async function sweep(dir = captureDir(), keepDays = Number(getSetting("worker_capture_keep_days")) || 7): Promise<number> {
  let removed = 0;
  try {
    const cutoff = Date.now() - keepDays * 86_400_000;
    for (const f of await readdir(dir)) {
      if (!/^worker-\d{4}-\d{2}-\d{2}\.ndjson$/.test(f)) continue;
      const st = await stat(join(dir, f));
      if (st.mtimeMs < cutoff) {
        await unlink(join(dir, f));
        removed++;
      }
    }
  } catch (err) {
    console.warn(`[capture] sweep failed: ${(err as Error).message}`);
  }
  return removed;
}
