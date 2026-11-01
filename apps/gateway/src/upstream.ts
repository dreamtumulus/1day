import {
  CC_ANTHROPIC_VERSION,
  ccCanonicalBetas,
  accountBaseUrl,
  anthropicFingerprintHeaders,
  ensureDeviceId,
  getSetting,
  isCcrExecutor,
  normalizeCcSoftware,
  sessionMetadataUserId,
  sessionUuidFromHash,
  sha256Hex,
  accountMachine,
  machineStainlessHeaders,
  rewriteEnvironmentBlock,
  isMachineEnvironmentBlock,
  type AccountMachine,
  type AccountRow,
  type Credential,
  featureFor,
} from "@1dayapi/core";
import { anthropicToOpenaiChat, openaiChatToAnthropic } from "./convert.js";

type Json = Record<string, any>;

/** What the client spoke. */
export type ClientFormat = "openai-chat" | "anthropic" | "responses";

/** How a request is carried to one account (docs/v3-design.md §7.1). */
export type Mode =
  | "passthrough-anthropic" // anthropic -> anthropic
  | "passthrough-openai" // chat -> chat
  | "passthrough-responses" // responses -> responses
  | "chat-via-anthropic" // client chat, upstream anthropic
  | "anthropic-via-chat" // client anthropic, upstream chat
  | "ccr-anthropic" // client anthropic, cloud session (docs/ccr-supply.md)
  | "ccr-chat"; // client chat, cloud session

export function isCcrMode(mode: Mode): boolean {
  return mode === "ccr-anthropic" || mode === "ccr-chat";
}

/** The Anthropic-wire mode a CCR response is delivered as (the executor synthesizes Anthropic wire). */
export function wireModeFor(mode: Mode): Mode {
  if (mode === "ccr-anthropic") return "passthrough-anthropic";
  if (mode === "ccr-chat") return "chat-via-anthropic";
  return mode;
}

/**
 * How a request is carried to one account (docs/v3-design.md §7.1).
 * `ccClient` (Claude Code 系 UA) enables dual-mode routing (docs/ccr-supply.md
 * §5.2 R1): executor=ccr/ccr_worker subscription accounts then serve in DIRECT
 * mode (passthrough-anthropic wire) instead of a cloud session / on-node
 * worker — CC clients never land on either CCR path.
 */
export function modeFor(
  format: ClientFormat,
  a: Pick<AccountRow, "protocol" | "type" | "platform" | "executor">,
  ccClient = false,
): Mode | null {
  if (isCcrExecutor(a.executor) && !ccClient) {
    if (format === "anthropic") return "ccr-anthropic";
    if (format === "openai-chat") return "ccr-chat";
    return null; // Responses API has no cloud-session/worker translation
  }
  const openaiOauth = a.type === "oauth" && a.platform === "openai";
  if (openaiOauth) return format === "responses" ? "passthrough-responses" : null;
  if (format === "responses") return a.protocol === "openai" ? "passthrough-responses" : null;
  if (format === "anthropic") return a.protocol === "anthropic" ? "passthrough-anthropic" : "anthropic-via-chat";
  return a.protocol === "openai" ? "passthrough-openai" : "chat-via-anthropic";
}

export interface UpstreamRequest {
  url: URL;
  headers: Record<string, string>;
  body: string;
}

/**
 * Headers the gateway never forwards verbatim: hop-by-hop, transport, the
 * client's own credential (replaced by the account's), and whatever the edge
 * (Cloudflare / nginx) or the platform added on the way in.
 */
const RAW_DROP_HEADERS = new Set([
  "host", "connection", "content-length", "transfer-encoding", "accept-encoding", "te", "upgrade", "keep-alive", "expect",
  "authorization", "x-api-key", "proxy-authorization", "proxy-connection", "via", "forwarded", "x-real-ip", "true-client-ip", "cdn-loop",
]);
const RAW_DROP_PREFIXES = ["cf-", "x-forwarded-", "x-1dayapi-"];

