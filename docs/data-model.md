# 数据模型（v3）

> 现状参考，以 `packages/core/src/schema.ts` 与 `migrations.ts` 为准。完整 DDL 见
> [`v3-design.md`](./v3-design.md) §3（与代码一致）。本文讲字段语义、不变量与迁移。

## 1. 存储概况

- 单个 SQLite 文件（`node:sqlite` `DatabaseSync`），默认 `data/1dayapi.db`；`DATA_DIR` 改数据目录，`DB_PATH` 单独改库文件。
- gateway 与 console **两个进程共用同一个库**，都通过 `@1dayapi/core` 打开：
  `journal_mode=WAL`、`busy_timeout=5000`、`foreign_keys=ON`；写事务用 `BEGIN IMMEDIATE`（`tx()`）。
- 时间统一存 **ISO-8601 UTC、秒精度、带 Z**：`2026-10-15T07:01:02Z`（SQL 默认值
  `strftime('%Y-%m-%dT%H:%M:%SZ','now')`）。字符串序 = 时间序，冷却判断直接做字符串比较；
  按日聚合用 `substr(created_at,1,10)`（UTC 日）。
- 金额 `REAL`，入库前用 `q8()` 量化到 8 位小数（half-away-from-zero），SQL 侧余额更新用 `round(…, 8)`。

## 2. 表一览

| 表 | 作用 | 主要外键 |
|---|---|---|
| `schema_migrations` | 已应用的迁移版本 | — |
| `users` | 账户：三种角色、登录密钥哈希、余额 | — |
| `user_sessions` | 控制台会话 | `user_id → users` (CASCADE) |
| `groups` | 分组：倍率 + 模型白名单 + 是否专属 | — |
| `user_allowed_groups` | 专属分组授权 | `users`、`groups` (CASCADE) |
| `api_keys` | 调用推理用的 `sk-1d-` Key | `user_id → users` (CASCADE)、`group_id → groups` |
| `accounts` | 上游账户（平台自有或号商） | `owner_id → users` (CASCADE) |
| `account_groups` | 账户挂分组（M:N，带分组内优先级） | `accounts`、`groups` (CASCADE) |
| `model_prices` | 目录价覆盖 / 自定义模型 | — |
| `usage_logs` | 每个推理请求一行（成功与失败） | 无外键（历史保留） |
| `ledger` | 非用量的余额变动 | `user_id → users` (CASCADE) |
| `redeem_codes` | 兑换码 | `used_by → users` (SET NULL) |
| `nodes` | 号商节点 | `provider_id → users` (CASCADE) |
| `node_proxies` | 节点代理池台账（url_enc 加密、探活状态、绑定账户） | `bound_account_id → accounts` |
| `onboarding_jobs` | 上号异步任务（docs/onboarding.md §5） | — |
| `node_bind_codes` | 节点绑定码 | `provider_id → users` (CASCADE) |
| `settings` | 键值配置 | — |
| `affinity_bindings` | 网关粘性会话 / 设备池的落盘副本（跨蓝绿发布保持会话、设备 → 账号的对应） | 无外键（account_id 只是值） |
| `worker_turn_memory` | 网关侧 worker 持久会话轮次记忆的落盘副本（reuseKey → JSON TurnMemory） | — |

索引：`api_keys(user_id)`、`accounts(owner_id)`、`usage_logs` 上 `(user_id,created_at)`、`(api_key_id,created_at)`、
`(provider_id,created_at)`、`(account_id,created_at)`、`(created_at)`、`ledger(user_id,created_at)`；
唯一约束：`users.login_key_hash`、`api_keys.key_hash`、`usage_logs.request_id`、`groups.name`。

## 3. 字段语义要点

### users
- `role`：`admin | consumer | provider`；`status`：`active | disabled`（禁用即清会话，其全部 API Key 推理返回 401 `user_disabled`）。
- `login_key_hash` = sha256(`1dk_<role>_<48hex>`)，`login_key_preview` = 明文前 16 位。
- `balance_usd`：consumer/admin 是**可用余额**（允许被结算扣成负数，见 §4）；provider 是**未结算收益**。
- `credit_limit_usd` / `credit_used_usd` / `credit_settled_at`（迁移 13，2026-10-19 **充值授信模式**）：管理员给 consumer 一条授信额度；用量先扣正的预付余额，剩余累计到 `credit_used_usd`（本期已用 / 待结算）；准入条件是 `credit_limit_usd − credit_used_usd + balance_usd > 0`（网关 `authenticate`），否则 402 `credit_exhausted`；管理员**结算**（`settleCredit`，全额或部分）把 `credit_used_usd` 减去已收款金额，授信随之恢复，`credit_settled_at` 记最近一次。额度为 0 的用户完全保持旧行为（整笔扣余额、允许透支为负）。
- `credit_events`：授信审计（`kind` = `limit_set` / `settlement`，前后额度与已用、金额、备注、操作人），只增不改。

