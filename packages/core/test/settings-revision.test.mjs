import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "1dayapi-settings-revision-"));
process.env.DATA_DIR = dir;
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
const {
  one, run, encryptJson, nowIso,
  settingsRevision, updateSettings, SettingsRevisionConflict,
} = await import("../dist/index.js");

test("migration 32 and settings revisions are atomic and reject stale writes", () => {
  assert.ok(one("SELECT 1 AS ok FROM schema_migrations WHERE version = 32")?.ok);
  const initial = settingsRevision();
  const next = updateSettings({ announcement: "first", provider_default_payout_rate: "0.65" }, initial);
  assert.equal(next, initial + 1);
  assert.equal(settingsRevision(), next);
  assert.throws(() => updateSettings({ announcement: "stale" }, initial), SettingsRevisionConflict);
  assert.equal(one("SELECT value FROM settings WHERE key = 'announcement'").value, "first");
  assert.equal(one("SELECT value FROM settings WHERE key = 'provider_default_payout_rate'").value, "0.65");
  assert.throws(() => updateSettings({ announcement: "stale again" }, initial), (err) => err instanceof SettingsRevisionConflict && err.actual === next);
});

test("every credential rewrite advances its version and invalidates old readiness proofs", () => {
  run("INSERT INTO accounts (id,name,platform,type,protocol,credential_enc,status,review_status,last_profile_at,last_refresh_at,last_inference_at,created_at,updated_at) VALUES ('credential-test','credential-test','anthropic','oauth','anthropic',?,'active','approved',?,?,?, ?, ?)",
    encryptJson({ accessToken: "old" }), nowIso(), nowIso(), nowIso(), nowIso(), nowIso());
  assert.equal(one("SELECT credential_version FROM accounts WHERE id = 'credential-test'").credential_version, 1);
  run("UPDATE accounts SET credential_enc = ? WHERE id = 'credential-test'", encryptJson({ accessToken: "new" }));
  const row = one("SELECT credential_version,last_profile_at,last_refresh_at,last_inference_at FROM accounts WHERE id = 'credential-test'");
  assert.equal(row.credential_version, 2);
  assert.equal(row.last_profile_at, null);
  assert.equal(row.last_refresh_at, null);
  assert.equal(row.last_inference_at, null);
  run("UPDATE accounts SET last_refresh_at = ? WHERE id = 'credential-test'", nowIso());
  run("UPDATE accounts SET credential_enc = credential_enc WHERE id = 'credential-test'");
  assert.equal(one("SELECT credential_version FROM accounts WHERE id = 'credential-test'").credential_version, 2, "a byte-identical write is not a new credential");
});

test("key policy: teamAffinity parses spread | pack, anything else is null (2026-11-01)", async () => {
  const { parseKeyPolicy, DEFAULT_KEY_POLICY } = await import("../dist/key-policy.js");
  assert.equal(DEFAULT_KEY_POLICY.teamAffinity, null);
  assert.equal(parseKeyPolicy(JSON.stringify({ teamAffinity: "spread" })).teamAffinity, "spread");
  assert.equal(parseKeyPolicy(JSON.stringify({ teamAffinity: "pack" })).teamAffinity, "pack");
  assert.equal(parseKeyPolicy(JSON.stringify({ teamAffinity: "nope" })).teamAffinity, null);
  assert.equal(parseKeyPolicy(JSON.stringify({ historyPolicy: "reset" })).teamAffinity, null);
});
