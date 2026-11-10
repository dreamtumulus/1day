# 1DayAPI v3 重构设计（契约）

> 状态：**已实现**（2026-10-15），后端由 `tests/e2e/` 覆盖，控制台前端在 `apps/web/src/console/`。本文是 v3 的唯一权威契约，取代
> `billing-groups.md`（Billing v2）与 `auth.md` 中关于自助签发 / 推荐的部分。
> 计费/分组设计参考 sub2api（分析笔记在 `recon/notes/`，本地留存）。
> 供给端下一阶段方向见 [`ccr-supply.md`](./ccr-supply.md)（云端会话供给，规划中）。

> 2026-10-27 组织隔离修订：Claude 订阅账号按实际组织 UUID 隔离，每个对话阶段只在同组织内换号。
> 当前组织对该请求无可用账号时，清除旧历史及客户端 system/developer 后创建新阶段，再选择其他组织。
> 固定代理默认承载两个同组织账号，常规容量不足才启用第三槽，硬上限三。组织身份仅管理员可见，归属与分配留历史。
> 迁移仅新增结构，旧数据不回填、不修改、不删除。详细规则见 [`team-isolation.md`](./team-isolation.md)；本修订取代下文旧的一号一代理与跨组织携历史故障转移约定。

## 0. 已拍板的决策

| # | 决策 | 结论 |
|---|---|---|
| D1 | 鉴权模式 | **保持密钥登录**：`1dk_<role>_<48hex>` 登录密钥 → 会话 cookie。无用户名 / 密码 |
| D2 | 注册 / 推荐 | **全部取消**：不开放注册（删除自助签发），不做推荐返利。账户只能由管理员创建 |
| D3 | 账户与 Key | **登录密钥 + 多把 API Key**：登录密钥代表一个账户（一个钱包）；用户自行生成多把 `sk-1d-…` API Key，每把独立分组 / 额度 / 过期 / 启停 |
| D4 | 上游接入 | **管理员与号商都能接**：官方 API Key、第三方中转 API（Base URL + Key）、订阅 OAuth 账号（经节点隧道）。号商接入需管理员审核；号商按用量记收益 |
| D5 | 计费 | **按量扣余额 + 兑换码**：`实扣 = 模型价 × 分组倍率`；兑换码 / 管理员调账入账；删除 mock USDT 充值；不做订阅套餐 |
| D6 | 技术栈 | **保留 TS + Fastify + SQLite（node:sqlite）+ React/Tailwind**；首页与公开页面风格不动，三角色控制台重写 |
| D7 | 订阅账号供给形态 | **双轨**：直连路径（v2，功能完整）+ 云端会话路径（CCR，见 `ccr-supply.md`，规划中）。CCR 为订阅账号的主演进方向 |
| D8 | 账号授权接入 | OAuth 令牌申请**必须经真实浏览器完成官方同意页流程**；纯脚本化申请已验证不可用（令牌分钟级失效）。实现载体为指纹浏览器自动化或人工辅助，见 `ccr-supply.md` §2 |

## 1. 总体架构

```
             ┌──────────── web (Vite/React, :8402) ────────────┐
             │ 公开站点（首页/模型/价格/文档/校验…，保持不变）   │
             │ /console/*  三角色控制台（v3 新建）              │
             └───────────────┬─────────────────────────────────┘
                             │ /api, /auth (cookie 会话)
 client ──sk-1d-…──▶ gateway (:8400) ──────────┐       console (:8401)
                     │ 鉴权/准入/调度/转换/结算 │       │ 控制台 API、节点 WS 控制面、隧道管理器
                     │                         │       │
                     ├── direct ──▶ 上游 HTTPS  │       │
                     └── node ──▶ /internal/tunnel/* ──▶ WS ──▶ provider-node ──TCP──▶ 上游
                             (loopback + 内部令牌)
             gateway 与 console 共用 packages/core（同一 SQLite 文件、同一迁移、同一加密主钥）
```

### 1.1 包结构

| 包 | 职责 |
|---|---|
| `packages/catalog` | 内置模型目录与官方价目（种子数据，保持不变） |
| `packages/core`（新） | 数据库打开 + 版本化迁移、加密（`enc:v1:`）、内部令牌、金额量化、模型注册表（目录 ∪ 自定义价）、白名单匹配、平台默认值、结算事务、调度查询 |
| `apps/gateway` | 推理网关：鉴权 → 准入 → 选账户 → 协议转换 → 上游 → 流式 → 结算 |
| `apps/console` | 控制台 API（三角色）、节点 WS 控制面与隧道管理器 |
| `apps/web` | 公开站点 + `/console` 控制台 |
| `apps/provider-node` | 号商节点（协议不变，见 `provider-protocol.md`） |

**去掉的东西**：网关 `UPSTREAM_*` 环境变量直连兜底（上游一律以"上游账户"配置）、
`/internal/accounts/:id/credential`（网关经 core 直接解密）、自助签发、推荐、mock 充值、
`usage_billing_dedup`（由 `usage_logs.request_id UNIQUE` 在同一事务内实现幂等）。

## 2. 角色与身份

