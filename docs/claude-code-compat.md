# Claude Code 客户端请求兼容性规范（锚定 CC 2.1.300）

> 目标：直连路径下，网关转发到 Anthropic 上游的请求与官方 Claude Code 客户端发出的请求**逐字段一致**，
> 保障上游账号可用性与行为一致性。
> 本文档是 `packages/core/src/fingerprint.ts`（及 provider-node vendored 副本）的权威依据。改动实现时必须同步本文档。
> 分析材料在 `recon/claude-code/`（本地留存，不共享）。

## 1. 分析方法与证据

| 方法 | 证据文件（本地 recon/） |
|---|---|
| 官方客户端（Bun 编译单文件）内嵌源码静态阅读 | `recon/claude-code/bundle.js`（46MB 源码切片） |
| 本地请求采样：`ANTHROPIC_BASE_URL` 指向本地采样服务，运行 `claude -p` | `recon/claude-code/captures.ndjson`、`capture-*.json` |
| 采样程序 | `recon/claude-code/capture-upstream.mjs` |

版本锚点：Claude Code **2.1.312**（2026-10-28 升级，§11），内嵌 `@anthropic-ai/sdk` **0.128.0**，运行时标识 Node **v26.12.1**（Bun 1.4.4）。
首版锚点 2.1.300（BUILD_TIME 2026-10-14，GIT_SHA c6733ae1，运行时 v26.3.0）采样于 2026-10-15；§3–§6 的数值已按 2.1.312 更新，差异见 §11。

## 2. 端点

```
POST /v1/messages?beta=true     HTTP/1.1
```

注意 `?beta=true` 查询参数恒定存在，即使不带任何 beta 也要保留。

## 3. 请求头（实测采样，按线上出现顺序）

| Header | 值 | 说明 |
|---|---|---|
| `Accept` | `application/json` | 即使 `stream:true` 也是 json，不是 text/event-stream |
| `Content-Type` | `application/json` | |
| `User-Agent` | `claude-cli/2.1.312 (external, sdk-cli)` | 格式 `claude-cli/{VERSION} (external, {entrypoint}{, agent-sdk/…}{, client-app/…}{, workload/…})`。`-p` 打印模式 entrypoint 为 `sdk-cli`；交互式为 `cli` |
| `X-Claude-Code-Session-Id` | UUID v4 | 每会话一个 |
| `X-Stainless-Arch` | `x64` | SDK 遥测头组 |
| `X-Stainless-Lang` | `js` | |
| `X-Stainless-OS` | `Linux` | |
| `X-Stainless-Package-Version` | `0.128.0` | |
| `X-Stainless-Retry-Count` | `0` | 重试时递增 |
| `X-Stainless-Runtime` | `node` | |
| `X-Stainless-Runtime-Version` | `v26.3.0` | |
| `X-Stainless-Timeout` | `600` | |
| `anthropic-beta` | 见 §4，逗号连接、无空格 | 按模型/功能动态裁剪 |
| `anthropic-dangerous-direct-browser-access` | `true` | 恒定 |
| `anthropic-version` | `2023-06-01` | 恒定 |
| `x-api-key` / `authorization` | 凭证 | 网关替换为真实上游凭证 |
| `x-app` | `cli` | 恒定 |
| `Connection` | `keep-alive` | |
| `Accept-Encoding` | `gzip, deflate, br, zstd` | Bun fetch 默认值（见 §7 差异） |

**形态判定**：UA 像 CC 不等于是 CC。网关用本文 §3 / §5 的结构性特征做硬检查（`x-app`、`claude-code-20250219` beta、计费头块及其版本与 UA 一致、
`metadata.user_id` 结构），不通过的请求按 settings `cc_shape_policy` 处理，见 docs/gateway.md §2a。头部缺失**不再**仅靠下面的 canonical 注入"洗白"：注入只服务非 CC 客户端。

**网关策略**：客户端发来的上述头**透传**（仅替换凭证）；两个例外——`User-Agent` 仅在形如
`claude-cli/*` / `claude-code/*` 时透传（其他 UA 透传反而更突兀），`Accept` 仅在含
`application/json` 时透传；客户端没发（非 CC 客户端走 anthropic 协议）时注入 §6 的 canonical 集合。
传输层用原生 `http.request`（`apps/gateway/src/rawhttp.ts`），因为 undici fetch 会强加
`accept-language: *` 和 `sec-fetch-mode: cors`，CC 不发这两个头。

