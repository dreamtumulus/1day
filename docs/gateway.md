# 推理网关（apps/gateway，v3）

> 现状参考。代码：`apps/gateway/src/`（`auth.ts` 鉴权、`proxy.ts` 调度与结算、`upstream.ts` 构造上游请求与 OAuth 刷新、
> `convert.ts` 协议转换、`usage.ts` 用量、`tunnel.ts` 节点隧道、`routes.ts` 路由、`ccr/` 云端会话翻译层与执行器）。契约见 [`v3-design.md`](./v3-design.md) §7。
> 数据与计价逻辑在 `@1dayapi/core`（注册表、候选账户、冷却、结算）。

## 1. 端点

所有路径同时挂在 `/` 与 `/v1` 前缀下。

| 方法 路径 | 说明 |
|---|---|
| `GET /health` | `{status, service, time}` |
| `GET /v1/models` | 注册表中启用的模型 ∩ 调用者 Key 所在分组白名单；`{object:"list", data:[{id, object, type, created, owned_by, display_name}]}`；带 `anthropic-version` 头时错误用 Anthropic 信封 |
| `GET /v1/models/pricing` | 公开价目（`publicPricing()`，无需鉴权） |
| `POST /v1/chat/completions` | OpenAI Chat 协议 |
| `POST /v1/messages` | Anthropic Messages 协议（必须带 `max_tokens`） |
| `POST /v1/messages/count_tokens` | 本地估算 `{input_tokens}`（字符 /4），不调上游、不计费 |
| `POST /v1/responses` | OpenAI Responses 协议 |
| `POST /v1/images/generations`、`POST /v1/videos` | 501 `not_implemented` |

请求体上限 32 MB。CORS 全放开（`authorization, x-api-key, content-type, anthropic-version, anthropic-beta, x-1dayapi-tee-proof-mode`）。

## 2. 鉴权与准入（顺序）

1. Key 取自 `Authorization: Bearer` 或 `x-api-key`；按 sha256 查 `api_keys`（JOIN users、groups）。缺失 / 不存在 → 401 `invalid_api_key`。
2. Key `disabled` → 401 `key_disabled`；`expires_at <= now` → 401 `key_expired`。
3. 用户 `disabled` → 401 `user_disabled`；用户是 provider → 403 `role_not_permitted`。
4. 分组不存在或 disabled → 403 `group_disabled`。
5. （推理端点）余额 ≤ 0 → 402 `insufficient_balance`；`quota_usd>0 && used_usd>=quota_usd` → 429 `quota_exhausted`。
6. 缺 `model` → 400 `missing_required_parameter`；`/v1/messages` 缺 `max_tokens` → 400。
7. 注册表无此模型或已下架 → 404 `model_not_found`（v2 中"未知模型 0 计费"由此消除）。
8. 分组白名单不允许 → 403 `model_not_allowed`。

`/v1/models`、`count_tokens` 只做 1–4。

鉴权通过后的准入拒绝（5–8：余额 / 配额 / 缺参数 / 模型不存在 / 白名单）自 2026-10-16 起也各写一条零费用 `usage_logs`
（`error_code`、`error_message`、`account_id` NULL、`mode` NULL），错误日志页因此能看到"请求到了但没放行"的那部分；1–4 没有可归属的用户，不落行。

错误信封按客户端方言：`/v1/messages` 返回 `{type:"error", error:{type, message, code}}`，其余返回 `{error:{code, message, type}}`。

## 2a. Claude Code 形态判定（分流器，`packages/core/src/cc-shape.ts`）

订阅号直连（§4 双模路由 R1）只对**真 Claude Code 请求**开放。UA 前缀一改就能伪造，而伪造得不像的"CC 请求"
打在订阅号上会被 Anthropic 回 429（2026-10-16 实测：缺计费头 system 块即 429），且是账号上的异常样本，封号风险由平台承担。
所以 `isClaudeCodeUa` 只决定"自称 CC"，是否放行直连由 `classifyCcRequest(headers, body)` 决定：

| 判定 | 条件 |
|---|---|
| `not_cc` | UA 不以 `claude-cli/x.y.z` / `claude-code/x.y.z` 开头 → 按非 CC 客户端处理，不做后续检查 |
| `genuine` | 全部**硬检查**通过 |
| `suspect` | 自称 CC 但任一硬检查失败 |

**硬检查**（每个真 CC 版本都满足、结构稳定、不随版本漂移；2026-10-19 对照 2.1.303 实抓请求核对）：`x-app: cli`；`anthropic-beta` 含
`claude-code-20250219`；`system` 为数组且首块为 `x-anthropic-billing-header: cc_version=<ver>; …`，`<ver>` 的 major.minor.patch 与 UA 版本一致；
`metadata.user_id` 是 JSON 字符串且含 64 位 hex `device_id` 与 uuid `session_id`；`x-stainless-lang: js` 且 `x-stainless-runtime: node`；
`x-claude-code-session-id` 为 uuid **且等于** `metadata.user_id.session_id`（`session_id_mismatch`）；`accept` 含 `application/json`；
`anthropic-version: 2023-06-01`；UA 版本不低于 Anthropic 对该模型的最低 Claude Code 版本（`CC_MIN_VERSION_BY_MODEL`：opus-5-5 ≥ 2.1.280、
fable-5-1 ≥ 2.1.251，来自上游 `claude_code_version_too_old` 400；低于门槛的请求直连只会收 400，走 worker 反而能用节点的 2.1.300）。
2026-10-19 之前后五项只是软检查：当天有 8 个只补了 UA / x-app / beta / 计费头 / metadata 的 router 请求以 bun 运行时、无 session 头的形状
通过 genuine 进了订阅直连。注意 TLS 在 nginx 终止、网关重新发起，Anthropic 看到的 TLS 指纹永远是平台的，客户端差异只剩头和体。

