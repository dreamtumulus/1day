// All timestamps are stored as ISO-8601 UTC strings with second precision
// ("2026-10-15T07:01:02Z"): lexicographic order == time order, and both
// SQLite date functions and JS Date parse them.

export const SQL_NOW = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";

export function isoAt(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19) + "Z";
}

export function nowIso(): string {
  return isoAt(Date.now());
}

export function isoIn(ms: number): string {
  return isoAt(Date.now() + ms);
}

/** "YYYY-MM-DD" (UTC) for an offset in days from today (0 = today). */
export function dayIso(offsetDays = 0): string {
  return isoAt(Date.now() + offsetDays * 86_400_000).slice(0, 10);
}

/** Normalize a client-supplied date/datetime to stored ISO form, or null. */
export function parseIsoInput(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const ms = Date.parse(v.trim());
  return Number.isFinite(ms) ? isoAt(ms) : null;
}
