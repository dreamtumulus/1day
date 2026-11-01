# Canonical Claude Code Worker + API Adapter 实施方案 v1

> 状态：**实施计划，未执行**。本文不替代冻结的设计文档
> `docs/canonical-cc-worker-api-plan-2026-11-01.md`，也不修改任何代码或生产配置。
>
> 基线：冻结设计文档 + 当前仓库/生产快照。实施前 R0 必须重新读取实际 HEAD、worktree
> 和生产版本，不能把提交号或行号当作长期坐标。
>
> 参考项目：**CPA（CLIProxyAPI，MIT）**、**sub2api（LGPLv3）**、**newapi（AGPLv3）**。
> 三者仅作为设计与测试参考；LGPL/AGPL 代码不要直接复制进闭源实现，需法务确认或重写。

---

## 0. 结论与必须先拍板的决策

### 0.1 核心结论

**目标 1（上游归一，包括遥测）只有在 canonical worker 路径上才能完整成立。**

原因不是实现难度，而是拓扑决定的：

- **raw direct**：客户本地 Claude Code 的 Messages 可以经网关归一化，但遥测的 ingest 地址是
  CC 内嵌源码硬编码的 `https://api.anthropic.com/api/event_logging/v2/batch`，不跟随
  `ANTHROPIC_BASE_URL`。网关无法接管客户进程的遥测，也无法把遥测绑定到订阅账号的身份/出口。
- **canonical worker**：节点上的官方 CC 同时产生 Messages 和遥测，两者共享同一账号、
  `.claude.json`、native session、机器档和 pinned proxy，才能同时满足“请求归一 + 遥测归一”。

因此必须先做一个产品决策：

| 决策 | 结果 |
|---|---|
| **遥测是硬目标** | CC 客户默认 `telemetryPolicy=native-required` → **走 canonical worker**；raw direct 只能作为明确标注的 `passthrough-isolated` 例外，不计入目标完成量 |
| **延迟优先，遥测不作硬承诺** | 允许 direct 归一化，但必须明确它只保证 Messages 形状，不保证账号侧原生遥测 |
| **两者都要** | 不可行；除非能控制客户本地 CC 的遥测（当前不能），否则只能走 canonical worker |

**方案建议：默认 `native-required`，CC 客户也走 canonical worker；direct 作为显式 opt-in 的
`passthrough-isolated` 例外。** 这会让“直连优先”变成“canonical worker 优先，direct 例外”，
但这是唯一能满足“包括遥测”的路径。

### 0.2 三个不可妥协的架构选择

1. **canonical worker 不替换 CC 主提示词**
   - 不用 `--system-prompt` / `--system-prompt-file` 写“你是 API assistant”；
   - 保留官方默认 system prompt；
   - 客户 system 用 `--append-system-prompt`（或 G1 验证的 append-file）追加。

2. **native worker 不折叠历史**
   - 正常路径使用 `--session-id` + 原生 persistence + `--resume`；
   - 不把历史变成 `[user]/[assistant]` 文本；
   - 外部历史导入必须 G3 通过，否则明确拒绝。

3. **内置工具先 restricted，Bash 单独安全发布**
   - 首批只开 `--restricted` 的 Read/Glob/Grep 等；
   - Bash/PowerShell 在 G7 通过前不开；
   - 当前 UID/0700/mount namespace 不足以作为完整沙箱。

---

## 1. 目标、非目标、不变量

### 1.1 目标

- 订阅 OAuth 的 direct/worker 都是真实 Claude Code 形态；worker 使用节点官方二进制，
  不出现“API assistant / 不是 CC / 没有工具”的上游提示。
- CC 客户端：结构校验 + 版本 profile 归一化；custom entrypoint 按 Key 授权；
  telemetryPolicy 决定 direct 或 canonical worker。
- 非 CC 客户端：Messages / Chat / Responses 适配层 + canonical worker，提供稳定 API 体验。
- 历史真实可恢复：原生 CC session；不静默折叠。
- 遥测真实可证：worker 的 Messages 与遥测同账号、同 session、同出口；
  raw direct 不冒充 native。
- 不静默失真：不支持参数/能力明确拒绝或标记估算。

### 1.2 非目标

- 不承诺订阅 OAuth 与官方 Messages API 每个高级参数完全等价。
- 不为 Responses 强制引入 OpenAI 上游；可适配到内部 Messages。
- 不把 `cli`、`sdk-cli`、`restricted` 混成一个 profile；不混拼字段。
- 不随机化 JA3；不把 direct `cli` 与 worker `sdk-cli` 的官方差异当“一号两软件”。
- 不伪造/重放遥测，不用假上游 200 当真实证据。

### 1.3 不变量（实现必须断言）

