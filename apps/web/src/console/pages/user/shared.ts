// Local helpers shared by the consumer pages.

/** `*` wildcard match, anchored and case-insensitive (mirrors packages/core allowlist). */
export function wildcardMatch(pattern: string, value: string): boolean {
  const p = pattern.toLowerCase();
  const v = value.toLowerCase();
  if (!p.includes("*")) return p === v;
  const re = new RegExp(
    "^" +
      p
        .split("*")
        .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*") +
      "$",
  );
  return re.test(v);
}

export function allowedBy(allowlist: { enabled: boolean; models: string[] } | null, model: string): boolean {
  if (!allowlist || !allowlist.enabled) return true;
  if (allowlist.models.length === 0) return false;
  const candidates = [model, model.replace(/^models\//, "")];
  return candidates.some((c) => allowlist.models.some((p) => wildcardMatch(p, c)));
}

/** <input type="date"> value -> ISO at end of that local day (or null). */
export function dateInputToIso(v: string): string | null {
  if (!v) return null;
  const d = new Date(`${v}T23:59:59`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** ISO -> local YYYY-MM-DD for <input type="date">. */
export function isoToDateInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Local YYYY-MM-DD range -> API from/to (UTC days). Good enough for day-level filters. */
export function rangeParams(from: string, to: string): { from?: string; to?: string } {
  return { from: from || undefined, to: to || undefined };
}
