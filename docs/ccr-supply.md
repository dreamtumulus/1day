# 云端会话供给（CCR）设计

> 状态：**规划中 → 骨架已落地**（2026-10-15）。不依赖附录 A 的部分已实现：账户 `executor` 维度与窗口字段
> （迁移 3）、配额窗口调度与巡检、网关翻译层骨架（`apps/gateway/src/ccr/`），由 `tests/e2e/ccr.test.mjs` 对 mock 会话 API 覆盖。
> 出站事件流 schema 仍待附录 A 首抓确认（见 §5.1 与附录 A 的核对清单）。
> 本文档是契约级设计；与既有"直连/API Key 供给"（v2 指纹路径）并行，不替代。
> 相关：`v3-design.md`（账户体系）、`claude-code-compat.md`（客户端兼容性规范）、`provider-protocol.md`。

## 1. 定位

CCR（Claude Code Remote）云端会话是 Claude Code 官方提供的远程执行能力：账号下创建
云端执行环境（environment），在环境内创建 code session，向会话推送事件（用户消息、
控制指令），由官方云端 worker 执行 Claude Code 并产生响应事件。

平台把该能力作为一种**上游供给类型**：客户侧的 Messages API 请求被翻译成
code session 事件流，执行结果再翻译回 Messages API 响应。与直连路径的分工：

| | 直连路径（v2 已有） | 云端会话路径（本文档） |
|---|---|---|
| 上游凭证 | 官方 API Key / 第三方中转 | 订阅账号 OAuth 令牌 |
| 执行者 | 平台节点发 HTTPS 请求 | 官方云端 worker |
| 客户端兼容性 | 平台侧负责（compat 规范） | 由官方 worker 天然保证 |
| 功能完整度 | 完整（thinking / 工具 / 缓存） | 受会话形态约束（见 §6 能力矩阵） |
| 计费单位 | 上游按量 | 订阅窗口配额（滚动时间窗） |
| 适合产品 | 全功能 API 档 | 云端 Claude Code 任务档 |

## 2. 账号接入（授权流程）

订阅账号接入的产物：OAuth 令牌对（access_token / refresh_token）+ 组织 UUID + 环境 ID。
完整请求、scope/client 矩阵及 Bridge/SI 细节见 [`onboarding.md`](./onboarding.md) §2、§9。

**2026-10-18 协议复核结论**：sessionKey 可以经非浏览器直连完成授权码 + PKCE 交换。
`POST https://api.anthropic.com/v1/oauth/{org}/authorize` 以 `Authorization: Bearer <sessionKey>`
提交后，可从返回的 `redirect_uri` 取 code，再调用 `/v1/oauth/token` 获取 access/refresh token。
该流程不要求打开同意页，也不依赖浏览器自动化；服务器浏览器 bot 已删除，控制台实现见 `onboarding.md` §2.1。旧的“必须真实浏览器”结论只适用于当时实验使用的
全 scope 与请求组合，不再作为新接入的限制。

- **Chrome Extension**：`dae2cad8-...`，scope `user:profile user:inference user:chat`；
  token exchange 使用 `https://platform.claude.com/v1/oauth/token` 的表单编码。
- **Claude Code runner**：`9d1c250a-...`，scope `user:ccr_inference user:file_upload`；
  token 可 validate，但不能用于 `/chrome/{accountUuid}`。
- **Bridge environment / SI**：scope `user:sessions:claude_code user:file_upload`；
  用于 `/v1/environments/bridge`、`environment_secret`、work/poll 和 SI token。
- **官方 Remote Control 全量接入**：`user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload`，
  已由官方进程完成 environment、work、ack 和 worker/register。

令牌参数：access_token 有效期 28800s（8h）；refresh_token 长期有效、刷新即轮换；
刷新端点 `POST https://platform.claude.com/v1/oauth/token`（`grant_type=refresh_token`，client_id 为官方 CLI 的公开 ID）。
刷新请求无会话新鲜度要求，可长期自动保活。

健康检查（免费、不消耗配额）：`POST https://api.anthropic.com/api/oauth/validate`（Bearer）。
注意该端点有 scope 门槛（`user:profile / user:office / user:ccr_inference / user:chrome_bridge` 之一），
最小 scope 令牌会返回 403——巡检时按账号 scope 区分语义。旧 SK 在 authorize 阶段出现
`session_stale_relogin` 则表示登录新鲜度不足，不等同于 token 无效。

## 3. 环境 provisioning（每账号一次）

```
POST https://api.anthropic.com/v1/environment_providers/cloud/create
Headers: Authorization: Bearer <access_token>
         anthropic-version: 2023-06-01
         anthropic-beta: ccr-byoc-2025-07-29
         x-organization-uuid: <org>
Body: {"name": "...", "kind": "anthropic_cloud", "description": "..."}
→ {"environment_id": "env_01…", "state": "active",
   "config": {"environment_type": "anthropic", "sub_type": "ccr", "cwd": "/workspace", …}}
```

已验证：个人订阅（Pro）账号可创建成功。环境 ID 落库到账户 `credentials`（加密）。

## 4. 会话生命周期

```
POST https://api.anthropic.com/v1/code/sessions
Headers: Authorization: Bearer <access_token> + anthropic-version + x-organization-uuid
         + anthropic-beta: ccr-byoc-2025-07-29 + anthropic-client-feature: ccr
Body: {"environment_id": "env_01…",
       "config": {"model": "<模型ID>", "sources": [], "outcomes": [], "cwd": "...", "name": "..."}}
→ {"session": {"id": "cse_01…", ...}}
```

