# 错误码总表（v3）

统一信封：`{"error":{"code":"...","message":"...","type":"..."}}`。例外：网关 `/v1/messages` 用 Anthropic 方言
`{"type":"error","error":{"type","message","code"}}`；`/internal/tunnel/read` 的 `error` 字段见 §4。
`message` 给人看，客户端只依赖 `code`。

## 1. 推理网关（apps/gateway）

| HTTP | code | type | 触发 |
|---|---|---|---|
| 400 | `missing_required_parameter` | invalid_request_error | 缺 `model`；`/v1/messages` 缺数字型 `max_tokens` |
| 400 | `unsupported_endpoint` | invalid_request_error | 分组里有支持该模型的账户，但都不支持当前端点（如 Anthropic 账户上调 `/v1/responses`） |
| 400 | `ccr_unsupported_content` / `ccr_unsupported_tool_choice` | invalid_request_error | 候选只剩云端会话（CCR）账户，而请求含图片 / 文件块，或 `tool_choice` 为 `any` / `tool`（`ccr-supply.md` §6） |
| 400 | `bad_request` | invalid_request_error | 请求体解析失败等 Fastify 4xx |
| 400 | `invalid_request` | invalid_request_error | 请求在发往上游前就被节点 / 平台拒绝（2026-10-19 起）：worker 路径消息里没有任何文本（`empty_prompt`，message 说明）、console 开会话校验失败（`console_*`）、节点拒绝 spec（`bad_spec` / `bad_url` / `target_not_allowed`）。只答一次，不换账号。此前这些情况会表现为 503 `no_available_account` |
| 400 | `cc_profile_mismatch` | invalid_request_error | 直连 profile 严格模式（settings `direct_profile_strict`，gateway.md §2a）：归一化后的出站请求不再是入站同一 Claude Code profile 的 genuine 请求（message 列出缺失项），**未发往上游**；只答一次，不换账号。计 `cc_profile_mismatch_total` |
| 400 | `prompt_too_long` | invalid_request_error | worker 路径：会话超出模型上下文窗口，message 为 Claude Code 原句（"Prompt is too long · the request is ~N tokens (limit 1000000) …"），Claude Code 客户端据此自动 compact。不换账号、不冷却（2026-10-19 起；此前记为 502 `upstream_stream_error`） |
| 400 | `safeguards_refusal` | invalid_request_error | worker 路径：Anthropic 安全分类器拒绝（"… safeguards flagged this session …" / "… can't help with this. Start a new session …"），message 为 Claude Code 原句。内容问题，不换账号、不冷却，客户端不应原样重试（2026-10-19 起；此前为 502） |
| 413 | `request_too_large` | invalid_request_error | 节点出口拒绝超大 spec（48 MiB，约等于 32 MB 请求体）；只答一次（2026-10-18 起） |
| 401 | `invalid_api_key` | authentication_error | 未带 Key 或 Key 不存在 |
| 401 | `key_disabled` / `key_expired` | authentication_error | Key 停用 / 过期 |
| 401 | `user_disabled` | authentication_error | Key 所属账户被禁用 |
| 402 | `insufficient_balance` | billing_error | 无授信额度的用户：预付余额 ≤ 0 |
| 402 | `credit_exhausted` | billing_error | 有授信额度的用户：`授信额度 − 本期已用 + 预付余额` ≤ 0，需管理员结算后恢复（2026-10-19 起，data-model.md §4） |
| 403 | `role_not_permitted` | permission_error | 号商账户的 Key（号商不能调推理） |
| 403 | `group_disabled` | permission_error | Key 绑定的分组不存在或停用 |
| 403 | `model_not_allowed` | permission_error | 分组白名单不允许该模型 |
| 404 | `model_not_found` | not_found_error | 模型不在注册表或已下架 |
| 404 | `not_found` | not_found_error | 未知路由 |
| 429 | `quota_exhausted` | billing_error | Key 额度用尽 |
| 429 | `upstream_rate_limited` | rate_limit_error | 尝试过的账户最后都是账号/窗口限流 |
| 429 | `upstream_request_rejected` | rate_limit_error | 直连上游把请求本身拒绝（客户端版本、请求权益/形态等）：不换账号、不冷却，客户端修正后再试；用量行 `error_scope=request`、`retryable=false` |
| 429（用量行） | `upstream_model_rate_limited` | — | 模型额度/权益限制：只冷却该账号的 `model:<id>`，其他模型仍可调度，换账号重试；用量行 `error_scope=account_model` |
| 透传 | 上游原样 / `upstream_client_error` | invalid_request_error | 上游 400/404/413/422 直接透传；跨协议时包装成客户端方言 |
| 500 | `internal_error` | api_error | 未处理异常 |
| 501 | `not_implemented` | invalid_request_error | 图片 / 视频生成 |
| 502 | `upstream_error` | upstream_error | 上游 5xx / 网络错误 / 鉴权失败，且所有候选都失败；或 200 之后 body 读取失败（gateway.md §5.2） |
| 502（用量行） | `upstream_stream_error` | — | 流式响应在终止符之前出错或中断：只出现在 `usage_logs.error_code`，客户端收到的是流内的错误事件（gateway.md §5.2）。流里识别出 `prompt_too_long` / `safeguards_refusal` 时用量行记 400 与对应 code，流内错误事件 type 为 `invalid_request_error` |
| 503 | `no_available_account` | upstream_error | 无候选账户，或候选都因并发满 / 节点离线未能尝试。2026-10-19 起请求本身的问题不再落到这里，收到它就是真的没有可用供给，客户端应退避重试 |
| 503 | `team_capacity_exhausted` | upstream_error | **工具轮**（最后一条消息是 `tool_result` / `tool` / `function_call_output`）所在组织暂无可调度账号，或其账号全部尝试失败（2026-11-01 起）。工具轮不再切换组织、不重置代次：先等待至多 `ACCOUNT_BUSY_WAIT_MS`（默认 15 s）看组织是否恢复，仍不可用则返回本码并带 `Retry-After: 30`；对话上下文保留，客户端**原样重试同一请求**即可。此前（2026-10-30/31）同一情形切换组织后返回 409 `tool_continuation_after_reset`，两天 771 次 |
| 409 | `tool_continuation_after_reset` | invalid_request_error | 工具轮的 `tool_use` 不是本平台当前代次发出的：历史策略 `reset` 下带着外部历史的工具轮（`history_unknown` 的工具轮形态），或代次重置后残留的旧工具轮。2026-11-01 起组织容量耗尽不再触发此码（见 503 `team_capacity_exhausted`） |

