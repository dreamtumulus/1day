import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const ENC_PREFIX = "enc:v1:";

/**
 * Loads (or generates) the master key stored at `keyPath`.
 * The file holds 32 random bytes encoded base64url (0600); the AES-256-GCM
 * key is sha256 of those bytes, per docs/provider-protocol.md.
 */
export function loadMasterKey(keyPath: string): Buffer {
  let raw: string | null = null;
  try {
    raw = fs.readFileSync(keyPath, "utf8").trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (raw !== null) {
    const bytes = Buffer.from(raw, "base64url");
    if (bytes.length !== 32) throw new Error(`Invalid master key file: ${keyPath}`);
    fs.chmodSync(keyPath, 0o600);
    return crypto.createHash("sha256").update(bytes).digest();
  }
  const bytes = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(keyPath, bytes.toString("base64url"), { mode: 0o600 });
  return crypto.createHash("sha256").update(bytes).digest();
}

export function isEncrypted(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(ENC_PREFIX);
}

export function encryptSecret(plain: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENC_PREFIX + [iv, tag, ciphertext].map((b) => b.toString("base64url")).join(".");
}

export function decryptSecret(stored: string, key: Buffer): string {
  if (!isEncrypted(stored)) return stored;
  const body = stored.slice(ENC_PREFIX.length);
  const parts = body.split(".");
  if (parts.length !== 3) throw new Error("Malformed enc:v1 payload");
  const [iv, tag, ciphertext] = parts.map((p) => Buffer.from(p, "base64url"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
