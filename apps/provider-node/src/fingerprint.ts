// vendored from packages/core/src/fingerprint.ts — 权威定义在 core，升级指纹时两边同步（docs/claude-code-compat.md §8）
/**
 * Claude Code 请求指纹（docs/claude-code-compat.md §3/§6）。
 * 常量锚定 Claude Code 2.1.312 / @anthropic-ai/sdk 0.128.0（2026-10-28 采样，docs/claude-code-compat.md §11）；升级按文档 §9 SOP。
 */

export const CC_VERSION = "2.1.312";
export const CC_SDK_VERSION = "0.128.0";
export const CC_RUNTIME_VERSION = "v26.12.1";
export const CC_ANTHROPIC_VERSION = "2023-06-01";
/** Auxiliary (axios) calls of Claude Code: `claude-code/<ver>` + axios default Accept (docs/claude-code-compat.md §8). */
export const CC_AUX_UA = `claude-code/${CC_VERSION}`;
export const CC_AUX_ACCEPT = "application/json, text/plain, */*";
export const CC_BETAS = [
  "claude-code-20250219",
  "interleaved-thinking-2025-05-14",
  "context-management-2025-06-27",
  "thinking-token-count-2026-05-13",
];
/**
 * Canonical anthropic-beta list in the order a 2.1.312 client sends it: `oauth-2025-04-20` sits
 * right after `claude-code-20250219` on OAuth accounts (12 captures, docs/claude-code-compat.md §11),
 * not at the tail.
 */
export function ccCanonicalBetas(oauth: boolean): string[] {
  const [first, ...rest] = CC_BETAS;
  return oauth ? [first, "oauth-2025-04-20", ...rest] : [first, ...rest];
}

/** Machine headers of the native Claude Code build on a node (claude-cli 2.1.303 ELF, Linux x64, 2026-10-19). */
export const NODE_MACHINE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "x-stainless-os": "Linux",
  "x-stainless-arch": "x64",
  "x-stainless-runtime": "node",
  "x-stainless-runtime-version": CC_RUNTIME_VERSION,
});

type ClientHeaders = Record<string, string | string[] | undefined>;

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
    if (name === "user-agent" && !/^(claude-cli|claude-code)\//.test(v)) continue;
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
  // One account = one machine: the worker path is a real Claude Code on this node, so the
  // direct path reports the same machine (see packages/core/src/fingerprint.ts).
  Object.assign(out, NODE_MACHINE_HEADERS);
  const clientAccept = first(clientHeaders.accept);
  out.accept = clientAccept && clientAccept.includes("application/json") ? clientAccept : "application/json";
  // undici 无法解码 zstd（docs/claude-code-compat.md §7.2）
  // Exactly what Claude Code sends; the node relays /v1 bodies compressed and the gateway decodes (zstd needs Node ≥ 22.15).
  out["accept-encoding"] = "gzip, deflate, br, zstd";
  return out;
}
