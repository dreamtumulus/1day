> **已被取代**：本文是 Billing v2 设计，已由 [`v3-design.md`](./v3-design.md) 整体取代（2026-10-15）。仅作历史参考，不再代表实现。

# 1DayAPI 分组 · 账户 · 计费体系（Billing v2）

> 参考 sub2api 的设计（分析笔记在 `recon/notes/`，本地留存），按 1DayAPI 架构（SQLite /
> auth_keys 三级密钥 / provider 隧道 / catalog SKU 定价）裁剪。本文档是实现的唯一权威契约。
> 与 docs/auth.md、docs/provider-protocol.md 并列生效。

## 1. 核心抽象

**分组（Group）= 定价 + 准入 + 路由的三位一体**：密钥绑分组 → 分组决定倍率、
模型白名单、可用账户池。**账户（Account）= 上游凭证池**，两种来源：
`direct`（平台持有的官方 API key，网关直连）与 `node`（provider 节点凭证，走隧道，
即原 provider_credentials 升级）。账户经 account_groups（M:N，每对独立 priority）
挂进分组。

计费公式：`actual_cost = total_cost(catalog SKU) × group.rate_multiplier`，
倍率快照进 usage_logs，改价不翻旧账。

## 2. 数据库（新增/变更）

```sql
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  description TEXT,
  platform TEXT NOT NULL DEFAULT 'all',      -- all | anthropic | openai | moonshot ...
  rate_multiplier REAL NOT NULL DEFAULT 1.0,
  model_allowlist TEXT,                       -- JSON {enabled:bool, models:["claude-*", ...]}
  status TEXT NOT NULL DEFAULT 'active',      -- active | disabled
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,                       -- direct | node
  provider_id TEXT REFERENCES auth_keys(id),  -- source=node 时必填（号商）
  node_id TEXT,                               -- source=node 时指定出口节点（可空=该号商任一在线节点）
  vendor TEXT NOT NULL,                       -- anthropic | openai | moonshot | ...
  label TEXT,
  credential_enc TEXT NOT NULL,               -- enc:v1:（API key 或 OAuth access_token）
  refresh_token TEXT,                         -- enc:v1:（source=node OAuth 刷新令牌；自 provider_credentials 迁移保留）
  account_email TEXT,                         -- 脱敏展示（自 provider_credentials 迁移保留）
  subscription_type TEXT,                     -- 同上
  priority INTEGER NOT NULL DEFAULT 50,       -- 越小越优先
  rate_multiplier REAL NOT NULL DEFAULT 1.0,  -- 账户成本倍率（统计口径，不影响用户扣费）
  status TEXT NOT NULL DEFAULT 'active',      -- active | error | disabled
  error_message TEXT,
  rate_limit_reset_at TEXT,                   -- 429 冷却截止
  temp_unschedulable_until TEXT,              -- 临时停调截止
  last_used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS account_groups (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  group_id TEXT NOT NULL REFERENCES groups(id),
  priority INTEGER NOT NULL DEFAULT 50,       -- 该账户在此分组内的优先级（覆盖 accounts.priority）
  PRIMARY KEY (account_id, group_id)
);
CREATE TABLE IF NOT EXISTS redeem_codes (
  code TEXT PRIMARY KEY,                      -- 24 位字母数字
  value_usd REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'unused',      -- unused | used
  used_by TEXT REFERENCES auth_keys(id),
  used_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS usage_billing_dedup (
  request_id TEXT PRIMARY KEY,
  key_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,                  -- sha256(key|model|tokens|amount)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
ALTER TABLE auth_keys ADD COLUMN group_id TEXT REFERENCES groups(id);
ALTER TABLE auth_keys ADD COLUMN quota_usd REAL NOT NULL DEFAULT 0;       -- 0=不限
ALTER TABLE auth_keys ADD COLUMN quota_used_usd REAL NOT NULL DEFAULT 0;
ALTER TABLE usage_logs ADD COLUMN request_id TEXT;                        -- 唯一索引
ALTER TABLE usage_logs ADD COLUMN group_id TEXT;
ALTER TABLE usage_logs ADD COLUMN rate_multiplier REAL NOT NULL DEFAULT 1.0;
```

迁移规则：provider_credentials 数据并入 accounts（source='node'）；建内置分组
`default`（rate 1.0、白名单关、platform 'all'）；存量 auth_keys.group_id 置 default；
gateway 环境变量 UPSTREAM_* 自动物化为 source='direct' 账户（label='env-fallback'，
归入 default 分组，priority 100 垫底）——若无 UPSTREAM key（mock 场景）也建一条
credential_enc='mock' 的 direct 账户保证调度链路闭环。

## 3. 模型白名单匹配（照搬 sub2api 简化版）

- 结构 `{enabled, models[]}`；enabled 且空列表 → 拒绝配置（400）
- 通配符只有 `*`，可在任意位置（前/中/后），锚定匹配、大小写不敏感；
  按 `*` 切分逐段 prefix/contains/suffix 判断