- **I1** canonical worker 无 `--system-prompt*` 替换 CC 主提示词，无“不是 CC/没有工具”指令。
- **I2** 上游提示词/Environment/遥测无 `1dayapi`、平台 scratch 真实路径、网关实现细节。
- **I3** canonical 正常路径不调用 `messagesToPrompt()`/`workerSystemPrompt()`，不折叠历史。
- **I4** 下游只能看到客户声明的 caller tools；内置 tool_use/事件不泄漏。
- **I5** 客户提示词驱动的工具不能读 OAuth、节点秘密、其他账号/组织/会话；不能绕过 pinned proxy。
- **I6** 同一 conversation generation 只有一个可写 native revision；不并发 resume。
- **I7** resume/重试/工具续轮/max_tokens 不重复扣费。
- **I8** native transcript 不跨节点、不跨组织搬运。
- **I9** 灰度可回滚，但进行中的 native conversation 不得切回折叠历史。
- **I10** 无真实上游接受证据只能标 `unknown`，不能标成功。

---

## 2. 目标架构与路由

```text
Claude Code 客户端
  └─ 原始结构 gate + Key allowlist
       ├─ telemetryPolicy=native-required
       │    └─ canonical worker（真实 CC -p + native session + native telemetry）
       └─ telemetryPolicy=passthrough-isolated
            └─ raw direct（profile 归一化；仅 Messages，不承诺 native 遥测）

Messages / Chat / Responses 客户端
  └─ API adapter（严格参数、协议转换）
       └─ canonical worker（caller MCP tools + native session + native telemetry）

所有路径共享：
真实订阅 OAuth、固定 device/account、固定机器档、固定 node/proxy、
组织隔离、双账本、conversation 绑定、org 级熔断
```

### 2.1 路由顺序（固定）

1. 认证、模型/额度准入、参数校验。
2. 解析 conversation identity + 既有 generation；
   **已有 conversation 的模式/native/telemetryPolicy 优先于新请求全局设置**。
3. 识别 CC 客户端，跑原始结构 gate；custom entrypoint 只在该 Key 的 allowlist 中参与。
4. 读取 Key 的 `telemetryPolicy`：
   - `native-required`：不得选择 raw direct；
   - `passthrough-isolated`：才允许 direct 可用性判断。
5. direct 不可用或策略要求节点执行 → 选支持所需 profile、G10 证据有效的 canonical worker 节点。
6. 非 CC 请求只进 API adapter + canonical worker；legacy worker 仅迁移期显式保留。
7. 节点未声明 capability → 不得假定支持；`native-required` 无合格节点 →
   **503 `native_telemetry_unverified`**，不得降级冒充完成。

### 2.2 新 Key 策略默认

```json
{
  "historyPolicy": "passthrough",
  "workerMode": "canonical",
  "telemetryPolicy": "native-required",
  "allowedCustomEntrypoints": [],
  "parameterPolicy": "strict",
  "responseMode": "strict",
  "probeIntercept": false,
  "autoProbeIntercept": false
}
```

- 存量 Key 暂时 `workerMode=legacy`、`parameterPolicy=warn`、`responseMode=keepalive`、
  `telemetryPolicy=passthrough-isolated`；**不静默切换**。
- 迁移按 Key/客户逐个显式选择；存量 raw direct 要保留现状必须标 `passthrough-isolated`，
  不计入 native 完成量。
- `workerMode`/`telemetryPolicy` 只决定新 conversation；已有 conversation 固定其启动时的模式。

---

## 3. 参考项目取用与不取用

### 3.1 CPA / CLIProxyAPI（MIT）

**取用：**

- `ClaudeDeviceProfile` / `fingerprint-profile` 思路：按 credential 选择固定
  UA/package/runtime/OS/arch，不逐请求随机。
- `ClaudeCLIAuthIdentitySeed` / stable device/account：确定性身份，避免 token 轮换导致设备漂移。
- `ClaudeCodeSessionID`、prompt cache 作用域：session/agent 级稳定键。
- `ClaudeHeaderDefaults`：canonical header 集、beta、diagnostics。
- `claude_executor_cloaking` / response header 清理：给 CC 客户端清理网关可识别头。
- 配置/管理 API 的 profile 校验：未知 profile 写入即拒绝，不静默回退。

**不取用：**

- CPA 是 API 代理，不运行 canonical worker；它的 fingerprint 不能提供账号侧原生遥测。
- 不把 CPA 的 Mac/Windows 机器档直接套到 Linux worker；worker 实际 OS 必须和 body/遥测一致。
- 不把“cloak”当成 G10 证据。

### 3.2 sub2api（LGPLv3）

**取用：**

- `ClaudeCodeValidator`：UA、system prompt similarity、billing header、entrypoint marker；
  作为 gate 的补充，不取代我们的结构 gate。
- `normalizeClaudeOAuthRequestBody`：缺失 `temperature=1`、`max_tokens=128000`、`tools=[]`、
  `context_management` 的补齐；只对非 CC/缺失情况使用，不覆盖客户显式值。