**软检查**（描述当前 canonical 构建，只记录不判定，用来提前发现 CC 升级）：`stream:true`、身份句块、带 cache_control 的长主提示词、
tools 字母序且无 `strict`、有 `thinking` / `context_management`。巡检脚本 `1day-health` 输出窗口内 genuine / suspect 计数与缺失项分布。

**处置**由 settings `cc_shape_policy` 决定（控制台「设置」可改）：

| 策略 | suspect 请求 |
|---|---|
| `observe`（默认） | 维持现状走直连，只打日志和标记。用于基线观察：确认真实 CC 用户零误判后再收紧 |
| `downgrade` | `ccClient=false`，按非 CC 客户端路由（ccr / ccr_worker 翻译路径，能力矩阵见 ccr-supply §6），**绝不**走订阅号直连 |
| `reject` | 400 `cc_shape_mismatch`，message 列出缺失项 |

每条自称 CC 的请求都落 `usage_logs.cc_shape`（`genuine` / `suspect`，迁移 7），控制台用户列表有「伪造 CC（30 天）」计数，
用量明细对 suspect 行打标。日志：`[cc-shape] <reqId> key=<keyId> ua=… suspect missing=a,b policy=…`；genuine 但有软漂移时打
`[cc-shape] <reqId> genuine v<ver> soft=…`。误杀风险：硬检查只看结构不比对具体字符串，CC 升级改 beta 列表 / 工具数 / 主提示词不会被判 suspect。

## 2b. 按 Key 的路由策略与按用户的并发上限（迁移 29，2026-10-29）

客户复测报告（mirasim.ai，2026-10-29）催生：对话中途从别的上游切过来会被重置（200 + `x-1day-context-reset`）、不合形态的请求被转到 worker
而不是 400、并发固定 4。三者都做成**后台可编辑**的设置，不再改代码。

**`api_keys.policy_json`**（控制台 → API Keys → 编辑；`packages/core/src/key-policy.ts`）：

| 字段 | 取值 | 行为 |
|---|---|---|
| `historyPolicy` | `reset`（默认） | 带着本平台没服务过的前几轮（`unknownInitialHistory`）时保存边界、只转发最后一个问题，响应 `x-1day-context-reset: 1`（team-isolation.md 对话归属） |
| | `reject` | 同一情形返回 **409 `history_unknown`**，客户端可换上游 |
| | `passthrough` | 历史原样转发，对话绑定到实际服务它的组织（运营方接受跨组织关联风险） |
| `directOnly` | `false`（默认）/ `true` | 开启后非 genuine Claude Code 请求返回 **400 `direct_only`**（message 列出缺失项），不转 worker；原样透传分组（§4a）不受影响 |

**`users.max_inflight` / `users.max_inflight_usd`**（控制台 → 用户 → 余额页「并发上限」）：覆盖 `USER_MAX_INFLIGHT`（默认 4）与
`USER_MAX_INFLIGHT_USD`（默认 10）；空 / 0 = 用默认。超出返回 429 `user_inflight_limit`（`packages/core/src/request-budget.ts`）。

## 3. 选账户