/** The client's headers as they should reach a raw-passthrough relay (lower-cased names, multi-values joined). */
export function rawClientHeaders(clientHeaders: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(clientHeaders)) {
    const name = k.toLowerCase();
    if (v === undefined || RAW_DROP_HEADERS.has(name) || RAW_DROP_PREFIXES.some((p) => name.startsWith(p))) continue;
    out[name] = Array.isArray(v) ? v.join(", ") : v;
  }
  return out;
}

/**
 * Upstream-visible shaping decisions for one request (铁律 2 / core canary.ts): each one is a three-state setting
 * ("0" | "canary" | "1") resolved by proxy.ts for the request's key group and the chosen account. The default
 * here (settings without canary context) is what tests and ad-hoc callers get.
 */
export interface UpstreamShaping {
  /** direct_cc_entrypoint_normalize: rewrite a customer-made UA entrypoint to (external, cli). */
  normalizeEntrypoint: boolean;
  /** direct_strip_user_email: drop the customer's `# userEmail` reminder. */
  stripUserEmail: boolean;
  /** direct_cc_canonical_fields: oauth beta after claude-code, metadata.user_id in Claude Code key order. */
  canonicalFields: boolean;
}

export function shapingFor(ctx: { groupId?: string | null; accountId?: string | null } = {}): UpstreamShaping {
  return {
    normalizeEntrypoint: featureFor("direct_cc_entrypoint_normalize", { groupId: ctx.groupId }),
    stripUserEmail: featureFor("direct_strip_user_email", ctx),
    canonicalFields: featureFor("direct_cc_canonical_fields", ctx),
  };
}

