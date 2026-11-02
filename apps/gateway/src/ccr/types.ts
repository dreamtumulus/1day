// Cloud session (CCR) wire types — docs/ccr-supply.md §4–§5.
//
// Inbound shapes (session create, events push) are documented and verified.
// Outbound event payloads are PROVISIONAL until Appendix A (事件流首抓) lands:
// they follow the Claude Code SDK stream-json message family, which the
// documented inbound `user` event already uses. Everything that depends on
// the outbound shape lives in translate.ts (`SessionTranslator`) so a schema
// correction is a one-file change.

export interface CcrSession {
  id: string;
}

/** One event as pushed to / read from /v1/code/sessions/{id}/events. */
export interface SessionEvent {
  id?: string;
  payload: EventPayload;
}

export type EventPayload =
  | ControlRequestPayload
  | UserPayload
  | AssistantPayload
  | StreamEventPayload
  | ResultPayload
  | { type: string; [k: string]: unknown };

export interface ControlRequestPayload {
  type: "control_request";
  request: { subtype: "set_model"; model: string } | { subtype: string; [k: string]: unknown };
}

export interface UserPayload {
  type: "user";
  uuid: string;
  session_id: string;
  message: { role: "user"; content: string | AnthropicBlock[] };
}

export interface AssistantPayload {
  type: "assistant";
  uuid?: string;
  session_id?: string;
  message: {
    id?: string;
    role: "assistant";
    model?: string;
    content: AnthropicBlock[];
    stop_reason?: string | null;
    usage?: AnthropicUsage;
  };
}

/** Raw Messages API stream event wrapped by the worker (partial messages). */
export interface StreamEventPayload {
  type: "stream_event";
  uuid?: string;
  session_id?: string;
  event: { type: string; index?: number; message?: { id?: string; usage?: AnthropicUsage }; delta?: Record<string, unknown>; usage?: AnthropicUsage; content_block?: AnthropicBlock };
}

/**
 * Facts about one worker/cloud turn that proxy.ts records with the usage row (canary 2026-11-02 §8.1): Claude Code
 * retries upstream 429/529s itself (`system/api_retry`, backoff 25s→36s→47s→…), which the client only sees as first-byte
 * latency; counting them makes that latency attributable and lets the gateway react before the first byte.
 */
export interface TurnFacts {
  upstreamRetries?: number;
  retryStatuses?: number[];
  /** Milliseconds spent inside Claude Code's retry backoff before the first upstream byte (sum of retry_delay_ms). */
  retryDelayMs?: number;
}

export interface ResultPayload {
  type: "result";
  subtype?: string; // success | error_max_turns | error_during_execution | …
  is_error?: boolean;
  result?: string;
  usage?: AnthropicUsage;
  stop_reason?: string | null;
  duration_ms?: number;
  num_turns?: number;
}

export interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  [k: string]: unknown;
}