候选 = `listCandidates(groupId, model)`：Key 所在分组经 `account_groups` 挂入的账户中，`status=active`、`review_status=approved`、
`overload_until` / `temp_unschedulable_until` 已过、且 `supportsModel`（`models` 非空则按通配匹配，否则模型平台 == 账户平台）。
**429 冷却是软的**：`rate_limited_until` 未过的账户仍是候选，但 `cooling=true`、排在所有未冷却账户之后（冷却越早结束越靠前），
粘性会话也不会把它提前；只有被拒窗口写入的 `rate_limited_until`（`window_reason` 为 `… rejected (429) until <同一时间>`）才是硬排除。
原因：一次 429 可能只针对某种请求形态（实测：OAuth 订阅号对缺计费头 system 块的 Claude Code UA 请求回 429，
docs/claude-code-compat.md §5），同一账户对其他形态照常可用；若按硬冷却处理，单账户分组里一个探针的 429 会让其他所有
调用方在冷却期内收到 503（2026-10-16 线上实测）。网关在 `-> HTTP <status>` 日志后附上游错误体前 240 字，便于区分。
网关尝试冷却账户时打一行 `[proxy] <reqId> account <name> is 429-cooling until …; no other candidate, trying anyway`。
Anthropic 订阅账户（`type=oauth, platform=anthropic`）还要通过**订阅窗口过滤**（仿 sub2api account_scheduling_threshold）：
`window_exhausted_until` 已过，且上次采样的绑定窗口用量 `< anthropic_window_threshold_percent`（默认 95%，100 = 关闭）；
快照已过 `window_reset_at` 视为窗口已滚动放行；阈值下调后首次被过滤时写一次 `window_exhausted_until` + `window_reason`，管理台可见。
**5h 窗口冷静期（2026-10-17，用户要求）**：5h 窗口用尽 / 被拒后不在重置点立刻恢复，而是重置时刻再加 **随机 1h45m～2h05m**
（settings `window_rest_min_sec`=6300 / `window_rest_max_sec`=7500；core `restAfterReset`），避免一批账号在各自重置点同时打满。
作用于 `window_exhausted`（含 CC session-limit 文本）、`window_rejected`（five_hour）、被动采样达阈值暂停、调度时阈值暂停四处；
7d 窗口与模型族冷却不加。`window_reason` 写成 `… until <含冷静期的时刻> (reset <重置点> + rest)`。
worker 路径没有 unified 头，窗口用尽只以 Claude Code 自己的文本到达（`result` / 流错误里的 "You've hit your session limit · resets
8:50am (Europe/Berlin)"）：网关 `markCcrFailure` 用 core `ccLimitReset` 解析窗口种类和重置时刻（引号里的时区换算成 UTC，解析不出则
回退 1h），写 `window_exhausted_until`，不再按"瞬时故障"短冷却反复挑中同一账号（2026-10-17 mirasim 事故：3 分钟 6×502 + 10×503）。
**worker 路径的鉴权失败**（2026-10-17）：Claude Code 以文本报 OAuth 死亡（"Failed to authenticate: OAuth token revoked…"、"OAuth session expired and
could not be refreshed"），网关 `ccr/auth-failure.ts` 识别后：单次 → 冷却 5 分钟（`transient` 带 `cooldownMs`），30 分钟内第 3 次 → `status='error'`
（与直连 401/403 同等），该账号任一请求成功即清零计数。单次不直接禁用，因为实测两个进程同时刷新同一账号会各报一条这样的文本而账号其实仍好。
**账号被 Anthropic 挂起（on hold）**（2026-10-20，用户定）：Claude Code 文本 "Your account is on hold and can't use Claude Code. View details or appeal:
https://claude.ai/restricted" 是对账号本身的判决，不是刷新竞态——`isCcAccountOnHold` 命中即 `status='error'`（`error_message` 以 `account on hold:` 开头），
**一次即禁用，不进 3 次计数**。此前它落在通用 transient 30 s 冷却里：2026-10-20 一天 73 个账号被挂起，每个平均再被挑中 20～30 次（559 个客户 502）才被别的错误标掉。
**worker 路径的模型不可用**（2026-10-17）：Claude Code 对下线/无权限的模型不回 404，而是 is_error 结果文本 "There's an issue with the selected model
(claude-sonnet-4-5). It may not exist or you may not have access to it"。网关 `ccr/model-unavailable.ts` 识别后直接给客户 404 `model_not_found`，
**不换号、不冷却**（此前会连换 3 个账号并各冷却 30 秒：一个客户扫一遍模型目录就冷却了 6 个好账号）。目录里 `claude-sonnet-4-5` 在订阅路径已不可用，
是否下架由产品决定。
**worker 路径的请求级错误**（2026-10-19，`ccr/model-unavailable.ts` `classifyCcRequestError`）：同样"是请求的问题、换账号没用"的还有
Claude Code 的上下文溢出（"Prompt is too long · the request is ~N tokens (limit 1000000) …"）和安全分类器拒绝（"… safeguards flagged this session …"、
"… can't help with this. Start a new session …"）。网关直接答 400 `prompt_too_long` / `safeguards_refusal`，message 用 Claude Code 原句
（Claude Code 客户端看到 "prompt is too long" 会自动 compact），不换号、不冷却；流式时流内 `event: error` 的 type 为 `invalid_request_error`，用量行记 400。
此前都是 502 并把健康账号冷却 30 秒（一个客户的模型巡检一次冷却 2 个账号）。
**开会话阶段的拒绝也只答一次**（2026-10-19，`tunnel.ts` `rejectRequestLevel`）：console `POST /internal/tunnel/open` 返回 400/413/422 时抛
`TunnelRequestError`（code `console_<code>`），与节点的 `spec_too_large` / `bad_spec` 同路径 → 400 `invalid_request` / 413 `request_too_large`。
此前任何非 2xx 都当"节点不在线"换下一个账号且不计次，一个请求把全部账号走一遍后以 503 `no_available_account` 收场（每天 6–27 个客户请求、
console 日志里 2600 条 400）。最常见的触发是 `messagesToPrompt` 渲染出空 prompt：现在 `ccr/worker.ts` 在进账号循环前就抛 `empty_prompt`
（仅图片 / 文件块的轮次用占位 prompt 放行，节点按 content 块处理）。
**上下文溢出的真实来源是 Claude Code 的文件引用**（2026-10-19）：节点上的 Claude Code 2.1.300 会把客户文本里的 `@路径` 当文件引用读入请求
（文件读内容、目录读列表），会话被撑大 1.7–3.8 倍而报 "Prompt is too long … this conversation is only ~385k tokens — the rest is … attachment content"，
也让客户文本能读到节点文件。节点 worker 进程现在带 `CLAUDE_CODE_DISABLE_FILE_MENTIONS=1`（bundle d7db36dd），`@/etc/hostname` 之类不再被读取。
**模型族冷却**（2026-10-16，仿 sub2api `SetModelRateLimit`）：`accounts.model_cooldowns` JSON `{scope: {until, reason, used, resetAt}}`（迁移 9）。
目前只有 `fable` 一个 scope（模型名含 fable）。Fable 专属 7 天窗口（响应头 `anthropic-ratelimit-unified-7d_oi-*`、usage 体
`seven_day_fable` / `seven_day_overage_included`）耗尽或 429 `credits_required` 时只冷却该 scope：Fable 请求跳过该账户，其他模型照常调度。
`listCandidates(groupId, model)` 按请求模型的 scope 过滤。usage 体里的 `seven_day_sonnet` / `seven_day_opus` 等模型族窗口**不再**并入账号级绑定窗口
（此前会因某一族 7d 用尽而暂停整个账号）。

排序：未冷却优先（冷却者按 `rate_limited_until` ASC）→ `account_groups.priority` ASC → `accounts.priority` ASC → `last_used_at` ASC → 同档随机。

再按端点筛掉协议不兼容的账户（见 §4）：有候选但都不兼容 → 400 `unsupported_endpoint`；完全没有候选 → 503 `no_available_account`。

§4 的 `ccClient` 取 §2a 判定为 `genuine`（`observe` 策略下 suspect 也暂按 CC 处理）。