- `claudeMachineProfiles` / `accountMachine`：一号一机器、OS/arch/shell/workingDir 同源；
  可借鉴 profile 设计。
- `anthropicfp.NormalizeDateline`：清理客户端在日期句里的隐写差异。
- `apicompat.ResponsesToAnthropicRequest` / `forwardResponsesViaNativeAnthropic`：
  Responses↔Anthropic 的请求/响应/流式状态机、tool pairing、usage、错误映射。
- `claude-oauth` 的 metadata/session/account_uuid 归一化思路。

**不取用：**

- sub2api 的“system prompt injection/伪装”是 API 代理的 mimicry，不是 canonical CC；
  不能用于 worker 的 G1/G10。
- LGPLv3 代码不要直接复制进闭源仓库；优先重写或做合规评估。
- 它的 OS 档位是桌面多样性；canonical worker 在 Linux 节点上不能用 Mac/Windows 遥测，
  必须用节点真实/受限机器档。

### 3.3 newapi（AGPLv3）

**取用（设计/测试向量，不复制代码）：**

- `relaykit/relayconvert` 的请求/响应/流式 golden 测试思路；
- Claude↔Chat/Responses 转换器的 stop_reason、usage、tool_call、terminal event 处理；
- `HandleStreamResponseData` 对 `message_stop`/完成状态的显式判定；
- channel/adaptor 抽象、错误状态映射、重试边界。

**不取用：**

- newapi 是通用 API 网关，不提供 CC 设备/机器/遥测语义；
- AGPLv3 代码不要直接复制进闭源服务；只参考协议行为与测试用例。
- 它可能对未知参数较宽松；我们的 `strict` 策略要更严格。

---

## 4. 领域模型与契约

### 4.1 版本 profile（核心新模块）

新增 `packages/core/src/cc-profile.ts`（名称按仓库约定）：

```ts
interface CcProfile {
  profileId: string;              // e.g. cc-2.1.312-sdk-cli
  ccVersion: string;
  sdkVersion: string;
  runtimeVersion: string;
  entrypoint: "cli" | "sdk-cli" | "restricted";
  billingAlgorithm: string;
  identityBlock: string;
  betaPolicy: { base: string[]; modelRules: ...; featureRules: ... };
  toolsTemplateDigest?: string;
  systemPromptDigest?: string;
  evidence: { source: string; sampledAt: string; digest: string }[];
}
```

规则：

- **禁止跨版本 pin**：没有完整 profile 时，不允许只改 UA/Stainless/billing 冒充另一版本。
- 同版本只修 transport/device/machine/custom entrypoint；版本相关 body 保持该版本原样。
- 未知版本：`requireKnownProfile=1` 时不得 direct；运营选择 observe 时原样 direct 并记录
  `cc_profile_unknown`，但不得 pin 成已知版本。
- worker 使用节点真实二进制版本；不把 `-p/sdk-cli` 改成 `cli`。
- 新版本加入 profile 前必须完成 G9 采样；2.1.316 等不能因“检查更少”而直接放行。

### 4.2 `api_keys.policy_json`

复用现有字段，新增：

```json
{
  "historyPolicy": "passthrough",
  "workerMode": "legacy|canonical",
  "telemetryPolicy": "native-required|passthrough-isolated",
  "allowedCustomEntrypoints": ["mirasim"],
  "parameterPolicy": "strict|warn",
  "responseMode": "strict|keepalive",
  "probeIntercept": true,
  "autoProbeIntercept": false
}
```

- 新 Key：`strict`、`canonical`、`native-required`、`autoProbeIntercept=false`。
- 存量：`warn`、`legacy`、`passthrough-isolated`、`keepalive`，逐个迁移。
- 会话启动后模式固定；不可中途改变。

### 4.3 native session 元数据

首批复用 `worker_turn_memory.data` 存版本化 JSON，或新增 `native_sessions` 表（仅新增）；字段：

```text
schemaVersion, mode, profileId, accountId, teamId, nodeId,
nativeSessionId, revision, expectedTurn, state,
clientHistoryHash, assistantResponseHash,
configGeneration, syntheticCwd, usageBaseline,
pendingCallerCalls, checkpointId, expiresAt
```

状态机：

```text
READY -> RUNNING -> COMMITTED
                  ├-> AWAITING_CALLER -> RUNNING
                  └-> DIRTY / LOST
```

- `COMMITTED`：result 完整、usage 基线记录，可接下一轮。
- `AWAITING_CALLER`：仅在 G5 证明可恢复时允许回收；否则保留进程到工具超时。
- `DIRTY`：max_tokens 截断、abort、stdout 中断、result 缺失；不得作为下一轮干净基线。
- `LOST`：transcript 不存在、revision 冲突、节点不可恢复；明确错误，不折叠恢复。
- transcript 本体不进 SQLite、不打日志；TTL 初始 24h（可配置），到期 `session_expired`。
- native session 绑定 `accountId + nodeId + configGeneration + profileId + syntheticCwd`；
  **不跨账号、不跨节点、不跨组织**。

