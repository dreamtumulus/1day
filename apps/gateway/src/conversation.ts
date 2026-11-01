import { sha256Hex, type ConversationRow } from "@1dayapi/core";
import type { ClientFormat } from "./upstream.js";

type Json = Record<string, any>;
export const RESET_NOTICE = "当前对话已重新开始，之前的上下文和工具状态已清空。请发送新的独立问题。";
const CLEAN_SYSTEM = "You are a helpful assistant. This is a new conversation. Answer only the user's current request; no prior conversation or tool state is available.";

function stable(value: any): any {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().filter((k) => k !== "cache_control").map((k) => [k, stable(value[k])]));
  return typeof value === "string" ? value.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trimEnd() : value;
}
const fingerprint = (value: any): string => sha256Hex(JSON.stringify(stable(value)));

export function requestMessages(body: Json, format: ClientFormat): Json[] {
  if (format === "responses") {
    if (typeof body.input === "string") return [{ role: "user", content: body.input }];
    return Array.isArray(body.input) ? body.input : [];
  }
  return Array.isArray(body.messages) ? body.messages : [];
}

/** Session identity never includes the model, system prompt, IP, or software version. */
export function resolveConversationIdentity(apiKeyId: string, headers: Record<string, any>, body: Json, format: ClientFormat): { key: string; reliable: boolean } {
  const values: unknown[] = [headers["x-1day-conversation-id"], headers["x-conversation-id"], headers["x-session-id"], headers["x-claude-session-id"], headers["x-claude-code-session-id"], headers["session_id"], body.metadata?.session_id, body.conversation_id];
  const metadata = body.metadata?.user_id;
  if (typeof metadata === "string") {
    try { values.push(JSON.parse(metadata).session_id); } catch { values.push(/session_([0-9a-zA-Z-]{8,})/.exec(metadata)?.[1]); }
  }
  for (const v of values) if (typeof v === "string" && v.trim() && v.length <= 4096) return { key: `id:${sha256Hex(v.trim())}`, reliable: true };
  // An echoed root links old clients without requiring an additional header. A new/unmatched
  // fingerprint is deliberately treated as uncertain and only the latest question is forwarded.
  const first = requestMessages(body, format).find((m) => m?.role === "user");
  return { key: `root:${fingerprint(first ?? { input: body.input ?? null, apiKeyId })}`, reliable: false };
}

export function conversationBranchKey(body: Json, format: ClientFormat): string {
  return fingerprint(requestMessages(body, format).find((m) => m?.role === "user") ?? { input: body.input ?? null });
}

function cleanContent(content: unknown): string | Json[] | null {
  if (typeof content === "string") {
    const text = content.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
    return text || null;
  }
  if (!Array.isArray(content)) return null;
  const out: Json[] = [];
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    if (["text", "input_text"].includes(b.type) && typeof b.text === "string") {
      const text = cleanContent(b.text);
      if (typeof text === "string") out.push({ type: b.type, text });
    } else if (["image", "document"].includes(b.type) && b.source && ["base64", "url", "text"].includes(b.source.type)) {
      const source: Json = { type: b.source.type };
      for (const k of ["media_type", "data", "url", "text"]) if (typeof b.source[k] === "string") source[k] = b.source[k];
      out.push({ type: b.type, source });
    } else if (b.type === "image_url" && (typeof b.image_url === "string" || typeof b.image_url?.url === "string")) {
      out.push({ type: "image_url", image_url: typeof b.image_url === "string" ? b.image_url : { url: b.image_url.url, ...(b.image_url.detail ? { detail: b.image_url.detail } : {}) } });
    } else if (b.type === "input_image" && typeof b.image_url === "string") out.push({ type: b.type, image_url: b.image_url });
    else if (b.type === "input_file" && (typeof b.file_data === "string" || typeof b.file_url === "string")) {
      const file: Json = { type: b.type };
      for (const k of ["file_data", "file_url", "filename"]) if (typeof b[k] === "string") file[k] = b[k];
      out.push(file);
    } else if (b.type === "file" && typeof b.file?.file_data === "string") out.push({ type: "file", file: { file_data: b.file.file_data, ...(b.file.filename ? { filename: b.file.filename } : {}) } });
  }
  return out.length ? out : null;
}

export interface ResetQuestion { message: Json | null; index: number; anchor: string | null; prefix: string | null }

/** A tool result is never silently reinterpreted as a new user instruction. */
export function latestQuestion(body: Json, format: ClientFormat): ResetQuestion {
  const messages = requestMessages(body, format);
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || ["system", "developer"].includes(m.role)) continue;
    if (m.role === "assistant") continue; // discard assistant prefill
    if (m.role !== "user") return { message: null, index: -1, anchor: null, prefix: null };
    const content = cleanContent(m.content);
    if (!content) return { message: null, index: -1, anchor: null, prefix: null };
    return { message: { role: "user", content }, index: i, anchor: fingerprint(m), prefix: JSON.stringify(messages.slice(0, i).map(fingerprint)) };
  }
  return { message: null, index: -1, anchor: null, prefix: null };
}

