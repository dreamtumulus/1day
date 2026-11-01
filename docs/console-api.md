# 控制台 API（apps/console，v3）

> 现状参考。代码：`apps/console/src/routes/{public,user,provider,admin}.ts`、`node/routes.ts`、`session.ts`、`shapes.ts`。
> 契约见 [`v3-design.md`](./v3-design.md) §8。

## 0. 约定

- 端口 8401。成功 `{data: …}`；错误 `{error: {code, message, type}}`（`type` 由状态码推出）。
- 鉴权：**只认会话 cookie** `oneday_session`（`POST /auth/login` 下发，7 天，`HttpOnly; SameSite=Lax`，`COOKIE_SECURE=1` 时加 `Secure`）。
  无会话 401 `unauthorized`；角色不符 403 `role_not_permitted`。
- 角色守卫：用户端点 `consumer | admin`；号商端点仅 `provider`；管理端点仅 `admin`，其中账号池子集（账户列表 / 启停 / 探测 / 上号 / 重新授权 / 分组与节点只读）另对 `ops` 开放（`auth.md` §2）。
- 分页：`page`（1 起）、`pageSize`（1–100，默认 20）→ `{items, total, page, pageSize}`。
- 日期：`from` / `to` 为 `YYYY-MM-DD`（UTC，含两端）。时间字段均为 ISO-8601 UTC。
- 请求体校验失败 400 `invalid_request`（具体字段写在 message 里）；不存在 404 `<thing>_not_found`。
- CORS 白名单 `CONSOLE_CORS_ORIGINS`（逗号分隔，默认 `http://localhost:8402,http://127.0.0.1:8402`），带凭证。
- `TRUST_PROXY=1` 开启 Fastify `trustProxy`，部署在 nginx 后必须开，否则登录限流按代理 IP 计。内部端点不受影响（看 socket 地址 + 内部令牌）。

## 1. 公共

| 方法 路径 | 请求 | 响应 data / 说明 |
|---|---|---|
| `GET /health` | — | `{ok, service:"console", version:"v3"}`（无信封） |
| `POST /auth/login` | `{key}` | `Me`；设 cookie。错误：401 `invalid_login_key` / `user_disabled`；同 IP 10 分钟失败 ≥ 20 次 → 429 `too_many_attempts` |
| `GET /auth/me` | — | `Me = {id, role, name, status, keyPreview, balanceUsd}` |
| `POST /auth/logout` | — | `{ok}`，清 cookie |
| `GET /api/models` | — | 启用模型（目录形状 `CatalogModel[]`，自定义模型合成） |
| `GET /api/models/pricing` | — | 启用模型价目（`PricingEntry[]`；覆盖价 / 自定义模型合成 SKU） |
| `GET /api/site` | — | `{announcement, apiBaseUrl}` |

已删除：`/api/keys/self-issue`、`/api/topup`、`/api/wallet`、`/api/usage`、`/api/referral`、`/api/groups`、`/api/redeem`、
`/api/usage-limits`、`/api/model-availability`、`/api/client-cache`、`/api/client-errors`、旧 `/api/admin/keys*`（签发/吊销登录密钥）与 `/api/admin/stats`。

## 2. 用户 `/api/user/*`（consumer、admin）

