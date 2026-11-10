// Platform prompt overhead of the CCR lanes (X-54, docs/ccr-supply.md §7.1).
//
// On the worker / cloud lanes a real Claude Code runs the customer's request and prepends its own system prompt, tool
// descriptions and environment blocks. Those tokens are the platform's cost. This module answers "how many tokens does
// Claude Code add per upstream API call for this kind of turn" and learns the answer from real traffic:
//
//   key      = lane | tools | upstream model | Claude Code version      (what changes Claude Code's own prompt)
//   sample   = upstreamPromptTotal − local estimate of the customer's own prompt, taken only from turns where the
//              customer part is small and known (fresh, one user message, one upstream call, estimate ≤ 400 tokens)
//   value    = a LOW percentile (p10) of the last 64 samples, trusted once the window holds 8
//
// Why p10: a sample's error is one-sided. The local estimate is chars/4, which under-counts CJK text and never sees an
// auxiliary upstream call, so samples err upward (too much overhead); accounts also differ by a few hundred tokens.
// A low percentile sits at the smallest overhead seen, so the subtraction errs toward taking slightly too little and
// a customer's real prompt is never swallowed. p10 rather than the minimum so one freak low sample does not rule the
// window (below 11 samples p10 is the minimum).
//
// State is shared by every gateway instance through SQLite (table ccr_overhead_calibration, migration 43): samples
// are buffered in memory and merged into the row at most once per `flushMs` per key; the table is re-read at most
// once per `flushMs`. A database error never reaches the caller: the instance goes on with what it has in memory.

import { all, one, run, tx } from "./db.js";

export type OverheadLane = "legacy" | "p" | "tui" | "cloud";
/** none = no caller tools; caller = caller tools beside Claude Code's built-in tools; caller-only = built-in tools dropped (tools-disabled profile). */
export type OverheadTools = "none" | "caller" | "caller-only";
export const OVERHEAD_LANES: OverheadLane[] = ["legacy", "p", "tui", "cloud"];
export const OVERHEAD_TOOLS: OverheadTools[] = ["none", "caller", "caller-only"];

export interface OverheadKey {
  lane: OverheadLane;
  tools: OverheadTools;
  /** Upstream model id. */
  model: string;
  /** Claude Code version the node reported (null when unknown: cloud sessions, an old console). */
  version: string | null;
}

export type OverheadSource = "pinned" | "learned" | "learned_version" | "learned_lane" | "inherited" | "default" | "baseline";

export interface OverheadResolution {
  /** Tokens Claude Code adds per upstream API call. */
  perCall: number;
  source: OverheadSource;
  /** The turn's own key. */
  key: string;
  /** Where the value came from: a table key, a pin spec, a default spec; null for the baseline setting. */
  matched: string | null;
  /** Samples in the window behind a learned value (0 otherwise). */
  samples: number;
}

export interface OverheadPin {
  lane: OverheadLane;
  tools: OverheadTools | null;
  model: string | null;
  value: number;
  spec: string;
}

export const OVERHEAD_WINDOW = 64;
export const OVERHEAD_MIN_SAMPLES = 8;
export const OVERHEAD_PERCENTILE = 0.1;
export const OVERHEAD_FLUSH_MS = 15_000;
/** A sample is taken only when the local estimate of the customer's own prompt is at most this many tokens. */
export const OVERHEAD_SAMPLE_MAX_ESTIMATE = 400;
const SAMPLE_MAX = 500_000;
const KEEP_DAYS = 45;

/**
 * Shipped defaults, used until a key has learned its own value. Measured single-message totals minus a margin of
 * ~100 tokens, so a default never takes more than the real overhead:
 *   TUI (interactive Claude Code 2.1.319, docs/tui-worker-2026-11-08.md): opus-5-5 30069 / opus-4-6 25802 / opus-4-8 28994 /
 *   sonnet-5 34711; production 2026-11-10 opus-5-5 raw totals 29705–30243. Another model gets the smallest of them.
 *   TUI with caller tools and the built-in tools dropped: 3972 measured with one small tool.
 *   `-p` canonical (2.1.312 --restricted) without caller tools: production raw totals 12331–12339.
 * No entry = unknown (legacy `-p`, cloud, `-p` with caller tools): the ccr_cache_baseline_* setting applies.
 */
export const OVERHEAD_DEFAULTS: Array<{ lane: OverheadLane; tools: OverheadTools; model: string | null; value: number }> = [
  { lane: "tui", tools: "none", model: "claude-opus-5-5", value: 29600 },
  { lane: "tui", tools: "none", model: "claude-opus-4-8", value: 28900 },
  { lane: "tui", tools: "none", model: "claude-opus-4-6", value: 25700 },
  { lane: "tui", tools: "none", model: "claude-sonnet-5", value: 34600 },
  { lane: "tui", tools: "none", model: null, value: 25700 },
  { lane: "tui", tools: "caller-only", model: null, value: 3800 },
  { lane: "p", tools: "none", model: null, value: 12200 },
];

