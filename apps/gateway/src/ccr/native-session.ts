// Canonical native sessions, gateway side (docs/canonical-implementation-spec-2026-11-01.md §6.3 / WP3).
//
// The conversation of a canonical worker lives in Claude Code's own transcript on the node (projects/<cwd-hash>/<id>.jsonl
// under the account's config dir). The gateway only remembers (TurnMemory.native) which native session a conversation
// is, how many turns were committed and where it stands; a continue that no live process can take is resumed by the
// node with `--resume <id>` (G4). External history (G3) is imported by writing a transcript in the same shape the
// binary writes — WITHOUT thinking blocks: the probe showed the binary forwards any thinking/signature unverified and
// the real upstream rejects it (docs/evidence/cc-2.1.312/G3-matrix.md).
import { randomUUID } from "node:crypto";
import { CC_VERSION } from "@1dayapi/core";

type Json = Record<string, any>;

export interface NativeTranscriptOptions {
  model?: string;
  /** Transcript `cwd`; the node overwrites it with the real scratch cwd. */
  cwd?: string;
  now?: () => string;
}

/** Content blocks a transcript may carry: text / image / document / tool_use / tool_result. Thinking is stripped (G3). */
export function transcriptBlocks(content: unknown): Json[] | string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const out: Json[] = [];
  for (const b of content as Json[]) {
    if (!b || typeof b !== "object") continue;
    switch (b.type) {
      case "text": if (typeof b.text === "string" && b.text) out.push({ type: "text", text: b.text }); break;
      case "image": case "document": out.push({ type: b.type, source: b.source, ...(b.title ? { title: b.title } : {}) }); break;
      case "tool_use": out.push({ type: "tool_use", id: String(b.id ?? `toolu_${randomUUID().replace(/-/g, "").slice(0, 24)}`), name: String(b.name ?? ""), input: b.input ?? {} }); break;
      case "tool_result": out.push({ type: "tool_result", tool_use_id: String(b.tool_use_id ?? ""), content: b.content ?? "", ...(b.is_error ? { is_error: true } : {}) }); break;
      default: break; // thinking / redacted_thinking / unknown: never imported
    }
  }
  return out;
}

/**
 * Claude Code transcript lines for an Anthropic Messages history (everything BEFORE the turn that will be fed live).
 * Shape mirrors what 2.1.312 writes itself (probe sample): one line per message, `parentUuid` chain, sdk-cli entrypoint.
 */
export function buildNativeTranscript(messages: Json[], sessionId: string, opts: NativeTranscriptOptions = {}): Json[] {
  const now = opts.now ?? (() => new Date().toISOString());
  const lines: Json[] = [];
  let parent: string | null = null;
  for (const m of messages) {
    if (!m || typeof m !== "object" || (m.role !== "user" && m.role !== "assistant")) continue;
    const uuid = randomUUID();
    const base = { parentUuid: parent, isSidechain: false, userType: "external", entrypoint: "sdk-cli", cwd: opts.cwd ?? "", sessionId, version: CC_VERSION, gitBranch: "", uuid, timestamp: now() };
    if (m.role === "user") {
      const content = transcriptBlocks(m.content);
      if (content === "" || (Array.isArray(content) && content.length === 0)) continue;
      lines.push({ ...base, type: "user", message: { role: "user", content }, promptId: randomUUID(), permissionMode: "default", promptSource: "sdk", turnOrigin: "sdk" });
    } else {
      const content = transcriptBlocks(m.content);
      const blocks = typeof content === "string" ? (content ? [{ type: "text", text: content }] : []) : content;
      if (blocks.length === 0) continue;
      const stop = blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn";
      lines.push({ ...base, type: "assistant", message: { id: `msg_imported_${uuid.slice(0, 8)}`, type: "message", role: "assistant", model: opts.model ?? "claude-sonnet-5-5", content: blocks, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
    }
    parent = uuid;
  }
  return lines;
}

/** Does the history carry anything the import drops (thinking) — reported to the log, never to upstream. */
export function countStrippedThinking(messages: Json[]): number {
  let n = 0;
  for (const m of messages) if (Array.isArray(m?.content)) for (const b of m.content) if (b?.type === "thinking" || b?.type === "redacted_thinking") n++;
  return n;
}
