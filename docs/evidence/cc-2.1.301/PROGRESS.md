# WP0 探针进度（cc-2.1.301）

任务书：`docs/wp0-batch4-brief-2026-11-02.md`（第四批）；模板：`docs/evidence/cc-2.1.312/PROGRESS.md`；做法与坑汇总：`docs/wp0-probe-handoff-2026-11-01.md` §7。
时间均为 UTC。只跑本机假上游（`127.0.0.1`）+ 拒绝式 CONNECT 代理 + 临时 HOME/假 OAuth；未连真实上游或服务器，未读真实凭据，未改 `packages/`。汇总视图（自动生成）：[README.md](./README.md)。

| 时间 (UTC) | 项 | 结论 | 文件 | 关键发现 |
|---|---|---|---|---|
| 05:28Z | 工具链参数化 | 完成 | `tests/e2e/cc-probe/{run-gate,profile-sample,profile-cli,build-profiles,scrub-evidence,evidence}.mjs`、新增 `billing.mjs`、`shape.mjs` | 新增 `CC_PROBE_VERSION`（默认 `2.1.312`）与 `CC_PROBE_OUT`（默认 `docs/evidence/cc-2.1.312`），`CC_PROBE_BIN` 默认路径随版本走；不设变量时行为与 2.1.312 完全一致（`evidence.mjs --check` 复跑 125 文件、G1–G10 结论不变）。`billing.mjs` 复刻 `ccBuildSuffix` 并在每次采样时对照真实计费头。 |
| 05:32Z | sdk-cli 采样 | 通过 | `baseline-sdk-01..12.json` → `profile-sdk-cli.json` | 12 次（4 提示词 × 3 模型）全成功；身份句 `You are a Claude agent, built on Anthropic's Claude Agent SDK.`；system 恒 3 块 `[74,62,N]`：主提示词 5599（sonnet/opus）/ 27158（haiku）；tools **22**（`31bf2e21ce4230bb`；haiku 26，多 `TaskCreate/TaskGet/TaskList/TaskUpdate`）——远多于 2.1.312 的 12；顶层 **11** 键，`safeguards` 在 `context_management` 之后；beta 12（sonnet/opus，含 `prompt-caching-scope-2026-01-05`、`dangerous-tool-use-2026-09-03`、`afk-mode-2026-01-31`，无 `advanced-tool-use-2025-11-20`）/ 8（haiku）。 |
| 05:38Z | cli 采样（pty） | 通过 | `profile-cli-cli-01..12.json` → `profile-cc-2.1.301-cli.json` | 12 次全成功；身份句 `You are Claude Code, Anthropic's official CLI for Claude.`；system `[70,57,N]`：主提示词 5854（sonnet/opus）/ 27282（haiku）；tools **25**（`bd29b46fcf18e040`；haiku 29，同样多 4 个 Task 工具）；顶层 11 键含 `safeguards`；beta 12/8，与 sdk-cli 同集；每次另发 1 条 `max_tokens:1` 无 system 额度探针 + 1 条标题生成请求。 |
| 05:43Z | restricted 采样 | 通过 | `restricted-res-01..12.json` → `profile-restricted.json` | 12 次全成功；主提示词 3513（sonnet/opus）/ 14332（haiku）；tools **19**（`f1cdf9a8cdeb2acb`；haiku 23）；无 Bash/Workflow/ToolSearch，含 Glob/Grep；顶层 11 键含 `safeguards`。 |
| 05:44Z | 传输常量 | 通过 | `profiles.json.transport` | `x-stainless-runtime-version` = **`v26.3.0`**（打包 Bun 1.4.3 的 Node ABI 串，2.1.312/2.1.316 是 `v26.12.1`）、`x-stainless-package-version` = **`0.128.0`**、UA 原文 `claude-cli/2.1.301 (external, sdk-cli)` / `claude-cli/2.1.301 (external, cli)`（`x-app: cli`、`x-stainless-os: Linux`、`x-stainless-arch: x64`）。 |
| 05:45Z | 计费后缀核对 | 通过（36/36 样本） | 每份样本 JSON 的 `requests[].billing`；`profiles.json.billingSuffix` | 盐/取位与算法在 2.1.301 二进制内嵌 JS 中逐字确认（`var XB="59cf53e54c78"`、`[4,7,20]`、`+VERSION`）；**36 个主请求全部命中**（48 个带计费头的请求 48/48 命中，0 不符）。哈希对象是 pre-normalization 的首条用户文本，须跳过 `<system-reminder>` 块。 |
| 05:46Z | 与 2.1.312 差异 | 完成 | `profiles.json` / `README.md` | 见下节；核心：beta 集换入 `prompt-caching-scope-2026-01-05`、移除 `advanced-tool-use-2025-11-20`；工具表大幅增加（22/25/19）；`safeguards` 进入所有入口的顶层键；主提示词 5599/5854 保持不变。 |
| 05:46Z | 汇总/去敏 | 通过 | `tests/e2e/cc-probe/evidence.mjs` → `README.md` | `profilesOnly` 模式（无 G1–G10 gate 文件）只汇总 profile/transport/billing；40 个 JSON 脱敏校验 0 命中，README 本身也不含 token 前缀 / 邮箱符号 / 临时目录 / 家目录字面量。 |

