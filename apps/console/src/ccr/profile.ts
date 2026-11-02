import {
  CCR,
  oauthProfileHeaders,
  oauthRolesHeaders,
  accountBaseUrl,
  hasSubscriptionWindow,
  nowIso,
  normalizeTeamId,
  parseOAuthProfile,
  readCredential,
  run,
  type AccountRow,
  type OAuthProfile,
} from "@1dayapi/core";
import { requestViaNode } from "../node/egress-request.js";

const PROFILE_TIMEOUT_MS = 15_000;

/**
 * Fetch the account's OAuth profile (email, plan) and write it back
 * (`account_email`, `subscription_type`). Node-routed accounts go through
 * their node so the call leaves from the bound proxy; the headers are the
 * same minimal set a real Claude Code auxiliary call sends. Throws on failure.
 */
export async function enrichAccountProfile(account: AccountRow): Promise<OAuthProfile> {
  if (!hasSubscriptionWindow(account)) throw new Error("profile applies to Anthropic subscription (OAuth) accounts");
  const base = accountBaseUrl(account);
  if (!base) throw new Error("account has no resolvable base URL");
  const cred = readCredential(account);
  if (!cred.accessToken) throw new Error("account has no access token");
  const url = `${base}${CCR.profilePath}`;
  const headers = oauthProfileHeaders(cred.accessToken);
  let status: number;
  let text: string;
  if (account.route === "node") {
    const r = await requestViaNode(account, url, headers, undefined);
    if ("nodeError" in r) throw new Error(`node: ${r.nodeError}`);
    status = r.status;
    text = r.text;
  } else {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(PROFILE_TIMEOUT_MS) });
    status = res.status;
    text = await res.text().catch(() => "");
  }
  if (status < 200 || status >= 300) throw new Error(`profile returned HTTP ${status}${status === 403 ? " (token scope may lack user:profile)" : ""}`);
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* handled below */
  }
  const p = parseOAuthProfile(json);
  if (!p) {
    console.warn(`[profile] unparseable body for account ${account.id}: ${text.slice(0, 200)}`);
    throw new Error("profile response did not contain account fields");
  }
  if(account.team_id && p.orgUuid && normalizeTeamId(p.orgUuid)!==account.team_id){
    run("UPDATE accounts SET status='error',error_message='organization identity mismatch',updated_at=? WHERE id=?",nowIso(),account.id);
    throw new Error("organization identity mismatch");
  }
  if(account.team_id && p.orgName)run("UPDATE upstream_teams SET name=COALESCE(name,?) WHERE id=?",p.orgName,account.team_id);
  const o = p.details.organization;
  run(
    `UPDATE accounts SET account_email = COALESCE(?, account_email), subscription_type = COALESCE(?, subscription_type),
       rate_limit_tier = ?, plan_label = ?, org_type = ?, billing_type = ?, seat_tier = ?, subscription_status = ?, profile_json = ?,
       last_profile_at = ?, updated_at = ? WHERE id = ?`,
    p.email,
    p.subscriptionType,
    p.rateLimitTier,
    p.planLabel,
    o.organizationType,
    o.billingType,
    o.seatTier,
    o.subscriptionStatus,
    p.rawJson,
    nowIso(),
    nowIso(),
    account.id,
  );
  console.info(`[profile] ${account.id}: ${p.email ?? "no email"} / ${p.subscriptionType ?? "plan unknown"} (${p.rateLimitTier ?? "no tier"}; ${p.planLabel ?? "-"}; org=${o.organizationType ?? "-"} billing=${o.billingType ?? "-"} seat=${o.seatTier ?? "-"} status=${o.subscriptionStatus ?? "-"})`);
  return p;
}

export interface OAuthRoles {
  organizationRole: string | null;
  workspaceRole: string | null;
  organizationName: string | null;
}

export async function fetchAccountRoles(account: AccountRow): Promise<OAuthRoles> {
  const cred = readCredential(account);
  if (!cred.accessToken) throw new Error("account has no access token");
  const base = accountBaseUrl(account);
  if (!base) throw new Error("account has no resolvable base URL");
  const headers = oauthRolesHeaders(cred.accessToken);
  const url = `${base}${CCR.rolesPath}`;
  let status: number;
  let text: string;
  if (account.route === "node") {
    const r = await requestViaNode(account, url, headers, undefined);
    if ("nodeError" in r) throw new Error(`node: ${r.nodeError}`);
    status = r.status;
    text = r.text;
  } else {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(PROFILE_TIMEOUT_MS) });
    status = res.status;
    text = await res.text().catch(() => "");
  }
  if (status < 200 || status >= 300) throw new Error(`roles returned HTTP ${status}`);
  let value: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    value = parsed as Record<string, unknown>;
  } catch {
    throw new Error("roles response was not a JSON object");
  }
  const str = (key: string): string | null => typeof value[key] === "string" ? value[key] as string : null;
  return { organizationRole: str("organization_role"), workspaceRole: str("workspace_role"), organizationName: str("organization_name") };
}

/** Default non-inference validation: identity/profile plus the roles companion request, never a paid model call. */
export async function validateAccountControlPlane(account: AccountRow): Promise<{ profile: OAuthProfile; roles: OAuthRoles }> {
  const profile = await enrichAccountProfile(account);
  const roles = await fetchAccountRoles(account);
  return { profile, roles };
}
