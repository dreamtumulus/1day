# WP0 探针进度（cc-2.1.316）

任务书：`docs/wp0-batch4-brief-2026-11-02.md`（第四批）；模板：`docs/evidence/cc-2.1.312/PROGRESS.md`；做法与坑汇总：`docs/wp0-probe-handoff-2026-11-01.md` §7。
时间均为 UTC。只跑本机假上游（`127.0.0.1`）+ 拒绝式 CONNECT 代理 + 临时 HOME/假 OAuth；未连真实上游或服务器，未读真实凭据，未改 `packages/`。汇总视图（自动生成）：[README.md](./README.md)。

| 时间 (UTC) | 项 | 结论 | 文件 | 关键发现 |
|---|---|---|---|---|
| 05:28Z | 工具链参数化 | 完成 | `tests/e2e/cc-probe/{run-gate,profile-sample,profile-cli,build-profiles,scrub-evidence,evidence}.mjs`、新增 `billing.mjs`、`shape.mjs` | 新增 `CC_PROBE_VERSION`（默认 `2.1.312`）与 `CC_PROBE_OUT`（默认 `docs/evidence/cc-2.1.312`），`CC_PROBE_BIN` 默认路径随版本走；不设变量时行为与 2.1.312 完全一致（`evidence.mjs --check` 复跑 125 文件、G1–G10 结论不变）。`billing.mjs` 复刻 `ccBuildSuffix` 并在每次采样时对照真实计费头。 |
| 05:31Z | sdk-cli 采样 | 通过 | `baseline-sdk-01..12.json` → `profile-sdk-cli.json` | 12 次（4 提示词 × 3 模型）全成功；身份句 `You are a Claude agent, built on Anthropic's Claude Agent SDK.`；system 恒 3 块 `[74,62,N]`，主提示词 **按模型分档**：sonnet 5503 / opus 5693 / haiku 26946；tools 12（`2106a37964466cf3`，与 2.1.312 完全相同）；顶层 10 键同 2.1.312 顺序；`thinking` adaptive（haiku `enabled,budget_tokens:31999`）、`max_tokens` 128000/32000；beta 10（sonnet/opus）/ 8（haiku）。 |
| 05:33Z | cli 采样（pty） | 通过 | `profile-cli-cli-01..12.json` → `profile-cc-2.1.316-cli.json` | 12 次全成功；身份句 `You are Claude Code, Anthropic's official CLI for Claude.`；system `[70,57,N]`，主提示词 5758（sonnet）/ 5948（opus）/ 27282（haiku）；tools **13**（多 `AskUserQuestion`，`51d4b5a2143407cb`，与 2.1.312 相同）；顶层 11 键，`safeguards` 在 `context_management` 之后；beta 12（含 `dangerous-tool-use-2026-09-03`、`afk-mode-2026-01-31`）/ 8；每次另发 1 条 `max_tokens:1` 无 system 额度探针 + 1 条标题生成请求。 |
| 05:42Z | restricted 采样 | 通过 | `restricted-res-01..12.json` → `profile-restricted.json` | 12 次全成功；主提示词 3417（sonnet）/ 3607（opus）/ 14138（haiku）；tools 12（`60c5d5dd0a586e3a`，与 2.1.312 相同，无 Bash/Workflow，含 Glob/Grep）；顶层 10 键；beta/thinking/max_tokens 与 sdk-cli 同构。 |
| 05:43Z | 传输常量 | 通过 | `profiles.json.transport` | `x-stainless-runtime-version` = **`v26.12.1`**（打包 Bun 1.4.4 的 Node ABI 串）、`x-stainless-package-version` = **`0.128.0`**、UA 原文 `claude-cli/2.1.316 (external, sdk-cli)` / `claude-cli/2.1.316 (external, cli)`（按入口分列，`x-app: cli`、`x-stainless-os: Linux`、`x-stainless-arch: x64`）。三者与 2.1.312 相同，仅 UA 版本号变。 |
| 05:44Z | 计费后缀核对 | 通过（36/36 样本） | 每份样本 JSON 的 `requests[].billing`；`profiles.json.billingSuffix` | 盐 `59cf53e54c78`、取位 `[4,7,20]`、输入 `+VERSION` 与 2.1.316 payload 逐字一致；**36 个主请求全部命中**（另有 12 条标题请求也带计费头，共 48 个带计费头的请求 48/48 命中，0 不符；12 条 `max_tokens:1` 额度探针无 system、无计费头）。注意哈希对象是 **pre-normalization** 的首条用户文本：出站 `messages[0]` 的首块是 `<system-reminder>`，必须先跳过它（`fingerprint.ts` 已如此实现），否则会算错。 |
| 05:45Z | 与 2.1.312 差异 | 完成 | `profiles.json` / `README.md` | 见下节；核心：beta 集、身份句、tools、顶层键序、thinking/output_config **全部不变**；变的是主提示词长度（sdk-cli 5599→5503，opus 另有 +190B 段落）与 opus 专属段落。 |
| 05:46Z | 汇总/去敏 | 通过 | `tests/e2e/cc-probe/evidence.mjs` → `README.md` | `profilesOnly` 模式（无 G1–G10 gate 文件）只汇总 profile/transport/billing；40 个 JSON 脱敏校验 0 命中，README 本身也不含 token 前缀 / 邮箱符号 / 临时目录 / 家目录字面量。 |

