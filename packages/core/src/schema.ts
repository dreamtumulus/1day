import { SQL_NOW } from "./time.js";

// v3 schema (docs/v3-design.md §3). Applied by migration 1.
export const SCHEMA_V3 = `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  name TEXT NOT NULL,
  login_key_hash TEXT UNIQUE NOT NULL,
  login_key_preview TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  balance_usd REAL NOT NULL DEFAULT 0,
  credit_limit_usd REAL NOT NULL DEFAULT 0,
  credit_used_usd REAL NOT NULL DEFAULT 0,
  credit_settled_at TEXT,
  note TEXT,
  last_login_at TEXT,
  -- migration 20 (docs/onboarding.md §1 原则 5, 2026-10-26): provider role — the group its
  -- self-onboarded accounts join immediately (NULL = settings default_group_id).
  onboard_group_id TEXT REFERENCES groups(id),
  created_at TEXT NOT NULL DEFAULT (${SQL_NOW})
);

CREATE TABLE user_sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (${SQL_NOW})
);

CREATE TABLE groups (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  description TEXT,
  rate_multiplier REAL NOT NULL DEFAULT 1.0,
  model_allowlist TEXT,
  is_exclusive INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (${SQL_NOW})
);

CREATE TABLE user_allowed_groups (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, group_id)
);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key_hash TEXT UNIQUE NOT NULL,
  key_enc TEXT,
  key_preview TEXT NOT NULL,
  group_id TEXT NOT NULL REFERENCES groups(id),
  status TEXT NOT NULL DEFAULT 'active',
  quota_usd REAL NOT NULL DEFAULT 0,
  used_usd REAL NOT NULL DEFAULT 0,
  expires_at TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (${SQL_NOW})
);
CREATE INDEX idx_api_keys_user ON api_keys(user_id);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  type TEXT NOT NULL,
  protocol TEXT NOT NULL,
  base_url TEXT,
  credential_enc TEXT NOT NULL,
  -- migration 32: monotonically increasing whenever credential_enc changes
  credential_version INTEGER NOT NULL DEFAULT 1,
  models TEXT,
  model_mapping TEXT,
  owner_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  route TEXT NOT NULL DEFAULT 'direct',
  node_id TEXT,
  review_status TEXT NOT NULL DEFAULT 'approved',
  review_note TEXT,
  payout_rate REAL NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 50,
  concurrency INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  error_message TEXT,
  rate_limited_until TEXT,
  overload_until TEXT,
  temp_unschedulable_until TEXT,
  -- migration 31 (docs/gateway.md §8): token-endpoint 429 back-off; no refresh before it ends
  refresh_cooldown_until TEXT,
  account_email TEXT,
  subscription_type TEXT,
  last_used_at TEXT,
  -- migration 32: last successful profile / token refresh / minimal inference checks
  last_profile_at TEXT,
  last_refresh_at TEXT,
  last_inference_at TEXT,
  -- migration 33 (operator rule 2026-11-01): status 'proxy_down' bookkeeping — frozen since / why / which proxy
  proxy_down_since TEXT,
  proxy_down_reason TEXT,
  proxy_down_proxy_id TEXT,
  -- CCR (docs/ccr-supply.md §5.2/§7): executor + subscription window state
  executor TEXT NOT NULL DEFAULT 'direct',
  window_used REAL,
  window_reset_at TEXT,
  window_checked_at TEXT,
  window_exhausted_until TEXT,
  -- migration 4: per-window detail + pause reason (passive sampling, sub2api-style)
  window_5h_used REAL,
  window_5h_reset_at TEXT,
  window_7d_used REAL,
  window_7d_reset_at TEXT,
  window_reason TEXT,
  model_cooldowns TEXT,
  -- migration 5 (docs/onboarding.md §5): per-account RPM cap (0 = unlimited)
  -- and the one-proxy-per-account lifetime binding.
  rpm_limit INTEGER NOT NULL DEFAULT 0,
  -- migration 19: forward the client's request as-is (headers, body, query) to a third-party relay.
  raw_passthrough INTEGER NOT NULL DEFAULT 0,
  bound_proxy_id TEXT REFERENCES node_proxies(id),
  created_at TEXT NOT NULL DEFAULT (${SQL_NOW}),
  updated_at TEXT NOT NULL DEFAULT (${SQL_NOW})
);
CREATE INDEX idx_accounts_owner ON accounts(owner_id);

CREATE TABLE account_groups (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  priority INTEGER NOT NULL DEFAULT 50,
  PRIMARY KEY (account_id, group_id)
);

CREATE TABLE model_prices (
  model_id TEXT PRIMARY KEY,
  display_name TEXT,
  platform TEXT NOT NULL,
  input_per_m REAL NOT NULL DEFAULT 0,
  output_per_m REAL NOT NULL DEFAULT 0,
  cache_read_per_m REAL NOT NULL DEFAULT 0,
  cache_write_per_m REAL NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (${SQL_NOW})
);

CREATE TABLE usage_logs (
  id TEXT PRIMARY KEY,
  request_id TEXT UNIQUE NOT NULL,
  user_id TEXT NOT NULL,
  api_key_id TEXT NOT NULL,
  group_id TEXT,
  account_id TEXT,
  provider_id TEXT,
  model TEXT NOT NULL,
  upstream_model TEXT,
  -- migration 32: model reported by the upstream response (upstream_model is the requested mapping)
  actual_model TEXT,
  endpoint TEXT NOT NULL,
  stream INTEGER NOT NULL DEFAULT 0,
  status_code INTEGER NOT NULL DEFAULT 200,
  error_code TEXT,
  error_scope TEXT,
  retryable INTEGER,
  credential_version INTEGER,
  execution_sequence INTEGER,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  usage_estimated INTEGER NOT NULL DEFAULT 0,
  total_cost REAL NOT NULL DEFAULT 0,
  rate_multiplier REAL NOT NULL DEFAULT 1,
  actual_cost REAL NOT NULL DEFAULT 0,
  provider_earning REAL NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  first_token_ms INTEGER,
  selection_ms INTEGER,
  stream_truncated INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  tool_results INTEGER NOT NULL DEFAULT 0,
  client_ip TEXT,
  cc_shape TEXT,
  error_message TEXT,
  mode TEXT,
  upstream_status INTEGER,
  node_id TEXT,
  account_switched INTEGER NOT NULL DEFAULT 0,
  cache_refund_id TEXT,
  created_at TEXT NOT NULL DEFAULT (${SQL_NOW})
);
CREATE INDEX idx_usage_user_time ON usage_logs(user_id, created_at);
CREATE INDEX idx_usage_cache_refund_pending ON usage_logs(user_id, created_at) WHERE account_switched = 1 AND cache_refund_id IS NULL;
CREATE INDEX idx_usage_key_time ON usage_logs(api_key_id, created_at);
CREATE INDEX idx_usage_provider_time ON usage_logs(provider_id, created_at);
CREATE INDEX idx_usage_account_time ON usage_logs(account_id, created_at);
CREATE INDEX idx_usage_time ON usage_logs(created_at);

CREATE TABLE ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  amount_usd REAL NOT NULL,
  balance_after REAL NOT NULL,
  ref TEXT,
  note TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (${SQL_NOW})
);
CREATE INDEX idx_ledger_user_time ON ledger(user_id, created_at);

-- Cache-rebuild refunds (docs/data-model.md §3 cache_refunds, migration 15): one row per
-- user per refund run; the usage_logs rows it covers point back via cache_refund_id.
CREATE TABLE cache_refunds (
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
  created_at TEXT NOT NULL DEFAULT (${SQL_NOW})
);
CREATE INDEX idx_cache_refunds_user_time ON cache_refunds(user_id, created_at);
CREATE INDEX idx_cache_refunds_time ON cache_refunds(created_at);

-- Account affinity bindings (gateway.md §3 粘性会话 / 设备亲和, migration 16): the gateway's
-- sticky-session (kind=session → account_id) and device-pool (kind=device → accounts JSON)
-- maps written through to disk, so a blue/green gateway release keeps every conversation
-- and every client device on the account it was already using. expires_at is unix ms.
CREATE TABLE affinity_bindings (
  key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  account_id TEXT,
  accounts TEXT,
  expires_at INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (${SQL_NOW})
);
CREATE INDEX idx_affinity_expires ON affinity_bindings(expires_at);

-- Worker turn memory (worker-sessions.md §1, migration 17): the gateway's per-conversation record of
-- what the node's live claude process has already been fed (reuseKey → JSON TurnMemory), written
-- through so a release does not turn every next turn into a fresh full-history replay.
CREATE TABLE worker_turn_memory (
  key TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (${SQL_NOW})
);
CREATE INDEX idx_worker_turn_expires ON worker_turn_memory(expires_at);

CREATE TABLE credit_events (
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
  created_at TEXT NOT NULL DEFAULT (${SQL_NOW})
);
CREATE INDEX idx_credit_events_user_time ON credit_events(user_id, created_at);

CREATE TABLE redeem_codes (
  code TEXT PRIMARY KEY,
  value_usd REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'unused',
  batch TEXT,
  used_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  used_at TEXT,
  expires_at TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (${SQL_NOW})
);

CREATE TABLE nodes (
  node_id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  secret_hash TEXT NOT NULL,
  node_version TEXT,
  os_type TEXT,
  os_arch TEXT,
  online INTEGER NOT NULL DEFAULT 0,
  accepting_sessions INTEGER NOT NULL DEFAULT 1,
  in_flight INTEGER NOT NULL DEFAULT 0,
  last_heartbeat_at TEXT,
  capacity INTEGER NOT NULL DEFAULT 100,
  deploy_meta TEXT,
  created_at TEXT NOT NULL DEFAULT (${SQL_NOW})
);

-- Protocol v2 (http-egress): per-node proxy pool ledger. url_enc is the
-- AES-256-GCM encrypted proxy URL (plaintext only ever travels in the
-- WS proxies.set push); id = sha256(url).slice(0,12), computed identically
-- on the node.
CREATE TABLE node_proxies (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  url_enc TEXT NOT NULL,
  label TEXT,
  status TEXT NOT NULL DEFAULT 'unknown',
  last_check_at TEXT,
  last_error TEXT,
  -- migration 5 (docs/onboarding.md §5): lifetime binding to one account (NULL = free).
  bound_account_id TEXT REFERENCES accounts(id),
  -- migration 14: released from a rejected account → not assignable to a new account until then.
  cooldown_until TEXT,
  cooldown_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (${SQL_NOW})
);
CREATE INDEX idx_node_proxies_node ON node_proxies(node_id);
-- migration 40 (2026-11-08, docs/onboarding.md §1 原则 8): a pool row lives on its home node (node_proxies.node_id) and may be
-- shared into other nodes' pools; the exit's capacity is one global count whichever node uses it.
CREATE TABLE node_proxy_shares (
  proxy_id TEXT NOT NULL REFERENCES node_proxies(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (${SQL_NOW}),
  PRIMARY KEY (proxy_id, node_id)
);
CREATE INDEX idx_node_proxy_shares_node ON node_proxy_shares(node_id);

-- Account onboarding jobs (docs/onboarding.md §5): async authorize-and-import
-- pipeline state. payload_enc holds the sessionKey / PKCE verifier+state
-- (encrypted) and is cleared when the job reaches done/failed.
CREATE TABLE onboarding_jobs (
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
CREATE INDEX idx_onboarding_jobs_requester ON onboarding_jobs(requester_id);
CREATE INDEX idx_onboarding_jobs_status ON onboarding_jobs(status);
CREATE INDEX idx_accounts_node ON accounts(node_id);
CREATE INDEX idx_accounts_bound_proxy ON accounts(bound_proxy_id);
CREATE INDEX idx_node_proxies_bound ON node_proxies(bound_account_id);
CREATE INDEX idx_user_sessions_user ON user_sessions(user_id);

CREATE TABLE node_proxy_assignments (
  node_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  proxy_id TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (${SQL_NOW}),
  PRIMARY KEY (node_id, account_id)
);

CREATE TABLE node_bind_codes (
  code TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (${SQL_NOW})
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO groups (id, name, description, rate_multiplier, sort_order)
VALUES ('default', 'default', 'Built-in default group', 1.0, 0);
`;
