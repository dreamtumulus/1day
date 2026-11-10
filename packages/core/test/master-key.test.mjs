// Master key guard (crypto.ts): the key file is never regenerated on top of existing ciphertexts, and
// verifyMasterKey() refuses a key that does not match the database. The key is loaded at import time, so every
// scenario runs in its own child process against a shared temp DATA_DIR.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const CORE = fileURLToPath(new URL("../dist/index.js", import.meta.url));

function freshDir() {
  const dir = mkdtempSync(join(tmpdir(), "1dayapi-master-key-"));
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Import core in a child with DATA_DIR=dir, then run `body` (an async function body receiving `core`). */
function child(dir, body, env = {}) {
  const script = `const core = await import(${JSON.stringify(CORE)});\n${body}`;
  const base = { ...process.env, DATA_DIR: dir, ...env };
  for (const k of ["DB_PATH", "PROVIDER_CRED_KEY", "INTERNAL_TOKEN", "ALLOW_NEW_MASTER_KEY"]) if (!(k in env)) delete base[k];
  const r = spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", script], { env: base, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const INSERT_ACCOUNT = `core.run("INSERT INTO accounts (id,name,platform,type,protocol,credential_enc,created_at,updated_at) VALUES ('mk-test','mk-test','anthropic','apikey','anthropic',?,?,?)", core.encryptJson({ apiKey: "secret" }), core.nowIso(), core.nowIso());`;

test("missing key + no database: key is created, check value recorded, then verified", () => {
  const dir = freshDir();
  const first = child(dir, `console.log("RESULT " + core.verifyMasterKey());`);
  assert.equal(first.code, 0, first.err);
  assert.match(first.out, /RESULT created/);
  assert.ok(existsSync(join(dir, "provider-cred.key")));
  const key = readFileSync(join(dir, "provider-cred.key"), "utf8");
  const second = child(dir, `console.log("RESULT " + core.verifyMasterKey());`);
  assert.equal(second.code, 0, second.err);
  assert.match(second.out, /RESULT verified/);
  assert.equal(readFileSync(join(dir, "provider-cred.key"), "utf8"), key, "an existing key is never rewritten");
});

test("missing key + database without encrypted rows: key is created", () => {
  const dir = freshDir();
  assert.equal(child(dir, "").code, 0);
  rmSync(join(dir, "provider-cred.key"));
  const r = child(dir, `console.log("RESULT " + core.verifyMasterKey());`);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /RESULT created/);
  assert.ok(existsSync(join(dir, "provider-cred.key")));
});

test("missing key + encrypted rows: refuses to start and names the expected path", () => {
  const dir = freshDir();
  const seed = child(dir, `${INSERT_ACCOUNT} core.verifyMasterKey();`);
  assert.equal(seed.code, 0, seed.err);
  const keyPath = join(dir, "provider-cred.key");
  rmSync(keyPath);

  const refused = child(dir, `console.log("STARTED");`);
  assert.notEqual(refused.code, 0);
  assert.doesNotMatch(refused.out, /STARTED/);
  assert.match(refused.err, /MasterKeyError/);
  assert.ok(refused.err.includes(keyPath), refused.err);
  assert.match(refused.err, /accounts\.credential_enc \(1 rows\)/);
  assert.ok(!existsSync(keyPath), "no key file is written when startup is refused");

  // The operator's explicit override generates a new key; the check value still refuses until it is replaced too.
  const forced = child(dir, `console.log("RESULT " + core.verifyMasterKey());`, { ALLOW_NEW_MASTER_KEY: "1" });
  assert.equal(forced.code, 0, forced.err);
  assert.match(forced.out, /RESULT replaced/);
  assert.ok(existsSync(keyPath));
  const after = child(dir, `console.log("RESULT " + core.verifyMasterKey());`);
  assert.match(after.out, /RESULT verified/);
});

test("PROVIDER_CRED_KEY from the environment needs no key file", () => {
  const dir = freshDir();
  const seed = child(dir, `${INSERT_ACCOUNT} console.log("RESULT " + core.verifyMasterKey());`, { PROVIDER_CRED_KEY: "env-key-material" });
  assert.equal(seed.code, 0, seed.err);
  assert.match(seed.out, /RESULT created/);
  assert.ok(!existsSync(join(dir, "provider-cred.key")));
  const wrong = child(dir, `core.verifyMasterKey();`, { PROVIDER_CRED_KEY: "another-key" });
  assert.notEqual(wrong.code, 0);
  assert.match(wrong.err, /master key mismatch/);
});

test("wrong key: verifyMasterKey refuses on the check value", () => {
  const dir = freshDir();
  const seed = child(dir, `${INSERT_ACCOUNT} core.verifyMasterKey();`);
  assert.equal(seed.code, 0, seed.err);
  writeFileSync(join(dir, "provider-cred.key"), "a-different-key-generation", { mode: 0o600 });
  const r = child(dir, `core.verifyMasterKey(); console.log("STARTED");`);
  assert.notEqual(r.code, 0);
  assert.doesNotMatch(r.out, /STARTED/);
  assert.match(r.err, /master key mismatch/);
  assert.match(r.err, /__master_key_check__/);
  assert.ok(r.err.includes(join(dir, "1dayapi.db")), r.err);
});

test("wrong key on a database that has no check value yet: not recorded as the reference", () => {
  const dir = freshDir();
  // Existing production database: encrypted rows, but written before the check value existed.
  const seed = child(dir, INSERT_ACCOUNT);
  assert.equal(seed.code, 0, seed.err);
  const good = readFileSync(join(dir, "provider-cred.key"), "utf8");
  writeFileSync(join(dir, "provider-cred.key"), "a-different-key-generation", { mode: 0o600 });
  const r = child(dir, `core.verifyMasterKey(); console.log("STARTED");`);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /decrypts none of the 1 most recent accounts\.credential_enc/);
  const none = child(dir, `console.log("ROW " + JSON.stringify(core.one("SELECT value FROM settings WHERE key = '__master_key_check__'") ?? null));`);
  assert.match(none.out, /ROW null/);
  // With the right key back, the first start records the check value.
  writeFileSync(join(dir, "provider-cred.key"), good, { mode: 0o600 });
  const ok = child(dir, `console.log("RESULT " + core.verifyMasterKey());`);
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /RESULT created/);
});

test("the check value is not a visible setting", () => {
  const dir = freshDir();
  const r = child(dir, `core.verifyMasterKey(); console.log("KEYS " + Object.keys(core.getSettings()).includes("__master_key_check__"));`);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /KEYS false/);
});
