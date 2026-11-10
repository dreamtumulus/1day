// In-process counters named after docs/canonical-implementation-spec-2026-11-01.md WP7 §4 (…_total). No metrics
// stack exists yet (docs/operations.md §7). Since the 2026-11-09 review (H) the snapshot is served on
// GET /internal/metrics behind the internal token — labels carry organisation UUIDs and account ids — and the
// public /health answers liveness only. Counters reset with the process. Labels are folded into the name
// (`canonical_worker_open_total{profile=x,result=y}` → "canonical_worker_open_total{profile=x,result=y}").
//
// Cardinality is bounded (H): label values are reduced to a safe alphabet and truncated (client-controlled values
// such as an entrypoint, a version or a parameter name end up in labels), each counter name keeps at most
// METRICS_MAX_SERIES_PER_NAME label sets (default 100) and the whole map at most METRICS_MAX_KEYS keys (default
// 2000); whatever does not fit is added to that name's `{other=1}` bucket.

const counters = new Map<string, number>();
const seriesPerName = new Map<string, number>();
const gauges = new Map<string, () => Record<string, number>>();

function limit(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

export const LABEL_VALUE_MAX = 64;

/** A label value as it may appear in a key: printable, no separators of the key syntax, at most LABEL_VALUE_MAX chars. */
export function sanitizeLabelValue(v: string | number | boolean): string {
  const s = String(v).replace(/[^A-Za-z0-9_.:@/+-]/g, "_");
  return s.length > LABEL_VALUE_MAX ? `${s.slice(0, LABEL_VALUE_MAX - 1)}~` : s || "_";
}

function sanitizeName(name: string): string {
  return name.replace(/[^A-Za-z0-9_:]/g, "_").slice(0, 80) || "_";
}

export function bump(name: string, labels?: Record<string, string | number | boolean | null | undefined>, by = 1): void {
  const base = sanitizeName(name);
  const parts = labels ? Object.entries(labels).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${sanitizeName(k)}=${sanitizeLabelValue(v as string | number | boolean)}`) : [];
  let key = parts.length ? `${base}{${parts.join(",")}}` : base;
  if (!counters.has(key)) {
    const series = seriesPerName.get(base) ?? 0;
    const other = `${base}{other=1}`;
    // The plain name and the overflow bucket are always admitted: their number is bounded by the code's own counter names.
    if (parts.length && (series >= limit("METRICS_MAX_SERIES_PER_NAME", 100) || counters.size >= limit("METRICS_MAX_KEYS", 2000))) key = other;
    else if (parts.length) seriesPerName.set(base, series + 1);
  }
  counters.set(key, (counters.get(key) ?? 0) + by);
}

export function counterValue(name: string): number {
  return counters.get(name) ?? 0;
}

/** Values read at snapshot time (queue depths …). A failing provider is skipped. */
export function registerGauge(id: string, read: () => Record<string, number>): void {
  gauges.set(id, read);
}

export function countersSnapshot(): Record<string, number> {
  const out = new Map(counters);
  for (const read of gauges.values()) {
    try { for (const [k, v] of Object.entries(read())) if (Number.isFinite(v)) out.set(sanitizeName(k), v); } catch { /* gauge unavailable */ }
  }
  return Object.fromEntries([...out.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/** Tests only. */
export function resetCounters(): void {
  counters.clear();
  seriesPerName.clear();
}
