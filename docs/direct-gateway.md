# worker-0 独立直连网关（1dayapi-direct）

> 状态：worker-0 独立网关初版已实现。本文同时记录建设契约与当前实现约束，后续变更须同步更新。
> 节点暂定名 `worker-0`。本文中的身份、出口和状态隔离属于硬性要求，不是部署建议。

## 1. 目标与边界

### 1.1 目标

- 交付单文件 Bun 二进制 `1dayapi-direct`，独立运行于 `worker-0`。
- 接受 Claude Code、Pi、OpenCode 及其他 Anthropic Messages / OpenAI Chat Completions 客户端。
- Claude Code 原生请求采用零业务注入路径；其他客户端经版本化兼容 Profile 转换。
- 推理、OAuth 刷新和辅助查询均从 `worker-0` 的账号绑定代理发出。
- 账号设备、会话、凭证和出口状态可持久化、可备份、可测试、可回滚。
- 用官方客户端本地采样与网关采样做逐字段对照，避免仅凭常量推断兼容性。

### 1.2 非目标

- 不替代现有 TUI / `ccr_worker`，不与其共享运行目录或身份状态。
- 不重写现有平台的用户、分组、计费和控制台体系。
- 不在第一阶段实现 OpenAI Responses、图片生成或其他非 Claude 上游协议。
- 不把协议一致性表述为对上游账号处置结果的保证。

## 2. 节点与状态隔离

`worker-0` 是独立的身份和出口边界：

```text
Claude Code / Pi / OpenCode
            |
            v
   1dayapi-direct (Bun)
   - client authentication
   - protocol adaptation
   - versioned CC profile
   - account/session affinity
            |
            v
   worker-0 account state
   accountId -> deviceId
             -> accountUuid
             -> OAuth credential
             -> proxy URL
            |
            v
   account-bound HTTP/SOCKS5 proxy
            |
            v
      Anthropic upstream
```

硬性不变量：

1. 不读取或写入 TUI 节点的 `CLAUDE_CONFIG_DIR`、`.claude.json`、代理分配表和配置密钥。
2. `worker-0` 的默认状态目录独立于现有 provider-node：
   - 配置：`~/.config/1dayapi-direct/config.json`
   - 状态：`~/.config/1dayapi-direct/state.json`
   - 密钥：`~/.config/1dayapi-direct/config.key`
3. 每个账号在 `worker-0` 上有独立 `deviceId`；缺省值由 `sha256("1dayapi-direct:" + nodeName + ":" + accountId)` 生成并持久化。
4. 每个账号必须配置固定代理。代理缺失、失效或连接失败时返回 `no_proxy_available`，禁止直接出网，也禁止切换到 TUI 节点或其他账号的代理。
5. OAuth 刷新后的 access token、refresh token 和 expiry 必须写入 `worker-0` 自己的加密状态文件，避免重启后重放旧 refresh token。
6. 备份和恢复以整个状态目录为单位；不得只复制配置而遗漏状态或密钥。

## 3. 客户端协议

### 3.1 端点

| 方法 | 路径 | 行为 |
|---|---|---|
| `GET` | `/health` | 返回服务名、节点名和版本，不泄露账号或代理信息 |
| `GET` | `/v1/models` | 返回已配置账号共同支持的 Claude 模型 |
| `POST` | `/v1/messages` | Anthropic Messages 原生入口 |
| `POST` | `/v1/messages/count_tokens` | 与 Messages 使用相同的账号和出口 |
| `POST` | `/v1/chat/completions` | OpenAI Chat 兼容入口，双向转换请求、响应和 SSE |

所有推理端点同时接受 `Authorization: Bearer` 和 `x-api-key`。客户端密钥只用于访问本网关，绝不转发到上游。

### 3.2 Native CC 模式

当请求具备 Claude Code 的结构特征时进入 Native CC 模式：

- 保留原始 messages、tools、thinking、context_management、cache_control、stream 和主提示词等业务内容。
- 只移除传输层头和客户端凭证；真实 entrypoint 保留，自定义或未知 entrypoint 归一到激活 Profile。
- Native 与 Agent 使用同一个激活 Profile：UA、`cc_version` 及其构建后缀、Stainless SDK/runtime 和机器头统一归一，避免同一上游账号呈现多个客户端版本。
- 替换为上游凭证，并将 metadata 中的 `device_id/account_uuid` 固定为当前上游账号在 `worker-0` 的身份。
- 结构完整时 `session_id` 保持不变；缺少 `claude-code-20250219` beta 时补齐，未知 Profile、身份块差异或新版本不因此拒绝。
- 不追加身份句、主提示词或 Claude Code 内置工具。

