import { isCanaryGroup, parseFeatureValue } from "./canary.js";
import { getSetting } from "./settings.js";
// Per-API-key routing policy (docs/gateway.md §2b, 2026-10-29, migration 29: api_keys.policy_json).
//
// Two layers since 2026-11-01 (docs/canonical-implementation-spec-2026-11-01.md §6.2): `auto` is written by the
// judge (key-policy-auto.ts) from the key's observed traffic, `override` by an administrator. Effective value per
// field = override[k] ?? auto[k] ?? system default. The pre-2026-11-01 flat document ({historyPolicy, directOnly, …})
// is read as an override layer, so nothing a key had configured changes meaning.
//
//   { "auto": { "workerMode": "canonical", "telemetryPolicy": "native-required", "parameterPolicy": "warn",
//               "responseMode": "keepalive", "historyPolicy": "passthrough", "probeIntercept": false,
//               "decidedAt": "…", "basis": "cc_genuine_ratio=0.98;protocol=messages;foreign_history=0.6" },
//     "override": { "telemetryPolicy": "passthrough-isolated", "allowedCustomEntrypoints": ["mirasim"],
//                   "by": "<admin id>", "reason": "低延迟需求", "at": "…" } }
//
// Fields:
// historyPolicy — what the gateway does with a request that carries prior turns this platform never served:
//   reset (default via settings history_policy_default) / passthrough / reject (409 history_unknown).
// directOnly — the key never falls back to the worker path (400 direct_only instead).
// probeIntercept — liveness probes are answered from pool state (docs/gateway.md §2c). Default on.
// teamAffinity — which organization a NEW conversation joins when several have capacity: null = capacity,
//   "spread" = larger organizations first, "pack" = smaller first.
// workerMode — legacy (today's worker: folded history, replaced system prompt) | canonical (lane B, WP2).
// telemetryPolicy — native-required (lane B carries Messages + native telemetry) | passthrough-isolated (lane A,
//   genuine Claude Code requests go direct, no account-side telemetry). System default stays passthrough-isolated
//   until lane B exists; the judge / an override flips it.
// parameterPolicy — warn (unsupported fields named in x-1day-ignored-params) | strict (400 unsupported_parameter).
// responseMode — keepalive (early 200 + heartbeat; errors after 200 only in-stream) | strict (no early 200).
// allowedCustomEntrypoints — customer-made Claude Code UA entrypoints admitted to the direct path for this key.

export const HISTORY_POLICIES = ["reset", "reject", "passthrough"] as const;
export type HistoryPolicy = (typeof HISTORY_POLICIES)[number];
export const TEAM_AFFINITIES = ["spread", "pack"] as const;
export type TeamAffinity = (typeof TEAM_AFFINITIES)[number];
export const WORKER_MODES = ["legacy", "canonical"] as const;
export type WorkerMode = (typeof WORKER_MODES)[number];
export const TELEMETRY_POLICIES = ["native-required", "passthrough-isolated"] as const;
export type TelemetryPolicy = (typeof TELEMETRY_POLICIES)[number];
export const PARAMETER_POLICIES = ["warn", "strict"] as const;
export type ParameterPolicy = (typeof PARAMETER_POLICIES)[number];
export const RESPONSE_MODES = ["keepalive", "strict"] as const;
export type ResponseMode = (typeof RESPONSE_MODES)[number];

export interface KeyPolicy {
  historyPolicy: HistoryPolicy;
  directOnly: boolean;
  probeIntercept: boolean;
  teamAffinity: TeamAffinity | null;
  workerMode: WorkerMode;
  telemetryPolicy: TelemetryPolicy;
  parameterPolicy: ParameterPolicy;
  responseMode: ResponseMode;
  allowedCustomEntrypoints: string[];
}

/** One layer: every field optional; absent = "no opinion" (falls through to the next layer). */
export type KeyPolicyLayer = Partial<KeyPolicy>;
export interface KeyPolicyAutoLayer extends KeyPolicyLayer {
  decidedAt?: string;
  basis?: string;
  /** Judge hysteresis (key-policy-auto.ts): a differing proposal waits here until it has been stable for 3 days. */
  pending?: { layer: KeyPolicyLayer; basis: string; since: string };
}
export interface KeyPolicyOverrideLayer extends KeyPolicyLayer { by?: string; reason?: string; at?: string }
export interface KeyPolicyDoc { auto: KeyPolicyAutoLayer; override: KeyPolicyOverrideLayer }

export const KEY_POLICY_FIELDS = ["historyPolicy", "directOnly", "probeIntercept", "teamAffinity", "workerMode", "telemetryPolicy", "parameterPolicy", "responseMode", "allowedCustomEntrypoints"] as const satisfies readonly (keyof KeyPolicy)[];

