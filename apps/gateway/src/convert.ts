// Protocol conversion between OpenAI Chat Completions and Anthropic Messages
// (docs/v3-design.md §7.1). Request + response + SSE, both directions.

type Json = Record<string, any>;

function safeParse(s: unknown): unknown {
  if (typeof s !== "string") return s ?? {};
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p: Json) => (p && typeof p.text === "string" ? p.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

// =====================================================================
// OpenAI Chat request  ->  Anthropic Messages request
// =====================================================================

function openaiPartToAnthropic(p: Json): Json | null {
  if (!p || typeof p !== "object") return null;
  if (p.type === "text") return { type: "text", text: String(p.text ?? "") };
  if (p.type === "image_url") {
    const url: string = typeof p.image_url === "string" ? p.image_url : p.image_url?.url ?? "";
    const m = /^data:([^;]+);base64,(.*)$/s.exec(url);
    if (m) return { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } };
    if (url) return { type: "image", source: { type: "url", url } };
  }
  return null;
}

export function openaiChatToAnthropic(body: Json, upstreamModel: string): Json {
  const system: string[] = [];
  const messages: Json[] = [];
  const push = (role: "user" | "assistant", blocks: Json[]) => {
    if (blocks.length === 0) return;
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };

  for (const m of Array.isArray(body.messages) ? (body.messages as Json[]) : []) {
    if (!m || typeof m !== "object") continue;
    if (m.role === "system" || m.role === "developer") {
      const t = textOf(m.content);
      if (t) system.push(t);
      continue;
    }
    if (m.role === "tool") {
      push("user", [
        { type: "tool_result", tool_use_id: String(m.tool_call_id ?? ""), content: textOf(m.content) || "" },
      ]);
      continue;
    }
    const blocks: Json[] = [];
    if (typeof m.content === "string") {
      if (m.content) blocks.push({ type: "text", text: m.content });
    } else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        const b = openaiPartToAnthropic(p);
        if (b) blocks.push(b);
      }
    }
    if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls as Json[]) {
        blocks.push({
          type: "tool_use",
          id: String(tc.id ?? `toolu_${Math.random().toString(36).slice(2, 10)}`),
          name: String(tc.function?.name ?? ""),
          input: safeParse(tc.function?.arguments) ?? {},
        });
      }
    }
    push(m.role === "assistant" ? "assistant" : "user", blocks);
  }

  const out: Json = {
    model: upstreamModel,
    max_tokens: Number(body.max_completion_tokens ?? body.max_tokens ?? 8192),
    messages,
  };
  if (system.length) out.system = system.join("\n\n");
  if (typeof body.temperature === "number") out.temperature = Math.min(body.temperature, 1);
  // Claude rejects requests carrying both temperature and top_p; OpenAI SDKs often send both defaults.
  else if (typeof body.top_p === "number") out.top_p = body.top_p;
  if (body.stop !== undefined && body.stop !== null) {
    out.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  }
  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = (body.tools as Json[])
      .filter((t) => t?.type === "function" && t.function?.name)
      .map((t) => ({
        name: t.function.name,
        description: t.function.description ?? "",
        input_schema: t.function.parameters ?? { type: "object", properties: {} },
      }));
    const tc = body.tool_choice;
    if (tc === "required") out.tool_choice = { type: "any" };
    else if (tc === "none") out.tool_choice = { type: "none" };
    else if (tc && typeof tc === "object" && tc.function?.name) {
      out.tool_choice = { type: "tool", name: tc.function.name };
    }
  }
  if (body.stream === true) out.stream = true;
  return out;
}

const ANTHROPIC_TO_OPENAI_FINISH: Record<string, string> = {
  end_turn: "stop",
  stop_sequence: "stop",
  max_tokens: "length",
  tool_use: "tool_calls",
  refusal: "content_filter",
};