export function overheadKeyString(k: OverheadKey): string {
  return `${k.lane}|${k.tools}|${k.model}|${k.version ?? "-"}`;
}

export function parseOverheadKey(s: string): OverheadKey | null {
  const p = s.split("|");
  if (p.length !== 4 || !OVERHEAD_LANES.includes(p[0] as OverheadLane) || !OVERHEAD_TOOLS.includes(p[1] as OverheadTools) || !p[2]) return null;
  return { lane: p[0] as OverheadLane, tools: p[1] as OverheadTools, model: p[2], version: p[3] === "-" ? null : p[3] };
}

/**
 * settings `ccr_overhead_pins`: entries `lane[:tools[:model]]=tokens` separated by commas, semicolons or newlines,
 * e.g. `tui:none=29000, tui:caller-only=3800, p:none:claude-opus-5-5=12300`. The most specific matching entry wins.
 */
export function parseOverheadPins(text: string): { pins: OverheadPin[]; errors: string[] } {
  const pins: OverheadPin[] = [];
  const errors: string[] = [];
  for (const raw of String(text ?? "").split(/[,;\n]/)) {
    const entry = raw.trim();
    if (!entry) continue;
    const m = /^([a-z]+)(?::([a-z-]+))?(?::([A-Za-z0-9._\-\[\]]+))?\s*=\s*(\d{1,7})$/.exec(entry);
    if (!m || !OVERHEAD_LANES.includes(m[1] as OverheadLane) || (m[2] !== undefined && !OVERHEAD_TOOLS.includes(m[2] as OverheadTools))) {
      errors.push(entry);
      continue;
    }
    pins.push({ lane: m[1] as OverheadLane, tools: (m[2] as OverheadTools | undefined) ?? null, model: m[3] ?? null, value: Number(m[4]), spec: entry.replace(/\s+/g, "") });
  }
  return { pins, errors };
}

function matchPin(pins: OverheadPin[], k: OverheadKey): OverheadPin | null {
  let best: OverheadPin | null = null;
  let bestScore = -1;
  for (const p of pins) {
    if (p.lane !== k.lane || (p.tools !== null && p.tools !== k.tools) || (p.model !== null && p.model !== k.model)) continue;
    const score = (p.tools !== null ? 1 : 0) + (p.model !== null ? 1 : 0);
    if (score > bestScore) { best = p; bestScore = score; }
  }
  return best;
}

function matchDefault(lane: OverheadLane, tools: OverheadTools, model: string): { value: number; spec: string } | null {
  const hit = OVERHEAD_DEFAULTS.find((d) => d.lane === lane && d.tools === tools && d.model === model) ?? OVERHEAD_DEFAULTS.find((d) => d.lane === lane && d.tools === tools && d.model === null);
  return hit ? { value: hit.value, spec: `${hit.lane}:${hit.tools}${hit.model ? `:${hit.model}` : ""}` } : null;
}

/** Low percentile of a sample window (nearest rank, rounded down); null for an empty window. */
export function overheadPercentile(values: number[], p = OVERHEAD_PERCENTILE): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(p * (sorted.length - 1))];
}

type Sample = [number, number]; // [ms epoch, tokens]

export interface OverheadRow {
  key: string;
  /** p10 of the window; null while the window holds fewer than the minimum. */
  value: number | null;
  /** Samples in the window. */
  samples: number;
  /** Samples accepted since the key was first seen. */
  n: number;
  min: number | null;
  max: number | null;
  updatedAt: string | null;
}

interface KeyState {
  samples: Sample[];
  n: number;
  updatedAt: string | null;
}

export interface OverheadCalibratorOptions {
  now?: () => number;
  flushMs?: number;
  window?: number;
  minSamples?: number;
  percentile?: number;
  /** Called with a short reason whenever the table could not be read or written (the caller counts it). */
  onDbError?: (op: "read" | "write", err: unknown) => void;
}

function parseSamples(json: string): Sample[] {
  try {
    const v = JSON.parse(json) as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter((s): s is Sample => Array.isArray(s) && s.length === 2 && Number.isFinite(s[0]) && Number.isFinite(s[1]) && s[1] > 0);
  } catch {
    return [];
  }
}

function mergeSamples(a: Sample[], b: Sample[], window: number): Sample[] {
  return [...a, ...b].sort((x, y) => x[0] - y[0]).slice(-window);
}