| 方法 路径 | 请求 | 响应 data |
|---|---|---|
| `GET /overview` | — | `{balanceUsd, keyCount, today, month, daily(14 天), topModels:[{model, requests, costUsd}]}`；`today/month = {requests, costUsd, totalCostUsd, tokens, earningUsd, errors}`；`daily[] = {day, requests, costUsd, tokens, earningUsd, errors}` |
| `GET /groups` | — | 可选分组（active 且非专属，或已授权的专属组）：`Group & {isDefault}` |
| `GET /keys` | — | `ApiKey[]` |
| `POST /keys` | `{name?, groupId?, quotaUsd?, expiresAt?}` | 201 `ApiKey & {key}`（明文仅此一次）；不给分组用 `default_group_id`（不可用时取第一个可用组）；超上限 400 `key_limit_reached`；分组不可用 400 `group_not_available` |
| `PATCH /keys/:id` | `{name?, groupId?, quotaUsd?, expiresAt?(null 清除), status?: active\|disabled}` | `ApiKey` |
| `POST /keys/:id/reveal` | — | `{key}`；legacy Key → 400 `key_not_revealable` |
| `DELETE /keys/:id` | — | `{ok}` |
| `GET /usage` | `page,pageSize,from,to,keyId,model,status(ok\|error)` | 分页 `UsageRow` |
| `GET /usage`（补充过滤） | `code`（error_code）、`mode`、`nodeId`、`statusCode`、`q`（error_message / error_code 模糊、request_id 精确） | 错误日志页用 |
| `GET /errors/summary` | 同 `/usage` 的过滤参数 | `{totalErrors, totalRequests, byCode[{code,statusCode,count}], byStatus, byMode, byAccount[{accountId,name,count}], hourly[{hour,count}]}`，只统计 `status_code >= 400` |
| `GET /usage/stats` | `from,to,keyId,model,status` | `{totals:{requests, costUsd, inputTokens, outputTokens, cacheTokens}, daily:[{day, requests, costUsd, tokens}], byModel:[{model, requests, costUsd, inputTokens, outputTokens}]}` |
| `GET /usage/breakdown` | `bucket(hour\|day，缺省 day)` + 同 `/usage` 的过滤 | 按小时 / 按天 × 密钥的消耗：`{bucket, by:"key", cells:[{t, key, requests, errors, costUsd, tokens, lastAt}], series:[{key, name, requests, errors, costUsd, tokens, lastAt}]}`。`t` 为桶起点 ISO（小时 `…T05:00:00Z`、天 `…T00:00:00Z`，均 UTC）；`requests` 只计成功（<300），`errors` 为失败数，`costUsd` 含失败请求的计费；`series` 按费用倒序，`lastAt` 为该序列最近一次请求时间。小时视图服务端固定只看最近 31 天；结果最多 50000 个 cell（2026-10-23） |
| `GET /ledger` | `page,pageSize` | 分页 `{id, kind, amountUsd, balanceAfter, ref, note, createdAt}`；`kind` 含 `cache_refund` |
| `GET /cache-refund` | — | 缓存重建返还概览（data-model.md cache_refunds）：`{enabled, percent, intervalSec, pending:{rows, excessUsd, refundUsd, percent, from, to}, lastScheduledRunAt, nextScheduledRunAt, totals:{runs, refundUsd, toCreditUsd, toBalanceUsd, lastRefundAt}}` |
| `GET /cache-refunds` | `page,pageSize` | 分页 `CacheRefund = {id, userId, userName, rows, excessUsd, percent, refundUsd, toCreditUsd, toBalanceUsd, ledgerId, creditEventId, periodFrom, periodTo, note, createdBy(scheduler\|管理员 id), createdAt}` |
| `POST /redeem` | `{code}`（大小写、空格、`-` 不敏感） | `{valueUsd, balanceUsd}`；失败 400 `code_invalid_or_used` |

管理员用这些端点管理"自己的" Key，且建 Key 时不受可用分组限制。

- `ApiKey = {id, userId, userName, name, keyPreview, groupId, groupName, status, effectiveStatus(active|disabled|expired|exhausted), quotaUsd, usedUsd, expiresAt, lastUsedAt, createdAt, revealable}`
- `UsageRow = {id, requestId, createdAt, keyName, model, upstreamModel, endpoint, stream, statusCode, errorCode, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, usageEstimated, rateMultiplier, actualCost, durationMs, firstTokenMs, ccShape(genuine|suspect|null), errorMessage, mode, upstreamStatus, nodeId}`

## 3. 号商 `/api/provider/*`（provider）