Native CC 的“零注入”指不增加业务内容，不排除凭证替换、账号身份固定和软件版本字段归一。版本归一只修改兼容性字段，不把旧客户端的主提示词或工具定义替换成另一版本。

如果请求自称 Claude Code 但计费块、metadata/session 等基础结构不完整，不返回 `cc_shape_mismatch` 拒绝，而是转入下面的 Agent 修复路径，重新构造完整的激活 Profile。生产日志（2026-11-12 美西近两小时）曾出现 3967 次 CC 请求全部被判 suspect，其中 3963 次含 `cc_profile_unknown`；因此 worker-0 不采用“未知版本即降级/拒绝”的策略。

### 3.3 Agent 兼容模式

非 Claude Code 请求进入 Agent 兼容模式：

1. OpenAI Chat 请求先转换为 Anthropic Messages；Anthropic 请求保留业务语义。
2. 按激活 Profile 构造 Claude Code 请求头、beta、计费块、身份块、metadata 和上下文管理字段。
3. 客户端 system/developer 内容作为独立缓存文本块保留，不写入客户端消息。
4. 客户端工具转换为 Anthropic 工具并按名称排序；不伪造客户端无法执行的 Claude Code 内置工具。
5. 客户端未提供会话时，根据客户端密钥、模型和对话根生成稳定 UUID；支持 `x-1dayapi-session-id` 显式指定。
6. 响应按客户端原方言返回，包括非流式 JSON、SSE、工具调用和 usage。

Agent 兼容模式是协议适配，不宣称任意第三方 Agent 的业务正文与官方 Claude Code 逐字相同。

### 3.4 出站形态管线（关键不变量）

worker-0 不以 UA 作为最终判断，也不以旧版硬门槛代替归一。每次上行严格按以下顺序执行：

1. **入口分类**：结构完整的 CC 走 Native；缺 beta 自动补齐；结构不完整走 Agent 修复，不因未知版本、身份块或 Profile 未登记而拒绝。
2. **软件归一**：UA、`cc_version`、SDK、runtime、机器头和真实 entrypoint 归一到激活 Profile；客户自定义 entrypoint 不直接透传。
3. **thinking 归一**：按目标模型处理 enabled/budget、adaptive、disabled、between_tools 与 effort，不丢 display 等其余意图。
4. **身份与 session**：metadata 固定为 `device_id → account_uuid → session_id` 的键序；派生 session 必须是确定性的合法 UUIDv4；JSON 与 legacy `user_…_session_…` 都能读取。
5. **机器环境**：`# Environment` 的 cwd、Platform、Shell、OS Version 和 scratchpad 与账号机器头同源，避免 Darwin 正文配 Linux 头。
6. **beta 与顶层结构**：`claude-code-20250219` 必须存在，OAuth beta 紧跟其后；Native 保留客户端功能 beta，不把整组高级/延迟工具 beta 强加给所有请求；只有 Agent 修复使用整组 canonical。顶层键按 Messages 顺序校验。ToolSearch、DeferredToolPlaceholder、延迟 schema 和 tool_use/tool_result 均按客户端原消息透传。
7. **计费后缀最后重算**：所有改体完成后，使用 suffix-v1（盐 + 首条用户文本 `[4,7,20]` + 出站版本）重算。首条用户文本跳过 `<system-reminder>`，不把样本里的 `93a` 当常量。
8. **出站硬校验**：再次核对 UA/计费版本与后缀、entrypoint、metadata/session、Stainless lang/package/runtime、beta 顺序、机器环境和顶层键序。任一不符返回 400 `cc_shape_mismatch`，请求不进入账号冷却、不计费，也不发往上游。

`2.1.322` 的 suffix-v1 已通过真实客户端样本验证：同一消息计算结果确为 `93a`；其他消息必须得到各自的后缀。归一后的出站校验与入站分类相互独立，避免“入站看似合规、归一后又混版”。