### api_keys
- 明文 `sk-1d-<48hex>`；`key_hash` 用于网关查找，`key_enc`（`enc:v1:`）供用户"查看"，迁移来的 legacy 行为 NULL（不可查看）。
- `key_preview` = 前 10 位 + `…` + 后 4 位。`status` 只存 `active | disabled`；`expired`/`exhausted` 是读取时算出的 `effectiveStatus`。
- `quota_usd` 0 = 不限；`used_usd` 累计实扣。

### groups
- `rate_multiplier`：实扣 = 标准价 × 倍率。`model_allowlist`：JSON `{enabled, models[]}`，`*` 通配。
- `is_exclusive=1` 时只有 `user_allowed_groups` 授权的用户能把 Key 绑到该组（管理员不受限）。
- 内置 `default` 组不可删除 / 停用；`settings.default_group_id` 指向的组不可删。

### accounts
- `type`：`apikey`（官方 Key）/ `upstream`（第三方中转）/ `oauth`（订阅令牌）；`protocol`：`anthropic | openai`。
- `credential_enc`：`enc:v1:` 加密的 JSON：`{apiKey}` 或 `{accessToken, refreshToken?, expiresAt?, accountId?}`。
- `base_url` NULL = 平台默认（见 v3-design §5.1）。`models` JSON 数组（空 = 该平台全部注册模型），`model_mapping` JSON 对象。
- `owner_id` NULL = 平台自有；非空 = 号商，`payout_rate` 为其分成。`route=node`：号商账户可用该号商任一在线节点或固定节点；平台自有账户（`owner_id` NULL）必须固定到**平台节点**（管理员部署、`nodes.provider_id` 为管理员的节点）。
- `review_status`：号商提交 / 节点上传默认 `pending`，只有 `approved` 参与调度。
- 冷却三个时间戳：`rate_limited_until`（429）、`overload_until`（529/503）、`temp_unschedulable_until`（402/5xx/网络）；
  `status=error` 表示鉴权失败，需管理员重新启用（启用即清空错误与全部冷却，含窗口冷却）。
- 订阅窗口（迁移 3 + 4，`gateway.md` §3/§5.1）：`executor`（`direct | ccr | ccr_worker`，后两者只有 oauth+anthropic 可设；`ccr_worker` = 节点真 Claude Code worker 模式，见 `ccr-supply.md` §8.1）；`window_used`
  （绑定窗口已用比例 0..1，NULL = 未采样）、`window_reset_at`、`window_checked_at`、`window_exhausted_until`（窗口级冷却，
  `listCandidates` 单独过滤，不计入 `coolingUntil`）、`window_5h_used/_reset_at`、`window_7d_used/_reset_at`、`window_reason`、
  `model_cooldowns`（迁移 9，JSON `{scope:{until,reason,used,resetAt}}`，目前 scope 只有 `fable`；gateway.md §3）。
  来源：网关对 Anthropic OAuth 账户每个响应的 `anthropic-ratelimit-unified-*` 头被动采样，以及 console 的 usage 探测。凭证 JSON 另含 `orgUuid`、`environmentId`。
- 原样透传（迁移 19，gateway.md §4a）：`raw_passthrough`（1 = 同协议请求原样转给中转，不做 Claude Code 归一 / 指纹 / 身份固定）。
- 上号（迁移 5，docs/onboarding.md）：`rpm_limit`（每分钟请求上限，0 = 不限，迁移 22 后由共享 SQLite 滑动窗口执行）、
  `bound_proxy_id → node_proxies(id)`（账号固定代理全生命周期绑定；同组织默认两号共享一个 IP，正常容量不足才用第三槽，上限三号含有效预约；绑定代理非 `live` 时账户跳过调度但不算失败、不冷却；
  删除账户时同事务释放）。

