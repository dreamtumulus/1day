// Rate limiter for repeating diagnostics (heartbeats repeat the same fact every few seconds).
const last = new Map<string, number>();

/** True at most once per `intervalMs` for a key; the caller logs only when it returns true. */
export function oncePer(key: string, intervalMs: number, now = Date.now()): boolean {
  const prev = last.get(key);
  if (prev !== undefined && now - prev < intervalMs) return false;
  if (last.size > 5000) for (const [k, t] of last) if (now - t > 3_600_000) last.delete(k);
  last.set(key, now);
  return true;
}

/** Test hook. */
export function resetLogLimits(): void {
  last.clear();
}
