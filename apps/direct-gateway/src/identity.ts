import crypto from "node:crypto";
import type { Json, RuntimeAccount } from "./types.js";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function stableUuid(seed: string): string {
  const hex = crypto.createHash("sha256").update(seed).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const raw = hex.join("");
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
}

export function metadataSession(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as Json;
    const id = parsed.session_id;
    return typeof id === "string" && UUID_RE.test(id) ? id.toLowerCase() : null;
  } catch {
    return null;
  }
}

export function conversationSession(headers: Headers, body: Json, clientKey: string, model: string): string {
  const explicit = headers.get("x-1dayapi-session-id");
  if (explicit && UUID_RE.test(explicit)) return explicit.toLowerCase();
  const metadata = metadataSession(body.metadata?.user_id);
  if (metadata) return metadata;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const root = JSON.stringify({ user: body.user ?? "", first: messages[0] ?? null });
  return stableUuid(`${clientKey}:${model}:${root}`);
}

export function pinIdentity(body: Json, account: RuntimeAccount, sessionId: string): Json {
  let identity: Json = {};
  try {
    const parsed = JSON.parse(body.metadata?.user_id ?? "{}") as Json;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) identity = parsed;
  } catch {}
  return {
    ...body,
    metadata: {
      ...(body.metadata ?? {}),
      user_id: JSON.stringify({ ...identity, device_id: account.deviceId, account_uuid: account.accountUuid ?? "", session_id: sessionId }),
    },
  };
}
