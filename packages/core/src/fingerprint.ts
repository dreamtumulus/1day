/**
 * Claude Code 请求指纹（docs/claude-code-compat.md §3/§6）。
 * 常量锚定 Claude Code 2.1.300 / @anthropic-ai/sdk 0.128.0；升级按文档 §8 SOP。
 */

import { randomBytes, randomUUID } from "node:crypto";

export const CC_VERSION = "2.1.300";
export const CC_SDK_VERSION = "0.128.0";
export const CC_RUNTIME_VERSION = "v26.3.0";
export const CC_ANTHROPIC_VERSION = "2023-06-01";
export const CC_BETAS = [
  "claude-code-20250219",
  "interleaved-thinking-2025-05-14",
  "thinking-token-count-2026-05-13",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
];

/**
 * 辅助端点指纹（docs/claude-code-compat.md §8）：CC 对 /api/oauth/* 与 OAuth
 * token 端点的调用走 axios 辅助函数，只带 Authorization + UA + axios 默认 Accept；
 * UA 是 `claude-code/<ver>`（无 entrypoint 后缀，bundle `ps()`），不是 SDK 的 claude-cli/。
 */
/**
 * Machine headers of the native Claude Code build on a worker node (captured from the
 * claude-cli 2.1.303 ELF on Linux x64, 2026-10-19). The direct path pins these so both
 * paths of one account look like the same host (docs/claude-code-compat.md §8).
 */
export const NODE_MACHINE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "x-stainless-os": "Linux",
  "x-stainless-arch": "x64",
  "x-stainless-runtime": "node",
  "x-stainless-runtime-version": CC_RUNTIME_VERSION,
});

export const CC_AUX_UA = `claude-code/${CC_VERSION}`;
export const CC_AUX_ACCEPT = "application/json, text/plain, */*";

/** 计费头 system 块与身份句（docs/claude-code-compat.md §5）；OAuth 订阅号缺计费块 → 上游 429。 */
export const CC_BILLING_BLOCK = `x-anthropic-billing-header: cc_version=${CC_VERSION}.f23; cc_entrypoint=cli;`;
export const CC_IDENTITY_BLOCK = "You are Claude Code, Anthropic's official CLI for Claude.";

/** metadata.user_id（JSON 字符串，docs/claude-code-compat.md §5）。 */
export function ccMetadataUserId(sessionId: string = randomUUID()): string {
  return JSON.stringify({ device_id: randomBytes(32).toString("hex"), account_uuid: "", session_id: sessionId });
}

/**
 * 探活/测试用的随机提示词池。固定提示词（"ping"、同一个 OK 句式）按固定节奏
 * 从同一批账号发出，本身就是可识别的机器人模式 —— 每次探测取一条随机自然句子。
 */
export const PROBE_PROMPTS = [
  "What's one good way to make cold brew coffee at home?",
  "Give me a single tip for falling asleep faster.",
  "Why is the sky blue? One sentence.",
  "Suggest a quick stretch for someone sitting all day.",
  "What's the difference between a latte and a flat white?",
  "Name one book you'd recommend to a beginner in philosophy.",
  "How do I keep basil alive indoors? One tip.",
  "What's a simple trick to remember names better?",
  "Give me one idea for a 15-minute weekday dinner.",
  "Why do cats purr? Short answer.",
  "What's one underrated feature of Python dictionaries?",
  "How often should a laptop battery be fully drained?",
  "One sentence: why do we see lightning before we hear thunder?",
  "Suggest a good morning habit that takes under two minutes.",
  "What's the fastest way to defrost chicken safely?",
  "Give me one tip for taking better phone photos at night.",
  "Why do airplanes have winglets? Brief answer.",
  "What's one way to make instant noodles taste better?",
  "How do noise-cancelling headphones work? One sentence.",
  "Suggest one exercise for lower back tension.",
] as const;

export function randomProbePrompt(): string {
  return PROBE_PROMPTS[Math.floor(Math.random() * PROBE_PROMPTS.length)];
}

type ClientHeaders = Record<string, string | string[] | undefined>;

/**
 * One account = one software (docs/gateway.md §3, 2026-10-20): on the direct path the
 * client's own Claude Code UA passed through verbatim, so one pinned device showed up
 * with up to 7 CC versions a day and customer-made entrypoints ("(external, mirasim)" was
 * 70% of direct traffic). Rewrite the UA entrypoint to a real one and, when `versionPin`
 * is set, the UA version, the stainless package version and the billing block's
 * cc_version — all three must agree (the cc-shape gate checks the same pair).
 * Non-CC user agents are returned untouched (the node then substitutes the canonical UA).
 */
const CC_UA_FULL_RE = /^(claude-cli|claude-code)\/(\d+\.\d+\.\d+)(\S*)(.*)$/;
const UA_ENTRYPOINT_RE = /\(external,\s*([^,)]+)([^)]*)\)/;
/** Entrypoints real Claude Code builds and official SDKs send (nginx 2026-10-20 + docs/claude-code-compat.md §3). */
const KNOWN_ENTRYPOINTS = /^(cli|sdk-cli|sdk-ts|sdk-py|claude-vscode|claude-jetbrains|claude-desktop|claude-desktop-3p|local-agent)$/;
const BILLING_LINE_RE = /^(x-anthropic-billing-header:\s*)(.*)$/m;

type Json = Record<string, any>;