| 方法 路径 | 请求 | 响应 data |
|---|---|---|
| `GET /overview` | — | `{balanceUsd(未结算), lifetimeEarningUsd, paidOutUsd, today:{requests, earningUsd}, month:{…}, daily:[{day, requests, earningUsd}], accounts:{total, active, pending, error}, nodes:{total, online}}` |
| `GET /nodes` | — | `NodeRow[]` |
| `POST /bind-codes` | — | 201 `{code:"bind_…", expiresAt}`（10 分钟） |
| `DELETE /nodes/:id` | — | 删除节点、断开其 WS（close 4003）；同事务释放节点资源：绑定在其代理上的账户解绑并 `disabled`（`error_message` 说明原因，代理没了不能再调度）、删 `node_proxies` / `node_proxy_assignments`、该节点上进行中的上号任务置 `failed` |
| `GET /accounts` | — | `ProviderAccount[]` |
| `POST /accounts` | `{name, platform, type: apikey\|upstream, protocol?, baseUrl?, apiKey, models?, modelMapping?, route?: direct\|node}` | 201 `ProviderAccount`，`reviewStatus=pending` |
| `PATCH /accounts/:id` | `{name?, platform?, protocol?, baseUrl?, apiKey?, models?, modelMapping?, status?: active\|disabled}` | 改凭证 / URL / 平台 / 协议 → 退回 `pending`（同请求显式给的 `status` 仍生效）；OAuth 账户除 `name`/`status` 外任何字段都 400；error 状态的账户必须更新凭证才能重新启用 |
| `DELETE /accounts/:id` | — | `{ok}`（用量历史保留；同事务释放其绑定代理 `node_proxies.bound_account_id` → NULL，docs/onboarding.md §6.4） |
| `POST /accounts/onboard` | 上号（docs/onboarding.md §4）：方式一 `{method:"session_key", sessionKey, orgUuid?, nodeId, proxyId?, concurrencyLimit?, rpmLimit?, name?}`；方式二第一步 `{method:"auth_url", nodeId, proxyId?, ...}`；方式二第二步 `{method:"auth_url", jobId, callbackUrl}` | `{jobId, status}`（方式二第一步另含 `authorizeUrl`）；只能选**自己的**节点/代理（他方节点 404）；落库账户 **直接 `approved`**、挂该号商的 `onboardGroupId` 分组（未设则默认分组）、不加新号冷静期（2026-10-26 起，此前为 `pending` 待审核）；错误码 `proxy_pool_empty`/`proxy_bound`/`proxy_cooling`（代理处于释放冷静期，仅平台账号释放的代理会有，docs/onboarding.md §1 原则 3）/`node_offline`/`callback_invalid`；任务态错误见 docs/onboarding.md §4 |
| `GET /accounts/onboard/:jobId` | — | `{jobId, status: pending_callback\|working\|done\|failed, accountId?, error?, authorizeUrl?}`（只能看自己的 job） |
| `POST /accounts/:id/reauth`（admin / ops） | 同上号 body（`session_key` 或 `auth_url` 两步） | 原地重授权（docs/onboarding.md §11）：限 Anthropic oauth 且非 active（400 `account_active`）；钉账号自己的节点与绑定代理；身份不符作业 `account_mismatch`；完成 `reused: true` |
| `GET /nodes/:id/proxies` | `free=1` | 代理选择器视图 `[{id, label, host, port, status, bound}]`（无用户名密码）；`free=1` 只返回未绑定且探活 `live` 的，按 `lastCheckAt` 最久优先；仅限自己的节点（他方 404） |
| `GET /earnings` | `page,pageSize,from,to,accountId` | 分页 `{id, createdAt, accountId, accountName, model, inputTokens, outputTokens, cacheTokens, totalCost, providerEarning, statusCode}` + `sumEarningUsd`（只含成功请求） |
| `GET /ledger` | `page,pageSize` | 分页 ledger（结算出账、调账） |

- `ProviderAccount = {id, name, platform, type, executor(direct|ccr|ccr_worker), protocol, baseUrl, models, route, nodeId, reviewStatus, reviewNote, status, errorMessage, payoutRate, accountEmail, subscriptionType, coolingUntil, lastUsedAt, createdAt, requests30d, earning30d, modelCooldowns(admin only: {fable:{until,reason,used,resetAt}})}`
- `NodeRow = {nodeId, providerId, providerName, platformNode, nodeVersion, osType, osArch, online, acceptingSessions, inFlight, capacity, accountCount, proxyCount, deployMeta, lastHeartbeatAt, createdAt}`（`platformNode` = 注册者是管理员的平台节点）

## 4. 管理员 `/api/admin/*`

### 4.1 仪表盘与用户

