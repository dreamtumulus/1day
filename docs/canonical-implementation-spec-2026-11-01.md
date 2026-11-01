# Canonical Claude Code 执行与多协议 API —— 技术实施文档（v2，2026-11-01）

> 性质：**实施规范**。合并了《任务书》（`canonical-cc-worker-api-plan-2026-11-01.md`）、另一 agent 的《实施方案 v1》（服务器同名 `-implementation-plan-`）、本会话《可实施方案》与《合并决议》，并落入用户 2026-11-01 的全部决策。与前述文档冲突时以本文为准。
> 基线：仓库 `de6d0e6`（服务器同）。所有行号/函数名按实施时 HEAD 重新核对。
> 约束：`docs/iron-rules.md`（铁律 1 代理冻结、铁律 2 灰度）。本文每一个"上游可见"改动都标注了开关名。

---

## 0. 术语

| 术语 | 含义 |
|---|---|
| 车道 A / raw direct | 真 Claude Code 客户的请求体经网关做同版本归一后直连 Anthropic（账号侧无遥测） |
| 车道 B / canonical worker | 节点上官方 Claude Code 二进制以账号 OAuth 运行 `-p`，承载 Messages 与原生遥测 |
| profile | 一个 CC 版本 × 入口（cli / sdk-cli / restricted）的完整请求形态证据 |
| 判断器 | 按 Key 的观测自动决定其策略（车道、参数策略、响应模式、历史策略）的组件，管理员可覆盖 |
| 证据等级 | `real` / `secondary(structural+health)` / `unknown`，决定 `native-required` 能否开放 |
| 灰度组 | settings `canary_group_id` 指向的账号组（现网 `canary-1cf43ccb`），三态开关 `canary` 档只对它生效 |

---

## 1. 目标与硬指标

| 目标 | 定义 | 上线硬指标 |
|---|---|---|
| **G-A 上游归一（含遥测）** | 每个订阅账号在 Anthropic 侧看到的是：一台固定机器、一个固定设备、同一版本的官方二进制产生的 Messages + bootstrap/eval/event_logging 遥测，共享身份、session、机器档、固定出口 | 非官方二进制产生的 Messages 占比 → 0（例外 = 管理员 override 的 `passthrough-isolated` Key，可数）；`native-required` 账号证据覆盖 100%（`real` 或 `secondary`）；上游 `429 rate_limit_error "Error"` = 0；上游可见内容含 `1dayapi`/平台路径 = 0 |
| **G-B 用户端体验** | 真 CC 客户：结构校验 → 同版本 profile 归一 → 再校验，不确定不碰；API 客户：Messages/Chat/Responses，不支持即明确拒绝；响应头/错误/限流/ID 同构 | strict 模式静默忽略字段 = 0；直连误判可审计；Responses 第一档可用；`x-1day-mode` 对 API 客户可见 |

---

## 2. 不变量（实现必须断言，测试必须覆盖）

- **I1 原生身份**：canonical 不用 `--system-prompt*` 替换主提示词；无"不是 CC / 没有工具 / 不要自称"类指令。
- **I2 无平台泄露**：上游提示词、Environment、遥测、工具事件中不出现 `1dayapi`、真实 scratch 路径、网关细节。
- **I3 无折叠历史**：canonical 不调用 `messagesToPrompt()` / `workerSystemPrompt()`。
- **I4 工具边界**：下游只见 caller tools；CC 内置工具事件不下发。
- **I5 凭据隔离**：客户提示词驱动的工具读不到 OAuth、节点秘密、其他账号/组织/会话；不绕过 pinned proxy。
- **I6 会话线性**：一个 conversation generation 同时只有一个可写 native revision。
- **I7 计费幂等**：resume/重试/工具续轮/截断不重复扣费。
- **I8 不跨组织**：native transcript 不跨节点、不跨组织。
- **I9 不混模**：进行中的 native 会话不切回折叠；回滚只停新会话。
- **I10 无遥测伪证**：没有真实接受证据只能 `unknown`/`secondary`，不得标 `real`。
- **I11 出站后缀不变量**（11-01 事故）：直连所有改体在前，`alignBillingSuffix` 最后；出站 `system[0]` 后缀 ≡ `ccBuildSuffix(出站 messages, 版本)`；不会算后缀的版本不碰首条用户文本；最后一道运行时闸。
- **I12 请求级拒绝不扩散**：上游 `429 {"type":"rate_limit_error","message":"Error"}` 归请求级，不换号、不重试。
- **I13 铁律 2**：任何上游可见改动 = 三态开关 + 默认老行为 + 灰度组 ≥24h + 一天一轮 + 快照可回滚。

