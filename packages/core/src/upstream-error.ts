export type UpstreamErrorScope = "request" | "account_model" | "account" | "node_proxy" | "transport";

export interface UpstreamFailure {
  scope: UpstreamErrorScope;
  code: string;
  message: string;
  retryable: boolean;
  status?: number;
  credentialVersion?: number;
  executionSequence?: number;
  resetAt?: string;
}

function errorText(body: string): string {
  try {
    const j = JSON.parse(body) as { error?: { message?: unknown; type?: unknown; code?: unknown; details?: { error_code?: unknown } }; message?: unknown };
    const code = [j.error?.details?.error_code, j.error?.code, j.error?.type].filter((v): v is string => typeof v === "string").join(" ");
    const message = typeof j.error?.message === "string" ? j.error.message : typeof j.message === "string" ? j.message : body;
    return `${code} ${message}`;
  } catch {
    return body;
  }
}

export function upstreamMessage(body: string): string {
  try {
    const j = JSON.parse(body) as { error?: { message?: unknown }; message?: unknown };
    return String(j.error?.message ?? j.message ?? body).replace(/\s+/g, " ").trim().slice(0, 600);
  } catch {
    return body.replace(/\s+/g, " ").trim().slice(0, 600);
  }
}

/**
 * Classify a direct Anthropic 429 without treating every rejection as exhausted account quota.
 * Unknown 429s conservatively retain the existing account cooldown behavior.
 */
export function classifyDirectRateLimit(body: string, hasRejectedWindow: boolean): UpstreamFailure {
  const text = errorText(body);
  const message = upstreamMessage(body) || "Upstream rejected the request with HTTP 429";
  if (/credits_required|model.{0,80}(?:quota|limit|exhausted)|(?:not entitled|not available|no access).{0,60}model/i.test(text)) {
    return { scope: "account_model", code: "upstream_model_rate_limited", message, retryable: true, status: 429 };
  }
  // 2026-11-01 incident (docs/iron-rules.md 铁律 2 起因, spec I12): `{"type":"rate_limit_error","message":"Error"}` with no
  // further text is Anthropic's rejection of a forged / mis-checksummed Claude Code request — it is about THIS request,
  // not the account. Treating it as account rate limiting spread one bad request across 21 accounts (651 retries) and
  // got the organization disabled. Request scope: answered once, no cooldown, never retried on another account.
  if (/^(?:rate_limit_error\s+)?Error\.?$/i.test(text.trim())) {
    return { scope: "request", code: "upstream_request_rejected", message: "Upstream rejected this request (429 \"Error\": the request was not accepted as a genuine Claude Code request); it was not retried on another account.", retryable: false, status: 429 };
  }
  if (/claude_code_version_too_old|billing.header|cc_version|claude code.{0,100}(?:required|unsupported|version)|request.{0,60}(?:not entitled|not allowed)|required.{0,40}(?:scope|entitlement)/i.test(text)) {
    return { scope: "request", code: "upstream_request_rejected", message, retryable: false, status: 429 };
  }
  return {
    scope: "account",
    code: hasRejectedWindow ? "upstream_window_exhausted" : "upstream_rate_limited",
    message,
    retryable: true,
    status: 429,
  };
}

export function classifyTransportFailure(message: string, nodeProxy = false): UpstreamFailure {
  return {
    scope: nodeProxy ? "node_proxy" : "transport",
    code: nodeProxy ? "node_proxy_unavailable" : "upstream_transport_error",
    message,
    retryable: true,
    status: 502,
  };
}
