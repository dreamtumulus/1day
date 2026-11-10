// OpenAI Responses API ↔ Anthropic Messages (docs/canonical-implementation-spec-2026-11-01.md WP4.3, "Responses 第一档").
// Internal representation is Anthropic Messages: a Responses request is validated → mapped → decided here; the answer
// (Anthropic JSON or SSE, from a direct account or the worker translator) is mapped back to a Responses object / event
// stream. Written against the public Responses API shape; sub2api's apicompat was read for its state-machine design,
// nothing copied (LGPL). First tier = self-contained `input` + `instructions`, text / image parts, function tools,
// `function_call_output`, streaming and non-streaming. Not implemented → ResponsesUnsupported (400 unsupported_parameter):
// previous_response_id, background, store=true, built-in OpenAI tools, files / containers, json_schema text format.
import { randomUUID } from "node:crypto";

type Json = Record<string, any>;

export class ResponsesUnsupported extends Error {
  constructor(public readonly parameter: string, public readonly reason: string) {
    super(`${parameter}: ${reason}`);
    this.name = "ResponsesUnsupported";
  }
}

function rid(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function safeParse(s: unknown): Json | null {
  if (typeof s !== "string") return typeof s === "object" && s ? (s as Json) : null;
  try { const v = JSON.parse(s); return v && typeof v === "object" ? v : null; } catch { return null; }
}

function partToBlock(p: Json, path: string): Json | null {
  if (!p || typeof p !== "object") return null;
  switch (p.type) {
    case "input_text": case "output_text": case "text": return typeof p.text === "string" && p.text ? { type: "text", text: p.text } : null;
    case "input_image": {
      const url: string | undefined = typeof p.image_url === "string" ? p.image_url : typeof p.image_url?.url === "string" ? p.image_url.url : undefined;
      if (p.file_id) throw new ResponsesUnsupported(`${path}.file_id`, "file references are not available; send the image inline (data: URL) or by URL");
      if (!url) return null;
      const m = /^data:([^;]+);base64,(.*)$/s.exec(url);
      return m ? { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } } : { type: "image", source: { type: "url", url } };
    }
    case "input_file": throw new ResponsesUnsupported(`${path}.input_file`, "file inputs are not available on this platform yet");
    case "refusal": return typeof p.refusal === "string" && p.refusal ? { type: "text", text: p.refusal } : null;
    default: throw new ResponsesUnsupported(`${path}.type`, `content part type '${String(p.type)}' is not supported`);
  }
}

/** Responses request → Anthropic Messages request (throws ResponsesUnsupported for anything outside the first tier). */
export function responsesToAnthropic(body: Json, upstreamModel: string): Json {
  if (body.previous_response_id) throw new ResponsesUnsupported("previous_response_id", "responses are not stored on this platform; send the full conversation in `input`");
  if (body.background === true) throw new ResponsesUnsupported("background", "background responses are not available");
  if (body.store === true) throw new ResponsesUnsupported("store", "responses are not stored on this platform; omit `store` or send false");
  if (body.conversation) throw new ResponsesUnsupported("conversation", "server-side conversations are not available");
  if (body.text?.format && body.text.format.type && body.text.format.type !== "text") throw new ResponsesUnsupported("text.format", `'${String(body.text.format.type)}' output is not available on this path yet`);
  const system: string[] = [];
  if (typeof body.instructions === "string" && body.instructions.trim()) system.push(body.instructions);
  const messages: Json[] = [];
  const push = (role: "user" | "assistant", blocks: Json[]) => {
    if (!blocks.length) return;
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };
  const input = body.input;
  if (typeof input === "string") {
    if (input) push("user", [{ type: "text", text: input }]);
  } else if (Array.isArray(input)) {
    input.forEach((item: Json, i: number) => {
      if (!item || typeof item !== "object") return;
      const path = `input[${i}]`;
      const type = item.type ?? (item.role ? "message" : undefined);
      switch (type) {
        case "message": {
          const role = item.role;
          const blocks: Json[] = [];
          if (typeof item.content === "string") { if (item.content) blocks.push({ type: "text", text: item.content }); }
          else if (Array.isArray(item.content)) item.content.forEach((p: Json, j: number) => { const b = partToBlock(p, `${path}.content[${j}]`); if (b) blocks.push(b); });
          if (role === "system" || role === "developer") { const t = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n"); if (t) system.push(t); }
          else if (role === "assistant" || role === "user") push(role, blocks);
          else throw new ResponsesUnsupported(`${path}.role`, `role '${String(role)}' is not supported`);
          break;
        }
        case "function_call":
          push("assistant", [{ type: "tool_use", id: String(item.call_id ?? item.id ?? rid("toolu")), name: String(item.name ?? ""), input: safeParse(item.arguments) ?? {} }]);
          break;
        case "function_call_output":
          push("user", [{ type: "tool_result", tool_use_id: String(item.call_id ?? ""), content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "") }]);
          break;
        case "reasoning":
          break; // reasoning items from a previous response are not replayable: dropped (thinking is never imported)
        case "item_reference": throw new ResponsesUnsupported(`${path}.type`, "item references need stored responses, which this platform does not keep");
        default: throw new ResponsesUnsupported(`${path}.type`, `input item type '${String(type)}' is not supported (built-in tools, files and containers are not available)`);
      }
    });
  } else if (input !== undefined && input !== null) {
    throw new ResponsesUnsupported("input", "input must be a string or an array of items");
  }
  const out: Json = { model: upstreamModel, max_tokens: Number(body.max_output_tokens ?? 8192), messages };
  if (system.length) out.system = system.join("\n\n");
  if (typeof body.temperature === "number") out.temperature = Math.min(body.temperature, 1);
  else if (typeof body.top_p === "number") out.top_p = body.top_p;
  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = (body.tools as Json[]).map((t, i) => {
      if (t?.type !== "function") throw new ResponsesUnsupported(`tools[${i}].type`, `built-in tool '${String(t?.type)}' is not available; only function tools are supported`);
      if (typeof t.name !== "string" || !t.name) throw new ResponsesUnsupported(`tools[${i}].name`, "function tools need a name");
      return { name: t.name, description: t.description ?? "", input_schema: t.parameters ?? { type: "object", properties: {} } };
    });
    const tc = body.tool_choice;
    if (tc === "required") out.tool_choice = { type: "any" };
    else if (tc === "none") out.tool_choice = { type: "none" };
    else if (tc && typeof tc === "object") {
      if (tc.type === "function" && typeof tc.name === "string") out.tool_choice = { type: "tool", name: tc.name };
      else if (tc.type !== "allowed_tools") throw new ResponsesUnsupported("tool_choice", `tool_choice type '${String(tc.type)}' is not supported`);
    }
  }
  if (body.stream === true) out.stream = true;
  return out;
}

