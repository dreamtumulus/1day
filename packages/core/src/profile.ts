// Anthropic OAuth profile (`GET /api/oauth/profile`, Bearer; scope user:profile).
// Pure parsing; the console fetches it through the account's node/bound proxy
// (docs/onboarding.md §1: every account-side call leaves from its own proxy).
//
// Observed shape (live, 2026-10-16, a Team seat; 2026-11-02, an Ultra/ex-Max-20x seat):
//   { account: { uuid, email, full_name, display_name, has_claude_max: false, has_claude_pro: false, created_at },
//     organization: { uuid, name, organization_type: "claude_team", billing_type: "stripe_subscription",
//                     rate_limit_tier: "default_claude_max_5x", seat_tier: "team_tier_1", subscription_status: "active", … },
//     application: { uuid, name } }
// subscriptionType is normalised to the values Claude Code itself writes into
// .credentials.json (the node materialises it there): max | pro | team | enterprise | free.
//
// 2026-11-02 (operator): keep EVERYTHING the endpoint says, not just the plan class. Anthropic renamed Max 20x → Ultra
// and Max 5x → Max on 2026-10-30 and dropped the five-hour window for *verified* Ultra accounts only; Pro / Max / Team
// keep it. The tier string (`default_claude_max_20x` …) is the only field that tells those apart, so it is stored and
// shown, and the full (secret-free) body is kept for the console.

export interface OAuthProfileDetails {
  account: {
    uuid: string | null;
    email: string | null;
    fullName: string | null;
    displayName: string | null;
    hasClaudeMax: boolean | null;
    hasClaudePro: boolean | null;
    createdAt: string | null;
  };
  organization: {
    uuid: string | null;
    name: string | null;
    organizationType: string | null;
    billingType: string | null;
    rateLimitTier: string | null;
    seatTier: string | null;
    subscriptionStatus: string | null;
    /** Every other primitive field the endpoint returned under `organization` (future-proof, informational). */
    extra: Record<string, string | number | boolean | null>;
  };
  application: { uuid: string | null; name: string | null } | null;
}

export interface OAuthProfile {
  email: string | null;
  accountUuid: string | null;
  orgUuid: string | null;
  orgName?: string | null;
  /** max | pro | team | enterprise | free | null when nothing identifies the plan. */
  subscriptionType: string | null;
  /** Rate-limit tier as reported, e.g. "default_claude_max_5x" (informational). */
  rateLimitTier: string | null;
  displayName: string | null;
  /** Human plan name derived from tier + org type (`planLabel`). */
  planLabel: string | null;
  /** Everything else the endpoint said (secret-free). */
  details: OAuthProfileDetails;
  /** Secret-free JSON of the whole body, for storage / the console's raw view. */
  rawJson: string;
}

const SECRET_KEY = /token|secret|password|credential|cookie|session_key|api_key/i;

/** Drop any key that looks like a secret, recursively; keep primitives, objects, arrays. */
export function scrubProfileJson(v: unknown, depth = 0): unknown {
  if (depth > 6) return null;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => scrubProfileJson(x, depth + 1));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (SECRET_KEY.test(k)) continue;
      out[k] = scrubProfileJson(x, depth + 1);
    }
    return out;
  }
  if (typeof v === "string") return v.slice(0, 500);
  return v;
}

/**
 * Plan name people recognise, from the tier string first (it is the only field that separates Ultra from Max):
 *   default_claude_max_20x → "Ultra (ex Max 20x)", default_claude_max_5x → "Max (ex Max 5x)", *ultra* → "Ultra",
 *   *pro* → "Pro", team org → "Team" (+ seat tier), enterprise org → "Enterprise"; otherwise the raw tier.
 */
export function planLabel(tier: string | null | undefined, orgType?: string | null, seatTier?: string | null, subscriptionType?: string | null): string | null {
  const t = (tier ?? "").toLowerCase();
  const o = (orgType ?? "").toLowerCase();
  let base: string | null = null;
  if (t.includes("ultra")) base = "Ultra";
  else if (t.includes("max_20x")) base = "Ultra (ex Max 20x)";
  else if (t.includes("max_5x")) base = "Max (ex Max 5x)";
  else if (t.includes("max")) base = "Max";
  else if (t.includes("pro")) base = "Pro";
  else if (t.includes("enterprise") || o.includes("enterprise")) base = "Enterprise";
  else if (o.includes("team")) base = "Team";
  else if (t === "default_claude_ai" || t.includes("free")) base = "Free";
  else if (tier) base = tier;
  else if (subscriptionType) base = subscriptionType[0].toUpperCase() + subscriptionType.slice(1);
  if (!base) return null;
  if (o.includes("team") && !/team/i.test(base)) base = `Team · ${base}`;
  if (seatTier && o.includes("team")) base = `${base} (${seatTier})`;
  return base;
}

/**
 * Which usage windows the plan is expected to enforce, before any usage probe has said so (Anthropic help centre,
 * 2026-10-30): Pro / Max / Team / unverified Ultra → five-hour + weekly; verified Ultra → weekly only. The tier alone
 * cannot tell verified from unverified Ultra, so Ultra reads "unknown" until `GET /api/oauth/usage` or a
 * rate_limit_event settles it (accounts.window_model).
 */
export function expectedFiveHourWindow(tier: string | null | undefined, orgType?: string | null): boolean | null {
  const t = (tier ?? "").toLowerCase();
  if (t.includes("ultra") || t.includes("max_20x")) return null;
  if (!t && !orgType) return null;
  return true;
}

export function parseOAuthProfile(json: unknown): OAuthProfile | null {
  if (!json || typeof json !== "object") return null;
  const j = json as Record<string, any>;
  const acc = (j.account && typeof j.account === "object" ? j.account : j) as Record<string, any>;
  const org = (j.organization && typeof j.organization === "object" ? j.organization : {}) as Record<string, any>;
  const app = (j.application && typeof j.application === "object" ? j.application : null) as Record<string, any> | null;
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : null);
  const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
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
    subscriptionType = t.includes("max") || t.includes("ultra") ? "max" : t.includes("pro") ? "pro" : t.includes("team") ? "team" : t.includes("enterprise") ? "enterprise" : "free";
  }
  if (!email && !accountUuid && !orgUuid && !subscriptionType) return null;
  const known = new Set(["uuid", "name", "organization_type", "billing_type", "rate_limit_tier", "seat_tier", "subscription_status"]);
  const extra: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(org)) {
    if (known.has(k) || SECRET_KEY.test(k)) continue;
    if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") extra[k] = typeof v === "string" ? v.slice(0, 200) : v;
  }
  const details: OAuthProfileDetails = {
    account: { uuid: accountUuid, email, fullName: str(acc.full_name), displayName: str(acc.display_name), hasClaudeMax: bool(acc.has_claude_max), hasClaudePro: bool(acc.has_claude_pro), createdAt: str(acc.created_at) },
    organization: { uuid: orgUuid, name: str(org.name), organizationType: str(org.organization_type), billingType: str(org.billing_type), rateLimitTier: tier, seatTier: str(org.seat_tier), subscriptionStatus: str(org.subscription_status), extra },
    application: app ? { uuid: str(app.uuid), name: str(app.name) } : null,
  };
  return {
    email,
    accountUuid,
    orgUuid,
    orgName: str(org.name),
    subscriptionType,
    rateLimitTier: tier,
    displayName: str(acc.display_name) ?? str(acc.full_name),
    planLabel: planLabel(tier, details.organization.organizationType, details.organization.seatTier, subscriptionType),
    details,
    rawJson: JSON.stringify(scrubProfileJson(json)),
  };
}