注意（实测）：

- 该端点只接受 Bearer 令牌；不接受站点 cookie 认证（401），也不接受两种凭证混用（400）。
- 会话是有状态的 agentic 执行单元：有工作目录、有上下文累积、云端 worker 可能多轮自主行动。

## 5. 推理与读回（events）

```
POST /v1/code/sessions/{id}/events
{"events": [
  {"payload": {"type": "control_request", "request": {"subtype": "set_model", "model": "<模型ID>"}}},
  {"payload": {"type": "user", "uuid": "<uuid>", "session_id": "<sid>",
               "message": {"role": "user", "content": "..."}}}]}

GET /v1/code/sessions/{id}/events?sort_order=asc   （轮询读回事件流）
```

事件流包含 assistant 消息、执行进度、用量等（**详细 schema 待首抓**——按计划用测试账号
全链路跑通后落本文档附录）。翻译层以事件流为输入。

### 5.1 翻译层（已实现骨架，`apps/gateway/src/ccr/`）

| 文件 | 职责 | 依赖附录 A？ |
|---|---|---|
| `client.ts` | 会话 API HTTP 客户端：建环境（§3）、建会话（§4）、推 / 拉 events（§5）。头集按 §3/§4 实测值 + Claude Code 指纹头 | 分页参数（`has_more` / `next_cursor`）为假设 |
| `translate.ts` | **请求侧** `messagesToPrompt()`：Messages 请求折叠为单条 user 文本；`buildSessionEvents()`：生成 §5 的 `set_model` + `user` 事件。**响应侧** `SessionTranslator`：事件 payload → Anthropic Messages SSE / 最终 JSON + usage | 响应侧 payload 形状为假设 |
| `executor.ts` | `runCcr()`：每请求一个会话（建环境懒执行并回写凭证 → 建会话 → 推事件 → 轮询读回 → 翻译），返回 Anthropic 线协议的 `Response`，交给网关既有的交付 / 用量 / 结算管道 | 否 |
| `types.ts` | 入站（已验证）与出站（**临时**）事件类型 | 出站部分 |

**请求折叠规则**（§6 多轮折叠）：单轮纯文本请求原样发送；否则拼成
`[system]…\n\n[tools]…\n\n[user]…\n\n[assistant]…` 的文本。`thinking` 块丢弃；`tool_use` 块折叠为 ```` ```tool_call ```` 围栏，
`tool_result` 折叠为 `[tool_result for <id>]` 段。**原生工具会话例外（2026-10-23）**：`omitTools` 时 `tool_use` 折成
`[tool_use <id> <name>]\n<input JSON>` 行而不是围栏——模型要调的是 MCP 工具，不能让它学到一种可模仿的文本写法；worker 系统提示同日加了
一段说明"`[user]`/`[assistant]`/`[tool_result …]` 是对话记录，只写你的下一轮，不要续写记录、不要编造工具输出"。
翻译层另有**转录护栏**（`transcriptGuard`，仅 worker 路径）：回答开头的 `[assistant]` 标题去掉；模型自己写出 `[tool_result for …]` 即在此截断
（`end_turn`、取消会话，伪造的工具结果不会流给客户）；原生工具模式下以文本写出的 ```` ```tool_call ```` 围栏转成真正的 `tool_use`
（名字须在客户工具表里），围栏之后的"续写记录"丢弃；围栏模拟模式同样丢弃围栏后的续写。命中记网关日志 `transcript guard … : <kinds>`。
背景：opencode 客户收到整段 `[assistant] … ```tool_call … [user] [tool_result for …]` 正文，其中 rm / nginx reload 的"结果"全是模型编的
（worker-sessions.md 进度 2026-10-23）。

**自定义工具的 prompt 级模拟**：请求带 `tools` 时在 `[tools]` 段给出 JSON schema，并约定"调用工具 = 回复末尾恰有一个
```` ```tool_call ```` 围栏，内含 `{"name","input"}`"。翻译层在会话结束后从最后一个文本块尾部抽出该围栏，合成 `tool_use` 块，
`stop_reason=tool_use`。为此带 tools 的流式请求采用**缓冲模式**：等会话结束后一次性回放整条消息的 SSE。

**出站事件的假设形状**（`SessionTranslator` 是唯一消费者，附录 A 落地后只改这一处）：payload 遵循 Claude Code SDK 的
stream-json 消息族——`{type:"assistant", message:{id, content:[…], usage}}`、`{type:"result", subtype, is_error, result, usage}`、
可选的 `{type:"stream_event", event:<原生 Messages 流事件>}`（有则按增量转写，同 `message.id` 的整条 `assistant` 消息只用于收尾）、
`system`/`user`/`control_response` 忽略。每个 assistant 文本块成为一个 content block；worker 的内建 `tool_use`、思考块不输出；
`result.usage` 为权威用量（否则累加各轮 assistant usage）；`result` 结束消息。
- **`result.is_error` 的处理（2026-10-16 修正）**：worker 的 `result` 带 `is_error:true` 且 subtype 非 `error_max_turns` 时，不论之前是否已经
  流出了部分文本，一律视为失败：非流式返回 502 `ccr_worker: <result 文本> (after partial output)`，流式在已发出的块之后补一个 SSE `error`
  事件（不发 `message_stop`），网关按 `upstream_stream_error` 记 502、不计费。此前"已产出内容"的错误结果被当成功交付（客户拿到截断的回答 +
  200，用量回退为 chars/4 估算），高峰期每小时几十条；节点日志 `worker_failed` 与网关 200 对不上就是这个症状。`error_max_turns` 在有输出时仍按
  `stop_reason: max_tokens` 正常结束。网关失败时打 `[ccr-worker] <id> result subtype=… is_error=…: <文本头>`，节点在 `worker_failed`
  行后附 stderr 尾（200 字）。