| 角色 | 登录密钥 | 能做什么 |
|---|---|---|
| admin | `1dk_admin_…` | 全部管理：用户、分组、上游账户、模型定价、兑换码、用量、节点、号商结算、设置。也可给自己建 API Key 调用 |
| consumer（用户） | `1dk_consumer_…` | 管理自己的 API Key、看用量、兑换码充值、看可用分组/模型 |
| provider（号商） | `1dk_provider_…` | 绑定节点、上传订阅账号、提交上游 API、看收益与结算记录。**不能调用推理** |

- 登录密钥只用于登录控制台（`POST /auth/login`）。**推理只接受 API Key**（`sk-1d-…`）。
  兼容：迁移时为每个旧 consumer/admin 登录密钥生成一把同哈希的"legacy" API Key，
  旧客户端里配的 `1dk_consumer_…` 仍可调推理（网关按哈希查 `api_keys`）。
- 管理员创建用户时签发登录密钥（明文只返回一次），可重置（旧密钥立即失效 + 清会话）。
- 控制台 API 只认会话 cookie（`oneday_session`，7 天；`COOKIE_SECURE=1` 时带 `Secure`），不再接受 `Authorization: Bearer 1dk_…` 直调。
- 用户状态 `active | disabled`；禁用后登录与其全部 API Key 立即失效。
- 首次启动无管理员时自动生成（写 `data/admin-key.txt`，0600），沿用 v2 行为。

## 3. 数据模型（v3 schema）

所有金额 `REAL`，入库前量化到 8 位小数（half-away-from-zero）。时间统一 `TEXT`
（SQLite `datetime('now')`，UTC，`YYYY-MM-DD HH:MM:SS`）。

```sql
CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,                     -- admin | consumer | provider
  name TEXT NOT NULL,
  login_key_hash TEXT UNIQUE NOT NULL,    -- sha256(明文)
  login_key_preview TEXT NOT NULL,        -- 明文前 16 位
  status TEXT NOT NULL DEFAULT 'active',  -- active | disabled
  balance_usd REAL NOT NULL DEFAULT 0,    -- consumer/admin：可用余额；provider：未结算收益
  note TEXT,
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE user_sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE groups (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  description TEXT,
  rate_multiplier REAL NOT NULL DEFAULT 1.0,  -- 实扣 = 模型价 × 倍率
  model_allowlist TEXT,                        -- JSON {enabled, models[]}，见 §6
  is_exclusive INTEGER NOT NULL DEFAULT 0,     -- 1 = 仅 user_allowed_groups 授权的用户可选
  status TEXT NOT NULL DEFAULT 'active',       -- active | disabled
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
  key_hash TEXT UNIQUE NOT NULL,          -- sha256(明文)，网关查找用
  key_enc TEXT,                           -- enc:v1:(明文)，供用户再次查看；legacy 迁移行为 NULL
  key_preview TEXT NOT NULL,              -- 'sk-1d-ab12…9f3c'
  group_id TEXT NOT NULL REFERENCES groups(id),
  status TEXT NOT NULL DEFAULT 'active',  -- active | disabled
  quota_usd REAL NOT NULL DEFAULT 0,      -- 0 = 不限
  used_usd REAL NOT NULL DEFAULT 0,       -- 累计实扣
  expires_at TEXT,                        -- NULL = 永不过期
  last_used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE accounts (                   -- 上游账户
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,                 -- anthropic | openai | google | moonshot | zhipu | xai | ...（§5.1）
  type TEXT NOT NULL,                     -- apikey | upstream | oauth
  protocol TEXT NOT NULL,                 -- anthropic | openai （上游说的线协议）
  base_url TEXT,                          -- NULL = 平台默认（§5.1）
  credential_enc TEXT NOT NULL,           -- enc:v1:JSON {apiKey} | {accessToken, refreshToken?, expiresAt?, accountId?}
  models TEXT,                            -- JSON string[]，支持 * 通配；NULL/[] = 该平台全部目录模型
  model_mapping TEXT,                     -- JSON {请求模型: 上游模型}
  owner_id TEXT REFERENCES users(id),     -- NULL = 平台自有；否则号商
  route TEXT NOT NULL DEFAULT 'direct',   -- direct | node
  node_id TEXT,                           -- route=node 时可固定节点；NULL = 该号商任一在线节点
  review_status TEXT NOT NULL DEFAULT 'approved', -- pending | approved | rejected（号商提交默认 pending）
  review_note TEXT,
  payout_rate REAL NOT NULL DEFAULT 0,    -- 号商分成比例：收益 = 标准价 × payout_rate
  priority INTEGER NOT NULL DEFAULT 50,   -- 越小越优先
  concurrency INTEGER NOT NULL DEFAULT 0, -- 0 = 不限
  status TEXT NOT NULL DEFAULT 'active',  -- active | disabled | error
  error_message TEXT,
  rate_limited_until TEXT,                -- 429 冷却
  overload_until TEXT,                    -- 529/503 过载
  temp_unschedulable_until TEXT,          -- 其他临时停调
  account_email TEXT,
  subscription_type TEXT,
  last_used_at TEXT,
  executor TEXT NOT NULL DEFAULT 'direct', -- direct | ccr（迁移 3，见 ccr-supply.md §7）
  window_used REAL,                       -- CCR：绑定窗口已用比例 0..1，NULL = 未巡检
  window_reset_at TEXT,
  window_checked_at TEXT,
  window_exhausted_until TEXT,            -- 窗口级冷却
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE account_groups (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  priority INTEGER NOT NULL DEFAULT 50,   -- 分组内优先级（排序第一键）
  PRIMARY KEY (account_id, group_id)
);

CREATE TABLE model_prices (               -- 管理员覆盖目录价 / 新增自定义模型
  model_id TEXT PRIMARY KEY,
  display_name TEXT,
  platform TEXT NOT NULL,
  input_per_m REAL NOT NULL DEFAULT 0,        -- USD / 1M tokens
  output_per_m REAL NOT NULL DEFAULT 0,
  cache_read_per_m REAL NOT NULL DEFAULT 0,
  cache_write_per_m REAL NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,         -- 0 = 下架（含目录模型）
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE usage_logs (
  id TEXT PRIMARY KEY,
  request_id TEXT UNIQUE NOT NULL,        -- 幂等键
  user_id TEXT NOT NULL,
  api_key_id TEXT NOT NULL,
  group_id TEXT,
  account_id TEXT,
  provider_id TEXT,                       -- 账户 owner（号商），平台自有为 NULL
  model TEXT NOT NULL,                    -- 请求模型
  upstream_model TEXT,                    -- 映射后
  endpoint TEXT NOT NULL,                 -- /v1/chat/completions | /v1/messages | /v1/responses
  stream INTEGER NOT NULL DEFAULT 0,
  status_code INTEGER NOT NULL DEFAULT 200,
  error_code TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  usage_estimated INTEGER NOT NULL DEFAULT 0, -- 1 = 上游没报 usage，按字符估算
  total_cost REAL NOT NULL DEFAULT 0,     -- 标准价（倍率前）
  rate_multiplier REAL NOT NULL DEFAULT 1,
  actual_cost REAL NOT NULL DEFAULT 0,    -- 实扣
  provider_earning REAL NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  first_token_ms INTEGER,
  client_ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE ledger (                     -- 非用量的余额变动（用量只记 usage_logs）
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                     -- redeem | admin_adjust | payout | legacy_topup
  amount_usd REAL NOT NULL,               -- 正 = 入账，负 = 出账
  balance_after REAL NOT NULL,
  ref TEXT,                               -- 兑换码 / 外部单号
  note TEXT,
  created_by TEXT,                        -- 操作管理员 id
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE redeem_codes (
  code TEXT PRIMARY KEY,                  -- 24 位无歧义大写字母数字
  value_usd REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'unused',  -- unused | used | disabled
  batch TEXT,                             -- 批次备注
  used_by TEXT REFERENCES users(id),
  used_at TEXT,
  expires_at TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE nodes (                      -- 原 provider_nodes
  node_id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  secret_hash TEXT NOT NULL,
  node_version TEXT, os_type TEXT, os_arch TEXT,
  online INTEGER NOT NULL DEFAULT 0,
  accepting_sessions INTEGER NOT NULL DEFAULT 1,
  in_flight INTEGER NOT NULL DEFAULT 0,
  last_heartbeat_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE node_bind_codes (            -- 原 provider_bind_codes
  code TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
```