export class OverheadCalibrator {
  private readonly now: () => number;
  private readonly flushMs: number;
  private readonly window: number;
  private readonly minSamples: number;
  private readonly percentile: number;
  private readonly onDbError: (op: "read" | "write", err: unknown) => void;
  /** What the table held at the last read / own write. */
  private stored = new Map<string, KeyState>();
  private loadedAt = -Infinity;
  /** Samples not written yet. */
  private readonly pending = new Map<string, Sample[]>();
  private readonly lastFlush = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private lastPrune = 0;

  constructor(o: OverheadCalibratorOptions = {}) {
    this.now = o.now ?? Date.now;
    this.flushMs = o.flushMs ?? OVERHEAD_FLUSH_MS;
    this.window = o.window ?? OVERHEAD_WINDOW;
    this.minSamples = o.minSamples ?? OVERHEAD_MIN_SAMPLES;
    this.percentile = o.percentile ?? OVERHEAD_PERCENTILE;
    this.onDbError = o.onDbError ?? (() => {});
  }

  private refresh(force = false): void {
    const now = this.now();
    if (!force && now - this.loadedAt < this.flushMs) return;
    this.loadedAt = now; // also after a failure: a broken table is not re-read on every request
    try {
      const next = new Map<string, KeyState>();
      for (const r of all<{ key: string; samples: string; n: number; updated_at: string }>("SELECT key, samples, n, updated_at FROM ccr_overhead_calibration")) {
        next.set(r.key, { samples: parseSamples(r.samples), n: Number(r.n) || 0, updatedAt: r.updated_at });
      }
      this.stored = next;
    } catch (err) {
      this.onDbError("read", err);
    }
  }

  /** The window as this instance sees it: the table's samples plus its own unwritten ones. */
  private view(key: string): KeyState {
    const s = this.stored.get(key);
    const p = this.pending.get(key);
    if (!p || p.length === 0) return s ?? { samples: [], n: 0, updatedAt: null };
    return { samples: mergeSamples(s?.samples ?? [], p, this.window), n: (s?.n ?? 0) + p.length, updatedAt: new Date(p[p.length - 1][0]).toISOString() };
  }

  private learned(key: string): { value: number; samples: number } | null {
    const v = this.view(key);
    if (v.samples.length < this.minSamples) return null;
    const value = overheadPercentile(v.samples.map((s) => s[1]), this.percentile);
    return value === null ? null : { value, samples: v.samples.length };
  }

  private keys(): string[] {
    return [...new Set([...this.stored.keys(), ...this.pending.keys()])];
  }

  /** Learned value for lane + tools + model: the exact version, else the most recently updated other version, else the smallest of the lane's other models. */
  private learnedChain(k: OverheadKey): { perCall: number; source: OverheadSource; matched: string; samples: number } | null {
    const exact = overheadKeyString(k);
    const hit = this.learned(exact);
    if (hit) return { perCall: hit.value, source: "learned", matched: exact, samples: hit.samples };
    let sameModel: { key: string; value: number; samples: number; at: string } | null = null;
    let lane: { key: string; value: number; samples: number } | null = null;
    for (const key of this.keys()) {
      if (key === exact) continue;
      const pk = parseOverheadKey(key);
      if (!pk || pk.lane !== k.lane || pk.tools !== k.tools) continue;
      const l = this.learned(key);
      if (!l) continue;
      if (pk.model === k.model) {
        const at = this.view(key).updatedAt ?? "";
        if (!sameModel || at > sameModel.at) sameModel = { key, value: l.value, samples: l.samples, at };
      } else if (!lane || l.value < lane.value) lane = { key, value: l.value, samples: l.samples };
    }
    if (sameModel) return { perCall: sameModel.value, source: "learned_version", matched: sameModel.key, samples: sameModel.samples };
    if (lane) return { perCall: lane.value, source: "learned_lane", matched: lane.key, samples: lane.samples };
    return null;
  }

  /**
   * Overhead per upstream call for a turn. Order: pin → learned (exact key → other version of the model → smallest of
   * the lane's other models) → for caller tools beside the built-in ones, the same chain of the lane without caller
   * tools (the prompt is a superset of it) → shipped default → the legacy baseline setting. With calibration off the
   * learned steps are skipped.
   */
  resolve(k: OverheadKey, o: { baseline: number; calibration: boolean; pins?: OverheadPin[] }): OverheadResolution {
    const key = overheadKeyString(k);
    const pin = matchPin(o.pins ?? [], k);
    if (pin) return { perCall: pin.value, source: "pinned", key, matched: pin.spec, samples: 0 };
    const inherit: OverheadKey | null = k.tools === "caller" ? { ...k, tools: "none" } : null;
    if (o.calibration) {
      this.refresh();
      const own = this.learnedChain(k);
      if (own) return { ...own, key };
      const base = inherit ? this.learnedChain(inherit) : null;
      if (base) return { perCall: base.perCall, source: "inherited", key, matched: base.matched, samples: base.samples };
    }
    const d = matchDefault(k.lane, k.tools, k.model);
    if (d) return { perCall: d.value, source: "default", key, matched: d.spec, samples: 0 };
    const di = inherit ? matchDefault(inherit.lane, inherit.tools, inherit.model) : null;
    if (di) return { perCall: di.value, source: "inherited", key, matched: di.spec, samples: 0 };
    return { perCall: Math.max(0, Math.floor(o.baseline) || 0), source: "baseline", key, matched: null, samples: 0 };
  }

