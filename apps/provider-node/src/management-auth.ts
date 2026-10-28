import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveConfigPath } from "./config.js";

export function managementTokenPath(configPath = resolveConfigPath()): string {
  return process.env.PROVIDER_MANAGEMENT_TOKEN_FILE ?? path.join(path.dirname(configPath), "management.token");
}

/** An independent local administrator credential; never returned by a public endpoint. */
export function managementToken(configPath = resolveConfigPath()): string {
  const file = managementTokenPath(configPath);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try { fs.writeFileSync(file, crypto.randomBytes(32).toString("base64url") + "\n", { mode: 0o600, flag: "wx" }); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; }
  fs.chmodSync(file, 0o600);
  const token = fs.readFileSync(file, "utf8").trim();
  if (token.length < 32) throw new Error("Invalid local management credential");
  return token;
}

export function validManagementToken(candidate: unknown, expected: string): boolean {
  if (typeof candidate !== "string") return false;
  const value = candidate.replace(/^Bearer\s+/i, "");
  const a = Buffer.from(value), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
