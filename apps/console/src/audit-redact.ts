// Redaction for the admin audit trail (docs/auth.md §3a; review fix 2026-11-10). Pure functions, no imports: the
// one-off re-redaction script (apps/console/scripts/redact-audit-2026-11-10.mjs) loads this file without opening a DB.
//
// Two layers:
//   1. by KEY NAME — a precise list of credential-carrying fields (password, sessionKey, accessToken, privateKey, …).
//      The old pattern /key|token|secret|…/ matched any name that merely contained "key" or "token", so harmless
//      settings (`max_keys_per_user`, `key_policy_auto`) were stored as "[redacted]" and the trail could not show
//      what an admin had changed, while proxy passwords under `proxy` / `proxies[].url` / `callbackUrl` went in clear.
//   2. by VALUE — every string is scrubbed wherever it sits: URL userinfo passwords, bare proxy lines
//      (`user:pass@host:port`, `host:port:user:pass`), OAuth `code=` / `state=` and other secret query parameters,
//      and recognisable tokens (sk-ant…, sk-1d…, onboarder / bind codes, Bearer values, JWTs).

export const REDACTED = "[redacted]";
const MAX_STRING = 200;
const MAX_DEPTH = 4;
const MAX_KEYS = 60;

/** Key names (lower-cased, `_` / `-` removed) whose value is a credential as a whole. */
const SECRET_KEYS = new Set([
  "key", "apikey", "loginkey", "sessionkey", "privatekey", "secretkey", "accesskey", "masterkey", "sshkey",
  "token", "accesstoken", "refreshtoken", "idtoken", "authtoken", "bearertoken",
  "secret", "clientsecret", "providernodesecret", "nodesecret", "currentsecret",
  "password", "passwd", "pass", "sshpass",
  "credential", "credentials", "cred", "cookie", "cookies", "setcookie", "authorization",
  "codeverifier", "bindingcode",
]);
/** …and names that end with one of these (botToken, oauthClientSecret, adminPassword, upstreamApiKey, …). */
const SECRET_KEY_SUFFIXES = ["token", "secret", "password", "passwd", "credential", "credentials", "apikey", "sessionkey", "privatekey", "loginkey", "secretkey", "accesskey", "cookie"];

export function isSecretKeyName(name: string): boolean {
  const k = name.toLowerCase().replace(/[_\-\s]/g, "");
  if (SECRET_KEYS.has(k)) return true;
  return SECRET_KEY_SUFFIXES.some((s) => k.length > s.length && k.endsWith(s));
}

const SECRET_QUERY_PARAMS = "code|state|access_token|refresh_token|id_token|token|key|api_key|apikey|session_key|sessionKey|code_verifier|client_secret|password|secret";

/** Scrub secrets inside one string. Idempotent: scrubbing a scrubbed string changes nothing. */
export function redactString(s: string): string {
  if (!s || s.length < 6) return s;
  let out = s;
  // scheme://user:password@host → scheme://user:***@host
  out = out.replace(/\b([a-z][a-z0-9+.-]{1,15}:\/\/)([^\s/:@]*):([^\s/@]+)@/gi, (_m, scheme: string, user: string) => `${scheme}${user}:***@`);
  // bare user:password@host:port (a proxy line without a scheme)
  out = out.replace(/(^|[\s,;"'])([^\s:@/,;"']+):([^\s:@/,;"']+)@((?:[a-z0-9-]+\.)+[a-z0-9-]+|\[[0-9a-f:.]+\]|localhost):(\d{2,5})\b/gi,
    (_m, pre: string, user: string, _pw: string, host: string, port: string) => `${pre}${user}:***@${host}:${port}`);
  // host:port:user:password (the provider-list shape)
  out = out.replace(/\b((?:[a-z0-9-]+\.)+[a-z0-9-]+):(\d{2,5}):([^\s:@,;"']+):([^\s:@,;"']+)/gi,
    (m, host: string, port: string, user: string, pw: string) => (pw === "***" ? m : `${host}:${port}:${user}:***`));
  // ?code=…&state=… (OAuth callback) and other secret query parameters, also when pasted without the URL
  out = out.replace(new RegExp(`(^|[?&#\\s"'])((?:${SECRET_QUERY_PARAMS})=)([^&#\\s"']+)`, "gi"),
    (_m, pre: string, name: string) => `${pre}${name}***`);
  // recognisable tokens
  out = out.replace(/\bsk-ant-[A-Za-z0-9_-]{4,}/g, "sk-ant-***");
  out = out.replace(/\bsk-1d-?[A-Za-z0-9_-]{4,}/g, "sk-1d-***");
  out = out.replace(/\bsk-(?!ant-\*|1d-\*)[A-Za-z0-9_-]{20,}/g, "sk-***");
  out = out.replace(/\b1dk_onb_[A-Za-z0-9]{4,}/g, "1dk_onb_***");
  out = out.replace(/\b(bind|dl_bundle|dl_shim)_[0-9a-f]{16,}\b/g, "$1_***");
  out = out.replace(/\b(Bearer|Basic)\s+(?!\*\*\*)[A-Za-z0-9._~+/=-]{8,}/g, "$1 ***");
  out = out.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, "[jwt]");
  // PEM private keys pasted into a free-text field
  out = out.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[private key]");
  return out;
}

export interface RedactOptions {
  /** false: keep string length and nesting as they are (re-redacting stored rows must not truncate them again). */
  bound?: boolean;
}

/** Drop credential fields, scrub secrets inside every string, bound depth/size. Safe on any JSON-ish value. */
export function redactForAudit(value: unknown, depth = 0, opts: RedactOptions = {}): unknown {
  const bound = opts.bound !== false;
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    const clean = redactString(value);
    return bound && clean.length > MAX_STRING ? `${clean.slice(0, MAX_STRING)}…(${value.length})` : clean;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (bound && depth >= MAX_DEPTH) return "[…]";
  if (Array.isArray(value)) return (bound ? value.slice(0, MAX_KEYS) : value).map((v) => redactForAudit(v, depth + 1, opts));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSecretKeyName(k)) {
        out[k] = v === null || v === undefined || v === "" ? v : REDACTED;
        continue;
      }
      if (bound && ++n > MAX_KEYS) {
        out["…"] = "[truncated]";
        break;
      }
      out[k] = redactForAudit(v, depth + 1, opts);
    }
    return out;
  }
  return String(value);
}

/**
 * Re-redact one stored `admin_audit.summary` (JSON text, possibly cut at 8000 chars). Returns the new text, or null
 * when nothing changes. A summary that no longer parses (it was cut) is scrubbed as plain text.
 */
export function reRedactSummary(summary: string | null): string | null {
  if (!summary) return null;
  let next: string;
  try {
    next = JSON.stringify(redactForAudit(JSON.parse(summary), 0, { bound: false }));
  } catch {
    next = redactString(summary);
  }
  return next === summary ? null : next;
}