/** Same mapping as chat (convert.ts openaiUsageFromAnthropic): input_tokens = input + cache read + cache creation; cached_tokens = cache read. */
export function responsesUsageFromAnthropic(u: Json | undefined): Json {
  const input = Number(u?.input_tokens ?? 0);
  const cacheRead = Number(u?.cache_read_input_tokens ?? 0);
  const cacheWrite = Number(u?.cache_creation_input_tokens ?? 0);
  const output = Number(u?.output_tokens ?? 0);
  const total = input + cacheRead + cacheWrite;
  return { input_tokens: total, input_tokens_details: { cached_tokens: cacheRead }, output_tokens: output, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: total + output };
}

/** Anthropic content blocks → Responses output items (adjacent text blocks become one message item; thinking is dropped). */
export function anthropicBlocksToOutputItems(content: Json[], ids?: { message?: () => string; call?: () => string }): Json[] {
  const items: Json[] = [];
  let text: Json | null = null;
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "text") {
      if (!text) { text = { id: ids?.message?.() ?? rid("msg"), type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: "", annotations: [] }] }; items.push(text); }
      text.content[0].text += String(b.text ?? "");
    } else if (b.type === "tool_use") {
      text = null;
      items.push({ id: ids?.call?.() ?? rid("fc"), type: "function_call", status: "completed", call_id: String(b.id ?? ""), name: String(b.name ?? ""), arguments: JSON.stringify(b.input ?? {}) });
    } else text = null;
  }
  return items;
}

const INCOMPLETE: Record<string, string> = { max_tokens: "max_output_tokens" };

export function responseSkeleton(id: string, createdAt: number, model: string, status: string, req?: Json): Json {
  return {
    id, object: "response", created_at: createdAt, status, background: false, error: null, incomplete_details: null,
    instructions: typeof req?.instructions === "string" ? req.instructions : null, max_output_tokens: req?.max_output_tokens ?? null, model,
    output: [], parallel_tool_calls: true, previous_response_id: null, reasoning: null, store: false,
    temperature: typeof req?.temperature === "number" ? req.temperature : null, text: { format: { type: "text" } },
    tool_choice: req?.tool_choice ?? "auto", tools: Array.isArray(req?.tools) ? req.tools : [], top_p: typeof req?.top_p === "number" ? req.top_p : null,
    truncation: "disabled", usage: null, user: null, metadata: req?.metadata && typeof req.metadata === "object" ? req.metadata : {},
  };
}

