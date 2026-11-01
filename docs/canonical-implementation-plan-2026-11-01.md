# Canonical Claude Code 归一化 · 可实施方案（2026-11-01，版本冻结期编写）

> 基线：本地/服务器 `de6d0e6`（第四轮已发布：三态开关、灰度组、计费后缀最后重算）。**本文只是方案，代码冻结，未改任何实现。**
> 上游任务书：`docs/canonical-cc-worker-api-plan-2026-11-01.md`（下称《任务书》）。本文回答"怎么落地、先后、改哪些文件、怎么验收、怎么回滚"，并吸收 sub2api / CLIProxyAPI(CPA) / new-api 三个开源项目的可借鉴做法，以及 2026-11-01 封号事故的教训。
> 铁律：`docs/iron-rules.md`。本文所有"上游可见"的改动都必须走三态开关 + 灰度组 + ≥24h 观察。

---

## 0. 两个目标的可测量定义

| 目标 | 定义 | 度量（上线后硬指标） |
|---|---|---|
| **G-A 上游归一**：订阅号发出的一切都是真实 Claude Code 形态，含遥测 | 每个订阅账号在 Anthropic 侧看到的 = 一台固定机器上、一个固定设备、同一个 CC 版本的官方二进制产生的 **Messages + bootstrap/eval/event_logging 遥测**，Messages 与遥测共享账号身份、session、机器档、固定出口 | ① 非官方二进制产生的 Messages 占比 → 0（只剩显式例外 `passthrough-isolated` Key）；② 账号侧遥测证据覆盖率 100%（G10）；③ 上游 `429 "Error"`（伪造判定）= 0；④ 平台路径/产品名在上游可见内容出现 = 0 |
| **G-B 用户端体验**：直连谨慎归一，非直连尽量像官方 API | 真 CC 客户：结构校验 → 同版本 profile 归一 → 再校验，不确定就不碰；API 客户：Messages/Chat/Responses 三协议，不支持的参数**明确拒绝**，响应头/错误/限流/ID 与官方同构 | ① 静默忽略字段 = 0（strict 模式）；② 直连误判（genuine 请求被降档 / suspect 请求被放行）可审计；③ Responses 第一档可用；④ 客户可从 `x-1day-mode` 知道自己走的车道 |

两个目标的内在矛盾（《任务书》§0）：直连保真 = 保留客户 CC 的 system/tools/附件；API 体验 = 替换/折叠这些。解法不是在一条路径上两头兼顾，而是**两条车道各自纯粹**：直连只接真 CC 且只做"同版本内"归一；其余全部进 canonical worker（真实 CC 进程 + API 适配层）。

---

## 1. 现状与差距（2026-11-01 de6d0e6）

| 维度 | 现状 | 差距 |
|---|---|---|
| direct 路径 | 真 CC 客户直连；版本钉 2.1.312；设备/机器档/入口归一；计费后缀最后重算（已修）；删 userEmail 等在开关后（默认关） | 版本 pin 跨版本混体（A3）；自定义入口全局开关而非按 Key；未知版本放行宽松；**客户 CC 的遥测从不到达账号**（硬编码 api.anthropic.com + 第一方凭证，客户用的是平台 Key → 账号侧零遥测） |
| worker 路径 | 节点真实 CC 2.1.312，但 `--system-prompt-file` 替换主提示词、`--tools ""`、`--no-session-persistence`、历史折叠成文本 | 上游看到"API assistant"提示词；无原生历史/resume；遥测开着但**无接受证据** |
| 上游判定 | gate 硬检查 + 软检查，2.1.312 后缀算法已验证 | 2.1.312 二进制里已有 `cch=`/`cc_prev_req`/`cc_turn_origin` 签名字段（当前抓包未出现 = 远端 flag 关着）；一旦打开，网关合成/改写的 body 无法签名，**只有真实二进制能跟** |
| API 体验 | Messages 直连高保真；worker 兼容但 temperature/top_k/response_format/n/seed… 静默忽略（现有 `x-1day-ignored-params` 提示）；Responses 不可用；无上游头 | strict 参数契约、Responses 第一档、refusal 语义、keepalive/strict 响应模式 |
| 组织/号池 | 29 号单组织已被停；多小组织支持（容量选组织、认领释放、组织页）已上线 | 新号池按多小组织重建；灰度组空 |