## 4. anthropic-beta 取值

Beta 集合随模型与启用功能变化。两次实测：

- **claude-sonnet-4-5-20250929**（max_tokens 32000, thinking enabled/budget 31999, 24 工具）：
  `claude-code-20250219,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05`
- **claude-opus-5-5**（默认模型，max_tokens 128000, thinking adaptive, 20 工具）追加：
  `per-turn-control-2026-07-01,mid-conversation-tool-changes-2026-07-01,effort-2025-11-24,dangerous-tool-use-2026-09-03,afk-mode-2026-01-31`

完整 beta 注册表（客户端内定义，49 项）：

```
claude-code-20250219  oauth(动态)  interleaved-thinking-2025-05-14
context-1m-2025-08-07  context-management-2025-06-27  structured-outputs-2025-12-15
web-search-2025-03-05  advanced-tool-use-2025-11-20  tool-search-tool-2025-10-19
effort-2025-11-24  task-budgets-2026-03-13  prompt-caching-scope-2026-01-05
prompt-caching-evict-2026-05-12  cache-keepalive-2026-09-03  extended-cache-ttl-2025-04-11
fast-mode-2026-02-01  redact-thinking-2026-02-12  thinking-resumption-2026-07-17
thinking-token-count-2026-05-13  advisor-tool-2026-03-01  afk-mode-2026-01-31
auto-mode-classifier-2026-07-16  cache-diagnosis-2026-04-07  ccr-byoc-2025-07-29
context-hint-2026-04-09  dangerous-tool-use-2026-09-03  environments-2025-11-01
fallback-credit-2026-06-01  files-api-2025-04-14  inline-tools-2026-09-15
mcp-servers-2025-12-04  message-threads-2026-08-12  mid-conversation-tool-changes-2026-07-01
mid-conversation-system-clear-at-2026-08-21  per-turn-control-2026-07-01  timing-2026-09-09
server-side-fallback-2026-06-01  server-side-fallback-2026-07-01  thinking-binding-controls-2026-08-01
thinking-display-updates-2026-08-18
```

## 5. Body 结构（passthrough-anthropic 时必须原样转发）

顶层键顺序：`model, messages, system, tools, metadata, max_tokens, thinking, context_management, stream`。

- **system**：数组，第一块是**计费头**（无 cache_control）：
  `x-anthropic-billing-header: cc_version=2.1.300.f23; cc_entrypoint=sdk-cli;`
  第二块为身份句（`You are a Claude agent, built on Anthropic's Claude Agent SDK.` 或交互式的
  `You are Claude Code, Anthropic's official CLI for Claude.`），`cache_control: {type: ephemeral}`；
  第三块为 ~27KB 主提示词，同样 ephemeral。
  **实测（2026-10-16，经网关、OAuth 订阅号、CC UA）**：body 缺这个计费头块时 Anthropic 直接回 **429**（并非额度问题，
  同一账号带上它即 200；只带 `metadata` 或普通字符串 `system` 仍是 429）。所以带 CC UA 的探针/测试必须带计费头块，
  否则不仅失败，还会把账号打入网关的 429 冷却。
- **metadata.user_id**：注意是 **JSON 字符串**而非旧版拼接格式：
  `{"device_id":"<sha256>","account_uuid":"","session_id":"<uuid>"}`
- **tools**：按名称字母序（sonnet 采样 24 个：Agent, Bash, CronCreate, CronDelete, CronList, Edit,
  EnterWorktree, ExitWorktree, ListAgents, NotebookEdit, Read, ReportFindings, ScheduleWakeup,
  SendMessage, Skill, TaskCreate, TaskGet, TaskList, TaskStop, TaskUpdate, WebFetch, WebSearch,
  Workflow, Write）。无 cache_control、无 strict 字段。