**粘性会话**（仿 sub2api `GenerateSessionHash`）：键按优先级取 ① `metadata.user_id` 里的客户端会话 ID（Claude Code 的
`…_session_<uuid>` 或 JSON `{session_id}`）→ ② **system 里**带 `cache_control` 的内容块文本 + 第一条 user 消息全文（客户端要保温的缓存前缀 + 对话根；
2026-10-23 前取的是全部消息里的标记块，而 opencode 之类把 `cache_control` 打在最后两条消息上，键每轮都变，一条 35 轮对话落了 30 个账号、缓存永远只命中身份前缀）→ ③ `api_key_id + 客户端 IP +
去数字 UA + system + 全部消息文本` 的 sha256。进程内 Map 作热缓存、写穿到 `affinity_bindings` 表（见下「跨发布保持」），TTL 取 settings `sticky_session_ttl_sec`（默认 1800）；
命中且仍在候选中的账户排到最前。**键里带模型**（2026-10-20）：提示缓存按账号 × 模型隔离，Claude Code 同一会话里 Sonnet/Haiku
的副任务若因并发满被挪到别的账号，不能把 Opus 主会话的绑定一起带走（安安 06:56 一次 94 万 token 重写），所以会话键是 `s:<key>:<session>:<model>`。

**503 的原因**：候选为空时先查 `modelSuspensionSummary(group, model)`，若有账号正处于组织级模型停用，返回
`upstream_model_suspended`（503，文案写明是 Anthropic 对组织的临时限制、最早解除时间），否则才是 `no_available_account`。

**一账号一软件**（2026-10-20，用户定）：设备固定后，直连 UA 仍原样透传客户的 Claude Code 版本和入口后缀，结果一个设备一天出现
最多 7 个 CC 版本，且 70% 的直连流量带客户自定义后缀 "(external, mirasim)"。网关在 `buildUpstreamRequest`（passthrough-anthropic）里
调 core `normalizeCcSoftware`：`direct_cc_entrypoint_normalize=1` 把非真实入口（真实：cli / sdk-cli / sdk-ts / sdk-py / claude-vscode /
claude-jetbrains / claude-desktop(-3p) / local-agent）的后缀改成 "(external, cli)"，计费头 `cc_entrypoint` 同步；`direct_cc_version_pin`
（默认 2.1.303 = 节点 worker 的版本，空 = 透传）把 UA 版本、`x-stainless-package-version`（取 canonical SDK 版本）和计费头 `cc_version`
统一。形态判定（§2a）在归一化之前跑，判的仍是客户原始形状；worker 路径不受影响。两项都是设置项，改完即生效，无需发布。

**设备亲和**（2026-10-19）：会话键只管一条对话，同一台客户机器的其它对话仍会散到任意账号，结果一个账号一小时内同时服务多台机器、
多个 Claude Code 版本。设备键 = `d:<api_key_id>:<metadata.user_id 的 device_id>`（JSON 形式或 legacy `user_<hex>`），记住该设备
最近用过的账号（最多 `device_affinity_pool_size` 个，默认 3，0 关闭；TTL `device_affinity_ttl_sec`，默认 7200）。排序为
粘性账号 → 设备池内账号（按记录顺序）→ 其余；池满后溢出到的账号不再入池。被迫换号的会话因此多半落到已服务过该设备、
缓存前缀仍热的账号上。非 Claude Code 客户端没有 device_id，行为不变。

**跨发布保持**（2026-10-21，core `affinity.ts`，迁移 16）：粘性会话表和设备池此前只在网关进程内存里，蓝绿切换后新实例是空表，
所有活跃对话（30 min 内）和设备在切换瞬间被重新发牌到任意账号——Anthropic 看到设备在账号间跳、提示缓存全部重建，而且新实例没有
"上一次绑定"可比，这批跳号不会被标 `account_switched`，全价计费且不在返还范围内（19:54 一次切换后 10 min 内输入 token 翻倍）。
现在两张表都写穿到 SQLite `affinity_bindings`（`key` 主键，`kind` = session / device，`account_id` 或 `accounts` JSON，`expires_at` 毫秒）：
每次 `rememberSticky` / `rememberDevice` 同步落库，进程内查不到（或已过期）再查库并回填。排空中的旧实例与新实例共用同一文件，
旧实例在排空期间写的绑定新实例也看得到。网关每 10 min 清一次过期行；启动日志打印 `affinity: N session / M device bindings carried over`。
会话键、设备键的构成不变，TTL 不变。worker 持久会话的网关侧轮次记忆同样写穿到 `worker_turn_memory`（迁移 17，worker-sessions.md §1 / 进度 2026-10-22），
切换后同一对话继续 `continue` 到节点上的活进程，不再全量 fresh。启动日志同时打印 `N worker turn memories carried over`。

**按模型的组织级停用**（2026-10-20）：Anthropic 会对整个组织按模型临时停用：403 `permission_error`
`model: "claude-opus-5-5" is suspended for this organization until <ISO>`（worker 路径包在 Claude Code 的
"Failed to authenticate. API Error: 403 …" 文本里）。首例 2026-10-20 04:36Z，fgms.us 团队组织的 Opus 5.5 与 Sonnet 5.5 停一小时，
其它模型照常。网关识别后只给该账号写 `model_cooldowns["model:<id>"].until`（core `parseModelSuspension` /
`markFailure({kind:"model_suspended"})`），换下一个账号继续；不再当作 401/403 认证失败把账号整个标成 error。

**并发**：`accounts.concurrency > 0` 时使用 SQLite 共享租约，所有在线和排空实例共计。满额账号属于暂时繁忙；同 team 内等待最多 `ACCOUNT_BUSY_WAIT_MS`（默认 15 秒），超时返回可重试错误，不清空对话。失去租约会取消上游。

依次尝试，最多 `GATEWAY_MAX_ATTEMPTS`（默认 3）次真实上游调用。`route=node` 的账户若开不了隧道（号商无在线节点 / 节点拒绝 / TLS 失败），
视为基础设施不可用，直接跳过且不计入尝试、不标记账户。

## 4. 协议模式