---

## 2. 从三个开源项目借什么、不借什么

| 项目 | 借 | 不借 / 注意 |
|---|---|---|
| **sub2api**（Go，号池型） | ① "三层自洽"方法论：Header（stainless/UA/beta）、Body（`# Environment`）、身份（device/session/cc_version）必须同源，**同号恒定、号间差异**（我们 `accountMachine` 已是这一思路，继续）；② `FromClient 陷阱`：真 CC 客户端自带的 UA/stainless **不能透传**覆盖账号级指纹（我们已固定；写进 profile 测试）；③ `# Environment` 归一只 rewrite 已存在的字段、不无中生有（我们 `pinMachineEnvironment` 同）；④ Anthropic 400/429 熔断按账号 10 分钟窗口（我们已有 markFailure 冷却，补"请求级错误不换号"）；⑤ `apicompat/` 的 Responses↔Anthropic 双向映射（function_call↔tool_use 配对、reasoning↔thinking signature、input_image data URI、tool pairing 归一）——**作为 WP4 Responses 第一档的参考实现**。 | ✗ `/api/event_logging/batch` 返 200 吞掉遥测：那是客户端兼容，不是账号侧遥测；✗ 用 OpenAI Moderation 做内容审核（与本方案无关）；✗ 跨版本伪装 CLI 版本（他们也踩过"版本倒退"坑） |
| **CLIProxyAPI**（Go，多账号 CLI 代理） | ① `fingerprint-profile=claude-code-cli` 按凭证选 profile 的设计 → 我们按 **Key 的 profile/telemetryPolicy + 账号的 profile** 组合；② 响应头清理清单（`ScrubProxyAndFingerprintHeaders`：X-Forwarded-*/Via/Sec-*/Referer/Priority）→ WP5 对 CC 客户端的下游响应 profile；③ 计费后缀算法实现与我们一致（salt+[4,7,20]+version，UTF-16 注意）→ 作为交叉验证；④ **`cch` 签名（xxHash64 seed 0x4D65…）与 `cc_prev_req/cc_prompt_id/cc_turn_origin` 字段**：证明新版 CC 的计费头会签名、带会话连续性标签 → **我们的结论：不要走 CPA 的"网关合成 CC body"路线**，真实二进制才能长期跟上签名/标签变化；⑤ caller system 放到"首个 user 之后的 mid-conversation system block"（`mid-conversation-system-2026-04-07` beta）而不是顶层 system → 这是 G1 的替代方案之一（若 `--append-system-prompt-file` 语义不理想）。 | ✗ 整体 cloaking（无真实进程、无遥测）；✗ `injectFakeUserID` 随机 device（我们一号一设备） |
| **new-api**（Go，通用 relay） | ① 通道适配器接口（`ConvertClaudeRequest / ConvertOpenAIResponsesRequest / SetupRequestHeader / DoResponse`）的分层 → 我们 WP4 的 adapter 边界照此切；② `stop_reason=refusal` 的显式处理（记管理原因、不当作成功）→ B9 的语义；③ 参数覆盖/转换错误（`param_override_error.go` / `convert_request_error.go`）**返回明确 4xx 而不是静默**→ strict 模式的错误体设计；④ 已有 `sub2api` 通道 → 说明下游用 new-api 聚合我们时会怎样读错误码（Retry-After、`type`）。 | ✗ 多厂商目录（我们只做 Claude）；✗ 其按渠道重试换号的默认策略（与组织隔离冲突） |

---

## 3. 目标架构（两条车道 + 三个共享层）