export const DEFAULT_KEY_POLICY: KeyPolicy = Object.freeze({
  historyPolicy: "reset",
  directOnly: false,
  probeIntercept: true,
  teamAffinity: null,
  workerMode: "legacy",
  telemetryPolicy: "passthrough-isolated",
  parameterPolicy: "warn",
  responseMode: "keepalive",
  allowedCustomEntrypoints: [],
}) as KeyPolicy;

/**
 * The historyPolicy a key gets when neither layer names one: settings `history_policy_default` (reset), or
 * `history_policy_canary` for keys in the 灰度 group (铁律 2: the passthrough default of 2026-11-01 11:00 is
 * upstream-visible — foreign history travels to the organization's accounts — so it rolls out through canary).
 */
export function defaultHistoryPolicy(groupId?: string | null): HistoryPolicy {
  const valid = (v: string): v is HistoryPolicy => (HISTORY_POLICIES as readonly string[]).includes(v);
  const canary = getSetting("history_policy_canary").trim();
  if (canary && valid(canary) && isCanaryGroup(groupId)) return canary;
  const d = getSetting("history_policy_default").trim();
  return valid(d) ? d : "reset";
}

const ENTRYPOINT_RE = /^[a-z][a-z0-9_-]{0,39}$/;

function oneOf<T extends string>(list: readonly T[], v: unknown): T | undefined {
  return typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : undefined;
}

/** Tolerant field-by-field validation of one layer; unknown / malformed values are dropped (never throw on stored data). */
export function sanitizeKeyPolicyLayer(v: unknown): KeyPolicyLayer {
  if (!v || typeof v !== "object") return {};
  const r = v as Record<string, unknown>;
  const out: KeyPolicyLayer = {};
  const hp = oneOf(HISTORY_POLICIES, r.historyPolicy); if (hp) out.historyPolicy = hp;
  if (typeof r.directOnly === "boolean") out.directOnly = r.directOnly;
  if (typeof r.probeIntercept === "boolean") out.probeIntercept = r.probeIntercept;
  if (r.teamAffinity === null) out.teamAffinity = null;
  else { const ta = oneOf(TEAM_AFFINITIES, r.teamAffinity); if (ta) out.teamAffinity = ta; }
  const wm = oneOf(WORKER_MODES, r.workerMode); if (wm) out.workerMode = wm;
  const tp = oneOf(TELEMETRY_POLICIES, r.telemetryPolicy); if (tp) out.telemetryPolicy = tp;
  const pp = oneOf(PARAMETER_POLICIES, r.parameterPolicy); if (pp) out.parameterPolicy = pp;
  const rm = oneOf(RESPONSE_MODES, r.responseMode); if (rm) out.responseMode = rm;
  if (Array.isArray(r.allowedCustomEntrypoints)) out.allowedCustomEntrypoints = [...new Set(r.allowedCustomEntrypoints.filter((e): e is string => typeof e === "string" && ENTRYPOINT_RE.test(e)))];
  return out;
}

/**
 * Validation for administrator input (console): returns the field name of the first invalid value, or null.
 * Stricter than `sanitizeKeyPolicyLayer`: a present-but-invalid value is an error, not something to drop.
 */
export function invalidKeyPolicyField(v: unknown): string | null {
  if (!v || typeof v !== "object") return "policy";
  const r = v as Record<string, unknown>;
  const check = (name: string, ok: boolean) => (ok ? null : name);
  return (
    (r.historyPolicy !== undefined && check("historyPolicy", !!oneOf(HISTORY_POLICIES, r.historyPolicy))) ||
    (r.directOnly !== undefined && check("directOnly", typeof r.directOnly === "boolean")) ||
    (r.probeIntercept !== undefined && check("probeIntercept", typeof r.probeIntercept === "boolean")) ||
    (r.teamAffinity !== undefined && r.teamAffinity !== null && check("teamAffinity", !!oneOf(TEAM_AFFINITIES, r.teamAffinity))) ||
    (r.workerMode !== undefined && check("workerMode", !!oneOf(WORKER_MODES, r.workerMode))) ||
    (r.telemetryPolicy !== undefined && check("telemetryPolicy", !!oneOf(TELEMETRY_POLICIES, r.telemetryPolicy))) ||
    (r.parameterPolicy !== undefined && check("parameterPolicy", !!oneOf(PARAMETER_POLICIES, r.parameterPolicy))) ||
    (r.responseMode !== undefined && check("responseMode", !!oneOf(RESPONSE_MODES, r.responseMode))) ||
    (r.allowedCustomEntrypoints !== undefined && check("allowedCustomEntrypoints", Array.isArray(r.allowedCustomEntrypoints) && r.allowedCustomEntrypoints.length <= 20 && r.allowedCustomEntrypoints.every((e) => typeof e === "string" && ENTRYPOINT_RE.test(e)))) ||
    null
  );
}