| 客户端端点 | 账户 `protocol=anthropic` | `protocol=openai` |
|---|---|---|
| `/v1/messages` | `passthrough-anthropic` → `{base}/v1/messages` | `anthropic-via-chat` → `{base}/chat/completions` |
| `/v1/chat/completions` | `chat-via-anthropic` → `{base}/v1/messages` | `passthrough-openai` → `{base}/chat/completions` |
| `/v1/responses` | 不支持 | `passthrough-responses` → `{base}/responses` |

ChatGPT OAuth 账户（`type=oauth, platform=openai`）只接 `/v1/responses`，出口固定 `https://chatgpt.com/backend-api/codex`（实验性）。

`executor=ccr` 的账户不走上表：`/v1/messages` → `ccr-anthropic`，`/v1/chat/completions` → `ccr-chat`（先做 Chat→Messages 转换），
`/v1/responses` 不支持。执行器输出 Anthropic 线协议，交付时按 `passthrough-anthropic` / `chat-via-anthropic` 处理（§10）。

- 请求体里的 `model` 一律替换为 `model_mapping[model] ?? model`；透传模式下响应里的 `model` 改回客户端请求的名字。
- 转换覆盖：system/developer、多段文本、图片（data URL ↔ base64 source、http URL）、tools / tool_choice、tool_calls ↔ tool_use、
  tool 消息 ↔ tool_result、stop ↔ stop_sequences、temperature（转 Anthropic 时上限 1）、`max_tokens`（Chat→Anthropic 缺省 8192）、
  finish_reason ↔ stop_reason，及两个方向的 SSE 流（含工具参数增量）。
- 上游请求头：
  - Anthropic 线协议：路径为 `/v1/messages?beta=true`，并按 [`claude-code-compat.md`](./claude-code-compat.md)
    补齐客户端指纹头（另一条工作线正在实现，以该文档与 `upstream.ts` 为准）；`anthropic-version`（客户端给了就用，否则 `2023-06-01`）；透传模式转发客户端的 `anthropic-beta`；
    `apikey` 用 `x-api-key`；`upstream`（第三方中转）同时带 `x-api-key` 和 `Authorization: Bearer`；
    `oauth` 用 `Authorization: Bearer` 并追加 beta `oauth-2025-04-20`。
  - OpenAI 线协议：`Authorization: Bearer`；ChatGPT OAuth 另加 `chatgpt-account-id`、`openai-beta: responses=experimental`、
    `originator: codex_cli_rs`，请求体置 `store=false`。

## 4a. 原样透传账号（`accounts.raw_passthrough`，迁移 19，2026-10-23）

给第三方中转（官Key 分组 / api-key.xyz）用：账号勾选「原样透传」后，**同协议**的请求（`passthrough-anthropic` / `passthrough-openai` /
`passthrough-responses`）按客户端发来的样子转给上游——请求头原样（去掉 host / content-length / connection / accept-encoding 等传输头、
客户端自己的 `authorization` / `x-api-key`、`cf-*` / `x-forwarded-*` / `x-1dayapi-*` 等边缘与平台头），正文原样（只有模型映射仍生效），
查询串原样（Claude Code 的 `?beta=true` 来了就带、没来就不加）。不做 §2a/§3 的 Claude Code UA/版本归一、指纹头、设备身份固定、
`thinking` 整理和 beta 注入；凭据照旧同时发 `x-api-key` 与 `Authorization: Bearer`；客户端没带 `anthropic-version` 时补默认值。
跨协议转换（`chat-via-anthropic` / `anthropic-via-chat`）不受影响。计费仍按上游 usage × 目录价 × 分组倍率（目录里没有的模型按估价）。
控制台账号表单「原样透传」复选框（非 OAuth 账号可见），API 字段 `rawPassthrough`。

**不做任何判断（用户定，2026-10-26）**：正文连 `model` 都不改写——账号的 `model_mapping` 和目录的规范 id（`claude-opus-5.5 → claude-opus-5-5`）
对透传账号一律不生效；`supportsModel` 对无 `models` 列表的透传账号恒为真（目录里没有的模型 id 照样路由）。
当一个分组里**所有**可调度账号（active + approved）都是透传账号时（`groupIsRawPassthrough`），该分组的请求：
- 不做准入：`model` / `max_tokens` 缺失、模型不在目录都不拦，交给中转判定（分组自身的 `model_allowlist` 仍生效，那是运营规则不是对请求的判断）；
- 不做 §2a 的 Claude Code 形态分类（不打 `[cc-shape]` 日志，`cc_shape` 为空）；
- 上游任何状态码（含 429 / 5xx）原样回给客户端（同方言：状态码 + 正文照搬，`retry-after` 一并转发），**不标记账号冷却、不换下一个账号**；
  网络错误答一次 502 `upstream_error`，同样不冷却；流中断 / 正文读取失败只记失败行，不冷却。
  失败行的 `error_code`：4xx `upstream_client_error`、429 `upstream_rate_limited`、5xx `upstream_error`。
混有普通账号的分组仍走普通路径（透传账号在其中只少做请求改写）。

## 5. 上游错误处理

| 上游 | 账户处理 | 后续 |
|---|---|---|
| 2xx | `last_used_at` 更新、记粘性 | 返回客户端 |
| 400 / 404 / 413 / 422 | 不标记 | **直接透传**：同方言原样转发状态码与正文；跨协议时把上游 message 包进客户端方言，code `upstream_client_error` |
| 401 / 403 | OAuth 且有 refreshToken：强制刷新后对同一账户重试一次；否则 `status=error` | 换下一个 |
| 402 | `temp_unschedulable_until = now+60min` | 换下一个 |
| 429 | **先看模型族**：请求模型含 fable 且（`7d_oi` 头 rejected / utilization ≥ 1 且 reset ≤ 8d，或 body `error.details.error_code = credits_required`）→ 只写 `model_cooldowns.fable.until = reset`（缺 reset 则 +24h），账号级不动；否则响应带 `anthropic-ratelimit-unified-{5h,7d}-status: rejected`（或 utilization ≥ 1，或 `-surpassed-threshold: true`）且 reset 合理 → `rate_limited_until = 该窗口 reset`（5h 上限 6h、7d 上限 8d），`window_reason` 记录（硬排除）；否则 `now + Retry-After`（缺省 60s，1s–7200s，软冷却：仅降序，见 §3） | 换下一个 |
| 529 / 503 | `overload_until = now+60s` | 换下一个 |
| 其他 5xx、网络错误 | `temp_unschedulable_until = now+30s` | 换下一个 |
| 节点 / 平台在开会话时拒绝该请求（`spec_too_large`、`bad_spec`、console 400/413/422，`empty_prompt`） | 不标记 | **只答一次**：413 `request_too_large` 或 400 `invalid_request`，不再换账号（2026-10-18/19，§3） |
| worker 结果为上下文溢出 / 安全分类器拒绝 | 不标记 | **只答一次**：400 `prompt_too_long` / `safeguards_refusal`（§3） |

