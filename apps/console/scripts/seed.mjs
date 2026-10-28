#!/usr/bin/env node
// v3 dev seed (docs/v3-design.md): one admin, one demo consumer ($50, one
// API key), one demo provider, and two mock upstream accounts pointing at
// apps/gateway/scripts/mock-upstream.mjs. Plaintext keys are written once to
// data/seed-keys.txt (0600); stdout only shows previews, so a seed run captured
// in journald / CI output never leaks a usable key (issue A-5 follow-up).
//
//   node scripts/seed.mjs [--mock http://127.0.0.1:19001]
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyLedger,
  dataDir,
  encryptJson,
  encryptString,
  generateApiKey,
  generateLoginKey,
  newId,
  nowIso,
  one,
  run,
  tx,
} from "@1dayapi/core";

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const mock = arg("mock", "http://127.0.0.1:19001").replace(/\/+$/, "");

function user(role, name) {
  const k = generateLoginKey(role);
  const id = newId();
  run(
    "INSERT INTO users (id, role, name, login_key_hash, login_key_preview, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    id, role, name, k.hash, k.preview, nowIso(),
  );
  return { id, loginKey: k.plaintext };
}

function account(name, platform, protocol, baseUrl) {
  const id = newId();
  run(
    `INSERT INTO accounts (id, name, platform, type, protocol, base_url, credential_enc, created_at, updated_at)
     VALUES (?, ?, ?, 'apikey', ?, ?, ?, ?, ?)`,
    id, name, platform, protocol, baseUrl, encryptJson({ apiKey: "mock" }), nowIso(), nowIso(),
  );
  run("INSERT INTO account_groups (account_id, group_id, priority) VALUES (?, 'default', 50)", id);
  return id;
}

const out = tx(() => {
  const admin = user("admin", "seed-admin");
  const consumer = user("consumer", "demo-consumer");
  applyLedger(consumer.id, "admin_adjust", 50, { note: "seed" });
  const k = generateApiKey();
  run(
    `INSERT INTO api_keys (id, user_id, name, key_hash, key_enc, key_preview, group_id, created_at)
     VALUES (?, ?, 'demo', ?, ?, ?, 'default', ?)`,
    newId(), consumer.id, k.hash, encryptString(k.plaintext), k.preview, nowIso(),
  );
  const provider = user("provider", "demo-provider");
  const ops = user("ops", "demo-ops");
  if (!one("SELECT 1 FROM accounts WHERE name = 'mock-anthropic'")) account("mock-anthropic", "anthropic", "anthropic", mock);
  if (!one("SELECT 1 FROM accounts WHERE name = 'mock-openai'")) account("mock-openai", "openai", "openai", `${mock}/v1`);
  return { admin, consumer, provider, ops, apiKey: k.plaintext };
});

const keyFile = join(dataDir, "seed-keys.txt");
writeFileSync(
  keyFile,
  [
    `admin    login key : ${out.admin.loginKey}`,
    `consumer login key : ${out.consumer.loginKey} (balance $50)`,
    `consumer API key   : ${out.apiKey}`,
    `provider login key : ${out.provider.loginKey}`,
    `ops      login key : ${out.ops.loginKey}`,
    "",
  ].join("\n"),
  { mode: 0o600 },
);
chmodSync(keyFile, 0o600);
// SEED_PRINT_KEYS=1 (the e2e runner, which parses stdout into a temp file) prints the plaintext.
const preview = (k) => (process.env.SEED_PRINT_KEYS === "1" ? k : `${k.slice(0, 16)}…`);
console.log("admin    login key :", preview(out.admin.loginKey));
console.log("consumer login key :", preview(out.consumer.loginKey), "(balance $50)");
console.log("consumer API key   :", preview(out.apiKey));
console.log("provider login key :", preview(out.provider.loginKey));
console.log("ops      login key :", preview(out.ops.loginKey));
console.log(`plaintext keys     : ${keyFile} (0600)`);
console.log(`mock accounts      : ${mock} (anthropic) / ${mock}/v1 (openai) in group 'default'`);