索引：`usage_logs(user_id, created_at)`、`usage_logs(api_key_id, created_at)`、
`usage_logs(provider_id, created_at)`、`usage_logs(created_at)`、`api_keys(user_id)`、
`ledger(user_id, created_at)`、`accounts(owner_id)`。

### 3.1 settings 键

| key | 默认 | 含义 |
|---|---|---|
| `default_group_id` | `default` | 新建 API Key 未指定分组时使用 |
| `provider_default_payout_rate` | `0.6` | 号商账户审核通过时的默认分成 |
| `announcement` | `""` | 控制台顶部公告（Markdown 纯文本） |
| `api_base_url` | `https://api.1dayapi.com` | 用户"接入指南"里展示的网关地址 |
| `max_keys_per_user` | `50` | 每用户 API Key 上限 |
| `anthropic_window_threshold_percent` | `95` | Anthropic 订阅账户绑定窗口用量 ≥ 该百分比即停调到窗口重置；100 = 关闭（`gateway.md` §3） |
| `window_poll_interval_sec` | `300` | 订阅账户巡检（usage 探测 + OAuth 令牌保活）间隔（秒，最小 30） |
| `sticky_session_ttl_sec` | `1800` | 粘性会话 TTL（秒） |
| `cc_shape_policy` | `observe` | 自称 Claude Code 但形态不合规的请求：`observe` 只记录 / `downgrade` 按非 CC 路由 / `reject` 400（`gateway.md` §2a） |
| `onboard_default_executor` | `ccr_worker` | 上号落库账号的默认执行器（onboarding.md） |
| `onboard_default_concurrency` / `onboard_default_rpm_limit` | `9` / `100` | 上号表单留空时新账号的并发 / RPM 上限 |
| `window_passive_max_age_sec` | `21600` | 主动 usage 探测只对超过此秒数无被动采样的账号执行（ccr-supply.md §7） |
| `ccr_cache_baseline_worker` / `ccr_cache_baseline_cloud` | `16600` / `28000` | CCR 路径客户可见缓存 = 上游缓存 − 身份上下文基线（token），0 = 全额计给客户（ccr-supply.md §7.1） |

### 3.2 从 v2 迁移（迁移版本 1，一次性、幂等）

