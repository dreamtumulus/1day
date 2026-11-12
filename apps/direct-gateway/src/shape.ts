import crypto from "node:crypto";
import { ACTIVE_PROFILE } from "./profile.js";
import { UUID_RE } from "./identity.js";
import type { Json, RuntimeAccount } from "./types.js";

export class ShapeError extends Error {
  constructor(readonly missing: string[]) {
    super(`Outgoing Claude Code shape mismatch: ${missing.join(",")}`);
    this.name = "ShapeError";
  }
}

function firstUserText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  const message = messages.find((m) => m && typeof m === "object" && (m.role === "user" || m.type === "user") && m.isMeta !== true);
  const content = message?.content ?? message?.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const block = content.find((b) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string" && !b.text.trimStart().startsWith("<system-reminder>"));
  return block?.text ?? "";
}

export function ccBuildSuffix(messages: unknown, version = ACTIVE_PROFILE.claudeCodeVersion): string {
  const text = firstUserText(messages);
  const chars = [4, 7, 20].map((i) => text[i] ?? "0").join("");
  return crypto.createHash("sha256").update(`59cf53e54c78${chars}${version}`).digest("hex").slice(0, 3);
}

export function billingVersionOf(body: Json): string | null {
  const first = Array.isArray(body.system) ? body.system[0] : null;
  const text = typeof first === "string" ? first : first?.text;
  return typeof text === "string" ? /cc_version=(\d+\.\d+\.\d+)/.exec(text)?.[1] ?? null : null;
}

export function alignBillingSuffix(body: Json): Json {
  const version = billingVersionOf(body);
  if (!version || !Array.isArray(body.system) || body.system.length === 0) return body;
  const first = body.system[0];
  const text = typeof first === "string" ? first : first?.text;
  if (typeof text !== "string" || !text.startsWith("x-anthropic-billing-header:")) return body;
  const want = ccBuildSuffix(body.messages, version);
  const line = text.replace(/(cc_version=\d+\.\d+\.\d+)(\.[0-9a-z]+)?/i, (_match, prefix) => `${prefix}.${want}`);
  if (line === text) return body;
  return { ...body, system: [typeof first === "string" ? line : { ...first, text: line }, ...body.system.slice(1)] };
}

export function metadataUserId(identity: Json, account: RuntimeAccount, sessionId: string): string {
  const { device_id: _device, account_uuid: _account, session_id: _session, ...others } = identity;
  return JSON.stringify({ device_id: account.deviceId, account_uuid: account.accountUuid ?? "", session_id: sessionId, ...others });
}

export function canonicalBetas(oauth: boolean, incoming = ""): string {
  const present = new Set(incoming.split(",").map((v) => v.trim()).filter(Boolean));
  const base = [...ACTIVE_PROFILE.betas];
  const betas = oauth ? [base[0], "oauth-2025-04-20", ...base.slice(1)] : base;
  for (const beta of present) if (!betas.includes(beta)) betas.push(beta);
  return betas.join(",");
}

function claudeLine(model: string): { family: string; version: number } | null {
  const match = /^claude-(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d))?(?:-\d{8})?$/.exec(model);
  return match ? { family: match[1], version: Number(match[2]) + (match[3] ? Number(match[3]) / 10 : 0) } : null;
}

export function normalizeThinking(body: Json, model: string): Json {
  const thinking = body.thinking;
  if (!thinking || typeof thinking !== "object") return body;
  const line = claudeLine(model);
  if (!line) return body;
  const type = typeof thinking.type === "string" ? thinking.type : "";
  const effort = typeof body.output_config?.effort === "string" ? body.output_config.effort : typeof body.effort === "string" ? body.effort : "";
  const highEffort = effort === "xhigh" || effort === "max";
  const drop = (): Json => {
    const { thinking: _omit, ...rest } = body;
    return rest;
  };
  if (type === "enabled") {
    const rejectsBudget = line.version >= 5 || (line.family === "opus" && line.version >= 4.7);
    if (!rejectsBudget) return body;
    const { budget_tokens: _budget, ...preserved } = thinking;
    return { ...body, thinking: { ...preserved, type: "adaptive" } };
  }
  if (type === "disabled") {
    const alwaysOn = ((line.family === "fable" || line.family === "mythos") && line.version >= 5) || (line.family === "opus" && line.version >= 5.5);
    if (alwaysOn) return drop();
    if (line.family === "sonnet" && line.version >= 5.5) return highEffort ? drop() : { ...body, thinking: { ...thinking, type: "between_tools" } };
    if (line.version >= 5 && highEffort) return drop();
    return body;
  }
  if (type === "between_tools") return line.family === "sonnet" && line.version >= 5.5 && !highEffort ? body : drop();
  return body;
}