---

## 3. 现状差距（de6d0e6）

| 维度 | 现状 | 差距 |
|---|---|---|
| 车道 A | 真 CC 直连；`direct_cc_version_pin=2.1.312`（跨版本混体）；设备/机器/入口归一；后缀最后重算已落地；改体开关默认关 | 自定义入口全局开关而非 Key 白名单；未知版本放行宽松；客户 CC 遥测永远到不了账号；2.1.312 二进制已含 `cch=` 签名字段（远端 flag 未开），一开则任何改体失效 |
| 车道 B | 真实 CC 2.1.312，但 `--system-prompt-file` 替换主提示词、`--tools ""`、`--no-session-persistence`、历史折叠 | 上游看到"API assistant"；无原生历史/resume；遥测开着但无接受证据 |
| API 体验 | 直连高保真；worker 兼容但静默忽略参数（`x-1day-ignored-params` 提示）；Responses 不可用；无上游头 | strict 契约、Responses 第一档、refusal 语义、keepalive/strict |
| 策略 | Key policy 手配（historyPolicy/directOnly/probeIntercept/teamAffinity） | 无判断器、无 auto/override 两层 |
| 号池 | 单组织 29 号已停；多小组织能力（容量选组织、认领释放、组织页）已上线 | 新号池待重建；灰度组空 |

---

## 4. 参考项目取用（设计与测试向量；LGPLv3 / AGPLv3 代码不复制进闭源仓库）

| 项目 | 取 | 不取 |
|---|---|---|
| CPA（MIT）`/home/ubuntu/cliproxyapi` | 按凭证选 fingerprint profile（`claude_fingerprint_policy.go`）；稳定 device/account/session 键；响应头清理清单（`internal/misc/header_utils.go`）；计费后缀算法交叉验证（`claude_executor_cloaking.go: computeFingerprint`）；`cch` 签名与 `cc_prev_req/cc_prompt_id/cc_turn_origin`（`claude_signing.go`）作为"真实二进制才能跟"的证据；mid-conversation system 作为 G1 备选 | 网关整体 cloaking（无真实进程、无遥测）；随机 user_id |
| sub2api（LGPLv3）`/home/ubuntu/sub2api-source` | 三层自洽方法论；FromClient 陷阱；`gateway_environment_block.go` 只 rewrite 已有字段；`claude_code_validator.go` 的 system 相似度做 gate 补充；`apicompat/{responses_to_anthropic_request,anthropic_to_responses,responses_to_anthropic}.go` 的双向映射与流状态机作为 WP4 参考；缺省补齐只对非 CC；`NormalizeDateline` | `/api/event_logging/batch` 返 200 吞遥测；内容审核；跨版本伪装 |
| new-api（AGPLv3）`/tmp/new-api` | 适配器分层（`relay/channel/claude/adaptor.go`）；`stop_reason=refusal` 显式处理（`relay-claude.go`）；参数/转换错误返明确 4xx（`param_override_error.go`、`convert_request_error.go`）；Responses over Claude（`relay_responses.go`）golden 向量 | 多厂商目录；换渠道重试默认 |

---

## 5. 目标架构与路由契约

```text
                      共享：认证 → 额度/模型准入 → 参数校验 → conversation identity → Key 生效策略(override ?? auto)
真 CC 客户端 ── 原始结构 gate（不改体）── Key.allowedCustomEntrypoints ──┬─ telemetryPolicy=native-required（默认）──▶ 车道 B
                                                                      └─ passthrough-isolated（管理员 override）──▶ 车道 A（同版本归一，I11）
API 客户端（Messages/Chat/Responses）── 适配层（strict/warn）──────────────────────────────────────────────────▶ 车道 B
车道 B：节点官方 CC -p · 原生 system · --restricted 工具 · caller MCP · 原生 session/resume · 原生遥测 · 合成 cwd
共享底座：账号固定设备/机器档/代理 · 组织隔离 · 双账本 · proxy_down 冻结 · 组织预算 · 三态开关/灰度组
```

