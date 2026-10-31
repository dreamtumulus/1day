/**
 * Claude Code 请求指纹（docs/claude-code-compat.md §3/§6）。
 * 常量锚定 Claude Code 2.1.312 / @anthropic-ai/sdk 0.128.0（2026-10-28 采样，docs/claude-code-compat.md §11）；升级按文档 §9 SOP。
 */

import { randomBytes, randomUUID } from "node:crypto";
import { sha256Hex } from "./crypto.js";

export const CC_VERSION = "2.1.312";
export const CC_SDK_VERSION = "0.128.0";
export const CC_RUNTIME_VERSION = "v26.12.1";
export const CC_ANTHROPIC_VERSION = "2023-06-01";
export const CC_BETAS = [
  "claude-code-20250219",
  "interleaved-thinking-2025-05-14",
  "context-management-2025-06-27",
  "thinking-token-count-2026-05-13",
];
/**
 * Canonical anthropic-beta list in the order a 2.1.312 client sends it: `oauth-2025-04-20` sits
 * right after `claude-code-20250219` on OAuth accounts (12 captures, docs/claude-code-compat.md §11),
 * not at the tail. Feature-dependent betas are passed through from genuine CC requests instead of
 * being injected into bodies that do not use those features.
 */
export function ccCanonicalBetas(oauth: boolean): string[] {
  const [first, ...rest] = CC_BETAS;
  return oauth ? [first, "oauth-2025-04-20", ...rest] : [first, ...rest];
}

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

export const CC_IDENTITY_BLOCK = "You are Claude Code, Anthropic's official CLI for Claude.";

function firstUserText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  const message = messages.find((m) => m && typeof m === "object" && (m.role === "user" || m.type === "user") && m.isMeta !== true);
  const content = message?.content ?? message?.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  // The billing hash is computed from the user's prompt, not Claude Code's injected reminder attachments.
  const block = content.find((b) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string" && !b.text.trimStart().startsWith("<system-reminder>"));
  return block?.text ?? "";
}

/** Claude Code 2.1.312 derives the three-digit billing flag from the first user text and client version. */
export function ccBuildSuffix(messages: unknown, version = CC_VERSION): string {
  const text = firstUserText(messages);
  const chars = [4, 7, 20].map((i) => text[i] ?? "0").join("");
  return sha256Hex(`59cf53e54c78${chars}${version}`).slice(0, 3);
}

export function ccBillingBlock(messages: unknown, entrypoint = "cli", version = CC_VERSION): string {
  return `x-anthropic-billing-header: cc_version=${version}.${ccBuildSuffix(messages, version)}; cc_entrypoint=${entrypoint};`;
}

/** metadata.user_id（JSON 字符串，docs/claude-code-compat.md §5）。 */
export function ccMetadataUserId(sessionId: string = randomUUID()): string {
  return JSON.stringify({ device_id: randomBytes(32).toString("hex"), account_uuid: "", session_id: sessionId });
}

/**
 * 把一段 hex（通常是会话 namespace 的 sha256）整形成一个**合法的 UUIDv4**：
 * 第 13 位固定 `4`、第 17 位取 `8/9/a/b`。真 Claude Code 的 session_id 由 `randomUUID()`
 * 生成，一定满足 v4 的 version/variant 位；此前我们直接 8-4-4-4-12 切片，约 15/16 不合法，
 * 既出现在 metadata.user_id.session_id 里也出现在 x-claude-code-session-id 头里，是一条
 * 一行正则就能命中的指纹（docs/claude-code-compat.md §5/§10）。确定性保留：同一 namespace 永远同值。
 */
