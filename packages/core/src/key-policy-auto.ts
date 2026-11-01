// Key-policy judge (docs/canonical-implementation-spec-2026-11-01.md §6.2 / WP8; user decision 2026-11-01: automatic by
// default, administrator can override). It derives the `auto` layer of `api_keys.policy_json` from what the key's
// traffic looks like, writes every flip to `key_policy_events` (migration 35, append-only) and never touches the
// `override` layer. Whether the auto layer is *in force* is a separate three-state switch (`key_policy_auto`:
// 0 = record only / canary / 1), so the first week runs in observe mode.
//
// First version rules (spec §6.2 table), from usage_logs only:
//   ≥95% genuine Claude Code  → canonical / native-required / strict / strict / passthrough
//   otherwise (API client)    → canonical / native-required / warn / keepalive when it has >75 s non-stream
//                               requests else strict / historyPolicy left to the system default (no foreign-history
//                               observation in usage_logs yet; same for ignored-params hits and probe shape)
// Hysteresis: a key is first judged after 50 requests (adopted at once); afterwards a different proposal has to stay
// identical for ≥ 3 days (`pending`) before it replaces the current auto layer. Only new conversations pick up a
// changed policy (the gateway reads policy_json per request; conversation mode is fixed at start — WP3).

import { all, one, run } from "./db.js";
import { nowIso } from "./time.js";
import { KEY_POLICY_FIELDS, parseKeyPolicyDoc, serializeKeyPolicyDoc, type KeyPolicyAutoLayer, type KeyPolicyLayer } from "./key-policy.js";

export const JUDGE_MIN_REQUESTS = 50;
export const JUDGE_WINDOW_DAYS = 14;
export const JUDGE_STABLE_MS = 3 * 86_400_000;
export const JUDGE_GENUINE_RATIO = 0.95;
export const JUDGE_LONG_NON_STREAM_MS = 75_000;

export interface KeyObservation {
  apiKeyId: string;
  windowDays: number;
  /** Non-probe requests in the window. */
  requests: number;
  /** Requests with a Claude Code user agent (cc_shape not null). */
  ccRequests: number;
  /** Requests that passed the shape gate. */
  genuineRequests: number;
  /** /v1/messages requests (Anthropic dialect). */
  messagesRequests: number;
  streamRequests: number;
  /** Successful non-stream requests that took longer than JUDGE_LONG_NON_STREAM_MS. */
  longNonStream: number;
  errorRequests: number;
  since: string | null;
}

export function observeKey(apiKeyId: string, windowDays = JUDGE_WINDOW_DAYS, now = Date.now()): KeyObservation {
  const from = new Date(now - windowDays * 86_400_000).toISOString();
  const r = one<{ n: number; cc: number; genuine: number; msgs: number; streams: number; longns: number; errs: number; since: string | null }>(
    `SELECT COUNT(*) AS n,
            COALESCE(SUM(cc_shape IS NOT NULL), 0) AS cc,
            COALESCE(SUM(cc_shape = 'genuine'), 0) AS genuine,
            COALESCE(SUM(endpoint LIKE '%/messages%'), 0) AS msgs,
            COALESCE(SUM(stream = 1), 0) AS streams,
            COALESCE(SUM(stream = 0 AND status_code = 200 AND duration_ms > ?), 0) AS longns,
            COALESCE(SUM(status_code >= 400), 0) AS errs,
            MIN(created_at) AS since
       FROM usage_logs WHERE api_key_id = ? AND created_at >= ? AND (mode IS NULL OR mode <> 'probe')`,
    JUDGE_LONG_NON_STREAM_MS, apiKeyId, from,
  )!;
  return { apiKeyId, windowDays, requests: r.n, ccRequests: r.cc, genuineRequests: r.genuine, messagesRequests: r.msgs, streamRequests: r.streams, longNonStream: r.longns, errorRequests: r.errs, since: r.since };
}