**路由顺序（固定）**：① 认证/额度/参数 → ② conversation identity（既有会话的 mode/telemetryPolicy 优先）→ ③ CC 结构 gate（原始体）→ ④ Key 白名单入口 → ⑤ 生效 `telemetryPolicy` → ⑥ 车道 A 可用性（仅 passthrough-isolated）→ ⑦ 车道 B 节点能力（`canonicalProfiles` 含所需 profile、证据等级 ≥ secondary）→ ⑧ 非 CC 一律车道 B → ⑨ 无合格节点 503 `native_telemetry_unverified`。

---

## 6. 领域模型

### 6.1 `packages/core/src/cc-profile.ts`
```ts
interface CcProfile {
  profileId: string;                 // "cc-2.1.312-cli" | "cc-2.1.312-sdk-cli" | "cc-2.1.312-restricted"
  ccVersion: string; sdkVersion: string; runtimeVersion: string;
  entrypoint: "cli" | "sdk-cli" | "restricted";
  betaPolicy: { base: string[]; byModel: Record<string,string[]>; byFeature: Record<string,string> }; // 有序
  identityBlock: string; mainPromptDigest: string; toolsDigest: string;
  billingAlgo: "suffix-v1";          // salt+[4,7,20]+version；cch 签名未开
  minVersionByModel: Record<string,string>;
  evidence: { source: string; sampledAt: string; digest: string }[];
}
```
规则：禁止跨版本 pin（`direct_cc_version_pin` 默认空，迁移期后删除）；同版本只修 transport/device/machine/custom-entrypoint；未知版本 `requireKnownProfile=1` 不直连，observe 时原样直连记 `cc_profile_unknown`；worker 用节点真实二进制版本，`sdk-cli` 不改成 `cli`。

### 6.2 Key policy（复用 `api_keys.policy_json`，两层）
```json
{ "auto": { "workerMode": "canonical", "telemetryPolicy": "native-required", "parameterPolicy": "warn",
            "responseMode": "keepalive", "historyPolicy": "passthrough", "probeIntercept": false,
            "decidedAt": "…", "basis": "cc_genuine_ratio=0.98;protocol=messages;foreign_history=0.6" },
  "override": { "telemetryPolicy": "passthrough-isolated", "allowedCustomEntrypoints": ["mirasim"],
                "by": "<admin id>", "reason": "低延迟需求", "at": "…" },
  "teamAffinity": null }
```
生效值 = `override[k] ?? auto[k] ?? 系统默认`。`parseKeyPolicy` 兼容旧平铺格式（旧字段视为 override）。

**判断器 `packages/core/src/key-policy-auto.ts`**（用户决策 2026-11-01：默认自动，管理员可覆盖）：
- 输入：该 Key 近 N 次（≥50）请求的 gate 结果比例、UA 版本/入口、协议、外来历史比例、工具形态、流式比例、`ignored-params` 命中、Agent/SDK 形态、探针形态。
- 规则（首版）：

  | 观测 | workerMode | telemetryPolicy | parameterPolicy | responseMode | historyPolicy |
  |---|---|---|---|---|---|
  | ≥95% 真 CC 已知 profile | canonical | native-required | strict | strict | passthrough |
  | 真 CC + 自定义入口 | canonical | native-required（低延迟 → 管理员 override isolated + 白名单） | strict | strict | passthrough |
  | API 客户 | canonical | native-required | warn → 连续 7 天零命中自动 strict | 有 >75s 非流式长请求 → keepalive，否则 strict | 外来历史比例高 → passthrough，否则 reset |
  | 探针形态 | — | — | — | — | probeIntercept=true |
- 滞回：每日重算；新 Key 50 次请求后首评；观测稳定 ≥3 天才翻转；翻转写 `key_policy_events(id, api_key_id, field, old, new, basis, created_at)`（迁移只新增）；只影响新 conversation。
- 开关：`key_policy_auto`：`0`（只记录建议）/`canary`/`1`。首周 observe。
- 控制台：Key 页显示 auto 与 override 两层及依据，逐字段 override / 回到自动；分组批量 override。

### 6.3 native session 元数据（首批复用 `worker_turn_memory.data`，版本化 JSON；或新增 `native_sessions` 表）
`schemaVersion, mode, profileId, accountId, teamId, nodeId, nativeSessionId, revision, expectedTurn, state(READY|RUNNING|COMMITTED|AWAITING_CALLER|DIRTY|LOST), clientHistoryHash, assistantResponseHash, configGeneration, syntheticCwd, usageBaseline, pendingCallerCalls, checkpointId, expiresAt`。transcript 不进 SQLite/日志；TTL 24h（设置 `native_transcript_ttl_hours`）；过期 `session_expired`。绑定 `accountId+nodeId+configGeneration+profileId+syntheticCwd`。