export function buildUpstreamRequest(
  account: AccountRow,
  cred: Credential,
  mode: Mode,
  clientBody: Json,
  upstreamModel: string,
  clientHeaders: Record<string, string | string[] | undefined>,
  clientQuery = "",
  upstreamSession?: string,
  shaping: UpstreamShaping = shapingFor(),
): UpstreamRequest | null {
  if (upstreamSession) clientBody = { ...clientBody, metadata: { user_id: sessionMetadataUserId(upstreamSession) } };
  const base = accountBaseUrl(account);
  if (!base) return null;
  const secret = cred.apiKey ?? cred.accessToken ?? "";
  const anthropicWire = mode === "passthrough-anthropic" || mode === "chat-via-anthropic";
  // Raw passthrough (gateway.md §4a, 官Key 分组 2026-10-23): a same-protocol request to a relay account
  // goes out as the client sent it — its headers (minus transport / credential), its body byte for
  // byte (since 2026-10-26 not even the model is rewritten: the account's model mapping is ignored),
  // its query string. No Claude Code UA/version normalisation, fingerprint headers, device-identity
  // pinning, thinking normalisation, `?beta=true` or beta injection.
  if (account.raw_passthrough === 1 && mode.startsWith("passthrough-")) {
    const headers = rawClientHeaders(clientHeaders);
    headers["content-type"] = "application/json";
    if (anthropicWire) {
      headers["x-api-key"] = secret;
      headers.authorization = `Bearer ${secret}`;
      if (!headers["anthropic-version"]) headers["anthropic-version"] = CC_ANTHROPIC_VERSION;
    } else {
      headers.authorization = `Bearer ${secret}`;
    }
    const path = mode === "passthrough-anthropic" ? "/v1/messages" : mode === "passthrough-openai" ? "/chat/completions" : "/responses";
    const q = clientQuery ? (clientQuery.startsWith("?") ? clientQuery : `?${clientQuery}`) : "";
    return { url: new URL(base + path + q), headers, body: JSON.stringify(clientBody) };
  }
  // One account = one software (docs/gateway.md §3): a Claude Code client's UA entrypoint
  // and version are aligned with the node's Claude Code before the fingerprint layer.
  if (mode === "passthrough-anthropic") {
    const pin = getSetting("direct_cc_version_pin").trim();
    const n = normalizeCcSoftware(clientHeaders, clientBody, {
      normalizeEntrypoint: shaping.normalizeEntrypoint,
      versionPin: pin || null,
    });
    clientHeaders = n.headers;
    clientBody = n.body;
  }
  const headers: Record<string, string> = anthropicWire
    ? { "content-type": "application/json", ...anthropicFingerprintHeaders(clientHeaders) }
    : { "content-type": "application/json", accept: "*/*" };
  // 每账号一台独立 Linux 机器（docs/claude-code-compat.md §10）：x-stainless-os/arch 与 body 的 # Environment 同源，
  // 同号恒定、号号各异；runtime / runtime-version 由 CC 版本定死（anthropicFingerprintHeaders 已补），不覆盖。
  const machine = anthropicWire ? accountMachine(account.id) : null;
  const envUuid = upstreamSession ?? sessionUuidFromHash(sha256Hex(`env-scratch::${account.id}`));
  if (machine && anthropicWire) {
    const sh = machineStainlessHeaders(machine);
    headers["x-stainless-os"] = sh["x-stainless-os"];
    headers["x-stainless-arch"] = sh["x-stainless-arch"];
  }
  let path: string;
  let body: Json;

  switch (mode) {
    case "passthrough-anthropic":
      // Claude Code 恒定带 ?beta=true（docs/claude-code-compat.md §2）
      path = "/v1/messages?beta=true";
      body = pinDeviceIdentity(normalizeThinking({ ...clientBody, model: upstreamModel }, upstreamModel), account, { canonicalOrder: shaping.canonicalFields });
      if (machine) body = pinMachineEnvironment(body, machine, envUuid);
      if (account.raw_passthrough !== 1 && shaping.stripUserEmail) body = stripUserEmail(body);
      break;
    case "chat-via-anthropic":
      path = "/v1/messages?beta=true";
      body = pinDeviceIdentity(normalizeThinking({ ...openaiChatToAnthropic(clientBody, upstreamModel), ...(upstreamSession ? { metadata: clientBody.metadata } : {}) }, upstreamModel), account, { canonicalOrder: shaping.canonicalFields });
      if (machine) body = pinMachineEnvironment(body, machine, envUuid);
      break;
    case "passthrough-openai":
      path = "/chat/completions";
      body = { ...clientBody, model: upstreamModel };
      if (body.stream === true) {
        body.stream_options = { ...(body.stream_options ?? {}), include_usage: true };
      }
      break;
    case "anthropic-via-chat":
      path = "/chat/completions";
      body = anthropicToOpenaiChat(clientBody, upstreamModel);
      break;
    case "passthrough-responses":
      path = "/responses";
      body = { ...clientBody, model: upstreamModel };
      break;
    default:
      throw new Error(`buildUpstreamRequest: mode ${mode} is not an HTTP upstream mode`);
  }

  if (anthropicWire) {
    const v = clientHeaders["anthropic-version"];
    headers["anthropic-version"] = typeof v === "string" && v ? v : CC_ANTHROPIC_VERSION;
    const betas = new Set<string>();
    const clientBeta = clientHeaders["anthropic-beta"];
    if (mode === "passthrough-anthropic" && typeof clientBeta === "string") {
      for (const b of clientBeta.split(",")) if (b.trim()) betas.add(b.trim());
    }
    // 客户端非 Claude Code 时注入 canonical beta 集（docs/claude-code-compat.md §6）
    if (betas.size === 0) for (const b of ccCanonicalBetas(account.type === "oauth")) betas.add(b);
    let betaList = [...betas];
    if (account.type === "oauth") {
      // A client list missing the OAuth beta gets it where a real OAuth client carries it — right after
      // claude-code-20250219 (audit 2026-11-01 B12) — behind direct_cc_canonical_fields; otherwise appended (old).
      if (!betas.has("oauth-2025-04-20")) {
        const i = shaping.canonicalFields ? betaList.indexOf("claude-code-20250219") : -1;
        betaList = i >= 0 ? [...betaList.slice(0, i + 1), "oauth-2025-04-20", ...betaList.slice(i + 1)] : [...betaList, "oauth-2025-04-20"];
      }
      headers.authorization = `Bearer ${secret}`;
    } else {
      headers["x-api-key"] = secret;
      // Third-party Anthropic-compatible relays often expect Bearer instead.
      if (account.type === "upstream") headers.authorization = `Bearer ${secret}`;
    }
    headers["anthropic-beta"] = betaList.join(",");
  } else {
    headers.authorization = `Bearer ${secret}`;
    if (account.type === "oauth" && account.platform === "openai") {
      if (cred.accountId) headers["chatgpt-account-id"] = cred.accountId;
      headers["openai-beta"] = "responses=experimental";
      headers.originator = "codex_cli_rs";
      body.store = false;
    }
  }
  // anthropic wire 保持 CC 行为：流式也发 accept: application/json
  if (!anthropicWire && body.stream === true) headers.accept = "text/event-stream";

  return { url: new URL(base + path), headers, body: JSON.stringify(body) };
}

