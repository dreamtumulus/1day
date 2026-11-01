/**
 * Claude Code request-shape verdict — the gate in front of the subscription
 * direct path (docs/gateway.md §2a, docs/claude-code-compat.md §3–§5).
 *
 * A UA prefix is trivially forged, and a forged "Claude Code" request that is
 * not shaped like one is answered 429 by Anthropic (measured 2026-10-16) while
 * being an anomalous sample on the subscription account. So the direct path is
 * granted only when the structural invariants below hold.
 *
 * Hard checks are things every real Claude Code build sends and that do not
 * change between versions in their *structure*; failing any → "suspect".
 * Soft checks describe the current canonical build more closely; they are
 * only reported (logging / drift detection), never enforced.
 */

import { ccBuildSuffix } from "./fingerprint.js";
import { CC_KNOWN_VERSIONS, CC_MIN_VERSION_BY_MODEL, ccProfileFor } from "./cc-profile.js";

type Headers = Record<string, string | string[] | undefined>;
type Json = Record<string, any>;

export type CcShapeVerdict = "genuine" | "suspect" | "not_cc";

export interface CcShape {
  verdict: CcShapeVerdict;
  /** Version from the UA, e.g. "2.1.300"; null when the UA is not Claude Code. */
  version: string | null;
  /** Hard checks that failed (empty for genuine / not_cc). */
  missing: string[];
  /** Soft checks that failed (informational). */
  soft: string[];
  /** UA entrypoint ("cli", "sdk-cli", "mirasim"…); null when the UA is not Claude Code. */
  entrypoint: string | null;
  /** The entrypoint is not one a real Claude Code build sends (customer-made embedding). */
  customEntrypoint: boolean;
  /** A custom entrypoint was refused because neither the global switch nor the key's allowlist admits it. */
  customEntrypointDenied: boolean;
  /** Known profile this request belongs to (spec §6.1, cc-profile.ts), null = no sampled profile for version × entrypoint. */
  profileId: string | null;
}

export const CC_SHAPE_POLICIES = ["observe", "downgrade", "reject"] as const;
export type CcShapePolicy = (typeof CC_SHAPE_POLICIES)[number];

const UA_RE = /^(?:claude-cli|claude-code)\/(\d+\.\d+\.\d+)/;
const UA_ENTRYPOINT_RE = /\(external,\s*([^,)]+)(?:,|\))/;
const BILLING_RE = /^x-anthropic-billing-header:\s*cc_version=(\d+\.\d+\.\d+)(?:\.([0-9a-z]+))?[^;]*;/;
const BILLING_ENTRYPOINT_RE = /(?:^|;\s*)cc_entrypoint=([a-z][a-z0-9_-]{0,39})(?=;|$)/;
const KNOWN_ENTRYPOINTS = /^(cli|sdk-cli|sdk-ts|sdk-py|claude-vscode|claude-jetbrains|claude-desktop|claude-desktop-3p|local-agent)$/;
const CLI_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const SDK_IDENTITY = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const SDK_APPEND_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.";
const CC_VERSION_DETAILS: Record<string, { runtime: string; packageVersion: string }> = {
  "2.1.300": { runtime: "v26.3.0", packageVersion: "0.128.0" },
  "2.1.312": { runtime: "v26.12.1", packageVersion: "0.128.0" },
};
const HEX64 = /^[0-9a-f]{64}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function h(headers: Headers, name: string): string {
  const v = headers[name];
  return typeof v === "string" ? v : Array.isArray(v) ? (v[0] ?? "") : "";
}

function textOf(block: unknown): string {
  if (typeof block === "string") return block;
  if (block && typeof block === "object" && (block as Json).type === "text") return String((block as Json).text ?? "");
  return "";
}