**网关接线**：`modeFor()` 对 `executor=ccr` 账户返回 `ccr-anthropic`（客户端 `/v1/messages`）或 `ccr-chat`（`/v1/chat/completions`，
先经既有 Chat→Messages 转换），`/v1/responses` 不支持。执行器输出 Anthropic 线协议，交付时映射回 `passthrough-anthropic` /
`chat-via-anthropic`，用量抽取、结算、TEE 桩与直连路径完全一致。会话 API 的非 2xx 按 §7.3 的状态码规则冷却 / 换账户；
网关环境变量 `CCR_POLL_INTERVAL_MS`（1000）、`CCR_SESSION_TIMEOUT_MS`（600000）、`CCR_HTTP_TIMEOUT_MS`（60000）。

### 5.2 双模路由：订阅账号按客户端身份选执行模式（2026-10-15 拍板）

订阅 OAuth 账号（`type=oauth, platform=anthropic`）同时具备两种执行能力，网关按**客户端身份**自动选路，
同一账号池服务两类客户：

| 客户端 | 判定 | 执行模式 | 说明 |
|---|---|---|---|
| Claude Code 系 | UA 以 `claude-cli/`、`claude-code/` 开头，**且**请求形态通过 `classifyCcRequest` 硬检查（docs/gateway.md §2a；只有 UA 的伪造按 `cc_shape_policy` 记录 / 降级 / 拒绝） | **直连模式**：OAuth Bearer + `oauth-2025-04-20` beta + 客户端兼容性头集，经节点钉死代理出网 | 与 CC 登录订阅后的原生行为逐字段一致；tools/thinking/缓存/流式全真 |
| 其他（SDK / 脚本 / chat 应用） | 其余 | **云端会话模式**（`executor=ccr`，本章 §5.1） | 能力边界见 §6 |

规则：

- R1：CC 系客户端的请求，候选账号过滤为「可直连 Anthropic 线协议的账号」（`apikey`/`upstream`/`oauth` 均可）；
  `executor=ccr` 的订阅账号此时按直连模式使用，不走云端会话。**CC 客户永远不会落到云端会话路径。**
- R2：非 CC 客户端 + `executor=ccr` 账号 → 云端会话模式。
- R3：非 CC 客户端 + `executor=direct` 账号 → 现有直连（行为不变）。
- 两种模式消耗同一订阅窗口配额，窗口调度（§7）与并发/RPM 限额（`onboarding.md` §6.3）对两种模式统一生效。

动机：云端会话路径的工具是 prompt 级模拟，承载不了 CC 客户端的真实工具往返（会露馅）；
而订阅 token 直打 Messages API 正是 CC 的原生形态，零降级。

### 5.3 会话池与释放（2026-10-16 拍板，X-12 解决）

会话冷启动实测 6–12s，复用可降到 ~2s 级；往既有 `cse_` 会话推新 user 事件已验证可行。
实现：`apps/gateway/src/ccr/session-pool.ts`（纯记账，DB/HTTP 由回调注入）+ executor 接线。

- **池键**：`accountId + upstreamModel + 客户端会话粘性键`。粘性键只认最强会话身份——
  请求 `metadata.user_id` 里的 `session_<hex>`（前缀 `s:<apiKeyId>:` 隔离调用方）。
  **无粘性键的请求一律不复用**（污染防护：折叠 prompt 会重放完整客户端历史，
  复用到无关会话实测会串味），仍每请求新建，完成即归档（见下）。
- **复用条件**：同键 + 轮数 < 50 + 空闲 < 30min + 无错误史 + 当前空闲（busy 不双发）。
  复用时模型已在键内，`set_model` 控制事件跳过，只推 user 事件。
- **水位**：每账号温会话数 ≤ 并发上限（`concurrency`>0 取之，否则默认 8）；注册超出时归档最久空闲者。
- **释放**：退役（轮数满 / 出错 / 空闲超时 / 账号删除或禁用）→ `POST /v1/code/sessions/{id}/archive`
  （200 与 409=已归档都算成功）。账号删除/禁用由网关 sweeper 惰性发现（`CCR_POOL_SWEEP_MS`，默认 60s），
  账户行已删时用池条目里的快照（baseUrl/凭证/路由）归档。复用 push 遇 404（上游会话已不在）→ 归档后自动新建。
- **env**：`CCR_POOL_MAX_TURNS`（50）、`CCR_POOL_IDLE_MS`（1800000）、`CCR_POOL_SWEEP_MS`（60000）。
- **指标**：每次会话获取打 `[ccr-pool] hit/miss/created/archived/warm` 计数日志。
- worker 模式（§8.1）不在本期范围：每请求新进程，天然无残留。

## 6. 能力矩阵（翻译层必须声明的边界）