## 4. 版本化 Claude Code Profile

每个 Profile 对应一个明确的 Claude Code 版本，包含：

- `claudeCodeVersion`、SDK 版本和 runtime version
- UA、entrypoint、Stainless 头、Anthropic 版本
- canonical beta 集及 OAuth beta
- 计费块和身份块
- thinking / context_management 默认结构
- 支持的入口和模型最低客户端版本

Profile 是请求兼容性的唯一来源。运行代码不得另维护一套漂移的版本常量。

升级流程：

1. 在隔离配置目录中运行指定版本官方 Claude Code，将 `ANTHROPIC_BASE_URL` 指向本地采样器。
2. 保存 `cli` / `sdk-cli`、工具、多轮、thinking 和辅助端点样本。
3. 必要时使用 REA 检查 Bun 二进制内嵌 JavaScript，确认采样无法解释的构造逻辑。
4. 对官方样本与网关样本做字段、顺序和关联值 diff；随机值只脱敏，不破坏 session 等关联约束。
5. 新增 Profile 并保留旧版，测试通过后再切换默认值。

## 5. 账号调度与会话亲和

第一阶段采用可预测的本地调度：

- 候选账号必须启用且支持请求模型。
- 优先使用会话已绑定账号；绑定账号不可用时返回明确错误，不静默改变设备或出口。
- 新会话按账号当前在途数、最近使用顺序选择。
- 会话绑定键包含客户端密钥、模型和 session UUID，避免不同客户端或模型互相牵引。
- 当前会话绑定保存在内存中，进程重启后按当时候选账号重新选择；跨重启持久绑定作为后续增强，不与凭证状态混写。

错误处理：

- 上游 4xx 按原方言返回，不盲目换号。
- 网络与代理错误不直接出网重试。
- OAuth 401 可在同一账号、同一代理上强制刷新后重试一次。
- 同账号并发刷新合并为一个 Promise，刷新成功立即持久化。

## 6. 出口与传输

- 运行时必须为 Bun；Node.js 启动仅可用于 TypeScript 检查，不提供服务。
- HTTP/HTTPS 代理直接交给 `Bun.fetch({proxy})`。
- SOCKS5/SOCKS5H 通过本地 CONNECT 桥接，远端 DNS 与认证行为沿用 provider-node 的实现约束。
- Anthropic `/v1/*` 请求使用 `Accept-Encoding: gzip, deflate, br, zstd`。
- 上游响应压缩体由网关流式解压，避免自动解压导致 SSE 缓冲。
- 辅助端点不套用 Messages 的 Stainless 头集。
- 日志只记录请求 ID、账号 ID、状态码、字节数和耗时，不记录凭证、代理 userinfo、提示词或响应正文。

### 6.1 伴生遥测：与版本归一分开处理

现有 1dayapi 的两种模式不能混为一谈：

- 旧直连模式只归一推理请求的软件字段；`docs/claude-code-compat.md` 明确将客户端后台流量排除在网关之外。
- TUI / `ccr_worker` 运行固定版本的真实 Claude Code，并通过 `HTTPS_PROXY` 等变量把其全部流量送到账号代理，因此 statsig、特性评估和 usage 等伴生行为由真实客户端自然产生（`docs/ccr-supply.md` §8.1）。

worker-0 已实现可选的 companion（默认关闭），不伪造或静态回放遥测事件。仅归一 Messages 的 UA 不能改变客户本地 Claude Code 另行发出的遥测内容或目的地，因此 companion 使用真实官方客户端：

1. `companion.claudeBin` 必须与激活 Profile 完全相同，不复用 TUI 节点配置目录。
2. 每账号使用 `<state-dir>/companions/<accountId>/` 作为独立 HOME/CLAUDE_CONFIG_DIR，物化设备身份和 OAuth 凭证；API key 通过进程环境传递。
3. 以 `-p --input-format stream-json --output-format stream-json --verbose --tools "" --no-session-persistence` 启动并保持 stdin 等待，不写任何用户消息，因此不产生推理请求。
4. 进程的 `HTTPS_PROXY`、`HTTP_PROXY` 及小写变量全部指向该账号代理，不继承宿主 `NO_PROXY` 或其他绕过配置。
5. 服务启动时按账号逐个拉起；凭证轮换后重启对应 companion；异常退出按 `restartDelayMs` 退避重启，服务停止时终止进程组。
6. `/health` 的 `companion` 字段只暴露 enabled、running、startingOrFailed 数量，不暴露账号或路径。

