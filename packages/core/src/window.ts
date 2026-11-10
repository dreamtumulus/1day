// Subscription-window state for Anthropic OAuth accounts (docs/ccr-supply.md §7,
// docs/gateway.md §3). Ported from sub2api's account scheduling threshold +
// passive usage sampling: every upstream response carries
// `anthropic-ratelimit-unified-{5h,7d}-{utilization,reset,status}` headers,
// which are sampled into the account row; the admin "refresh" / poller use
// `GET /api/oauth/usage` for idle accounts. Pure helpers: no DB access.

export interface WindowSnapshot {
  /** Binding window (highest utilization), 0..1. */
  used: number;
  /** ISO reset time of the binding window, or null when unknown. */
  resetAt: string | null;
  /** Which window is binding, e.g. "five_hour" / "seven_day". */
  window: string | null;
  fiveHour?: WindowPoint | null;
  sevenDay?: WindowPoint | null;
  /**
   * Fable-only 7d window (headers `anthropic-ratelimit-unified-7d_oi-*`, usage body
   * `seven_day_fable` / `seven_day_overage_included`). Never part of the binding
   * window: its exhaustion limits only the Fable model family (sub2api
   * selectAnthropicFableWindowLimit), the account stays schedulable for the rest.
   */
  fable?: WindowPoint | null;
  /**
   * Which windows the source actually reported (2026-11-02): `GET /api/oauth/usage` returns `five_hour: null` and
   * unified headers carry no `-5h-` fields on a verified Ultra account (no five-hour window since 2026-10-30), while
   * Pro / Max / Team / unverified Ultra report both. Recorded into accounts.window_model.
   */
  presence?: { five_hour: boolean; seven_day: boolean; fable: boolean };
}

/** Model-family scope of a request for per-scope cooldowns; null = account-wide only. */
export function modelScope(model: string): string | null {
  return /fable/i.test(model) ? "fable" : null;
}

/**
 * Anthropic's per-model organization suspension (first seen 2026-10-20 04:36Z on the
 * fgms.us team org: Opus 5.5 + Sonnet 5.5 off for one hour, every other model fine):
 *   403 permission_error `model: "claude-opus-5-5" is suspended for this organization until 2026-10-20T05:36:03Z`
 * On the worker path the same sentence arrives inside Claude Code's
 * "Failed to authenticate. API Error: 403 …" text. It is a time-boxed, model-scoped
 * limit — not an auth failure — so the account must only lose that model until `until`.
 */
export function parseModelSuspension(text: string | null | undefined): { model: string; until: string } | null {
  if (!text) return null;
  const m = /model:\s*\\?"([A-Za-z0-9._-]+)\\?"\s+is suspended for this organization(?:\s+until\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?Z?)?/i.exec(text);
  if (!m) return null;
  const until = m[2] ? `${m[2]}Z` : new Date(Date.now() + 3_600_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  return { model: m[1], until };
}

export interface WindowPoint {
  used: number; // 0..1
  resetAt: string | null;
  /** "allowed" | "rejected" | null (only the unified headers say). */
  status?: string | null;
}

export interface WindowState {
  executor: string;
  type?: string;
  platform?: string;
  window_used: number | null;
  window_reset_at: string | null;
  window_exhausted_until: string | null;
}

/** Scheduling threshold: pause an account whose binding window is at or above this percentage. 100 = off. */
export const DEFAULT_WINDOW_THRESHOLD_PERCENT = 98;

export function parseThresholdPercent(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 && n <= 100 ? n : DEFAULT_WINDOW_THRESHOLD_PERCENT;
}

/** True when `used` (0..1) is at or above the threshold percent (threshold 100 never pauses). */
export function windowExhausted(used: number | null, thresholdPercent = DEFAULT_WINDOW_THRESHOLD_PERCENT): boolean {
  if (used === null || used === undefined || thresholdPercent >= 100) return false;
  return used * 100 >= thresholdPercent - 1e-9;
}

/**
 * Scheduling filter. Accounts without window data always pass. An account is
 * skipped while in window cooldown, or when its last snapshot shows the
 * binding window at/above the threshold — unless that snapshot is already
 * past its reset time (the window rolled over since we last looked).
 */
export function windowAllows(a: WindowState, now: string, thresholdPercent = DEFAULT_WINDOW_THRESHOLD_PERCENT): boolean {
  if (a.window_exhausted_until && a.window_exhausted_until > now) return false;
  if (a.window_used === null || a.window_used === undefined) return true;
  if (a.window_reset_at && a.window_reset_at <= now) return true;
  return !windowExhausted(a.window_used, thresholdPercent);
}

function toIso(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    const ms = v > 1e12 ? v : v * 1000;
    return new Date(ms).toISOString().slice(0, 19) + "Z";
  }
  if (typeof v !== "string" || !v) return null;
  const t = v.trim();
  if (/^\d+$/.test(t)) return toIso(Number(t));
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 19) + "Z" : null;
}