### 4.4 `telemetryEvidence`

新增版本化记录（表或 JSON 文件，仅元数据）：

```text
accountId, profileId, nodeId, proxyId, nativeSessionId,
ccVersion, endpoint, realStatus, source, observedAt, structureDigest, expiresAt
```

- 不记录 OAuth/API Key/事件正文/URL query。
- 只覆盖明确测量的账号/profile/出口；不能外推到节点或池。
- 版本/profile/出口变化即失效；未覆盖为 `unknown`，不标成功。
- **raw direct 不产生该证据**，只能标 `passthrough-isolated`。

### 4.5 节点协议新增

`CcWorkerOpen`：

```text
profileId, appendSystemPrompt?/callerInstructions?,
nativeSession { id, action: start|resume|fork, revision, checkpointId? },
builtInToolProfile: "restricted"|"tools-disabled",
expectedTurn, reuseKey
```

新增 typed `cc_worker.state`：

```text
nativeSessionId, revision, state, checkpointId, reasonCode
```

`cc_worker.close/commit` 带 revision 和幂等语义；迟到帧不能覆盖新状态。

heartbeat：

```text
ccWorker.canonicalProfiles[], historyImport, restrictedTools,
telemetryEvidence { covered, expiresAt, source },
nativeSessions, resumeFailures, diskUsage
```

HTTP egress spec 增加 `preserveHeaders:true` + capability `raw-v1`。

---

## 5. 工作包与实施顺序

### WP0：基线与 P0 Gate（先做，不改生产路由）

**目标**：证明参数存在且语义成立，建立证据。

- 清理/确认他人未提交修改；冻结 R0 基线。
- 新增 `tests/e2e/cc-canonical-probe/`：临时 HOME、临时 `CLAUDE_CONFIG_DIR`、假 OAuth、
  本机假上游；不消耗客户账号。
- 完成 G1/G2/G8/G9；G10 只做受控结构，不做真实接受。
- 输出：版本化 JSON 证据、结构摘要、失败原因；不得改断言迁就实现。
- 文件：`tests/e2e/`、`apps/provider-node/test/`、`packages/core/test/`。
- 退出条件：G1/G2/G8/G9 有明确结论；G3/G4/G5/G6/G7/G10 有 PoC 计划。

### WP1：direct profile 与归一化（可与 WP0 并行）

**目标**：CC 客户端 direct 时，profile 一致、custom entrypoint 可控、附件中性化；
但 `native-required` 不走 direct。

修改：

- `packages/core/src/cc-profile.ts`（新增）、`cc-shape.ts`、`fingerprint.ts`、`settings.ts`。
- `apps/gateway/src/upstream.ts`、`proxy.ts`、`conversation.ts`。

步骤：

1. `classifyCcRequest` 返回原始结构 verdict + version + entrypoint；
   新增 `allowedCustomEntrypoints` 从 Key policy 传入；**先 gate 原始请求**。
2. gate 通过后调用 `normalizeCcSoftware`；自定义 entrypoint 才允许改写
   UA/billing/entrypoint；保留客户 messages/system 语义。
3. normalize 后**再次运行完整 gate + profile 一致性断言**；最终必须 genuine。
4. `metadata.user_id` 重建 canonical 顺序；device/account 用账号身份；
   `# Environment` 与 `accountMachine` 一致。
5. 附件中性化：只剥离可识别 `userEmail`、真实 gitStatus、自动 CLAUDE.md、
   宿主路径附件；不得宽正则误删客户显式消息。
6. 版本未知：不 pin；`requireKnownProfile` 时不得 direct；记录 `cc_profile_unknown`。
7. 删除全局 `direct_cc_entrypoint_normalize` 的长期依赖，改为 Key allowlist。
8. CC 响应头 profile：清理网关可识别头；`x-1day-mode`/`ignored-params`
   默认只给 API 客户端。

测试：

- 单元：profile per version/entrypoint；custom entrypoint 未授权不走 direct；
  授权后完整链路 genuine；normalize 后 re-gate。
- 集成：mirasim 流式真实调用；unknown version；附件中性化；metadata 顺序。
- 退出条件：直连路径无版本混拼；custom entrypoint 只按 Key 授权；
  direct 只服务 `passthrough-isolated`。

### WP2：canonical worker 进程、工具边界、合成 cwd

**目标**：worker 是真实 CC，system/tools/environment 正常，内部工具不泄漏。

修改：

- `apps/gateway/src/ccr/worker.ts`、`translate.ts`、`session-memory.ts`、
  `apps/provider-node/src/cc-worker.ts`、`machine-runtime.ts`、`mcp-server.ts`、`protocol.ts`。