// OAuth refresh lives in @1dayapi/core (shared with the console keep-alive
// loop). Every node-routed account (ccr, ccr_worker or direct executor)
// refreshes through the tunnel pinned to its bound proxy (docs/onboarding.md
// §1/§6.2: all platform-side requests of a bound account leave on that proxy);
// a failed/unavailable tunnel keeps the old token (core returns null).
import { abortable } from "./lifecycle.js";
import { freshCredential as coreFreshCredential, readCredential } from "@1dayapi/core";
import { pinnedTunnelTransport, type IsolationContext } from "./tunnel.js";

export function freshCredential(account: AccountRow, force = false, isolation?: IsolationContext, signal?: AbortSignal): Promise<Credential> {
  if (isolation && readCredential(account).orgUuid?.toLowerCase() !== isolation.teamId) return Promise.reject(new Error("account organization does not match conversation"));
  const transport = account.route === "node" ? pinnedTunnelTransport(account.id, account.bound_proxy_id, isolation, signal) : (signal ? (url: string, init: { headers: Record<string, string>; body: string }) => fetch(url, { ...init, method: "POST", signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) }) : undefined);
  return abortable(coreFreshCredential(account, force, transport, signal), signal);
}
export { canRefresh } from "@1dayapi/core";

/**
 * One account = one device (docs/claude-code-compat.md §8): the client's
 * `metadata.user_id` carries *its* device_id / account_uuid, so passing it
 * through made one upstream account appear to log in from every customer's
 * machine. Rewrite device_id (and account_uuid when known) to the account's own
 * pinned identity and keep the client's session_id — upstream still sees one
 * device with many conversations, and the gateway's sticky key (computed from
 * the original body) is untouched. Both Claude Code forms are handled: the JSON
 * string and the legacy `user_<hex>_account_<uuid>_session_<uuid>`.
 */
/** `claude-<family>-<major>[-<minor>][-<yyyymmdd>]` → family + numeric version (4.7, 5, 5.5). */
function claudeLine(model: string): { family: string; version: number } | null {
  const m = /^claude-(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d))?(?:-\d{8})?$/.exec(model);
  if (!m) return null;
  return { family: m[1], version: Number(m[2]) + (m[3] ? Number(m[3]) / 10 : 0) };
}

/**
 * Make the client's `thinking` object acceptable to the upstream model
 * (Anthropic rules as of 2026-10, claude-api skill shared/error-codes.md):
 *   - `enabled`/`budget_tokens` → 400 on every 5.x line and on Opus 4.7/4.8 → `adaptive`
 *   - `disabled` → 400 on Fable/Mythos 5.x and Opus 5.5 (always-on thinking) → omit `thinking`
 *   - `disabled` → 400 on Sonnet 5.5 → `between_tools` (its thinking-off form; omit at effort xhigh/max)
 *   - `disabled` → 400 on Opus 5 / Sonnet 5 / Haiku 5.5 only at effort xhigh/max → omit there
 *   - `between_tools` exists only on Sonnet 5.5 at effort ≤ high → omit elsewhere
 * Older lines (4.6 and before) still take every form; the body is returned as is.
 * The CCR worker path maps the same intent through planThinking; this covers the
 * passthrough wires (10 × 400 from a Claude Code 2.1.220 client on 2026-10-19).
 */