/** Unified rate-limit headers / rate_limit_event: utilization is a 0..1 fraction. */
function toFraction(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(n, 1);
}

/** `GET /api/oauth/usage` reports utilization as a PERCENT (0..100; sub2api divides by 100). */
function percentToFraction(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(n / 100, 1);
}

function binding(points: Array<[string, WindowPoint | null | undefined]>): WindowSnapshot | null {
  let best: WindowSnapshot | null = null;
  for (const [name, p] of points) {
    if (!p) continue;
    if (!best || p.used > best.used || (p.status === "rejected" && best.used < 1)) {
      best = { used: p.status === "rejected" ? Math.max(p.used, 1) : p.used, resetAt: p.resetAt, window: name };
    }
  }
  return best;
}

/**
 * Account-wide windows in the usage probe body. Per-model-family windows
 * (`seven_day_sonnet`, `seven_day_opus`, `seven_day_fable` / `_overage_included`)
 * are NOT folded into the binding window: pausing the whole account because one
 * family's 7d budget is used up would starve the other models (sub2api only
 * pauses on 5h / 7d; the Fable window becomes a model-scoped cooldown).
 */
const USAGE_WINDOW_KEYS = ["five_hour", "seven_day"];
const USAGE_FABLE_KEYS = ["seven_day_fable", "seven_day_overage_included"];

/**
 * Parse the usage probe body (`GET /api/oauth/usage`, docs/ccr-supply.md A.1):
 * top-level window objects `{utilization (percent 0..100), resets_at}` —
 * `five_hour`, `seven_day`, `seven_day_sonnet`, … (unused windows are null).
 * Returns null when no window object carries a utilization.
 */