### 6.4 `telemetry_evidence`（新表，迁移只新增）
`id, account_id, profile_id, node_id, proxy_id, native_session_id, cc_version, endpoint, status, source('real'|'secondary'|'controlled'), observed_at, digest, expires_at, note`。
三档（用户决策 2026-11-01，允许次级证据）：
- `real`：G10-B 真实上游 2xx（测试出口 `SSLKEYLOGFILE`/受控测试代理/CC 原生结果）。
- `secondary`：G10-A 结构通过 + 该账号 canonical 下连续 `telemetry_health_days`（默认 7）天健康（无 429 "Error"、无组织级错误、profile/roles/窗口正常）+ 账号/profile/出口未变；变化即失效重计；可用 real 升级。
- `unknown`：不接新会话。
证据只覆盖所测账号；不外推。

### 6.5 节点协议（`apps/provider-node/src/protocol.ts`，全部 capability gate）
- `CcWorkerOpen` 新增：`mode:"canonical"`, `profileId`, `appendSystemPromptFile?`/`callerInstructions?`, `nativeSession{id, action:"start|resume|fork", revision, checkpointId?}`, `builtInToolProfile:"restricted-default|tools-disabled-canonical"`, `jsonSchema?`。legacy 字段仅 `mode:"legacy"`。
- 节点→平台 `cc_worker.state{nativeSessionId, revision, state, checkpointId, reasonCode}`；`cc_worker.close/commit` 带 revision 幂等。
- heartbeat：`ccWorker.canonicalProfiles[]`, `historyImport`, `restrictedTools`, `telemetryEvidence{covered, expiresAt, source}`, `nativeSessions`, `resumeFailures`, `diskUsage`。
- HTTP egress spec：`preserveHeaders:true` + capability `raw-v1`。
- `teams.retire`（已实现）。

---

## 7. P0 实证门（R1 第一周；受控探针 `tests/e2e/cc-probe/`：真实 2.1.312 二进制 `/home/ubuntu/claude-code-re/2.1.312/package/claude`、临时 HOME/CLAUDE_CONFIG_DIR、假 OAuth、本机假上游记录 header+body；证据写 `docs/evidence/cc-2.1.312/<gate>.json`）

| Gate | 问题 | 已知事实（二进制/文档） | 通过标准 | 失败处置 |
|---|---|---|---|---|
| G1 append | `--append-system-prompt-file` 是否保留 canonical system/tools；resume 后不重复 | 参数存在（帮助文本） | 假上游见 billing+identity+main prompt，客户 system 只在追加位 | 改用首个 user 的 caller-instructions 块或 mid-conversation system（CPA 法）；不放 argv |
| G2 stream-json | stdin 接受的 role/content | `--input-format stream-json`、`--replay-user-messages` 存在；现网已用 | 官方进程接受并正确下一轮 | 不假设 assistant 注入；历史走 G3 |
| G3 外部历史导入 | 新会话可被 `--resume` 读取的 transcript | 节点 `cc-accounts/<id>/projects/` 有真实样本 | user/assistant/tool_use/tool_result/thinking+signature 全 matrix | canonical 对外部多轮历史 `history_import_unsupported`；Key 留 legacy 或 historyPolicy=reset |
| G4 resume | 进程/节点重启后 `--resume` | 参数存在 | 不丢不重 | 不启用 native 灰度 |
| G5 工具中断 | awaiting caller tool 时进程死 | — | 原生 resume 补 tool_result，不重复执行 | 409 `tool_continuation_lost` |
| G6 restricted | 工具集与文件边界 | "Reads outside the working directories are blocked"、"--restricted: path outside the working directory" | 文件限 cwd；读 OAuth/config/其他会话失败 | 只用 tools-disabled-canonical |
| G7 Bash | 隔离 | — | 读凭据/直连/metadata/跨会话均失败 | 本期不开放 |
| G8 schema | `--json-schema` | 参数存在 | 可解析、失败明确、流式可适配 | `response_format` → `unsupported_parameter` |
| G9 profile | cli/sdk-cli/restricted 三 profile ≥12 次采样 | `claude-code-compat.md §5/§11`；二进制含 `mid-conversation-system-2026-04-07`/`effort-2025-11-24`/`prompt-caching-scope-2026-01-05`/`advisor-tool-2026-03-01`/`redact-thinking-2026-02-12` 等（远端 flag 控制）；`cch=` 字段存在但当前抓包未出现 | beta 集/顺序、tools、system、`cc_*` 字段按 profile 存证 | 不做跨版本 pin |
| G10 telemetry | 原生遥测结构（A）与真实接受（B） | `INGEST_URL` 硬编码 `https://api.anthropic.com/api/event_logging/v2/batch`，不跟 BASE_URL | A：结构/身份/出口/无泄露；B：真实 2xx 或次级证据（§6.4） | `unknown` 不开放 |