全部失败：最后状态 429 → 429 `upstream_rate_limited`；一次都没真正发出 → 503 `no_available_account`；其余 → 502 `upstream_error`。
所有失败都写一条 `usage_logs`（费用 0，`error_code`）。

### 5.1 订阅窗口被动采样（仿 sub2api）

Anthropic 订阅账户的每个上游响应（2xx 与 429）都读取 `anthropic-ratelimit-unified-5h-{utilization,reset,status}` /
`…-7d-…` 头（utilization 0..1，reset 为 Unix 秒），写回 `window_5h_*`、`window_7d_*`，绑定窗口（用量高者，rejected 视为 100%）写
`window_used / window_reset_at`；达阈值 → `window_exhausted_until = reset` + `window_reason`。空闲账户由 console 巡检器用
`GET /api/oauth/usage` 补采（`docs/console-api.md` `POST /accounts/:id/window`）。

### 5.2 200 里的失败

上游返回 200 之后仍可能失败：流里出现 `event: error`（Anthropic）/ `{"error":…}` 块（OpenAI）/ CCR 执行器的 `event: error`，或 body 读到一半断开（隧道被节点关闭、socket 复位、压缩 body 截断）。这些**不是已服务的请求**：

- 流式：流在到达终止符（`message_stop` / `[DONE]` / `response.completed`）之前出错 → 不结算、写一行 `502 upstream_stream_error`（零费用）、账户 `transient` 冷却；客户端已收到上游原样的错误事件（透传模式），或转换器生成的本方言错误（`chat-via-anthropic` 发 `{"error":…}` 且不发 `[DONE]`；`anthropic-via-chat` 发 `event: error` 且不发 `message_stop`）；读流异常时网关自己补一条错误事件。客户端自己断开则照常按上游已报用量结算。
- 非流式：body 读取失败 → `502 upstream_error` + 用量行（零费用）+ `transient` 冷却，不再是无记录的 500。
- 流空闲：两个 chunk 之间超过 `STREAM_IDLE_TIMEOUT_MS`（120 s）视为上游挂死，取消读取并按上面的失败处理；客户端断开时立即取消上游读取，不再占并发槽。
- CCR 的会话/环境 API 返回 400/404 是账户状态问题（环境被删、配置不支持），按 `transient` 冷却并换账户，不透传会话 API 的 body；执行器遇到持久化的 `environmentId` 被拒时清掉并重建一次。

## 6. 流式与用量

- 只有客户端 `stream=true` **且**上游返回 `text/event-stream` 时走流式管道，否则按非流式处理。
- 响应头：`text/event-stream`、`cache-control: no-cache`、`x-accel-buffering: no`。
- `passthrough-openai` 流式**强制注入** `stream_options.include_usage=true`；若客户端自己没要求，则剔除仅含 usage 的末块（`choices: []`），客户端看到的流与上游原生一致。
- `chat-via-anthropic` 只在客户端要求 `include_usage` 时追加 usage 块，最后输出 `data: [DONE]`。
- 用量抽取（统一成"input 不含缓存读"的口径）：
  - Anthropic：`message_start.message.usage` + `message_delta.usage`（`input_tokens / output_tokens / cache_read_input_tokens / cache_creation_input_tokens`）；
  - OpenAI Chat：`prompt_tokens − cached_tokens` 为输入，`cached_tokens` 为缓存读；
  - Responses：`response.completed`（或 `response.done`）事件里的 `response.usage`（`input_tokens_details.cached_tokens`）。
- 上游一个 usage 都没报时，按"请求文本字符数 / 4"和"生成文本字符数 / 4"估算，`usage_estimated=1`。这是 `usage_estimated` 的唯一含义
  （2026-10-16 起 CCR 行不再借用该标记）。**媒体块不按字节算**（2026-10-17）：`estimateRequestTokens` 对 Anthropic `image/document`
  （`source.data`）与 OpenAI `image_url: data:…` 每块固定计 1600 token，JSON 键名不计；此前两条客户端 120s 超时放弃、带约 8MB 图片的请求
  被估成 217 万 token、各扣 $8.71。客户端中途断开且上游没报 usage 的请求仍按估算计费（防"发完就断"白嫖），仅输入侧。
- **粘性会话被迫换账号 → 本轮 input 按缓存读价计**（2026-10-17，照搬 sub2api `ForceCacheBilling`）：请求命中了仍有效的 sticky 绑定，
  却因冷却 / 故障转移 / 代理不可用落到了另一个账号，提示词缓存被迫重建不是客户的责任，结算时把该请求的 `input_tokens` 并入
  `cache_read_tokens`（0.1×）。只影响账单，不改客户可见 usage；日志 `[proxy] <id> sticky session moved off its account to …`。
  **同时把该行 `usage_logs.account_switched` 置 1**（迁移 15，2026-10-21）：缓存写入（1.25×）部分 ForceCacheBilling 管不到，由 console 的
  缓存重建返还定时任务按差额的 `cache_refund_percent`（默认 80%）返还给用户，先冲减授信、再加余额（data-model.md cache_refunds）。
