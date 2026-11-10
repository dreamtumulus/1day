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
import { DatabaseSync } from "node:sqlite";
import { dataDir, dbPath } from "./paths.js";

const ENC_PREFIX = "enc:v1:";

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function newId(): string {
  return randomUUID();
}

/** Thrown at startup when the master key is missing / wrong for this database. */
export class MasterKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MasterKeyError";
  }
}

const allowNewMasterKey = (): boolean => process.env.ALLOW_NEW_MASTER_KEY === "1";
const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** Every `*_enc` column (accounts.credential_enc, api_keys.key_enc, node_proxies.url_enc, …) of an open database. */
function encryptedColumns(d: DatabaseSync): { table: string; column: string }[] {
  const out: { table: string; column: string }[] = [];
  const tables = d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
  for (const t of tables) {
    for (const c of d.prepare(`PRAGMA table_info(${quoteIdent(t.name)})`).all() as { name: string }[]) {
      if (/_enc$/.test(c.name)) out.push({ table: t.name, column: c.name });
    }
  }
  return out;
}

/**
 * The `*_enc` columns of the database at dbPath that hold at least one enc:v1: value, as "table.column (n rows)".
 * Opens its own read-only handle: crypto.ts is imported before (and by) db.ts, so the shared handle is not there
 * yet. A missing database file, or one without tables, has no encrypted rows.
 */