/**
 * The request continues a tool round rather than asking something new: the last non-system message is
 * an Anthropic user turn carrying tool_result blocks, a Chat Completions `tool` message, or a Responses
 * function_call_output item. Such a turn is only answerable by the upstream that issued the tool calls.
 */
export function isToolContinuation(body: Json, format: ClientFormat): boolean {
  const messages = requestMessages(body, format);
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || typeof m !== "object" || ["system", "developer", "assistant"].includes(m.role)) continue;
    if (m.role === "tool" || m.type === "function_call_output") return true;
    return m.role === "user" && Array.isArray(m.content) && m.content.some((b: Json) => b?.type === "tool_result");
  }
  return false;
}

function cleanSchema(value: any): any {
  if (Array.isArray(value)) return value.map(cleanSchema);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([k]) => !["description", "$comment", "examples", "default"].includes(k)).map(([k, v]) => [k, cleanSchema(v)]));
  return value;
}

/** Rebuild, rather than mutate, a body so opaque upstream continuation handles cannot survive. */
export function resetBody(body: Json, format: ClientFormat, messages: Json[]): Json {
  const out: Json = {};
  for (const k of ["model", "max_tokens", "max_completion_tokens", "stream", "temperature", "top_p", "top_k", "stop", "stop_sequences", "presence_penalty", "frequency_penalty", "seed", "stream_options", "thinking", "effort", "output_config", "response_format"]) if (body[k] !== undefined) out[k] = structuredClone(body[k]);
  // Current tool capabilities are schema, not the old invocation/result state. Definitions are
  // rebuilt; old server/container/session handles are not accepted as portable tool resources.
  if (Array.isArray(body.tools)) out.tools = body.tools.flatMap((t: Json): Json[] => {
    if (!t || typeof t !== "object") return [];
    if (format === "anthropic" && typeof t.name === "string" && t.input_schema && typeof t.input_schema === "object") return [{ name: t.name, input_schema: cleanSchema(t.input_schema) }];
    const fn = t.function ?? t;
    if (t.type !== "function" || typeof fn.name !== "string") return [];
    const schema = cleanSchema(fn.parameters ?? { type: "object", properties: {} });
    return format === "responses" ? [{ type: "function", name: fn.name, parameters: schema }] : [{ type: "function", function: { name: fn.name, parameters: schema } }];
  });
  if (body.tool_choice !== undefined && out.tools?.length) out.tool_choice = structuredClone(body.tool_choice);
  if (format === "anthropic") { out.system = CLEAN_SYSTEM; out.messages = messages; }
  else if (format === "openai-chat") out.messages = [{ role: "system", content: CLEAN_SYSTEM }, ...messages];
  else { out.instructions = CLEAN_SYSTEM; out.input = messages; out.store = false; }
  return out;
}

/**
 * Keep stripping the old prefix on every future request, including after gateway restarts. The boundary
 * is recognized by its anchor (the first question of this generation) standing at the recorded index;
 * the pre-boundary messages themselves are dropped either way, so edits to them (Claude Code clears old
 * tool_result bodies) must not make the gateway forget the generation's own history.
 */
export function applyResetBoundary(body: Json, format: ClientFormat, row: ConversationRow): { body: Json; matched: boolean; question: ResetQuestion } {
  const question = latestQuestion(body, format);
  if (!row.reset_active) return { body, matched: true, question };
  const messages = requestMessages(body, format);
  let before: string[] = [];
  try { before = JSON.parse(row.reset_prefix ?? "[]"); } catch { /* conservative reset */ }
  // The anchor is the first question of this generation. It used to be looked up at exactly
  // `before.length` (the position it had when the boundary was saved); a client that compacts or drops
  // earlier history — Claude Code's /compact, a summary replacing old turns — moved it and every later
  // request fell back to "latest question only" (audit 2026-11-01). Now: fast path at the saved index,
  // otherwise the message whose content fingerprint equals the anchor, the one nearest the saved index
  // when the same text occurs more than once.
  let index = before.length;
  let matched = !!row.reset_anchor && index < messages.length && fingerprint(messages[index]) === row.reset_anchor;
  if (!matched && row.reset_anchor) {
    const hits: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (!m || ["system", "developer"].includes(m.role)) continue;
      if (fingerprint(m) === row.reset_anchor) hits.push(i);
    }
    if (hits.length) {
      index = hits.reduce((best, i) => (Math.abs(i - before.length) < Math.abs(best - before.length) ? i : best), hits[0]);
      matched = true;
    }
  }
  if (matched) {
    const first = cleanContent(messages[index]?.content);
    if (first) {
      // Only post-boundary assistant/user/tool messages belong to this generation. Drop all
      // system/developer messages, including summaries the client inserts into later history.
      const tail = messages.slice(index + 1).filter((m) => m && !["system", "developer"].includes(m.role));
      return { body: resetBody(body, format, [{ role: "user", content: first }, ...tail]), matched: true, question };
    }
  }
  return { body: resetBody(body, format, question.message ? [question.message] : []), matched: false, question };
}