---

## 8. 工作包

### WP0 基线与探针（无生产影响）
- `tests/e2e/cc-probe/`：`probe.mjs`（启动真实 CC、注入假 OAuth、指向假上游）、`mock-upstream-capture.mjs`（扩展 `apps/gateway/scripts/mock-upstream.mjs` 记录 headers+body+telemetry 端点）、`evidence.mjs`（脱敏、digest、写 JSON）。
- 产出 G1/G2/G6/G8/G9 结论；G10-A；G10-B 取证 PoC（`SSLKEYLOGFILE` 在 Bun 下可用性）。
- 退出：证据文件齐；生产不变。

### WP1 车道 A：profile、Key 白名单入口、再校验、零改体方向
改动：`packages/core/src/{cc-profile(新),cc-shape,fingerprint,settings,key-policy}.ts`、`apps/gateway/src/{upstream,proxy}.ts`、测试。
1. `classifyCcRequest(headers, body, { allowedCustomEntrypoints, requireKnownProfile })`：原始体校验；自定义入口只在 Key 白名单内放行；UA 与 billing entrypoint 必须一致。
2. 归一化只做 transport/device/machine/entrypoint；归一化后再 `classifyCcRequest` + profile 断言；不 genuine → 400 `cc_profile_mismatch`，记 `cc_profile_mismatch_total`。
3. `direct_cc_version_pin` 默认空；已知 profile 表来自 G9；未知版本按 `direct_require_known_profile`。
4. body 改体（`direct_strip_user_email`、`direct_cc_canonical_fields`）：G9 确认真 CC 用平台 Key 登录时不带 `# userEmail` 后**删除**该开关与代码；`metadata.user_id` 键序对真 CC 本就 canonical，开关也删除。目标：车道 A 对 body **零改写**（为 `cch` 开启预留）。保留 I11 闸。
5. `direct_cc_entrypoint_normalize` 三态总闸只作迁移期；Key 白名单落地后删除。
6. 车道 A 对 CC 客户端的下游响应 profile：不下发 `x-1day-*` 诊断头；清理可识别网关的头（CPA 清单 + 抓包验证）。开关 `cc_client_response_profile`（0/canary/1）。
测试：分类→白名单→normalize→build→再 gate（mirasim 2.1.316/2.1.314/2.1.312 真实形态、短提示+同块 reminder）；后缀不变量矩阵（已有 336 组合）扩到新 profile。
退出：灰度 Key ≥24h `cc_profile_mismatch_total=0`、无 `429 "Error"`。

### WP2 车道 B：canonical 进程、工具边界、合成 cwd、遥测开启
改动：`apps/provider-node/src/{cc-worker,machine-runtime,mcp-server,protocol,bridge}.ts`、`apps/gateway/src/ccr/{worker,translate,session-memory}.ts`。
1. canonical open（§6.5）；启动参数：`-p --model <m> --output-format stream-json --input-format stream-json --verbose --include-partial-messages --session-id <uuid> --system-prompt-snapshot on --restricted --permission-prompts none --strict-mcp-config --mcp-config <f> --allowedTools mcp__caller [--append-system-prompt-file <f>] [--json-schema <f>]`；移除 `--tools ""`、`--system-prompt-file`、`--no-session-persistence`。
2. 删除 `workerSystemPrompt()` 文本；客户 system 只追加（G1 结果决定 file / caller-instructions / mid-conversation）。
3. 合成 cwd：mount namespace 内 bind 真实 scratch → `accountMachine.workingDir`，chdir；`# Environment`/进程 cwd/遥测三者一致；自检失败拒绝 canonical。
4. 内置工具：`--restricted` 默认集 + caller MCP（回环、每会话随机令牌）；Bash 不开放。
5. `SessionTranslator` typed 事件分类：`mcp__caller__*` → 客户 tool_use 停泊；内置工具事件只消费不下发；索引重映射；内置工具循环不提前 `stop_reason:tool_use`；`internal_tool_event_leaked_total=0`。
6. 遥测：不设 `DISABLE_TELEMETRY`/`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`；`CLAUDE_CODE_DISABLE_ATTACHMENTS` 按 G9 采样决定；Sentry/autoupdater 维持关闭。
7. 节点心跳能力声明；旧节点不接 canonical。
开关：节点 env `CC_WORKER_CANONICAL=1` 且 Key 生效 `workerMode=canonical`。
退出：上游 system = 官方 + 追加块；无 API assistant/平台路径；内置工具零泄露；restricted 越界读全败。
回滚：新会话停发 canonical；旧会话 drain（I9）。

