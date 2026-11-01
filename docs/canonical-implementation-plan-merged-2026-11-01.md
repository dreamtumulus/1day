# Canonical 方案 · 合并决议（2026-11-01）

> 输入：A = 另一 agent 的《实施方案 v1》（服务器 `docs/canonical-cc-worker-api-implementation-plan-2026-11-01.md`，706 行）；B = 本会话的《可实施方案》（`docs/canonical-implementation-plan-2026-11-01.md`）。两者都源自《任务书》，骨架一致（两条车道、G1–G10、WP1–WP7、R0–R5）。
> 决议：**以 A 为主干**（工作包拆得更细、有许可合规、有 WP7 组织预算），**叠加 B 的 12 条修正/补强**。实施以本文 + A 为准；冲突处以本文为准。

## 1. A 比 B 多的、采纳

| 项 | 内容 | 处置 |
|---|---|---|
| 许可合规 | sub2api LGPLv3、new-api AGPLv3 不得复制进闭源仓库，只参考设计与测试向量；CPA MIT 可用 | 采纳，写进 `iron-rules.md` 附录"第三方代码" |
| WP7 组织预算/护栏 | 组织级日 token/费用/工具调用/并发预算，超限暂停新会话；单会话 max turns/token/工具调用/超时 | 采纳（注意：用户已判定"组织级封禁不可逆，熔断无意义"——**这里采纳的是事前预算护栏，不是事后熔断**；识别到 `organization has disabled` 时的处置只做"立刻停止调度 + 告警，不重试不 reauth"，不宣称能救号） |
| G10-B 取证方法 | 测试出口用 `SSLKEYLOGFILE`（若 Bun/CC 支持）或受控测试代理记录 TLS/HTTP 状态；生产不常驻 MITM | 采纳为 S1 的 PoC 项（R0 第一件事） |
| sub2api 细节 | `normalizeClaudeOAuthRequestBody` 的缺省补齐只对非 CC 使用、`NormalizeDateline` 日期句归一、`ClaudeCodeValidator` 的 system 相似度作为 gate 补充 | 采纳为 WP1/WP4 参考 |
| CPA 细节 | `ClaudeDeviceProfile` / `ClaudeCLIAuthIdentitySeed` / `ClaudeCodeSessionID` 的稳定键设计；管理 API 对未知 profile 写入即拒绝 | 采纳为 `cc-profile.ts` 设计输入 |
| 数据模型 | `native_sessions` 独立表（仅新增）作为 `worker_turn_memory` 之外的选项；`cc_worker.state` typed 事件 | 采纳 |
| 新 Key 默认 `probeIntercept=false` | — | 采纳（显式头 `x-1day-probe` 才接管；现网已把重复推断关掉） |

## 2. B 比 A 多的、必须并入 A

