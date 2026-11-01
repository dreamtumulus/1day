# Canonical 实施：V2（本轮实现）与 V1 的区别（2026-11-01）

> V1 = `canonical-cc-worker-api-implementation-plan-2026-11-01.md`（另一 agent 的实施方案 v1）所描述的设计 + 基线 `de6d0e6` 的现网行为。
> V2 = `canonical-implementation-spec-2026-11-01.md`（技术实施文档 v2）及其在 `53de26f`…`0e349eb` 九笔提交中的实现。本文只说"哪里不一样、为什么"，实现细节见 `canonical-progress-2026-11-01.md`。

## 1. 总体

| 维度 | V1 | V2 |
|---|---|---|
| 性质 | 实施计划，未执行；所有改动待"先拍板" | 已实现并上线（2026-11-01 16:30Z，schema 34→37），**所有新行为默认 = 老行为**，由三态开关 / Key 策略逐项放开 |
| 发布纪律 | 未提及灰度细则 | 铁律 2：每个上游可见改动一个三态开关（`0`/`canary`/`1`）、灰度组 ≥24h、一天一轮、dist 快照；`ops/bin/canary-verify` 一键核对 |
| 实证 | 列出 G1–G10 "必须先给结论" | **已给**：真实 2.1.312 二进制受控探针 102 份证据（`docs/evidence/cc-2.1.312/`），三 profile × 12 采样，三批 T1–T12 |

## 2. 车道 A（真 Claude Code 直连）

| 项 | V1 | V2 |
|---|---|---|
| 版本 | 建议停用跨版本 pin（`direct_cc_version_pin` 置空） | 默认仍 pin 到 2.1.312（老行为）；`direct_profile_strict` 开时不跨版本 pin、runtime/package 版本按客户版本的 profile 给、**出站再过一遍形态 gate**，profile 变了 → 400 `cc_profile_mismatch` 不上行 |
| profile | 概念（`versionProfile`） | `packages/core/src/cc-profile.ts` 数据表：`cc-2.1.312-{cli,sdk-cli,restricted}`（12 采样回填）、`cc-2.1.300-*`（interim）；beta 按模型族（haiku 不同）与功能（attachments → `mid-conversation-tool-changes`）分档 |
| 自定义入口（mirasim） | 全局开关 | Key 策略 `allowedCustomEntrypoints` 白名单，放行即改写 `(external, cli)`；全局开关只作迁移期 |
| 未知版本 | 未定 | strict 下 `cc_profile_unknown` 不直连（observe 策略仍直连但不改体） |
| 响应头 | "`x-1day-*` 默认只给 API 客户端"（建议） | `cc_client_response_profile` 开关：CC UA 不下发 `x-1day-*` |
| `# userEmail` | 建议删 strip 开关 | 探针证明平台 Key 登录不带、OAuth 登录带 → 开关保留在 `0`（= 零改体），不删代码 |

## 3. 车道 B（canonical worker）

| 项 | V1 | V2 |
|---|---|---|
| 系统提示词 | "保留官方默认 system prompt" | 已实现：不传 `--system-prompt-file`，客户 system 以 `--append-system-prompt-file` 追加（G1 证明进主提示词块尾部）；**T8 发现 resume 时当次 append 被忽略（回放 prompt_snapshot）→ 客户 system 在会话首轮定死** |
| 历史 | native session / 导入 | fresh 只接受单条 user 原样 content；多轮只能是活进程 continue 或 `--resume`；外部历史 → 409 `history_import_unsupported`，或 `canonical_history_import` 开时按 CC jsonl 导入（**剥 thinking**：G3 证明零校验） |
| 内置工具 | restricted 不满足则 tools-disabled | G6/G7 通过 → 默认 `restricted-default`（`--restricted --permission-prompts none`，无 Bash）；翻译器 `internalTools` 消费内置工具循环，只下发 `mcp__caller__*` |
| 客户工具 | MCP | MCP；需持久会话池，否则 400 `canonical_requires_persistent_session` |
| session | `--session-id` / `--resume` | 节点 `nativeSession{id,action,revision}`；continue 失配 → `--resume <id>` 只喂新一轮（T7 实证可用）；无可 resume → `session_lost`，绝不从折叠转录重启 |
| 遥测 | 不关 | 不关（沿用）；attachments 仍关（I2：`# Environment` 含真实路径；合成 cwd 未做） |
| thinking | 未提 | canonical 保持 CC 默认（adaptive），不再强制 `MAX_THINKING_TOKENS=0` |
| 节点能力 | `canonicalProfiles` 心跳 | `CC_WORKER_CANONICAL=1` → capability `canonical_v1` + 心跳 `ccWorker.canonical{enabled,profiles}`；控制台只派给有能力的节点（I9） |
| 开关 | 节点 env + Key workerMode | 同，另加总闸 `worker_canonical`（三态） |

