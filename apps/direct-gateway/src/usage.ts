import type { TokenUsage } from "./types.js";

const MAX_USAGE_TOKENS = 1_000_000_000;

function validateTokenUsage(usage: TokenUsage): void {
  if (!usage || typeof usage !== "object") throw new TypeError("usage must be an object");
  for (const field of ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "cache_write_5m_tokens", "cache_write_1h_tokens"] as const) {
    const n = usage[field];
    if (n === undefined && field !== "input_tokens" && field !== "output_tokens") continue;
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0 || n > MAX_USAGE_TOKENS) throw new RangeError(`invalid usage count: ${field}`);
  }
  const prompt = usage.input_tokens + (usage.cache_read_tokens ?? 0) + (usage.cache_write_tokens ?? ((usage.cache_write_5m_tokens ?? 0) + (usage.cache_write_1h_tokens ?? 0)));
  if (prompt > MAX_USAGE_TOKENS) throw new RangeError("invalid usage count: total prompt tokens");
}

type Json = Record<string, any>;

// Usage extraction normalizes every wire format to Anthropic semantics:
// input_tokens excludes cache reads, which are billed separately.

/**
 * Split a cache-creation total into its 5-minute / 1-hour buckets (official `usage.cache_creation`).
 * `total` undefined = the wire carried only the nested object. The buckets always add up to the total:
 * a total without a split (or with a split that covers less) goes to the 5-minute tier — the official
 * default TTL and the cheaper price; a split larger than the total is cut down, 1-hour first kept.
 */
export function splitCacheCreation(total: number | undefined, m5: number | undefined, h1: number | undefined): { total: number; m5: number; h1: number } {
  const a = m5 ?? 0, b = h1 ?? 0;
  const t = total ?? a + b;
  const hour = Math.min(b, t);
  return { total: t, m5: t - hour, h1: hour };
}

/** Accumulates usage across a response or a stream of events. */
export class UsageAccumulator {
  input = 0;
  output = 0;
  cacheRead = 0;
  /** Total cache creation (`cache_creation_input_tokens`). */
  cacheWrite = 0;
  /** Nested `cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`, when the wire carried them. */
  private cacheWrite5m: number | undefined;
  private cacheWrite1h: number | undefined;
  private cacheWriteTotalSeen = false;
  seen = false;
  text = ""; // generated text, for estimation when upstream reports nothing
  actualModel: string | null = null;
  toolCalls = 0;
  toolResults = 0;
  private requestObserved = false;
  private readonly openAIToolIndexes = new Set<unknown>();
  private readonly responseToolItems = new Set<string>();

  invalid = false;