- **messages**：user 内容多块，最后一块带 `cache_control: {type: ephemeral}`。
- **context_management**：`{"edits":[{"type":"clear_thinking_20251015","keep":"all"}]}`。
- **thinking**：sonnet `{"budget_tokens":31999,"type":"enabled","display":"omitted"}`（= max_tokens-1）；
  opus-5-5 `{"type":"adaptive","display":"omitted"}`。
  **网关归一化（2026-10-19，`apps/gateway/src/upstream.ts` `normalizeThinking`）**：passthrough-anthropic / chat-via-anthropic 出口按上游模型调整
  `thinking`，其余字段仍原样转发。规则（Anthropic 2026-10 行为）：5.x 全系及 Opus 4.7/4.8 拒绝 `budget_tokens` → `enabled` 改 `{type:"adaptive"}`；
  Fable/Mythos 5.x 与 Opus 5.5 拒绝 `disabled` → 删掉 `thinking`（模型默认 adaptive）；Sonnet 5.5 的关闭形态是 `{type:"between_tools"}`
  （effort xhigh/max 时删掉）；Opus 5 / Sonnet 5 / Haiku 5.5 只在 effort xhigh/max 时拒绝 `disabled` → 该情况删掉；4.6 及更早不动。
  起因：Claude Code 2.1.220 对 claude-fable-5 发 `{type:"disabled"}`，上游 400 "thinking.type.disabled is not supported"。worker 路径一直由
  `planThinking` 映射，不受影响。
- `stream: true` 恒定；无 temperature/top_p/top_k/service_tier/tool_choice。

**模型 ID**：CC 会发别名（`claude-opus-5-5`）也会发带日期的快照 ID（`claude-sonnet-4-5-20250929`）。
网关侧 `packages/catalog`/`packages/core/models.ts` 对 `-YYYYMMDD` 后缀做别名回退
（路由与计费按别名，转发上游保留原始 ID），避免快照 ID 404 或计费归零。
**点号写法**（2026-10-19）：`claude-opus-5.5`、`claude-haiku-4.5` 这类把版本写成点号的 ID 也能解析（`dottedVersionAlias`，仅 `claude-` 前缀，
`gpt-5.5-mini` 之类不受影响）：日志与计费保留客户写法，发往上游时改为规范的横线 ID（`ModelEntry.upstreamModelId`），计费按规范模型单价。

## 6. Canonical 注入集（客户端非 CC 时网关补齐）

```
User-Agent: claude-cli/2.1.312 (external, cli)
X-Stainless-Arch: x64            (按宿主)
X-Stainless-Lang: js
X-Stainless-OS: Linux            (按宿主: Linux|Darwin|Windows_NT→Windows)
X-Stainless-Package-Version: 0.128.0
X-Stainless-Retry-Count: 0
X-Stainless-Runtime: node
X-Stainless-Runtime-Version: v26.12.1
X-Stainless-Timeout: 600
anthropic-beta: claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,thinking-token-count-2026-05-13
anthropic-dangerous-direct-browser-access: true
anthropic-version: 2023-06-01
x-app: cli
Accept: application/json
```

`oauth-2025-04-20` 只在 OAuth 账户上出现，位置在 `claude-code-20250219` 之后（真实客户端的顺序，`ccCanonicalBetas()`）；API key 账户没有这一项。客户端自带 beta 时原样透传，OAuth 账户缺它则追加。

## 7. 已知差异（未对齐项）

1. **TLS 客户端特征**：CC 是 Bun/BoringSSL；Node/undici(OpenSSL) 的 ClientHello 不同。
   协议 v2 已把出口移到 provider-node 的 Bun fetch（同族 BoringSSL），直连路径仍有差异。
2. **Accept-Encoding**：CC 发 `gzip, deflate, br, zstd`。节点出口（route=node，所有订阅账号）自 2026-10-16 起发**完全相同**的值：节点对
   `/v1/*` 不再解压（Bun `decompress: false`），把压缩体和 `content-encoding` 原样经隧道交给网关，由网关用 Node zlib 流式解码
   （gzip / deflate / br / zstd，Node ≥ 22.15）。动机：Bun 的 fetch 解 brotli 流会把已到数据扣到下一块压缩数据到达（oven-sh/bun#41439），
   导致直连 SSE 整段攒到最后才出。网关自己直连（非 node 账号，undici）仍发 `gzip, deflate, br`。
3. **X-Claude-Code-Session-Id**：客户端发则透传；注入模式下不合成（合成固定值反而异常）。
4. **HTTP 头顺序**：undici 与 Bun 的头块顺序不同，不做对齐（无证据表明上游校验顺序）。
5. 后台小模型调用（话题摘要等）、`count_tokens`、遥测流量由客户端直连，与网关无关。
6. **`# Environment` 块**（2026-10-29 实测 2.1.312）：worker 路径每个请求的 `messages[1]`（role=system）带节点内核版本（`os.release()`）与会话工作目录（`/var/lib/1dayapi-cc-worker/...` 前缀），同节点所有账号同值。无环境变量开关（`CLAUDE_CODE_DISABLE_ATTACHMENTS` 只管附件；`CLAUDE_CODE_SIMPLE`/`--bare` 会丢 OAuth 凭证）。可做的：工作目录改成类似开发者的路径布局、`SHELL=/bin/bash`（已做）；内核串只能接受。

