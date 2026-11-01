import { CC_AUX_ACCEPT, CC_AUX_UA } from "./fingerprint.js";

const AXIOS_ACCEPT_ENCODING = "gzip, compress, deflate, br";

/** Claude Code 2.1.312 token refresh / authorization-code exchange (Axios defaults + JSON content type). */
export function oauthTokenHeaders(userAgent: string, authorization?: string): Record<string, string> {
  return {
    accept: CC_AUX_ACCEPT,
    "content-type": "application/json",
    ...(userAgent ? { "user-agent": userAgent } : {}),
    ...(authorization ? { authorization } : {}),
    "accept-encoding": AXIOS_ACCEPT_ENCODING,
  };
}

/** GET /api/oauth/profile: unlike roles, the native client explicitly sends JSON content type and no-cache. */
export function oauthProfileHeaders(accessToken: string): Record<string, string> {
  return {
    accept: CC_AUX_ACCEPT,
    "content-type": "application/json",
    authorization: `Bearer ${accessToken}`,
    "cache-control": "no-cache",
    "user-agent": CC_AUX_UA,
    "accept-encoding": AXIOS_ACCEPT_ENCODING,
  };
}

/** GET /api/oauth/claude_cli/roles: no content-type or cache-control in the 2.1.312 source. */
export function oauthRolesHeaders(accessToken: string): Record<string, string> {
  return {
    accept: CC_AUX_ACCEPT,
    authorization: `Bearer ${accessToken}`,
    "user-agent": CC_AUX_UA,
    "accept-encoding": AXIOS_ACCEPT_ENCODING,
  };
}

/** The usage window helper uses the auxiliary UA family, not inference stainless headers. */
export function oauthUsageHeaders(accessToken: string): Record<string, string> {
  return {
    accept: CC_AUX_ACCEPT,
    authorization: `Bearer ${accessToken}`,
    "user-agent": CC_AUX_UA,
    "accept-encoding": AXIOS_ACCEPT_ENCODING,
  };
}