export interface CcSoftwareNormalization {
  headers: Record<string, string | string[] | undefined>;
  body: Json;
  /** What was rewritten: "entrypoint", "version". Empty = untouched. */
  changed: string[];
}

export function normalizeCcSoftware(
  headers: Record<string, string | string[] | undefined>,
  body: Json,
  opts: { normalizeEntrypoint: boolean; versionPin: string | null },
): CcSoftwareNormalization {
  const ua = typeof headers["user-agent"] === "string" ? headers["user-agent"] : "";
  const m = CC_UA_FULL_RE.exec(ua);
  if (!m) return { headers, body, changed: [] };
  const changed: string[] = [];
  let [, product, version, buildSuffix, rest] = m;
  let entrypoint: string | null = null;
  const ep = UA_ENTRYPOINT_RE.exec(rest);
  if (opts.normalizeEntrypoint && ep && !KNOWN_ENTRYPOINTS.test(ep[1].trim())) {
    rest = rest.replace(UA_ENTRYPOINT_RE, "(external, cli)");
    entrypoint = "cli";
    changed.push("entrypoint");
  }
  const pin = opts.versionPin && /^\d+\.\d+\.\d+$/.test(opts.versionPin) ? opts.versionPin : null;
  if (pin && pin !== version) {
    version = pin;
    buildSuffix = "";
    changed.push("version");
  }
  if (changed.length === 0) return { headers, body, changed };
  const outHeaders: Record<string, string | string[] | undefined> = { ...headers, "user-agent": `${product}/${version}${buildSuffix}${rest}` };
  if (changed.includes("version")) outHeaders["x-stainless-package-version"] = CC_SDK_VERSION;
  // Billing block (first system text block): keep every other field, align version / entrypoint.
  let outBody = body;
  const system = body?.system;
  if (Array.isArray(system) && system.length > 0) {
    const b0 = system[0];
    const text = typeof b0 === "string" ? b0 : b0 && typeof b0 === "object" && (b0 as Json).type === "text" ? String((b0 as Json).text ?? "") : null;
    if (text !== null && BILLING_LINE_RE.test(text)) {
      let line = text;
      if (changed.includes("version")) line = line.replace(/(cc_version=)\d+\.\d+\.\d+/, `$1${version}`);
      if (entrypoint) line = line.replace(/(cc_entrypoint=)[^;]*/, `$1${entrypoint}`);
      if (line !== text) {
        const nb0 = typeof b0 === "string" ? line : { ...(b0 as Json), text: line };
        outBody = { ...body, system: [nb0, ...system.slice(1)] };
      }
    }
  }
  return { headers: outHeaders, body: outBody, changed };
}

/** Claude Code 系客户端识别（docs/ccr-supply.md §5.2 R1 / claude-code-compat.md §3）。 */
const CC_UA_RE = /^(claude-cli|claude-code)\//;
export function isClaudeCodeUa(ua: unknown): boolean {
  return typeof ua === "string" && CC_UA_RE.test(ua);
}

function first(v: string | string[] | undefined): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

/** Headers a real Claude Code client sends that we pass through verbatim when present. */
const PASSTHROUGH = [
  "user-agent",
  "x-app",
  "x-claude-code-session-id",
  "anthropic-dangerous-direct-browser-access",
  "x-stainless-arch",
  "x-stainless-lang",
  "x-stainless-os",
  "x-stainless-package-version",
  "x-stainless-retry-count",
  "x-stainless-runtime",
  "x-stainless-runtime-version",
  "x-stainless-timeout",
] as const;

/**
 * Build the header block for an Anthropic-wire upstream request so it matches
 * an official Claude Code request: client-sent fingerprint headers win, gaps
 * are filled with the canonical CC 2.1.300 set. Auth and anthropic-beta are
 * handled by the caller (account-dependent).
 */
export function anthropicFingerprintHeaders(clientHeaders: ClientHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of PASSTHROUGH) {
    const v = first(clientHeaders[name]);
    if (!v) continue;
    // UA 只在确属 Claude Code / Agent SDK 时透传；curl/python 等 UA 一律换成 canonical，
    // 否则比不发更扎眼。
    if (name === "user-agent" && !isClaudeCodeUa(v)) continue;
    out[name] = v;
  }
  const defaults: Record<string, string> = {
    "user-agent": `claude-cli/${CC_VERSION} (external, cli)`,
    "x-app": "cli",
    "anthropic-dangerous-direct-browser-access": "true",
    "x-stainless-lang": "js",
    "x-stainless-package-version": CC_SDK_VERSION,
    "x-stainless-retry-count": "0",
    "x-stainless-timeout": "600",
  };
  for (const [k, v] of Object.entries(defaults)) if (!out[k]) out[k] = v;
  // One account = one machine (docs/claude-code-compat.md §8). The worker path is a real
  // Claude Code on the node, so the direct path reports the node's machine too; otherwise
  // the same device_id shows up as Darwin/arm64 (customer laptop) and Linux/x64 (node)
  // within the same minute. Applied after the client values: never passed through.
  Object.assign(out, NODE_MACHINE_HEADERS);
  const clientAccept = first(clientHeaders.accept);
  out.accept = clientAccept && clientAccept.includes("application/json") ? clientAccept : "application/json";
  // undici 无法解码 zstd（docs/claude-code-compat.md §7.2）
  out["accept-encoding"] = "gzip, deflate, br";
  return out;
}