/** Anthropic Message (non-stream) → Responses object. */
export function anthropicMessageToResponses(resp: Json, model: string, req?: Json): Json {
  const id = typeof resp.id === "string" ? resp.id.replace(/^msg_/, "resp_") : rid("resp");
  const stop = String(resp.stop_reason ?? "end_turn");
  const r = responseSkeleton(id, Math.floor(Date.now() / 1000), model, stop === "max_tokens" ? "incomplete" : "completed", req);
  if (stop === "max_tokens") r.incomplete_details = { reason: INCOMPLETE[stop] };
  r.output = anthropicBlocksToOutputItems(Array.isArray(resp.content) ? resp.content : []);
  r.usage = responsesUsageFromAnthropic(resp.usage);
  return r;
}

/** Anthropic SSE events → Responses API event stream (`event: <type>` + `data`). */
export class AnthropicToResponsesStream {
  private seq = 0;
  private readonly id = rid("resp");
  private readonly createdAt = Math.floor(Date.now() / 1000);
  private readonly items: Json[] = [];
  /** Anthropic block index → open item (text or function_call) or "ignored" (thinking etc.). */
  private readonly open = new Map<number, { item: Json; outputIndex: number } | "ignored">();
  private usage: Json = {};
  private stopReason: string | null = null;
  private started = false;
  errored = false;
  done = false;

  constructor(private readonly model: string, private readonly req?: Json) {}

  private ev(type: string, data: Json): string {
    return `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: this.seq++, ...data })}\n\n`;
  }

  private response(status: string): Json {
    const r = responseSkeleton(this.id, this.createdAt, this.model, status, this.req);
    r.output = this.items;
    if (status === "incomplete") r.incomplete_details = { reason: INCOMPLETE[this.stopReason ?? ""] ?? "max_output_tokens" };
    if (status === "completed" || status === "incomplete") r.usage = responsesUsageFromAnthropic(this.usage);
    return r;
  }

  private start(): string[] {
    if (this.started) return [];
    this.started = true;
    return [this.ev("response.created", { response: this.response("in_progress") }), this.ev("response.in_progress", { response: this.response("in_progress") })];
  }

  push(ev: Json): string[] {
    const out: string[] = [];
    switch (ev.type) {
      case "error": {
        this.errored = true;
        const e = ev.error ?? {};
        out.push(this.ev("error", { code: e.type ?? "api_error", message: String(e.message ?? "upstream error"), param: null }));
        break;
      }
      case "message_start":
        Object.assign(this.usage, ev.message?.usage ?? {});
        out.push(...this.start());
        break;
      case "content_block_start": {
        out.push(...this.start());
        const cb = ev.content_block ?? {};
        const outputIndex = this.items.length;
        if (cb.type === "text") {
          const item = { id: rid("msg"), type: "message", status: "in_progress", role: "assistant", content: [{ type: "output_text", text: String(cb.text ?? ""), annotations: [] }] };
          this.items.push(item); this.open.set(ev.index, { item, outputIndex });
          out.push(this.ev("response.output_item.added", { output_index: outputIndex, item: { ...item, content: [] } }));
          out.push(this.ev("response.content_part.added", { item_id: item.id, output_index: outputIndex, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }));
          if (item.content[0].text) out.push(this.ev("response.output_text.delta", { item_id: item.id, output_index: outputIndex, content_index: 0, delta: item.content[0].text }));
        } else if (cb.type === "tool_use") {
          const item = { id: rid("fc"), type: "function_call", status: "in_progress", call_id: String(cb.id ?? rid("toolu")), name: String(cb.name ?? ""), arguments: "" };
          this.items.push(item); this.open.set(ev.index, { item, outputIndex });
          out.push(this.ev("response.output_item.added", { output_index: outputIndex, item }));
        } else this.open.set(ev.index, "ignored");
        break;
      }
      case "content_block_delta": {
        const o = this.open.get(ev.index);
        if (!o || o === "ignored") break;
        const d = ev.delta ?? {};
        if (o.item.type === "message" && d.type === "text_delta" && typeof d.text === "string" && d.text) {
          o.item.content[0].text += d.text;
          out.push(this.ev("response.output_text.delta", { item_id: o.item.id, output_index: o.outputIndex, content_index: 0, delta: d.text }));
        } else if (o.item.type === "function_call" && d.type === "input_json_delta" && typeof d.partial_json === "string" && d.partial_json) {
          o.item.arguments += d.partial_json;
          out.push(this.ev("response.function_call_arguments.delta", { item_id: o.item.id, output_index: o.outputIndex, delta: d.partial_json }));
        }
        break;
      }
      case "content_block_stop": {
        const o = this.open.get(ev.index);
        this.open.delete(ev.index);
        if (!o || o === "ignored") break;
        o.item.status = "completed";
        if (o.item.type === "message") {
          out.push(this.ev("response.output_text.done", { item_id: o.item.id, output_index: o.outputIndex, content_index: 0, text: o.item.content[0].text }));
          out.push(this.ev("response.content_part.done", { item_id: o.item.id, output_index: o.outputIndex, content_index: 0, part: o.item.content[0] }));
        } else {
          if (!o.item.arguments) o.item.arguments = "{}";
          out.push(this.ev("response.function_call_arguments.done", { item_id: o.item.id, output_index: o.outputIndex, arguments: o.item.arguments }));
        }
        out.push(this.ev("response.output_item.done", { output_index: o.outputIndex, item: o.item }));
        break;
      }
      case "message_delta":
        Object.assign(this.usage, ev.usage ?? {});
        if (ev.delta?.stop_reason) this.stopReason = String(ev.delta.stop_reason);
        break;
      case "message_stop":
        if (this.done || this.errored) break;
        this.done = true;
        out.push(...this.start());
        out.push(this.ev(this.stopReason === "max_tokens" ? "response.incomplete" : "response.completed", { response: this.response(this.stopReason === "max_tokens" ? "incomplete" : "completed") }));
        break;
    }
    return out;
  }