## 与 2.1.312 的差异（实测）

- **身份句**：无变化（sdk-cli/restricted = `You are a Claude agent, built on Anthropic's Claude Agent SDK.`；cli = `You are Claude Code, Anthropic's official CLI for Claude.`）。
- **beta 集/顺序**：`prompt-caching-scope-2026-01-05` 插到第 6 位（sonnet/opus），`advanced-tool-use-2025-11-20` 消失；`dangerous-tool-use-2026-09-03`、`afk-mode-2026-01-31` 现在 sdk-cli 也有（2.1.312 仅 cli 有）。sdk-cli/restricted 12 个、cli 12 个、haiku 8 个。
- **tools**：sdk-cli 12→**22**、cli 13→**25**、restricted 12→**19**。新增 `CronCreate/CronDelete/CronList/DesignSync/EnterWorktree/ExitWorktree/NotebookEdit/RemoteTrigger/SendMessage/TaskStop/WebFetch/WebSearch` 等，移除 `ToolSearch/DeferredToolPlaceholder`；haiku 再额外多 `TaskCreate/TaskGet/TaskList/TaskUpdate`（+4）。cli 保留 `EnterPlanMode/ExitPlanMode/AskUserQuestion/Workflow`。
- **顶层键序**：sdk-cli/restricted 由 10 键变 **11 键**，`safeguards` 在 `context_management` 之后、`output_config` 之前；cli 同样 11 键（与 2.1.312 cli 相同）。
- **主提示词**：sdk-cli 5599（sonnet/opus，与 2.1.312 相同）/ 27158（haiku，2.1.312 是 26946）；cli 5854/27282（与 2.1.312 相同）；restricted 3513/14332（与 2.1.312 相同）。**不像 2.1.316 那样按模型分档**（sonnet=opus）。
- **thinking / output_config / max_tokens**：不变（adaptive+display:updates；haiku enabled+31999/32000；`output_config` 仅标题请求带 `format`）。
- **cc_\* 字段**：60 个请求中 0 命中（本地假上游下 `cch` 等 first-party-only 字段不出现，不能据此断言线上）。
- **传输常量**：runtime `v26.3.0`（Bun 1.4.3）与 2.1.312 的 `v26.12.1` 不同；SDK 仍 `0.128.0`。

## 坑

- `ccBuildSuffix` 的输入是**规范化之前**的首条用户文本：`-p` 模式下出站 `messages[0].content[0]` 是 `<system-reminder>`（attribution），真正的提示词在第 2 块。直接对出站首块哈希会算错；`fingerprint.ts` 已跳过 `<system-reminder>`，`billing.mjs` 按同一规则复刻后 36/36 命中。
- 2.1.301 的 tools **随模型变**（haiku 多 4 个 Task 工具），`cc-profile.ts` 的工具表/digest 必须按 (入口, 模型) 分档，不能只按入口存一份。
- 2.1.301 所有入口顶层都带 `safeguards`，若 profile 校验按“键集合完全相等”判，会把 sdk-cli 误判成 cli。
- 统计“样本数”要按 **主请求**算：cli 每次还有额度探针（无 system、无计费头）和标题请求（`output_config.format`），`profile-sample.mjs` 已按“有 system 且非结构化输出”筛主轮。

最后一行状态：

DONE