export function parseUsageSnapshot(json: unknown): WindowSnapshot | null {
  if (!json || typeof json !== "object") return null;
  const points: Array<[string, WindowPoint]> = [];
  let fable: WindowPoint | null = null;
  for (const [name, raw] of Object.entries(json as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const w = raw as Record<string, unknown>;
    const used = percentToFraction(w.utilization);
    if (used === null) continue;
    if (USAGE_WINDOW_KEYS.includes(name)) points.push([name, { used, resetAt: toIso(w.resets_at) }]);
    else if (USAGE_FABLE_KEYS.includes(name) && (!fable || used > fable.used)) fable = { used, resetAt: toIso(w.resets_at) };
  }
  const snap = binding(points);
  if (!snap) return null;
  snap.fiveHour = points.find(([n]) => n === "five_hour")?.[1] ?? null;
  snap.sevenDay = points.find(([n]) => n === "seven_day")?.[1] ?? null;
  snap.fable = fable;
  const j = json as Record<string, unknown>;
  const has = (k: string) => !!j[k] && typeof j[k] === "object";
  snap.presence = { five_hour: has("five_hour"), seven_day: has("seven_day"), fable: USAGE_FABLE_KEYS.some(has) };
  return snap;
}

/**
 * Claude Code's per-turn `rate_limit_event` (stream-json, 2.1.3xx): `rate_limit_info` = { status: allowed |
 * allowed_warning | rejected, rateLimitType?: five_hour | seven_day | seven_day_opus | seven_day_sonnet |
 * seven_day_overage_included | overage, utilization?: 0..1, resetsAt?: epoch seconds, surpassedThreshold?, isUsingOverage?,
 * overageStatus?, overageDisabledReason? }. It is the worker path's only live window signal (no unified headers reach the
 * platform there), so it is folded into the same WindowSnapshot shape. Returns null when the event names no window.
 */
export interface RateLimitEventInfo {
  status?: string;
  rateLimitType?: string;
  utilization?: number;
  resetsAt?: number | string;
  surpassedThreshold?: boolean;
  isUsingOverage?: boolean;
  overageStatus?: string;
  overageDisabledReason?: string;
  /**
   * Claude Code 2.1.31x: the per-window state moved here (`five_hour`, `seven_day`, model-family / overage windows), each
   * `{ utilization: 0..1, resetsAt: epoch s, status }`; the top-level `utilization` is no longer sent. Reading only the
   * top level recorded 0.0 for every worker account (2026-11-05 report: the account page's quota was always wrong).
   */
  unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number | string; status?: string } | null | undefined>;
}
export function parseRateLimitEvent(info: unknown): WindowSnapshot | null {
  if (!info || typeof info !== "object") return null;
  const e = info as RateLimitEventInfo;
  const type = typeof e.rateLimitType === "string" ? e.rateLimitType : null;
  const status = typeof e.status === "string" ? e.status.toLowerCase() : null;
  const uw = e.unifiedWindows && typeof e.unifiedWindows === "object" ? e.unifiedWindows : null;
  if (uw) {
    const pt = (w: string): WindowPoint | null => {
      const x = uw[w];
      if (!x || typeof x !== "object") return null;
      const st = typeof x.status === "string" ? x.status.toLowerCase() : null;
      const u = toFraction(x.utilization);
      if (u === null && st !== "rejected") return null;
      // the event's own verdict names the binding window: a rejected five_hour is exhausted whatever the fraction says
      const rejected = st === "rejected" || (status === "rejected" && type === w);
      return { used: rejected ? Math.max(u ?? 0, 1) : (u ?? 0), resetAt: toIso(x.resetsAt), status: rejected ? "rejected" : st };
    };
    const fiveHour = pt("five_hour");
    const sevenDay = pt("seven_day");
    const fable = pt("seven_day_overage_included") ?? pt("seven_day_fable");
    if (fiveHour || sevenDay || fable) {
      const presence = { five_hour: !!fiveHour, seven_day: !!sevenDay, fable: !!fable };
      const best = binding([["five_hour", fiveHour], ["seven_day", sevenDay]]);
      if (best) return { ...best, fiveHour, sevenDay, fable, presence };
      return { used: 0, resetAt: null, window: null, fiveHour: null, sevenDay: null, fable, presence };
    }
  }
  if (!type && status !== "rejected") return null;
  let used = toFraction(e.utilization) ?? (status === "rejected" ? 1 : 0);
  if (e.surpassedThreshold === true || status === "rejected") used = Math.max(used, 1);
  const point: WindowPoint = { used, resetAt: toIso(e.resetsAt), status };
  if (type === "five_hour") return { used, resetAt: point.resetAt, window: "five_hour", fiveHour: point, sevenDay: null, fable: null, presence: { five_hour: true, seven_day: false, fable: false } };
  if (type === "seven_day") return { used, resetAt: point.resetAt, window: "seven_day", fiveHour: null, sevenDay: point, fable: null, presence: { five_hour: false, seven_day: true, fable: false } };
  if (type === "seven_day_overage_included" || type === "seven_day_fable") return { used: 0, resetAt: null, window: null, fiveHour: null, sevenDay: null, fable: point };
  // seven_day_opus / seven_day_sonnet / overage: model-family or overage budgets — reported, never account-binding here.
  return { used: 0, resetAt: null, window: type, fiveHour: null, sevenDay: null, fable: null };
}