```text
                     ┌──────────────── 共享：认证/额度/参数校验 → conversation identity → Key policy ────────────────┐
客户端                                                                                                              上游
┌──────────────┐   ① 原始结构 gate（不改体）        ┌──────────────────────────────┐  同版本 profile 归一 + 后缀最后重算   ┌────────────┐
│ 真 Claude    │──▶ ② Key.allowedCustomEntrypoints ─▶│ 车道 A：raw direct            │─────────────────────────────────────▶│ Anthropic  │
│ Code 客户端  │   ③ Key.telemetryPolicy==         │ (仅 passthrough-isolated Key) │   账号侧无遥测 → 显式例外、不计入 G-A │ Messages   │
└──────────────┘      passthrough-isolated          └──────────────────────────────┘                                      └────────────┘
       │ 其他情况（native-required，默认）
       ▼
┌──────────────┐   Messages/Chat/Responses 适配层   ┌──────────────────────────────┐  官方 CC -p · 原生 system · 原生 tools  ┌────────────┐
│ API 客户端   │──▶ strict/warn 参数契约 ──────────▶│ 车道 B：canonical worker      │─────────────────────────────────────▶│ Messages + │
│ (OpenAI/Anth)│   内部表示 = Anthropic Messages    │ 真实 CC 进程 @ 节点 + 账号 OAuth│  原生 session/resume · caller MCP     │ 遥测(原生) │
└──────────────┘                                   └──────────────────────────────┘                                      └────────────┘
                     └── 共享：账号固定设备/机器档/代理/组织隔离 · 双账本 · proxy_down 冻结 · 灰度开关 ──┘
```

**路由决策（固定顺序，《任务书》§3）**：认证 → conversation identity（既有会话的模式优先）→ CC 结构 gate（原始体）→ Key `allowedCustomEntrypoints` → Key `telemetryPolicy` → 车道 A 可用性 → 车道 B 节点能力（`canonicalProfiles`、`telemetryEvidence` 有效）→ 非 CC 一律车道 B。无合格节点返回 503 `native_telemetry_unverified`，不降级。

**Key policy 扩展**（复用 `api_keys.policy_json`，无新列）：
```json
{ "historyPolicy": "passthrough", "workerMode": "legacy|canonical", "telemetryPolicy": "native-required|passthrough-isolated",
  "allowedCustomEntrypoints": ["mirasim"], "parameterPolicy": "strict|warn", "responseMode": "keepalive|strict",
  "probeIntercept": true, "autoProbeIntercept": false, "teamAffinity": null }
```
默认：新 Key `strict` / `strict` / `native-required` / `autoProbeIntercept=false`；存量 Key `warn` / `keepalive`，分批迁移。所有新字段先过 `parseKeyPolicy`，控制台 Key 编辑页加选项。

---

## 4. 工作包

每个工作包：改动点（文件级）→ 接口/数据 → 开关与灰度 → 验收 → 回滚。所有上游可见项的开关默认 = 老行为。

### WP0 实证门（先于一切生产代码）

在 `tests/e2e/cc-probe/` 建受控探针：临时 HOME、临时 `CLAUDE_CONFIG_DIR`、假 OAuth、本机假上游（扩展 `apps/gateway/scripts/mock-upstream.mjs` 记录完整请求含 header）。用 **2.1.312 真实二进制**（`/home/ubuntu/claude-code-re/2.1.312/package/claude`，节点同版本）。每个 gate 产出一份版本化 JSON 证据 `docs/evidence/cc-2.1.312/<gate>.json`（结构、状态、无秘密样本）。

