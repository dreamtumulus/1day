import type { TokenUsage } from "@1dayapi/core";

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

  /** Anthropic message / message_start.message / message_delta usage object. */
  addAnthropic(u: Json | undefined): void {
    if (!u || typeof u !== "object") return;
    this.seen = true;
    if (typeof u.input_tokens === "number") this.input = u.input_tokens;
    if (typeof u.output_tokens === "number") this.output = u.output_tokens;
    if (typeof u.cache_read_input_tokens === "number") this.cacheRead = u.cache_read_input_tokens;
    if (typeof u.cache_creation_input_tokens === "number") this.cacheWrite = u.cache_creation_input_tokens;
  }

  /** OpenAI chat usage object. */
  addOpenaiChat(u: Json | undefined): void {
    if (!u || typeof u !== "object") return;
    this.seen = true;
    const cached = Number(u.prompt_tokens_details?.cached_tokens ?? 0);
    this.input = Math.max(Number(u.prompt_tokens ?? 0) - cached, 0);
    this.output = Number(u.completion_tokens ?? 0);
    this.cacheRead = cached;
  }

  /** OpenAI Responses usage object. */
  addResponses(u: Json | undefined): void {
    if (!u || typeof u !== "object") return;
    this.seen = true;
    const cached = Number(u.input_tokens_details?.cached_tokens ?? 0);
    this.input = Math.max(Number(u.input_tokens ?? 0) - cached, 0);
    this.output = Number(u.output_tokens ?? 0);
    this.cacheRead = cached;
  }

  addText(t: unknown): void {
    if (typeof t === "string" && this.text.length < 2_000_000) this.text += t;
  }

  /** Final usage; estimates (chars / 4) when upstream never reported usage. */
  finalize(requestBody: unknown): { usage: TokenUsage; estimated: boolean } {
    if (this.seen && (this.input > 0 || this.output > 0 || this.cacheRead > 0)) {
      return {
        usage: {
          input_tokens: this.input,
          output_tokens: this.output,
          cache_read_tokens: this.cacheRead,
          cache_write_tokens: this.cacheWrite,
        },
        estimated: false,
      };
    }
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
  return Math.ceil(chars / 4) + media * MEDIA_BLOCK_TOKENS;
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