  /** Nothing to add after message_stop (Responses streams have no [DONE]). */
  end(): string[] {
    return [];
  }
}

// =====================================================================
// Strict parameter contract (spec WP4.2): fields a path cannot honour are a 400, never silently dropped.
// =====================================================================

export interface UnsupportedParam { parameter: string; path: string; reason: string }

/**
 * Parameters a strict key refuses: the path's ignored list (what `warn` reports in x-1day-ignored-params) plus the
 * explicit contract — n>1, logprobs, seed, non-zero penalties, service_tier, parallel_tool_calls, structured output
 * formats, worker-side temperature/top_p/top_k and a forced tool_choice (prompt-level only there).
 */
export function strictUnsupportedParams(body: Json, format: "openai-chat" | "anthropic" | "responses", ignored: string[], workerPath: boolean): UnsupportedParam[] {
  const out = new Map<string, UnsupportedParam>();
  const add = (parameter: string, reason: string, path = parameter) => { if (!out.has(parameter)) out.set(parameter, { parameter, path, reason }); };
  for (const n of ignored) add(n, workerPath ? "not honoured on the worker path" : "not honoured when converting between dialects");
  const present = (k: string) => body[k] !== undefined && body[k] !== null;
  if (format === "openai-chat") {
    if (typeof body.n === "number" && body.n > 1) add("n", "only n=1 is supported");
    if (body.logprobs === true || present("top_logprobs")) add("logprobs", "log probabilities are not available");
    if (present("seed")) add("seed", "deterministic sampling is not available");
    if (typeof body.presence_penalty === "number" && body.presence_penalty !== 0) add("presence_penalty", "penalties are not available");
    if (typeof body.frequency_penalty === "number" && body.frequency_penalty !== 0) add("frequency_penalty", "penalties are not available");
    if (present("service_tier")) add("service_tier", "service tiers are not available");
    if (present("parallel_tool_calls")) add("parallel_tool_calls", "parallel tool-call control is not available");
    if (body.response_format && body.response_format.type && body.response_format.type !== "text") add("response_format", "structured output formats are not available on this path yet", "response_format.type");
    if (workerPath && body.tool_choice && typeof body.tool_choice === "object" || (workerPath && body.tool_choice === "required")) add("tool_choice", "a forced tool_choice is only a prompt-level constraint on the worker path");
  } else if (format === "responses") {
    if (present("service_tier")) add("service_tier", "service tiers are not available");
    if (present("parallel_tool_calls")) add("parallel_tool_calls", "parallel tool-call control is not available");
    if (present("truncation") && body.truncation !== "disabled") add("truncation", "automatic truncation is not available");
    if (present("reasoning")) add("reasoning", "reasoning controls are not mapped on this path yet");
    if (workerPath && body.tool_choice && (body.tool_choice === "required" || typeof body.tool_choice === "object")) add("tool_choice", "a forced tool_choice is only a prompt-level constraint on the worker path");
  } else {
    if (present("service_tier")) add("service_tier", "service tiers are not available");
    if (workerPath && body.tool_choice && typeof body.tool_choice === "object" && (body.tool_choice.type === "any" || body.tool_choice.type === "tool")) add("tool_choice", "a forced tool_choice is only a prompt-level constraint on the worker path");
    if (workerPath && body.output_format) add("output_format", "structured output is not available on the worker path yet");
  }
  return [...out.values()];
}