| Gate | 问题 | 本文已掌握的事实 | 仍要实测 |
|---|---|---|---|
| G1 append | `--append-system-prompt-file` 是否保留 canonical system 块与原生 tools | 二进制帮助文本确认存在："Read system prompt from a file and append to the default system prompt" | 追加位置（system[] 第几块、cache_control）、与 `--system-prompt-snapshot on` 的交互、resume 后是否重复 |
| G2 stream-json | stdin 接受的 role/content 形态 | `--input-format stream-json`、`--replay-user-messages` 存在；现有 worker 已用 stream-json 送 user/tool_result | 能否注入 assistant（预期不能）、图片/document 块、`tool_result` 配对 |
| G3 外部历史导入 | 能否为新会话写出 2.1.312 可 `--resume` 的 transcript（JSONL） | 节点 `cc-accounts/<id>/projects/` 下有真实 transcript 样本（运维清理任务提到） | 字段 matrix：user/assistant/tool_use/tool_result/thinking+signature；CC 读取后上下文正确；**不通过则 canonical 对外部多轮历史返回 `history_import_unsupported`，该 Key 留 legacy** |
| G4 resume | 进程退出/节点重启后 `--resume <id>` 无丢失无重复 | `--session-id`/`--resume`/`--fork-session` 存在 | 配合 `--system-prompt-snapshot on` 的 system 一致性 |
| G5 工具中断 | awaiting caller tool 时进程死亡能否 resume 并补 tool_result | — | 不通过 → 409 `tool_continuation_lost` |
| G6 restricted | `--restricted` 的上游 tools 集与文件边界 | 二进制含 "Reads outside the working directories are blocked (permissions.blockReadsOutsideWorkingDirectories)"、"--restricted: path outside the working directory" | 实际 tools 列表、OAuth/config/其他会话读取全部失败、事件形态 |
| G7 Bash/网络 | 开放 Bash 的隔离 | — | **首批不开放**；只记录结论 |
| G8 schema | `--json-schema` 请求形态与失败语义 | 参数存在 | 流式可否适配；失败错误体 |
| G9 profile | direct/worker 完整 profile（headers/body/beta/tools/system 模板） | `docs/claude-code-compat.md` §5/§11 有 2.1.312 cli/sdk-cli 两套；二进制含 `mid-conversation-system-2026-04-07`、`effort-2025-11-24`、`prompt-caching-scope-2026-01-05`、`advisor-tool-2026-03-01`、`redact-thinking-2026-02-12` 等 beta 字符串（远端 flag 控制是否发） | 对 2.1.312 **cli / sdk-cli / restricted** 三个 profile 各抓 ≥12 次：beta 集与顺序、tools、system 块、`cc_*` 字段（含 `cch=` 是否出现）；2.1.316 另抓 |
| G10 telemetry | worker 原生遥测结构正确且被真实上游接受 | 2.1.312 `INGEST_URL` 硬编码 `https://api.anthropic.com/api/event_logging/v2/batch`，不跟 `ANTHROPIC_BASE_URL`（二进制确认） | A 受控结构（假上游）；B **专用测试账号**真实接受（经固定代理、不 MITM）；证据写入 `telemetryEvidence` |

**G10 的拓扑结论（直接决定车道 A 的地位）**：客户本地 CC 的遥测带的是客户的凭证（平台 Key）并打向 api.anthropic.com → 要么 401 要么根本不是账号的遥测；因此**车道 A 在账号侧永远零遥测**，不能满足 G-A，只能作为显式例外。

### WP1 direct：版本 profile + 按 Key 入口 + 再校验（车道 A）

改动：
- `packages/core/src/cc-profile.ts`（新）：`CC_PROFILES[version][entrypoint] = { ua, sdkVersion, runtimeVersion, betas(ordered, feature→beta 规则), identityBlock, mainPromptDigest, toolsDigest, billingAlgo, minVersionByModel, evidence{date, digest} }`，由 G9 产出；`cc-shape.ts` 的 `CC_VERSION_DETAILS` 并入。
- `cc-shape.ts`：`classifyCcRequest(headers, body, { allowedCustomEntrypoints: string[] , requireKnownProfile })`：custom 入口只在 Key allowlist 内放行（替代今天的三态全局开关，`direct_cc_entrypoint_normalize` 保留为迁移期总闸，完成后删除）；未知版本在 `requireKnownProfile=1` 时不直连，observe 时原样直连并记 `cc_profile_unknown`，**不 pin**。
- `fingerprint.ts` / `upstream.ts`：**禁止跨版本 pin**（`direct_cc_version_pin` 默认空）：同版本只修正 transport/device/machine/custom entrypoint，body 版本相关字段不动；归一化后再次 `classifyCcRequest` + profile 一致性断言，不是 genuine 不出站（返 400 `cc_profile_mismatch`，记日志）。保留 `alignBillingSuffix` 最后一步与运行时闸。
- `# Environment` 与附件：只 rewrite 已存在字段；`userEmail` 删除继续在开关后（G9 要先确认真 CC 在"只用 API Key 登录"时是否也带 userEmail——客户用的是平台 Key，不是 OAuth，CC 的 `oauthAccount.emailAddress` 可能为空 → 很可能**本来就不带**；若如此该开关永远不开，直接删代码）。
- 集成测试：分类 → Key 授权 → normalize → buildUpstreamRequest → 再 gate，覆盖 mirasim 2.1.316/2.1.314/2.1.312 的真实抓包形态与今天的"短提示+同块 reminder"。
开关：`direct_cc_entrypoint_normalize`（迁移期）、`direct_require_known_profile`（默认 1）、`direct_strip_user_email`。
验收：`cc_profile_mismatch_total=0`（归一化后仍 genuine）；上游 `429 "Error"`=0；未知版本不被 pin。
回滚：开关回 0 / 代码路径与今天一致。