- **CCR 路径缓存写按输入价**：settings `ccr_cache_write_as_input`（默认 1），见 ccr-supply.md §7.1。
- CCR 路径（executor=ccr / ccr_worker）的 usage 由翻译层产出：input/output 为上游口径，缓存 = 上游缓存 − 身份上下文基线
  （settings `ccr_cache_baseline_worker` / `ccr_cache_baseline_cloud`，ccr-supply.md §7.1），之后与直连走同一条结算管道。
- 客户端中途断开：停止读取上游，用已收到的数据结算。
- 首 token 时间记入 `first_token_ms`，总耗时 `duration_ms`。

## 6a. 慢请求保活（`src/heartbeat.ts`，2026-10-22）

api.1dayapi.com 在 Cloudflare 后面：源站 125 s 没有任何字节就回客户端 524（nginx 记 499），nginx 自身 `proxy_read_timeout 300s`，
Claude Code 一类客户端自己还有约 120 s 的首字节超时。网关在拿到上游第一个字节之前必须自己产生字节，而且要用客户端能忽略的格式，
客户端一行都不用改：

- **流式**：第一次尝试上游之前就 `hijack` 并发 200 + SSE 头（`beginEarlyStream`），Anthropic 方言发真正的 `event: ping`
  （协议自带的心跳，各家 SDK 都跳过），OpenAI 方言发 SSE 注释；每 15 s 一次，上游首字节到达即停。从这里起失败只能是 SSE `error` 事件
  （`endEarlyStreamWithError`），HTTP 状态码已经发出去了。
- **非流式**：快速失败要保留真实状态码，所以只在第一次尝试上游时**计时**（`armNonStreamHeartbeat`），75 s 仍无上游应答才
  提交 200 + `application/json` 头并每 20 s 写一个换行（JSON 值前的空白不影响解析，RFC 8259 §2），body 到了接着写出去
  （`endEarlyJson`）。提交之后的失败只能是 200 + 错误 JSON（`endEarlyJsonWithError`，日志 `after the non-stream 200 was committed`），
  仍比 Cloudflare 的 524 HTML 页好。`x-1dayapi-tee-proof-mode: multipart` 的请求不计时（multipart 框架没法提前开始）。
- 客户端中途断开（`reply.raw` 的 `close`）：两种心跳都停，`ctx.abort` 让持有上游 body 的一方取消，记 499 `client_closed`、不计费。

背景：2026-10-22 一位客户 816 个非流式请求（haiku 原生工具调用停顿 300 s，见 ccr-supply.md）全部在 125 s 被切断且照常计费；
另一位客户的 8 MB+ 大请求等上游响应头超过 120 s 后由客户端放弃。节点侧 `[http-egress]` 日志从同日起带 `hdr=`（到上游响应头的毫秒）
与 `req=`（请求体字节），响应头超过 30 s 单独记一行，网关被动关闭时记 `closed by gateway … before upstream headers`。

## 7. 结算

**请求来源留痕（迁移 30，2026-10-29）**：`usage_logs.team_id / proxy_id` 在结算时写入服务账号当时的组织与绑定代理；控制台用量明细按
`COALESCE(l.team_id, a.team_id)` 显示组织（优先 onboard_orgs 方案名，其次 upstream_teams 名）、IP 组与出口国家，账号重绑或删除后旧记录不变。

调用 core 的 `settleRequest`（单事务，见 [`data-model.md`](./data-model.md) §4）：
`total = computeCost(model, usage)`、`actual = q8(total × 分组倍率)`、号商账户 `earning = q8(total × payout_rate)`。
流式请求**在结束客户端响应之前**结算，客户端看到流结束时扣费已落库；非流式在发送响应前结算。结算异常只打日志，不影响响应。

## 8. OAuth 刷新

`freshCredential()`：`type=oauth` 且有 `refreshToken`、`expiresAt` 距今不足 5 分钟（或 401/403 后强制）时刷新：
Anthropic `POST https://platform.claude.com/v1/oauth/token`（JSON），OpenAI `POST https://auth.openai.com/oauth/token`（form）。
同一账户并发刷新合并为一次；成功则加密回写凭证，失败沿用旧令牌（随后的 401 会把账户置 error）。
刷新实现在 `@1dayapi/core` `oauth.ts`，接受可选 transport：`route=node` 的账户由其节点（绑定 / 粘性代理）发出刷新请求
（console 的保活循环已如此；网关侧按 `docs/onboarding.md` §6.2 接入中），其余账户直连。

所有 `route=node` 的账户（executor=ccr / ccr_worker / direct 都一样）的刷新请求都经该账户的节点、钉在 `bound_proxy_id` 上发出（docs/onboarding.md §1）；隧道不可用时刷新返回 null，沿用旧令牌，不把账户标错。

## 9. 节点隧道传输（route=node，协议 v2 http_egress）

1. `POST {CONSOLE_BASE}/internal/tunnel/open {accountId, kind:"http_egress"}`，带 `x-1dayapi-internal: <internal.key>`。
2. console 按账户选节点：号商账户取该号商在线节点（固定 `node_id` 时只用它），平台自有账户取其固定的平台节点；下发 `http_egress.open`。
3. 网关把隧道包装成 Duplex（写 = `POST /:id/data`，读 = `GET /:id/read` 长轮询），写入一行 JSON spec `{url, headers, bodyBase64}`，
   读回一行 JSON 头 `{status, headers}`（或 `{error, message}`），随后是原始响应 body 字节流直到会话关闭。**TLS 在节点终止**（Bun），
   请求经节点的强制代理发出；节点看得到明文请求头，但不记录不持久化。
4. 头行为 `error`（`no_proxy_available` 等）= 基础设施失败：跳过该账户、不计尝试；HTTP 状态 ≥ 400 按 §5 处理。

