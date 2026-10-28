# 接入方适配说明（2026-10-19）

面向调用 `https://api.1dayapi.com` 的客户端（Anthropic Messages 方言 `/v1/messages`，以及 OpenAI 方言 `/v1/chat/completions`）。
本文只写**客户端能感知到的变化**，内部实现见 `gateway.md` §3 / §5 与 `errors.md`。单价与计费公式没有变化。

## 1. 新增错误码：这些错误以前是 502 / 503，现在是 400

错误信封不变：Anthropic 方言 `{"type":"error","error":{"type","message","code"}}`，OpenAI 方言 `{"error":{"message","type","code"}}`。
流式请求里，错误以流内事件返回（Anthropic 方言 `event: error`，OpenAI 方言一个 `{"error":…}` 块且不发 `[DONE]`），`type` 同下表。

| HTTP | `code` | `type` | 含义 | 客户端应当 |
|---|---|---|---|---|
| 400 | `prompt_too_long` | `invalid_request_error` | 会话超出模型上下文窗口。`message` 以 "Prompt is too long · the request is ~N tokens (limit 1000000) …" 开头 | 压缩 / 截断会话后再发。Claude Code 客户端看到这句话会自动 compact，无需处理 |
| 400 | `safeguards_refusal` | `invalid_request_error` | Anthropic 安全分类器拒绝了这段内容（"… safeguards flagged this session …" / "… can't help with this. Start a new session …"） | 不要原样重试，换账号也是同样结果；提示用户修改内容或开新会话 |
| 400 | `invalid_request` | `invalid_request_error` | 请求在发往上游前被拒：例如消息里没有任何文本（`message` 说明原因） | 按 `message` 修正请求，不要重试 |
| 413 | `request_too_large` | `invalid_request_error` | 请求体过大（上限 32 MB，与 Anthropic 官方一致） | 缩小请求 |

**为什么重要**：以前这几类情况会返回 503 `no_available_account` 或 502 `upstream_error` / 流内 `api_error`，客户端往往会按"服务端故障"退避重试，
白白等待。现在 **4xx 都是请求本身的问题，重试无效；503 `no_available_account` 只在真的没有可用供给时出现，退避重试即可**。

## 2. 模型 ID

- 推荐使用规范 ID（横线）：`claude-opus-5-5`、`claude-sonnet-5-5`、`claude-haiku-4-5`、`claude-fable-5-1`。
- 带日期的快照 ID（`claude-sonnet-4-5-20250929`）照常接受。
- 点号写法（`claude-opus-5.5`、`claude-haiku-4.5`）现在也能解析，不再 404；账单与日志按你发送的写法记录，单价按规范模型。仍建议改用规范 ID。

## 3. `thinking` 参数（Anthropic 方言）

Anthropic 对 5.x 系列模型收紧了 `thinking` 取值：`{type:"enabled", budget_tokens:N}` 在 5.x 全系及 Opus 4.7/4.8 返回 400；
`{type:"disabled"}` 在 Fable 5 / 5.1 与 Opus 5.5 返回 400（Sonnet 5.5 的关闭形态是 `{type:"between_tools"}`）。

网关现在会在转发前按目标模型把这些值改成上游接受的形态（budget → `adaptive`；不支持关闭的模型删掉 `thinking`），所以旧客户端不会再收到这类 400。
但语义会有差异（例如你要求关闭思考、模型实际按默认 adaptive 运行并产生思考 token 计费）。**建议客户端直接按官方规则发送**：
`thinking: {type:"adaptive"}` 并用 `output_config.effort`（`low` / `medium` / `high` / `xhigh` / `max`）控制深度。
使用 Claude Code 的用户请升级到 2.1.295 以上，旧版 2.1.220 仍会对 Fable 5 发 `disabled`。

## 4. 消息文本中的 `@路径`

此前订阅路径上的执行器会把消息文本里形如 `@src/index.ts`、`@/etc/hosts` 的片段当作文件引用去读取，导致会话体积异常膨胀、偶发
"Prompt is too long"。此行为已关闭：`@…` 现在只是普通文本，和官方 API 一致。如果你的应用依赖这种"自动附件"效果（不应有），请改为把文件内容放进消息。

## 5. 发布与可用性

- 网关发布改为蓝绿切换，发布期间不再有连接被拒（此前每次发布约 1 分钟内新请求可能收到 nginx 502）。
- 三台服务器的 DNS 改为公共解析器优先，10-18 晚间那类"节点同时掉线数分钟"的故障不会再因机房解析器抖动发生。

## 6. 计费模式：授信

平台计费从"预付余额"改为**授信**：管理员为每个账户设置授信额度，用量先扣预付余额（如有），其余累计为"本期已用"；到达额度后请求返回 `402 credit_exhausted`（`type: billing_error`），message 中给出已用 / 额度；管理员结算后额度恢复，无需换 key。控制台「钱包」页可以看到可用额度、本期已用和每次结算记录。没有被设置授信额度的账户保持原来的余额逻辑（`402 insufficient_balance`）。

## 7. 重试建议汇总

| 收到 | 处理 |
|---|---|
| 400 / 404 / 413 任意 `code` | 修正请求，不重试 |
| 402 `credit_exhausted` / `insufficient_balance` | 不重试；联系管理员结算 / 充值 |
| 429 `upstream_rate_limited` / `quota_exhausted` | 按 `Retry-After` 或指数退避 |
| 502 `upstream_error` | 可重试 1–2 次（上游或网络瞬时故障） |
| 503 `no_available_account` | 指数退避重试（起步 5–10 秒）；持续超过 1 分钟请联系我们 |
| 流式：流在 `message_stop` / `[DONE]` 前以错误事件结束 | 看错误事件的 `type`：`invalid_request_error` 不重试，`api_error` 可重试 |
