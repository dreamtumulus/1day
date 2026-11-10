// What a direct-lane 401 / 403 says about the ACCOUNT (review 2026-11-09 C).
//
// Before this, any 403 not otherwise matched forced a token refresh and, on the retry, put the account into
// `status = 'error'` — on the first hit and without reading the body. A 403 is also what a proxy or WAF page, a
// per-request permission refusal or a geo block looks like; none of them says the credential is dead.
//
//   "auth"      the upstream says this credential is not accepted: counts toward the account-level threshold
//               (N hits inside the window before `status = 'error'`); a single hit still gets one forced refresh
//               and one retry.
//   "transient" anything else — HTML / non-JSON bodies, `permission_error`, unknown shapes: this attempt failed,
//               the account's status is not touched.

export type DirectAuthSignal = "auth" | "transient";

const AUTH_ERROR_TYPES = new Set(["authentication_error", "invalid_api_key", "token_expired", "invalid_token", "token_invalidated", "account_deactivated"]);
/** Unambiguous OAuth / key verdicts, wherever in the body they stand. */
const OAUTH_INVALID_RE = /oauth (?:access )?token (?:has been |is |was )?(?:revoked|expired|invalid)|invalid_grant|invalid (?:bearer token|x-api-key|api[ _-]?key|authentication credentials)|credential has no (?:accessToken|orgUuid)/i;

interface ErrorBody {
  error?: { type?: unknown; code?: unknown; message?: unknown } | string;
  type?: unknown;
  message?: unknown;
}

export function directAuthSignal(status: number, body: string): DirectAuthSignal {
  if (status !== 401 && status !== 403) return "transient";
  let parsed: ErrorBody | null = null;
  try {
    const j = JSON.parse(body) as unknown;
    if (j && typeof j === "object" && !Array.isArray(j)) parsed = j as ErrorBody;
  } catch {
    parsed = null;
  }
  // A proxy / WAF page (or an empty body) is not the upstream's verdict on the credential, whatever words it contains.
  if (!parsed) return "transient";
  const e = parsed.error && typeof parsed.error === "object" ? parsed.error : null;
  const type = typeof e?.type === "string" ? e.type : "";
  const code = typeof e?.code === "string" ? e.code : "";
  if (type === "permission_error") return "transient";
  if (AUTH_ERROR_TYPES.has(type) || AUTH_ERROR_TYPES.has(code)) return "auth";
  const message = typeof e?.message === "string" ? e.message : typeof parsed.error === "string" ? parsed.error : typeof parsed.message === "string" ? parsed.message : "";
  return OAUTH_INVALID_RE.test(message) ? "auth" : "transient";
}

/** Why a credential could not be prepared — data problems, never an upstream auth verdict. */
export function credentialProblem(err: unknown): "org_mismatch" | "unreadable" {
  return /organization does not match/i.test((err as Error)?.message ?? "") ? "org_mismatch" : "unreadable";
}