## 8. 辅助端点（非 /v1/messages）指纹

CC 对非 SDK 线端点的调用**不走**不锈钢头集，而是 axios 辅助函数（bundle 实证）：

| 调用 | 真实 CC 形态 |
|---|---|
| `GET /api/oauth/usage`（窗口巡检） | 仅 `Authorization: Bearer` + `User-Agent: claude-code/2.1.300`（`ps()`，无 entrypoint 后缀）+ axios 默认 `Accept: application/json, text/plain, */*`；**不发** x-stainless-* / anthropic-beta / anthropic-version |
| `POST platform.claude.com/v1/oauth/token`（刷新） | **2026-10-29 16:34Z 本地 MITM 实抓（2.1.312，把本地凭证 expiresAt 改成过去时强制刷新）**：头只有 `accept: application/json, text/plain, */*`、`content-type: application/json`、**`user-agent: axios/1.15.2`**、`accept-encoding: gzip, compress, deflate, br`，没有 authorization / anthropic-version / x-app；body 与平台一致：`{grant_type:"refresh_token", refresh_token, client_id, scope:"user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload user:plugins"}`。时机是**懒刷新**：启动发现令牌过期才刷，失败后 3 秒内重试共 4 次（每次后 GET `/api/oauth/profile` 验旧令牌），仍失败就拿旧令牌继续；没有任何后台保活。**本行此前写的 `claude-code/<ver>` UA 是错的**（那是 `/api/oauth/profile` 等 api.anthropic.com 辅助调用的 UA）：平台 2026-10-29 照错行加上后，令牌端点对每次刷新回 429、8 小时 0 次成功，去掉即恢复。平台自 2026-10-29 晚起按此形态发送（gateway.md §8） |

配套实现约束：

- console 巡检 `probeHeaders` 与刷新 `refreshOAuthCredential` 按上表发送（`CC_AUX_UA` / `CC_AUX_ACCEPT` / `refreshScopes` 常量）。
- provider-node 出口的不锈钢指纹补齐**只作用于 `/v1/*` 路径（`/v1/oauth/*` 除外，2026-10-29）**；`/api/oauth/*` 与 `/v1/oauth/*` 保持调用方原样（调用方自带 `CC_AUX_UA`），否则辅助调用会被"过度装扮"成异常指纹。节点上没有 UA 的请求会带 Bun 默认 `Bun/x`：代理健康探测因此显式带 `CC_AUX_UA`；**刷新例外**——带该 UA 的刷新被令牌端点一律 429（2026-10-29 实测），刷新不发 UA。
- 节点 CC 进程**保留遥测**（2026-10-29 本地 MITM 实测 2.1.312 共 8 个会话）：正常会话会调 `/api/claude_cli/bootstrap`、`/api/eval/*`、`/mcp-registry/v0/servers` 并上报一批 `/api/event_logging/v2/batch`（≈120 事件、≈230 KB），载荷含固定 device_id、session_id 与机器 `env` 块（内核、发行版、架构、内存），不含主机名/用户名/路径；关掉后这些调用整体消失，比保留更显眼。只关 `DISABLE_ERROR_REPORTING`（Sentry 在正常与 API 500 会话中都未触发，崩溃报告会带主机名）与 `DISABLE_AUTOUPDATER`（-p 会话未见升级检查）。另设 `SHELL=/bin/bash`。
- **`# Environment` 系统块（2.1.312）**：`messages[1]` 以 `role=system` 携带「Primary working directory / Is a git repository / Platform / Shell / OS Version(内核)」，`CLAUDE_CODE_DISABLE_ATTACHMENTS` 不再覆盖它。节点上所有账号共享同一内核串与 worker 根路径前缀——已知未对齐项，见 §7。
- OAuth 订阅号的 `/v1/messages` 测试/探测必须带 §5 的计费头 system 块 + 身份句 + `metadata.user_id`（JSON 字符串），否则上游 429（2026-10-16 实测）：console 账号「测试」与 `/root/monitor/func.py` 的 `cc_dual_mode` 均已按此改造。