function openaiUsageFromAnthropic(u: Json | undefined): Json {
  const input = Number(u?.input_tokens ?? 0);
  const cacheRead = Number(u?.cache_read_input_tokens ?? 0);
  const cacheWrite = Number(u?.cache_creation_input_tokens ?? 0);
  const output = Number(u?.output_tokens ?? 0);
  const prompt = input + cacheRead + cacheWrite;
  return {
    prompt_tokens: prompt,
    completion_tokens: output,
    total_tokens: prompt + output,
    prompt_tokens_details: { cached_tokens: cacheRead },
  };
}

export function anthropicMessageToOpenai(resp: Json, model: string): Json {
  const content = Array.isArray(resp.content) ? (resp.content as Json[]) : [];
  const text = content.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("");
  const toolCalls = content
    .filter((b) => b?.type === "tool_use")
    .map((b) => ({
      id: b.id,
      type: "function",
      function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
    }));
  const message: Json = { role: "assistant", content: text || (toolCalls.length ? null : "") };
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {
    id: typeof resp.id === "string" ? resp.id.replace(/^msg_/, "chatcmpl-") : `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      { index: 0, message, finish_reason: ANTHROPIC_TO_OPENAI_FINISH[resp.stop_reason] ?? "stop" },
    ],
    usage: openaiUsageFromAnthropic(resp.usage),
  };
}

/** Anthropic SSE events -> OpenAI chat.completion.chunk lines. */
export class AnthropicToOpenaiStream {
  private id = `chatcmpl-${Math.random().toString(36).slice(2, 14)}`;
  private created = Math.floor(Date.now() / 1000);
  private usage: Json = {};
  private toolIndexByBlock = new Map<number, number>();
  private nextTool = 0;
  private finish: string | null = null;

  constructor(
    private model: string,
    private includeUsage: boolean,
  ) {}

  private chunk(delta: Json, finish: string | null = null): string {
    return `data: ${JSON.stringify({
      id: this.id,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  }

  /** Set once the upstream stream carried an `error` event; end() then emits no terminator. */
  errored = false;

  push(ev: Json): string[] {
    const out: string[] = [];
    switch (ev.type) {
      case "error": {
        // Surface the upstream failure in the OpenAI dialect instead of a clean-looking [DONE].
        this.errored = true;
        const e = ev.error ?? {};
        out.push(`data: ${JSON.stringify({ error: { message: String(e.message ?? "upstream error"), type: String(e.type ?? "api_error"), param: null, code: null } })}\n\n`);
        break;
      }
      case "message_start":
        Object.assign(this.usage, ev.message?.usage ?? {});
        out.push(this.chunk({ role: "assistant", content: "" }));
        break;
      case "content_block_start":
        if (ev.content_block?.type === "tool_use") {
          const idx = this.nextTool++;
          this.toolIndexByBlock.set(ev.index, idx);
          out.push(
            this.chunk({
              tool_calls: [
                {
                  index: idx,
                  id: ev.content_block.id,
                  type: "function",
                  function: { name: ev.content_block.name, arguments: "" },
                },
              ],
            }),
          );
        }
        break;
      case "content_block_delta": {
        const d = ev.delta ?? {};
        if (d.type === "text_delta" && d.text) out.push(this.chunk({ content: d.text }));
        else if (d.type === "input_json_delta" && this.toolIndexByBlock.has(ev.index)) {
          out.push(
            this.chunk({
              tool_calls: [
                { index: this.toolIndexByBlock.get(ev.index), function: { arguments: d.partial_json ?? "" } },
              ],
            }),
          );
        }
        break;
      }
      case "message_delta":
        Object.assign(this.usage, ev.usage ?? {});
        if (ev.delta?.stop_reason) this.finish = ANTHROPIC_TO_OPENAI_FINISH[ev.delta.stop_reason] ?? "stop";
        break;
      case "message_stop":
        out.push(this.chunk({}, this.finish ?? "stop"));
        break;
    }
    return out;
  }

  end(): string[] {
    const out: string[] = [];
    if (this.errored) return out;
    if (this.includeUsage) {
      out.push(
        `data: ${JSON.stringify({
          id: this.id,
          object: "chat.completion.chunk",
          created: this.created,
          model: this.model,
          choices: [],
          usage: openaiUsageFromAnthropic(this.usage),
        })}\n\n`,
      );
    }
    out.push("data: [DONE]\n\n");
    return out;
  }
}

// =====================================================================
// Anthropic Messages request  ->  OpenAI Chat request
// =====================================================================

function anthropicBlockToOpenaiPart(b: Json): Json | null {
  if (b?.type === "text") return { type: "text", text: String(b.text ?? "") };
  if (b?.type === "image") {
    const s = b.source ?? {};
    if (s.type === "base64") return { type: "image_url", image_url: { url: `data:${s.media_type};base64,${s.data}` } };
    if (s.type === "url") return { type: "image_url", image_url: { url: s.url } };
  }
  return null;
}

export function anthropicToOpenaiChat(body: Json, upstreamModel: string): Json {
  const messages: Json[] = [];
  const sys = typeof body.system === "string" ? body.system : textOf(body.system);
  if (sys) messages.push({ role: "system", content: sys });

  for (const m of Array.isArray(body.messages) ? (body.messages as Json[]) : []) {
    const blocks: Json[] =
      typeof m.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m.content) ? m.content : [];
    if (m.role === "assistant") {
      const text = blocks.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("");
      const toolCalls = blocks
        .filter((b) => b?.type === "tool_use")
        .map((b) => ({
          id: b.id,
          type: "function",
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        }));
      const msg: Json = { role: "assistant", content: text || null };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      messages.push(msg);
      continue;
    }
    // user: tool_result blocks become tool messages first, the rest one user message.
    for (const b of blocks.filter((x) => x?.type === "tool_result")) {
      messages.push({
        role: "tool",
        tool_call_id: b.tool_use_id,
        content: typeof b.content === "string" ? b.content : textOf(b.content),
      });
    }
    const parts = blocks.filter((x) => x?.type !== "tool_result").map(anthropicBlockToOpenaiPart).filter(Boolean) as Json[];
    if (parts.length === 1 && parts[0].type === "text") messages.push({ role: "user", content: parts[0].text });
    else if (parts.length) messages.push({ role: "user", content: parts });
  }

  const out: Json = { model: upstreamModel, messages, max_tokens: body.max_tokens };
  if (typeof body.temperature === "number") out.temperature = body.temperature;
  if (typeof body.top_p === "number") out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) out.stop = body.stop_sequences;
  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = (body.tools as Json[])
      .filter((t) => t?.name && !t.type?.startsWith?.("web_search"))
      .map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description ?? "", parameters: t.input_schema ?? { type: "object" } },
      }));
    const tc = body.tool_choice;
    if (tc?.type === "any") out.tool_choice = "required";
    else if (tc?.type === "none") out.tool_choice = "none";
    else if (tc?.type === "tool" && tc.name) out.tool_choice = { type: "function", function: { name: tc.name } };
  }
  if (body.stream === true) {
    out.stream = true;
    out.stream_options = { include_usage: true };
  }
  return out;
}