### model_prices
- 有行 = 覆盖（目录模型）或新增（自定义模型）；`enabled=0` 下架。四个单价单位 USD / 1M tokens。
- 有覆盖行时按四个计量项计价（5m/1h 缓存写并入 `cache_write_per_m`）；无覆盖行时用目录全部 SKU。

### usage_logs
- 每次请求一行，`request_id` 唯一（结算幂等键）。失败请求 `status_code ≥ 300`、费用 0、`error_code` 有值。
- `input_tokens` **不含**缓存读；`cache_read_tokens`、`cache_write_tokens` 单列。`usage_estimated=1` 表示上游未报告或报告非法 usage，按请求正文和已生成文本估算；图片/文档按媒体块估算，不按 base64 字节收费。计数必须为有限非负整数，每项及提示词合计最多十亿。
- 费用三列：`total_cost`（标准价）、`actual_cost = q8(total × rate_multiplier)`（实扣）、`provider_earning = q8(total × payout_rate)`（仅号商账户）。
- `account_id` / `provider_id` 不设外键，账户删除后历史仍可查。
- `account_switched`（迁移 15）：1 = 该请求命中了仍有效的粘性会话却被迫落到另一个账号（网关 ForceCacheBilling，gateway.md §6），
  提示词缓存被迫重建；`cache_refund_id` = 返还它的 `cache_refunds` 行（NULL = 尚未返还）。部分索引
  `idx_usage_cache_refund_pending(user_id, created_at) WHERE account_switched=1 AND cache_refund_id IS NULL` 就是"待返还集合"。

### cache_refunds（迁移 15，2026-10-21）
缓存重建返还：每个用户每轮一行。新请求在结算时固定多付的缓存费快照 = 实付（`actual_cost` 口径，使用该次结算单价）−
"该请求全部提示词 token（input + cache_read + cache_write）都按缓存读价"的理论价，裁到 `[0, actual_cost]`；
按 settings `cache_refund_percent`（默认 80）返还。改价不重算旧快照；没有快照的历史行不自动返还，也不回填、修改其 `cache_refund_id`。返还顺序：**先冲减授信已用**（`credit_used_usd`，最多到 0，写 `credit_events.kind=cache_refund`，
不动 `credit_settled_at`），**余下加到预付余额**（`ledger.kind=cache_refund`，`ref` = 本行 id）。`rows / excess_usd / percent / refund_usd /
to_credit_usd / to_balance_usd / ledger_id / credit_event_id / period_from / period_to / note / created_by`（`scheduler` 或管理员 id）。
返还比例为 0 或差额四舍五入为 0 时仍写一行（金额 0），覆盖的 usage 行同样被绑定，不再计入待返还。
console 定时任务每 `cache_refund_interval_sec`（默认 86400）跑一轮，上次运行时刻存 settings 表的 `cache_refund_last_run_at`（不在 SETTING_DEFAULTS 里，
管理台不显示也不会覆盖）；管理员可随时对单个用户或全体手动返还，手动不改定时时钟。

### affinity_bindings（迁移 16，2026-10-21）

网关「粘性会话」与「设备亲和」两张进程内表的写穿副本（gateway.md §3「跨发布保持」，core `affinity.ts`）。
`key` 主键即网关的会话键 `s:<api_key_id>:<session>:<model>` 或设备键 `d:<api_key_id>:<device_id>`；`kind` = `session`（`account_id` 有值）
或 `device`（`accounts` 为 JSON 数组，按记录顺序，最多 `device_affinity_pool_size` 个）；`expires_at` 为 unix 毫秒，读到已过期的行视为不存在，
网关每 10 min 删一次过期行。只有网关读写；两个蓝绿实例在交接期间共用，所以新实例接着旧实例的绑定继续，不会把对话 / 设备重新发牌。
不是账单数据，可以清空（后果只是等同一次冷启动）。

### worker_turn_memory（迁移 17，2026-10-22）

网关 `ccr/session-memory.ts` 的 `SessionMemory` 写穿副本（worker-sessions.md §1）：`key` = reuseKey（账号 | 会话键 | 模型 | 系统提示 | 工具 | 思考 | max_tokens
的 sha256），`data` = 整条 TurnMemory JSON（每个内容块的哈希、上一轮回答折叠文本、节点侧轮次计数、累计 usage 基线、挂起的原生工具调用），
`expires_at` unix 毫秒（= 进程内 TTL 10 min，与节点 idle TTL 一致）。只有网关读写；蓝绿切换后新实例据此对同一对话算出 `continue`，
不再把全量历史折叠进新进程。同样不是账单数据，可清空（后果 = 下一轮 fresh）。