## 9. 版本升级 SOP

CC 发版频繁（周级）。升级常量时：

1. `npm view @anthropic-ai/claude-code version` 对比本文档版本。
2. 新版安装到临时目录，重新静态阅读内嵌源码并重跑 §1 采样（capture-upstream.mjs 可复用）。
3. 更新：UA 版本号、`X-Stainless-Package-Version`、beta canonical 列表、`cc_version` 计费头格式、
   模型 ID 表；同步改 `packages/core/src/fingerprint.ts` 常量与本文档。
4. 本地对照测试：网关指到采样服务，比对上游侧收到的请求与直接采样的 CC 请求逐字段 diff。
5. **平台自发起流量同样在比对范围内**（2026-10-16 教训：透传路径一致 ≠ CC 身份一致）：
   窗口巡检（`/api/oauth/usage`）、令牌刷新（`/v1/oauth/token`）、账号「测试」、监控探针，
   逐一对照新版 bundle 的对应调用点（头集、body 字段、UA 家族），见 §8。

## 10. 设备身份：一号一设备（2026-10-17）

`metadata.user_id` 是 CC 的设备/账号/会话三元组：JSON 形态 `{"device_id":<64 hex = .claude.json userID>,"account_uuid":<OAuth
账号 uuid，可为空>,"session_id":<uuid>}`，legacy 形态 `user_<hex>_account_<uuid>_session_<uuid>`。两条路径的处理：

- **worker 路径**：设备身份来自节点上该账号的 `CLAUDE_CONFIG_DIR/.claude.json`（首次运行生成、之后复用），一个账号 = 一台固定设备 +
  一个固定出口 IP。客户请求的 metadata 根本不到上游（历史被折叠成 prompt），这是对的。
- **直连路径**（`passthrough-anthropic` / `chat-via-anthropic`）：此前 `{...clientBody}` 原样转发，客户 CC 的 device_id / account_uuid
  直达上游，一个账号呈现成百上千台设备。现在 gateway `pinDeviceIdentity` 把 device_id 改写成账号的 `accounts.device_id`、account_uuid
  改写成 `accounts.account_uuid`（已知时），**session_id 原样保留**：上游看到的是一台设备上的多个会话，与真人多开窗口一致；
  网关 sticky key 取自改写前的 body，客户的粘性对话不受影响。
- **身份同步**：节点为真相源。节点启动/重连扫描全部账号目录、每次会话结束重读 `.claude.json`，心跳 `ccIdentities` 增量上报
  `{deviceId, accountUuid}`，console 写 `accounts.device_id / account_uuid`（迁移 11）。没有配置目录的新账号由平台 `ensureDeviceId`
  （sha256("1dayapi-device:"+id) 的 64 hex）生成，随 `cc_worker.open.deviceId` 播种为新 `.claude.json` 的 userID；节点值后续覆盖平台种子。
- **运维约束**：`/var/lib/1dayapi-cc-worker/cc-accounts/` 不可清空重建（否则全部账号同时"换设备"）；备份已包含 `.claude.json`。

## 11. 2026-10-28 升级到 2.1.312（按 §9 SOP）

采样方法同 §1：两版官方 Linux x64 二进制（`bun add -g @anthropic-ai/claude-code@<ver>`，包本身只是下载器，二进制在
`@anthropic-ai/claude-code-linux-x64`）以 worker 的真实参数（`-p --model claude-sonnet-5-5 --output-format stream-json --verbose
--tools "" --no-session-persistence --max-thinking-tokens 1024 --settings '{"alwaysThinkingEnabled":true}' --include-partial-messages`）
打到本地采样服务（`ANTHROPIC_BASE_URL`），逐字段比对。