| 方法 路径 | 请求 | 响应 data |
|---|---|---|
| `GET /dashboard` | — | `{users:{consumer, provider, admin, disabled}, today, month, daily(30 天), topModels, topUsers:[{userId, name, requests, costUsd}], accounts:{total, active, pending, error, cooling}, nodes:{total, online}, balances:{consumerTotalUsd, providerUnsettledUsd, creditLimitTotalUsd, creditOutstandingUsd}, cacheRefunds:{monthUsd, monthRows, pendingUsd, pendingExcessUsd, pendingRows, pendingUsers, percent}}`；`accounts.cooling` 含三个错误冷却与 CCR 窗口冷却（`window_exhausted_until > now`） |
| `GET /users` | `page,pageSize,role,status,q` | 分页 `AdminUser` |
| `POST /users` | `{role: admin\|consumer\|provider\|ops, name, note?, initialBalanceUsd?, allowedGroupIds?}` | 201 `AdminUser & {loginKey}`（明文仅此一次；初始余额写 `admin_adjust`） |
| `GET /users/:id` | — | `AdminUser & {keys: ApiKey[], recentLedger(20), recentCreditEvents(20), recentCacheRefunds(20), cacheRefund}`（`cacheRefund` 同用户端 `GET /api/user/cache-refund`） |
| `GET /users/:id/cache-refund` | — | 该用户的缓存返还概览（同上） |
| `POST /users/:id/cache-refund` | `{note?}` | 立即返还该用户全部待返还请求（不等定时）→ `{refund: CacheRefund, summary}`；无待返还 400 `nothing_pending`；号商 400 |
| `GET /users/:id/cache-refunds` | 分页 | 该用户的 `CacheRefund[]` |
| `GET /cache-refunds` | 分页 | 全站 `CacheRefund[]`（带 `userName`）+ `pending:{users, rows, excessUsd, refundUsd, percent, from, to}` |
| `POST /cache-refund/run` | `{note?}` | 立即为所有有待返还的用户返还 → `{users, rows, excessUsd, refundUsd, toCreditUsd, toBalanceUsd}`；不改定时任务的时钟 |
| `PATCH /users/:id` | `{name?, note?, status?, allowedGroupIds?, onboardGroupId?}` | 禁用即清会话；禁用号商同时断开其节点；不能禁用自己；`onboardGroupId`（仅 provider，2026-10-26）= 该号商自己上的号授权后直接挂入的分组，`null` 回到默认分组 |
| `POST /users/:id/reset-login-key` | — | `{loginKey}`（旧密钥立即失效、清会话） |
| `POST /users/:id/adjust-balance` | `{amountUsd(≠0), note?}` | `{balanceUsd}`（ledger `admin_adjust`，预付余额） |
| `POST /users/:id/credit-limit` | `{limitUsd(≥0), note?}` | 设置授信额度 → `{creditLimitUsd, creditUsedUsd, balanceUsd, availableUsd, creditSettledAt}`；credit_events `limit_set`（仅 consumer/admin） |
| `POST /users/:id/settle` | `{amountUsd?(>0), note?}` | 结算本期已用（缺省全额）：`credit_used_usd -= amount`，授信恢复；超过待结算额 400 `amount_exceeds_outstanding`，无待结算 400 `nothing_to_settle`；返回同上加 `settledUsd`；credit_events `settlement` |
| `GET /users/:id/credit-events` | 分页 | 授信 / 结算记录 `{id, kind, amountUsd, limitBefore, limitAfter, usedBefore, usedAfter, note, createdBy, createdAt}` |
| `POST /users/:id/payout` | `{amountUsd(>0), ref?, note?}` | 仅号商；超过未结算余额 400 `insufficient_balance`；ledger `payout`（负数） |
| `DELETE /users/:id` | — | 有用量记录（作为用户或号商）→ 400 `user_has_usage`；不能删自己；号商：同事务释放其账户绑定的代理、清掉其节点的代理池/分配/上号任务并断开节点 |

`AdminUser = {id, role, name, loginKeyPreview, status, balanceUsd, note, keyCount, requests30d, cost30d, ccSuspect30d, lastRequestAt, lastLoginAt, createdAt, allowedGroupIds, onboardGroupId}`；`lastRequestAt` = 该用户 usage_logs 里最近一条（任意状态）的 `created_at`，从未调用为 null（2026-10-23）

### 4.2 Key 与分组

| 方法 路径 | 请求 | 响应 data |
|---|---|---|
| `GET /keys` | `page,pageSize,userId,groupId,q` | 分页 `ApiKey` |
| `PATCH /keys/:id` | 同用户 PATCH，分组不受可用性限制 | `ApiKey` |
| `GET /groups` | — | `Group & {keyCount, accountCount}`，按 `sortOrder` |
| `POST /groups` / `PATCH /groups/:id` | `{name, description?, rateMultiplier(0–1000), modelAllowlist?: {enabled, models[]}\|null, isExclusive?, status?, sortOrder?}` | 同名 409 `group_exists`；白名单启用且为空 400 `invalid_allowlist`；`default` 不可停用 400 `group_protected` |
| `DELETE /groups/:id` | — | `default` 或当前默认组 400 `group_protected`；仍有 Key 400 `group_in_use` |

`Group = {id, name, description, rateMultiplier, modelAllowlist, isExclusive, status, sortOrder, createdAt}`

### 4.3 上游账户