检测到旧表 `auth_keys` 时执行（由 `schema_migrations` 保证只跑一次），全程单事务：

- `users` ← `auth_keys` ⨝ `wallets`（`label`→`name`，空则 `<role>-<preview>`；`revoked_at` 非空 → `disabled`）。
- `api_keys` ← 每个 consumer/admin 的 `auth_keys` 生成一把 legacy Key：`key_hash` 复用、`key_enc` NULL、
  `name='legacy'`、分组取 `auth_keys.group_id`（缺省 default）、`quota_usd/used_usd` 取旧值。
- `groups` ← `groups`（丢 `platform`）；`account_groups` 原样。
- `accounts` ← `accounts`：`source=node` → `type=oauth, route=node, owner_id=provider_id, protocol` 按平台；
  `source=direct` → `type=apikey, route=direct, owner_id NULL`；`credential_enc` 解密后重新包成 JSON 加密。
  解密失败的行跳过并打日志。`vendor`→`platform`。
- `usage_logs` ← 旧行（`cost_usd`→`actual_cost`，`total_cost = actual/rate`，无 `request_id` 的用旧 `id`）。
- `ledger` ← `transactions` 中非 `charge` 的行（`topup`→`legacy_topup`；`balance_after` 记 0，历史不可回推）。
- `redeem_codes`、`nodes`、`node_bind_codes`、`user_sessions` 对应搬迁。
- 旧表全部改名 `legacy_v2_*` 保留，不删除。

## 4. API Key

- 格式 `sk-1d-` + 48 位 hex；`key_preview = 前 10 位 + '…' + 后 4 位`。
- 明文：创建时返回一次；同时 `enc:v1:` 加密保存，用户可在控制台"查看"再次取回（legacy 行不可查看）。
- 网关校验顺序（任何一步失败即返回，不计费）：
  1. 取 `Authorization: Bearer` 或 `x-api-key`；按 sha256 查 `api_keys` → 401 `invalid_api_key`
  2. Key `status=disabled` → 401 `key_disabled`；`expires_at <= now` → 401 `key_expired`
  3. 用户 `status=disabled` → 401 `user_disabled`；用户角色 provider → 403 `role_not_permitted`
  4. 分组不存在或 disabled → 403 `group_disabled`
  5. 用户余额 `<= 0` → 402 `insufficient_balance`
  6. `quota_usd > 0 && used_usd >= quota_usd` → 429 `quota_exhausted`
- 用户可改：名称、分组（仅限可用分组）、额度、过期时间、启停；可删除。

## 5. 上游账户

### 5.1 平台默认值

| platform | 默认 protocol | 默认 base_url |
|---|---|---|
| anthropic | anthropic | `https://api.anthropic.com` |
| openai | openai | `https://api.openai.com/v1` |
| google | openai | `https://generativelanguage.googleapis.com/v1beta/openai` |
| moonshot | openai | `https://api.moonshot.cn/v1` |
| zhipu | openai | `https://open.bigmodel.cn/api/paas/v4` |
| xai | openai | `https://api.x.ai/v1` |
| volcengine | openai | `https://ark.cn-beijing.volces.com/api/v3` |
| minimax | openai | `https://api.minimax.chat/v1` |
| qwen | openai | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| deepseek | openai | `https://api.deepseek.com/v1` |
| 其他（xiaomi / opencode / custom） | 必填 | 必填 |

**URL 拼接约定**：`protocol=openai` 的 base_url 含版本前缀，网关拼 `/chat/completions`、`/responses`；
`protocol=anthropic` 的 base_url 为站点根，网关拼 `/v1/messages`（与两家官方 SDK 的 base_url 习惯一致）。

### 5.2 三种类型

| type | 含义 | 凭证 | 鉴权头 |
|---|---|---|---|
| `apikey` | 官方 API Key | `{apiKey}` | anthropic: `x-api-key` + `anthropic-version`；openai: `Authorization: Bearer` |
| `upstream` | 第三方中转 API（任意 Base URL） | `{apiKey}` | 同上，按 `protocol` |
| `oauth` | 订阅账号 OAuth 令牌（Claude / ChatGPT） | `{accessToken, refreshToken?, expiresAt?, accountId?}` | anthropic: `Authorization: Bearer` + `anthropic-beta: oauth-2025-04-20`；openai：`Authorization: Bearer` + `chatgpt-account-id`，固定出口 `https://chatgpt.com/backend-api/codex`，**仅支持 /v1/responses**（实验性） |

- `executor`（骨架已实现，见 `ccr-supply.md`）：账户的执行器维度——`direct`（平台/节点直发 Messages 请求）
  或 `ccr`（云端会话编排：建环境/建会话/events 推拉，由官方云端 worker 执行）。只有 `type=oauth, platform=anthropic`
  的账户可设 `ccr`；凭证另含 `orgUuid`、`environmentId`（缺环境时网关首个请求懒创建并回写）。`executor=ccr` 的账户走
  `ccr-supply.md` §7 的配额窗口调度，端点只支持 `/v1/messages` 与 `/v1/chat/completions`，能力边界以其 §6 为准。
