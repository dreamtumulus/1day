// Platform prompt overhead on the CCR lanes (X-54, docs/ccr-supply.md §7.1): what the customer sees and pays is the
// customer's own prompt, not Claude Code's system prompt / tool descriptions / environment blocks.
//
//   upstreamPromptTotal P = input + cache_read + cache_creation            (the turn's raw upstream usage)
//   wanted deduction      = overhead per upstream call × upstream calls    (core/overhead-calibration.ts resolves it)
//   visible total         = min(cap, max(floor, P − wanted))
//       floor = max(1, ½ × local estimate of the customer's prompt)  — over-subtraction can never show a real prompt as 0
//       cap   = 6 × estimate + 64, only on a fresh single-message single-call turn with an estimate ≤ 400 tokens: there
//               the customer's part is known to be small, whatever the learned value says (new Claude Code version,
//               key not calibrated yet, an account with a longer prefix)
//   deduction             = max(P − visible, min(legacy baseline, P))      — never less than before X-54: no bill rises
// taken from the buckets in the existing order: cache read → cache creation 1h → 5m → input.

import { getSettings, overheadCalibrator, overheadKeyString, parseOverheadPins, OVERHEAD_SAMPLE_MAX_ESTIMATE, type OverheadKey, type OverheadPin, type OverheadResolution, type OverheadSource } from "@1dayapi/core";
import { bump, registerGauge } from "../metrics.js";
import { estimateRequestTokens } from "../usage.js";

type Json = Record<string, any>;

/** Share of the local estimate that always stays visible. */
export const MIN_VISIBLE_FACTOR = 0.5;
/** Small-turn plausibility cap: visible ≤ CAP_FACTOR × estimate + CAP_SLACK (chars/4 under-counts CJK by up to ~6×). */
export const SMALL_TURN_CAP_FACTOR = 6;
export const SMALL_TURN_CAP_SLACK = 64;

export interface OverheadPlan {
  /** Tokens Claude Code adds per upstream API call for this turn's key. */
  perCall: number;
  source: OverheadSource;
  key: OverheadKey | null;
  matched: string | null;
  /** The legacy single subtraction (settings ccr_cache_baseline_*): the lower bound of the deduction. */
  baseline: number;
  /** Local estimate (chars/4, media flat) of the customer's own system + messages + tools; null = unknown. */
  customerEstimate: number | null;
  /** Fresh request with one user message, no tool result, no media and an estimate ≤ 400: the customer part is known to be small. */
  small: boolean;
  /** settings ccr_overhead_calibration. */
  calibration: boolean;
}

export interface PromptBuckets {
  input: number;
  read: number;
  creation5m: number;
  creation1h: number;
}

export interface OverheadApplied extends PromptBuckets {
  /** Tokens taken off the upstream prompt total. */
  deducted: number;
  /** perCall × calls (or the baseline once), before floor / cap / never-raise. */
  wanted: number;
  /** Which rule decided the visible total. */
  rule: "overhead" | "floor" | "cap" | "baseline";
}

const total = (b: PromptBuckets): number => b.input + b.read + b.creation5m + b.creation1h;

/** Take `d` tokens off the buckets: cache read first, then creation 1h, then 5m, then input (each clamped at 0). */
export function deduct(raw: PromptBuckets, d: number): PromptBuckets {
  let left = Math.max(0, d);
  const take = (n: number): number => {
    const t = Math.min(n, left);
    left -= t;
    return n - t;
  };
  const read = take(raw.read);
  const creation1h = take(raw.creation1h);
  const creation5m = take(raw.creation5m);
  const input = take(raw.input);
  return { input, read, creation5m, creation1h };
}

/** Client-visible prompt buckets of a turn. `plan` null = the pre-X-54 logic (baseline once). */
export function applyOverhead(raw: PromptBuckets, calls: number, plan: OverheadPlan | null, legacyBaseline = 0): OverheadApplied {
  const P = total(raw);
  const baseline = Math.min(P, Math.max(0, Math.floor(plan ? plan.baseline : legacyBaseline) || 0));
  if (!plan || plan.source === "baseline" && !plan.calibration) return { ...deduct(raw, baseline), deducted: baseline, wanted: baseline, rule: "baseline" };
  const n = Math.max(1, Math.floor(calls) || 1);
  const wanted = plan.source === "baseline" ? baseline : Math.max(0, Math.floor(plan.perCall)) * n;
  const est = plan.customerEstimate;
  const floor = Math.min(P, Math.max(1, est === null ? 1 : Math.ceil(est * MIN_VISIBLE_FACTOR)));
  const capped = plan.calibration && plan.small && n === 1 && plan.source !== "pinned" && est !== null;
  const cap = capped ? SMALL_TURN_CAP_FACTOR * est! + SMALL_TURN_CAP_SLACK : Infinity;
  let visible = P - Math.min(wanted, P);
  let rule: OverheadApplied["rule"] = plan.source === "baseline" ? "baseline" : "overhead";
  if (visible < floor) { visible = floor; rule = "floor"; }
  if (visible > cap) { visible = cap; rule = "cap"; }
  let deducted = P - visible;
  if (deducted < baseline) { deducted = baseline; rule = "baseline"; }
  return { ...deduct(raw, deducted), deducted, wanted, rule };
}