### ledger
- `kind`：`redeem | admin_adjust | payout | legacy_topup | cache_refund`（以及迁移来的旧 kind，如 `redeem`、`admin_adjust`）。
- `amount_usd` 正入负出；`balance_after` 为变动后余额（迁移来的历史行记 0）。用量扣费**不**写 ledger。

### redeem_codes
- `code` 24 位无歧义大写字母数字；`status`：`unused | used | disabled`。核销是乐观锁：
  `UPDATE … SET status='used' WHERE code=? AND status='unused' AND (expires_at IS NULL OR expires_at > now)`。

### nodes / node_bind_codes
- `nodes.secret_hash` = sha256(节点密钥)；`online`/`in_flight`/`last_heartbeat_at` 由 WS 控制面更新。
  心跳的 `ccWorker{enabled, claudeVersion, maxConcurrency, active, queued}` 合并进 `deploy_meta.ccWorker`（worker 模式遥测，ccr-supply.md §8.1）。
- `nodes.metrics`（迁移 12，2026-10-17）：最近一次心跳的完整快照 JSON `{reportedAt, inFlight, acceptingSessions, healthy, host, egress,
  ccWorker(含 pool), proxies{total, live, dead, unknown}}`，每次心跳整体覆盖；节点监控看板 `GET /api/admin/nodes/monitor` 读它
  （docs/operations.md §7.2）。不是历史时序，只有"现在"。
- `node_proxies`（迁移 2 + 5）：节点代理池台账，`url_enc` 加密存储，`status`（`live|dead|unknown`）/ `last_check_at`
  由节点心跳回写；`bound_account_id → accounts(id)`（NULL = 空闲）是一号一代理绑定的另一半，与 `accounts.bound_proxy_id`
  同事务写入、删除账户时同事务置 NULL（docs/onboarding.md §6）。

### onboarding_jobs
- 上号异步任务（迁移 5，docs/onboarding.md §5）：`id, requester_id, scope('admin'|'provider'), method
  ('session_key'|'auth_url'), node_id, proxy_id, params_json, payload_enc, authorize_url, status
  ('pending_callback'|'working'|'done'|'failed'), account_id, error, created_at, updated_at`。
- `payload_enc` 存 sessionKey 或 PKCE `{codeVerifier, state}`（加密）；job 到 `done`/`failed` 立即清 NULL。
- `params_json` 只放非密参数（concurrencyLimit/rpmLimit/name/note/groupId）；号商只能看自己的 job。
- 绑定码 `bind_<32hex>`，10 分钟有效，一次性（`used_at`）。

### settings
| key | 默认 | 含义 |
|---|---|---|
| `default_group_id` | `default` | 新建 Key 未指定分组时使用 |
| `provider_default_payout_rate` | `0.6` | 审核通过时的默认分成 |
| `announcement` | `""` | 控制台顶部公告 |
| `api_base_url` | `https://api.1dayapi.com` | 接入指南展示的网关地址 |
| `max_keys_per_user` | `50` | 每用户 Key 上限 |
| `anthropic_window_threshold_percent` | `95` | 订阅窗口停调阈值（100 = 关） |
| `window_poll_interval_sec` | `300` | 订阅账户巡检 / 令牌保活间隔 |
| `sticky_session_ttl_sec` | `1800` | 粘性会话 TTL |
| `cc_shape_policy` | `observe` | Claude Code 形态判定策略：`observe` / `downgrade` / `reject`（gateway.md §2a） |
| `onboard_default_executor` | `ccr_worker` | 上号落库账号的默认执行器（`ccr_worker` / `ccr`，onboarding.md） |
| `onboard_default_concurrency` / `onboard_default_rpm_limit` | `9` / `100` | 上号表单留空时新账号的并发 / RPM 上限 |
| `direct_cc_entrypoint_normalize` / `direct_cc_version_pin` | `1` / `2.1.303` | 直连「一账号一软件」（docs/gateway.md §3）：UA 入口后缀归一化、Claude Code 版本统一；pin 留空 = 透传 |
| `proxy_release_cooldown_sec` | `86400` | 删除 error 状态账号（401 吊销 / on hold）释放的代理在此时长内不分配给新账号（`node_proxies.cooldown_until`）；0 = 关闭 |
| `onboard_cooldown_min_sec` / `onboard_cooldown_max_sec` | `3720` / `4200` | 新号冷静期：授权完成后随机 62～70 分钟不参与调度（写 `temp_unschedulable_until`）；两项为 0 = 关闭 |
| `window_passive_max_age_sec` | `21600` | 账号超过此秒数无任何窗口采样才主动探测 usage（被动优先，ccr-supply.md §7） |
| `ccr_cache_baseline_worker` | `16600` | worker 模式身份上下文缓存基线（token），客户可见缓存 = 上游缓存 − 基线（ccr-supply.md §7.1） |
| `ccr_cache_baseline_cloud` | `28000` | 云端会话模式同上 |
| `cache_refund_enabled` / `cache_refund_percent` / `cache_refund_interval_sec` | `1` / `80` / `86400` | 缓存重建返还（本节 cache_refunds）：是否自动跑、返还差额的百分比（0 = 只标记不返钱）、定时间隔（≥ 3600）。关闭只停定时任务，手动返还仍可用 |

