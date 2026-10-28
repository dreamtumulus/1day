import { createHash, randomBytes } from "node:crypto";
import { CC_AUX_ACCEPT, CC_VERSION, CCR, isoIn, OAUTH_ENDPOINTS } from "@1dayapi/core";
import { requestViaNodeProxy } from "../node/egress-request.js";

// sessionKey → OAuth token pair without a browser (docs/onboarding.md §2.1):
// the SK is the Bearer on `POST /v1/oauth/{org}/authorize`, whose response
// carries the redirect_uri with the code; the code is exchanged with the PKCE
// verifier as usual. Every call leaves through the node + proxy the account is
// about to be bound to (一号一代理, §1), via the same http_egress path the
// gateway uses — the main server never talks to the upstream itself.
//
// The method=auth_url callback (§2.2) shares the code exchange + validate tail.

export interface EgressTarget {
  nodeId: string;
  proxyId: string;
  /** Label for the node's session log (no account exists yet). */
  bindingId: string;
  teamId: string;
}

export interface AuthResult {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  orgUuid: string;
  accountUuid?: string;
  /** Not known from the token flow; filled later by the profile fetch. */
  email?: string;
}

/** Failure with a stable code for the job's `error` column (docs/onboarding.md §4). */
export class OnboardError extends Error {
  constructor(
    public readonly code:
      | "node_offline"
      | "proxy_unverified"
      | "proxy_team_mismatch"
      | "proxy_capacity_reached"
      | "team_mismatch"
      | "cloudflare_challenge"
      | "session_key_invalid"
      | "session_stale_relogin"
      | "authorize_failed"
      | "token_exchange_failed"
      | "validate_failed",
    message: string,
  ) {
    super(message);
    this.name = "OnboardError";
  }
}

export interface Pkce {
  codeVerifier: string;
  codeChallenge: string;
  state: string;
}

export function newPkce(): Pkce {
  const codeVerifier = randomBytes(32).toString("base64url");
  return {
    codeVerifier,
    codeChallenge: createHash("sha256").update(codeVerifier).digest("base64url"),
    state: randomBytes(16).toString("hex"),
  };
}

const JSON_HEADERS = { "content-type": "application/json", accept: CC_AUX_ACCEPT, "anthropic-version": CCR.anthropicVersion };

// claude.ai (unlike api.anthropic.com) sits behind Cloudflare bot management:
// a cookie request that does not look like the web app's own XHR — e.g. the
// node's default `Bun/x` user agent — gets the challenge page (403 "Just a
// moment...") before the sessionKey is ever looked at. Same shape as the
// claude.ai frontend's fetch of /api/organizations.
const CLAUDE_AI_HEADERS: Record<string, string> = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  accept: "application/json, text/plain, */*",
  "accept-language": "en-US,en;q=0.9",
  origin: "https://claude.ai",
  referer: "https://claude.ai/new",
  "sec-ch-ua": '"Chromium";v="131", "Google Chrome";v="131", "Not_A Brand";v="24"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
};

/** Cloudflare's managed-challenge page (served with cf-mitigated: challenge); never JSON. */
function isCloudflareChallenge(status: number, text: string): boolean {
  return status === 403 && /<title>Just a moment\.\.\.<\/title>|cf-chl|challenge-platform/.test(text);
}

async function call(
  target: EgressTarget,
  url: string,
  headers: Record<string, string>,
  payload?: unknown,
): Promise<{ status: number; text: string; json: Record<string, unknown> | null }> {
  const r = await requestViaNodeProxy(target, url, headers, payload);
  if ("nodeError" in r) throw new OnboardError("node_offline", `node egress failed: ${r.nodeError}`);
  if (isCloudflareChallenge(r.status, r.text)) {
    throw new OnboardError(
      "cloudflare_challenge",
      `${new URL(url).host} answered with a Cloudflare challenge page for proxy ${target.proxyId} (bot check on that IP); the request itself was never evaluated — retry with another proxy`,
    );
  }
  let json: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(r.text);
    json = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    /* non-JSON body */
  }
  return { status: r.status, text: r.text, json };
}

function upstreamSummary(status: number, text: string): string {
  return `HTTP ${status} ${text.replace(/\s+/g, " ").slice(0, 200)}`;
}