## 4. Key 策略与判断器

| 项 | V1 | V2 |
|---|---|---|
| 策略结构 | 新字段平铺 | `{auto, override}` 两层，生效 = `override ?? auto ?? 默认`；旧平铺按 override 读 |
| 判断器 | "新 Key 策略默认"表 | `key-policy-auto.ts`：≥50 次首评即采用，之后不同提案连续 ≥3 天才翻转；翻转写 `key_policy_events`（迁移 35）；控制台日批；`key_policy_auto` 三态（首周 `0` 只记录） |
| telemetryPolicy 系统默认 | native-required | **passthrough-isolated**（车道 B 落地前不能把真 CC 默认送进 worker）；由判断器/override 翻到 native-required |

## 5. 遥测证据、组织护栏

| 项 | V1 | V2 |
|---|---|---|
| 证据等级 | real / unknown | real / **secondary**（用户决策：profile 结构证据 + 账号连续 N 天健康）/ unknown；`telemetry_evidence` 表（迁移 36）；`telemetry_evidence_required` 开关 |
| G10-B | 设想 keylog | 探针：Bun 不写 `SSLKEYLOGFILE`，但尊重 `NODE_EXTRA_CA_CERTS` → 受控 CA 注入取结构证据 |
| 组织熔断 | 事后 | `orgLevelErrorCode` → `suspendTeam`（整组织立刻停调度，`[ALERT][org]`，人工解除）；按模型限时的不触发 |
| 预算 | 用量护栏 | `upstream_teams` 日 token / 成本 / 并发（迁移 37），只拦新对话绑定 |
| 429 "Error" | — | 请求级 `upstream_request_rejected`，不换号不重试（I12，事故根因之二） |

## 6. API 协议

| 项 | V1 | V2 |
|---|---|---|
| Responses | 第一档计划 | 已实现：`adapters/responses.ts`（请求映射、非流式对象、流事件状态机）；worker `ccr-responses` + 直连 `responses-via-anthropic`；未实现字段 400 `unsupported_parameter` |
| strict | 严格参数契约 | Key `parameterPolicy=strict` → 路径无法实现的参数 400；默认 warn 不变 |
| responseMode | strict / keepalive | Key `responseMode=strict` 不提前 200、不心跳 |
| raw relay | `preserveHeaders` + `raw-v1` | 已实现，开关 `raw_preserve_headers`；节点 capability `raw-v1` |
| count_tokens | — | `x-1day-estimated: 1` |

## 7. V1 设想在 V2 中被改掉的点

1. **telemetryPolicy 默认**：V1 建议默认 native-required（真 CC 也走 worker）；V2 系统默认 passthrough-isolated，由判断器按观测翻，管理员可覆盖——避免在车道 B 未证实前把全部直连流量搬进 worker。
2. **删 strip 开关**：V1/spec 建议 G9 后删除；V2 保留在 `0`（删除与 `0` 对上游等价，保留退路）。
3. **tools-disabled 作为默认**：V1 的降级项；V2 因 G6/G7 通过而以 `restricted-default` 为默认，tools-disabled 作为可选档。
4. **外部历史**：V1 倾向 G2 stream-json 注入；探针证明首条 user 立即触发 API 调用 → V2 用 G3 transcript 导入（剥 thinking），且默认关。
5. **证据等级**：新增 secondary（用户决策）。

## 8. 两者都还没做的

R5 legacy 关闭与删代码（需两周观察）；合成 cwd（attachments 开启的前提）；节点心跳遥测元数据；判断器缺外来历史 / ignored-params / 探针形态三项观测；`response_format → --json-schema`；2.1.316/2.1.314 profile 采样；（导入会话的 append：T11 已证首次 resume 生效、之后定终身。）