`usage_logs.cc_shape`（迁移 7）：`genuine` / `suspect` / NULL（非 CC UA 请求），索引 `idx_usage_cc_shape(cc_shape, created_at)`。

`usage_logs` 可观测列（迁移 10）：`error_message`（网关解释 + `upstream <status>: <上游错误体前 500 字>`，≤1000 字）、`mode`（服务该请求的
协议模式，如 `passthrough-anthropic` / `ccr-anthropic`）、`upstream_status`（上游 HTTP 状态，无上游调用为 NULL）、`node_id`；索引
`idx_usage_status_time(status_code, created_at)` 供错误日志页过滤。

## 4. 不变量

1. 用户余额只有两条写路径：`settleRequest`（用量扣费 / 号商收益）与 `applyLedger`（兑换、调账、结算出账、缓存返还，同时写 ledger）。
   授信字段同理只有四条写路径：`settleRequest`（累计已用）、`setCreditLimit`、`settleCredit`、`refundCredit`（后三者各写一行 `credit_events`；
   `refundCredit` 只由 `runCacheRefund` 调用，不改 `credit_settled_at`）。
2. 结算在单个 `BEGIN IMMEDIATE` 事务内：插 `usage_logs`（只忽略 `request_id` 唯一冲突；其他约束失败显式抛错）和结算单价快照 → 扣用户余额 → 累加 Key `used_usd` → 号商加收益。
3. 结算允许单次后付费透支（余额变负），不丢单；准入除余额/Key 额度外，还受共享用户并发和在途金额预约约束。没有可用余额/授信时 402，无在途容量时 429。
4. 对迁移之后的变动：`users.balance_usd` = Σ`ledger.amount_usd` − Σ`usage_logs.actual_cost`（consumer/admin），
   或 Σ`ledger.amount_usd` + Σ`usage_logs.provider_earning`（provider）。
   `users.credit_used_usd` = Σ授信累计（settleRequest 的授信部分）− Σ`credit_events(settlement).amount_usd` − Σ`credit_events(cache_refund).amount_usd`。
6. 每行 `usage_logs` 最多被一行 `cache_refunds` 覆盖（`cache_refund_id` 只从 NULL 写一次），同一笔多付不会返两次；
   `cache_refunds.refund_usd = to_credit_usd + to_balance_usd`。
5. 兑换码核销与入账在同一事务内。

## 5. 迁移

迁移框架：`schema_migrations(version)` + `packages/core/src/migrations.ts` 中的顺序列表，任一进程打开库时执行；
每个迁移在 `foreign_keys=OFF` + `BEGIN IMMEDIATE` 中运行，事务内再查一次版本防并发重复。

**迁移 1（v3 schema + 从 v2 导入）**：