| 方法 路径 | 请求 | 说明 |
|---|---|---|
| `GET /accounts` | `kind(api=apikey+upstream / subscription=oauth), page, pageSize(≤100), platform, status, reviewStatus, ownerId(=platform 表示平台自有), nodeId, q, sort(createdAt\|lastUsedAt\|name\|priority), order(asc\|desc)` | 分页 `{items: AdminAccount[], total, page, pageSize, counts:{api, subscription, pending}}`；不给 `sort` 时待审核排最前再按创建时间倒序。每行带 `usage`（5h/7d/30d/累计的成功请求数、实收费用、总 token，`rpm`=最近 60 秒成功请求，`errors24h`）和 `inFlight`（网关实时在途数，网关不可达时为 null） |
| `POST /accounts` | `{name, platform, type, executor?: direct\|ccr\|ccr_worker, protocol?, baseUrl?, apiKey \| accessToken/refreshToken?/expiresAt?/accountId?/orgUuid?/environmentId?, models?, modelMapping?, priority?, concurrency?, rpmLimit?, groupIds?, route?, ownerId?, nodeId?, payoutRate?}` | 直接 `approved`；`executor` 缺省 `direct`；`groupIds` 缺省挂默认组；`route=node` 需给号商 `ownerId`，或给 `nodeId`（号商节点 → 归属该号商；平台节点 → 平台自有）；号商账户 `payoutRate` 缺省取设置 |
| `PATCH /accounts/:id` | 上述任意字段（凭证字段给出才更新；`executor` 不给则不改）+ `status: active\|disabled` + `route/nodeId` | `active` 同时清空错误与全部冷却（含窗口冷却 `windowExhaustedUntil`，窗口测量值保留）；`route:"node", nodeId` 绑节点（校验存在/在线/容量，`node_offline`/`node_at_capacity`）；`route:"direct"` 解绑并清 `node_id`；给了 `nodeId` 但最终 `route` 不是 `node` → 400 |
| `POST /accounts/:id/review` | `{action: approve\|reject, groupIds?, priority?, payoutRate?, note?}` | 通过时若未挂任何组则挂默认组 |
| `POST /accounts/:id/test` | `{mode?: profile\|inference, model?}` | Anthropic 订阅号默认 `mode=profile`：只经固定节点/代理做 `GET /api/oauth/profile` + `GET /api/oauth/claude_cli/roles`，**不发推理**；显式 `mode=inference` 才发原来的 8-token 最小请求。返回带 `validation`，成功分别更新 `lastProfileAt` / `lastInferenceAt` 与 `readiness`。`route=node` 均经该账户节点；ChatGPT OAuth 不支持 |
| `POST /accounts`（补充） | `nodeId` 给出时：`route` 缺省为 `node`；号商节点 → `ownerId` 缺省取该号商（给了且不一致 → 400）；平台节点（管理员部署）→ 账户保持平台自有（给了 `ownerId` → 400）；节点不存在 → 400 `node_not_found`；节点账号数达 `capacity` → 400 `node_at_capacity`。PATCH 改 `nodeId` 同样校验 | — |
| `POST /accounts/:id/proxy-release` | `{note?}` | 解除代理失联冻结（`status='proxy_down'` → `active`）。要求绑定代理当前 `live` 且对该账号可调度（未隔离、组织认领一致、同节点），否则 400：`not_proxy_down` / `proxy_missing` / `proxy_not_live` / `proxy_not_schedulable`。记 `proxy_team_events.account_proxy_released`。铁律 2026-11-01（onboarding.md §1.2） |
| `POST /accounts/:id/proxy-rebind` | `{proxyId?}` | 把账号改绑到另一条代理（缺省自动选：同组织、同节点、已实测、容量内），同时解除冻结；返回 `{oldProxyId,newProxyId,exitIp,account}`；失败 400 `proxy_rebind_failed`（message 为原因） |
| `PATCH /accounts/:id {status:"active"}` 对 `proxy_down` 账号 | — | 400 `proxy_down_use_release`：冻结只能经上面两条路径解除 |
| `POST /accounts/:id/window` | — | 立即探测该账户的订阅窗口（`GET /api/oauth/usage`，仿 sub2api；`route=node` 的经其节点发出）并回写 `window*` 列，返回探测后的 `AdminAccount`。仅 Anthropic OAuth 账户（否则 400 `invalid_request`）；探测失败（网络 / 非 2xx / 无法解析）400 `window_probe_failed`（message 为失败原因）；401 会把账户置 `error`（令牌失效需重新授权） |
| `POST /accounts/:id/profile` | — | 经账号节点/绑定代理拉 OAuth profile，回填 `accountEmail` / `subscriptionType`（onboarding.md） |
| `PATCH /keys/:id` / `PATCH /user/keys/:id`（补充） | `policy`（仅管理员）：`{historyPolicy: reset\|reject\|passthrough, directOnly: bool, probeIntercept: bool}`（gateway.md §2b / §2c；`null` 清回默认；`probeIntercept` 缺省 true） | — |
| `PUT /settings`（补充） | 新键 `anthropic_window_threshold_percent`、`window_poll_interval_sec`、`sticky_session_ttl_sec`、`cc_shape_policy`、`ccr_cache_baseline_worker`、`ccr_cache_baseline_cloud`、`ccr_cache_write_as_input`（0/1，ccr-supply §7.1）、`ccr_worker_persistent`、`ccr_worker_native_tools`（0/1，worker-sessions.md）、`window_rest_min_sec` / `window_rest_max_sec`（秒，5h 冷静期，gateway.md §3）、`window_passive_max_age_sec`、`onboard_default_executor`、`onboard_default_concurrency`、`onboard_default_rpm_limit`（v3-design §3.1） | — |
| `DELETE /accounts/:id` | — | `{ok}`（同事务释放绑定代理，docs/onboarding.md §6.4） |
| `POST /accounts/onboard` / `GET /accounts/onboard/:jobId` | 同号商上号端点（docs/onboarding.md §4） | 管理员上号直接 `approved` 并挂 `groupId`（缺省默认组）；归属随节点：平台节点 → 平台池（`ownerId=NULL`），号商节点 → 归该号商（同 `POST /accounts` 的 `nodeId` 规则）；节点满员 400 `node_at_capacity`；代理在"选定 → 绑定"期间被正在进行的上号任务预留（自动挑选跳过，显式指定 400 `proxy_bound`）；其余语义一致 |
| `GET /nodes/:id/proxies?free=1` | — | 同号商版选择器视图（管理员可看任意节点） |