| # | 补强 | 来源/证据 |
|---|---|---|
| B1 | **两个目标的可测量硬指标**（非官方二进制 Messages 占比→0、遥测证据覆盖 100%、上游 `429 "Error"`=0、平台路径=0、strict 零静默、`x-1day-mode` 可见） | B §0 |
| B2 | **铁律 2 贯穿**：A 的每个上游可见改动（WP1 附件中性化、metadata 键序、WP2 提示词、WP5 头清理…）都必须是三态开关 + 灰度组 ≥24h；A 未提灰度组 | `docs/iron-rules.md`，服务器已建 `canary-1cf43ccb` |
| B3 | **出站不变量**：直连所有改体在前、`alignBillingSuffix` 最后；不会算后缀的版本不碰首条用户文本；运行时最后一道闸。A 的 WP1 步骤 4/5（键序、附件中性化）必须在这个框架内 | 11-01 封号根因；`de6d0e6` 已落地 |
| B4 | **cch 签名风险 → 车道 A 零改体方向**：2.1.312 二进制已含 `cch=`/`cc_prev_req`/`cc_turn_origin`（远端 flag 未开）；一旦开启，任何 body 改写失效。结论：S2 之后车道 A 只保留 header/设备级归一，**所有 body 改体开关进入删除清单**；不要走 CPA 式网关合成 body | B §1、§7.5；二进制字符串计数 |
| B5 | **上游 `429 {"type":"rate_limit_error","message":"Error"}` 归请求级**：不换号、不重试，记 `cc_shape_rejected_upstream`。A 未覆盖；这是把 31 条放大为 651 条的放大器（与"熔断"无关，是错误作用域） | B WP5 |
| B6 | **车道 A 遥测的具体原因**：客户用平台 Key，CC 把遥测发向硬编码 `api.anthropic.com` 且带客户凭证 → 账号侧零遥测；写进客户接入文档 | 二进制 `INGEST_URL` |
| B7 | **G1/G6/G8 的已知事实**：`--append-system-prompt-file <file>` 帮助文本已确认；`--restricted` 的越界读取拒绝文案已确认；`--json-schema`、`--fork-session`、`--system-prompt-snapshot`、`--replay-user-messages` 均在 2.1.312 | 二进制 |
| B8 | **`anthropic-ratelimit-*` 不转发**（A WP5 要转发）：它描述的是订阅号的窗口而不是客户 Key，且随换号跳变 → 泄露号池状态（运营规则 2026-10-29）。只转 `request-id`（网关自己的）与 `retry-after` | 冲突，以 B 为准 |
| B9 | **默认 historyPolicy**：A 写新 Key 默认 passthrough；现网已改为 settings `history_policy_default=reset` + `history_policy_canary`（铁律 2）。新 Key 可显式选 passthrough；默认值由设置页决定，不写死 | 冲突，以现网为准 |
| B10 | **userEmail 开关很可能可以直接删**：客户 CC 用平台 Key 登录时 `oauthAccount.emailAddress` 多半为空，本就不带 `# userEmail`；G9 采样确认后删代码而不是留开关 | B WP1 |
| B11 | **号池重建纳入方案**：多小组织（每组织 1～3 号、不同出口子网、冷静期恢复、首日并发 1～2）、首批 1～2 号进灰度组、拨 1 个专用测试账号做 G10-B；`teamAffinity` 防单客户横跨所有组织 | B §7.8，功能 2 已上线 |
| B12 | **参考实现的文件级指针**（直接可读）：sub2api `internal/pkg/apicompat/{responses_to_anthropic_request.go, anthropic_to_responses.go, responses_to_anthropic.go}`、`internal/service/{claude_code_validator.go, gateway_environment_block.go, header_util.go}`、`internal/pkg/claude/constants.go`；CPA `internal/runtime/executor/{claude_executor_cloaking.go, claude_signing.go, claude_executor_request.go, claude_fingerprint_policy.go}`、`internal/misc/header_utils.go`；new-api `relay/channel/claude/{adaptor.go, relay-claude.go, relay_responses.go}`、`relay/claude_handler.go`、`relay/param_override_error.go` | 本机已有克隆：`/home/ubuntu/sub2api-source`、`/home/ubuntu/cliproxyapi`、`/tmp/new-api` |

## 3. 两份都没写透、实施前要补的

1. **G10-B 若拿不到真实状态怎么收口**：A 给了"接受 unknown 不宣称达成"；补一条产品决策——`native-required` 是否允许在 `unknown` 下以"结构正确 + 账号健康 N 天"作为次级证据开放。默认：**不允许**，等用户拍板。
2. **节点容量模型**：canonical 每会话一个 CC 进程 + 原生 transcript；需要 p95、RSS、磁盘增长基线与 TTL 清理任务（24h），worker-01 现有 `1dayapi-cc-cleanup.timer` 要改成按 TTL。
3. **CC 版本升级 SOP**：新版本 = 新 profile + G1–G10 重跑 + 节点二进制同步；旧版本客户按 `requireKnownProfile` 处理（A 有规则，B 有 SOP 骨架，合并进 `claude-code-compat.md §9`）。
4. **存量 Key 迁移沟通**：mirasim（真 CC + 自定义入口）需明确选 `passthrough-isolated` 或 `native-required`（后者 = 他们的 CC 请求由节点 CC 重放，延迟 +1 跳）；RuoMoe/刀刀（API 客户）→ canonical + strict 需先在 warn 模式观察静默字段。

## 4. 合并后的顺序（替代 A §7 / B §5）

| 阶段 | 内容 | 退出条件 |
|---|---|---|
| R0 | 基线固化（已完成：铁律 1/2、三态开关、后缀不变量、灰度组、多小组织）；号池按多小组织重建；拨测试账号 | 灰度组有 1～2 号 + 测试 Key + 专用遥测测试账号 |
| R1 | G1/G2/G8/G9 受控探针 + G10-A + **G10-B 取证 PoC**；WP1 direct profile（禁跨版本 pin、Key 白名单入口、再校验、零改体方向）；WP5 响应头/strict 模式/429 "Error" 请求级 | 证据文件齐；灰度 Key ≥24h 无 `cc_profile_mismatch`、无 429 "Error" |
| R2 | WP2 canonical worker（restricted、append-file、合成 cwd、内置工具零泄露）+ WP6 证据表与心跳 + WP7 组织预算；单 Key/单账号/单节点 | G10-B 真实接受证据；内部工具零泄露；一个完整观察周期 |
| R3 | WP3 native resume / 外部历史（G3/G4/G5） | kill/重启/蓝绿无重复 turn、无重复扣费 |
| R4 | WP4 Responses 第一档 + strict 参数 + raw-v1；存量 Key 显式迁移 | 三协议 golden 全绿；strict 零静默 |
| R5 | legacy 新会话关闭、观察期后删代码；文档收口 | 完成定义（A §10 + B1 指标）全部成立 |