export function canonicalBodyOrder(body: Json): Json {
  const order = ["model", "messages", "system", "tools", "metadata", "max_tokens", "thinking", "context_management", "safeguards", "output_config", "stream"];
  const out: Json = {};
  for (const key of order) if (key in body) out[key] = body[key];
  for (const [key, value] of Object.entries(body)) if (!(key in out)) out[key] = value;
  return out;
}

export function assertOutgoingShape(headers: Record<string, string>, body: Json, countTokens = false): void {
  const missing: string[] = [];
  const version = ACTIVE_PROFILE.claudeCodeVersion;
  const ua = new RegExp(`^claude-cli/${version.replaceAll(".", "\\.")} \\(external, ([^,)]+)`).exec(headers["user-agent"] ?? "");
  if (!ua) missing.push("user_agent");
  if (headers["x-app"] !== "cli") missing.push("x_app_cli");
  if (headers["x-stainless-lang"] !== "js") missing.push("stainless_lang");
  if (headers["x-stainless-package-version"] !== ACTIVE_PROFILE.sdkVersion) missing.push("stainless_package_version");
  if (headers["x-stainless-runtime"] !== "node" || headers["x-stainless-runtime-version"] !== ACTIVE_PROFILE.runtimeVersion) missing.push("stainless_runtime");
  if (!(headers.accept ?? "").includes("application/json")) missing.push("accept_json");
  if (headers["anthropic-version"] !== "2023-06-01") missing.push("anthropic_version");
  const betas = (headers["anthropic-beta"] ?? "").split(",");
  if (!betas.includes("claude-code-20250219")) missing.push("beta_claude_code");
  if (headers.authorization && betas[1] !== "oauth-2025-04-20") missing.push("oauth_beta_order");
  const topLevelOrder = ["model", "messages", "system", "tools", "metadata", "max_tokens", "thinking", "context_management", "safeguards", "output_config", "stream"];
  let previous = -1;
  for (const key of Object.keys(body)) {
    const index = topLevelOrder.indexOf(key);
    if (index < 0) continue;
    if (index <= previous) missing.push("top_level_order");
    previous = Math.max(previous, index);
  }
  const billing = billingVersionOf(body);
  if (billing !== version) missing.push("billing_version_mismatch");
  const suffix = ccBuildSuffix(body.messages, version);
  const first = Array.isArray(body.system) ? body.system[0] : null;
  const billingText = typeof first === "string" ? first : first?.text;
  if (typeof billingText !== "string" || !billingText.includes(`.${suffix};`)) missing.push("billing_suffix");
  const entrypoint = /cc_entrypoint=([^;]+)/.exec(billingText ?? "")?.[1];
  if (ua && entrypoint && ua[1] !== entrypoint) missing.push("entrypoint_mismatch");
  let identity: Json = {};
  try { identity = JSON.parse(body.metadata?.user_id ?? "{}") as Json; } catch {}
  if (!/^[0-9a-f]{64}$/i.test(String(identity.device_id ?? ""))) missing.push("metadata_device_id");
  if (!UUID_RE.test(String(identity.session_id ?? ""))) missing.push("metadata_session_id");
  const sessionHeader = headers["x-claude-code-session-id"] ?? "";
  if (!UUID_RE.test(sessionHeader)) missing.push("session_id_header");
  else if (String(identity.session_id ?? "").toLowerCase() !== sessionHeader.toLowerCase()) missing.push("session_id_mismatch");
  if (headers["x-stainless-os"] === "Linux" && /Platform:\s*(?:darwin|win32)/i.test(JSON.stringify(body))) missing.push("machine_environment");
  if (missing.length) throw new ShapeError(missing);
}