### WP2 canonical worker 进程与工具边界（车道 B 核心）

改动（`apps/provider-node/src/cc-worker.ts`、`apps/gateway/src/ccr/worker.ts`、`protocol.ts`）：
- 新 open 形态 `CcWorkerOpen{ mode:"canonical", profileId, appendSystemPromptFile|callerInstructions, nativeSession{id, action:"fresh|resume|fork", revision}, builtInToolProfile:"restricted-default|tools-disabled-canonical", checkpointId }`；legacy 字段只在 `mode:"legacy"`。
- 启动参数（2.1.312）：`-p --model <m> --output-format stream-json --input-format stream-json --verbose --include-partial-messages --session-id <uuid> --system-prompt-snapshot on --restricted --permission-prompts none --strict-mcp-config --mcp-config <file> --allowedTools mcp__caller [--append-system-prompt-file <f>] [--json-schema <f>]`；**移除** `--tools ""`、`--system-prompt-file`、`--no-session-persistence`。
- 提示词：删除 `workerSystemPrompt()` 的全部"你不是 Claude Code / 没有工具 / 忽略路径"文本；客户 system 只追加（G1）；无平台路径（I2）。
- 合成 cwd：`machine-runtime.ts` 的私有 mount namespace 内把真实 scratch bind 到 `accountMachine.workingDir`，chdir 合成路径；`# Environment`、进程 cwd、遥测 cwd 三者一致；启动自检失败则拒绝 canonical session。
- 工具边界：`--restricted` + 默认内置工具 + caller MCP；Bash 不开放（G7）；`SessionTranslator` 按事件来源分类：`mcp__caller__*` → 客户 tool_use 停泊；CC 内置工具事件 → 吞掉、索引重映射、不提前结束下游；`internal_tool_event_leaked_total` 恒 0。
- 遥测：不设 `DISABLE_TELEMETRY` / `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`；`CLAUDE_CODE_DISABLE_ATTACHMENTS` 是否保留以 G9 采样决定（目标：保留官方 Environment，隔绝账号 email/宿主附件）。
- 节点心跳新增 `ccWorker.canonicalProfiles`、`historyImport`、`restrictedTools`、`telemetryEvidence`；无能力声明的节点不接 canonical。
开关：节点 env `CC_WORKER_CANONICAL=1` **且** Key `workerMode=canonical`。
验收：上游 system 块 = 官方（计费头+身份+主提示词）+ 追加块；无 "API assistant"；内置工具零泄露；restricted 读取越界全部失败。
回滚：新会话停发 canonical；既有 canonical 会话 drain，不切回折叠（I9）。

### WP3 原生会话、恢复、外部历史（车道 B 状态机）

- 状态机 `READY → RUNNING → COMMITTED / AWAITING_CALLER / DIRTY / LOST`（《任务书》§6.2），元数据先复用 `worker_turn_memory.data`（版本化 JSON：`schemaVersion, mode, profileId, accountId, teamId, nodeId, nativeSessionId, revision, expectedTurn, state, clientHistoryHash, assistantResponseHash, configGeneration, syntheticCwd, usageBaseline, pendingCallerCalls, expiresAt`）。
- live 进程优先 stream-json 续轮；进程回收后 `--resume <nativeSessionId>`（同 account/team/configGeneration/profile/cwd 全匹配）；fork 只用于显式分支。
- 幂等：revision 单调；open/resume/commit 可重试；迟到帧拒绝；计费按 request_id 唯一 + settlement journal，resume 的 usage 取增量。
- 外部历史：G2 能力优先；否则 G3 版本化 importer（只建新会话）；未通过前对外部多轮历史返回 `history_import_unsupported`（该 Key 留 legacy 或改 `historyPolicy=reset`）。
- transcript 不进 SQLite/日志；TTL 24h 可配；过期返 `session_expired`。
验收：kill 进程 / 重启节点 / 网关蓝绿后 ≥3 轮普通对话 + 1 轮 caller tool 对话无重复 turn、无重复扣费。