## 与 2.1.312 的差异（实测）

- **身份句**：sdk-cli/restricted 仍是 `You are a Claude agent, built on Anthropic's Claude Agent SDK.`；cli 仍是 `You are Claude Code, Anthropic's official CLI for Claude.`（无变化）。
- **主提示词**：sdk-cli 5599→**5503**（sonnet），opus **5693**（比 sonnet 多 190B，末尾多一段游戏开发指引：`Do build original games … Don't build a recreation of a specific existing game`，该段在 2.1.312/2.1.301 中不存在）；cli 5854→5758/5948；restricted 3513→3417/3607；haiku 26946（sdk）/27282（cli）/14138（restricted）与 2.1.312 相同。
- **beta 集/顺序**：sdk-cli/restricted 10 个、cli 12 个、haiku 8 个，**与 2.1.312 逐位相同**（含 `advanced-tool-use-2025-11-20`、`dangerous-tool-use-2026-09-03`、`afk-mode-2026-01-31`）；无新增/删除。
- **tools**：sdk-cli 12 / cli 13 / restricted 12，名单与 digest 均与 2.1.312 相同（`2106a37964466cf3` / `51d4b5a2143407cb` / `60c5d5dd0a586e3a`）→ 可直接复用 2.1.312 的工具表。
- **顶层键序**：sdk-cli/restricted 10 键（`model,messages,system,tools,metadata,max_tokens,thinking,context_management,output_config,stream`）、cli 11 键（`safeguards` 在 `output_config` 前），与 2.1.312 相同。
- **thinking / output_config / max_tokens**：不变（adaptive+display:updates；haiku enabled+31999/32000；`output_config` 仅标题请求带 `format`）。
- **cc_\* 字段**：60 个请求中 0 命中（与 2.1.312 相同；注意本探针 base URL 是本地假上游，`cch` 等 first-party-only 字段不会出现，不能据此断言线上没有）。
- **传输常量**：仅 UA 版本号变化，runtime/SDK 常量相同。

## 坑

- `ccBuildSuffix` 的输入是**规范化之前**的首条用户文本：`-p` 模式下出站 `messages[0].content[0]` 是 583B 的 `<system-reminder>`（attribution），真正的提示词在第 2 块。直接对出站首块哈希会得到错误后缀（本次先踩到 `a38` vs 观测 `6b4`，修成跳过 reminder 后 36/36 命中）。
- 2.1.316 的主提示词**随模型变**（opus 多 190B），`cc-profile.ts` 的 `mainPromptLen/mainPromptDigests` 必须按 (入口, 模型) 分档，不能只存一个值。
- 统计“样本数”要按 **主请求**算：cli 每次还有额度探针（无 system、无计费头）和标题请求（`output_config.format`），`profile-sample.mjs` 已按“有 system 且非结构化输出”筛主轮。

最后一行状态：

DONE