步骤：

1. canonical open 用 `profileId`，不再发 legacy `systemPrompt`。
2. 移除 `--system-prompt-file`、`--tools ""`；保留
   `-p --output-format stream-json --verbose --include-partial-messages`。
3. 保留官方 system prompt；客户 system 用 G1 验证的 `--append-system-prompt-file`，
   无 file 变体时作为首个 user 的 `caller_instructions` 内容。
4. `--system-prompt-snapshot on`；保留防 fallback、pinned proxy、机器身份；
   不设置 `DISABLE_TELEMETRY`/`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`。
5. `--restricted` + `--permission-prompts none` + `--strict-mcp-config`；
   caller tools 仍走回环 MCP；首批不开放 Bash。
6. `--no-session-persistence` 移除（为 WP3）；在 WP3 前先做 live process 多轮。
7. 在 `machine-runtime.ts` 的 mount namespace 内把真实 scratch bind 到
   `accountMachine.workingDir`；chdir 合成路径；自检 cwd/读写/清理/其他会话不可见。
8. `translate.ts` typed 事件分类：
   - `mcp__caller__<name>` → 客户 tool_use；
   - 内置工具事件只消费，不下发；
   - 内部工具循环不提前 `stop_reason:tool_use`；
   - 只有 caller tool 停泊/最终 result 结束客户响应；
   - 索引重映射；`internal_tool_event_leaked_total=0`。
9. 删除 `workerSystemPrompt` 的 API assistant/平台路径文本；canonical 不再调用它。

测试：

- 首轮/多轮/live 多轮；restricted 工具；caller MCP；Read/Bash/WebFetch 与 caller 混合、
  并行、交错；内部工具零泄漏；cwd/Environment 合成；无平台路径。
- 退出条件：canonical 正常路径无折叠、无 API prompt；restricted 安全自检通过；
  工具过滤 0 泄漏。

### WP3：native session、resume、外部历史

**目标**：正常路径使用官方 session，不折叠；可恢复边界明确。

修改：

- `apps/gateway/src/ccr/worker.ts`、`session-memory.ts`、新增 `native-session.ts`、
  `packages/core/src/conversations.ts`/`migrations.ts`、`provider-node/src/cc-worker.ts`。

步骤：

1. fresh：生成 revision + native session UUID；`--session-id <uuid>`；
   移除 `--no-session-persistence`；以 CC `system/init`/`result` 的 session_id 为权威。
2. live process 继续 stream-json；优先 live，减少 resume。
3. 进程/节点重启：同 account/team/config/profile/syntheticCwd/nativeSessionId →
   `--resume`；全部匹配才恢复。
4. `AWAITING_CALLER`：G5 通过才允许回收；否则保留到工具超时；
   丢失返回 409 `tool_continuation_lost`。
5. `DIRTY`：max_tokens/abort/stdout 中断/result 缺失；只恢复 clean checkpoint 或失败，不折叠。
6. `LOST`：transcript 不存在/revision 冲突/节点不可恢复 → 明确错误，不跨节点/组织。
7. 外部历史：G2 官方输入优先；G3 importer 只创建新 native session，保留
   role/content/tool pairing/signature；不支持 assistant prefill/跨组织 handle/失效 signature →
   400/409；G3 未通过前 canonical 对未知外部历史返回 `history_import_unsupported`，
   Key 保持 legacy。
8. transcript 存在节点原账号配置区；TTL 24h（可配置）；清理时安全删除；不写日志。
9. 计费：resume usage 累计值按最后 baseline 取增量；request_id/journal 幂等；
   冲突停止不重复收费。

测试：

- 进程 kill/节点重启/蓝绿切换 resume；三轮普通 + 一轮 caller tool；
  revision 冲突、重复 open/commit、迟到 close；DIRTY/LOST/TTL；外部历史 matrix。
- 退出条件：同 account/node resume 无丢失/重复；跨节点/组织明确失败；无折叠回退。

### WP4：API adapter 与严格参数契约

**目标**：非 CC 客户端得到稳定 API 体验；不支持的能力明确失败。

修改：

- 新增 `apps/gateway/src/adapters/{messages,chat,responses}.ts`（或 `protocol/`）。
- `proxy.ts`、`convert.ts`、`http.ts`、`routes.ts`、`usage.ts`。

步骤：

1. 统一内部表示为 Anthropic Messages；Messages/Chat/Responses 输入输出转换。
2. 参数校验 → 映射 → 决策：
   - strict：会改变结果且无法保证 → 400 `unsupported_parameter`，含
     `{parameter,path,reason}`。
   - `temperature/top_p/top_k` strict 拒绝（无可靠 CC 映射）；
     `max_tokens`/stop/thinking/effort 支持；`n=1` 接受，`n>1` 拒绝；
     `logprobs`、`seed`、非零 penalties、`service_tier`、`parallel_tool_calls` 等 strict 拒绝。
   - `tool_choice=any/tool` 若仅提示词约束 → strict 拒绝；`auto/none` 按实测。
   - `response_format`/Responses `text.format`：G8 `--json-schema` 通过则支持，
     否则 400；不得用提示冒充保证。
