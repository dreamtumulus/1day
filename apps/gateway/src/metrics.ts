// In-process counters named after docs/canonical-implementation-spec-2026-11-01.md WP7 §4 (…_total). No metrics
// stack exists yet (docs/operations.md §7); the counters are exposed on /health as `counters` so release-verify and
// the 1day-health report can read them, and reset with the process. Labels are folded into the name
// (`canonical_worker_open_total{profile=x,result=y}` → "canonical_worker_open_total{profile=x,result=y}").

const counters = new Map<string, number>();

export function bump(name: string, labels?: Record<string, string | number | boolean | null | undefined>, by = 1): void {
  const key = labels && Object.keys(labels).length ? `${name}{${Object.entries(labels).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${k}=${String(v)}`).join(",")}}` : name;
  counters.set(key, (counters.get(key) ?? 0) + by);
}

export function counterValue(name: string): number {
  return counters.get(name) ?? 0;
}

export function countersSnapshot(): Record<string, number> {
  return Object.fromEntries([...counters.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/** Tests only. */
export function resetCounters(): void {
  counters.clear();
}