校验规则（`account-input.ts`）：`platform` 必须是已知平台；OAuth 只允许 anthropic / openai，且只有管理员能手工建（号商经节点上传）；
平台无默认 Base URL 时必须给 `baseUrl`；`upstream` 类型必须给 `baseUrl`；`custom` 平台的 upstream 必须给 `models`；
OpenAI OAuth 未给 `accountId` 时从 accessToken 的 JWT 声明里取；`executor=ccr`/`ccr_worker` 只允许 `type=oauth` 且 `platform=anthropic`（否则 400 `invalid_request`），
PATCH 把账户改成其他类型 / 平台时执行器自动退回 `direct`；`orgUuid` / `environmentId` 只对 OAuth 账户有效，合并进加密凭证（PATCH 不给则保留）。

`AdminAccount = ProviderAccount & {ownerId, ownerName, priority, concurrency, rpmLimit, boundProxyId, modelMapping, groups:[{groupId, name, priority}], credentialVersion, readiness, lastProfileAt, lastRefreshAt, lastInferenceAt, rateLimitedUntil, overloadUntil, tempUnschedulableUntil, windowUsed, windowResetAt, windowCheckedAt, windowExhaustedUntil, window5hUsed, window5hResetAt, window7dUsed, window7dResetAt, windowReason, cost30d, usage:{h5, d7, d30, all: {requests, costUsd, tokens}, rpm, errors24h}, inFlight: number|null}`；`inFlight` 由 console 回环调用网关 `GET {GATEWAY_URL}/internal/inflight`（`x-1dayapi-internal`，缺省 `http://127.0.0.1:8400`，2 秒缓存、800 ms 超时）取得

- `windowUsed`：Anthropic 订阅（OAuth）账户绑定窗口已用比例 0..1，`null` = 尚未采样；`window5hUsed/window7dUsed` 与各自 `ResetAt` 为分窗口详情；
  `windowResetAt` / `windowCheckedAt` 为绑定窗口重置时间与最近采样时间；`windowExhaustedUntil` 为窗口级冷却（与 `coolingUntil` 的三个错误冷却分开），
  `windowReason` 为停调 / 限流原因。来源：网关对每个响应的被动采样 + console 巡检（settings `window_poll_interval_sec`，`CCR_WINDOW_POLL=0` 关闭）。非订阅账户均为 `null`。

### 4.4 模型、兑换码、用量、节点、设置