  /** One calibration sample (tokens of platform overhead seen on an eligible turn). Never throws. */
  record(k: OverheadKey, sample: number): { accepted: boolean; reason?: "out_of_range" } {
    if (!Number.isFinite(sample) || sample < 1 || sample > SAMPLE_MAX) return { accepted: false, reason: "out_of_range" };
    const key = overheadKeyString(k);
    const now = this.now();
    const list = this.pending.get(key) ?? [];
    list.push([now, Math.floor(sample)]);
    if (list.length > this.window) list.splice(0, list.length - this.window);
    this.pending.set(key, list);
    if (now - (this.lastFlush.get(key) ?? -Infinity) >= this.flushMs) this.flushKey(key);
    else if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.flushMs);
      this.timer.unref?.();
    }
    return { accepted: true };
  }

  private flushKey(key: string): void {
    const mine = this.pending.get(key);
    if (!mine || mine.length === 0) return;
    const now = this.now();
    this.lastFlush.set(key, now);
    try {
      const state = tx(() => {
        const row = one<{ samples: string; n: number }>("SELECT samples, n FROM ccr_overhead_calibration WHERE key = ?", key);
        const samples = mergeSamples(row ? parseSamples(row.samples) : [], mine, this.window);
        const n = (row ? Number(row.n) || 0 : 0) + mine.length;
        const value = samples.length >= this.minSamples ? overheadPercentile(samples.map((s) => s[1]), this.percentile) : null;
        const updatedAt = new Date(now).toISOString();
        run(
          "INSERT INTO ccr_overhead_calibration(key, samples, n, value, updated_at) VALUES (?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET samples = excluded.samples, n = excluded.n, value = excluded.value, updated_at = excluded.updated_at",
          key, JSON.stringify(samples), n, value, updatedAt,
        );
        if (now - this.lastPrune > 3_600_000) {
          this.lastPrune = now;
          run("DELETE FROM ccr_overhead_calibration WHERE updated_at < ?", new Date(now - KEEP_DAYS * 86_400_000).toISOString());
        }
        return { samples, n, updatedAt };
      });
      this.stored.set(key, state);
      this.pending.delete(key);
    } catch (err) {
      this.onDbError("write", err); // the samples stay pending (bounded by the window) and still count in this instance
    }
  }

  /** Write every buffered sample now (timer, tests, shutdown). */
  flush(): void {
    for (const key of [...this.pending.keys()]) this.flushKey(key);
  }

  /** Every key this instance knows, for the admin view and the gauge. */
  rows(): OverheadRow[] {
    this.refresh();
    return this.keys().sort().map((key) => {
      const v = this.view(key);
      const values = v.samples.map((s) => s[1]);
      return {
        key,
        value: v.samples.length >= this.minSamples ? overheadPercentile(values, this.percentile) : null,
        samples: v.samples.length,
        n: v.n,
        min: values.length ? Math.min(...values) : null,
        max: values.length ? Math.max(...values) : null,
        updatedAt: v.updatedAt,
      };
    });
  }

  calibratedKeys(): number {
    return this.rows().filter((r) => r.value !== null).length;
  }
}

/** The process's calibrator (gateway). The console reads the table through `overheadCalibrationRows()`. */
export const overheadCalibrator = new OverheadCalibrator({
  onDbError: (op, err) => console.warn(`[overhead] calibration table ${op} failed (requests unaffected): ${(err as Error)?.message ?? err}`),
});

/** Admin view straight from the table (console process): what every gateway has written. */
export function overheadCalibrationRows(): OverheadRow[] {
  return new OverheadCalibrator({ flushMs: 0 }).rows();
}

/** Admin: forget what was learned (all keys, or one). Returns the number of rows removed. */
export function resetOverheadCalibration(key?: string): number {
  return key ? run("DELETE FROM ccr_overhead_calibration WHERE key = ?", key).changes : run("DELETE FROM ccr_overhead_calibration").changes;
}