**Retry-After 与响应头**（2026-11-01 起）：平台产生的每个 429 带 `Retry-After: 10`、每个 503 带 `Retry-After: 15`（`team_capacity_exhausted` 为 30；原样透传分组的上游值照转）。每个响应（成功或失败，含流式与提前 200 的头）带 `request-id`（网关请求 id，与 `usage_logs.request_id` 一致，用于对账）和 `x-1day-mode: direct | worker | relay`（实际执行路径：订阅直连 / 节点上的 Claude Code worker / 原样透传中转）。请求里有该路径无法生效的字段时带 `x-1day-ignored-params: temperature,top_k`（不报错，只告知；见 client-notes）。上游的 `request-id` / `anthropic-ratelimit-*` 不转发：它们描述的是本次服务的订阅账号而不是客户的 Key。

迁移 32 起失败行还带统一错误对象：`error_scope`（`request` / `account_model` / `account` / `node_proxy` / `transport`）、`retryable`、`credential_version`、`execution_sequence`。节点代理失败与上游传输失败分开；凭据每次变更版本加 1，强制刷新后的重试使用新版本；同一客户请求的首次执行为 1，故障转移/刷新重试递增。

失败请求同样写入 `usage_logs`（`status_code`、`error_code`，费用 0）。v2 的 `key_revoked`、`upstream_not_configured`、
`upstream_unreachable` 已不再产生。

## 2. 控制台（apps/console）

