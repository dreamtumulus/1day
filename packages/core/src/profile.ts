// Anthropic OAuth profile (`GET /api/oauth/profile`, Bearer; scope user:profile).
// Pure parsing; the console fetches it through the account's node/bound proxy
// (docs/onboarding.md §1: every account-side call leaves from its own proxy).
//
// Observed shape (live, 2026-10-16, a Team seat):
//   { account: { uuid, email, full_name, display_name, has_claude_max: false, has_claude_pro: false, created_at },
//     organization: { uuid, name, organization_type: "claude_team", billing_type: "stripe_subscription",
//                     rate_limit_tier: "default_claude_max_5x", seat_tier: "team_tier_1", subscription_status: "active", … },
//     application: { uuid, name } }
// subscriptionType is normalised to the values Claude Code itself writes into
// .credentials.json (the node materialises it there): max | pro | team | enterprise | free.

export interface OAuthProfile {
  email: string | null;
  accountUuid: string | null;
  orgUuid: string | null;
  orgName?:string|null;
  /** max | pro | team | enterprise | free | null when nothing identifies the plan. */
  subscriptionType: string | null;
  /** Rate-limit tier as reported, e.g. "default_claude_max_5x" (informational). */
  rateLimitTier: string | null;
  displayName: string | null;
}

export function parseOAuthProfile(json: unknown): OAuthProfile | null {
  if (!json || typeof json !== "object") return null;
  const j = json as Record<string, any>;
  const acc = (j.account && typeof j.account === "object" ? j.account : j) as Record<string, any>;
  const org = (j.organization && typeof j.organization === "object" ? j.organization : {}) as Record<string, any>;
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : null);
  const email = str(acc.email);
  const accountUuid = str(acc.uuid) ?? str(j.account_uuid);
  const orgUuid = str(org.uuid) ?? str(j.organization_uuid);
  const orgType = (str(org.organization_type) ?? "").toLowerCase();
  const tier = str(org.rate_limit_tier);
  let subscriptionType: string | null = null;
  if (acc.has_claude_max === true) subscriptionType = "max";
  else if (acc.has_claude_pro === true) subscriptionType = "pro";
  else if (orgType.includes("enterprise")) subscriptionType = "enterprise";
  else if (orgType.includes("team")) subscriptionType = "team";
  else if (tier) {
    const t = tier.toLowerCase();
    subscriptionType = t.includes("max") ? "max" : t.includes("pro") ? "pro" : t.includes("team") ? "team" : t.includes("enterprise") ? "enterprise" : "free";
  }
  if (!email && !accountUuid && !orgUuid && !subscriptionType) return null;
  return { email, accountUuid, orgUuid, orgName:str(org.name),subscriptionType, rateLimitTier: tier, displayName: str(acc.display_name) ?? str(acc.full_name) };
}