### WP3 原生会话、恢复、外部历史
改动：`apps/gateway/src/ccr/{worker,session-memory,native-session(新)}.ts`、`packages/core/src/{conversations,migrations}.ts`、节点 `cc-worker.ts`。
1. fresh：revision + native session UUID；以 CC `system/init`/`result` 的 session_id 为权威。
2. live 进程优先 stream-json 续轮；回收后 `--resume`（五元组全匹配）；fork 仅显式分支。
3. 状态机与 DIRTY/LOST 处置（§6.3）；`AWAITING_CALLER` 仅 G5 通过才允许回收。
4. 外部历史：G2 优先；G3 importer 只建新会话；不通过 → `history_import_unsupported`。
5. 幂等：revision 单调；迟到帧拒绝；usage 增量按 baseline；request_id/journal 不重复。
退出：kill/重启/蓝绿后 ≥3 轮普通 + 1 轮 caller tool 无重复 turn/扣费。

### WP4 下游 API 适配与 strict 契约
改动：`apps/gateway/src/adapters/{messages,chat,responses}.ts`（新）、`convert.ts`、`proxy.ts`、`routes.ts`、`usage.ts`。
1. 内部表示 = Anthropic Messages；三协议转换做"校验→映射→决策"。
2. strict：`unsupported_parameter{parameter,path,reason}` 拒绝 `n>1`、`logprobs`、`seed`、非零 penalties、`service_tier`、`parallel_tool_calls`、`temperature/top_p/top_k`（worker 无可靠映射）、强制 `tool_choice`（仅提示词约束）、`response_format`（G8 通过前）；`n=1` 等无语义默认值接受。warn = 现有 `x-1day-ignored-params`。
3. Responses 第一档：自包含 `input`/`instructions`、文本/图片/文件、function tools、`function_call_output`、流式/非流式、标准 id/usage/events；未实现字段（`previous_response_id`、后台任务、内置 OpenAI 工具、container/files、store）→ 400。参考 sub2api `apicompat`（重写，不复制）。
4. `count_tokens` 标估算（响应头 `x-1day-estimated: 1`）。
5. refusal：直连原样透传；worker CLI 文本 refusal 保持 400 `safeguards_refusal`（文档标非标准）；用量行记原因（new-api 法）。
退出：三协议 golden 全绿；strict 零静默。

### WP5 响应头、错误、保活、raw relay
改动：`apps/gateway/src/{http,proxy,upstream,tunnel}.ts`、`provider-node/src/http-egress.ts`。
1. allowlist 转发 `request-id`（网关自己的）、`retry-after`；**不转 `anthropic-ratelimit-*`**（泄露号池状态）。
2. `responseMode=strict`：不提前 200、不填空白；`keepalive` 保留并文档化"200 后只能流内报错"。
3. probe：只显式头；`autoProbeIntercept` 默认关（已做）；reset 不合成 assistant 文本。
4. raw passthrough：`preserveHeaders:true` + `raw-v1` capability；节点跳过指纹注入。
5. 错误作用域：上游 `429 "Error"` → 请求级 `upstream_request_rejected`，不换号（I12）。
退出：`raw_passthrough_header_mutation_total=0`；strict 下真实 4xx/5xx 原样。