3. Responses 第一档：
   - 自包含 `input`/`instructions`、文本/图片/文件、function tools、
     function_call_output、流式/非流式、usage、标准 events、错误映射。
   - 未实现：`previous_response_id`、后台任务、内置 OpenAI tools、container/files handle、
     store 语义 → 400；若后续支持 `previous_response_id`，
     建立 API Key 范围内 response→conversation/native revision 映射，不能猜。
4. `count_tokens`：media-aware 估算，标注“估算”；图片不按 base64 字符数。
5. usage：native 内部工具循环实际消耗进平台全量账；客户账按基线；
   不因过滤内部事件漏计；ID 稳定、request_id 可关联。
6. 错误映射：各协议方言；4xx/429/5xx/平台错误；不静默吞字段。

测试：

- golden request/response/stream（Anthropic/Chat/Responses），strict/warn 两模式；
  tool pairing、parallel、empty blocks、max_tokens、stop、thinking、JSON schema、
  图片/PDF、长上下文；usage/billing。
- 退出条件：strict 不支持参数 100% 明确拒绝；Responses 第一档通过；
  无静默字段丢失。

### WP5：响应头、Retry-After、early 200、raw relay

**目标**：API 客户端拿到真实 API 头；CC 客户端不暴露网关；raw 真正原样。

修改：

- `apps/gateway/src/http.ts`、`proxy.ts`、`upstream.ts`、`tunnel.ts`、
  `provider-node/http-egress.ts`。

步骤：

1. allowlist 转发 `request-id`、`anthropic-ratelimit-*`、`retry-after` 等；
   CORS expose；不转发 hop-by-hop/Set-Cookie/内部身份。
2. 平台 429/503 统一 `Retry-After`；错误体保持方言。
3. CC 响应 profile：清理网关前缀/平台诊断头（CPA 思路）；
   `x-1day-mode`/`ignored-params` 默认只给 API 客户端。
4. `responseMode=strict` 禁用提前 200/空白填充；`keepalive` 保留折衷并明确
   200+error 风险；两者互斥，不能宣称 keepalive 后还能补真实头。
5. probe：只显式 `x-1day-probe:1`；自动接管 `autoProbeIntercept=false`；
   reset 用真实错误/头，不合成 assistant 文本。
6. raw passthrough：spec `preserveHeaders:true` + `raw-v1` capability；
   节点跳过 fingerprint；旧节点不假定支持。
7. direct 路径转发上游头；worker 路径生成平台 request-id/限流头；
   不伪造 Anthropic 头。

测试：

- 头矩阵、429/503 Retry-After、early 200 strict/keepalive、raw 头不变量、
  CC 客户端不出现平台头。
- 退出条件：API 客户端头符合契约；CC 客户端无网关泄露；raw mutation=0。

### WP6：遥测真实性与 G10

**目标**：证明 canonical worker 原生遥测被真实上游接受；不伪造。

步骤：

1. **明确拓扑**：raw direct 不能控制客户遥测；只有 canonical worker 可证。
2. worker telemetry 契约：官方 CC 自己产生/发送；网关不构造/补发/改写；
   保留 bootstrap/eval/mcp-registry/event_logging；仅关 Sentry/autoupdater。
3. 每账号固定 `.claude.json`/device/account/OAuth/机器档/代理；
   native session 与 Messages/telemetry 一致；`# Environment`/cwd 经 mount namespace 对齐；
   无 platform path。
4. **G10 A 受控结构**：假 OAuth/本机假上游；覆盖首轮/多轮/resume/restricted/caller tool/异常；
   记录 endpoint/event 结构、device/account/machine/cwd/session/model/entrypoint/出口；
   resume 不重报整批历史；无秘密泄露。
5. **G10 B 真实接受**：专用测试账号/组织 + 固定代理 + 官方 CC 2.1.312；
   不借客户账号、不双写生产。
   - 证据方法：优先官方 CC 原生结果；若拿不到 HTTP 状态，
     使用测试节点/测试出口的 `SSLKEYLOGFILE`（若 Bun/CC 支持）或受控测试代理记录
     TLS 连接/HTTP 状态；**生产不得常驻 MITM**。
   - 若无法取得真实状态：保持 `unknown`，`native-required` 不开放；
     禁止用假上游 200 充数。
6. 证据按 account/profile/proxy 保存；版本/出口变化失效；
   `native-required` 无证据 → 503 `native_telemetry_unverified`。
7. 禁止：伪造/补发/重放遥测；跨账号事件；生产 MITM；把“未关闭遥测”当成功。

测试/验收：