- 新库：直接建 v3 表并插入 `default` 组。
- 检测到旧表 `auth_keys`（v2 库）时：先把所有旧表改名为 `legacy_v2_*`（`auth_keys sessions wallets transactions usage_logs
  provider_nodes provider_bind_codes provider_credentials groups accounts account_groups redeem_codes usage_billing_dedup`，
  以及 Auth v1 残留的 `users api_keys`），再建 v3 表并搬数据：
  - `users` ← `auth_keys` ⨝ `wallets`（id 不变；`label` 为空时名字为 `<role>-<preview 末 4 位>`；已吊销 → `disabled`）。
  - 每个 consumer/admin 生成一把 legacy API Key：**复用旧登录密钥的哈希**，所以旧客户端里配置的 `1dk_consumer_…`
    仍能调用推理；`name='legacy'`、`key_enc` NULL、分组 / 额度沿用旧值。
  - `groups`（丢弃 `platform`）、`account_groups`、`redeem_codes`、`nodes`、`node_bind_codes`、`user_sessions` 对应搬迁，时间改为 ISO-Z。
  - `accounts`：凭证用当前主钥解密后重新包成 JSON 加密；`source=node` → `type=oauth, route=node`，`payout_rate=0.6`；
    `source=direct` → `type=apikey, route=direct`；全部 `approved`。解密失败的行跳过并打日志。
  - `usage_logs`：`cost_usd` → `actual_cost`，`total_cost = actual / rate`，挂到该用户的 legacy Key。
  - `ledger` ← `transactions` 中非 `charge` 的行（`topup` → `legacy_topup`，`balance_after=0`，`meta` 进 `note`）。
- 旧表全部保留，不删除。实测：本地 v2 库（17 用户 / 176 用量 / 7 账户）迁移后余额总额一致，重复启动不再执行。

**迁移 2**：节点代理池表 `node_proxies` / `node_proxy_assignments`，`nodes` 加 `capacity`、`deploy_meta`（幂等列检查）。

**迁移 3（CCR）**：`accounts` 加 `executor`、`window_used`、`window_reset_at`、`window_checked_at`、`window_exhausted_until`
（`PRAGMA table_info` 幂等列检查；新库由 `SCHEMA_V3` 直接带上）。**迁移 4**：加 `window_5h_used/_reset_at`、`window_7d_used/_reset_at`、
`window_reason`。单元测试 `packages/core/test/migration3.test.mjs` 覆盖新库、降级后重跑、调度过滤与窗口回写。

**迁移 5（上号，docs/onboarding.md §5）**：`accounts` 加 `rpm_limit`、`bound_proxy_id`；`node_proxies` 加
`bound_account_id`；新表 `onboarding_jobs`（列语义见上）。幂等列检查 + `CREATE TABLE IF NOT EXISTS`；
单元测试 `packages/core/test/migration5.test.mjs`。

**迁移 15（缓存重建返还，2026-10-21）**：`usage_logs` 加 `account_switched`、`cache_refund_id` + 部分索引，新表 `cache_refunds`。

**迁移 16（亲和落盘，2026-10-21）**：新表 `affinity_bindings` + `idx_affinity_expires`（本节 affinity_bindings）。任一进程打开库都会执行，
所以网关蓝绿切换时新实例自己建表，无需重启 console。

**迁移 17（worker 轮次记忆落盘，2026-10-22）**：新表 `worker_turn_memory` + `idx_worker_turn_expires`（本节 worker_turn_memory）。

**迁移 21（实际组织隔离，2026-10-27）**：仅新增结构，不执行旧数据推断、回填、清理或改写。

| 结构 | 用途 |
|---|---|
| `upstream_teams` | 实际 Claude 组织 UUID、管理员可见名称、启停状态 |
| `accounts.team_id` | 新管理订阅账号的组织；旧行保持 NULL，不自动参与新隔离池 |
| `node_proxies.team_id/isolation_version/exit_ip/resource_key` | 新出口的组织、隔离版本和实测 IP 资源；旧资源不自动认领 |
| `onboarding_jobs.team_id/isolation_version/egress_started_at/proxy_resource_key/reservation_account_id` | 授权预期、是否实际出站、容量预留；原账号重新授权不重复计数 |
| `proxy_team_claims` | 出口资源的永久组织认领；删除当前池成员或账号不清除 |
| `proxy_quarantine` | 发现失败、身份冲突等不可直接复用的资源 |
| `proxy_team_events` | 分配、释放、发现、冲突与重新授权事件，含账号、节点、作业、操作者、原因和时间 |
| `conversations` | 每个 API Key 下的持久对话、当前组织/阶段、短租约与清空状态 |
| `conversation_generations` | 对话各阶段的组织与切换原因 |
| `conversation_boundaries` | 每阶段、每分支的旧历史边界指纹与 nonce，防止旧历史和 worker 状态回流 |

