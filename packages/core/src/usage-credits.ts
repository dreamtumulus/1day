// "Usage credits" (formerly "extra usage") of a subscription account, as far as `GET /api/oauth/usage` reports them
// (docs/usage-credits.md). Prepaid pay-as-you-go funds on Pro / Max / Ultra (Team: owner-managed spend limits): when the
// account owner enables them, a request that would hit the 5-hour limit, the weekly limit or the Fable weekly limit is
// served anyway and billed at API rates, until the monthly spend cap is reached or the balance runs out with auto-reload
// off.
//
// Pure helpers, no DB access. THE ENABLED SHAPE IS INFERRED: as of 2026-11-10 every production account has credits
// disabled, so only the disabled body is a verified fixture. Everything here therefore parses defensively, never throws,
// and resolves doubt towards "not usable".

export interface CreditAmount {
  /** Integer amount in minor units (cents for USD). */
  amountMinor: number;
  currency: string;
  /** Decimal places of the currency: major = amountMinor / 10^exponent. */
  exponent: number;
}

export interface FableShare {
  /** Used percent of the Fable allowance itself (0..100+), i.e. what the "Fable" bar in Settings > Usage shows. */
  usedPercent: number | null;
  /** Size of the Fable allowance as a percent of the all-models weekly limit (50 on the 2026-11 Max / Ultra plans). */
  allowancePercentOfWeekly: number | null;
  resetsAt: string | null;
  /** `limits[].is_active`: the scoped limit is currently being counted against. */
  active: boolean;
}

export interface UsageCredits {
  /** The body carried a `spend` or `extra_usage` block at all (false: never polled, truncated, or an unknown shape). */
  known: boolean;
  enabled: boolean;
  everEnabled: boolean;
  canToggle: boolean;
  canPurchase: boolean;
  /** Prepaid balance left; null = not reported. */
  balance: CreditAmount | null;
  /** Monthly spend cap; null = no cap or not reported. */
  monthlyCap: CreditAmount | null;
  /** Spent on credits in the current month; null = not reported. */
  used: CreditAmount | null;
  spendLimitReached: boolean;
  /** null = not reported. */
  autoReload: boolean | null;
  disabledReason: string | null;
  /** Promotional credit balance, when the body reports one. */
  promo: CreditAmount | null;
  fableShare: FableShare | null;
}

export type UsageCreditsPolicy = "off" | "fable_only" | "all";
export const USAGE_CREDITS_POLICIES: readonly UsageCreditsPolicy[] = ["off", "fable_only", "all"];

/** Setting `usage_credits_policy`; anything unrecognised is "off" (today's behaviour). */
export function parseUsageCreditsPolicy(v: unknown): UsageCreditsPolicy {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return s === "fable_only" || s === "all" ? s : "off";
}

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null;
}

function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "" && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v.trim());
  return null;
}

function bool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

function str(v: unknown, max = 120): string | null {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
}

function exponentOf(v: unknown, fallback: number): number {
  const n = num(v);
  return n !== null && Number.isInteger(n) && n >= 0 && n <= 6 ? n : fallback;
}

/**
 * One money value in any of the shapes seen or plausible:
 *   - `{amount_minor, currency, exponent}` (the `spend.used` shape, verified);
 *   - `{amount | value | amount_decimal: 12.5, currency}` — decimal major units;
 *   - a bare number: an integer is read as MINOR units (the `extra_usage.monthly_limit` / `used_credits` convention,
 *     cents), a non-integer as decimal major units. A bare integer that was really major units is therefore shown 100x
 *     too small — it never changes `creditsUsable`, which only asks "> 0".
 * Negative or unparseable → null.
 */
function money(v: unknown, currency: string, exponent: number): CreditAmount | null {
  const o = obj(v);
  if (o) {
    const cur = str(o.currency, 8) ?? currency;
    const exp = exponentOf(o.exponent ?? o.decimal_places, exponent);
    const minor = num(o.amount_minor ?? o.amountMinor ?? o.minor);
    if (minor !== null) return minor >= 0 ? { amountMinor: Math.round(minor), currency: cur, exponent: exp } : null;
    const major = num(o.amount ?? o.value ?? o.amount_decimal ?? o.dollars);
    if (major !== null) return major >= 0 ? { amountMinor: Math.round(major * 10 ** exp), currency: cur, exponent: exp } : null;
    return null;
  }
  const n = num(v);
  if (n === null || n < 0) return null;
  return { amountMinor: Number.isInteger(n) ? n : Math.round(n * 10 ** exponent), currency, exponent };
}

function fableShare(j: Obj): FableShare | null {
  const limits = Array.isArray(j.limits) ? j.limits : [];
  const idx = limits.findIndex((l) => {
    const o = obj(l);
    if (!o) return false;
    const model = obj(obj(o.scope)?.model);
    return /fable/i.test(`${String(model?.display_name ?? "")} ${String(model?.id ?? "")}`);
  });
  const limit = idx >= 0 ? obj(limits[idx]) : null;
  const shares = Array.isArray(j.weekly_scoped_shares) ? j.weekly_scoped_shares.map(obj).filter((s): s is Obj => !!s) : [];
  // Without a Fable entry in limits[], a lone share is still the Fable share (the only scoped weekly limit there is).
  const share = (idx >= 0 ? shares.find((s) => num(s.limit_index) === idx) : null) ?? (idx < 0 && shares.length === 1 ? shares[0] : null);
  if (!limit && !share) return null;
  const allowance = num(share?.allowance_percent_of_weekly);
  const usedOfWeekly = num(share?.used_percent_of_weekly);
  let usedPercent = num(limit?.percent);
  if (usedPercent === null && usedOfWeekly !== null && allowance !== null && allowance > 0) usedPercent = Math.round((usedOfWeekly / allowance) * 100);
  return {
    usedPercent: usedPercent !== null && usedPercent >= 0 ? usedPercent : null,
    allowancePercentOfWeekly: allowance !== null && allowance >= 0 ? allowance : null,
    resetsAt: str(limit?.resets_at, 40),
    active: limit?.is_active === true,
  };
}