/** Keys with enough traffic in the window to be judged. */
export function keysToJudge(windowDays = JUDGE_WINDOW_DAYS, now = Date.now(), minRequests = JUDGE_MIN_REQUESTS): string[] {
  const from = new Date(now - windowDays * 86_400_000).toISOString();
  return all<{ api_key_id: string }>(
    `SELECT api_key_id FROM usage_logs WHERE created_at >= ? AND (mode IS NULL OR mode <> 'probe') GROUP BY api_key_id HAVING COUNT(*) >= ? ORDER BY api_key_id`,
    from, minRequests,
  ).map((r) => r.api_key_id);
}

export interface KeyPolicyProposal { layer: KeyPolicyLayer; basis: string }

/** The spec §6.2 rule table on one observation; null when the key has not been seen enough. */
export function proposeKeyPolicy(obs: KeyObservation): KeyPolicyProposal | null {
  if (obs.requests < JUDGE_MIN_REQUESTS) return null;
  const ratio = (n: number) => (obs.requests ? Math.round((n / obs.requests) * 1000) / 1000 : 0);
  const genuineRatio = ratio(obs.genuineRequests);
  const protocol = obs.messagesRequests >= obs.requests / 2 ? "messages" : "chat";
  const basis = `window=${obs.windowDays}d;requests=${obs.requests};cc_genuine_ratio=${genuineRatio};cc_ua_ratio=${ratio(obs.ccRequests)};protocol=${protocol}:${ratio(obs.messagesRequests)};stream_ratio=${ratio(obs.streamRequests)};long_nonstream=${obs.longNonStream};error_ratio=${ratio(obs.errorRequests)}`;
  if (genuineRatio >= JUDGE_GENUINE_RATIO) {
    return { layer: { workerMode: "canonical", telemetryPolicy: "native-required", parameterPolicy: "strict", responseMode: "strict", historyPolicy: "passthrough" }, basis: `${basis};rule=genuine_cc` };
  }
  return {
    layer: { workerMode: "canonical", telemetryPolicy: "native-required", parameterPolicy: "warn", responseMode: obs.longNonStream > 0 ? "keepalive" : "strict" },
    basis: `${basis};rule=api_client`,
  };
}

function layerFields(layer: KeyPolicyLayer): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of KEY_POLICY_FIELDS) if (layer[k] !== undefined) out[k] = layer[k];
  return out;
}

export function layersEqual(a: KeyPolicyLayer, b: KeyPolicyLayer): boolean {
  return JSON.stringify(layerFields(a), Object.keys(layerFields(a)).sort()) === JSON.stringify(layerFields(b), Object.keys(layerFields(b)).sort());
}

export interface KeyPolicyChange { field: string; old: unknown; new: unknown }

/**
 * Apply a proposal to the stored auto layer with hysteresis. Returns the new auto layer and the per-field changes
 * (empty when nothing was adopted). Pure; the caller persists and records events.
 */
export function reconcileAuto(prev: KeyPolicyAutoLayer, proposal: KeyPolicyProposal, now = Date.now()): { auto: KeyPolicyAutoLayer; changes: KeyPolicyChange[] } {
  const current = layerFields(prev);
  const at = new Date(now).toISOString();
  const adopt = (): { auto: KeyPolicyAutoLayer; changes: KeyPolicyChange[] } => {
    const changes: KeyPolicyChange[] = [];
    const next = layerFields(proposal.layer);
    for (const k of new Set([...Object.keys(current), ...Object.keys(next)])) {
      if (JSON.stringify(current[k]) !== JSON.stringify(next[k])) changes.push({ field: k, old: current[k] ?? null, new: next[k] ?? null });
    }
    return { auto: { ...(next as KeyPolicyLayer), decidedAt: at, basis: proposal.basis }, changes };
  };
  if (!prev.decidedAt) return adopt(); // first judgement after JUDGE_MIN_REQUESTS: adopted at once
  if (layersEqual(prev, proposal.layer)) {
    const { pending: _drop, ...rest } = prev;
    return { auto: { ...rest, basis: proposal.basis }, changes: [] }; // same opinion: refresh basis, forget any pending flip
  }
  if (prev.pending && layersEqual(prev.pending.layer, proposal.layer)) {
    if (now - Date.parse(prev.pending.since) >= JUDGE_STABLE_MS) return adopt();
    return { auto: { ...prev, pending: { ...prev.pending, basis: proposal.basis } }, changes: [] };
  }
  return { auto: { ...prev, pending: { layer: layerFields(proposal.layer) as KeyPolicyLayer, basis: proposal.basis, since: at } }, changes: [] };
}