function encryptedRowsInDatabase(): string[] {
  if (!existsSync(dbPath)) return [];
  const found: string[] = [];
  const d = new DatabaseSync(dbPath, { readOnly: true });
  try {
    d.exec("PRAGMA busy_timeout = 5000;");
    for (const { table, column } of encryptedColumns(d)) {
      const row = d.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)} WHERE ${quoteIdent(column)} LIKE ?`).get(`${ENC_PREFIX}%`) as { n: number };
      if (Number(row.n) > 0) found.push(`${table}.${column} (${row.n} rows)`);
    }
  } finally {
    d.close();
  }
  return found;
}

/** Write a fresh random secret (0600) unless another process got there first; returns what the file holds. */
function createSecretFile(path: string): string {
  const raw = randomBytes(32).toString("base64url");
  try {
    writeFileSync(path, raw, { mode: 0o600, flag: "wx" });
    chmodSync(path, 0o600);
    return raw;
  } catch (err) {
    // gateway and console start together: the loser of the race reads the winner's file.
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return readFileSync(path, "utf8").trim();
    throw err;
  }
}

/**
 * Master key material from data/provider-cred.key. A missing file is created only when nothing in the database
 * is encrypted yet (first start) or when ALLOW_NEW_MASTER_KEY=1: a second key generation on top of existing
 * ciphertexts (wrong DATA_DIR, restore without the key file) would leave every stored credential undecryptable
 * with no error anywhere, so that case refuses to start instead.
 */
function loadMasterKeyMaterial(): string {
  const path = join(dataDir, "provider-cred.key");
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  const encrypted = encryptedRowsInDatabase();
  if (encrypted.length && !allowNewMasterKey()) {
    throw new MasterKeyError(
      `master key file is missing: expected ${path} (DATA_DIR=${dataDir}), but the database ${dbPath} already holds ` +
        `encrypted values in ${encrypted.join(", ")}. Refusing to generate a new key: it could not decrypt them. ` +
        `Check DATA_DIR / restore provider-cred.key from the key backup, or set PROVIDER_CRED_KEY. ` +
        `Only if those values are to be abandoned on purpose, start once with ALLOW_NEW_MASTER_KEY=1.`,
    );
  }
  if (encrypted.length) {
    console.error(`[core/crypto] ALLOW_NEW_MASTER_KEY=1: generating a NEW master key at ${path}; existing ciphertexts in ${encrypted.join(", ")} will NOT decrypt`);
  } else {
    console.log(`[core/crypto] no master key and no encrypted rows: generating ${path} (back it up separately from the database)`);
  }
  return createSecretFile(path);
}

/** Internal token from data/internal.key. Losing it costs nothing durable, so it is recreated, but never silently. */
function loadInternalToken(): string {
  const path = join(dataDir, "internal.key");
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  if (existsSync(dbPath)) {
    console.error(`[core/crypto] internal token file ${path} is missing next to an existing database: generating a new one (gateway and console must both be restarted to share it)`);
  }
  return createSecretFile(path);
}

// Master key: PROVIDER_CRED_KEY env, else data/provider-cred.key. Same
// derivation as v2 (sha256 of the material) so existing ciphertexts decrypt.
const masterKey = createHash("sha256")
  .update(process.env.PROVIDER_CRED_KEY ?? loadMasterKeyMaterial(), "utf8")
  .digest();

// ---------- master key check value ----------

const KEY_CHECK_SETTING = "__master_key_check__";
const KEY_CHECK_PLAINTEXT = "1dayapi-master-key-check-v1";
/** Rows sampled per encrypted column before the first check value is written. */
const KEY_CHECK_SAMPLE = 20;

export type MasterKeyCheck = "verified" | "created" | "replaced";

function decrypts(stored: string): boolean {
  try {
    decryptString(stored);
    return true;
  } catch {
    return false;
  }
}

/**
 * Startup check, called once by each service after the database is open (gateway / console entry points):
 * decrypts the stored check value (settings.__master_key_check__ = encryption of a fixed string) with the key
 * this process loaded. A mismatch means the key file and the database belong to different generations and the
 * service must not run: it throws MasterKeyError naming both.
 *
 * First start with this check on an existing database: before the check value is written, a sample of the stored
 * ciphertexts must decrypt with the current key, so a wrong key is never recorded as the reference.
 * ALLOW_NEW_MASTER_KEY=1 replaces a mismatching check value (deliberate new key; old ciphertexts are abandoned).
 */
export function verifyMasterKey(): MasterKeyCheck {
  const keySource = process.env.PROVIDER_CRED_KEY ? "PROVIDER_CRED_KEY (env)" : join(dataDir, "provider-cred.key");
  const d = new DatabaseSync(dbPath);
  try {
    d.exec("PRAGMA busy_timeout = 5000;");
    if (!d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'settings'").get()) {
      throw new MasterKeyError(`verifyMasterKey: ${dbPath} has no settings table; call it after the database has been opened and migrated`);
    }
    const read = (): string | undefined =>
      (d.prepare("SELECT value FROM settings WHERE key = ?").get(KEY_CHECK_SETTING) as { value: string } | undefined)?.value;
    const matches = (stored: string): boolean => {
      try {
        return decryptString(stored) === KEY_CHECK_PLAINTEXT;
      } catch {
        return false;
      }
    };
    const stored = read();
    if (stored !== undefined) {
      if (matches(stored)) return "verified";
      if (!allowNewMasterKey()) {
        throw new MasterKeyError(
          `master key mismatch: the key from ${keySource} does not decrypt the check value stored in ${dbPath} ` +
            `(settings.${KEY_CHECK_SETTING}). This database was written with a different provider-cred.key, so its ` +
            `stored credentials would be undecryptable. Refusing to start. Check DATA_DIR (${dataDir}) and restore the ` +
            `matching key file from the key backup.`,
        );
      }
      console.error(`[core/crypto] ALLOW_NEW_MASTER_KEY=1: replacing the master key check value in ${dbPath}; ciphertexts written with the previous key are abandoned`);
      d.prepare("UPDATE settings SET value = ? WHERE key = ?").run(encryptString(KEY_CHECK_PLAINTEXT), KEY_CHECK_SETTING);
      return "replaced";
    }
    // No check value yet: do not record a key that cannot read what is already stored.
    if (!allowNewMasterKey()) {
      for (const { table, column } of encryptedColumns(d)) {
        const rows = d
          .prepare(`SELECT ${quoteIdent(column)} AS v FROM ${quoteIdent(table)} WHERE ${quoteIdent(column)} LIKE ? ORDER BY rowid DESC LIMIT ${KEY_CHECK_SAMPLE}`)
          .all(`${ENC_PREFIX}%`) as { v: string }[];
        if (!rows.length) continue;
        const readable = rows.filter((r) => decrypts(r.v)).length;
        if (readable === 0) {
          throw new MasterKeyError(
            `master key mismatch: the key from ${keySource} decrypts none of the ${rows.length} most recent ` +
              `${table}.${column} values in ${dbPath}. Refusing to start and to record this key as the reference. ` +
              `Check DATA_DIR (${dataDir}) and restore the matching provider-cred.key from the key backup.`,
          );
        }
        if (readable < rows.length) {
          console.error(`[core/crypto] warning: ${rows.length - readable} of the ${rows.length} most recent ${table}.${column} values do not decrypt with the current master key`);
        }
      }
    }
    d.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING").run(KEY_CHECK_SETTING, encryptString(KEY_CHECK_PLAINTEXT));
    // gateway and console start together: whoever lost the insert must still agree with the stored value.
    const now = read();
    if (now === undefined || !matches(now)) {
      throw new MasterKeyError(`master key mismatch: another process stored a check value in ${dbPath} that the key from ${keySource} does not decrypt; the services are not using the same key`);
    }
    console.log(`[core/crypto] master key check value recorded in ${dbPath} (settings.${KEY_CHECK_SETTING})`);
    return "created";
  } finally {
    d.close();
  }
}

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

export const internalToken = process.env.INTERNAL_TOKEN ?? loadInternalToken();
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