| 项 | 2.1.300 | 2.1.312 |
|---|---|---|
| `User-Agent` | `claude-cli/2.1.300 (external, sdk-cli)` | `claude-cli/2.1.312 (external, sdk-cli)` |
| `X-Stainless-Package-Version` | 0.128.0 | 0.128.0（不变） |
| `X-Stainless-Runtime-Version` | v26.3.0 | **v26.12.1**（内嵌 Bun 1.4.3 → 1.4.4，`HEAD /api/hello` 的 UA 同步变为 `Bun/1.4.4`） |
| 计费头 | `cc_version=2.1.300.f23; cc_entrypoint=sdk-cli;` | `cc_version=2.1.312.6b4; …`（构建标志 `.f23` → `.6b4`，常量 `CC_BUILD_SUFFIX`） |
| `anthropic-beta`（同参数） | claude-code, oauth, interleaved-thinking, thinking-token-count, context-management, **prompt-caching-scope**, per-turn-control, effort, **dangerous-tool-use**, thinking-display-updates, **afk-mode**, extended-cache-ttl | claude-code, oauth, interleaved-thinking, context-management, per-turn-control, thinking-token-count, effort, thinking-display-updates, extended-cache-ttl |
| body | 含 `safeguards`（dangerous_tool_use 分类器上下文） | 无 `safeguards`；其余键相同（`output_config.effort=medium`、`thinking.adaptive`、`context_management` 同） |
| OAuth scope / 凭据文件 / token 端点 | 同 | 同（`user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload`、`.credentials.json`、`platform.claude.com/v1/oauth/token`） |
| stream-json 事件 | `system/init,status,api_retry`、`assistant`、`result` | 同形 |

**交互模式（entrypoint cli）主对话请求**（伪终端采样，两版各 sonnet-5-5 / opus-5-5 一次，工具 25 / 13 个，`thinking.adaptive display=updates`）：

| 项 | 2.1.300 | 2.1.312 |
|---|---|---|
| 计费头 | `cc_version=2.1.300.f23; cc_entrypoint=cli;` | `cc_version=2.1.312.6b4; cc_entrypoint=cli;` |
| `anthropic-beta` | claude-code, oauth, interleaved-thinking, thinking-token-count, context-management, **prompt-caching-scope**, per-turn-control, mid-conversation-tool-changes, effort, dangerous-tool-use, thinking-display-updates, afk-mode, extended-cache-ttl | claude-code, oauth, interleaved-thinking, context-management, per-turn-control, mid-conversation-tool-changes, thinking-token-count, **advanced-tool-use**, effort, dangerous-tool-use, thinking-display-updates, afk-mode, extended-cache-ttl |

同一会话里 Claude Code 还会发两类辅助请求：无 system 的小请求（beta 只有 claude-code/oauth/interleaved-thinking/redact-thinking/context-management）
和标题生成（structured-outputs，计费头后缀不同：2.1.300 为 `.0e6`，2.1.312 为 `.058`）。**构建标志不是版本常量而是按请求类型变化**，
平台模拟的是主对话请求，故取 `.6b4`（sdk-cli 与 cli 主请求一致）。

`prompt-caching-scope-2026-01-05`：2.1.312 的 12 次采样（sdk-cli 4 种条件 × 1、交互 2 模型 × 主请求 2 次 + 辅助请求）全部不发送；
2.1.300 的对应采样全部发送。字符串仍在两版的 beta 注册表里，不再加入请求头的条件在压缩代码的其他分块，未继续反编译；
远程功能开关能否重新打开它无法从二进制排除（两版采样环境相同）。

**常量改动**：`CC_VERSION` 2.1.312、`CC_RUNTIME_VERSION` v26.12.1、新增 `CC_BUILD_SUFFIX` "6b4"、`CC_BETAS` 取 2.1.312 主请求里
**与工具 / 功能无关的核心项**并按其顺序排列：`claude-code-20250219, [oauth-2025-04-20], interleaved-thinking-2025-05-14,
context-management-2025-06-27, thinking-token-count-2026-05-13`（与 2.1.300 时代的取舍一致：per-turn-control / mid-conversation-tool-changes /
advanced-tool-use / effort / dangerous-tool-use / thinking-display-updates / afk-mode / extended-cache-ttl 都跟着工具或功能走，非 CC 客户端的
请求体里没有对应字段，不注入）。`normalizeCcSoftware` 把客户端版本钉到节点版本时连构建标志一起改成节点的；钉到其他版本时保留客户端的标志。
节点部署脚本 `CLAUDE_VERSION=2.1.312`，探针 `func.py` 的 UA 与计费头同步。

**采样工具**（本次补进仓库，`ops/cc-capture/`）：`capsrv.mjs` 本地采样服务、`capture-sdk.sh`（-p 模式，worker 参数）、
`capture-interactive.py`（伪终端交互模式，预置 onboarding 跳过首启向导）；两版二进制用 `bun add -g @anthropic-ai/claude-code@<ver>`
装到独立 HOME 下取得（`…/node_modules/@anthropic-ai/claude-code-linux-x64/claude`）。