const UNKNOWN: UsageCredits = {
  known: false,
  enabled: false,
  everEnabled: false,
  canToggle: false,
  canPurchase: false,
  balance: null,
  monthlyCap: null,
  used: null,
  spendLimitReached: false,
  autoReload: null,
  disabledReason: null,
  promo: null,
  fableShare: null,
};

/**
 * Normalise the credit state out of a stored usage body (`accounts.usage_json`: the JSON text or the parsed object).
 * Reads the current `spend` block and the older `extra_usage` block; where both speak, `spend` wins for amounts and an
 * explicit `false` from either wins for `enabled`. Never throws: anything unreadable yields `known: false`.
 */
export function parseUsageCredits(usageJson: unknown): UsageCredits {
  try {
    let j: unknown = usageJson;
    if (typeof j === "string") {
      try {
        j = JSON.parse(j);
      } catch {
        return { ...UNKNOWN }; // the stored body is cut at 8000 chars: a truncated one is simply unknown
      }
    }
    const root = obj(j);
    if (!root) return { ...UNKNOWN };
    const spend = obj(root.spend);
    const extra = obj(root.extra_usage);
    const share = fableShare(root);
    if (!spend && !extra) return { ...UNKNOWN, fableShare: share };

    const currency = str(obj(spend?.used)?.currency, 8) ?? str(spend?.currency, 8) ?? str(extra?.currency, 8) ?? "USD";
    const exponent = exponentOf(obj(spend?.used)?.exponent ?? spend?.exponent ?? extra?.decimal_places, 2);
    const m = (v: unknown) => money(v, currency, exponent);

    const flags = [bool(spend?.enabled), bool(extra?.is_enabled)];
    const enabled = flags.includes(true) && !flags.includes(false);

    const used = m(spend?.used) ?? m(extra?.used_credits);
    const monthlyCap = m(spend?.cap) ?? m(spend?.limit) ?? m(extra?.monthly_limit);
    const balance = m(spend?.balance) ?? m(obj(spend?.balance)?.available) ?? m(extra?.balance) ?? m(extra?.remaining_credits);

    const ar = spend?.auto_reload ?? extra?.auto_reload;
    const autoReload = bool(ar) ?? bool(obj(ar)?.enabled) ?? bool(obj(ar)?.is_enabled);

    const percent = num(spend?.percent) ?? num(extra?.utilization);
    const severity = str(spend?.severity, 24)?.toLowerCase() ?? "";
    const spendLimitReached =
      extra?.spend_limit_reached === true ||
      spend?.spend_limit_reached === true ||
      /^(exceeded|blocked|limit_reached|exhausted)$/.test(severity) ||
      // a cap exists and the month's spend has reached it
      (!!monthlyCap && monthlyCap.amountMinor > 0 && !!used && used.amountMinor >= monthlyCap.amountMinor) ||
      (!!monthlyCap && percent !== null && percent >= 100);

    const promoRaw = root.promo_credits;
    const promoObj = obj(promoRaw);
    const promo = m(promoRaw) ?? m(promoObj?.balance) ?? m(promoObj?.remaining) ?? m(promoObj?.available);

    return {
      known: true,
      enabled,
      everEnabled: enabled || extra?.credits_ever_enabled === true || spend?.credits_ever_enabled === true,
      canToggle: spend?.can_toggle === true,
      canPurchase: spend?.can_purchase_credits === true,
      balance,
      monthlyCap,
      used,
      spendLimitReached,
      autoReload,
      disabledReason: str(spend?.disabled_reason) ?? str(extra?.disabled_reason) ?? (extra?.user_disabled === true ? "user_disabled" : null),
      promo,
      fableShare: share,
    };
  } catch {
    return { ...UNKNOWN };
  }
}

/**
 * Would a request beyond the plan limits be paid from credits right now, as far as the last usage poll can tell?
 *
 *   1. not enabled (or state unknown)            → false: nothing to fall back on;
 *   2. spend limit reached                       → false: Anthropic stops at the monthly cap whatever the balance is;
 *   3. balance known and > 0                     → true:  prepaid funds are there;
 *   4. auto-reload on                            → true:  an empty balance is topped up from the payment method;
 *   5. balance not reported (null)               → true:  enabled and under the cap (rule 2 already failed a reached
 *                                                         cap) — postpaid / owner-managed shapes report no balance;
 *   6. balance known to be 0, auto-reload not on → false: "usage stops when the balance runs out".
 *
 * A promotional balance alone is not counted: whether promo credit pays for over-limit plan usage is unverified.
 * This is a forecast from a poll that may be hours old — the scheduler additionally distrusts it after any upstream
 * rejection (core accounts.ts `creditsLive`).
 */
export function creditsUsable(c: UsageCredits): boolean {
  if (!c.known || !c.enabled) return false; // 1
  if (c.spendLimitReached) return false; // 2
  if (c.balance && c.balance.amountMinor > 0) return true; // 3
  if (c.autoReload === true) return true; // 4
  if (c.balance === null) return true; // 5
  return false; // 6
}

/** "12.34" for display / logs (no currency symbol). */
export function creditAmountMajor(a: CreditAmount): string {
  return (a.amountMinor / 10 ** a.exponent).toFixed(a.exponent);
}