- `route=node`：号商账户经该号商在线节点隧道出网；平台自有账户（`owner_id` NULL）须固定 `node_id` 到管理员部署的**平台节点**（`GET /api/admin/nodes` 的 `platformNode`）；节点侧仍执行目标域名白名单。
- 订阅窗口：Anthropic OAuth 账户的每个响应被动采样 `anthropic-ratelimit-unified-*` 头，429 按被拒窗口的 reset 冷却，用量达
  `anthropic_window_threshold_percent` 停调到窗口重置；console 定时巡检空闲账户并提前刷新即将过期的令牌（`gateway.md` §3、§5.1）。
- OAuth 刷新：`expiresAt` 距今 < 5 分钟且有 `refreshToken` 时，调度前在网关内刷新（刷新实现在 core，console 保活共用）
  （anthropic `https://platform.claude.com/v1/oauth/token`；openai `https://auth.openai.com/oauth/token`），
  成功则加密回写；失败标 `error`。刷新经直连出网（不走隧道）。
- 号商提交的账户（含节点上传的 OAuth）`review_status=pending`，**不参与调度**；管理员审核通过时
  指定分组、优先级、分成比例。号商修改凭证 / Base URL 会退回 `pending`。

### 5.3 账户支持哪些模型

`supports(account, model)`：
1. 若 `models` 非空：model 命中其中任一通配模式；
2. 否则：模型注册表中该 model 的 `platform == account.platform`。

`upstream_model = model_mapping[model] ?? model`。

## 6. 模型注册表与定价

- 注册表 = 目录模型（`packages/catalog`）∪ `model_prices` 自定义模型；`model_prices` 同名行覆盖目录价，
  `enabled=0` 下架。
- **不在注册表内的模型直接拒绝**：404 `model_not_found`（v2 中未知模型计费为 0 的问题由此消除）。
- 标准价 `total_cost`：
  - 有 `model_prices` 行：`Σ tokens × 单价 / 1e6`（输入 / 输出 / 缓存读 / 缓存写 5m / 缓存写 1h；5m 单价为空时 = 1h 单价 × 0.625，X-51）；
  - 否则：目录 `estimateCost`（缓存写 5m / 1h 各按自己的 SKU，拆分前的旧记录按单一 SKU）。
- 分组白名单 `{enabled, models[]}`：`*` 通配、锚定、大小写不敏感，候选名 {原名, 去 `models/` 前缀}；
  `enabled` 且列表空 → 配置时 400。准入失败 403 `model_not_allowed`；`GET /v1/models` 按 Key 分组过滤。

## 7. 网关请求流程

```
鉴权(§4) → 解析 model → 注册表(§6) → 分组白名单 → 选候选账户 → 依次尝试(最多 3 个) → 回写 → 结算
```

### 7.1 端点与协议转换

| 客户端端点 | 账户 protocol=anthropic | protocol=openai |
|---|---|---|
| `POST /v1/messages` | 透传 | Anthropic→OpenAI Chat 请求转换，响应 / SSE 反向转换 |
| `POST /v1/chat/completions` | OpenAI→Anthropic 转换（含 tools、图片、system），响应 / SSE 反向转换 | 透传；**强制注入 `stream_options.include_usage=true`**，客户端未要求时剔除仅含 usage 的末块 |
| `POST /v1/responses` | 不支持（跳过该账户） | 透传；从 `response.completed` 事件取 usage |
| `GET /v1/models` | — | 注册表 ∩ 分组白名单 |

路径别名：不带 `/v1` 前缀的同名路径等价。`/v1/images/generations`、`/v1/videos` 返回 501。

### 7.2 选账户

候选 = 分组下 `account_groups` 中满足：`status=active`、`review_status=approved`、
未处于任何硬冷却窗口（`overload_until` / `temp_unschedulable_until` / `window_exhausted_until` / 被拒窗口的 `rate_limited_until`；
普通 Retry-After 式 429 冷却是软的：账户仍参与但排最后，见 docs/gateway.md §3）、`supports(account, model)`、端点协议兼容、并发未满、
`route=node` 时其号商有在线节点。

排序：粘性命中优先（键取 `metadata.user_id` 会话 ID → `cache_control` 内容 → Key+IP+UA+全文摘要，TTL `sticky_session_ttl_sec`）→
`account_groups.priority` ASC → `accounts.priority` ASC → `last_used_at` ASC（最久未用）→ 同档随机。

### 7.3 上游错误处理

| 上游结果 | 账户处理 | 对客户端 |
|---|---|---|
| 2xx | `last_used_at` 更新 | 正常返回 |
| 400 / 404 / 413 / 422 | 不标记 | **透传上游状态码与错误体**（客户端请求问题，换账户无意义） |
| 401 / 403 | OAuth 有 refreshToken 则先刷新重试一次；否则 `status=error` | 换下一个账户 |
| 402 | `temp_unschedulable_until = now+60min` | 换下一个 |
| 429 | `rate_limited_until = now + Retry-After（默认 60s，上限 2h）`，软冷却（只降序不排除）；被拒窗口则冷却到窗口 reset 并硬排除 | 换下一个 |
| 529 / 503 | `overload_until = now+60s` | 换下一个 |
| 其他 5xx / 网络错误 | `temp_unschedulable_until = now+30s` | 换下一个 |

全部候选失败：最后一个上游错误为 429 → 429 `upstream_rate_limited`；分组内有支持该模型的账户但端点协议都不兼容 → 400 `unsupported_endpoint`；无候选或一个都没真正尝试（并发满 / 节点离线）→ 503 `no_available_account`；
其余 → 502 `upstream_error`。失败请求也写 `usage_logs`（`status_code`、`error_code`，费用 0）。