export function normalizeThinking(body: Json, model: string): Json {
  const t = body.thinking;
  if (!t || typeof t !== "object") return body;
  const line = claudeLine(model);
  if (!line) return body;
  const { family, version } = line;
  const type = typeof t.type === "string" ? t.type : "";
  const effort = typeof body.output_config?.effort === "string" ? body.output_config.effort : typeof body.effort === "string" ? body.effort : "";
  const highEffort = effort === "xhigh" || effort === "max";
  const drop = (): Json => {
    const { thinking: _omit, ...rest } = body;
    return rest;
  };
  if (type === "enabled") {
    const rejectsBudget = version >= 5 || (family === "opus" && version >= 4.7);
    if (!rejectsBudget) return body;
    const { budget_tokens: _budget, ...preserved } = t;
    return { ...body, thinking: { ...preserved, type: "adaptive" } };
  }
  if (type === "disabled") {
    const alwaysOn = ((family === "fable" || family === "mythos") && version >= 5) || (family === "opus" && version >= 5.5);
    if (alwaysOn) return drop();
    if (family === "sonnet" && version >= 5.5) return highEffort ? drop() : { ...body, thinking: { ...t, type: "between_tools" } };
    if (version >= 5 && highEffort) return drop();
    return body;
  }
  if (type === "between_tools") {
    return family === "sonnet" && version >= 5.5 && !highEffort ? body : drop();
  }
  return body;
}

export function pinDeviceIdentity(body: Json, account: Pick<AccountRow, "id" | "device_id" | "account_uuid">, opts: { canonicalOrder?: boolean } = {}): Json {
  const meta = body.metadata;
  const raw = meta && typeof meta === "object" ? (meta as Json).user_id : undefined;
  if (typeof raw !== "string" || !raw) return body;
  const deviceId = account.device_id ?? ensureDeviceId(account.id);
  // Always overwrite account_uuid to the account's own (empty string when unknown — real Claude Code
  // sends `account_uuid: ""` too, docs §5). Never let the *client's* account_uuid pass through: the
  // bearer token belongs to this account, so a request declaring another account's uuid is a
  // self-contradiction (14 mustardseed accounts with no stored uuid leaked the caller's, 2026-10-31).
  const acctUuid = account.account_uuid ?? "";
  let next: string | null = null;
  const t = raw.trim();
  if (t.startsWith("{")) {
    try {
      const j = JSON.parse(t) as Json;
      if (opts.canonicalOrder !== false) {
        // Rebuild in Claude Code's own key order (device_id, account_uuid, session_id, then anything else): a
        // client that sent only {session_id} used to come out as {session_id, device_id, account_uuid} (audit A9).
        const { device_id: _d, account_uuid: _a, session_id, ...others } = j;
        next = JSON.stringify({ device_id: deviceId, account_uuid: acctUuid, ...(session_id !== undefined ? { session_id } : {}), ...others });
      } else {
        // old behaviour (pre-2026-11-01): assign in place, keep the client's key order
        j.device_id = deviceId;
        j.account_uuid = acctUuid;
        next = JSON.stringify(j);
      }
    } catch {
      return body;
    }
  } else {
    next = t.replace(/^user_[0-9a-fA-F]+/, `user_${deviceId}`);
    // The account segment runs up to the next `_` (`_session_…`); match every non-`_` char so a
    // client value that is not a clean uuid is still fully replaced, never partly kept.
    next = next.replace(/_account_[^_]*/, `_account_${acctUuid}`);
  }
  if (!next || next === raw) return body;
  return { ...body, metadata: { ...(meta as Json), user_id: next } };
}

/**
 * Rewrite Claude Code's machine-identity `# Environment` block (a role:"system" message in messages[],
 * or a block in system[]) to the account's synthetic Linux machine, so Platform/Shell/OS Version/cwd
 * match the account's x-stainless-* headers and stay consistent across the account's requests. No-op
 * when the body carries no such block (non-CC bodies). The model-catalog "# Environment" in the CC
 * system prompt is NOT matched (isMachineEnvironmentBlock excludes it).
 */