本地真实客户端验证已确认：等待期间出现到 `api.anthropic.com:443` 的辅助 CONNECT，模拟 Messages 上游收到的 companion 推理请求为 0；随后客户工具闭环只产生客户自身的请求。该验证不依赖向真实上游发送流量。

companion 使部署增加一个固定版本的官方 CC 二进制资产；启用前应核对 `claude --version` 与激活 Profile。生产灰度仍需观察进程内存、退出频率和真实账号辅助流量。

## 7. 配置与密钥

配置中的敏感字段支持 `env:VARIABLE_NAME`，推荐由 systemd `EnvironmentFile=` 注入。字面量配置仅适合隔离测试。

示例（不含真实凭据）：

```json
{
  "nodeName": "worker-0",
  "listen": { "host": "127.0.0.1", "port": 8410 },
  "clientApiKeys": ["env:DIRECT_GATEWAY_CLIENT_KEY"],
  "companion": {
    "enabled": true,
    "claudeBin": "/opt/claude/claude",
    "restartDelayMs": 5000,
    "startupStaggerMs": 500
  },
  "controlPlane": {
    "baseUrl": "https://1dayapi.com",
    "token": "env:WORKER0_CONTROL_TOKEN",
    "timeoutMs": 10000
  },
  "accounts": [
    {
      "id": "account-0",
      "baseUrl": "https://api.anthropic.com",
      "accessToken": "env:WORKER_0_CLAUDE_ACCESS_TOKEN",
      "refreshToken": "env:WORKER_0_CLAUDE_REFRESH_TOKEN",
      "expiresAt": null,
      "proxy": "env:WORKER_0_CLAUDE_PROXY",
      "models": ["claude-*"]
    }
  ]
}
```

状态文件中的 token 使用 AES-256-GCM 加密；`config.key` 为随机 32 字节并以 `0600` 保存。配置、状态和密钥均不得进入 git。

## 8. CLI、构建与运行

```bash
# 开发
bun apps/direct-gateway/src/index.ts serve --config /path/to/config.json

# 编译与检查
pnpm --filter @1dayapi/direct-gateway build
pnpm --filter @1dayapi/direct-gateway test
bun build apps/direct-gateway/src/index.ts --compile --outfile 1dayapi-direct

# 运行
./1dayapi-direct serve --config /path/to/config.json
```

默认仅监听 `127.0.0.1`。跨机访问必须在前面放置具备鉴权和 TLS 的内网反向代理，不能直接把无 TLS 的端口暴露到公网。

## 9. REA 使用边界

需要 REA：

- 检查官方 Claude Code Bun 二进制与内嵌 JavaScript。
- 追踪采样无法解释的请求构造、beta 选择、重试和辅助端点逻辑。
- 对比新旧官方版本的兼容性变化。
- 分析保留的 HAR / mitmproxy 记录。

不需要 REA：

- 阅读或修改本仓库完整源码。
- 编写协议转换、代理、状态和测试代码。
- 普通 NDJSON 本地采样分析。
- Bun 构建、单元测试和端到端测试。

TLS ClientHello 需要专用抓包/TLS 工具；REA 不替代这类证据。

## 10. 测试与验收

### 10.1 单元与契约测试

- OpenAI ↔ Anthropic 的非流式、流式、工具调用和 usage 转换。
- Native CC 的 messages、tools、主提示词和 thinking 不变；UA、计费块、SDK/runtime 归一到激活 Profile，设备身份固定且 session 一致。
- Agent 请求具备激活 Profile 的必填结构，客户端工具和 system 不丢失。
- 同账号 device/proxy 稳定；不同账号不共享身份。
- 代理缺失或失败时 fail closed。
- OAuth 刷新使用绑定代理，轮换后的凭证加密持久化，后续请求与 companion 不重复使用旧 refresh token。
- 缺 beta 的 Native 请求自动补齐；结构不完整的 CC 请求进入 Agent 修复而不是拒绝。
- companion 不发送 prompt，使用独立设备与固定代理，凭证轮换后重启，停止服务时清理进程。
- 配置与日志不泄露 token 和代理密码。