### WP4 下游 API 适配与 strict 参数契约（G-B 非直连）

- 内部表示 = Anthropic Messages。转换器补"校验 → 映射 → 不支持决策"三段：
  - Chat→Messages：system/developer、function tools、tool messages、`stop`、`temperature|top_p`（二选一）、stream usage；
  - Responses→Messages（参考 sub2api `apicompat/responses_to_anthropic_request.go`）：`instructions`→system、`input` 字符串/列表、`function_call`↔`tool_use`、`function_call_output`↔`tool_result`（配对归一 `normalizeAnthropicToolPairing`）、`input_image` data URI→image、`reasoning(encrypted_content)`↔thinking signature、`tool_choice` 映射、连续同角色合并；
  - Messages→Responses 流（参考 `responses_to_anthropic.go` 的状态机反向）：`response.created/output_item.added/output_text.delta/function_call_arguments.delta/done/completed`，usage 映射。
- `parameterPolicy`：`strict` → 400 `unsupported_parameter{param, path, reason}`（`n>1`、`logprobs`、`seed`、非零 penalties、`service_tier`、`temperature/top_p/top_k`（worker 无可靠映射）、强制 `tool_choice`（仍是提示词约束）、`response_format`（G8 通过前））；`warn` → 现有 `x-1day-ignored-params`。显式默认值（`n=1`、`temperature=1`？）→ 以 G9/实测为准决定是否接受。
- Responses 第一档：自包含 `input`/`instructions`、function tools、stream/non-stream、标准 id/usage/错误；`previous_response_id`、后台任务、内置 OpenAI 工具、container/files 明确 400。
- `count_tokens` 标为估算（文档 + 响应头 `x-1day-estimated: 1`）。
- 结构化输出：G8 通过 → `--json-schema`；否则 strict 拒绝。
- refusal：direct 原样透传；worker 的 CLI 文本 refusal 保持结构化 400 `safeguards_refusal`（标注非标准），不伪造 `stop_reason=refusal`（new-api 的做法是把 refusal 作为管理拒绝原因记录，可借鉴到用量行）。
验收：三协议 golden tests（流式/非流式/工具/图片/长 system/max_tokens/stop）；strict 下不支持参数 100% 明确拒绝。

### WP5 响应头、错误、保活、raw relay

- 上游头 allowlist：`request-id`、`retry-after`（`anthropic-ratelimit-*` **继续不转**：暴露号池状态，运营规则 10-29）；平台 429/503 已带 Retry-After。
- CC 客户端下游响应 profile（借 CPA）：对 CC UA 的响应不下发 `x-1day-*` 诊断头，清理可识别网关的头；清单以 CC 源码 + 抓包验证。
- `responseMode=strict`：不提前 200、不填空白，等真实上游头（接受 Cloudflare 100s 超时风险，文档化）；`keepalive` 保留现状并写明"200 后只能流内报错"。
- reset：不再用合成 assistant 文本；`autoProbeIntercept` 默认关（已做：`PROBE_INTERCEPT_REPEATS`）。
- raw passthrough：tunnel spec `preserveHeaders:true` + 节点 `raw-v1` capability；节点对该请求跳过 `anthropicFingerprintHeaders`。
- 错误分类：上游 `429 {"type":"rate_limit_error","message":"Error"}` 归 **请求级**（`upstream_request_rejected`，不换号、不重试、记 `cc_shape_rejected_upstream`）——这是今天把 31 条放大成 651 条的放大器；它不是熔断，是正确的错误作用域。
验收：`raw_passthrough_header_mutation_total=0`；strict 模式真实 4xx/5xx 原样到客户。