- 候选名归一化：请求模型名生成候选集 {原样, 去 `models/` 前缀}，任一命中即放行
- 双重生效：推理准入（403 `model_not_allowed`）+ GET /v1/models 列表按调用者分组过滤

## 4. 账户调度（gateway 对每个推理请求执行）

```
1. 按密钥取分组（无分组→default）；白名单准入检查
2. 候选账户 = 该分组 account_groups ∪ {env-fallback}，
   过滤：vendor 匹配 model 前缀、status='active'、未在冷却窗口
   （rate_limit_reset_at / temp_unschedulable_until > now 剔除）
3. 粘性会话：sessionHash = sha256(model + 首条 user 消息前 256 字符)，
   进程内 Map<hash, {accountId, expiresAt}>（TTL 10min），命中且仍可调度的优先
4. 排序：account_groups.priority ASC → accounts.priority ASC →
   last_used_at ASC（最久未用优先）→ 同档随机打散
5. 依次尝试：source='node' → 走现有隧道（internal/tunnel/open 扩展为按
   accountId 指定凭证与节点）；source='direct' → 取解密凭证直连官方
   （/internal/accounts/:id/credential，仅 loopback）
6. 上游错误处理：429 → rate_limit_reset_at = now+5min（或 Retry-After）；
   401 → status='error' + temp_unschedulable_until=now+24h；402 → temp 60min；
   其他 5xx → temp 30s。然后按排序尝试下一账户；全部失败才回退 env 直连/mock
```

## 5. 计费闭环（gateway settle，全部在单个 SQLite 事务内）

1. total_cost = catalog.estimateCost(model, usage)
2. rate = group.rate_multiplier（快照）；actual = total × rate；
   **金额量化到 8 位小数（half-away-from-zero）再进 SQL**
3. 幂等：`INSERT OR IGNORE INTO usage_billing_dedup(request_id, key_id, fingerprint)`，
   冲突且指纹不同 → 记 conflict 日志不再扣费
4. 条件扣减：`UPDATE wallets SET balance_usd = balance_usd - ? WHERE user_id=? AND balance_usd >= ?`，
   影响行数=0 → 无条件重扣并在 transactions meta 标 `overdraft:true`（超支记账不丢单）
5. quota：`UPDATE auth_keys SET quota_used_usd = quota_used_usd + ? WHERE id=?`；
   若 quota_usd>0 且 quota_used>=quota_usd → 同请求后续推理返回 429 `quota_exhausted`
6. usage_logs 写入 request_id/group_id/rate_multiplier/cost_usd(=actual)

预检（请求前）：`授信额度 − 本期已用 + 预付余额 > 0`（无授信额度时即余额 > 0；quota>0 时 quota_used<quota）→ 否则 402（`credit_exhausted` / `insufficient_balance`）/429。

## 6. 端点

### admin（/api/admin/）

- `GET|POST /api/admin/groups`、`PATCH|DELETE /api/admin/groups/:id`
- `GET|POST /api/admin/accounts`、`PATCH|DELETE /api/admin/accounts/:id`
  （POST 体含 source/vendor/credential 明文→加密落盘/priority/groupIds[]）
- `POST /api/admin/redeem-codes` `{valueUsd, count, expiresAt?}` → 批量生成返回明文列表；
  `GET /api/admin/redeem-codes?status=` 列表
- `POST /api/admin/keys/:id/group` `{groupId}`：给密钥换分组
- `POST /api/admin/keys/:id/quota` `{quotaUsd}`：设额度

### 用户（任意有效密钥）

- `GET /api/groups`：公开分组列表（active，脱敏：不含账户）+ `myGroupId`
- `POST /api/redeem` `{code}`：乐观锁核销
  （`UPDATE redeem_codes SET status='used'... WHERE code=? AND status='unused'`，
  影响行数=0 → 400 `code_invalid_or_used`），余额入账写 transactions kind='redeem'
- `GET /api/wallet` 响应加 `quotaUsd/quotaUsedUsd/groupName/rateMultiplier`

### gateway 内部（loopback）

- `/internal/accounts/:id/credential` → `{vendor, credential}`（解密）
- `/internal/tunnel/open` 请求体扩展 `accountId?`：指定账户的凭证与节点开洞

## 7. Web 端

- admin Dashboard 新增两个标签：**分组管理**（列表+编辑倍率/白名单/状态+密钥分配数）、
  **账户管理**（direct 账户添加表单含密钥明文输入+分组挂载+优先级；node 账户只读列表含冷却状态）；
  密钥管理标签加"分组"列与"换分组/设额度"操作；新增**兑换码**子页（批量生成+列表）
- 用户钱包页：显示当前分组名+倍率+额度进度条；**充值兑换码输入框**（/api/redeem）
- Models 页：已登录用户按自己分组的白名单过滤显示（未登录显示全部）

## 8. 错误码新增

`model_not_allowed`(403)、`quota_exhausted`(429)、`code_invalid_or_used`(400)、
`no_available_account`(503)