### 7.4 结算（单个 SQLite 事务）

```
total   = price(model, usage)                 -- §6
actual  = q8(total × group.rate_multiplier)
earning = owner 为号商 ? q8(total × account.payout_rate) : 0
BEGIN
  INSERT usage_logs(request_id UNIQUE …)      -- 冲突 → ROLLBACK（幂等重放）
  UPDATE users SET balance_usd = q8(balance_usd - actual) WHERE id = user   -- 允许透支为负，不丢单
  UPDATE api_keys SET used_usd = used_usd + actual, last_used_at = now WHERE id = key
  UPDATE users SET balance_usd = balance_usd + earning WHERE id = provider  -- earning > 0 时
COMMIT
```

- usage 缺失时按 `字符数 / 4` 估算输入 / 输出 token，`usage_estimated=1`。
- 流式请求在上游流结束（或客户端中断）后、**结束客户端响应之前**结算：客户端看到流结束时扣费已落库。
- 失败请求（4xx 透传 / 全部账户失败 / 准入失败）也写 `usage_logs`，费用 0、`provider_id` 为空。

### 7.5 其他

- 账户并发：网关进程内计数，`concurrency>0` 时满额账户跳过。
- TEE 证明桩（HMAC，非硬件证明）**仅在请求带 `x-1dayapi-tee-proof-mode` 头时输出**：非流式且值为 `multipart` 时返回 `multipart/mixed`（第二段为证明）；流式时在末尾追加 `event: tee.proof`。不带头时响应与上游协议完全一致。
- `POST /v1/messages/count_tokens` 本地按字符估算返回 `{input_tokens}`，不调上游、不计费。
- 网关 → console 隧道接口要求 loopback **且** 请求头 `x-1dayapi-internal: <data/internal.key>`。

## 8. 控制台 API

约定：成功 `{data: …}`；错误 `{error: {code, message, type}}`；分页参数 `page`（1 起）/`pageSize`（≤100，默认 20），
分页响应 `{data: {items, total, page, pageSize}}`；时间参数 `from`/`to` 为 `YYYY-MM-DD`（含两端，UTC）。
请求体字段 camelCase，响应字段 camelCase。

### 8.1 公共

| 方法 路径 | 说明 |
|---|---|
| `GET /health` | `{ok, service}` |
| `POST /auth/login` `{key}` | 设 cookie；`{data: Me}` |
| `GET /auth/me` | `{data: Me}`；`Me = {id, role, name, keyPreview, balanceUsd, status}` |
| `POST /auth/logout` | 清 cookie |
| `GET /api/models` | 注册表中启用模型（目录形状 `CatalogModel[]`，自定义模型合成） |
| `GET /api/models/pricing` | 启用模型价目（`PricingEntry[]`，自定义 / 覆盖价合成 SKU） |
| `GET /api/site` | `{announcement, apiBaseUrl}` |

### 8.2 用户（consumer，admin 亦可）——前缀 `/api/user`

| 方法 路径 | 请求 | 响应 data |
|---|---|---|
| `GET /overview` | — | `{balanceUsd, keyCount, today:{requests, costUsd, tokens}, month:{requests, costUsd, tokens}, daily:[{day, requests, costUsd, tokens}]（近 14 天）, topModels:[{model, requests, costUsd}]}` |
| `GET /groups` | — | `[{id, name, description, rateMultiplier, modelAllowlist, isDefault}]`（该用户可选的分组） |
| `GET /keys` | — | `[ApiKey]`，`ApiKey = {id, name, keyPreview, groupId, groupName, status, effectiveStatus, quotaUsd, usedUsd, expiresAt, lastUsedAt, createdAt, revealable}`；`effectiveStatus ∈ active|disabled|expired|exhausted` |
| `POST /keys` | `{name, groupId?, quotaUsd?, expiresAt?}` | `{...ApiKey, key}`（明文） |
| `PATCH /keys/:id` | `{name?, groupId?, quotaUsd?, expiresAt?(null 清除), status?}` | `ApiKey` |
| `POST /keys/:id/reveal` | — | `{key}`；legacy → 400 `key_not_revealable` |
| `DELETE /keys/:id` | — | `{ok}` |
| `GET /usage` | `page,pageSize,from,to,keyId,model` | 分页 `UsageRow = {id, requestId, createdAt, keyName, model, endpoint, stream, statusCode, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, actualCost, rateMultiplier, durationMs, usageEstimated}` |
| `GET /usage/stats` | `from,to,keyId` | `{totals:{requests, costUsd, inputTokens, outputTokens}, daily:[…], byModel:[{model, requests, costUsd, inputTokens, outputTokens}]}` |
| `GET /ledger` | `page,pageSize` | 分页 `{id, kind, amountUsd, balanceAfter, ref, note, createdAt}` |
| `POST /redeem` | `{code}` | `{valueUsd, balanceUsd}`；失败 400 `code_invalid_or_used` |

### 8.3 号商（provider）——前缀 `/api/provider`