### WP6 遥测真实性与证据（G-A 的闸）

- `telemetryEvidence` 表（版本化）：`accountId, profileId, nodeId, proxyId, nativeSessionId, ccVersion, endpoint, status, source(controlled|real), observedAt, digest, expiresAt`；不存事件正文/凭证/URL query。
- 节点心跳上报证据元数据；`native-required` 的账号/profile/出口在首次启用前必须有 B 类（真实账号）证据；CC 版本/profile/出口变化即失效。
- 运行时拿不到真实状态 → `unknown`，不算成功；无证据不接新会话（503 `native_telemetry_unverified`）。
- 永不：伪造/补发/重放遥测；为采集而上常驻 MITM；全局关遥测充数。
验收：`cc_telemetry_evidence_unknown_total` 只在未启用账号上出现；`native_telemetry_unverified_total` 可解释。

### WP7 控制台与运营面

- Key 编辑：`workerMode / telemetryPolicy / allowedCustomEntrypoints / parameterPolicy / responseMode / autoProbeIntercept`。
- 账号页：`profileId`、`telemetryEvidence` 状态（valid/expired/unknown）、所在车道统计。
- 节点页：`canonicalProfiles`、native session 数、resume 失败数、磁盘、证据覆盖。
- 组织页（已有）加：该组织下 native-required 会话数、被 503 `native_telemetry_unverified` 拒绝数。
- 设置页：新开关均为三态；灰度组选择（已有）。

---

## 5. 实施顺序（每步独立可审、可回滚；每步 ≤ 1 轮发布/天）

| 阶段 | 内容 | 退出条件 |
|---|---|---|
| **S0 基线固化**（已完成大半） | 铁律 1/2、三态开关、后缀不变量、灰度组、多小组织、proxy_down | 服务器 = `de6d0e6`；灰度组建好；新号池按多小组织重建后才有流量 |
| **S1 实证门**（1～2 周，纯测试工程，不碰生产路由） | WP0 的 G1/G2/G4/G6/G8/G9 受控探针 + G10-A；G3/G5 可并行；产出 `docs/evidence/cc-2.1.312/*` | 每个 gate 有版本化结论；G10-B 需专用测试账号（新号池第一批里拨 1 个到灰度组） |
| **S2 direct profile**（1 周） | WP1：profile 模块、按 Key 入口、禁止跨版本 pin、再校验、集成测试 | 灰度组 Key 跑 ≥24h：`cc_profile_mismatch_total=0`、无 429 "Error" |
| **S3 canonical worker 单轮 + live 多轮**（2～3 周） | WP2 + WP5 的内部工具过滤；WP6 证据表与心跳；节点 bundle；一个测试 Key/测试账号/一个节点 | G1/G6/G9 通过；G10-B 真实接受证据；restricted 越界读全部失败；内置工具零泄露；观察一个完整周期 |
| **S4 native resume + 外部历史**（2 周） | WP3；G3/G4/G5 | kill/重启/蓝绿后无重复 turn、无重复扣费；G3 不通过则对外部历史明确 `history_import_unsupported` |
| **S5 API 契约与 Responses**（2 周） | WP4、WP5 的 strict/keepalive 与 raw-v1 | 三协议 golden 全绿；strict 下零静默忽略 |
| **S6 迁移与收口**（1～2 周） | 存量 Key 显式选 `passthrough-isolated` 或迁 `native-required`；legacy worker 新会话关闭；文档收尾 | 非官方二进制 Messages 占比 → 0（例外清单可数）；legacy 代码保留一个观察期后删 |

每阶段的上游可见改动都先 `canary`（灰度组）→ ≥24h → `1`；每轮发布前有 `pre-<name>-<ts>-dist.tgz` 快照；回滚规则见《任务书》§12。

---

## 6. 测试与验收矩阵（摘要，详见《任务书》§11）

