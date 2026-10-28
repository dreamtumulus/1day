#!/usr/bin/env node
// Ops CLI: create a user and print its login key once (no self-registration in v3).
//   node scripts/issue-key.mjs --role provider --name "张三"
//   node scripts/issue-key.mjs --role ops --name "账号管理员"   (账号池监控 + 补授权)
//   node scripts/issue-key.mjs --reset <userId>        # rotate a user's login key
import { generateLoginKey, newId, nowIso, one, run } from "@1dayapi/core";

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const reset = arg("reset", "");
if (reset) {
  const u = one("SELECT role FROM users WHERE id = ?", reset);
  if (!u) {
    console.error("user not found");
    process.exit(1);
  }
  const k = generateLoginKey(u.role);
  run("UPDATE users SET login_key_hash = ?, login_key_preview = ? WHERE id = ?", k.hash, k.preview, reset);
  run("DELETE FROM user_sessions WHERE user_id = ?", reset);
  console.log(k.plaintext);
  process.exit(0);
}

const role = arg("role", "");
const name = arg("name", arg("label", ""));
if (!["admin", "consumer", "provider", "ops"].includes(role) || !name) {
  console.error('usage: node scripts/issue-key.mjs --role admin|consumer|provider|ops --name "<name>"');
  process.exit(1);
}
const k = generateLoginKey(role);
const id = newId();
run(
  "INSERT INTO users (id, role, name, login_key_hash, login_key_preview, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  id, role, name, k.hash, k.preview, nowIso(),
);
console.log(`user ${id} (${role}) login key:`);
console.log(k.plaintext);