| 方法 路径 | 请求 | 响应 data |
|---|---|---|
| `GET /overview` | — | `{balanceUsd（未结算）, lifetimeEarningUsd, paidOutUsd, today:{requests, earningUsd}, month:{…}, daily:[{day, requests, earningUsd}], accounts:{total, active, pending, error}, nodes:{total, online}}` |
| `GET /nodes` | — | `[{nodeId, nodeVersion, osType, osArch, online, acceptingSessions, inFlight, lastHeartbeatAt, createdAt}]` |
| `POST /bind-codes` | — | `{code, expiresAt}`（10 分钟有效） |
| `DELETE /nodes/:id` | — | 解绑（删除节点记录，WS 断开） |
| `GET /accounts` | — | `[ProviderAccount]` = `{id, name, platform, type, protocol, baseUrl, models, route, nodeId, reviewStatus, reviewNote, status, errorMessage, payoutRate, accountEmail, subscriptionType, coolingUntil, lastUsedAt, createdAt, requests30d, earning30d}` |
| `POST /accounts` | `{name, platform, type: apikey|upstream, protocol?, baseUrl?, apiKey, models?, route?: direct|node}` | `ProviderAccount`（pending） |
| `PATCH /accounts/:id` | `{name?, models?, apiKey?, baseUrl?, status?: active|disabled}` | 改凭证/URL → pending |
| `DELETE /accounts/:id` | — | `{ok}` |
| `GET /earnings` | `page,pageSize,from,to,accountId` | 分页 `{id, createdAt, accountName, model, inputTokens, outputTokens, totalCost, providerEarning, statusCode}` |
| `GET /ledger` | `page,pageSize` | 结算 / 调账记录（同用户 ledger 形状） |

### 8.4 管理员 —— 前缀 `/api/admin`

| 方法 路径 | 请求 | 响应 data |
|---|---|---|
| `GET /dashboard` | — | `{users:{consumer, provider, admin, disabled}, today:{requests, costUsd, totalCostUsd, tokens, errors}, month:{…}, daily:[{day, requests, costUsd, errors}]（30 天）, topModels, topUsers:[{userId, name, requests, costUsd}], accounts:{total, active, pending, error, cooling}, nodes:{total, online}, balances:{consumerTotalUsd, providerUnsettledUsd}}` |
| `GET /users` | `page,pageSize,role,status,q` | 分页 `AdminUser = {id, role, name, loginKeyPreview, status, balanceUsd, note, keyCount, requests30d, cost30d, lastLoginAt, createdAt, allowedGroupIds}` |
| `POST /users` | `{role, name, note?, initialBalanceUsd?, allowedGroupIds?}` | `{...AdminUser, loginKey}`（明文一次） |
| `GET /users/:id` | — | `AdminUser` + `{keys: ApiKey[], recentLedger}` |
| `PATCH /users/:id` | `{name?, note?, status?, allowedGroupIds?}` | `AdminUser`；禁用即清会话 |
| `POST /users/:id/reset-login-key` | — | `{loginKey}` |
| `POST /users/:id/adjust-balance` | `{amountUsd(≠0), note?}` | `{balanceUsd}`，写 ledger `admin_adjust` |
| `POST /users/:id/payout` | `{amountUsd(>0), ref?, note?}` | 号商结算出账，写 ledger `payout`（余额不足 400） |
| `DELETE /users/:id` | — | 仅无用量记录的用户可删，否则 400 `user_has_usage`（应改为禁用） |
| `GET /keys` | `page,pageSize,userId,groupId,q` | 分页 `ApiKey & {userId, userName}` |
| `PATCH /keys/:id` | 同用户 PATCH，`groupId` 不受可用分组限制 | `ApiKey` |
| `GET /groups` | — | `[{id, name, description, rateMultiplier, modelAllowlist, isExclusive, status, sortOrder, keyCount, accountCount, createdAt}]` |
| `POST /groups` / `PATCH /groups/:id` | 上述可写字段 | group |
| `DELETE /groups/:id` | — | `default` 不可删；仍有 Key 使用 → 400 `group_in_use` |
| `GET /accounts` | `platform,status,reviewStatus,ownerId,q` | `[AdminAccount]` = ProviderAccount 字段 + `{ownerId, ownerName, priority, concurrency, modelMapping, groups:[{groupId, name, priority}], rateLimitedUntil, overloadUntil, tempUnschedulableUntil, requests30d, cost30d}` |
| `POST /accounts` | `{name, platform, type, protocol?, baseUrl?, apiKey? | accessToken?/refreshToken?/expiresAt?/accountId?, models?, modelMapping?, priority?, concurrency?, groupIds?, route?, ownerId?, nodeId?, payoutRate?}` | AdminAccount（approved） |
| `PATCH /accounts/:id` | 同上任意字段（凭证字段给出才更新）+ `status` | AdminAccount；`status=active` 清冷却与错误 |
| `POST /accounts/:id/review` | `{action: approve|reject, groupIds?, priority?, payoutRate?, note?}` | AdminAccount |
| `POST /accounts/:id/test` | `{model?}` | `{ok, statusCode, latencyMs, message}`（仅 route=direct） |
| `DELETE /accounts/:id` | — | `{ok}` |
| `GET /models` | — | `[{modelId, displayName, platform, source: catalog|custom, enabled, overridden, prices:{inputPerM, outputPerM, cacheReadPerM, cacheWritePerM}, catalogPrices?}]` |
| `PUT /models/:modelId` | `{displayName?, platform, inputPerM, outputPerM, cacheReadPerM, cacheWritePerM, enabled}` | 覆盖 / 新增 |
| `DELETE /models/:modelId` | — | 删除覆盖（目录模型恢复目录价；自定义模型删除） |
| `POST /redeem-codes` | `{valueUsd, count(1-500), expiresAt?, batch?}` | `{codes[], valueUsd, count}` |
| `GET /redeem-codes` | `page,pageSize,status,batch,q` | 分页 `{code, valueUsd, status, batch, usedBy, usedByName, usedAt, expiresAt, createdAt}` |
| `PATCH /redeem-codes/:code` | `{status: disabled|unused}` | 仅未使用的可禁用 / 恢复 |
| `DELETE /redeem-codes/:code` | — | 仅未使用的可删 |
| `GET /usage` | `page,pageSize,from,to,userId,keyId,accountId,model,status(ok|error)` | 分页 UsageRow + `{userId, userName, accountId, accountName, providerEarning, totalCost, errorCode}` |
| `GET /usage/stats` | `from,to,userId,accountId` | 同用户 stats + `byAccount:[{accountId, name, requests, costUsd}]` |
| `GET /nodes` | — | `[{…node, providerId, providerName}]` |
| `DELETE /nodes/:id` | — | 移除节点（断开 WS，相关账户 `node_id` 置空） |
| `GET /settings` / `PUT /settings` | settings 键值对象 | 同 |