- 单元/集成：profile 一致性与禁混版本；自定义入口链路（分类→授权→normalize→build→再 gate）；后缀不变量（已有 336 组合，加新 profile）；canonical prompt 无 API-assistant/平台路径；translator 内置工具零泄露；native 状态机（revision 冲突、重复 open/commit、迟到 close、DIRTY/LOST/TTL）；strict/warn 参数；三协议 golden。
- 真实 CC 受控：G1–G10 版本化结果；kill/重启/蓝绿后 resume；并发同 conversation；restricted 越界与网络绕过；大图/PDF/长 system/长工具结果/max_tokens/stop/thinking signature/JSON Schema。
- 项目标准：`pnpm build` → `PATH=…bun… pnpm -r test` → `PROBE_INTERCEPT=0 pnpm test:e2e` → 真实 Key 三协议 + 工具轮 + resume + `cc_dual_mode` → `release-verify`（先灰度 Key）。
- 上线硬指标：legacy system prompt / 折叠构造 / 平台路径命中 = 0；内置工具泄露 = 0；native resume 无重复；`native-required` 证据覆盖 100%；strict 零静默；无 OOM/失控进程；p50/p95、错误率、RSS/磁盘有基线对照。

---

## 7. 风险与未决（审计 agent 必须给结论的问题，《任务书》§15 的扩展）

1. **G3 importer 值不值得做**：外部多轮历史是 passthrough 默认下的常态；若 importer 不可靠，替代契约 = `history_import_unsupported` + 该 Key 用 `historyPolicy=reset`（只带最后一问进 canonical），API 体验会退化，需要产品确认。
2. **`--append-system-prompt-file` 在 resume 下的 system 一致性**（G1×G4）；若追加块每轮重复或位置漂移，回退到 CPA 式"首个 user 后的 mid-conversation system"方案（需 `mid-conversation-system-2026-04-07` beta 在 2.1.312 是否对 OAuth 开放）。
3. **restricted 的工具集是否等于 direct profile 的 tools**：不等也可以，但要分 profile 留证据，不能混拼。
4. **遥测接受证据怎么拿**：官方 CC 不回显遥测 HTTP 状态；候选：开 `--debug-file` 看网络日志、或 `DEBUG` 环境输出中的 fetch 结果。拿不到 → G10 保持阻塞，`native-required` 不得开。
5. **2.1.312 的 `cch=` 签名何时被远端 flag 打开**：一旦打开，车道 A 的任何改体（含后缀重算）都会失效——这是**把一切流量迁到真实二进制（车道 B）的最强理由**，也是"不要再在网关里改 CC body"的边界。S2 之后，车道 A 只保留对 body **零改写**的能力（只改 header/device），改体开关全部删除。
6. **性能/成本**：canonical 每会话一个 CC 进程 + 原生历史落盘；现有 worker-01 24 核/94 GB 冗余足够，但要测 p95 与磁盘增长（transcript TTL 24h）。
7. **CC 版本升级**：新版本 = 新 profile + 全套 gate 重跑；节点二进制与 direct 已知表同步升级；旧版本客户按 `requireKnownProfile` 处理。
8. **号池重建**：多小组织（每组织 1～3 号、不同出口子网、冷静期 62～70 分钟恢复、首日并发 1～2）；第一个组织的 1～2 个号进灰度组；`teamAffinity` 防止单客户横跨所有组织。

---

## 8. 交付物清单

- 代码：`packages/core/{cc-profile,canary,key-policy,telemetry-evidence}.ts`、`apps/gateway/src/{upstream,proxy,ccr/worker,ccr/translate,convert,responses}.ts`、`apps/provider-node/src/{cc-worker,machine-runtime,protocol,bridge}.ts`、`apps/console/src/{node/registry,routes/admin,routes/user}.ts`、web Key/账号/节点/组织/设置页。
- 证据：`docs/evidence/cc-2.1.312/{G1..G10}.json` + 采样日期与 digest。
- 文档：`architecture.md`、`gateway.md`、`claude-code-compat.md`、`ccr-supply.md`、`worker-sessions.md`、`provider-protocol.md`、`team-isolation.md`、`client-notes`、`errors.md`、`iron-rules.md`；每轮发布一份 `docs/deployment/<date>-*.md`。
- 运维：`release-verify` 灰度优先；`1day-health` 新增 canonical/证据行；`proxy-down-alert` 已有。