- G10 A/B 证据文件；账号/profile/出口覆盖 100%；unknown 不算通过。
- 退出条件：native-required 只对证据覆盖的账号开放；raw direct 标 isolated。

### WP7：组织熔断、用量护栏、可观测性与发布

**目标**：避免再次出现单组织超量使用后被上游关闭。

步骤：

1. 新增 org 级 health/预算：
   - `upstream_teams` 增加 `status`/`suspended_reason`/`suspended_until`/
     `last_error_code`（或新表）。
   - 日 token/费用/工具调用/缓存读/并发预算；超限自动暂停新会话（不是杀在途）。
   - 识别 `oauth_not_allowed_for_organization`/`org_disabled_cc` → 立即 `suspended`，
     停止调度/重试，告警，人工复核；不得自动 reauth/重试。
2. worker/Key 级护栏：单会话 max turns、token、工具调用、cache read、超时；异常告警。
3. 指标：
   - `canonical_worker_open_total`
   - `native_resume_total`
   - `native_history_import_total`
   - `native_session_state`
   - `internal_tool_event_leaked_total`
   - `caller_tool_park_total`
   - `cc_profile_mismatch_total`
   - `custom_entrypoint_denied_total`
   - `cc_telemetry_evidence_total/unknown`
   - `unsupported_parameter_total`
   - `early_response_total`
   - `raw_passthrough_header_mutation_total`
   - `org_budget_exhausted_total`
4. 文档：architecture/gateway/compat/ccr-supply/worker-sessions/provider-protocol/
   team-isolation/client-notes/errors/operations；发布记录与设计方案分开。
5. 发布：备份 → build/test/e2e → 蓝绿 → 节点能力/证据 → 灰度 → release-verify。

---

## 6. P0 Gate 清单（实施前必须给结论）

| Gate | 问题 | 通过标准 | 失败时 |
|---|---|---|---|
| G1 | `--append-system-prompt[-file]` 在 `-p+stream-json+resume` 下保留 canonical system？ | 假上游看到 CC billing/identity/main prompt，客户 system 仅追加 | 用首个 user 的 caller_instructions；不得放 argv |
| G2 | stream-json 支持哪些 role/content？ | 官方进程接受并正确下一轮 | 不假设 assistant 注入；走 G3 |
| G3 | 外部历史导入为 2.1.312 可读 transcript？ | user/assistant/tool/thinking/signature matrix 通过 | canonical 只支持单轮/平台原生；外部历史 `history_import_unsupported` |
| G4 | 进程/节点重启后 resume？ | 上下文不丢、不重复 turn | 不启用 native 灰度 |
| G5 | 工具中断后原生 resume 补 tool_result？ | 不重复执行、不错误续写 | 409 `tool_continuation_lost` |
| G6 | `--restricted` 的工具集/文件权限？ | 文件限 cwd；OAuth/config/其他会话读取失败 | 只保留 tools-disabled，不宣称完整 restricted |
| G7 | Bash/网络隔离？ | 读凭据失败；直连/云 metadata/跨会话网络失败 | 不开放 Bash |
| G8 | `--json-schema` 请求/输出/失败语义？ | JSON Schema 可解析、校验失败明确、流式可适配 | `response_format` 返回 unsupported_parameter |
| G9 | direct/worker profile 证据？ | 分版本/entrypoint headers/body/beta/tools/system 证据 | 不做跨版本 pin |
| G10 | worker 原生遥测真实接受？raw direct 是否有同等证据？ | 结构/身份/出口/真实响应/泄露矩阵通过；unknown 不算 | 不开放 native-required；raw 只能 isolated |

---

## 7. 分阶段实施与灰度

| 阶段 | 内容 | 退出条件 |
|---|---|---|
| R0 | 冻结基线、清理未提交、G1/G2/G8/G9、G10 受控结构 | 证据齐；生产路由不变 |
| R1 | direct profile + 按 Key entrypoint + API adapter 独立修复（headers/strict/Responses 基础） | direct/API 合约测试通过；可独立发布 |
| R2 | canonical worker 单轮 + restricted + caller MCP + 内部工具过滤；单 Key/单账号/单节点 | 上游抓包正常 CC；内部工具 0 泄漏；API 合约通过 |
| R3 | native live 多轮 + G3/G4/G5 → resume/外部历史 | 断点恢复、工具续轮、计费幂等通过 |
| R4 | Responses 第一档、strict、raw-v1、全量迁移 | 存量 Key 显式迁移；legacy 新会话关闭 |
| R5 | 清理 legacy、文档/发布/回滚演练 | 完成定义 |

**灰度规则**：按 Key/账号/节点，不按单请求随机；conversation 启动时固定模式；
回滚新会话停止 canonical，旧 native 继续 drain/resume，不折回 legacy；
必须终止时 `session_migration_required`。

---

## 8. 测试与验收矩阵