### WP6 遥测证据与 G10
1. 契约：官方 CC 自己发遥测；网关不构造/补发/改写；保留 bootstrap/eval/mcp-registry/event_logging。
2. `telemetry_evidence` 三档（§6.4）；心跳上报元数据；`native-required` 开放条件 = `real` 或 `secondary`。
3. G10-A 受控结构；G10-B 真实接受（专用测试账号、固定代理、不 MITM、`SSLKEYLOGFILE`/受控测试代理）；版本/profile/出口变化失效。
4. 禁止：伪造/重放/跨账号事件/生产 MITM/全局关遥测充数。

### WP7 组织预算与护栏（事前，不是事后熔断）
1. `upstream_teams` 增 `daily_token_budget`、`daily_cost_budget`、`max_concurrency`、`suspended_reason`、`suspended_until`、`last_error_code`（迁移只新增）；超限暂停**新会话**，不杀在途。
2. 识别组织级错误文本（`organization has disabled`、`suspended for this organization`、`oauth_not_allowed_for_organization`）→ 停止调度 + 告警，不重试不 reauth（不宣称能救号）。
3. 单会话护栏：max turns/token/工具调用/超时。
4. 指标：`canonical_worker_open_total{profile,result}`、`native_resume_total`、`native_history_import_total`、`native_session_state`、`internal_tool_event_leaked_total`、`caller_tool_park_total`、`cc_profile_mismatch_total`、`custom_entrypoint_denied_total`、`cc_telemetry_evidence_total{source}`、`native_telemetry_unverified_total`、`unsupported_parameter_total`、`early_response_total`、`raw_passthrough_header_mutation_total`、`org_budget_exhausted_total`、`key_policy_auto_flip_total`。

### WP8 判断器与迁移
1. `key-policy-auto.ts` + `key_policy_events`；observe 一周 → canary → 1。
2. Key 页两层显示；分组批量 override；灰度组默认 override `canonical+native-required`。
3. 存量 Key：判断器给出 auto；管理员确认后生效；mirasim 等低延迟诉求由 override 处理；legacy 新会话入口在 R4 后关闭，观察 2 周删代码。

---

## 9. 实施顺序

| 阶段 | 内容 | 退出条件 | 预估 |
|---|---|---|---|
| R0 | 基线固化（已完成）；号池多小组织重建；灰度组 1～2 号 + 测试 Key + 专用遥测测试账号 | 资源到位 | 用户侧 |
| R1 | WP0 探针（G1/G2/G6/G8/G9/G10-A、G10-B PoC）；WP1 车道 A；WP5；WP8 判断器 observe | 证据文件齐；灰度 Key ≥24h 无 mismatch/无 429 "Error"；判断器建议与人工一致 | 2 周 |
| R2 | WP2 canonical 单轮 + live 多轮；WP6 证据表与心跳；WP7 预算；单 Key/单账号/单节点 | 真实或次级证据；内置工具零泄露；一个观察周期 | 2～3 周 |
| R3 | WP3 native resume / 外部历史（G3/G4/G5） | 恢复无重复；计费幂等 | 2 周 |
| R4 | WP4 Responses 第一档 + strict；raw-v1；判断器 `1`；存量迁移 | golden 全绿；strict 零静默；例外可数 | 2 周 |
| R5 | legacy 关闭、观察 2 周、删代码、文档收口 | 完成定义全部成立 | 2 周 |

每阶段：一天最多一轮发布；每轮 `pre-<name>-<ts>-dist.tgz` + DB 快照；上游可见改动先 `canary` ≥24h。

---

## 10. 测试与验收

- 单元/集成：profile 一致性与禁混版本；入口白名单链路；后缀不变量矩阵；canonical prompt 无 API-assistant/平台路径；translator 零泄露；native 状态机（revision 冲突、重复 open/commit、迟到 close、DIRTY/LOST/TTL）；strict/warn 参数矩阵；三协议 golden；判断器规则与滞回；证据等级计算；组织预算。
- 真实 CC 受控：G1–G10 版本化结论；kill/重启/蓝绿 resume；并发同 conversation；restricted 越界与网络绕过；大图/PDF/长 system/长工具结果/max_tokens/stop/thinking signature/JSON Schema。
- 项目标准：`pnpm build` → `PATH=/home/ubuntu/claude-code-re/bun-runtimes/1.4.4/package/bin:$PATH pnpm -r test` → `PROBE_INTERCEPT=0 … pnpm test:e2e` → 真实 Key 三协议/工具轮/resume/`cc_dual_mode` → `ops/bin/release-verify`（灰度 Key 优先）。
- 上线硬指标：§1 + legacy 构造/折叠/平台路径命中 = 0；内置工具泄露 = 0；native resume 无重复；证据覆盖 100%；strict 零静默；无 OOM/失控进程；p50/p95、错误率、RSS/磁盘有基线。

