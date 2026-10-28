import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { decryptString, encryptJson } from "./crypto.js";
import { defaultProtocol } from "./platforms.js";
import { SCHEMA_V3 } from "./schema.js";
import { SQL_NOW } from "./time.js";

type Log = (msg: string) => void;
type R = Record<string, unknown>;

// Tables that existed before v3 (Auth v2 + Billing v2). On upgrade they are
// renamed to legacy_v2_* (kept, never deleted) and their data copied over.
const LEGACY_TABLES = [
  "auth_keys",
  "sessions",
  "wallets",
  "transactions",
  "usage_logs",
  "provider_nodes",
  "provider_bind_codes",
  "provider_credentials",
  "groups",
  "accounts",
  "account_groups",
  "redeem_codes",
  "usage_billing_dedup",
  // Auth v1 leftovers, if any.
  "users",
  "api_keys",
];

function tableExists(d: DatabaseSync, name: string): boolean {
  return !!d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

/** Legacy "YYYY-MM-DD HH:MM:SS" -> "YYYY-MM-DDTHH:MM:SSZ" (null-safe). */
function ts(v: unknown): string | null {
  if (typeof v !== "string" || !v) return null;
  if (v.endsWith("Z")) return v;
  return v.replace(" ", "T").slice(0, 19) + "Z";
}

function migration1(d: DatabaseSync, log: Log): void {
  const isLegacy = tableExists(d, "auth_keys");
  if (isLegacy) {
    log("legacy v2 schema detected; renaming tables to legacy_v2_*");
    for (const t of LEGACY_TABLES) {
      if (tableExists(d, t) && !tableExists(d, `legacy_v2_${t}`)) {
        d.exec(`ALTER TABLE "${t}" RENAME TO "legacy_v2_${t}"`);
      }
    }
    // Indexes keep their old names after a rename; drop the ones whose names
    // collide with v3 index names.
    for (const idx of ["idx_usage_user_time"]) d.exec(`DROP INDEX IF EXISTS ${idx}`);
  }
  d.exec(SCHEMA_V3);
  if (isLegacy) migrateLegacyData(d, log);
}

function migrateLegacyData(d: DatabaseSync, log: Log): void {
  const L = (t: string) => `legacy_v2_${t}`;
  const has = (t: string) => tableExists(d, L(t));
  const rows = (sql: string) => d.prepare(sql).all() as R[];
  const ins = (sql: string, ...p: unknown[]) => d.prepare(sql).run(...(p as never[]));

  // groups
  if (has("groups")) {
    for (const g of rows(`SELECT * FROM ${L("groups")}`)) {
      if (g.id === "default") {
        ins(
          "UPDATE groups SET rate_multiplier=?, model_allowlist=?, status=?, description=COALESCE(?, description) WHERE id='default'",
          g.rate_multiplier ?? 1,
          g.model_allowlist ?? null,
          g.status ?? "active",
          g.description ?? null,
        );
        continue;
      }
      ins(
        `INSERT OR IGNORE INTO groups (id, name, description, rate_multiplier, model_allowlist, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        g.id,
        g.name,
        g.description ?? null,
        g.rate_multiplier ?? 1,
        g.model_allowlist ?? null,
        g.status ?? "active",
        ts(g.created_at) ?? new Date().toISOString().slice(0, 19) + "Z",
      );
    }
  }
  const groupIds = new Set(rows("SELECT id FROM groups").map((g) => g.id as string));

  // users (+ wallets) and legacy API keys
  const legacyKeyByUser = new Map<string, string>();
  const keys = rows(
    `SELECT k.*, ${has("wallets") ? "w.balance_usd" : "0"} AS balance_usd
     FROM ${L("auth_keys")} k ${has("wallets") ? `LEFT JOIN ${L("wallets")} w ON w.user_id = k.id` : ""}`,
  );
  for (const k of keys) {
    const role = k.role as string;
    const preview = (k.key_preview as string) ?? "";
    ins(
      `INSERT INTO users (id, role, name, login_key_hash, login_key_preview, status, balance_usd, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      k.id,
      role,
      (k.label as string) || `${role}-${preview.slice(-4)}`,
      k.key_hash,
      preview,
      k.revoked_at ? "disabled" : "active",
      Number(k.balance_usd ?? 0),
      ts(k.created_at),
    );
    if (role === "consumer" || role === "admin") {
      const keyId = randomUUID();
      legacyKeyByUser.set(k.id as string, keyId);
      const gid = typeof k.group_id === "string" && groupIds.has(k.group_id) ? k.group_id : "default";
      ins(
        `INSERT INTO api_keys (id, user_id, name, key_hash, key_enc, key_preview, group_id, status,
                               quota_usd, used_usd, created_at)
         VALUES (?, ?, 'legacy', ?, NULL, ?, ?, ?, ?, ?, ?)`,
        keyId,
        k.id,
        k.key_hash,
        `${preview}…`,
        gid,
        k.revoked_at ? "disabled" : "active",
        Number(k.quota_usd ?? 0),
        Number(k.quota_used_usd ?? 0),
        ts(k.created_at),
      );
    }
  }
  log(`migrated ${keys.length} users, ${legacyKeyByUser.size} legacy API keys`);

  if (has("sessions")) {
    d.exec(
      `INSERT OR IGNORE INTO user_sessions (token, user_id, expires_at, created_at)
       SELECT token, key_id, replace(expires_at,' ','T')||'Z', replace(created_at,' ','T')||'Z'
       FROM ${L("sessions")} WHERE key_id IN (SELECT id FROM users)`,
    );
  }

  // accounts
  const userIds = new Set(rows("SELECT id FROM users").map((u) => u.id as string));
  let accMigrated = 0;
  if (has("accounts")) {
    for (const a of rows(`SELECT * FROM ${L("accounts")}`)) {
      let secret: string;
      let refresh: string | null = null;
      try {
        secret = decryptString(String(a.credential_enc));
        if (typeof a.refresh_token === "string" && a.refresh_token) {
          refresh = decryptString(a.refresh_token);
        }
      } catch {
        log(`skip account ${String(a.id)}: credential cannot be decrypted with current master key`);
        continue;
      }
      const isNode = a.source === "node";
      const platform = String(a.vendor ?? "openai");
      const ownerId = isNode && userIds.has(String(a.provider_id)) ? String(a.provider_id) : null;
      if (isNode && !ownerId) continue;
      const credential = isNode
        ? { accessToken: secret, ...(refresh ? { refreshToken: refresh } : {}) }
        : { apiKey: secret };
      ins(
        `INSERT INTO accounts (id, name, platform, type, protocol, credential_enc, owner_id, route, node_id,
                               review_status, payout_rate, priority, status, error_message,
                               rate_limited_until, temp_unschedulable_until, account_email,
                               subscription_type, last_used_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        a.id,
        (a.label as string) || (a.account_email as string) || `${platform}-${String(a.id).slice(0, 8)}`,
        platform,
        isNode ? "oauth" : "apikey",
        defaultProtocol(platform),
        encryptJson(credential),
        ownerId,
        isNode ? "node" : "direct",
        a.node_id ?? null,
        isNode ? 0.6 : 0,
        Number(a.priority ?? 50),
        a.status === "error" ? "error" : a.status === "disabled" ? "disabled" : "active",
        a.error_message ?? null,
        ts(a.rate_limit_reset_at),
        ts(a.temp_unschedulable_until),
        a.account_email ?? null,
        a.subscription_type ?? null,
        ts(a.last_used_at),
        ts(a.created_at),
        ts(a.created_at),
      );
      accMigrated++;
    }
  }
  if (has("account_groups")) {
    d.exec(
      `INSERT OR IGNORE INTO account_groups (account_id, group_id, priority)
       SELECT account_id, group_id, priority FROM ${L("account_groups")}
       WHERE account_id IN (SELECT id FROM accounts) AND group_id IN (SELECT id FROM groups)`,
    );
  }
  log(`migrated ${accMigrated} upstream accounts`);

  // usage logs
  if (has("usage_logs")) {
    const cols = new Set(
      (d.prepare(`PRAGMA table_info(${L("usage_logs")})`).all() as R[]).map((c) => c.name as string),
    );
    let n = 0;
    for (const u of rows(`SELECT * FROM ${L("usage_logs")}`)) {
      const rate = cols.has("rate_multiplier") ? Number(u.rate_multiplier ?? 1) || 1 : 1;
      const actual = Number(u.cost_usd ?? 0);
      ins(
        `INSERT OR IGNORE INTO usage_logs (id, request_id, user_id, api_key_id, group_id, model, endpoint,
            input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
            total_cost, rate_multiplier, actual_cost, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        u.id,
        (cols.has("request_id") && u.request_id) || u.id,
        u.user_id,
        legacyKeyByUser.get(String(u.user_id)) ?? u.api_key_id,
        cols.has("group_id") ? (u.group_id ?? null) : null,
        u.model,
        u.endpoint,
        u.input_tokens ?? 0,
        u.output_tokens ?? 0,
        u.cache_read_tokens ?? 0,
        u.cache_write_tokens ?? 0,
        actual / rate,
        rate,
        actual,
        ts(u.created_at),
      );
      n++;
    }
    log(`migrated ${n} usage log rows`);
  }

  // ledger: every non-usage balance movement
  if (has("transactions")) {
    d.exec(
      `INSERT OR IGNORE INTO ledger (id, user_id, kind, amount_usd, balance_after, ref, note, created_at)
       SELECT id, user_id,
              CASE kind WHEN 'topup' THEN 'legacy_topup' ELSE kind END,
              amount_usd, 0, NULL, meta, replace(created_at,' ','T')||'Z'
       FROM ${L("transactions")}
       WHERE kind <> 'charge' AND user_id IN (SELECT id FROM users)`,
    );
  }

  if (has("redeem_codes")) {
    d.exec(
      `INSERT OR IGNORE INTO redeem_codes (code, value_usd, status, used_by, used_at, expires_at, created_at)
       SELECT code, value_usd, status,
              CASE WHEN used_by IN (SELECT id FROM users) THEN used_by END,
              CASE WHEN used_at IS NOT NULL THEN replace(used_at,' ','T')||'Z' END,
              CASE WHEN expires_at IS NOT NULL THEN replace(expires_at,' ','T')||'Z' END,
              replace(created_at,' ','T')||'Z'
       FROM ${L("redeem_codes")}`,
    );
  }

  if (has("provider_nodes")) {
    d.exec(
      `INSERT OR IGNORE INTO nodes (node_id, provider_id, secret_hash, node_version, os_type, os_arch,
                                    online, accepting_sessions, in_flight, last_heartbeat_at, created_at)
       SELECT node_id, provider_id, secret_hash, node_version, os_type, os_arch, 0, accepting_sessions, 0,
              CASE WHEN last_heartbeat_at IS NOT NULL THEN replace(last_heartbeat_at,' ','T')||'Z' END,
              replace(created_at,' ','T')||'Z'
       FROM ${L("provider_nodes")} WHERE provider_id IN (SELECT id FROM users)`,
    );
  }
  if (has("provider_bind_codes")) {
    d.exec(
      `INSERT OR IGNORE INTO node_bind_codes (code, provider_id, expires_at, used_at, created_at)
       SELECT code, provider_id, replace(expires_at,' ','T')||'Z',
              CASE WHEN used_at IS NOT NULL THEN replace(used_at,' ','T')||'Z' END,
              replace(created_at,' ','T')||'Z'
       FROM ${L("provider_bind_codes")} WHERE provider_id IN (SELECT id FROM users)`,
    );
  }
  log("legacy v2 data migration complete");
}

const MIGRATIONS: Array<{ version: number; up: (d: DatabaseSync, log: Log) => void }> = [
  { version: 1, up: migration1 },
  { version: 2, up: migration2 },
  { version: 3, up: migration3 },
  { version: 4, up: migration4 },
  { version: 5, up: migration5 },
  { version: 6, up: migration6 },
  { version: 7, up: migration7 },
  { version: 8, up: migration8 },
  { version: 9, up: migration9 },
  { version: 10, up: migration10 },
  { version: 11, up: migration11 },
  { version: 12, up: migration12 },
  { version: 13, up: migration13 },
  { version: 14, up: migration14 },
  { version: 15, up: migration15 },
  { version: 16, up: migration16 },
  { version: 17, up: migration17 },
  { version: 18, up: migration18 },
  { version: 19, up: migration19 },
  { version: 20, up: migration20 },
  { version: 21, up: migration21 },
];

// 上号员令牌（独立鉴权的上号站点 /onboard）：admin 签发，绑定目标节点；
// 上号员持 1dk_onb_… 令牌在该节点执行上号，账号落入平台池。
function migration8(d: DatabaseSync, log: Log): void {
  d.exec(`
CREATE TABLE IF NOT EXISTS onboard_tokens (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  token_preview TEXT NOT NULL,
  node_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  last_used_at TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (${SQL_NOW})
);
`);
  log("migration 8: onboard_tokens (onboarder site)");
}

// Indexes for queries added with onboarding / the admin account list
// (capacity counts by node, proxy release by bound account, job sweeps,
// session drops). Idempotent (IF NOT EXISTS).
function migration6(d: DatabaseSync, log: Log): void {
  d.exec(`
CREATE INDEX IF NOT EXISTS idx_accounts_node ON accounts(node_id);
CREATE INDEX IF NOT EXISTS idx_accounts_bound_proxy ON accounts(bound_proxy_id);
CREATE INDEX IF NOT EXISTS idx_node_proxies_bound ON node_proxies(bound_account_id);
CREATE INDEX IF NOT EXISTS idx_onboarding_jobs_status ON onboarding_jobs(status);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);
`);
  log("migration 6: indexes for node/proxy/job lookups");
}

// Account onboarding (docs/onboarding.md §5): per-account RPM cap, one-proxy-
// per-account lifetime binding, and the async onboarding job ledger.
// Idempotent: column adds are PRAGMA-checked, the table is IF NOT EXISTS.
function migration5(d: DatabaseSync, log: Log): void {
  addColumns(d, log, "accounts", [
    ["rpm_limit", "INTEGER NOT NULL DEFAULT 0"],
    ["bound_proxy_id", "TEXT REFERENCES node_proxies(id)"],
  ]);
  addColumns(d, log, "node_proxies", [["bound_account_id", "TEXT REFERENCES accounts(id)"]]);
  d.exec(`
CREATE TABLE IF NOT EXISTS onboarding_jobs (
  id TEXT PRIMARY KEY,
  requester_id TEXT,
  scope TEXT NOT NULL,
  method TEXT NOT NULL,
  node_id TEXT NOT NULL,
  proxy_id TEXT,
  params_json TEXT,
  payload_enc TEXT,
  authorize_url TEXT,
  status TEXT NOT NULL DEFAULT 'working',
  account_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (${SQL_NOW}),
  updated_at TEXT NOT NULL DEFAULT (${SQL_NOW})
);
CREATE INDEX IF NOT EXISTS idx_onboarding_jobs_requester ON onboarding_jobs(requester_id);
`);
}

// Per-window detail (5h / 7d) sampled from anthropic-ratelimit-unified-* headers
// and the usage probe, plus the human-readable pause reason.
function migration4(d: DatabaseSync, log: Log): void {
  addColumns(d, log, "accounts", [
    ["window_5h_used", "REAL"],
    ["window_5h_reset_at", "TEXT"],
    ["window_7d_used", "REAL"],
    ["window_7d_reset_at", "TEXT"],
    ["window_reason", "TEXT"],
  ]);
}

function addColumns(d: DatabaseSync, log: Log, table: string, cols: Array<[name: string, ddl: string]>): void {
  if (!tableExists(d, table)) return;
  const have = new Set((d.prepare(`PRAGMA table_info(${table})`).all() as R[]).map((c) => c.name as string));
  for (const [name, ddl] of cols) {
    if (have.has(name)) continue;
    d.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
    log(`${table}: added column ${name}`);
  }
}

// CCR (docs/ccr-supply.md §5.2, §7): account executor dimension + subscription
// window state written back by the console poller. Idempotent column adds.
function migration3(d: DatabaseSync, log: Log): void {
  addColumns(d, log, "accounts", [
    ["executor", "TEXT NOT NULL DEFAULT 'direct'"],
    ["window_used", "REAL"],
    ["window_reset_at", "TEXT"],
    ["window_checked_at", "TEXT"],
    ["window_exhausted_until", "TEXT"],
  ]);
}

// Protocol v2 (http-egress): node proxy ledger + node capacity/deploy_meta.
// Idempotent: CREATE TABLE IF NOT EXISTS + PRAGMA table_info column checks.
function migration2(d: DatabaseSync, log: Log): void {
  d.exec(`
CREATE TABLE IF NOT EXISTS node_proxies (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  url_enc TEXT NOT NULL,
  label TEXT,
  status TEXT NOT NULL DEFAULT 'unknown',
  last_check_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (${SQL_NOW})
);
CREATE INDEX IF NOT EXISTS idx_node_proxies_node ON node_proxies(node_id);
CREATE TABLE IF NOT EXISTS node_proxy_assignments (
  node_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  proxy_id TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (${SQL_NOW}),
  PRIMARY KEY (node_id, account_id)
);
`);
  if (tableExists(d, "nodes")) {
    const cols = new Set(
      (d.prepare("PRAGMA table_info(nodes)").all() as R[]).map((c) => c.name as string),
    );
    if (!cols.has("capacity")) {
      d.exec("ALTER TABLE nodes ADD COLUMN capacity INTEGER NOT NULL DEFAULT 100");
      log("nodes: added column capacity");
    }
    if (!cols.has("deploy_meta")) {
      d.exec("ALTER TABLE nodes ADD COLUMN deploy_meta TEXT");
      log("nodes: added column deploy_meta");
    }
  }
}

export function runMigrations(d: DatabaseSync, log: Log): void {
  d.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const applied = new Set(
    (d.prepare("SELECT version FROM schema_migrations").all() as R[]).map((r) => Number(r.version)),
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    // FK enforcement off while tables are renamed/rebuilt; re-enabled after.
    d.exec("PRAGMA foreign_keys = OFF");
    d.exec("BEGIN IMMEDIATE");
    try {
      // Another process may have applied it while we waited for the lock.
      const done = d.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(m.version);
      if (!done) {
        m.up(d, log);
        d.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
          m.version,
          new Date().toISOString().slice(0, 19) + "Z",
        );
        log(`applied migration ${m.version}`);
      }
      d.exec("COMMIT");
    } catch (err) {
      d.exec("ROLLBACK");
      throw err;
    } finally {
      d.exec("PRAGMA foreign_keys = ON");
    }
  }
}

// Claude Code shape verdict per usage row (docs/gateway.md §2a): 'genuine' /
// 'suspect' for CC-UA requests, NULL otherwise. Idempotent (PRAGMA-checked).
function migration7(d: DatabaseSync, log: Log): void {
  addColumns(d, log, "usage_logs", [["cc_shape", "TEXT"]]);
  d.exec("CREATE INDEX IF NOT EXISTS idx_usage_cc_shape ON usage_logs(cc_shape, created_at)");
  log("migration 7: usage_logs.cc_shape");
}

// Migration 9: per-model-family cooldowns (Fable 7d_oi window / credits_required),
// JSON per account (docs/gateway.md §3). Idempotent (PRAGMA-checked).
function migration9(d: DatabaseSync, log: Log): void {
  addColumns(d, log, "accounts", [["model_cooldowns", "TEXT"]]);
  log("migration 9: accounts.model_cooldowns");
}

// Migration 10: observability columns on usage_logs (docs/console-api.md 错误日志):
// what the upstream said, which path served it, which node. Idempotent.
function migration10(d: DatabaseSync, log: Log): void {
  addColumns(d, log, "usage_logs", [
    ["error_message", "TEXT"],
    ["mode", "TEXT"],
    ["upstream_status", "INTEGER"],
    ["node_id", "TEXT"],
  ]);
  d.exec("CREATE INDEX IF NOT EXISTS idx_usage_status_time ON usage_logs(status_code, created_at)");
  log("migration 10: usage_logs.error_message/mode/upstream_status/node_id");
}

// Migration 11: one device identity per account (docs/claude-code-compat.md §8):
// device_id = Claude Code userID the worker node holds for the account (or a
// platform-generated seed), account_uuid = upstream OAuth account uuid. Idempotent.
function migration11(d: DatabaseSync, log: Log): void {
  addColumns(d, log, "accounts", [
    ["device_id", "TEXT"],
    ["account_uuid", "TEXT"],
  ]);
  log("migration 11: accounts.device_id/account_uuid");
}

// Migration 12: node monitoring (docs/operations.md §7.2): latest heartbeat
// snapshot per node (host memory/load, worker pool, proxies, egress) as JSON.
function migration12(d: DatabaseSync, log: Log): void {
  addColumns(d, log, "nodes", [["metrics", "TEXT"]]);
  log("migration 12: nodes.metrics");
}

// Migration 13: credit billing (docs/data-model.md §4, 2026-10-19): a consumer
// runs on an admin-granted credit line; usage accrues to credit_used_usd (after
// any prepaid balance), the admin settles and the line is restored. credit_events
// is the audit trail (limit changes + settlements). Existing users keep working
// unchanged: limit 0 means "prepaid balance only" as before. Idempotent.
function migration13(d: DatabaseSync, log: Log): void {
  addColumns(d, log, "users", [
    ["credit_limit_usd", "REAL NOT NULL DEFAULT 0"],
    ["credit_used_usd", "REAL NOT NULL DEFAULT 0"],
    ["credit_settled_at", "TEXT"],
  ]);
  d.exec(`CREATE TABLE IF NOT EXISTS credit_events (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    amount_usd REAL NOT NULL,
    limit_before REAL NOT NULL,
    limit_after REAL NOT NULL,
    used_before REAL NOT NULL,
    used_after REAL NOT NULL,
    note TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  )`);
  d.exec("CREATE INDEX IF NOT EXISTS idx_credit_events_user_time ON credit_events(user_id, created_at)");
  log("migration 13: users.credit_*, credit_events");
}

// Migration 15: cache-rebuild refunds (docs/data-model.md §3 cache_refunds, 2026-10-21).
// usage_logs.account_switched = 1 marks a request whose sticky session was forced
// onto another account (gateway ForceCacheBilling), so its prompt cache was rebuilt
// at the client's expense; cache_refund_id links it to the cache_refunds row that
// paid part of that excess back (NULL = not refunded yet). Idempotent.
function migration15(d: DatabaseSync, log: Log): void {
  addColumns(d, log, "usage_logs", [
    ["account_switched", "INTEGER NOT NULL DEFAULT 0"],
    ["cache_refund_id", "TEXT"],
  ]);
  d.exec(
    "CREATE INDEX IF NOT EXISTS idx_usage_cache_refund_pending ON usage_logs(user_id, created_at) WHERE account_switched = 1 AND cache_refund_id IS NULL",
  );
  d.exec(`CREATE TABLE IF NOT EXISTS cache_refunds (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rows INTEGER NOT NULL,
    excess_usd REAL NOT NULL,
    percent INTEGER NOT NULL,
    refund_usd REAL NOT NULL,
    to_credit_usd REAL NOT NULL DEFAULT 0,
    to_balance_usd REAL NOT NULL DEFAULT 0,
    ledger_id TEXT,
    credit_event_id TEXT,
    period_from TEXT,
    period_to TEXT,
    note TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  )`);
  d.exec("CREATE INDEX IF NOT EXISTS idx_cache_refunds_user_time ON cache_refunds(user_id, created_at)");
  d.exec("CREATE INDEX IF NOT EXISTS idx_cache_refunds_time ON cache_refunds(created_at)");
  log("migration 15: usage_logs.account_switched/cache_refund_id, cache_refunds");
}

// Migration 16 (2026-10-21): affinity_bindings — the gateway's sticky-session and
// device-pool maps written through to SQLite so a blue/green release does not
// re-deal every live conversation / device to a new account (core/affinity.ts).
function migration16(d: DatabaseSync, log: Log): void {
  d.exec(`CREATE TABLE IF NOT EXISTS affinity_bindings (
    key TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    account_id TEXT,
    accounts TEXT,
    expires_at INTEGER NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (${SQL_NOW})
  )`);
  d.exec("CREATE INDEX IF NOT EXISTS idx_affinity_expires ON affinity_bindings(expires_at)");
  log("migration 16: affinity_bindings (sticky session / device pool persisted across gateway releases)");
}

// Migration 17 (2026-10-22): worker_turn_memory — the gateway's turn memory for
// persistent node worker sessions (docs/worker-sessions.md §1) written through,
// so a release no longer makes every conversation's next turn a fresh replay.
function migration17(d: DatabaseSync, log: Log): void {
  d.exec(`CREATE TABLE IF NOT EXISTS worker_turn_memory (
    key TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (${SQL_NOW})
  )`);
  d.exec("CREATE INDEX IF NOT EXISTS idx_worker_turn_expires ON worker_turn_memory(expires_at)");
  log("migration 17: worker_turn_memory (persistent worker session memory survives gateway releases)");
}

// Migration 14: proxy release cooldown (docs/onboarding.md §1 原则 3, 2026-10-20):
// a proxy freed by deleting an account Anthropic had rejected (status error:
// 401 revoked, on hold, …) must not be handed to a new account for a while.
function migration14(d: DatabaseSync, log: Log): void {
  addColumns(d, log, "node_proxies", [
    ["cooldown_until", "TEXT"],
    ["cooldown_reason", "TEXT"],
  ]);
  log("migration 14: node_proxies.cooldown_until/cooldown_reason");
}

// Migration 18 (2026-10-22): oauth_refresh_locks — one OAuth refresh per account at a
// time across processes (console keep-alive, gateway 401 retry). Anthropic rotates the
// refresh token on every refresh; a second refresh with the old one revokes the grant.
function migration18(d: DatabaseSync, log: Log): void {
  d.exec(`CREATE TABLE IF NOT EXISTS oauth_refresh_locks (
    account_id TEXT PRIMARY KEY,
    locked_until TEXT NOT NULL
  )`);
  log("migration 18: oauth_refresh_locks (cross-process OAuth refresh lock)");
}

// Migration 19 (2026-10-23): accounts.raw_passthrough — a relay account (官Key 分组,
// api-key.xyz) that receives the client's request verbatim: no Claude Code UA/version
// normalisation, no fingerprint headers, no device-identity pinning, no beta injection.
function migration19(d: DatabaseSync, log: Log): void {
  addColumns(d, log, "accounts", [["raw_passthrough", "INTEGER NOT NULL DEFAULT 0"]]);
  log("migration 19: accounts.raw_passthrough");
}

// Migration 20 (2026-10-26): users.onboard_group_id — a provider's self-onboarded accounts are
// approved on the spot (no admin review, user rule 2026-10-26) and join this group (NULL = the
// settings default group).
function migration20(d: DatabaseSync, log: Log): void {
  addColumns(d, log, "users", [["onboard_group_id", "TEXT REFERENCES groups(id)"]]);
  log("migration 20: users.onboard_group_id");
}

// Additive only: legacy credentials, bindings, conversations and financial rows
// are intentionally neither inferred nor rewritten by this migration.
function migration21(d: DatabaseSync, log: Log): void {
  d.exec(`CREATE TABLE IF NOT EXISTS upstream_teams (
    id TEXT PRIMARY KEY, name TEXT, status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (${SQL_NOW})
  )`);
  addColumns(d, log, "accounts", [["team_id", "TEXT REFERENCES upstream_teams(id)"]]);
  addColumns(d, log, "node_proxies", [
    ["team_id", "TEXT REFERENCES upstream_teams(id)"],
    ["isolation_version", "INTEGER NOT NULL DEFAULT 0"],
    ["exit_ip", "TEXT"], ["resource_key", "TEXT"],
  ]);
  addColumns(d, log, "onboarding_jobs", [
    ["team_id", "TEXT"], ["isolation_version", "INTEGER NOT NULL DEFAULT 0"],
    ["egress_started_at", "TEXT"], ["proxy_resource_key", "TEXT"],
    ["reservation_account_id", "TEXT"],
  ]);
  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_accounts_team ON accounts(team_id);
    CREATE INDEX IF NOT EXISTS idx_proxy_resource ON node_proxies(resource_key);
    CREATE INDEX IF NOT EXISTS idx_onboarding_resource ON onboarding_jobs(proxy_resource_key,status);
    CREATE TABLE IF NOT EXISTS proxy_team_claims (
      resource_key TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES upstream_teams(id),
      claimed_at TEXT NOT NULL DEFAULT (${SQL_NOW})
    );
    CREATE TABLE IF NOT EXISTS proxy_quarantine (
      resource_key TEXT PRIMARY KEY, reason TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (${SQL_NOW})
    );
    CREATE TABLE IF NOT EXISTS proxy_team_events (
      id TEXT PRIMARY KEY, resource_key TEXT NOT NULL, proxy_id TEXT, node_id TEXT,
      team_id TEXT, account_id TEXT, job_id TEXT, event TEXT NOT NULL, actor_id TEXT, reason TEXT,
      created_at TEXT NOT NULL DEFAULT (${SQL_NOW})
    );
    CREATE INDEX IF NOT EXISTS idx_proxy_team_events_resource ON proxy_team_events(resource_key,created_at);
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY, api_key_id TEXT NOT NULL, external_key TEXT NOT NULL,
      generation INTEGER NOT NULL DEFAULT 1, team_id TEXT, reset_anchor TEXT,
      reset_prefix TEXT, reset_active INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'active', lease_token TEXT,
      lease_until INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, UNIQUE(api_key_id,external_key)
    );
    CREATE INDEX IF NOT EXISTS idx_conversations_key_time ON conversations(api_key_id,updated_at);
    CREATE TABLE IF NOT EXISTS conversation_generations (
      conversation_id TEXT NOT NULL REFERENCES conversations(id), generation INTEGER NOT NULL,
      team_id TEXT, reset_reason TEXT, created_at TEXT NOT NULL,
      PRIMARY KEY(conversation_id,generation)
    );
    CREATE TABLE IF NOT EXISTS conversation_boundaries (
      conversation_id TEXT NOT NULL REFERENCES conversations(id),generation INTEGER NOT NULL,
      branch_key TEXT NOT NULL,anchor TEXT,prefix TEXT,nonce TEXT NOT NULL,
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
      PRIMARY KEY(conversation_id,generation,branch_key)
    );
  `);
  for (const table of ["proxy_team_claims", "proxy_quarantine", "proxy_team_events"]) {
    d.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table}
      BEGIN SELECT RAISE(ABORT, 'isolation history is append-only'); END`);
    d.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table}
      BEGIN SELECT RAISE(ABORT, 'isolation history is append-only'); END`);
  }
  log("migration 21: additive organization isolation, proxy history and conversation generations; no legacy backfill");
}