| HTTP | code | 触发 |
|---|---|---|
| 400 | `invalid_request` | 参数缺失 / 类型错误 / 越界（message 指明字段）；业务约束（如不能禁用自己、route=node 需号商） |
| 400 | `invalid_amount` | 调账金额为 0 |
| 400 | `insufficient_balance` | 号商结算金额超过未结算余额 |
| 400 | `key_limit_reached` / `group_not_available` | 建 Key 超上限 / 分组不存在或无权使用 |
| 400 | `key_not_revealable` | legacy Key 不能再次查看 |
| 400 | `code_invalid_or_used` | 兑换码无效、已用、已停用或过期 |
| 400 | `invalid_allowlist` | 白名单启用但为空、或格式错误 |
| 400 | `group_protected` / `group_in_use` | 删除 / 停用默认组；分组仍有 Key |
| 400 | `user_has_usage` | 删除有用量历史的用户（应改为禁用） |
| 400 | `node_not_found` / `node_offline` / `node_at_capacity` | 账户固定到节点：节点不存在 / 不在线（PATCH）/ 账号数已达容量 |
| 400 | `window_probe_failed` | 订阅窗口探测失败（网络 / 非 2xx / 无法解析），message 为原因 |
| 401 | `unauthorized` | 无有效会话 |
| 401 | `invalid_login_key` / `user_disabled` | 登录失败 |
| 401 | `invalid_provider_secret` / `invalid_binding_code` | 节点凭证 / 绑定码无效 |
| 403 | `role_not_permitted` | 角色不符 |
| 403 | `forbidden` | 内部隧道端点：非回环或内部令牌不符 |
| 404 | `user_not_found` / `key_not_found` / `group_not_found` / `account_not_found` / `node_not_found` / `model_override_not_found` / `session_not_found` | 对象不存在 |
| 404 | `not_found` | 未知路由 |
| 409 | `group_exists` | 分组重名 |
| 409 | `node_bound_elsewhere` | nodeId 已绑定到其他号商 |
| 409 | `settings_revision_conflict` | 设置已被其他管理员/进程改成新 revision；重新读取并复核，不用旧文档覆盖 |
| 428 | `settings_revision_required` | 设置写入缺 `_revision` 或 `If-Match`；先 GET 当前版本 |
| 429 | `too_many_attempts` | 同 IP 10 分钟内登录失败 ≥ 20 次 |
| 503 | `no_online_node` | 隧道 open 时号商无可用节点 |
| 500 | `internal_error` | 未处理异常 |

## 3. 号商节点本地控制台（apps/provider-node，127.0.0.1:16889）

| HTTP | code | 触发 |
|---|---|---|
| 400 | `invalid_binding_code` | 绑定码不以 `bind_` 开头 |
| 400 | `invalid_vendor` | 手动粘贴的 vendor 不是 anthropic/openai |
| 400 | `invalid_token_json` | 粘贴的 token 无法解析或缺 access token |
| 403 | `forbidden_host` | Host 头不是本机回环 |
| 403 | `csrf_token_invalid` | 写请求缺少/错误的 `x-1dayapi-csrf` |
| 403 | `loopback_only` | 写请求不是从本机（127.0.0.1 / ::1）发起（即使控制台绑定在非回环地址） |
| 404 | `no_local_credentials` | 本机没探测到凭证 |
| 404 | `not_found` | 未知路由 |
| 409 | `not_bound` | 未绑定时上传凭证 |
| 502 | `platform_unreachable` | 连不上平台 |
| 502 | `bad_platform_response` | 平台绑定响应缺字段 |
| 502 | `credential_upload_failed` | 上传凭证到平台失败 |
| 透传 | 平台的 code（如 `invalid_binding_code`）/ `bind_failed` | 平台绑定返回非 2xx |

## 4. 供应端协议内的原因码

`official_exit.open_response.reasonCode`（节点拒绝开洞）：
`node_identity_mismatch`、`node_draining`、`target_not_allowed`、`invalid_target_port`、`duplicate_session`。

`official_exit.error.errorCode`：`connect_timeout`，或 Node socket 错误码（`ECONNREFUSED`、`ENOTFOUND`…）。

协议 v2 `http_egress` 头行 `error`（管道内，账户级跳过）：`bad_spec` / `bad_url` / `target_not_allowed` / `no_proxy_available` /
`upstream_connect_failed` / `spec_too_large`；`http_egress.error.errorCode`：`request_timeout`（等 spec 或响应头超时）。

`official_exit.close.reasonCode`：节点侧 `target_closed`、`transport_lost`；平台侧 `closed`、`idle_timeout`。

隧道读结果 `{closed:true, error}` 的 `error`：节点的 `errorMessage`/`errorCode`，或平台的 `node_disconnected`。

平台内部 open 失败原因（不对外暴露，统一表现为 503）：`open_response_timeout`、`node_disconnected`、节点的拒绝原因。

## 5. WS 关闭码（平台 → 节点）

| code | reason | 节点行为 |
|---|---|---|
| 4000 | `superseded` | 同一 nodeId 有新连接，旧连接被踢；正常重连 |
| 4001 | `invalid_provider_secret` | 抑制重连 |
| 4001 | `provider_identity_mismatch` | 抑制重连 |
| 4003 | `unbound_by_provider` / `removed_by_admin` / `provider_disabled` | 号商解绑、管理员移除节点、号商被禁用（之后重连会因节点已删除或号商已禁用收到 4001） |
| — | `node_paused` / `node_revoked` | 节点会抑制重连，但**平台从不发送** |