export function sessionUuidFromHash(hash: string): string {
  const h = hash.padEnd(32, "0").slice(0, 32);
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * metadata.user_id 占位串，字段顺序与真 Claude Code 2.1.312 完全一致
 * （`device_id` → `account_uuid` → `session_id`）。device_id / account_uuid 先留空，
 * 由 gateway `pinDeviceIdentity` 在请求离开前原位改写成账号自己的身份，顺序不变。
 * 此前把 metadata 覆盖成只有 `{session_id}`、再由 pinDeviceIdentity 追加 device_id/account_uuid，
 * 发出去是 `{session_id, device_id, account_uuid}` —— 顺序反了，又是一条精确指纹。
 */
export function sessionMetadataUserId(sessionId: string): string {
  return JSON.stringify({ device_id: "", account_uuid: "", session_id: sessionId });
}

// ---------- 每账号合成机器画像（docs/claude-code-compat.md §10）----------
//
// Claude Code 每条请求在 messages[] 里带一条 role:"system" 的「# Environment」块，
// 内含 Primary working directory / Platform / Shell / OS Version / Scratchpad directory。
// 这个块由客户端本地生成、上游不校验其值（不在真伪硬检查清单里），但真 CC 永远带它，
// 所以不能删、要像真的。直连路径此前原样透传客户真机（Mac 用户名、darwin/Darwin），
// 与我们强制的 `x-stainless-os: Linux` 头自相矛盾，且同号的 worker 路径显示节点机器 → 一号两机。
//
// 对策：给每个账号一份**确定性**合成机器档（从 account id 派生，稳定、各实例一致、无需迁移）。
// cwd/home 按号各异（强区分度，配合已按号唯一的 device_id），Platform/Shell 归一到节点同类（linux/bash）。
// 这只改写直连 body；worker 遥测仍读取节点真实系统，不能把它当作按账号虚拟化后的主机事实。

// 每账号「一台独立真实 Linux 开发机」——生成式，不是查表（sub2api 的 11 档会把几千个号聚成 11 个相同签名，
// 本身就是号池特征）。关键约束（docs/claude-code-compat.md §8 + 实测）：
//   1. CC 版本定死的字段统一、不做多样性：`x-stainless-runtime`=node、`x-stainless-runtime-version`（bundled node）、
//      `x-stainless-package-version`（SDK）、UA 版本、beta 集——真 2.1.312 客户端全都发同一组值。
//      billing 后缀不是版本常量，由首条用户文本计算，见 ccBuildSuffix。
//   2. TLS 由 Bun 版本与 HTTP 配置决定，不从 body 的 OS 字段推导。机器档只覆盖生产 worker 的 Linux/x64 形态，
//      不让同一账号在 worker 报 x64、直连却声明 arm64。
//   3. 内核串、shell、工作目录可以按号派生；它们只影响直连 body，不会改变 TLS 或 worker 遥测。

// 真实 Ubuntu/Debian 桌面与服务器常见内核线；-NN-generic 的 NN 按号从合理区间取。
const MP_KERNEL_LINES = ["6.8.0", "6.8.0", "6.11.0", "6.5.0", "5.15.0", "6.2.0", "6.14.0", "6.12.0"];
const MP_SHELLS = ["bash", "bash", "bash", "bash", "zsh"]; // ~80% bash / 20% zsh
const MP_USERNAMES = [
  "james", "mary", "robert", "patricia", "john", "jennifer", "michael", "linda",
  "david", "elizabeth", "william", "barbara", "richard", "susan", "joseph", "jessica",
  "thomas", "sarah", "charles", "karen", "daniel", "nancy", "matthew", "lisa",
  "anthony", "betty", "mark", "margaret", "donald", "sandra", "steven", "ashley",
  "paul", "kimberly", "andrew", "emily", "joshua", "michelle", "kevin", "amanda",
  "dev", "alex", "chen", "wei", "li", "yuki", "raj", "omar", "nina", "leo",
];
const MP_REPOS = [
  "website", "api-server", "mobile-app", "data-pipeline", "backend", "frontend",
  "dashboard", "cli-tools", "scripts", "ml-project", "web-app", "microservices",
  "monorepo", "infra", "auth-service", "payment-gateway", "analytics", "chatbot",
  "ecommerce", "blog-engine", "task-queue", "file-sync", "search-service", "cms",
  "app", "api", "server", "core", "platform", "sdk", "bot", "pipeline",
];
// 工作目录版式：{u}=用户名 {r}=仓库名。覆盖真实开发者常见布局。
const MP_LAYOUTS = [
  "/home/{u}/projects/{r}", "/home/{u}/code/{r}", "/home/{u}/dev/{r}", "/home/{u}/work/{r}",
  "/home/{u}/src/{r}", "/home/{u}/repos/{r}", "/home/{u}/{r}", "/home/{u}/go/src/{r}",
  "/home/{u}/workspace/{r}", "/opt/{r}", "/srv/{r}",
];

export interface MachineProfile {
  stainlessOS: string; // x-stainless-os
  stainlessArch: string; // x-stainless-arch
  platform: string; // # Environment Platform
  osVersion: string; // # Environment OS Version（完整串）
}

/** 一个账号的完整机器身份：机器档 + shell + 工作目录 + 家目录（Scratchpad 用）。 */
export interface AccountMachine {
  profile: MachineProfile;
  shell: string;
  workingDir: string;
  home: string;
}

/** 从 accountId + 盐 派生一个 [0,2^48) 的确定性整数，用于各维度独立选取（不同盐 → 不相关）。 */
function deriveN(salt: string, accountId: string): number {
  return parseInt(sha256Hex(`${salt}${accountId}`).slice(0, 12), 16);
}
function pickFrom<T>(arr: readonly T[], salt: string, accountId: string): T {
  return arr[deriveN(salt, accountId) % arr.length];
}

/** 按 accountId 确定性派生直连机器身份（同号恒定、不随机、不依赖缓存/Redis）。 */
export function accountMachine(accountId: string, _osField?: string | null): AccountMachine {
  const line = pickFrom(MP_KERNEL_LINES, "cc-mach-kline::", accountId);
  const nn = 20 + (deriveN("cc-mach-knn::", accountId) % 60); // -20..-79-generic
  const shell = pickFrom(MP_SHELLS, "cc-mach-shell::", accountId);
  const user = pickFrom(MP_USERNAMES, "cc-mach-user::", accountId);
  const repo = pickFrom(MP_REPOS, "cc-mach-repo::", accountId);
  const workingDir = pickFrom(MP_LAYOUTS, "cc-mach-layout::", accountId).replace("{u}", user).replace("{r}", repo);
  const profile: MachineProfile = {
    stainlessOS: "Linux",
    stainlessArch: "x64",
    platform: "linux",
    osVersion: `Linux ${line}-${nn}-generic`,
  };
  return { profile, shell, workingDir, home: `/home/${user}` };
}

/**
 * 该账号机器身份对应的 x-stainless-* 头（与 body 的 # Environment 同源）。
 * runtime / runtime-version 是 CC 版本定死的（真 2.1.312 恒定），由调用方用 CC 常量补齐；os/arch 与机器档一致。
 */
export function machineStainlessHeaders(m: AccountMachine): Record<string, string> {
  return {
    "x-stainless-os": m.profile.stainlessOS,
    "x-stainless-arch": m.profile.stainlessArch,
    "x-stainless-runtime": "node",
    "x-stainless-runtime-version": CC_RUNTIME_VERSION,
  };
}

const ENV_BLOCK_HEAD = "# Environment";
const ENV_BLOCK_MARK = "invoked in the following environment";

/** True when a text block is Claude Code's machine-identity Environment block (not the model-catalog one in system[]). */
export function isMachineEnvironmentBlock(text: unknown): boolean {
  return typeof text === "string" && text.startsWith(ENV_BLOCK_HEAD) && text.includes(ENV_BLOCK_MARK);
}

/**
 * 把 Claude Code 机器身份 Environment 块的机器行改写成该账号的合成机器（移植 sub2api
 * `rewriteEnvironmentFields`，但按 1dayapi 实测 2.1.312 的 ` - <字段>: ` 行格式，见
 * ops/cc-capture 抓包）。只改已存在的字段行，保留全部其余 guidance 文本。
 * Scratchpad 行若存在，把其中的家目录路径换成合成家目录（去掉真实用户名泄露）。
 */
export function rewriteEnvironmentBlock(text: string, m: AccountMachine, sessionUuid: string): string {
  if (!isMachineEnvironmentBlock(text)) return text;
  let out = text;
  out = out.replace(/^( - Primary working directory: ).*$/m, `$1${m.workingDir}`);
  out = out.replace(/^( - Platform: ).*$/m, `$1${m.profile.platform}`);
  out = out.replace(/^( - Shell: ).*$/m, `$1${m.shell}`);
  out = out.replace(/^( - OS Version: ).*$/m, `$1${m.profile.osVersion}`);
  // Scratchpad 行（若有）：只换路径令牌（到 " — " guidance 分隔符之前），家目录风格随平台。
  const sep = m.profile.platform === "win32" ? "\\" : "/";
  const scratch = `${m.home}${sep}.claude${sep}projects${sep}${sessionUuid}${sep}scratchpad`;
  out = out.replace(/^( - Scratchpad directory: )[^\n]*?( — )/m, `$1${scratch}$2`);
  return out;
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
  if (changed.includes("version")) {
    outHeaders["x-stainless-package-version"] = CC_SDK_VERSION;
    outHeaders["x-stainless-runtime-version"] = CC_RUNTIME_VERSION;
  }
  // Billing block (first system text block): keep every other field, align version / entrypoint.
  let outBody = body;
  const system = body?.system;
  if (Array.isArray(system) && system.length > 0) {
    const b0 = system[0];
    const text = typeof b0 === "string" ? b0 : b0 && typeof b0 === "object" && (b0 as Json).type === "text" ? String((b0 as Json).text ?? "") : null;
    if (text !== null && BILLING_LINE_RE.test(text)) {
      let line = text;
      // Pinned to the node's own build: recompute the prompt-dependent flag using the same algorithm as CC 2.1.312.
      // Pinned to another version: keep the client's flag because that build's salt is not asserted here.
      if (changed.includes("version")) line = line.replace(/(cc_version=)\d+\.\d+\.\d+(\.[0-9a-z]+)?/, (_m, pre, suf) => `${pre}${version}${version === CC_VERSION ? `.${ccBuildSuffix(body.messages, version)}` : (suf ?? "")}`);
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
 * are filled with the canonical CC 2.1.312 set. Auth and anthropic-beta are
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