/** The authorize endpoint reports a stale login as an error type/code rather than a 401. */
function isStaleRelogin(text: string): boolean {
  return text.includes("session_stale_relogin");
}

/** `sk-ant-sid01-<base64url>`: chars 13–35 decode to the 16-byte account uuid (docs/onboarding.md §2.1). */
export function accountUuidFromSessionKey(sk: string): string | undefined {
  try {
    const raw = Buffer.from(sk.slice(13, 35), "base64url");
    if (raw.length !== 16) return undefined;
    const h = raw.toString("hex");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  } catch {
    return undefined;
  }
}

/** Pick the organization the SK can chat in (most capabilities wins), else the first one. */
function pickOrganization(orgs: unknown): string | null {
  if (!Array.isArray(orgs)) return null;
  let best: { uuid: string; n: number } | null = null;
  for (const o of orgs as Array<Record<string, unknown>>) {
    if (!o || typeof o.uuid !== "string") continue;
    const caps = Array.isArray(o.capabilities) ? (o.capabilities as unknown[]) : [];
    const n = caps.includes("chat") ? caps.length + 1000 : caps.length;
    if (!best || n > best.n) best = { uuid: o.uuid, n };
  }
  return best?.uuid ?? null;
}

/**
 * method=session_key: [organizations →] authorize (SK as Bearer) → token → validate.
 * `knownOrgUuid` (the form's optional 组织 UUID) skips the claude.ai lookup —
 * the only call in the flow that sits behind Cloudflare's bot check; with it
 * the whole exchange stays on api.anthropic.com.
 */
export async function authorizeWithSessionKey(target: EgressTarget, sessionKey: string, knownOrgUuid?: string): Promise<AuthResult> {
  const d = CCR.direct;
  const sk = sessionKey.trim();
  const orgUuid = knownOrgUuid?.trim() || (await lookupOrganization(target, sk));

  const pkce = newPkce();
  const authRes = await call(
    target,
    d.authorizeUrlTemplate.replace("{org}", encodeURIComponent(orgUuid)),
    { ...JSON_HEADERS, authorization: `Bearer ${sk}` },
    {
      response_type: "code",
      client_id: d.clientId,
      organization_uuid: orgUuid,
      redirect_uri: d.redirectUri,
      scope: d.scopes,
      state: pkce.state,
      code_challenge: pkce.codeChallenge,
      code_challenge_method: "S256",
    },
  );
  if (isStaleRelogin(authRes.text)) {
    throw new OnboardError("session_stale_relogin", "the account's login is not fresh enough to authorize; sign in again and paste a new sessionKey");
  }
  if (authRes.status === 401 || authRes.status === 403) {
    throw new OnboardError("session_key_invalid", `authorize: ${upstreamSummary(authRes.status, authRes.text)}`);
  }
  if (authRes.status !== 200 || !authRes.json) throw new OnboardError("authorize_failed", `authorize: ${upstreamSummary(authRes.status, authRes.text)}`);
  const redirect = authRes.json.redirect_uri;
  if (typeof redirect !== "string") throw new OnboardError("authorize_failed", "authorize: response has no redirect_uri");
  let code: string | null = null;
  let state: string | null = null;
  try {
    const u = new URL(redirect);
    code = u.searchParams.get("code");
    state = u.searchParams.get("state");
  } catch {
    /* handled below */
  }
  if (!code) throw new OnboardError("authorize_failed", "authorize: redirect_uri carries no code");
  if (state !== pkce.state) throw new OnboardError("authorize_failed", "authorize: state mismatch in redirect_uri");

  const tok = await exchangeCode(target, d.tokenUrl, { ...JSON_HEADERS, authorization: `Bearer ${sk}` }, {
    grant_type: "authorization_code",
    client_id: d.clientId,
    code,
    redirect_uri: d.redirectUri,
    state: pkce.state,
    code_verifier: pkce.codeVerifier,
  });
  const v = await validate(target, tok.accessToken);
  if(!v)throw new OnboardError("validate_failed","The token's actual organization could not be verified");
  return {
    ...tok,
    orgUuid: v.orgUuid,
    accountUuid: v?.accountUuid ?? accountUuidFromSessionKey(sk),
  };
}