/** Parse `api_keys.policy_json` into its two layers. A flat (pre-2026-11-01) document is an override layer. */
export function parseKeyPolicyDoc(json: string | null | undefined): KeyPolicyDoc {
  if (!json) return { auto: {}, override: {} };
  let v: unknown;
  try { v = JSON.parse(json); } catch { return { auto: {}, override: {} }; }
  if (!v || typeof v !== "object") return { auto: {}, override: {} };
  const r = v as Record<string, unknown>;
  const layered = "auto" in r || "override" in r;
  const autoRaw = (r.auto && typeof r.auto === "object" ? r.auto : {}) as Record<string, unknown>;
  const overrideRaw = (layered ? (r.override && typeof r.override === "object" ? r.override : {}) : r) as Record<string, unknown>;
  const auto: KeyPolicyAutoLayer = { ...sanitizeKeyPolicyLayer(autoRaw) };
  if (typeof autoRaw.decidedAt === "string") auto.decidedAt = autoRaw.decidedAt;
  if (typeof autoRaw.basis === "string") auto.basis = autoRaw.basis.slice(0, 500);
  const pend = autoRaw.pending as Record<string, unknown> | undefined;
  if (pend && typeof pend === "object" && typeof pend.since === "string") auto.pending = { layer: sanitizeKeyPolicyLayer(pend.layer), basis: typeof pend.basis === "string" ? pend.basis.slice(0, 500) : "", since: pend.since };
  const override: KeyPolicyOverrideLayer = { ...sanitizeKeyPolicyLayer(overrideRaw) };
  // spec §6.2 example keeps teamAffinity beside the layers; read it as an override when the layers do not name one.
  if (layered && override.teamAffinity === undefined && "teamAffinity" in r) {
    const ta = r.teamAffinity === null ? null : oneOf(TEAM_AFFINITIES, r.teamAffinity);
    if (ta !== undefined) override.teamAffinity = ta;
  }
  for (const k of ["by", "reason", "at"] as const) if (typeof overrideRaw[k] === "string") override[k] = String(overrideRaw[k]).slice(0, 500);
  return { auto, override };
}

export function serializeKeyPolicyDoc(doc: KeyPolicyDoc): string {
  return JSON.stringify({ auto: doc.auto, override: doc.override });
}

/** Is the judge's `auto` layer in force for this key (settings `key_policy_auto`: 0 = recorded only / canary / 1)? */
export function keyPolicyAutoActive(groupId?: string | null): boolean {
  const v = parseFeatureValue(getSetting("key_policy_auto"));
  return v === "1" || (v === "canary" && isCanaryGroup(groupId));
}

/** Effective policy: override ?? (auto when in force) ?? system default (historyPolicy default per group). */
export function effectiveKeyPolicy(doc: KeyPolicyDoc, groupId?: string | null, autoActive = keyPolicyAutoActive(groupId)): KeyPolicy {
  const base: KeyPolicy = { ...DEFAULT_KEY_POLICY, allowedCustomEntrypoints: [], historyPolicy: defaultHistoryPolicy(groupId) };
  const layers: KeyPolicyLayer[] = autoActive ? [doc.auto, doc.override] : [doc.override];
  const out: KeyPolicy = { ...base };
  for (const layer of layers) {
    for (const k of KEY_POLICY_FIELDS) {
      const v = layer[k];
      if (v !== undefined) (out as unknown as Record<string, unknown>)[k] = Array.isArray(v) ? [...v] : v;
    }
  }
  return out;
}

/** Tolerant parse of `api_keys.policy_json` to the effective policy; unknown or malformed input yields the defaults (for the key's group). */
export function parseKeyPolicy(json: string | null | undefined, groupId?: string | null): KeyPolicy {
  return effectiveKeyPolicy(parseKeyPolicyDoc(json), groupId);
}

/** Replace the override layer of a stored document, keeping the judge's auto layer (console PATCH). */
export function withKeyPolicyOverride(json: string | null | undefined, override: KeyPolicyOverrideLayer | null): string | null {
  const doc = parseKeyPolicyDoc(json);
  if (override === null) {
    if (Object.keys(doc.auto).length === 0) return null;
    return serializeKeyPolicyDoc({ auto: doc.auto, override: {} });
  }
  return serializeKeyPolicyDoc({ auto: doc.auto, override });
}
