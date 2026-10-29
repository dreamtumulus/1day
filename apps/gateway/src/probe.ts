// Liveness-probe interception (docs/gateway.md §2c, 2026-10-29).
//
// Health checkers poll the API with a tiny identical request every few seconds, often cycling through
// model ids. On the worker path each such request starts a Claude Code session on some account; one
// probing client touched 63 accounts in a single hour. A probe is recognised either explicitly
// (`x-1day-probe: 1`) or by repetition — the same tiny body from the same key seen again within the
// window — and is answered here from pool state: 200 "ok" when the key's group has an account ready
// for the model, 503 no_available_account otherwise. No account, worker or upstream is touched.
import { createHash } from "node:crypto";
import { listCandidates, nowIso } from "@1dayapi/core";
import { requestMessages } from "./conversation.js";

type Json = Record<string, any>;
type Format = "anthropic" | "openai-chat" | "responses";

function envInt(name: string, def: number, min: number, max: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : def;
}
/** Repetition window: a tiny body seen this often inside it is a probe. */
export const PROBE_WINDOW_MS = envInt("PROBE_INTERCEPT_WINDOW_MS", 600_000, 60_000, 6 * 3_600_000);
export const PROBE_MIN_REPEATS = envInt("PROBE_INTERCEPT_MIN_REPEATS", 2, 1, 100);
/** Tiny = at most this much user text and this small an output cap. */
export const PROBE_MAX_CHARS = envInt("PROBE_INTERCEPT_MAX_CHARS", 64, 1, 4096);
export const PROBE_MAX_OUTPUT = envInt("PROBE_INTERCEPT_MAX_OUTPUT", 64, 1, 100_000);
/** Reply text: the probed model and whether it is serving; never the pool size. */
export const probeReply = (model: string, ok: boolean): string => `${model}: ${ok ? "ok" : "unavailable"}`;

export interface ProbeShape { hash: string; chars: number }

function textOf(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  let out = "";
  for (const block of content) {
    if (!block || typeof block !== "object") return null;
    const type = (block as Json).type;
    if (type === "text" || type === "input_text" || type === "output_text") out += String((block as Json).text ?? "");
    else return null; // images, tool calls, tool results, documents: never a probe
  }
  return out;
}

/** The request as a probe candidate (tiny, text-only, no tools), or null. */
export function probeShape(body: Json, format: Format): ProbeShape | null {
  if (Array.isArray(body.tools) && body.tools.length) return null;
  const msgs = requestMessages(body, format).filter((m) => m && typeof m === "object" && !["system", "developer"].includes(m.role));
  if (!msgs.length || msgs.length > 2) return null;
  const parts: [string, string][] = [];
  let chars = 0;
  for (const m of msgs) {
    const t = textOf(m.content);
    if (t === null) return null;
    chars += t.length;
    parts.push([String(m.role), t]);
  }
  if (chars === 0 || chars > PROBE_MAX_CHARS) return null;
  const cap = Number(body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens ?? 0);
  if (Number.isFinite(cap) && cap > PROBE_MAX_OUTPUT) return null;
  const hash = createHash("sha256").update(JSON.stringify({ model: body.model ?? "", stream: body.stream === true, parts })).digest("hex").slice(0, 24);
  return { hash, chars };
}

const seen = new Map<string, Map<string, { n: number; last: number }>>();
const MAX_SHAPES_PER_KEY = 256;

/** Count this shape for the key inside the window; returns how many times it has now been seen. */
export function recordProbeShape(apiKeyId: string, hash: string, now = Date.now()): number {
  let m = seen.get(apiKeyId);
  if (!m) { m = new Map(); seen.set(apiKeyId, m); }
  for (const [h, e] of m) if (now - e.last > PROBE_WINDOW_MS) m.delete(h);
  const e = m.get(hash) ?? { n: 0, last: now };
  e.n += 1; e.last = now;
  m.set(hash, e);
  if (m.size > MAX_SHAPES_PER_KEY) {
    const oldest = [...m.entries()].sort((a, b) => a[1].last - b[1].last)[0];
    if (oldest) m.delete(oldest[0]);
  }
  return e.n;
}

/** Tests only. */
export function resetProbeMemory(): void { seen.clear(); }

export type ProbeVerdict = { reason: "header" | "repeat"; repeats: number; shape: ProbeShape | null };

/** Emergency / test switch: PROBE_INTERCEPT=0 disables interception for every key. */
export const PROBE_INTERCEPT_ENABLED = process.env.PROBE_INTERCEPT !== "0";

export function detectProbe(apiKeyId: string, body: Json, format: Format, headers: Record<string, unknown>): ProbeVerdict | null {
  if (!PROBE_INTERCEPT_ENABLED) return null;
  const h = headers["x-1day-probe"];
  const flag = Array.isArray(h) ? h[0] : h;
  if (flag === "1" || flag === "true") return { reason: "header", repeats: 0, shape: probeShape(body, format) };
  const shape = probeShape(body, format);
  if (!shape) return null;
  const n = recordProbeShape(apiKeyId, shape.hash);
  return n >= PROBE_MIN_REPEATS ? { reason: "repeat", repeats: n, shape } : null;
}

export interface PoolHealth { total: number; ready: number; cooling: number }

/** What a probe reports: accounts the group could schedule for the model right now. */
export function poolHealth(groupId: string, model: string): PoolHealth {
  const now = nowIso();
  const future = (t: string | null | undefined) => !!t && t > now;
  const cands = listCandidates(groupId, model);
  let ready = 0, cooling = 0;
  for (const a of cands) {
    if (a.cooling || future(a.temp_unschedulable_until) || future(a.window_exhausted_until) || future(a.overload_until) || future(a.rate_limited_until)) cooling++;
    else ready++;
  }
  return { total: cands.length, ready, cooling };
}