### 10.2 本地端到端

- 模拟上游记录完整请求并返回可控 JSON/SSE。
- 官方 Claude Code 与网关样本执行脱敏 diff。
- Pi 通过 OpenAI Chat 完成文本和工具调用。
- OpenCode 通过 Anthropic 或 OpenAI Chat 完成相同矩阵。
- Claude Code 通过 Native CC 路径完成文本与工具调用。
- 编译后的二进制在脱离源码目录的条件下重复上述冒烟测试。

### 10.3 上线顺序

1. 仅本地模拟上游。
2. `worker-0` 单账号、单代理、内部密钥灰度。
3. 核对上游状态、流式稳定性和状态文件恢复。
4. 再增加账号和客户端，不与 TUI 节点做身份或出口迁移。

## 11. 计费、缓存、限额与刷新对齐

### 11.1 唯一真相与控制面

worker-0 是 Bun 数据面，console/core 继续作为唯一账务、窗口和凭证版本真相。启用 `controlPlane` 后：

1. 每个请求先调用 `POST /internal/worker0/admission`，由 console 校验 Key、用户、分组、余额、授信、Key 额度、模型白名单并用 `listCandidates` 返回有序候选账号。
2. 每个上游响应先调用 `/account-event`，由 console 用 `recordWindowUsage` 和 `markFailure` 统一处理 5h/7d、98% 阈值、冷静期、普通 429、503/529、支付和模型作用域。
3. 正常流在终止事件前调用 `/settle`；部分流和错误也写对应用量行。console 用 `settleRequestDurably` 完成价格快照、幂等扣费、余额/授信/Key 额度与号商收益。
4. OAuth 轮换通过 `/credential-rotation` 做事务内 compare-and-swap。worker-0 收到冲突凭证后使用 console 的最新值，不重复旧 refresh token。

控制面不可用时不继续无约束放量；准入失败按原方言返回，结算失败不向客户端发送正常终止事件。

### 11.2 用量与缓存双账本

`UsageAccumulator` 与现有网关同形：

- Anthropic 非流式与 SSE 的 input/output/cache read/cache write；OpenAI cached_tokens 也归入缓存读。
- 缓存写总数和 5m/1h 拆分；只给总数时归 5m，拆分超过总数时以 1h 为优先裁剪。
- 正常流、部分流、usage 缺失、媒体块、工具调用/结果和实际模型均记录。

Native 使用上游原始用量，不误扣客户自己的主提示词。Agent 先按激活 Profile 的前三个 system 块估算平台开销，再按「缓存读 → 1h 写 → 5m 写 → input」顺序扣除；客户显式要求缓存时才保留写入分档，否则剩余写入并入 input。客户工具定义不扣除。

计费结果继续由 console 按目录/覆盖价、5m 1.25×、1h 2×、分组倍率和价格快照计算。OpenAI 的 prompt 合计包含 input + cache read + cache write，不额外虚增缓存字段。

### 11.3 冷却、窗口与换号不变量

- 普通 429 走 Retry-After 软冷却；窗口 429 硬排除；请求级 429 不冷却账号。
- 5h/7d 分列，达 98% 后停止新请求；5h reset 后随机 1h45m～2h05m，7d 不加。
- 同窗口低样本不缩短已生效暂停；Fable 和单模型/组织级暂停只影响对应 scope。
- 绑定账号不可用时 worker-0 当前直接返回 503，不静默换号，因此不会误标 `account_switched`。若未来开启换号，必须先接 ForceCacheBilling 和现有返还任务。
- OAuth 到期前 5 分钟刷新、同账号同代理、401 强刷一次、并发合并、加密持久化和 companion 同步均保留；跨进程覆盖由 console CAS 防止。

### 11.4 验收

- console 真实 SQLite：同一 requestId 不重复扣费、缓存两档、5h 暂停不缩短、7d 无冷静期、轮换冲突不覆盖。
- worker-0 控制面：admission/settle requestId 一致、Agent 总提示词减少、TTL 分档、窗口事件、部分流 `streamTruncated=true`。
- 既有协议、Native 版本归一、压缩 SSE、代理失败关闭和 companion 生命周期测试继续通过。