  private count(value: unknown): number | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_USAGE_TOKENS) {
      this.invalid = true;
      return undefined;
    }
    return value;
  }

  /** Anthropic message / message_start.message / message_delta usage object. */
  addAnthropic(u: Json | undefined): void {
    if (!u || typeof u !== "object" || Array.isArray(u)) return;
    const fields = [["input_tokens", "input"], ["output_tokens", "output"],
      ["cache_read_input_tokens", "cacheRead"], ["cache_creation_input_tokens", "cacheWrite"]] as const;
    for (const [wire, field] of fields) {
      const n = this.count(u[wire]);
      if (n !== undefined) {
        this[field] = n; this.seen = true;
        if (field === "cacheWrite") this.cacheWriteTotalSeen = true;
      }
    }
    // Official split of the total by TTL. message_start carries it; a later message_delta that repeats only the
    // total keeps the split seen so far (reconciled against the final total in finalize()).
    const split = u.cache_creation;
    if (split && typeof split === "object" && !Array.isArray(split)) {
      const m5 = this.count(split.ephemeral_5m_input_tokens), h1 = this.count(split.ephemeral_1h_input_tokens);
      if (m5 !== undefined || h1 !== undefined) {
        this.cacheWrite5m = m5 ?? 0;
        this.cacheWrite1h = h1 ?? 0;
        this.seen = true;
      }
    }
  }

  /** OpenAI chat usage object. Cache tokens are a subset of the prompt count. */
  addOpenaiChat(u: Json | undefined): void {
    if (!u || typeof u !== "object" || Array.isArray(u)) return;
    this.addOpenai(u.prompt_tokens, u.completion_tokens, u.prompt_tokens_details?.cached_tokens);
  }

  /** OpenAI Responses usage object. */
  addResponses(u: Json | undefined): void {
    if (!u || typeof u !== "object" || Array.isArray(u)) return;
    this.addOpenai(u.input_tokens, u.output_tokens, u.input_tokens_details?.cached_tokens);
  }

  private addOpenai(input: unknown, output: unknown, cached: unknown): void {
    const prompt = this.count(input), completion = this.count(output), read = this.count(cached) ?? 0;
    if (prompt === undefined || completion === undefined || read > prompt) { this.invalid = true; return; }
    this.input = prompt - read;
    this.output = completion;
    this.cacheRead = read;
    this.seen = true;
  }

  addText(t: unknown): void {
    if (typeof t === "string" && this.text.length < 2_000_000) this.text += t.slice(0, 2_000_000 - this.text.length);
  }

  observeModel(value: unknown): void {
    if (typeof value === "string" && value) this.actualModel = value;
  }

  observeRequest(body: unknown): void {
    if (this.requestObserved) return;
    this.requestObserved = true;
    if (!body || typeof body !== "object") return;
    const b = body as Json;
    const messages = Array.isArray(b.messages) ? b.messages : Array.isArray(b.input) ? b.input : [];
    for (const m of messages) {
      if (!m || typeof m !== "object") continue;
      if (m.role === "tool" || m.type === "function_call_output") this.toolResults++;
      if (Array.isArray(m.content)) for (const block of m.content) if (block?.type === "tool_result") this.toolResults++;
    }
  }

  addAnthropicContent(content: unknown): void {
    if (!Array.isArray(content)) return;
    for (const block of content) if (block?.type === "tool_use") this.toolCalls++;
  }

  addOpenAIToolCalls(calls: unknown): void {
    if (!Array.isArray(calls)) return;
    for (const call of calls) {
      const key = call && typeof call === "object" ? call.index ?? call.id : call;
      if (this.openAIToolIndexes.has(key)) continue;
      this.openAIToolIndexes.add(key);
      this.toolCalls++;
    }
  }

  addResponsesItem(item: unknown): void {
    if (!item || typeof item !== "object" || (item as Json).type !== "function_call") return;
    const value = item as Json;
    const key = String(value.id ?? value.call_id ?? JSON.stringify(value));
    if (this.responseToolItems.has(key)) return;
    this.responseToolItems.add(key);
    this.toolCalls++;
  }

  /**
   * Final usage; estimates (chars / 4) when upstream never reported usage.
   *
   * `partial` (review 2026-11-09 E): the stream stopped before its terminal event. On the Anthropic wire the
   * output count seen so far is message_start's placeholder (≈1 token) — the real figure only arrives with the
   * final message_delta — so the reported output is raised to the estimate of the text and thinking that was
   * actually forwarded, and the row is flagged estimated. Never lowered: a reported count above the estimate stands.
   */
  finalize(requestBody: unknown, opts: { partial?: boolean } = {}): { usage: TokenUsage; estimated: boolean } {
    const w = splitCacheCreation(this.cacheWriteTotalSeen ? this.cacheWrite : undefined, this.cacheWrite5m, this.cacheWrite1h);
    const usage = { input_tokens: this.input, output_tokens: this.output,
      cache_read_tokens: this.cacheRead, cache_write_tokens: w.total, cache_write_5m_tokens: w.m5, cache_write_1h_tokens: w.h1 };
    try { validateTokenUsage(usage); } catch { this.invalid = true; }
    if (this.seen && !this.invalid) {
      if (opts.partial) {
        const produced = Math.min(MAX_USAGE_TOKENS, estimateTokens(this.text));
        if (produced > usage.output_tokens) return { usage: { ...usage, output_tokens: produced }, estimated: true };
      }
      return { usage, estimated: false };
    }
    return {
      usage: {
        input_tokens: estimateRequestTokens(requestBody),
        output_tokens: estimateTokens(this.text),
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        cache_write_5m_tokens: 0,
        cache_write_1h_tokens: 0,
      },
      estimated: true,
    };
  }
}

export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

/** Anthropic bills an image by pixels, ~1.6k tokens at the 1568px cap; a PDF page similar. Flat per block here. */
const MEDIA_BLOCK_TOKENS = 1_600;

/**
 * Request-side estimate when upstream never reported usage: text at chars/4,
 * but base64 media (Anthropic `source.data`, OpenAI `image_url: data:…`) at a
 * flat per-block cost instead of its byte length — 2026-10-17 two aborted
 * requests carrying ~8 MB of images were billed 2.18M "tokens" ($8.71 each).
 */
export function estimateRequestTokens(body: unknown): number {
  let chars = 0;
  let media = 0;
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      chars += v.length;
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    if (!v || typeof v !== "object") return;
    const o = v as Json;
    const type = typeof o.type === "string" ? o.type : "";
    if ((type === "image" || type === "document") && o.source && typeof o.source === "object") {
      media += 1;
      // Count the block's non-payload fields (media_type, cache_control…) but not the data.
      const { data: _d, ...rest } = o.source as Json;
      walk(rest);
      return;
    }
    if (type === "image_url" || type === "input_image") {
      const url = typeof o.image_url === "string" ? o.image_url : typeof o.image_url?.url === "string" ? o.image_url.url : typeof o.image_url === "object" ? "" : String(o.image_url ?? "");
      media += 1;
      if (url && !url.startsWith("data:")) chars += url.length;
      return;
    }
    for (const x of Object.values(o)) walk(x);
  };
  walk(body ?? "");
  return Math.min(MAX_USAGE_TOKENS, Math.ceil(chars / 4) + media * MEDIA_BLOCK_TOKENS);
}

/** Collect generated text from a non-stream body for estimation. */
export function collectText(json: Json): string {
  if (Array.isArray(json.content)) {
    return json.content.map((b: Json) => (typeof b?.text === "string" ? b.text : "")).join("");
  }
  if (Array.isArray(json.choices)) {
    return json.choices.map((c: Json) => (typeof c?.message?.content === "string" ? c.message.content : "")).join("");
  }
  if (Array.isArray(json.output)) {
    return json.output
      .flatMap((o: Json) => (Array.isArray(o?.content) ? o.content : []))
      .map((c: Json) => (typeof c?.text === "string" ? c.text : ""))
      .join("");
  }
  return "";
}
