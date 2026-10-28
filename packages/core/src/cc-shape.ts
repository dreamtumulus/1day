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
}

export const CC_SHAPE_POLICIES = ["observe", "downgrade", "reject"] as const;
export type CcShapePolicy = (typeof CC_SHAPE_POLICIES)[number];

const UA_RE = /^(?:claude-cli|claude-code)\/(\d+\.\d+\.\d+)/;
const BILLING_RE = /^x-anthropic-billing-header:\s*cc_version=(\d+\.\d+\.\d+)[^;]*;/;
const HEX64 = /^[0-9a-f]{64}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function h(headers: Headers, name: string): string {
  const v = headers[name];
  return typeof v === "string" ? v : Array.isArray(v) ? (v[0] ?? "") : "";
}

function textOf(block: unknown): string {
  if (typeof block === "string") return block;
  if (block && typeof block === "object" && (block as Json).type === "text") return String((block as Json).text ?? "");
  return "";
}

export function classifyCcRequest(headers: Headers, body: Json): CcShape {
  const ua = h(headers, "user-agent");
  const m = UA_RE.exec(ua);
  if (!m) return { verdict: "not_cc", version: null, missing: [], soft: [] };
  const version = m[1];
  const missing: string[] = [];
  const soft: string[] = [];

  // ---- hard: headers every CC build sends (docs/claude-code-compat.md §3) ----
  if (h(headers, "x-app") !== "cli") missing.push("x_app_cli");
  const betas = h(headers, "anthropic-beta").split(",").map((s) => s.trim());
  if (!betas.includes("claude-code-20250219")) missing.push("beta_claude_code");

  // ---- hard: body (docs/claude-code-compat.md §5) ----
  const system = body?.system;
  const sysBlocks: unknown[] = Array.isArray(system) ? system : [];
  const billing = BILLING_RE.exec(textOf(sysBlocks[0]));
  if (!Array.isArray(system) || !billing) missing.push("billing_header");
  else if (billing[1] !== version) missing.push("billing_version_mismatch");

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

  // ---- soft: canonical-build details, reported only ----
  if (body?.stream !== true) soft.push("stream_true");
  const identity = textOf(sysBlocks[1]);
  if (!/^You are (Claude Code|a Claude agent)/.test(identity)) soft.push("identity_block");
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

  return { verdict: missing.length === 0 ? "genuine" : "suspect", version, missing, soft };
}

/**
 * Minimum Claude Code version Anthropic accepts per model (from its own 400s, `claude_code_version_too_old`):
 * opus-5-5 → 2.1.280 (2026-10-19), fable-5-1 → 2.1.251 (2026-10-19). Prefix match covers dated snapshots.
 */
export const CC_MIN_VERSION_BY_MODEL: Record<string, string> = {
  "claude-opus-5-5": "2.1.280",
  "claude-fable-5-1": "2.1.251",
};

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