| 方法 路径 | 请求 | 说明 |
|---|---|---|
| `GET /models` | — | `[{modelId, displayName, platform, source: catalog\|custom, enabled, overridden, prices, catalogPrices}]`，价格单位 USD/1M |
| `PUT /models/:modelId` | `{displayName?, platform, inputPerM, outputPerM, cacheReadPerM, cacheWritePerM, enabled}` | 覆盖或新增；缺省字段沿用现值 |
| `DELETE /models/:modelId` | — | 删除覆盖行（目录模型恢复目录价；自定义模型消失）；无覆盖 404 |
| `POST /redeem-codes` | `{valueUsd(0.01–1e7), count(1–500), expiresAt?, batch?}` | 201 `{codes[], valueUsd, count, batch, expiresAt}` |
| `GET /redeem-codes` | `page,pageSize,status,batch,q` | 分页 `{code, valueUsd, status, batch, usedBy, usedByName, usedAt, expiresAt, createdAt}` + `batches[]` |
| `PATCH /redeem-codes/:code` | `{status: disabled\|unused}` | 只能 unused ↔ disabled |
| `DELETE /redeem-codes/:code` | — | 已使用的不能删 |
| `GET /usage` | `page,pageSize,from,to,userId,keyId,accountId,model,status` | 分页 `UsageRow & {userId, userName, accountId, accountName, totalCost, providerEarning}` |
| `GET /usage/stats` | 同上过滤 | 用户 stats + `byAccount:[{accountId, name, requests, costUsd}]` |
| `GET /usage/breakdown` | `bucket(hour\|day)`、`by(user\|key，缺省 user)` + 同上过滤 | 同 §2 `/usage/breakdown`，但序列缺省是用户（`by=key` 时为密钥，配合 `userId=` 看某客户各密钥）。财务面板「消耗明细」与用户详情「消耗」页用 |
| `GET /nodes` | — | 全部节点 `NodeRow`（在线优先）+ `capacity, accountCount, proxyCount, deployMeta` |
| `GET /nodes/monitor` | — | 节点监控看板（docs/operations.md §7.2）：`{data:{nodes:[{nodeId, name(deployMeta.name，2026-10-23), providerName, platformNode, nodeVersion, online, acceptingSessions, inFlight, capacity, lastHeartbeatAt, heartbeatAgeSec, metrics(心跳快照 `nodes.metrics`：reportedAt, host{totalMemMb, freeMemMb, load1, load5, cpus, uptimeSec, processRssMb, processUptimeSec, bunVersion, nodeVersion, bundleHash, draining}, egress{activeSessions}, ccWorker{enabled, claudeVersion, maxConcurrency, active, queued, pool{live, idle, busy, awaitingTools, maxLive, rssMb, evictions}}, proxies{total, live, dead, unknown}) \| null, accounts{total, active, onLiveProxy, cooling}, proxies{total, live}, traffic{req1h, err1h, avgMs1h, req24h, err24h, cost24h}}], generatedAt}}` |
| `PUT /nodes/:id/proxies` | `{proxies:[{url, label?}]}`（http/https/socks5，≤500 条） | 替换代理池：仍在列表里的条目保留健康状态与账号绑定（只更新 url/label），新条目 `unknown`，不在列表里的删除——但**已绑定账号的代理不能移除**（400 `proxy_bound`，先删账号）；节点在线则 WS 推送 `proxies.set`（明文只出现在这次推送；节点每次重连平台也会推一次）；返回 `{pushed, total, skipped:{duplicateInBatch, alreadyInPool, onOtherNode}, skippedUrls[], proxies}`。**重复自动剔除（2026-10-20）**：同一批里重复的行只取第一条，已在其他节点池里的 URL 不接收（代理 id 全局唯一，一条代理只属于一个节点），均计入 `skipped` 并以脱敏 URL 列在 `skippedUrls` |
| `POST /nodes/:id/proxies` | `{proxies:[{url, label?}]}` | 追加代理：已有行（含已绑定）一律不动；**重复自动剔除**：批内重复、本节点池中已有、已在其他节点的都跳过，其余正常入库；返回 `{pushed, added, skipped:{duplicateInBatch, alreadyInPool, onOtherNode}, skippedUrls[], proxies}`，控制台 toast 直接显示「新增 N 条，剔除重复 M 条（…）」 |
| `GET /nodes/:id/proxies` | `free=1` | 脱敏列表（密码掩为 `***`）+ `status/lastCheckAt/lastError/assignedAccounts`；`free=1` 换上号选择器视图（`{id,label,host,port,status,bound}`，无凭据，仅 live 且未绑定，docs/onboarding.md §4） |
| `POST /nodes/deploy` | `{host, port?=22, username, password?\|privateKey?, name?, providerId?, proxies?[]}` | SSH 远程部署（装 unzip/Bun 1.4.4、gcc/libc6-dev/util-linux → 装 claude 2.1.312 到 `/opt/claude/claude` → 建 `ccworker` 与 `/var/lib/1dayapi-cc-worker` → 以 ccworker 跑隔离自检（失败即部署失败）→ 拉 bundle → 写配置 → systemd），同步等 SSH（≤420s，经 nginx `/api/` 调用会先于此在 60s 超时 504，部署仍在后台继续；脚本化调用请直连 127.0.0.1:8401 并带 `Host`/`X-Forwarded-Proto` 头）+ 等上线（≤30s）；返回 `{nodeId, online, ok, log, error?}`，失败也是 200（`ok:false`，节点记录保留，`deployMeta.status=failed`）；需本机有 `ssh`（密码认证还要 `sshpass`） |
| `POST /nodes/local` | `{name?, providerId?, proxies?[]}` | 本服务器直接起节点（不走 SSH，bun 跑 bundle，自动分配本地控制台端口 16889+）；返回同上 |
| `DELETE /nodes/:id` | — | 删除并断开节点：同事务释放节点资源（绑定账户解绑并 `disabled`、清 `node_proxies`/`node_proxy_assignments`、进行中的上号任务置 `failed`） |
| `GET /settings` / `PUT /settings` | settings 键值（见 data-model.md）；GET 在 data 中带 `_revision` 并返回 `ETag: "settings-N"`；PUT 必须带 `_revision` 或 `If-Match`，整份原子写入后 revision + 1 | 缺 revision → 428 `settings_revision_required`；旧版本 → 409 `settings_revision_conflict`，重新读取并复核后再保存，不覆盖并发修改。其余校验：默认组 active、分成 0–1、Key 上限 1–10000、URL http(s)、公告 ≤ 4000 字 |