三个 `proxy_*` 归属/隔离/事件表有禁止 UPDATE / DELETE 的触发器。出口容量从账号绑定和有效作业预留计算，不能使用旧的单值 `bound_account_id` 或心跳分配快照计数。不同 URL 或节点观察到的相同规范化公网 IP 共用容量上限三。

组织字段只在管理员 API shape 中输出，不能将数据库完整行直接返回给 provider、consumer 或 ops。完整不变量与发布状态见 [`team-isolation.md`](team-isolation.md) 和[发布记录](deployment/team-isolation-2026-10-27.md)。

**迁移 22（审计修复，2026-10-28）**：仅新建表/索引和给 `onboarding_jobs` 增加 nullable `expires_at`。不更新旧表内容、不补造历史价格。

| 新结构 | 用途 |
|---|---|
| `usage_pricing_snapshots` | 按 request_id 固定模型规范 ID、价格 JSON、标准费用和缓存返还差额；与 usage/扣款同事务写入 |
| `gateway_request_budgets` | 所有网关共享用户/Key 在途金额预约；90 秒租期、30 秒续期，正常完成释放，崩溃后按过期时间回收 |
| `gateway_account_leases` / `gateway_account_hits` | 所有蓝绿网关共享账号并发/RPM，避免双倍接入 |
| `ccr_archive_jobs` | 仅新建清理任务；加密的清理凭据/路由快照、尝试次数、重试期限及完成状态，支持节点离线后补归档 |
| `onboarding_jobs.expires_at` | 新任务绝对预约截止；旧行不回填，v1 作业可按原时间派生期限，v0 作业不自动维护 |

### 结算持久化与恢复

生产网关使用 `settleRequestDurably`：先把 requestId、用量、倍率、实际费用及价格快照写入 `data/settlement-journal/` 并 fsync，再提交 SQLite 账本事务。事务失败保留意图；每 10 秒自动重放，推理准入也尝试恢复。重放始终用原快照，以 `usage_logs.request_id` 幂等，不重新调用模型。

有未成功补账条目或日志目录不能可靠写入时，新推理返回 503 `settlement_unavailable`，并记录明确错误。数据库仍可访问时管理查询继续可用。非流式响应在安全记录后交付；流式已交付的增量不能撤回，进程在终止事件与持久化之间突然退出仍有最终用量丢失窗口。此日志解决已生成结算意图后的 SQLite 失败，不能声称消除磁盘/主机同时损坏或所有执行中崩溃。

### 默认在途额度政策

`USER_MAX_INFLIGHT=4`、`USER_MAX_INFLIGHT_USD=10`（环境变量，只接受正有限数；非法配置回退默认值）。网关按请求提示词和最大输出估计费用，按组倍率预约。单请求预约取「估算费用、10 美元、用户当前余额加剩余授信、Key 剩余额度」的最小值；单次至少预约 0.000001 美元（再受可用资金封顶）。同用户所有 Key/网关合计不得超过并发上限、在途金额上限及实际可用资金，单 Key 同样扣除在途预约。例：剩余 0.01 美元仍可启动一次预计更贵的后付费请求，但第二次请求等待第一笔释放资金。

这是准入预约，不提前写账或扣款；最终按实际用量结算，单次请求可以超出估计。超出资金的并发累计敞口得到限制，不宣称估计预算是上游实际费用的硬上限。用户/Key/旧账本不增加回填字段。

## 6. data/ 目录

| 文件 | 说明 |
|---|---|
| `1dayapi.db`（+ `-wal`/`-shm`） | 数据库 |
| `provider-cred.key` | 凭证主钥（0600，自动生成；`PROVIDER_CRED_KEY` 覆盖）。丢失则所有账户凭证与可查看 Key 无法解密 |
| `internal.key` | gateway → console 内部令牌（0600，自动生成；`INTERNAL_TOKEN` 覆盖）。两个进程必须读到同一份 |
| `admin-key.txt` | 首次启动无管理员时生成的登录密钥（0600） |
| `settlement-journal/` | 0600 结算意图文件；只能在确认已记账后由幂等恢复删除，不得当缓存清空 |
| `backups/` | v3 重构前的源码 / 数据库快照 |