/** Pure: next policy_json for a key given its stored document and observation; null = no judgement (too few requests). */
export function nextKeyPolicyJson(existingJson: string | null, obs: KeyObservation, now = Date.now()): { json: string; auto: KeyPolicyAutoLayer; changes: KeyPolicyChange[]; basis: string } | null {
  const proposal = proposeKeyPolicy(obs);
  if (!proposal) return null;
  const doc = parseKeyPolicyDoc(existingJson);
  const { auto, changes } = reconcileAuto(doc.auto, proposal, now);
  return { json: serializeKeyPolicyDoc({ auto, override: doc.override }), auto, changes, basis: proposal.basis };
}

export interface KeyPolicyEventRow { id: string; api_key_id: string; field: string; old: string | null; new: string | null; basis: string | null; created_at: string }

export function recordKeyPolicyEvents(apiKeyId: string, changes: KeyPolicyChange[], basis: string, at = nowIso()): void {
  for (const c of changes) {
    run(
      "INSERT INTO key_policy_events (id, api_key_id, field, old, new, basis, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      crypto.randomUUID(), apiKeyId, c.field, c.old === null || c.old === undefined ? null : JSON.stringify(c.old), c.new === null || c.new === undefined ? null : JSON.stringify(c.new), basis, at,
    );
  }
}

export function listKeyPolicyEvents(apiKeyId: string, limit = 100): KeyPolicyEventRow[] {
  return all<KeyPolicyEventRow>("SELECT id, api_key_id, field, old, new, basis, created_at FROM key_policy_events WHERE api_key_id = ? ORDER BY created_at DESC LIMIT ?", apiKeyId, limit);
}

export interface JudgeResult { apiKeyId: string; requests: number; changes: KeyPolicyChange[]; pending: boolean; basis: string | null }

/** Judge one key: observe → propose → reconcile → persist auto layer (override untouched) → events. */
export function judgeKey(apiKeyId: string, now = Date.now()): JudgeResult {
  const obs = observeKey(apiKeyId, JUDGE_WINDOW_DAYS, now);
  const row = one<{ policy_json: string | null }>("SELECT policy_json FROM api_keys WHERE id = ?", apiKeyId);
  if (!row) return { apiKeyId, requests: obs.requests, changes: [], pending: false, basis: null };
  const next = nextKeyPolicyJson(row.policy_json, obs, now);
  if (!next) return { apiKeyId, requests: obs.requests, changes: [], pending: false, basis: null };
  if (next.json !== (row.policy_json ?? "")) run("UPDATE api_keys SET policy_json = ? WHERE id = ?", next.json, apiKeyId);
  if (next.changes.length) recordKeyPolicyEvents(apiKeyId, next.changes, next.basis, new Date(now).toISOString());
  return { apiKeyId, requests: obs.requests, changes: next.changes, pending: !!next.auto.pending, basis: next.basis };
}

export interface JudgeSummary { judged: number; flipped: number; pending: number; events: number; results: JudgeResult[] }

export function judgeAllKeys(now = Date.now()): JudgeSummary {
  const results = keysToJudge(JUDGE_WINDOW_DAYS, now).map((id) => judgeKey(id, now));
  return {
    judged: results.length,
    flipped: results.filter((r) => r.changes.length > 0).length,
    pending: results.filter((r) => r.pending).length,
    events: results.reduce((n, r) => n + r.changes.length, 0),
    results,
  };
}

const LAST_RUN_KEY = "key_policy_judge_last_run_at";
export function lastKeyPolicyJudgeRunAt(): string | null {
  return one<{ value: string }>("SELECT value FROM settings WHERE key = ?", LAST_RUN_KEY)?.value ?? null;
}
export function markKeyPolicyJudgeRun(at = nowIso()): void {
  run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", LAST_RUN_KEY, at);
}