/** Manually supplied OAuth tokens use the same real organization validation. */
export async function verifyAccessToken(target:EgressTarget,accessToken:string):Promise<{orgUuid:string;accountUuid?:string}> {
  const v=await validate(target,accessToken);
  if(!v)throw new OnboardError("validate_failed","The token's actual organization could not be verified");
  return v;
}

/** GET claude.ai/api/organizations with the SK cookie; a Cloudflare challenge here is the one failure the form's 组织 UUID field sidesteps. */
async function lookupOrganization(target: EgressTarget, sk: string): Promise<string> {
  let orgRes: Awaited<ReturnType<typeof call>>;
  try {
    orgRes = await call(target, CCR.direct.organizationsUrl, { ...CLAUDE_AI_HEADERS, cookie: `sessionKey=${sk}` });
  } catch (err) {
    if (err instanceof OnboardError && err.code === "cloudflare_challenge") {
      throw new OnboardError("cloudflare_challenge", `${err.message}, or fill in the organization UUID (open https://claude.ai/api/organizations in the account's browser) to skip this lookup`);
    }
    throw err;
  }
  if (orgRes.status === 401 || orgRes.status === 403) {
    throw new OnboardError("session_key_invalid", `sessionKey rejected by claude.ai: ${upstreamSummary(orgRes.status, orgRes.text)}`);
  }
  if (orgRes.status !== 200) throw new OnboardError("authorize_failed", `organizations: ${upstreamSummary(orgRes.status, orgRes.text)}`);
  let orgUuid: string | null = null;
  try {
    orgUuid = pickOrganization(JSON.parse(orgRes.text));
  } catch {
    /* handled below */
  }
  if (!orgUuid) throw new OnboardError("authorize_failed", "organizations: no organization uuid in the response");
  return orgUuid;
}

/** method=auth_url step 2: the code came back through the account owner's browser; exchange + validate through the node. */
export async function exchangeCallbackCode(target: EgressTarget, code: string, codeVerifier: string, state: string): Promise<AuthResult> {
  const a = CCR.authorize;
  const tok = await exchangeCode(target, OAUTH_ENDPOINTS.anthropic.tokenUrl, JSON_HEADERS, {
    grant_type: "authorization_code",
    client_id: a.clientId,
    code,
    redirect_uri: a.redirectUri,
    state,
    code_verifier: codeVerifier,
  });
  const v = await validate(target, tok.accessToken);
  if (!v) throw new OnboardError("validate_failed", "token accepted but /api/oauth/validate returned no organization");
  return { ...tok, orgUuid: v.orgUuid, accountUuid: v.accountUuid };
}

async function exchangeCode(
  target: EgressTarget,
  url: string,
  headers: Record<string, string>,
  body: Record<string, string>,
): Promise<Pick<AuthResult, "accessToken" | "refreshToken" | "expiresAt">> {
  const r = await call(target, url, headers, body);
  if (r.status !== 200 || !r.json || typeof r.json.access_token !== "string") {
    throw new OnboardError("token_exchange_failed", `token: ${upstreamSummary(r.status, r.text)}`);
  }
  if (typeof r.json.refresh_token !== "string") throw new OnboardError("token_exchange_failed", "token: response has no refresh_token");
  return {
    accessToken: r.json.access_token,
    refreshToken: r.json.refresh_token,
    expiresAt: isoIn((Number(r.json.expires_in) || 28_800) * 1000),
  };
}

/** Free health probe; also the source of org/account uuid. Null when the scope gate denies it (403 on minimal scopes). */
async function validate(target: EgressTarget, accessToken: string): Promise<{ orgUuid: string; accountUuid?: string } | null> {
  const r = await call(
    target,
    `${OAUTH_ENDPOINTS.anthropic.baseUrl}${CCR.validatePath}`,
    { authorization: `Bearer ${accessToken}`, "content-type": "application/json", "user-agent": `claude-cli/${CC_VERSION} (external, cli)` },
    {},
  );
  if (r.status !== 200 || !r.json || typeof r.json.organization_uuid !== "string") return null;
  return { orgUuid: r.json.organization_uuid, accountUuid: typeof r.json.account_uuid === "string" ? r.json.account_uuid : undefined };
}
