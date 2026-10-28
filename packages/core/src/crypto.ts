import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./paths.js";

const ENC_PREFIX = "enc:v1:";

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function newId(): string {
  return randomUUID();
}

/** Read a secret file from data/, creating it (0600) with fresh random bytes if missing. */
function loadOrCreateSecretFile(name: string): string {
  const path = join(dataDir, name);
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  const raw = randomBytes(32).toString("base64url");
  writeFileSync(path, raw, { mode: 0o600 });
  chmodSync(path, 0o600);
  return raw;
}

// Master key: PROVIDER_CRED_KEY env, else data/provider-cred.key. Same
// derivation as v2 (sha256 of the material) so existing ciphertexts decrypt.
const masterKey = createHash("sha256")
  .update(process.env.PROVIDER_CRED_KEY ?? loadOrCreateSecretFile("provider-cred.key"), "utf8")
  .digest();

/** AES-256-GCM, stored as enc:v1:base64(iv ‖ ciphertext ‖ tag). */
export function encryptString(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ENC_PREFIX + Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64");
}

export function decryptString(stored: string): string {
  if (!stored.startsWith(ENC_PREFIX)) throw new Error("value is not enc:v1: encrypted");
  const raw = Buffer.from(stored.slice(ENC_PREFIX.length), "base64");
  const decipher = createDecipheriv("aes-256-gcm", masterKey, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString(
    "utf8",
  );
}

export function encryptJson(value: unknown): string {
  return encryptString(JSON.stringify(value));
}

export function decryptJson<T>(stored: string): T {
  return JSON.parse(decryptString(stored)) as T;
}

// ---------- internal token (gateway -> console loopback calls) ----------

export const internalToken = process.env.INTERNAL_TOKEN ?? loadOrCreateSecretFile("internal.key");
export const INTERNAL_HEADER = "x-1dayapi-internal";

export function verifyInternalToken(value: unknown): boolean {
  if (typeof value !== "string" || !value) return false;
  const a = Buffer.from(value);
  const b = Buffer.from(internalToken);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------- secret generators ----------

/**
 * admin: everything. consumer: own API keys. provider: own nodes/accounts.
 * ops (账号管理员): watches the upstream subscription-account pool and
 * re-authorizes revoked accounts; no users / billing / settings, no inference.
 */
export type Role = "admin" | "consumer" | "provider" | "ops";
export const ROLES: Role[] = ["admin", "consumer", "provider", "ops"];

/** Login key: 1dk_<role>_<48 hex>. */
export function generateLoginKey(role: Role): { plaintext: string; hash: string; preview: string } {
  const plaintext = `1dk_${role}_${randomBytes(24).toString("hex")}`;
  return { plaintext, hash: sha256Hex(plaintext), preview: plaintext.slice(0, 16) };
}

/** API key: sk-1d-<48 hex>; preview keeps the first 10 and last 4 chars. */
export function generateApiKey(): { plaintext: string; hash: string; preview: string } {
  const plaintext = `sk-1d-${randomBytes(24).toString("hex")}`;
  return {
    plaintext,
    hash: sha256Hex(plaintext),
    preview: `${plaintext.slice(0, 10)}…${plaintext.slice(-4)}`,
  };
}

// 31-char alphabet without 0/O/1/I/L.
const REDEEM_CHARSET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export function generateRedeemCode(): string {
  let code = "";
  for (const b of randomBytes(24)) code += REDEEM_CHARSET[b % REDEEM_CHARSET.length];
  return code;
}

export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}