## 5. 内部端点

### 5.1 节点 → 平台（`/internal/provider/*`，协议见 provider-protocol.md）

鉴权：`x-provider-node-id` + `x-provider-node-secret`（sha256 比对，且所属号商必须 active）；`bind` 除外（用绑定码）。

| 方法 路径 | 说明 |
|---|---|
| `POST /internal/provider/bind` | `{bindingCode, nodeId, nodeVersion?, runtimeIdentity?}` → `{providerId, nodeId, providerNodeSecret, platformWsUrl}`；码无效 401 `invalid_binding_code`；nodeId 属于其他号商 409 `node_bound_elsewhere`。`platformWsUrl` = `PLATFORM_WS_URL` 或按 `X-Forwarded-Proto`/Host 推出 |
| `POST /internal/provider/unbind` | 删除节点、清账户 `node_id` |
| `GET /internal/provider/status` | `{providerId, nodeId, online, credentials}` |
| `GET /internal/provider/credentials` | `{data:[{credentialBindingId, vendor, accountEmail, subscriptionType, status, createdAt}]}`；未通过审核时 `status` 显示 `pending`/`rejected` |
| `POST /internal/provider/credentials` | `{vendor: anthropic\|openai, accessToken, refreshToken?, expiresAt?, accountId?, accountEmail?, subscriptionType?}` → `{credentialBindingId}`；写入 `accounts`（`type=oauth, route=node, review_status=pending`） |
| WS `/internal/provider/connect` | 同样两个头；控制面消息见协议文档；心跳里的 `proxies[{id,live,error?}]`/`assignments{accountId:proxyId}` 回写 `node_proxies`/`node_proxy_assignments` |
| `GET /internal/provider/bundle?code=<bindCode>` | 节点安装包（bun 单文件 `node-bundle.js`，`application/octet-stream`，`x-bundle-sha256` 头）；回环 + 内部令牌，或一次性 bind code（下载即消耗）。deploy 流程已平台侧建好节点，节点无需再兑换该码 |

### 5.2 网关 → 平台（`/internal/tunnel/*`）

鉴权：**socket 来源是回环地址且** `x-1dayapi-internal` 等于 `data/internal.key`（或 `INTERNAL_TOKEN`），否则 403 `forbidden`。
不依赖 `request.ip`，因此开不开 `TRUST_PROXY` 都不受影响；生产 nginx 仍应只对外暴露节点需要的 `/internal/provider/*`。

| 方法 路径 | 说明 |
|---|---|
| `POST /internal/tunnel/open` | `{accountId, targetHost, targetPort}` 或 `{accountId, kind:"http_egress"}`（v2，不传 target）或 `{accountId, kind:"cc_worker", model, prompt, stream, cred}`（worker 模式，docs/ccr-supply.md §8.1，要求账户 `executor='ccr_worker'`），均可再带 `proxyId` 钉死池代理（docs/onboarding.md §6.2）→ `{sessionId, nodeId}`；账户必须 `route=node`、active、approved（平台自有账户须固定到平台节点）；无节点 503 `no_online_node` |
| `POST /internal/tunnel/:id/data` | `{payloadBase64}` |
| `GET /internal/tunnel/:id/read?timeout=ms` | 长轮询（上限 25s）→ `{chunks:[{seq, payloadBase64}], closed, error?}` |
| `POST /internal/tunnel/:id/close` | 关闭 |

v2 的 `/internal/accounts/:id/credential` 已删除：网关经 `@1dayapi/core` 直接解密凭证，明文不再走 HTTP。