function rewriteBlocksIn(content: unknown, machine: AccountMachine, sessionUuid: string): { content: unknown; changed: boolean } {
  if (typeof content === "string") {
    if (isMachineEnvironmentBlock(content)) return { content: rewriteEnvironmentBlock(content, machine, sessionUuid), changed: true };
    return { content, changed: false };
  }
  if (Array.isArray(content)) {
    let changed = false;
    const next = content.map((b) => {
      if (b && typeof b === "object" && typeof (b as Json).text === "string" && isMachineEnvironmentBlock((b as Json).text)) {
        changed = true;
        return { ...(b as Json), text: rewriteEnvironmentBlock((b as Json).text, machine, sessionUuid) };
      }
      return b;
    });
    return { content: next, changed };
  }
  return { content, changed: false };
}

/**
 * Claude Code's `# userEmail` context attachment (a <system-reminder> text block in a user turn) names the
 * *customer's* login. On a shared subscription account that is a different e-mail per customer under one
 * device_id / account_uuid — a plain "shared account" signal — and the customer's address travels to Anthropic
 * (audit 2026-11-01 A4). The direct path drops that reminder. It is an attachment, not the prompt: the billing
 * suffix is computed from the first non-reminder text, so nothing else in the body moves. Deliberately not rewritten
 * to the account owner's e-mail: the reminder tells the model to use the address for authorship, so the owner's
 * address would end up in the customer's commits (the worker path hit exactly that, 2026-10-19).
 */
const REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>\n?/g;
const USER_EMAIL_SECTION_RE = /(^|\n)# userEmail(\n|$)/;
function stripUserEmailText(text: string): { text: string; changed: boolean } {
  let changed = false;
  const out = text.replace(REMINDER_RE, (m) => {
    if (!USER_EMAIL_SECTION_RE.test(m)) return m;
    changed = true;
    return "";
  });
  return { text: out, changed };
}

export function stripUserEmail(body: Json): Json {
  if (!Array.isArray(body.messages)) return body;
  let changed = false;
  const msgs = body.messages.map((m: Json) => {
    if (!m || typeof m !== "object" || m.role !== "user") return m;
    if (typeof m.content === "string") {
      const r = stripUserEmailText(m.content);
      if (!r.changed || r.text.trim() === "") return m;
      changed = true;
      return { ...m, content: r.text };
    }
    if (!Array.isArray(m.content)) return m;
    let touched = false;
    const next: unknown[] = [];
    for (const b of m.content) {
      if (b && typeof b === "object" && (b as Json).type === "text" && typeof (b as Json).text === "string") {
        const r = stripUserEmailText((b as Json).text);
        if (r.changed) {
          touched = true;
          if (r.text.trim() === "") continue; // the reminder was the whole block
          next.push({ ...(b as Json), text: r.text });
          continue;
        }
      }
      next.push(b);
    }
    if (!touched || next.length === 0) return m;
    changed = true;
    return { ...m, content: next };
  });
  return changed ? { ...body, messages: msgs } : body;
}

export function pinMachineEnvironment(body: Json, machine: AccountMachine, sessionUuid: string): Json {
  let out = body;
  // messages[] system-role blocks (where 2.1.312 carries it)
  if (Array.isArray(out.messages)) {
    let changed = false;
    const msgs = out.messages.map((m: Json) => {
      if (!m || typeof m !== "object" || m.role !== "system") return m;
      const r = rewriteBlocksIn(m.content, machine, sessionUuid);
      if (r.changed) { changed = true; return { ...m, content: r.content }; }
      return m;
    });
    if (changed) out = { ...out, messages: msgs };
  }
  // top-level system (string or array) — robustness for other CC shapes
  if (out.system !== undefined) {
    const r = rewriteBlocksIn(out.system, machine, sessionUuid);
    if (r.changed) out = { ...out, system: r.content };
  }
  return out;
}
