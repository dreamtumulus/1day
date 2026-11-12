import profile from "./profiles/2.1.322.json" with { type: "json" };
import { UUID_RE } from "./identity.js";
import { accountMachine, machineHeaders } from "./machine.js";
import { canonicalBetas, ccBuildSuffix } from "./shape.js";
import type { Json, RuntimeAccount } from "./types.js";

export const ACTIVE_PROFILE = profile;

export function isClaudeCodeRequest(headers: Headers, body: Json): boolean {
  const ua = /^claude-(?:cli|code)\/(\d+\.\d+\.\d+)/.exec(headers.get("user-agent") ?? "");
  if (!ua) return false;
  const session = headers.get("x-claude-code-session-id") ?? "";
  let identity: Json = {};
  try { identity = JSON.parse(body.metadata?.user_id ?? "{}") as Json; } catch {}
  const system = Array.isArray(body.system) ? body.system : [];
  const first = system[0];
  const billing = typeof first === "string" ? first : first?.text;
  const billingVersion = typeof billing === "string" ? /^x-anthropic-billing-header:\s*cc_version=(\d+\.\d+\.\d+)[^;]*;/.exec(billing)?.[1] : null;
  return headers.get("x-app") === "cli" &&
    billingVersion === ua[1] &&
    /^[0-9a-f]{64}$/i.test(String(identity.device_id ?? "")) &&
    UUID_RE.test(session) &&
    String(identity.session_id ?? "").toLowerCase() === session.toLowerCase() &&
    headers.get("x-stainless-lang") === "js" &&
    headers.get("x-stainless-runtime") === "node" &&
    (headers.get("accept") ?? "").includes("application/json") &&
    headers.get("anthropic-version") === "2023-06-01";
}

export function claudeCodeLike(headers: Headers): boolean {
  return /^claude-(?:cli|code)\//.test(headers.get("user-agent") ?? "");
}

const KNOWN_ENTRYPOINTS = /^(cli|sdk-cli|sdk-ts|sdk-py|claude-vscode|claude-jetbrains|claude-desktop|claude-desktop-3p|local-agent)$/;

function nativeEntrypoint(headers: Headers): string {
  const ua = headers.get("user-agent") ?? "";
  const entrypoint = /\(external,\s*([^,)]+)/.exec(ua)?.[1]?.trim() ?? "";
  return KNOWN_ENTRYPOINTS.test(entrypoint) ? entrypoint : ACTIVE_PROFILE.entrypoint;
}

export function nativeProfileOverrides(incoming: Headers, account: RuntimeAccount): Record<string, string> {
  return {
    "user-agent": `claude-cli/${ACTIVE_PROFILE.claudeCodeVersion} (external, ${nativeEntrypoint(incoming)})`,
    ...machineHeaders(accountMachine(account)),
    "x-stainless-package-version": ACTIVE_PROFILE.sdkVersion,
    "x-stainless-runtime": "node",
    "x-stainless-runtime-version": ACTIVE_PROFILE.runtimeVersion,
  };
}

export function normalizeNativeBody(body: Json, headers: Headers): Json {
  const system = Array.isArray(body.system) ? body.system : [];
  const first = system[0];
  const text = typeof first === "string" ? first : first?.text;
  if (typeof text !== "string") return body;
  const next = text
    .replace(/cc_version=\d+\.\d+\.\d+(?:\.[0-9a-z]+)?/i, `cc_version=${ACTIVE_PROFILE.claudeCodeVersion}.${ccBuildSuffix(body.messages)}`)
    .replace(/cc_entrypoint=[^;]*/, `cc_entrypoint=${nativeEntrypoint(headers)}`);
  if (next === text) return body;
  const billing = typeof first === "string" ? next : { ...first, text: next };
  return { ...body, system: [billing, ...system.slice(1)] };
}

export function agentHeaders(sessionId: string, account: RuntimeAccount): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
    "user-agent": `claude-cli/${ACTIVE_PROFILE.claudeCodeVersion} (external, ${ACTIVE_PROFILE.entrypoint})`,
    "x-claude-code-session-id": sessionId,
    "x-stainless-lang": "js",
    ...machineHeaders(accountMachine(account)),
    "x-stainless-package-version": ACTIVE_PROFILE.sdkVersion,
    "x-stainless-retry-count": "0",
    "x-stainless-runtime": "node",
    "x-stainless-runtime-version": ACTIVE_PROFILE.runtimeVersion,
    "x-stainless-timeout": "600",
    "anthropic-beta": canonicalBetas(Boolean(account.accessToken)),
    "anthropic-dangerous-direct-browser-access": "true",
    "anthropic-version": "2023-06-01",
    "x-app": "cli",
    "accept-encoding": "gzip, deflate, br, zstd",
  };
  if (account.accessToken) headers.authorization = `Bearer ${account.accessToken}`;
  else headers["x-api-key"] = account.apiKey!;
  return headers;
}

function thinkingFor(body: Json, model: string, maxTokens: number): Json {
  if (body.thinking && typeof body.thinking === "object") return body.thinking;
  const modern = /^claude-(?:fable|mythos|opus|sonnet|haiku)-(?:[5-9]|[1-9]\d)/.test(model) || /^claude-opus-4-[78]/.test(model);
  return modern ? { type: "adaptive", display: "omitted" } : { budget_tokens: Math.max(1, maxTokens - 1), type: "enabled", display: "omitted" };
}

export function agentBody(source: Json, model: string, account: RuntimeAccount, sessionId: string): Json {
  const originalSystem = source.system;
  const system: Json[] = [
    { type: "text", text: `x-anthropic-billing-header: cc_version=${ACTIVE_PROFILE.claudeCodeVersion}.${ccBuildSuffix(source.messages)}; cc_entrypoint=${ACTIVE_PROFILE.entrypoint};` },
    { type: "text", text: ACTIVE_PROFILE.identityBlock, cache_control: { type: "ephemeral" } },
    { type: "text", text: ACTIVE_PROFILE.mainPrompt, cache_control: { type: "ephemeral" } },
  ];
  if (typeof originalSystem === "string" && originalSystem) {
    system.push({ type: "text", text: originalSystem, cache_control: { type: "ephemeral" } });
  } else if (Array.isArray(originalSystem)) {
    for (const block of originalSystem) {
      if (typeof block === "string") system.push({ type: "text", text: block, cache_control: { type: "ephemeral" } });
      else if (block && typeof block === "object") system.push({ ...block, cache_control: block.cache_control ?? { type: "ephemeral" } });
    }
  }
  const maxTokens = Number(source.max_tokens ?? 32000);
  const tools = Array.isArray(source.tools) ? [...source.tools].sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? ""))) : [];
  return {
    model,
    messages: source.messages ?? [],
    system,
    tools,
    metadata: { user_id: JSON.stringify({ device_id: account.deviceId, account_uuid: account.accountUuid ?? "", session_id: sessionId }) },
    max_tokens: maxTokens,
    thinking: thinkingFor(source, model, maxTokens),
    context_management: source.context_management ?? ACTIVE_PROFILE.contextManagement,
    stream: source.stream === true,
  };
}