---

## 11. 灰度、发布、回滚

- 灰度按 Key/账号/节点，不按请求随机；conversation 启动时固定模式。
- 回滚：新会话停发 canonical，旧 native 会话 drain/resume，不折回 legacy；必须终止 → `session_migration_required`；`native-required` 证据失效 → 停新会话，不自动走 direct；direct profile / raw / Responses / strict / 判断器均可独立开关回滚；迁移只新增。
- 回滚后核对在途请求、pending caller tools、未结算 usage、节点进程/磁盘。

---

## 12. 风险与降级

| 风险 | 降级 |
|---|---|
| G10-B 真实状态不可得 | 用 `secondary` 证据开放（用户决策）；账号页明示；一旦 real 方法可用自动升级 |
| G3/G4 失败 | canonical 只支持单轮/平台原生；外部历史明确错误 |
| G6/G7 失败 | tools-disabled-canonical；Bash 永久关闭 |
| native 绑定降低可用性 | 等待/明确失败，不跨节点/组织；容量与队列告警 |
| `cch` 远端开启 | 车道 A 零改体即不受影响；车道 B 真实二进制自然跟随；若仍有改体开关，立即置 0 |
| 单组织集中用量 | WP7 预算 + 多小组织 + `teamAffinity` |
| CC 版本升级 | 新 profile + G1–G10 重跑 + 节点二进制同步（SOP 进 `claude-code-compat.md §9`） |

---

## 13. 完成定义

- 车道 A/B 都是真实官方 CC profile，无版本混拼、无主身份替换；车道 A 只以管理员 override 的 `passthrough-isolated` 存在且可数。
- `native-required` 账号证据覆盖 100%（real/secondary 明示），`unknown` 不接流量。
- 三协议常用契约可用，未支持能力明确 400。
- canonical 无折叠历史；会话可恢复或明确失败。
- caller tools 完整；内置工具零泄露；restricted 安全测试通过。
- 设备/机器一致、组织隔离、pinned egress、计费幂等、组织预算无回归。
- 判断器 auto 生效，管理员 override 可审计。
- build/test/e2e、真实请求、蓝绿 release-verify、文档与线上一致。

---

## 14. 用户决策记录与默认值

| 事项 | 决定 |
|---|---|
| 遥测次级证据 | 允许（结构 + 连续 7 天健康），标 `secondary` |
| 车道/策略选择 | 判断器自动，管理员可覆盖，默认自动 |
| mirasim 等自定义入口真 CC | 默认自动 → canonical；低延迟由管理员 override |
| transcript TTL | 24h |
| legacy 关闭 | R4 后观察 2 周删除 |
| Bash | 本期不开放 |
| `anthropic-ratelimit-*` | 不转发 |
| 默认 historyPolicy | 设置项 `history_policy_default`（现 reset）+ 灰度值；判断器可按观测给 passthrough |

## 15. 需用户协助

- 新号池重建后：第一组织 1～2 号进灰度组；1 个专用遥测测试账号；一把灰度测试 Key 放到 `/root/monitor/canary-apikey.txt`。
- worker-02 / mirasim 节点的登录方式（发 bundle）。
- 发布窗口：一天一轮。

## 16. 交付物与文档更新
代码：`packages/core/src/{cc-profile,key-policy,key-policy-auto,canary,telemetry-evidence}.ts`、`apps/gateway/src/{upstream,proxy,http,tunnel,convert,adapters/*,ccr/*}`、`apps/provider-node/src/{cc-worker,machine-runtime,protocol,bridge,http-egress}.ts`、`apps/console/src/{node/registry,routes/admin,routes/user,node/teams}.ts`、web Key/账号/节点/组织/设置页。
证据：`docs/evidence/cc-2.1.312/*.json`。
文档：`architecture.md`、`gateway.md`、`claude-code-compat.md`、`ccr-supply.md`、`worker-sessions.md`、`provider-protocol.md`、`team-isolation.md`、`client-notes`、`errors.md`、`operations.md`、`iron-rules.md`；每轮 `docs/deployment/<date>-*.md`。