### 8.5 节点与隧道（契约不变，见 `provider-protocol.md`）

`/internal/provider/{bind,unbind,status,credentials}`、WS `/internal/provider/connect`、
`/internal/tunnel/{open,:id/data,:id/read,:id/close}`。变化：
- 节点上传凭证写入 `accounts`（`type=oauth, route=node, review_status=pending`）。
- `tunnel/open` 只接受 `{accountId, targetHost, targetPort}`，并校验内部令牌。
- `deadlineMs` 改为相对毫秒数（与节点实现一致）。

## 9. 前端

- 公开站点（`/`、`/models`、`/pricing`、`/docs*`、`/tools/*`、`/provider`）保持现有视觉；
  删除 `/referral`、`/register` 与导航 / 页脚中的推荐、自助签发入口。
- 登录页：只保留"输入登录密钥"，说明"账户由管理员开通"。
- `/console/*`：独立控制台外壳（左侧导航 + 顶栏，沿用站点设计令牌、`LogoMark`、`wk-btn`、`card`、`wk-table`、
  亮 / 暗主题、中英双语），按角色出菜单：

| 角色 | 菜单 |
|---|---|
| consumer | 概览 · API 密钥 · 使用记录 · 钱包（兑换码 + 流水）· 可用模型 · 接入指南 |
| provider | 概览 · 节点 · 上游账户 · 收益明细 · 结算记录 · 接入指南（节点安装） |
| admin | 仪表盘 · 用户 · API 密钥 · 分组 · 上游账户 · 模型定价 · 兑换码 · 使用记录 · 节点 · 系统设置；另可进入"我的 API 密钥 / 使用记录" |

- `/dashboard` 重定向到 `/console`。图表用内置 SVG 组件（无第三方图表库）。

## 10. 错误码（新增 / 变化）

| code | HTTP | 场景 |
|---|---|---|
| `invalid_api_key` / `key_disabled` / `key_expired` / `user_disabled` | 401 | §4 |
| `role_not_permitted` / `group_disabled` / `model_not_allowed` | 403 | §4、§6 |
| `model_not_found` | 404 | 注册表无此模型 |
| `insufficient_balance` | 402 | 余额 ≤ 0 |
| `quota_exhausted` / `upstream_rate_limited` | 429 | Key 额度用尽 / 全部账户限流 |
| `no_available_account` | 503 | 无可用账户 |
| `upstream_error` | 502 | 上游失败 |
| `unsupported_endpoint` | 400 | 端点与可用账户协议都不兼容 |
| `ccr_unsupported_content` / `ccr_unsupported_tool_choice` | 400 | 候选全是云端会话账户，而请求含图片 / 文件块，或强制 `tool_choice`（`ccr-supply.md` §6） |
| `code_invalid_or_used` | 400 | 兑换失败 |
| `key_not_revealable` | 400 | legacy Key 无法查看 |
| `invalid_login_key` / `user_disabled` | 401 | 控制台登录失败 |
| `too_many_attempts` | 429 | 同 IP 10 分钟内登录失败 ≥ 20 次 |
| `key_limit_reached` / `group_not_available` | 400 | 建 Key 超上限 / 分组不可用 |
| `upstream_client_error` | 透传 | 上游 400/404/413/422 且需跨协议包装时 |
| `node_bound_elsewhere` | 409 | 节点 id 已绑定到其他号商 |
| `user_has_usage` / `group_in_use` / `insufficient_balance`（payout） | 400 | 管理操作约束 |

## 11. 不做 / 以后再说

订阅套餐、在线支付、邀请返利、Key 级 RPM / 时间窗限额、IP 黑白名单、图片 / 视频生成、
多实例部署（调度状态在进程内）。
（Claude Code 客户端兼容性对齐已实现，见 `claude-code-compat.md`；云端会话供给见 `ccr-supply.md`。）