const OPENAI_TO_ANTHROPIC_STOP: Record<string, string> = {
  stop: "end_turn",
  length: "max_tokens",
  tool_calls: "tool_use",
  function_call: "tool_use",
  content_filter: "refusal",
};

function anthropicUsageFromOpenai(u: Json | undefined): Json {
  const prompt = Number(u?.prompt_tokens ?? 0);
  const cached = Number(u?.prompt_tokens_details?.cached_tokens ?? 0);
  return {
    input_tokens: Math.max(prompt - cached, 0),
    output_tokens: Number(u?.completion_tokens ?? 0),
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
  };
}

export function openaiChatToAnthropicMessage(resp: Json, model: string): Json {
  const choice = Array.isArray(resp.choices) ? resp.choices[0] : undefined;
  const msg = choice?.message ?? {};
  const content: Json[] = [];
  const text = textOf(msg.content);
  if (text) content.push({ type: "text", text });
  for (const tc of Array.isArray(msg.tool_calls) ? msg.tool_calls : []) {
    content.push({ type: "tool_use", id: tc.id, name: tc.function?.name, input: safeParse(tc.function?.arguments) });
  }
  return {
    id: `msg_${String(resp.id ?? Date.now()).replace(/^chatcmpl-/, "")}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: OPENAI_TO_ANTHROPIC_STOP[choice?.finish_reason] ?? "end_turn",
    stop_sequence: null,
    usage: anthropicUsageFromOpenai(resp.usage),
  };
}

/** OpenAI chat chunks -> Anthropic SSE events. */
export class OpenaiToAnthropicStream {
  private started = false;
  private blockIndex = -1;
  private openBlock: "text" | "tool" | null = null;
  private toolBlockByIndex = new Map<number, number>();
  private stopReason = "end_turn";
  private usage: Json | undefined;
  private id = `msg_${Math.random().toString(36).slice(2, 14)}`;

  constructor(private model: string) {}

  private ev(type: string, data: Json): string {
    return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  }

  private start(out: string[]) {
    if (this.started) return;
    this.started = true;
    out.push(
      this.ev("message_start", {
        message: {
          id: this.id,
          type: "message",
          role: "assistant",
          model: this.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }),
    );
  }

  private closeBlock(out: string[]) {
    if (this.openBlock !== null) {
      out.push(this.ev("content_block_stop", { index: this.blockIndex }));
      this.openBlock = null;
    }
  }

  /** Set once the upstream stream carried an error chunk; end() then emits no terminator. */
  errored = false;

  push(chunk: Json): string[] {
    const out: string[] = [];
    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
    if (chunk.error && !choice) {
      // OpenAI-style `{"error": {...}}` chunk: emit the Anthropic error event (after closing any open block).
      this.errored = true;
      const e = typeof chunk.error === "object" ? chunk.error : { message: String(chunk.error) };
      if (this.started) this.closeBlock(out);
      out.push(this.ev("error", { error: { type: String(e.type ?? "api_error"), message: String(e.message ?? "upstream error") } }));
      return out;
    }
    this.start(out);
    if (chunk.usage) this.usage = chunk.usage;
    if (!choice) return out;
    const d = choice.delta ?? {};
    if (typeof d.content === "string" && d.content) {
      if (this.openBlock !== "text") {
        this.closeBlock(out);
        this.blockIndex++;
        this.openBlock = "text";
        out.push(this.ev("content_block_start", { index: this.blockIndex, content_block: { type: "text", text: "" } }));
      }
      out.push(this.ev("content_block_delta", { index: this.blockIndex, delta: { type: "text_delta", text: d.content } }));
    }
    for (const tc of Array.isArray(d.tool_calls) ? d.tool_calls : []) {
      const ti = Number(tc.index ?? 0);
      if (!this.toolBlockByIndex.has(ti)) {
        this.closeBlock(out);
        this.blockIndex++;
        this.openBlock = "tool";
        this.toolBlockByIndex.set(ti, this.blockIndex);
        out.push(
          this.ev("content_block_start", {
            index: this.blockIndex,
            content_block: { type: "tool_use", id: tc.id ?? `toolu_${ti}`, name: tc.function?.name ?? "", input: {} },
          }),
        );
      }
      const args = tc.function?.arguments;
      if (typeof args === "string" && args) {
        out.push(
          this.ev("content_block_delta", {
            index: this.toolBlockByIndex.get(ti),
            delta: { type: "input_json_delta", partial_json: args },
          }),
        );
      }
    }
    if (choice.finish_reason) this.stopReason = OPENAI_TO_ANTHROPIC_STOP[choice.finish_reason] ?? "end_turn";
    return out;
  }

  end(): string[] {
    const out: string[] = [];
    if (this.errored) return out;
    this.start(out);
    this.closeBlock(out);
    out.push(
      this.ev("message_delta", {
        delta: { stop_reason: this.stopReason, stop_sequence: null },
        usage: anthropicUsageFromOpenai(this.usage),
      }),
    );
    out.push(this.ev("message_stop", {}));
    return out;
  }
}