type HeaderSource = { get(name: string): string | null } | Record<string, string | string[] | undefined>;

function headerGet(h: HeaderSource, name: string): string | null {
  if (typeof (h as { get?: unknown }).get === "function") return (h as { get(n: string): string | null }).get(name);
  const v = (h as Record<string, string | string[] | undefined>)[name] ?? (h as Record<string, string | string[] | undefined>)[name.toLowerCase()];
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

/**
 * Passive sampling (sub2api `ratelimit_service` / `account_usage_service`):
 * read `anthropic-ratelimit-unified-{5h,7d}-{utilization,reset,status}` from
 * any upstream response. Returns null when the headers are absent (API-key
 * accounts and non-Anthropic upstreams).
 */
export function parseUnifiedRateLimitHeaders(h: HeaderSource): WindowSnapshot | null {
  const point = (w: "5h" | "7d" | "7d_oi"): WindowPoint | null => {
    const util = headerGet(h, `anthropic-ratelimit-unified-${w}-utilization`);
    const reset = headerGet(h, `anthropic-ratelimit-unified-${w}-reset`);
    const status = headerGet(h, `anthropic-ratelimit-unified-${w}-status`);
    // "true" on 5h/7d, a float ("1.0") on 7d_oi (sub2api note): either way ≥ 1 means exceeded.
    const surpassed = headerGet(h, `anthropic-ratelimit-unified-${w}-surpassed-threshold`);
    if (util === null && reset === null && status === null && surpassed === null) return null;
    let used = toFraction(util) ?? (status?.toLowerCase() === "rejected" ? 1 : 0);
    if (surpassed !== null && (surpassed.toLowerCase() === "true" || (toFraction(surpassed) ?? 0) >= 1)) used = Math.max(used, 1);
    return { used, resetAt: toIso(reset), status: status ? status.toLowerCase() : null };
  };
  const fiveHour = point("5h");
  const sevenDay = point("7d");
  const fable = point("7d_oi");
  const snap = binding([
    ["five_hour", fiveHour],
    ["seven_day", sevenDay],
  ]);
  if (!snap) return null;
  if (!snap.resetAt) snap.resetAt = toIso(headerGet(h, "anthropic-ratelimit-unified-reset"));
  snap.fiveHour = fiveHour;
  snap.sevenDay = sevenDay;
  snap.fable = fable;
  snap.presence = { five_hour: !!fiveHour, seven_day: !!sevenDay, fable: !!fable };
  if (fable && !fable.resetAt) fable.resetAt = toIso(headerGet(h, "anthropic-ratelimit-unified-reset"));
  return snap;
}

/** On a 429: which window was rejected and when it resets (sub2api selectAnthropicExhaustedWindow). */
export function rejectedWindow(snap: WindowSnapshot | null, now: string): { window: string; resetAt: string } | null {
  if (!snap) return null;
  const cands: Array<[string, WindowPoint | null | undefined, number]> = [
    ["seven_day", snap.sevenDay, 8 * 86_400_000],
    ["five_hour", snap.fiveHour, 6 * 3_600_000],
  ];
  const nowMs = Date.parse(now);
  for (const [name, p, maxAge] of cands) {
    if (!p || !p.resetAt) continue;
    const exceeded = p.status === "rejected" || p.used >= 1 - 1e-9;
    if (!exceeded) continue;
    const resetMs = Date.parse(p.resetAt);
    if (resetMs <= nowMs || resetMs > nowMs + maxAge) continue;
    return { window: name, resetAt: p.resetAt };
  }
  return null;
}

/**
 * On a 429 for a Fable model: the Fable-only 7d window was rejected / exceeded and
 * resets at a sane time (≤ 8 days). Model-scoped: the caller cools only the "fable"
 * scope (sub2api selectAnthropicFableWindowLimit).
 */
export function fableRejectedWindow(snap: WindowSnapshot | null, now: string): { resetAt: string } | null {
  const p = snap?.fable;
  if (!p || !p.resetAt) return null;
  const exceeded = p.status === "rejected" || p.used >= 1 - 1e-9;
  if (!exceeded) return null;
  const nowMs = Date.parse(now);
  const resetMs = Date.parse(p.resetAt);
  if (resetMs <= nowMs || resetMs > nowMs + 8 * 86_400_000) return null;
  return { resetAt: p.resetAt };
}

/** Anthropic answers a Fable request with 429 `error.details.error_code = credits_required` when the org has no usage credits for the model (sub2api persistAnthropicFableCreditsRequired). */
export function isCreditsRequired(body: string): boolean {
  try {
    const j = JSON.parse(body) as { error?: { details?: { error_code?: unknown } } };
    return String(j?.error?.details?.error_code ?? "").toLowerCase() === "credits_required";
  } catch {
    return false;
  }
}

/**
 * Claude Code's own limit message, as it reaches the worker path in the
 * `result` text instead of 429 headers: "You've hit your session limit ·
 * resets 8:50am (Europe/Berlin)" (5h; 2.1.312 says "5-hour limit") / "…weekly
 * limit · resets Oct 21, 3pm (Europe/Berlin)" (7d). Returns the window kind and the reset instant
 * (wall time in the quoted zone → next occurrence ≥ now; null when the text
 * carries no parseable time), or null when the text is not a limit message.
 */
export function ccLimitReset(text: string, now = new Date()): { window: string; resetAt: string | null } | null {
  const hit = /hit your ([\w-]+) limit/i.exec(text);
  if (!hit) return null;
  const window = hit[1].toLowerCase();
  const m = /resets?\s+(?:([A-Z][a-z]{2})\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*(?:\(([^)]+)\))?/i.exec(text);
  if (!m) return { window, resetAt: null };
  const [, mon, day, hh, mm, ap, tz] = m;
  let hour = Number(hh) % 12;
  if (ap.toLowerCase() === "pm") hour += 12;
  const minute = Number(mm ?? 0);
  const zone = tz && tzValid(tz) ? tz : "UTC";
  // Walk day by day from yesterday (zone may be ahead of UTC) to a week ahead; first wall-time match ≥ now wins.
  for (let i = -1; i <= 8; i++) {
    const probe = new Date(now.getTime() + i * 86_400_000);
    const p = partsIn(probe, zone);
    if (mon && (p.monthShort.toLowerCase() !== mon.toLowerCase() || p.day !== Number(day))) continue;
    const guess = zonedToUtc(p.year, p.month, p.day, hour, minute, zone);
    if (guess.getTime() >= now.getTime()) return { window, resetAt: guess.toISOString().replace(/\.\d{3}Z$/, "Z") };
    if (mon) return { window, resetAt: null }; // the quoted date is already past
  }
  return { window, resetAt: null };
}

function tzValid(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function partsIn(d: Date, zone: string): { year: number; month: number; day: number; monthShort: string } {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(d);
  const get = (t: string) => Number(f.find((x) => x.type === t)?.value);
  const monthShort = new Intl.DateTimeFormat("en-US", { timeZone: zone, month: "short" }).format(d);
  return { year: get("year"), month: get("month"), day: get("day"), monthShort };
}

/** Wall time in `zone` → UTC instant (offset read at the guessed instant; DST edge within an hour tolerated). */
function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, zone: string): Date {
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  const offsetMs = (t: number) => {
    const f = new Intl.DateTimeFormat("en-US", { timeZone: zone, hour12: false, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }).formatToParts(new Date(t));
    const g = (k: string) => Number(f.find((x) => x.type === k)?.value);
    const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") % 24, g("minute"));
    return asUtc - t;
  };
  const first = naive - offsetMs(naive);
  return new Date(naive - offsetMs(first));
}

/** Human-readable pause reason, e.g. "five_hour 97% ≥ 95% until 2026-10-15T15:00:00Z". */
export function windowReason(snap: WindowSnapshot, thresholdPercent: number, until: string): string {
  return `${snap.window ?? "window"} ${Math.round(snap.used * 100)}% ≥ ${thresholdPercent}% until ${until}`;
}