// ---- glue: settings, key, counters ----

let pinsCache: { text: string; pins: OverheadPin[] } = { text: "", pins: [] };
function pinsOf(text: string): OverheadPin[] {
  if (text !== pinsCache.text) pinsCache = { text, pins: parseOverheadPins(text).pins };
  return pinsCache.pins;
}

const hasMediaOrToolResult = (content: unknown): boolean =>
  Array.isArray(content) && content.some((b) => b && typeof b === "object" && ["image", "document", "tool_result", "tool_use"].includes(String((b as Json).type)));

/** Local estimate of the customer's own prompt: system + messages + tools of the Anthropic-shaped body. */
export function customerPromptEstimate(body: Json): number {
  return estimateRequestTokens({ system: body.system, messages: body.messages, tools: body.tools });
}

/** One user message, nothing but text, small estimate. */
export function isSmallRequest(body: Json, estimate: number): boolean {
  const msgs: Json[] = Array.isArray(body.messages) ? body.messages : [];
  return msgs.length === 1 && msgs[0]?.role === "user" && !hasMediaOrToolResult(msgs[0].content) && estimate <= OVERHEAD_SAMPLE_MAX_ESTIMATE;
}

/**
 * The turn's overhead plan. `fresh` = first turn of a session (a continuation uses the same key — the prefix of every
 * upstream call is the same — but is never "small": its upstream prompt also holds the earlier conversation).
 */
export function planOverhead(o: { key: OverheadKey; body: Json; fresh: boolean; baselineSetting: "ccr_cache_baseline_worker" | "ccr_cache_baseline_cloud" }): OverheadPlan {
  const s = getSettings();
  const baseline = Math.max(0, Math.floor(Number(s[o.baselineSetting])) || 0);
  const calibration = s.ccr_overhead_calibration !== "off";
  let customerEstimate: number | null = null;
  try { customerEstimate = customerPromptEstimate(o.body); } catch { /* unknown */ }
  let r: OverheadResolution;
  try {
    r = overheadCalibrator.resolve(o.key, { baseline, calibration, pins: pinsOf(s.ccr_overhead_pins) });
  } catch (err) {
    console.warn(`[overhead] resolve failed for ${overheadKeyString(o.key)} (baseline used): ${(err as Error).message}`);
    r = { perCall: baseline, source: "baseline", key: overheadKeyString(o.key), matched: null, samples: 0 };
  }
  bump("ccr_overhead_source_total", { lane: o.key.lane, source: r.source });
  return { perCall: r.perCall, source: r.source, key: o.key, matched: r.matched, baseline, customerEstimate, small: o.fresh && customerEstimate !== null && isSmallRequest(o.body, customerEstimate), calibration };
}

export interface OverheadTurn {
  /** Raw upstream prompt buckets of the turn. */
  raw: PromptBuckets;
  /** Upstream API calls whose usage the raw numbers hold. */
  calls: number;
  /** The turn ended with an error / without usage: no sample. */
  failed: boolean;
  hasUsage: boolean;
}

/** Turn end: take a calibration sample when the turn is eligible. Never throws. */
export function recordOverheadSample(plan: OverheadPlan | null, turn: OverheadTurn): void {
  if (!plan?.key || !plan.calibration) return;
  const reject = (reason: string): void => bump("ccr_overhead_sample_rejected_total", { reason });
  try {
    if (!plan.small || plan.customerEstimate === null) return reject("not_small_fresh");
    if (turn.failed) return reject("turn_failed");
    if (!turn.hasUsage) return reject("no_usage");
    if (turn.calls !== 1) return reject("multi_call");
    const sample = total(turn.raw) - plan.customerEstimate;
    const r = overheadCalibrator.record(plan.key, sample);
    if (r.accepted) bump("ccr_overhead_sample_accepted_total", { lane: plan.key.lane });
    else reject(r.reason ?? "out_of_range");
  } catch (err) {
    reject("error");
    console.warn(`[overhead] sample not recorded: ${(err as Error).message}`);
  }
}

/** Platform-ledger half of the turn's log line: raw upstream prompt, what came off and why, what the customer sees. */
export function overheadLogLine(plan: OverheadPlan | null, raw: PromptBuckets, calls: number, applied: OverheadApplied): string {
  const vis = `in=${applied.input} cr=${applied.read} cw5m=${applied.creation5m} cw1h=${applied.creation1h}`;
  const src = plan ? `${plan.source}${plan.matched ? `:${plan.matched}` : ""} ${plan.perCall}×${Math.max(1, calls)}` : "baseline";
  return `raw in=${raw.input} cr=${raw.read} cw5m=${raw.creation5m} cw1h=${raw.creation1h} | overhead ${src} key=${plan?.key ? overheadKeyString(plan.key) : "-"} est=${plan?.customerEstimate ?? "-"} → deducted ${applied.deducted} (${applied.rule}) | visible ${vis}`;
}

registerGauge("ccr_overhead", () => ({ ccr_overhead_calibrated_keys: overheadCalibrator.calibratedKeys() }));
