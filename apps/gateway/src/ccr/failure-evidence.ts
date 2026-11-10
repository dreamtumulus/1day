// Which part of a worker-lane failure text may decide an account's fate (review 2026-11-09 D).
//
// The worker lane has no HTTP status: failures arrive as text, and proxy.ts reads account-level verdicts out of it
// (organisation suspended, usage window exhausted, account on hold, authentication failed). But a failure of the
// form `claude exited N: <stderr / TUI screen tail>` quotes whatever was on the screen — the customer's own prompt
// and the model's output — and a whole-message text that merely looks like Claude Code's error sentence can be
// produced by a model on request. A customer message containing "claude.ai/restricted" plus an unrelated process
// failure used to put an account into `status = 'error'` on ONE hit.
//
// Trusted outright:
//   - Claude Code's own structured verdict: the `result` event's is_error / error subtype text (source "cc_result"),
//   - an upstream HTTP error body (source "http_body"),
//   - the shim's cause head: the text after the last `claude-tui: ` up to the `: ` where it starts quoting the screen
//     — and only for what the shim can say itself (it never reports a hold, a limit or an organisation verdict, so a
//     head carrying one of those is a quote, not a cause).
// Everything else is a QUOTE: it needs the auth-failure threshold (N hits of one account inside the window) before
// it disposes of anything, and a signal the customer's own request text also carries is ignored (prompt echo).

import { ccLimitReset, orgLevelErrorCode, parseModelSuspension } from "@1dayapi/core";
import { isCcAccountOnHold, isCcAuthFailure } from "./auth-failure.js";
import type { TurnFacts } from "./types.js";

export type FailureSource = NonNullable<TurnFacts["failure"]>["source"];
export type DisposalKind = "org" | "limit" | "model_suspended" | "on_hold" | "auth";

/** Kinds the shim's own cause head may carry; the rest can only have been quoted from the screen. */
const SHIM_HEAD_KINDS: ReadonlySet<DisposalKind> = new Set<DisposalKind>(["auth"]);
const SHIM_MARK = "claude-tui: ";
const SHIM_HEAD_MAX = 240;

/** The account-level verdicts a text would trigger. */
export function disposalKinds(text: string): Set<DisposalKind> {
  const kinds = new Set<DisposalKind>();
  if (!text) return kinds;
  if (orgLevelErrorCode(text)) kinds.add("org");
  if (ccLimitReset(text)) kinds.add("limit");
  if (parseModelSuspension(text)) kinds.add("model_suspended");
  if (isCcAccountOnHold(text)) kinds.add("on_hold");
  if (isCcAuthFailure(text)) kinds.add("auth");
  return kinds;
}

export interface FailureEvidence {
  /** Text that may trigger account-level disposal on its own. */
  trusted: string;
  /** Text seen only through a quote of process output / model text: threshold, and never the customer's own echo. */
  quoted: string;
}

export function workerFailureEvidence(message: string, source: FailureSource | undefined): FailureEvidence {
  if (source === "cc_result" || source === "http_body") return { trusted: message, quoted: "" };
  if (source === "model_text") return { trusted: "", quoted: message };
  const at = message.lastIndexOf(SHIM_MARK);
  if (at < 0) return { trusted: "", quoted: message };
  const rest = message.slice(at + SHIM_MARK.length);
  const cut = rest.indexOf(": ");
  const head = (cut >= 0 ? rest.slice(0, cut) : rest).trim();
  const kinds = disposalKinds(head);
  const shimOwn = head.length > 0 && head.length <= SHIM_HEAD_MAX && [...kinds].every((k) => SHIM_HEAD_KINDS.has(k));
  if (!shimOwn) return { trusted: "", quoted: message };
  return { trusted: head, quoted: `${message.slice(0, at)} ${cut >= 0 ? rest.slice(cut + 2) : ""}`.trim() };
}

const ECHO_MAX_CHARS = 4_000_000;

/** Every string the customer sent (system, messages, tool results, tool definitions …), for the prompt-echo check. */
export function requestEchoText(body: unknown): string {
  const parts: string[] = [];
  let size = 0;
  const walk = (v: unknown, depth: number): void => {
    if (size >= ECHO_MAX_CHARS || depth > 24) return;
    if (typeof v === "string") { parts.push(v); size += v.length; return; }
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    if (v && typeof v === "object") for (const x of Object.values(v as Record<string, unknown>)) walk(x, depth + 1);
  };
  walk(body, 0);
  return parts.join("\n").slice(0, ECHO_MAX_CHARS);
}

export interface SignalDecision {
  /** May this failure's text trigger `kind` now? */
  allowed: boolean;
  /** Why: trusted text, a quote that reached the threshold, a quote still below it, a prompt echo, or no such signal. */
  basis: "trusted" | "quote_threshold" | "quote_pending" | "prompt_echo" | "none";
}

/**
 * Decide per verdict kind. `recordQuote(kind)` counts one quoted hit for the account and says whether the threshold
 * is reached; it is called at most once per kind. "auth" quotes are always allowed through: the caller's own
 * auth-failure tracker already demands the threshold before `status = 'error'`.
 */
export function failureSignals(
  evidence: FailureEvidence,
  customerText: () => string,
  recordQuote: (kind: DisposalKind) => boolean,
): (kind: DisposalKind) => SignalDecision {
  const trusted = disposalKinds(evidence.trusted);
  const quoted = evidence.quoted ? disposalKinds(evidence.quoted) : new Set<DisposalKind>();
  let echo: Set<DisposalKind> | null = null;
  const memo = new Map<DisposalKind, SignalDecision>();
  return (kind) => {
    const known = memo.get(kind);
    if (known) return known;
    let d: SignalDecision;
    if (trusted.has(kind)) d = { allowed: true, basis: "trusted" };
    else if (!quoted.has(kind)) d = { allowed: false, basis: "none" };
    else {
      echo ??= disposalKinds(customerText());
      if (echo.has(kind)) d = { allowed: false, basis: "prompt_echo" };
      else if (kind === "auth") d = { allowed: true, basis: "quote_threshold" };
      else d = recordQuote(kind) ? { allowed: true, basis: "quote_threshold" } : { allowed: false, basis: "quote_pending" };
    }
    memo.set(kind, d);
    return d;
  };
}

/** The text a parser for `kind` may read: trusted text first, the quote only when the decision allows it. */
export function signalText(evidence: FailureEvidence, decision: SignalDecision): string {
  if (decision.basis === "trusted") return evidence.trusted;
  return decision.allowed ? evidence.quoted : "";
}