- 单元：profile、gate/normalize、custom entrypoint、metadata order、attachments、
  parameter matrix、translator、native state、billing、org budget。
- 集成：真实 CC 受控 G1-G10；进程 kill/节点重启/蓝绿 resume；caller tool 续轮；
  Read/Bash/WebFetch 与 caller 混合；max_tokens/stop/thinking/signature/PDF/图片/
  长 system/长 tool result/JSON schema。
- API 合约：Messages/Chat/Responses 流式/非流式 golden；headers/Retry-After/usage/IDs/
  stop_reason/errors；strict 100% 拒绝；Responses 未支持字段 400。
- 安全：restricted 读 OAuth/其他会话/`/etc/hostname` 失败；Bash 直连/代理绕过失败；
  内部工具零泄漏；凭据/客户内容不进日志。
- 计费：resume/重试/工具续轮/max_tokens 不重复；平台全量 vs 客户基线；settlement journal。
- 运维：org circuit、预算、告警、备份/恢复、release-verify。
- 命令：`pnpm build`；`pnpm -r test`；`PROBE_INTERCEPT=0 pnpm test:e2e`
  （Bun 1.4.4 路径按当前环境）；真实平台 Key 的 Messages/Chat/Responses（已支持范围）；
  `ops/bin/release-verify`。

---

## 9. 风险、降级与开放问题

### 9.1 硬风险

1. **G10 证据不可得**：若无法在不 MITM 的情况下拿到真实遥测 HTTP 状态，
   `native-required` 永远不能开放。此时只能：
   - 继续 `passthrough-isolated`（无 telemetry 目标）；
   - 或接受 `unknown`，不宣称目标达成。
2. **G3/G4 失败**：canonical 只能单轮/平台原生，外部历史/重启恢复受限；
   必须明确错误，不能折叠。
3. **G6/G7 失败**：只能 tools-disabled 或 restricted 文件工具；Bash 永久关闭。
4. **native session 绑定降低可用性**：同账号/节点不可用时只能等待/明确失败，
   不能跨节点/组织；需要容量/队列/告警。
5. **组织级封号/用量**：必须 org 熔断/预算；否则 canonical worker 可能加剧单组织集中用量。
6. **合规**：订阅转售/共享条款风险独立存在；技术方案不能消除。

### 9.2 降级策略

- telemetry 证据缺失 → `native_telemetry_unverified`；不自动降级 raw。
- native resume 失败 → `session_expired`/`session_migration_required`；不折叠。
- restricted 不满足 → tools-disabled canonical；不宣称默认工具。
- Responses 高级字段 → 400；不静默。
- early 200 → strict 模式禁用；keepalive 仅显式。
- org 级错误 → 暂停 org，不重试/不 reauth。

---

## 10. 完成定义

只有全部成立才可以宣称完成：

- direct 与 worker 都是真实官方 CC profile；无版本混拼、无 CC 主身份替换；
  raw direct 只作为 `passthrough-isolated` 例外。
- `native-required` 的账号/profile/出口都有 G10 真实接受证据；
  unknown 不接流量、不伪造。
- 普通 API 的常用 Messages/Chat/Responses 可用；未支持能力明确 400。
- canonical 正常路径无折叠历史；native session 可恢复/明确失败；不静默降级。
- caller tools 完整；CC 内置工具零泄漏；restricted 安全测试通过；
  Bash 未通过则关闭。
- 同账号设备/机器/组织隔离/pinned egress/计费幂等/org 熔断无回归。
- build/test/e2e、真实请求、蓝绿 release-verify、文档与线上一致。

---

## 11. 建议的下一步（按顺序）

1. **先做 R0 + G1/G2/G8/G9 + G10 证据方法 PoC**，特别是确认
   `SSLKEYLOGFILE`/测试出口能否在不变更 TLS 的情况下取得遥测状态；
   如果不行，先拍板 telemetry 目标是否降级。
2. **并行 WP1（direct/API 独立修复）与 WP2（canonical worker restricted）**；
   WP1 可先发布，不依赖 native session。
3. **WP2 单节点/单 Key 灰度**，上游抓包验证 system/tools/history/environment；
   下游 API 合约测试。
4. **WP3 native resume/外部历史**；G3/G4/G5 未过不扩量。
5. **WP4/WP5 Responses/strict/raw/headers**；最后迁移存量 Key，关闭 legacy 新会话。
6. **WP7 org 熔断/预算/告警**必须在任何扩大 canonical 流量之前上线，
   避免重演单组织超量使用后被上游关闭。

> 本方案的关键不是“把 prompt 伪装得更像”，而是：
> **canonical worker 用真实 CC 身份和原生 session/遥测；direct 只做明确的 profile 归一；
> API 适配层负责契约，不污染上游身份。** 三者边界一旦混用，就会回到当前
> “真 CC 被包装成 API assistant/折叠历史”的问题。