每阶段一天最多一轮发布，先 `canary` 再 `1`，每轮有 `pre-*-dist.tgz` 快照。

## 5. 用户决策（2026-11-01，补入方案）

### 5.1 G10-B 拿不到真实遥测状态时：允许次级证据开放 `native-required`

- 证据等级分三档，账号页/证据表显式标注，不得混称：
  | 等级 | 条件 | 允许 |
  |---|---|---|
  | `real` | G10-B 取得真实上游 HTTP 2xx（测试出口 `SSLKEYLOGFILE` / 受控测试代理 / CC 原生结果） | `native-required` 直接开放 |
  | `structural+health`（次级，本次决议新增） | ① G10-A 受控结构验收通过（事件结构、身份、cwd、出口、无泄露）；② 该账号在 canonical 下**连续 N 天**（默认 7，设置 `telemetry_health_days`）健康：无 `429 "Error"`、无组织级错误文本、profile/roles 正常、窗口曲线正常；③ 该账号/profile/出口未变化 | 开放，但证据标 `secondary`；版本/出口变化即失效、重新计 N 天 |
  | `unknown` | 以上都不满足 | 不接新会话（503 `native_telemetry_unverified`） |
- 次级证据只覆盖它测量的账号；不外推到组织或节点。
- 一旦取得 `real` 证据的方法可用，次级证据账号自动补测升级。

### 5.2 客户车道与策略由判断器自动决定，管理员可覆盖

- Key policy 里每个策略字段分两层：`auto`（判断器写入，带依据与时间）与 `override`（管理员手动，带操作人与原因）。生效值 = `override ?? auto`。控制台 Key 页显示两层与依据，管理员一键"回到自动"。
- **判断器输入**（只用平台已有的观测，不问客户）：最近 N 次请求的 UA/结构 gate 结果（真 CC 比例、版本、入口是否自定义）、协议（Messages/Chat/Responses）、是否带外来历史、工具使用形态、流式比例、错误形态（`unsupported_parameter` 命中、静默字段）、是否 Agent/SDK 形态（`sdk-cli`、无 system-reminder）。
- **判断规则（首版）**：
  | 观测 | `workerMode` | `telemetryPolicy` | `parameterPolicy` | `responseMode` | `historyPolicy` |
  |---|---|---|---|---|---|
  | ≥95% 真 CC（genuine，已知 profile） | canonical（默认）；direct 仅当管理员 override 为 `passthrough-isolated` | native-required | strict（CC 不发非法参数） | strict | passthrough（CC 自带完整历史，且会话由平台原生承载） |
  | 真 CC 但自定义入口（如 mirasim） | canonical | native-required；若管理员要求低延迟 → override `passthrough-isolated` + `allowedCustomEntrypoints` | strict | strict | passthrough |
  | API 客户（非 CC UA，Chat/Responses/Messages 裸调） | canonical | native-required | **warn 起步**，连续 7 天 `x-1day-ignored-params` 命中为 0 → 自动升 strict；命中则保持 warn 并告知客户 | keepalive 起步（有 75s+ 非流式长请求时保留），否则 strict | 外来历史比例高 → passthrough（G3 通过前对外来多轮历史返回 `history_import_unsupported`）；否则 reset |
  | 测活/探针形态（极小重复请求、`x-1day-probe`） | — | — | — | — | `probeIntercept` 自动开 |
- **滞回与可审计**：判断器每日重算一次（或新 Key 前 50 次请求后首评），只在观测稳定 ≥3 天才翻转字段；每次翻转写 `key_policy_events`（旧值、新值、依据摘要、时间）；对话内不改模式（`workerMode`/`telemetryPolicy` 只影响新 conversation，I9）。
- **管理员操作**：Key 页可逐字段 override、可"回到自动"、可对分组批量设置默认 override（例如灰度组强制 `canonical+native-required`）。
- **与铁律 2 的关系**：判断器本身是平台内部逻辑，不改上游形态；但它翻转到 canonical/strict 等会改变上游与下游行为，因此判断器的"自动翻转"功能也是三态开关（`key_policy_auto`：0/canary/1），先在灰度组上跑。

### 5.3 对实施顺序的影响

- R1 新增：`packages/core/src/key-policy-auto.ts`（判断器 + 事件表 `key_policy_events`，迁移只新增）、控制台 Key 页两层显示；先以 `auto` 只记录不生效（observe）跑一周，核对判断与人工预期一致后再启用。
- R2 起 `native-required` 的开放条件按 5.1 三档执行；`telemetryEvidence.source` 增加 `secondary`。