> **worker 路径对采样参数的处理（2026-10-17 两次修订）**：`temperature`、`top_p`、`top_k` 在 `claude -p` 形态下没有对应开关，
> **被忽略**。同日晚修复（veridrop + 11 用例实测，见 `worker-sessions.md` 进度）：`max_tokens` → 进程 env
> `CLAUDE_CODE_MAX_OUTPUT_TOKENS`（进 reuseKey），上游 `stop_reason: max_tokens` 到达即结束消息并取消会话（不让 Claude Code 自己"续写"）；
> `stop_sequences` 由翻译层匹配截断（流式扣住最长停止串-1 的尾巴）、`stop_reason: stop_sequence`、同样取消会话；
> `tool_choice: any/tool` 不再 400，改为本轮末尾追加一条「调用方要求」文本块（不进会话哈希），模型据此只回一个 tool_use。
> 此前已透传：
> `tools`（原生，节点 MCP）、`thinking`（预算 + 会话设置；Claude 5.5 为自适应思考，实际由 `effort` 触发，思考正文上游不下发、只给签名）、
> `effort`（low/medium/high/xhigh/max → `--effort`）、`document`（base64 PDF 等）。仍为 400：`tool_choice=any/tool`。详见 `worker-sessions.md`。

| Messages API 能力 | 云端会话路径 | 说明 |
|---|---|---|
| 文本问答 | ✅ | 完整 |
| 流式输出 | ✅（事件流→SSE 转写） | 粒度取决于事件推送节奏；带 tools 的请求自 2026-10-16 起也即到即发，仅扣住可能是 ```tool_call 开头的尾巴（gateway.md §10a） |
| 多轮对话 | ⚠️ 折叠 | 客户端历史折叠进单条 user 消息；或映射为同 session 追加事件（复用策略待定） |
| 自定义 function tools | ⚠️ prompt 级模拟（已实现，§5.1） | 云端 worker 使用内建工具集；客户端自定义工具在提示层模拟并合成 tool_use 块；`tool_choice: auto/none` 可用；带 tools 的流式为缓冲回放 |
| 强制 tool_choice（tool/any） | ⚠️ worker 指令模拟 / 云端 ❌ 400 | worker（2026-10-17）：本轮末尾追加 `[Caller requirement]` 文本块要求只回一个工具调用；云端会话仍 400 `ccr_unsupported_tool_choice` |
| thinking 透传 | ❌ | worker 的思考过程不作为 API 块输出；请求里的 thinking 块折叠时丢弃 |
| prompt caching 语义 | ⚠️ 变化 | 无跨请求缓存控制；usage 字段按事件流如实报告。计费基线（`ccr_cache_baseline_worker`，线上 700）按 cache_read → cache_creation → **input** 的顺序扣：Claude Code 前缀低于模型缓存下限（Haiku 2048）时不进缓存、上游记成普通 input，2026-10-17 前这部分被整段算给客户（15 token 提示记 606） |
| max_tokens / stop_sequences | ✅ worker（2026-10-17） | 见上方说明；流式 `message_start.usage` 也补齐 input/cache 字段（此前为 0） |
| temperature / top_p / top_k / assistant 预填 | ❌ 忽略 / 不生效 | Claude Code 无开关；预填后模型会从头重写（客户端拼接会重复） |
| thinking 请求（enabled / adaptive） | ✅ worker（2026-10-17） | `enabled`+budget → `--max-thinking-tokens`；`adaptive`（Claude 5 API）→ `--effort`（客户未给则 high）；thinking 块与 `signature` 原样透传（CC 模式下正文为空、只有可回传的签名） |
| thinking 默认 | ✅ 关闭（2026-10-17） | Claude Code 默认开 thinking（Haiku 4.5 隐藏思考占输出 token 大半且计费）；客户未请求 thinking / effort 时进程以 `MAX_THINKING_TOKENS=0` 关闭，与官方 API 默认一致 |
| 图片 | ✅ worker（2026-10-16）/ ❌ 云端会话 400 | worker：网关把折叠 prompt + 原样 `image` 块组成一条 Messages 风格 user 消息，节点以 `--input-format stream-json` 喂给 `claude -p`（§8.1）；云端会话仍拒 |
| 文件（document） | ❌ 400 `ccr_unsupported_content` | 两种模式都未放开；混合分组里先落到直连账户 |
| 首轮延迟 | 较高 | 建会话 + worker 拉起，秒级到十几秒级 |

## 7. 配额与调度（已实现，并推广到全部 Anthropic 订阅账户）

> 2026-10-15 起本节逻辑按 sub2api 的做法推广到所有 `type=oauth, platform=anthropic` 账户（不限 executor）：网关对每个响应被动采样
> `anthropic-ratelimit-unified-*` 头、429 按被拒窗口 reset 冷却、阈值改为百分比 `anthropic_window_threshold_percent`。现状以
> `docs/gateway.md` §3 / §5.1 为准；下文的 CCR 特有部分仍适用。

- 订阅账号按**滚动时间窗**限配额（窗口水位通过官方 usage 端点巡检：
  `GET /api/oauth/usage`，Bearer；具体周期与余量字段以实测为准）。
- 账户字段（迁移 3，`packages/core`）：`executor`（`direct | ccr`）、`window_used`（**绑定窗口**的已用比例 0..1，NULL = 未巡检）、
  `window_reset_at`、`window_checked_at`、`window_exhausted_until`（窗口级冷却，区别于三个错误冷却）。
- 巡检解析 `parseUsageSnapshot()`（core，**临时**：取响应里各窗口对象 `{utilization, resets_at}` 中 utilization 最大者为绑定窗口，
  百分比归一到 0..1）。`recordWindowUsage()` 回写：`window_used >= 1 - headroom` → `window_exhausted_until = resets_at`
  （无 resets_at 则 +1h）；有余量 → 清窗口冷却。
- 调度 `listCandidates`：SQL 过滤 `window_exhausted_until`，再按 `windowAllows()` 过滤：未巡检放行；快照已过 `window_reset_at` 视为窗口已滚动放行；
  否则要求 `window_used < 1 - headroom`。`headroom` 取 settings `ccr_window_headroom`（默认 0.05）。
  `markFailure({kind:"window_exhausted"})` 供翻译层在识别到窗口耗尽信号时调用（信号形态待附录 A）。
- 巡检器：console `apps/console/src/ccr/window-poll.ts`。**被动优先（2026-10-16 用户要求：巡检别太频繁，贴近真实 Claude Code）**：
  每个上游响应头的被动采样是主数据源（同时刷新 `window_checked_at`）；tick 每 `window_poll_interval_sec`（默认 300）秒跑一次
  令牌保活，但主动 `GET /api/oauth/usage` 只对超过 `window_passive_max_age_sec`（默认 21600 = 6h，最小 600）没有任何采样的账号发一次。
  有流量的账号永远不会被主动探测；100 个账号的主动探测量 ≤ 100 次 / 6h。管理员仍可 `POST /api/admin/accounts/:id/window` 手动巡检；
  `status=active` 重新启用会清窗口冷却与模型族冷却但保留测量值。
- **Fable 专属 7d 窗口**（`7d_oi` 头 / usage 体 `seven_day_fable`、`seven_day_overage_included`）单独采样进 `accounts.model_cooldowns.fable`
  （used / resetAt / until / reason），不进账号级绑定窗口：达阈值或 429 只让 Fable 请求跳过该账号（docs/gateway.md §3、§5）。
  `seven_day_sonnet` / `seven_day_opus` 不参与调度（sub2api 同样只按 5h / 7d / 7d_oi 暂停）。
- **参数来源核对（2026-10-16）**：头名 `anthropic-ratelimit-unified-{5h,7d,7d_oi}-{utilization,reset,status,surpassed-threshold}` 与聚合
  `anthropic-ratelimit-unified-reset`、utilization 头为 0..1 小数、usage 体为 0..100 百分比、reset 为秒级 Unix 时间戳（自动识别毫秒）、
  5h reset 合理区间 ≤ 6h / 7d ≤ 8d、exhausted = status rejected 或 utilization ≥ 1 —— 全部与 sub2api `ratelimit_service.go`
  / `account_usage_service.go` 一致。**自动恢复**完全按时间：`listCandidates` 比较 `rate_limited_until` / `window_exhausted_until` /
  `model_cooldowns.*.until` 与 now（sub2api `IsSchedulable` 同），快照过了 `window_reset_at` 也直接放行；下一次被动采样或兜底探测回写后
  `window_exhausted_until` 清空。无 reset 时的 1h 兜底是本项目自加。

### 7.1 双账本计费口径（2026-10-16 拍板，同日修订：缓存按基线扣除后计费）

CCR 路径（云端会话与 worker）每单携带官方客户端身份上下文开销（实测：一句两 token 的问答，worker 上游计量
cache_read 16608–16777，云端约 28K，几乎全是 Claude Code 系统提示词与工具集）。因此拆两本账：

- **客户账（对外结算）**：`input_tokens`（上游口径，不含缓存，即客户内容的真实增量）+ `output_tokens`
  + **客户自己的缓存用量**：`cache_read = max(0, 上游 cache_read − 基线)`，基线扣不完的部分再从 `cache_creation` 扣，
  两者最低 0。基线 = 该执行模式的身份上下文 token 数，settings `ccr_cache_baseline_worker`（2026-10-17 起 **700**：worker 改用
  `--system-prompt-file` 替换 Claude Code 默认系统提示词后固定前缀只剩约 710 token；此前 16600）/
  `ccr_cache_baseline_cloud`（默认 28000），控制台「设置」可调，填 0 = 上游缓存全额计给客户。
  **缓存写入按输入价（2026-10-17 用户拍板）**：settings `ccr_cache_write_as_input`（默认 1）—— CCR 路径的 cache_control 是 Claude Code
  自动打的、客户并未要求，所以超出基线的 `cache_creation` 并入 `input_tokens` 按 1.0× 计，不收 1.25× 写入溢价；`cache_read` 仍按
  0.1× 读价让利客户。填 0 = 原样透传上游口径。**配套的翻译层改造**：worker 的历史不再折叠成单个文本块，而是**每轮一个内容块**
  （`messagesToBlocks`，超过 64 轮按固定边界分块），前缀块逐字节一致，同一对话粘在同一账号（sticky key 改为"系统提示 + 首条 user
  消息"而非整段历史）时后续轮次才能命中上游缓存——此前每轮全量 cache_creation、几乎零命中（3 小时 opus：1.19 亿写 / 29 万读）。
  翻译层 `usageOut()` 输出即客户可见 usage（JSON 与 `message_delta` 同一组数字），结算管道不变（× 模型标准价 × 分组倍率），
  客户可见 token 与扣费同源一致。**此前（同日上午）客户可见缓存恒为 0，客户内容被缓存命中时少计费，已修正。**
- **平台账（对内）**：`result.modelUsage`（含 costUSD、cache 全量）为账号经济流水口径，翻译层保留 `translator.upstreamUsage`，
  执行器完成时打一行网关日志摘要；本期不落新库字段。
- `usage_logs.usage_estimated` 自此只表示"上游一个 usage 都没报，token 按 chars/4 估算"；CCR 行不再强制置 1。
- 直连模式（含 CC 直通）不受影响：请求上下文是客户自己发的，按上游 usage 全额结算（现状不变）。
- 基线校准：Claude Code 升级后系统提示词长度会变，用一条两 token 的问答看 `[ccr-worker] … upstream modelUsage` 里的
  `cacheReadInputTokens`，取最小值回填 settings。基线偏大 → 客户缓存少计；偏小 → 客户为身份上下文买单。

## 8. 组件落位

| 组件 | 位置 | 职责 |
|---|---|---|
| 授权接入 | console（管理端 / 号商 / 上号员发起，经节点代理直连 OAuth） | authorize、换码、validate、令牌入库 |
| 令牌保活 / 窗口巡检 | console 定时器（窗口巡检已实现：`ccr/window-poll.ts`） | 到期前刷新、轮换回写、validate 巡检、usage 水位回写 |
| 会话驱动器 | **apps/gateway `ccr/executor.ts` + `ccr/client.ts`**（首期与翻译层同进程） | session 生命周期、events 推拉、超时与重试。原计划放 console；实现时并入网关：凭证刷新、故障转移、结算都在网关进程内，拆开要多一跳内部 HTTP 而没有收益。需要号商代理出口时改走 `fetchViaTunnel`（同直连路径），放哪一侧不影响 |
| 翻译层 | apps/gateway `ccr/translate.ts` | Messages ↔ events 双向翻译、SSE 化、usage 提取（§5.1） |
| 账号操作出口 | provider-node（可选增强） | 账号绑定代理出口，保证账号操作 IP 一致性 |

首期简化：会话驱动器放 console 中心运行（QPS 低）；当账号操作需要严格出口一致性时，
再经 provider-node 的代理池执行（复用 http_egress 通道，协议无需变更）。

### 8.1 worker 模式（bridge：节点跑真 Claude Code，2026-10-15 晚立项）

云端模式（anthropic_cloud）之外的第二种 CCR 执行形态：provider-node 上以真实 Claude Code
二进制执行请求，会话账本锚定为 `environment_kind=bridge`（Remote Control 本地桥型）。

- **凭证下发**：平台经 WS 加密推送账号 OAuth 令牌 → 节点物化为 per-账号 `CLAUDE_CONFIG_DIR`
  下的 `.credentials.json`（`claudeAiOauth: {accessToken, refreshToken, expiresAt, scopes, subscriptionType}`，
  客户端原生格式，bundle 已核实）。
- **出口**：CC 原生认 `HTTPS_PROXY`/`https_proxy`（EnvHttpProxyAgent，bundle 已核实）；
  钉死代理为 socks5 时经节点既有 socks5 桥转本地 http 代理注入。
- **执行**：每请求拉起 `claude -p --output-format stream-json --model <模型>`（新会话），
  stream-json 增量直接转写 Messages SSE（比云端轮询保真度高一档，工具输入可达 input_json_delta 粒度）。
  请求结束即退出，无常驻进程。
- **伴生遥测为真**：真二进制的 statsig / 特性评估 / usage 轮询自然发生——直连路径的
  "有推理流量、零遥测流量"理论差异在此模式下不存在。
- **资源护栏**：实测峰值 ~262MB/进程；节点按内存设 `cc_worker_max_concurrency`（默认
  floor((可用内存MB-512)/320)），超限排队。install.sh 加装 claude 二进制（npm 包或官方 tar）。
- **图片输入（2026-10-16）**：请求含 `image` 块时，网关 `messagesToContent()` 生成 `[{text: 折叠 prompt}, ...image 块]`，经隧道 open 信封
  `content` 字段下发（console `bodyLimit` 提到 32 MiB，与网关一致）；节点检测到 `content` 即加 `--input-format stream-json`，stdin 写一行
  `{"type":"user","message":{"role":"user","content":[…]}}`。无图片时仍是纯文本 prompt，老节点忽略 `content` 会丢图，所以节点 bundle 须同步更新。
  `ccrUnsupportedReason(body, {images: executor === "ccr_worker"})` 只对 worker 账号放行图片；`document` 仍拒。
- **worker 隔离（2026-10-16，事故驱动）**：此前 worker 以 root、cwd=`/`、HOME=`/root`、工具无限制运行，客户终端用户让 Claude"建文件/跑命令"就真的
  写进了节点的 `/root`（并能读节点配置），不同客户会话还共享同一目录。现在：每个会话一个私有 scratch 目录
  `<workerRoot>/cc-sessions/<sessionId>`（0700，作为 cwd、HOME、TMPDIR，会话结束即删除，节点启动时清扫残留）；以非特权用户 `ccworker` 运行
  （env `CC_WORKER_USER`，节点为 root 且用户存在时生效；凭据目录按会话 chown 给该用户）。**workerRoot**：降权时默认
  `/var/lib/1dayapi-cc-worker`（env `CC_WORKER_ROOT` 可改），因为节点自己的数据目录在 `/root/.config/...` 下、`/root` 为 0700，
  `ccworker` 根本进不去 —— 首次上线即因此 `EACCES mkdir` 全线 502，改到 `/var/lib` 后恢复；不降权时仍用 `<dataDir>`。
  该根目录及 `cc-accounts/`、`cc-sessions/` 为 0711（只许穿越不许列目录），账号凭据目录 0700 归 `ccworker`。
  **启动自检**：节点启动时在 `cc-sessions/selftest` 下以同样的 uid/gid、cwd/HOME/CLAUDE_CONFIG_DIR 跑一次 `claude --version`；
  失败则 `selfTestError` 非空、`enabled=false`，所有 cc_worker 会话以 `self_test_failed: <原因>` 拒绝并大字记日志，hello 的
  `ccWorker.selfTestError` 同步到控制台 `deploy_meta`；install.sh 的 `verify_worker_isolation` 做同一检查。目的：配置错误在
  部署当场暴露，而不是 2026-10-16 那样由客户 502 发现；`claude -p --tools "" --no-session-persistence`
  —— 默认**没有任何内建工具**、不落对话记录（env `CC_WORKER_TOOLS` 可白名单放行）；传给子进程的环境变量剔除 SECRET/TOKEN/KEY/PASS 类。
  安装脚本 `setup_worker_user` 负责建用户并把 claude 二进制暴露到 `/opt/claude/claude`（`/root/.bun` 下的二进制非特权用户不可执行）。
- **持久会话（2026-10-17，阶段 1 已上线）**：同一对话（sticky key）复用节点上的常驻 `claude` 进程，续写轮只喂新一轮；
  回收/容量、增量计费、分期计划见 `worker-sessions.md`。设置 `ccr_worker_persistent`。
- **边界**：与云端模式相同——客户自定义工具仍是 prompt 级模拟（真 worker 现在默认无工具，更不是客户机器的）；
  原生工具 / thinking / document 透传是 `worker-sessions.md` 阶段 2～4。
  **客户的 CC 直通请求不走 worker 模式**（§5.2 R1 直连模式承担）。
- 调度维度：`executor` 新增取值 `ccr_worker`；节点选择 + 容量由既有节点管理体系承担。

#### 已实现要点（2026-10-16）

- 隧道 `kind="cc_worker"` 三件套平行于 http_egress：网关 `tunnel.ts` `openCcWorker()` → console
  `/internal/tunnel/open`（校验账户 `executor='ccr_worker'`）→ WS `cc_worker.open`（参数全在信封，无 spec 行）→
  节点 `CcWorkerManager`（apps/provider-node `cc-worker.ts`）spawn `claude -p --output-format stream-json --verbose`，
  stdout 行作为 `cc_worker.data` 帧回流；close/error 帧语义同 http_egress（`worker_failed/worker_timeout(600s)/
  worker_spawn_failed`；open 拒绝码含 `no_proxy_available/worker_overloaded/claude_not_installed/self_test_failed: …`）。
- 网关 `ccr/worker.ts`：`messagesToPrompt` 折叠（tools 围栏约定同云端）→ 隧道 → 按行喂共享 `SessionTranslator`
  → Messages SSE/JSON；返回 null = 基础设施跳过换账户（同 `fetchViaTunnel` 语义）。
- 分派：`executor=ccr_worker` 非 CC 客户端走 worker；CC 客户端按 §5.2 R1 走直连（`modeFor` 的 `ccClient`
  分支对 ccr/ccr_worker 一体生效）；`executor=ccr` 云端模式不变。
- 钉代理：信封 `proxyId`（= `accounts.bound_proxy_id`）→ `ProxyPool.getPinned`，socks5 经本地桥注入
  `HTTPS_PROXY` 系列变量；缺/死硬拒。
- 并发护栏：默认 floor((可用内存MB-512)/320) 下限 1（env `CC_WORKER_MAX_CONCURRENCY` 覆盖），FIFO 队列 >30
  拒 `worker_overloaded`。
- 遥测：心跳 `ccWorker:{enabled, claudeVersion, maxConcurrency, active, queued}` → 平台落 `nodes.deploy_meta.ccWorker`；
  hello capabilities 含 `cc_worker`。install.sh 加装 `@anthropic-ai/claude-code@2.1.300`（npm 优先 bun 兜底，失败仅告警）。
- 测试：provider-node `test/cc-worker.test.mjs`（fixture 假 claude：spawn/凭证物化 0700+0600/钉代理硬拒/并发排队/
  超时杀/非零退出）；gateway `test/ccr-worker.test.mjs`（行分割 + SessionTranslator 翻译）+ `dual-mode.test.mjs`
  （ccr_worker 双模矩阵）；e2e `tests/e2e/worker.test.mjs`（fake-node + fake-claude 全链路：JSON/流式/chat/tools、
  计费落库、CC UA 直连对照、deploy_meta 透出、节点下线 503）。

- **文件引用关闭**（2026-10-19）：客户文本是数据不是操作者输入，Claude Code 却会把其中的 `@路径` 读成附件（文件内容 / 目录列表），既把会话撑爆
  1M 窗口（"Prompt is too long … the rest is system prompt, tool definitions, and attachment content"），也让客户能读到节点上 ccworker 可读的文件
  （探测 `@/etc/hostname` 原样返回主机名）。worker 进程 env 加 `CLAUDE_CODE_DISABLE_FILE_MENTIONS=1`（二进制里的正式开关；同族还有
  `CLAUDE_CODE_DISABLE_ATTACHMENTS`、`CLAUDE_CODE_EVAL_CONFINED`），bundle d7db36dd 起生效。副作用：Claude Code 会附一句
  "file contents are not attached automatically" 的 system reminder，个别回答会复述它。

## 9. 里程碑

1. M1 令牌生命周期：授权接入（浏览器辅助）+ 刷新调度 + 巡检 → 账号可长期在线 —— **管线已验证**（2026-10-15 晚：服务器浏览器授权一次通过、token 19min 存活 + refresh 轮换成功）；平台化（上号 API + bot 服务化）进行中，见 `onboarding.md`
2. M2 全链路 PoC：建环境 → 建会话 → events 问答 → 事件流落档 —— **已完成**（附录 A）
3. M3 翻译层 + 网关接入 `type=oauth, executor=ccr` 账户参与调度 —— **骨架已落地**（对 mock 会话 API 全链路通过；按附录 A 校正 mock/e2e 进行中）
4. M4 配额窗口调度 + 管理台账号水位视图 —— **已落地**
5. M5 账号操作经 provider-node 钉死代理出口执行（http_egress spec 加 proxyId）—— 进行中（与上号平台同批）
6. M6 双模路由（§5.2：CC 客户端直连模式 / 普通客户端云端模式）—— **已落地**（2026-10-16，含 ccr_worker 一体生效）
7. M7 worker 模式（§8.1：节点真 CC 二进制，executor=ccr_worker）—— **骨架已落地**（2026-10-16，见 §8.1「已实现要点」；对 fake claude 全链路通过，真实 claude 联调待服务器环境）。
   定位说明：指纹直连路径（v2）仅用于官方 API Key / 第三方中转账号及观察期实验；
   订阅账号生产流量以 worker 模式为主、云端模式为辅。依据：2026-10-15 实测——脚本化 mint 三次分钟级失效、
   浏览器授权 token 存活 + 直连三连 200；用户侧一手证据：低保真转发（sub2api 类）订阅号秒级失效。

## 附录 A：事件流与端点 schema（2026-10-15 首抓完成）

> 首抓环境：服务器真实浏览器授权（xvfb + headed Chromium + 账号代理出口，一次通过、无验证码）
> → 换 token → validate → usage → 环境 → 会话 → events 推拉，全程 200。
> 原始抓包在 `recon/lab` 产出目录（本地留存）。

### A.0 假设核对结论（对照骨架代码）

| # | 假设 | 实测结论 |
|---|---|---|
| A1 | 读回数组键 | ✅ 确认为 `{"data": [事件…]}`；元素含 `event_id / event_type / sequence_num / source(client\|worker) / created_at / received_at / processing_at / processed_at / payload`。事件少时未见分页字段 |
| A2 | 出站事件类型 | ⚠️ 实测一轮问答出现：`env_manager_log`（沙箱生命周期）、`control_request`/`control_response`、`user`、`system`（×5）、`active_goal`、`autocompact_state`、`assistant`、`rate_limit_event`、`result`。未出现 `stream_event`（本次为非流式推送；SSE 变体待验） |
| A3 | usage 字段 | ⚠️ 两处：`assistant` 事件 `payload.message.usage` 是 Messages API 形状（input_tokens/output_tokens/cache_creation_input_tokens/cache_read_input_tokens，**蛇形**）；`result` 事件的用量在 `payload.modelUsage.{模型ID}` 下（**驼峰**：inputTokens/outputTokens/cacheCreationInputTokens/cacheReadInputTokens/thinkingTokens，另含 **costUSD**、costBasis、contextWindow、maxOutputTokens）。结算建议用后者（含 costUSD） |
| A4 | 结束/错误信号 | ✅ `result` 事件：`subtype: "success"`、`terminal_reason: "completed"`、`is_error: false`、`stop_reason: "end_turn"`、`num_turns`、`result`（纯文本结果）、`duration_ms` / `duration_api_ms` |
| A5 | 窗口耗尽表现 | 待观察（本次账号配额充足）。注意正常事件中已有 `rate_limit_info.overageStatus: "rejected"` 与 `unifiedWindows`，窗口耗尽时 `status` 预计从 `allowed` 变化 |
| A6 | ~~usage 探测响应的窗口键名与字段~~ ✅ 已由 sub2api 源码证实（`ClaudeUsageResponse`：`five_hour` / `seven_day` / `seven_day_sonnet` / `seven_day_overage_included`，`utilization` 为百分比，`resets_at`） | `packages/core/src/window.ts` `parseUsageSnapshot()` |
| A7 | 会话成本 | 每请求建会话：建会话 POST 本身很轻，但 worker 冷启动（provision→start_cc）约 2s，端到端首轮 `duration_ms` 3.9s（其中模型推理 `duration_api_ms` 1.6s），建会话到可推理总计约 6–10s。会话创建后 `connection_status` 会转 connected |

### A.1 巡检与配额端点（实测响应）

- `POST /api/oauth/validate` → `{"valid":true,"account_uuid":"…","organization_uuid":"…","scopes":[…]}`
- `GET /api/oauth/usage` → 见 A6。`rate_limit_event` 事件每次请求还实时携带
  `rate_limit_info.unifiedWindows.{five_hour,seven_day}.{resetsAt(秒级时间戳),utilization}`，
  可作为调度的新鲜数据源（比巡检更及时）。
- 环境列表 `GET /v1/environment_providers` → `{"environments": […], "has_more": false}`。
  **环境是组织级资源，令牌失效后仍存活**（实测：此前已失效令牌创建的环境仍 active）。

### A.2 会话与推送（实测响应形状）

- 建会话：`{"deduplicated": false, "session": {"id": "cse_01…", "environment_kind": "anthropic_cloud",
  "connection_status": "disconnected", "config": {"model": "…", "sources": [], "outcomes": []}, …}}`
- 推 events：`{"attestation_feedback": null, "results": [{"duplicate": false, "event_id": "…", "sequence_num": "2"}, …]}`

### A.3 授权管线实测补充（D8 终判）

- 服务器端真实浏览器一次通过、**未触发验证码**；此前两次失败中验证码组件的 Skip 是
  "换一题"而非跳过（死路）；若未来触发验证码，当前对策是外部辅助（人工/打码）点选。
- **令牌存活复检（mint+19min）：validate 200（valid:true）+ refresh 200（轮换成功，新令牌 8h）**；
  账号侧浏览器会话未被登出。对照：三次脚本化申请均 4–8 分钟内令牌撤销 + refresh 连坐 + 会话强踢。
  D8 终判成立：真实浏览器同意的令牌可长期保活运营。
- 工程教训：长任务必须 setsid 脱离 SSH 会话执行（链路抖动会杀前台管道）。
