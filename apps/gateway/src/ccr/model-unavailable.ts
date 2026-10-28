// Claude Code's "model does not exist / no access" text (docs/gateway.md §3).
//
// On the worker path a retired or unlicensed model does not come back as an
// HTTP 404 — Claude Code ends the turn with an is_error result:
//   "There's an issue with the selected model (claude-sonnet-4-5). It may not
//    exist or you may not have access to it. Run --model to pick a different model."
// That is the consumer's request, never the account's health: failing over
// through three accounts and cooling each for 30 s (2026-10-17, 6 healthy
// accounts cooled for one client's model sweep) only wastes supply.

const MODEL_UNAVAILABLE_RE = /There's an issue with the selected model|may not exist or you may not have access to it/i;

export function isCcModelUnavailable(message: string): boolean {
  return MODEL_UNAVAILABLE_RE.test(message);
}

/**
 * Claude Code's context-overflow result ("Prompt is too long · the request is
 * ~1088871 tokens (limit 1000000) …"): the conversation is the problem, not
 * the account — no cooldown, no failover, and the client gets the text Claude
 * Code itself auto-compacts on (2026-10-18: surfaced as 502 upstream_stream_error).
 */
const PROMPT_TOO_LONG_RE = /prompt is too long/i;

export function isCcPromptTooLong(message: string): boolean {
  return PROMPT_TOO_LONG_RE.test(message);
}

/** Client-facing form: Claude Code's own sentence, without the worker prefix. */
export function promptTooLongMessage(message: string): string {
  const i = message.search(PROMPT_TOO_LONG_RE);
  return (i >= 0 ? message.slice(i) : message).replace(/\s+/g, " ").trim().slice(0, 600);
}

/**
 * Anthropic's safety classifiers, as Claude Code renders them: "Opus 5.5's
 * safeguards flagged this session (https://www.anthropic.com/legal/aup) …" or
 * "Opus 4.6 can't help with this. Start a new session to continue. … Details: `[bio]`".
 * The content is the problem, not the account (2026-10-19: one key's model sweep
 * failed over through 3 accounts per request and cooled healthy accounts for 30 s).
 */
const SAFEGUARDS_RE = /safeguards flagged this|can't help with this\. Start a new session|anthropic\.com\/legal\/aup/i;

export type CcRequestError = { code: "prompt_too_long" | "safeguards_refusal"; message: string };

/** Worker-path failures that belong to the request: answered once as 400, no failover, no cooldown. */
export function classifyCcRequestError(message: string): CcRequestError | null {
  if (PROMPT_TOO_LONG_RE.test(message)) return { code: "prompt_too_long", message: promptTooLongMessage(message) };
  if (SAFEGUARDS_RE.test(message)) return { code: "safeguards_refusal", message: refusalMessage(message) };
  return null;
}

function refusalMessage(message: string): string {
  const stripped = message.replace(/^[\s\S]*?API Error:\s*/, "").replace(/\\n/g, "\n");
  return stripped.replace(/\s+/g, " ").trim().slice(0, 600);
}
