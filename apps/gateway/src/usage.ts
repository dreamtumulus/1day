import { MAX_USAGE_TOKENS, validateTokenUsage, type TokenUsage } from "@1dayapi/core";

type Json = Record<string, any>;

// Usage extraction normalizes every wire format to Anthropic semantics:
// input_tokens excludes cache reads, which are billed separately.

/** Accumulates usage across a response or a stream of events. */
export class UsageAccumulator {
  input = 0;
  output = 0;
  cacheRead = 0;
  cacheWrite = 0;
  seen = false;
  text = ""; // generated text, for estimation when upstream reports nothing

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
      if (n !== undefined) { this[field] = n; this.seen = true; }
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

  /** Final usage; estimates (chars / 4) when upstream never reported usage. */
  finalize(requestBody: unknown): { usage: TokenUsage; estimated: boolean } {
    const usage = { input_tokens: this.input, output_tokens: this.output,
      cache_read_tokens: this.cacheRead, cache_write_tokens: this.cacheWrite };
    try { validateTokenUsage(usage); } catch { this.invalid = true; }
    if (this.seen && !this.invalid) return { usage, estimated: false };
    return {
      usage: {
        input_tokens: estimateRequestTokens(requestBody),
        output_tokens: estimateTokens(this.text),
        cache_read_tokens: 0,
        cache_write_tokens: 0,
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