export interface CcShapeOptions {
  /**
   * settings `direct_cc_entrypoint_normalize=1` (docs/gateway.md §3, operator decision 2026-10-20): a UA whose
   * entrypoint is not a real Claude Code one — e.g. `(external, mirasim)` — is still admitted when everything else
   * is shaped like Claude Code, and `normalizeCcSoftware` rewrites it to `(external, cli)` before the upstream
   * request. Without it the gate hard-fails `ua_entrypoint` (2026-11-01: the check and the normalizer contradicted
   * each other — the gate downgraded 8.4k requests/day that the normalizer was written for). Default false.
   */
  allowCustomEntrypoint?: boolean;
  /**
   * Per-key allowlist of customer-made entrypoints (spec §6.2 `allowedCustomEntrypoints`, WP1): admits exactly these
   * UA entrypoints for this key even when the global switch is off. Case-sensitive, matched against the UA value.
   */
  allowedCustomEntrypoints?: readonly string[];
  /**
   * spec §6.1 `requireKnownProfile` (settings `direct_profile_strict`): a version × entrypoint without a sampled
   * profile hard-fails `cc_profile_unknown` instead of being forwarded on the client's say-so.
   */
  requireKnownProfile?: boolean;
}

export function classifyCcRequest(headers: Headers, body: Json, opts: CcShapeOptions = {}): CcShape {
  const ua = h(headers, "user-agent");
  const m = UA_RE.exec(ua);
  if (!m) return { verdict: "not_cc", version: null, missing: [], soft: [], entrypoint: null, customEntrypoint: false, customEntrypointDenied: false, profileId: null };
  const version = m[1];
  const missing: string[] = [];
  const soft: string[] = [];
  const uaEntrypoint = UA_ENTRYPOINT_RE.exec(ua)?.[1]?.trim() ?? "";
  const customEntrypoint = uaEntrypoint !== "" && !KNOWN_ENTRYPOINTS.test(uaEntrypoint);
  const customAdmitted = customEntrypoint && (opts.allowCustomEntrypoint === true || (opts.allowedCustomEntrypoints ?? []).includes(uaEntrypoint));
  const customEntrypointDenied = customEntrypoint && !customAdmitted;
  if (!uaEntrypoint || customEntrypointDenied) missing.push("ua_entrypoint");
  else if (customEntrypoint) soft.push("ua_entrypoint_custom");

  // ---- hard: headers every CC build sends (docs/claude-code-compat.md §3) ----
  if (h(headers, "x-app") !== "cli") missing.push("x_app_cli");
  const betas = h(headers, "anthropic-beta").split(",").map((s) => s.trim());
  if (!betas.includes("claude-code-20250219")) missing.push("beta_claude_code");

  // ---- hard: body (docs/claude-code-compat.md §5) ----
  const system = body?.system;
  const sysBlocks: unknown[] = Array.isArray(system) ? system : [];
  const billing = BILLING_RE.exec(textOf(sysBlocks[0]));
  let billingEntrypoint = "";
  if (!Array.isArray(system) || !billing) missing.push("billing_header");
  else {
    billingEntrypoint = BILLING_ENTRYPOINT_RE.exec(textOf(sysBlocks[0]))?.[1] ?? "";
    if (!billingEntrypoint) missing.push("billing_entrypoint");
    if (billing[1] !== version) missing.push("billing_version_mismatch");
    if (version === "2.1.312" && billing[2] !== ccBuildSuffix(body.messages)) missing.push("billing_suffix");
    // Other sampled builds share the algorithm (2.1.300's captured .f23 reproduces); reported only until ≥12 samples confirm it.
    else if (version !== "2.1.312" && CC_KNOWN_VERSIONS.includes(version) && billing[2] !== ccBuildSuffix(body.messages, version)) soft.push("billing_suffix");
  }
  if (uaEntrypoint && billingEntrypoint && uaEntrypoint !== billingEntrypoint) missing.push("entrypoint_mismatch");

  const uid = body?.metadata?.user_id;
  let uidOk = false;
  let uidSession = "";
  if (typeof uid === "string") {
    try {
      const j = JSON.parse(uid) as Json;
      uidOk = !!j && typeof j === "object" && HEX64.test(String(j.device_id ?? "")) && UUID.test(String(j.session_id ?? ""));
      if (uidOk) uidSession = String(j.session_id);
    } catch {
      uidOk = false;
    }
  }
  if (!uidOk) missing.push("metadata_user_id");

  // ---- hard: transport fingerprint every CC build sends (verified against a live 2.1.303 capture, 2026-10-19;
  // promoted from soft after forged-shape requests with a foreign runtime reached the direct path) ----
  if (h(headers, "x-stainless-lang") !== "js" || h(headers, "x-stainless-runtime") !== "node") missing.push("stainless_js_node");
  const runtimeVersion = h(headers, "x-stainless-runtime-version");
  const packageVersion = h(headers, "x-stainless-package-version");
  if (!runtimeVersion) missing.push("stainless_runtime_version");
  if (!packageVersion) missing.push("stainless_package_version");
  const details = CC_VERSION_DETAILS[version];
  if (details) {
    if (runtimeVersion && runtimeVersion !== details.runtime) missing.push("stainless_runtime_version");
    if (packageVersion && packageVersion !== details.packageVersion) missing.push("stainless_package_version");
  }
  const sessionHeader = h(headers, "x-claude-code-session-id");
  if (!UUID.test(sessionHeader)) missing.push("session_id_header");
  else if (uidSession && sessionHeader.toLowerCase() !== uidSession.toLowerCase()) missing.push("session_id_mismatch");
  if (!h(headers, "accept").includes("application/json")) missing.push("accept_json");
  if (h(headers, "anthropic-version") !== "2023-06-01") missing.push("anthropic_version");
  // Anthropic gates models by Claude Code version ("Claude Code 2.1.266 does not support this model; version
  // 2.1.280 or newer is required", error_code claude_code_version_too_old). A request below the gate is either an
  // outdated client or a forged UA; either way the subscription direct path would only collect a 400.
  const minVersion = ccMinVersionForModel(typeof body?.model === "string" ? body.model : "");
  if (minVersion && compareVersions(version, minVersion) < 0) missing.push("version_below_model_minimum");
  if (version === "2.1.312" && body?.stream !== true) missing.push("stream_true");
  else if (body?.stream !== true) soft.push("stream_true");

  const identity = textOf(sysBlocks[1]);
  if (billing) {
    if (uaEntrypoint === "cli") {
      if (identity !== CLI_IDENTITY) missing.push("identity_block");
    } else if (uaEntrypoint === "sdk-cli") {
      if (identity !== SDK_IDENTITY && identity !== SDK_APPEND_IDENTITY) missing.push("identity_block");
    } else if (!/^You are (Claude Code|a Claude agent)/.test(identity)) soft.push("identity_block");
  }

  // ---- soft: canonical-build details, reported only ----
  const mainPrompt = sysBlocks.find((b) => textOf(b).length > 4000 && (b as Json)?.cache_control);
  if (!mainPrompt) soft.push("main_prompt_cached");
  if (Array.isArray(body?.tools) && body.tools.length > 0) {
    const names = body.tools.map((t: Json) => String(t?.name ?? ""));
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    if (names.some((n: string, i: number) => n !== sorted[i])) soft.push("tools_sorted");
    if (body.tools.some((t: Json) => t && "strict" in t)) soft.push("tools_no_strict");
  }
  if (!body?.thinking || typeof body.thinking !== "object") soft.push("thinking");
  if (!body?.context_management) soft.push("context_management");

  // ---- profile (spec §6.1): which sampled build × entrypoint this request belongs to ----
  const prof = ccProfileFor(version, uaEntrypoint, identity);
  if (!prof) {
    if (opts.requireKnownProfile) missing.push("cc_profile_unknown");
    else soft.push("cc_profile_unknown");
  }

  return { verdict: missing.length === 0 ? "genuine" : "suspect", version, missing, soft, entrypoint: uaEntrypoint || null, customEntrypoint, customEntrypointDenied, profileId: prof?.profileId ?? null };
}

/**
 * Minimum Claude Code version Anthropic accepts per model (from its own 400s, `claude_code_version_too_old`):
 * opus-5-5 → 2.1.280 (2026-10-19), fable-5-1 → 2.1.251 (2026-10-19). Prefix match covers dated snapshots.
 */
export { CC_MIN_VERSION_BY_MODEL } from "./cc-profile.js";

export function ccMinVersionForModel(model: string): string | null {
  for (const [prefix, v] of Object.entries(CC_MIN_VERSION_BY_MODEL)) {
    if (model === prefix || model.startsWith(prefix + "-")) return v;
  }
  return null;
}

/** Numeric dotted-version compare (a < b → negative). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number(n) || 0);
  const pb = b.split(".").map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function parseCcShapePolicy(v: string | null | undefined): CcShapePolicy {
  return (CC_SHAPE_POLICIES as readonly string[]).includes(v ?? "") ? (v as CcShapePolicy) : "observe";
}