`PROVIDER_TUNNEL_TARGET_HOST` / `_PORT` 是 v1 遗留环境变量，v2 下不再生效（节点自行决定出口）。

**压缩体解码（2026-10-16）**：节点对 Anthropic `/v1/*` 以 `decompress: false` 拉上游并保留 `content-encoding`，`fetchViaTunnel` 按该头用 zlib
流式解码（`decompressBody`：gzip / deflate / br / zstd）后再交给上层，并删掉 `content-encoding` / `content-length`。节点侧 `/api/oauth/*` 等辅助
端点仍由 Bun 解压（console 的 `requestViaNode` 读 JSON 不受影响）。

## 10. TEE 证明桩

HMAC-SHA256(`PROOF_SECRET`, `upstream_host:sha256(body)`)，不是硬件证明。**只在请求带 `x-1dayapi-tee-proof-mode` 头时输出**：
非流式且值为 `multipart` → `multipart/mixed`，第二段 `x-1dayapi-part: tee.proof`；流式 → 末尾追加 `event: tee.proof`。
不带此头时网关不改动上游协议。未设 `PROOF_SECRET` 时每次启动随机生成（重启后旧证明无法复核）。

## 10a. 云端会话执行器（executor=ccr，`src/ccr/`）

契约与假设清单见 [`ccr-supply.md`](./ccr-supply.md) §5.1 / 附录 A。流程：

1. 进入账户循环前按请求做一次能力检查（`ccrUnsupportedReason`）：含 `image` / `document` 块，或 `tool_choice` 为 `any` / `tool` →
   跳过所有 CCR 账户（不计尝试）；若因此一个账户都没试 → 400 `ccr_unsupported_content` / `ccr_unsupported_tool_choice`。
2. `runCcr()`：凭证需 `accessToken` + `orgUuid`；`environmentId` 缺失时先 `POST /v1/environment_providers/cloud/create` 并加密回写。
   每请求建一个会话（`config.model` = 映射后的模型），推送 `set_model` + `user` 两个事件（请求体经 `messagesToPrompt()` 折叠成单条文本），
   然后每 `CCR_POLL_INTERVAL_MS` 轮询 `GET …/events?sort_order=asc`，按事件 id / uuid 去重后喂给 `SessionTranslator`。
3. 非流式：收到 `result` 后返回完整 Messages JSON；流式：返回 `text/event-stream` 的 `Response`，边轮询边转写
   （带 `tools` 的请求为缓冲回放，以便把模拟的工具调用合成 `tool_use` 块）。
4. 会话 API 非 2xx 以同状态码的错误 `Response` 返回，走 §5 的冷却 / 换账户规则；超时与网络错误按 502 处理（transient 冷却）。
   流已开始后的错误以 `event: error` 结束流。
5. 用量：`result.usage`（否则各轮 assistant usage 累加），由 `deliver()` 的 Anthropic 分支照常抽取并结算；TEE 桩的 host 为账户 Base URL 的 host。

单元测试 `apps/gateway/test/translate.test.mjs`（`pnpm --filter @1dayapi/gateway test`）；端到端 `tests/e2e/ccr.test.mjs`。

## 11. 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` / `HOST` | `8400` / `0.0.0.0` | 监听 |
| `CONSOLE_BASE` | `http://127.0.0.1:8401` | 隧道管理器（console）地址，必须是本机回环 |
| `GATEWAY_MAX_ATTEMPTS` | `3` | 每请求最多尝试的上游账户数 |
| `UPSTREAM_TIMEOUT_MS` | `300000` | 等待上游响应头的超时（直连与经节点都用它；经节点时随 `headersTimeoutMs` 下发给节点） |
| `STREAM_IDLE_TIMEOUT_MS` | `120000` | 流式 body 两个 chunk 之间的最大静默，超过即放弃该流（§5.2） |
| `PROOF_SECRET` | 随机 | TEE 桩签名密钥 |
| `DATA_DIR` / `DB_PATH` | `data/` / `data/1dayapi.db` | 与 console 必须一致 |
| `PROVIDER_CRED_KEY` / `INTERNAL_TOKEN` | 读 `data/` 下文件 | 与 console 必须一致；`INTERNAL_TOKEN` 同时保护网关自己的 `GET /internal/inflight`（console 读实时在途数，见 console-api.md 管理端 `GET /accounts`） |
| `PROVIDER_TUNNEL_TARGET_HOST` / `_PORT` | 空 | 仅开发 |
| `CCR_POLL_INTERVAL_MS` | `1000` | 云端会话 events 轮询间隔 |
| `CCR_SESSION_TIMEOUT_MS` | `600000` | 单次会话从建会话到 `result` 的总上限 |
| `CCR_HTTP_TIMEOUT_MS` | `60000` | 会话 API 单次 HTTP 调用超时 |
| `CCR_POOL_MAX_TURNS` | `50` | 会话池：单会话最大复用轮数（ccr-supply.md §5.3） |
| `CCR_POOL_IDLE_MS` | `1800000` | 会话池：空闲退役阈值（30min） |
| `CCR_POOL_SWEEP_MS` | `60000` | 会话池：sweeper 间隔（空闲超时 + 账号删除/禁用归档） |
| `LOG_LEVEL` | `info` | |

v2 的 `UPSTREAM_ANTHROPIC_*` / `UPSTREAM_OPENAI_*` 直连兜底已删除：上游一律在控制台以"上游账户"配置。

2026-10-28：usage 非法值转受限估算；正常流必须出现协议完成事件。结算使用 fsync 持久意图及原价快照，数据库暂不可用时暂停新推理准入并幂等补账。取消贯穿刷新凭据、排队、隧道、worker 和流读取；响应遵守背压和大小预算。详见 [逐项修复记录](audit-remediation-2026-10-28.md)。
