// Shared "structure only" descriptor for a captured /v1/messages request (cc-probe evidence, spec §0.4).
// No prompt text beyond a short head, no tokens, no paths.
import { createHash } from "node:crypto";
import { billingProbe } from "./billing.mjs";

const textOf = (b) => (typeof b === "string" ? b : b?.type === "text" ? String(b.text ?? "") : "");
const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const IDENTITY = /You are Claude Code[^.]*\./;

// §0.4: no temp/home paths in evidence
const scrub = (s) => String(s)
  .replace(/\/(?:tmp|var\/tmp)\/[A-Za-z0-9_.@+-]+(?:\/[A-Za-z0-9_.@+-]+)*/g, "<tmp-path>")
  .replace(/\/home\/[A-Za-z0-9_.@+-]+(?:\/[A-Za-z0-9_.@+-]+)*/g, "<home-path>")
  .replace(/\/root\/[A-Za-z0-9_.@+-]+(?:\/[A-Za-z0-9_.@+-]+)*/g, "<home-path>");
const scrubDeep = (v) => (typeof v === "string" ? scrub(v) : Array.isArray(v) ? v.map(scrubDeep) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrubDeep(x)])) : v);

export function describeMessageRequest(r, version = process.env.CC_PROBE_VERSION ?? "2.1.312") {
  const b = r.body ?? {};
  const sys = Array.isArray(b.system) ? b.system : b.system !== undefined ? [b.system] : [];
  const sysTexts = sys.map(textOf);
  const raw = JSON.stringify(b);
  const auth = r.headers?.authorization ?? "";
  return scrubDeep({
    url: r.url, method: r.method,
    headers: Object.fromEntries(Object.entries(r.headers ?? {}).filter(([k]) => /^(user-agent|x-app|anthropic-beta|anthropic-version|x-stainless-|accept|content-type|x-claude-code-session-id|anthropic-dangerous)/.test(k))),
    betaList: String(r.headers?.["anthropic-beta"] ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    authScheme: auth.startsWith("Bearer ") ? "bearer" : r.headers?.["x-api-key"] ? "x-api-key" : "none",
    topLevelKeys: Object.keys(b),
    system: sys.map((s) => ({ len: textOf(s).length, head: textOf(s).slice(0, 160), cache_control: s?.cache_control ?? null, hasMarker: textOf(s).includes("CALLER-SYSTEM-MARKER") })),
    systemDigest: sha(sysTexts.join("\u0000")),
    systemBlockDigests: sysTexts.map(sha),
    identitySentence: (sysTexts.join("\n").match(IDENTITY) ?? [null])[0],
    billingLine: sysTexts.find((t) => t.startsWith("x-anthropic-billing-header")) ?? null,
    messages: Array.isArray(b.messages) ? b.messages.map((m) => ({ role: m.role, blocks: Array.isArray(m.content) ? m.content.map((c) => ({ type: c.type, len: textOf(c).length, head: (c.type === "tool_result" ? (typeof c.content === "string" ? c.content : JSON.stringify(c.content ?? "")) : textOf(c)).slice(0, 160), is_error: c.is_error ?? undefined, cache_control: c.cache_control ?? null })) : [{ type: "string", len: String(m.content ?? "").length, head: String(m.content ?? "").slice(0, 80) }] })) : null,
    messageDigest: sha(JSON.stringify(b.messages ?? null)),
    tools: Array.isArray(b.tools) ? b.tools.map((t) => t.name) : null,
    toolsDigest: sha(JSON.stringify(Array.isArray(b.tools) ? b.tools.map((t) => t.name) : null)),
    metadataKeys: b.metadata ? Object.keys(b.metadata) : null,
    metadataUserIdKeys: (() => { try { return Object.keys(JSON.parse(b.metadata?.user_id ?? "")); } catch { return null; } })(),
    thinking: b.thinking ?? null, context_management: b.context_management ?? null,
    output_config: b.output_config ?? null, output_format: b.output_format ? Object.keys(b.output_format) : null,
    stream: b.stream ?? null, max_tokens: b.max_tokens ?? null,
    ccFieldHits: ["cch", "cc_prev_req", "cc_prompt_id", "cc_turn_origin", "cc_session_id"].filter((k) => raw.includes(k)),
    billing: billingProbe(b, version),
    bodyDigest: sha(raw),
    hasSystem: sys.length > 0,
  });
}
