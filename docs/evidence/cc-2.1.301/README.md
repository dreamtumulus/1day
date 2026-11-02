# CC 2.1.301 探针证据（WP0 汇总，自动生成）

由 `node tests/e2e/cc-probe/evidence.mjs` 生成；逐项过程记录见 [PROGRESS.md](./PROGRESS.md)。

- 证据文件：40 个 JSON（`docs/evidence/cc-2.1.301/`）
- 生成时间：2026-11-02T05:50:08.131Z
- 脱敏校验（token 前缀 / 邮箱符号 / 临时目录 / 家目录路径）：通过（0 处命中）
- 所有 gate 的 CONNECT 目标：api.anthropic.com:443, raw.githubusercontent.com:443, downloads.claude.ai:443, github.com:443

| Gate | 结论 | 文件 | sampledAt | digest | spec 失败处置 | 是否触发 |
|---|---|---|---|---|---|---|
| G9 profile | 通过 | `profiles.json`<br>`profile-sdk-cli.json`<br>`profile-cc-2.1.301-cli.json`<br>`profile-restricted.json` | 2026-11-02T05:32:21.213Z | d7b4025cc4b69752 | 不做跨版本 pin | 未触发（按 2.1.301 三 profile 存证） |

## 采样概要（第四批：只采 profile）

| profile | samples | 身份句 | 主提示词长度 | tools | beta 组数 | 顶层键 | cc_* 字段 | 计费后缀核对 |
|---|---|---|---|---|---|---|---|---|
| `cc-2.1.301-cli` | 12 | 「You are Claude Code, Anthropic's official CLI for Claude.」 | 5854 / 27282 | 25 (`bd29b46fcf18e040`) | 2 | `model, messages, system, tools, metadata, max_tokens, thinking, context_management, safeguards, output_config, stream` | 0 | 12/12 命中 |
| `cc-2.1.301-sdk-cli` | 12 | 「You are a Claude agent, built on Anthropic's Claude Agent SDK.」 | 5599 / 27158 | 22 (`31bf2e21ce4230bb`) | 2 | `model, messages, system, tools, metadata, max_tokens, thinking, context_management, safeguards, output_config, stream` | 0 | 12/12 命中 |
| `cc-2.1.301-restricted` | 12 | 「You are a Claude agent, built on Anthropic's Claude Agent SDK.」 | 3513 / 14332 | 19 (`f1cdf9a8cdeb2acb`) | 2 | `model, messages, system, tools, metadata, max_tokens, thinking, context_management, safeguards, output_config, stream` | 0 | 12/12 命中 |

## 传输常量（二进制真实发出的请求头）

- `x-stainless-runtime-version`：`v26.3.0`
- `x-stainless-package-version`：`0.128.0`
- UA 原文：`claude-cli/2.1.301 (external, cli)`<br>`claude-cli/2.1.301 (external, sdk-cli)`

| profile | UA | x-stainless-runtime-version | x-stainless-package-version | os/arch/lang |
|---|---|---|---|---|
| cli | `claude-cli/2.1.301 (external, cli)` | `v26.3.0` | `0.128.0` | Linux/x64/js |
| sdk-cli | `claude-cli/2.1.301 (external, sdk-cli)` | `v26.3.0` | `0.128.0` | Linux/x64/js |
| restricted | `claude-cli/2.1.301 (external, sdk-cli)` | `v26.3.0` | `0.128.0` | Linux/x64/js |

## 计费后缀核对（system[0] 的 `x-anthropic-billing-header`）

- 算法：`sha256("59cf53e54c78" + firstUserText[4,7,20] + "2.1.301").slice(0,3)`（与 `packages/core/src/fingerprint.ts#ccBuildSuffix` 同盐、同取位、同截断；盐与取位在 2.1.301 客户端代码中逐字确认）
- 结果：带计费头样本 `36` 个，命中 `36`，不符 `0`（matchRate `36/36`）；headerVersion 均为 2.1.301：true
- 观测后缀：`b22` / `0b9` / `d5f` / `d39`；重算后缀：`b22` / `0b9` / `d5f` / `d39`
- 结论：该版本的计费后缀可由出站 messages 重算 → 直连改首条用户文本在该版本上没有形态障碍（仍需在 cc-profile 中登记版本并让 canEditFirstUserText 按版本放行）。

## 与 2.1.312 的差异

- `cc-2.1.301-cli`：身份句 不变；主提示词 5854/27282 → 5854/27282；beta +prompt-caching-scope-2026-01-05 / -advanced-tool-use-2025-11-20；tools 25（+CronCreate,CronDelete,CronList,DesignSync,EnterPlanMode,EnterWorktree,ExitPlanMode,ExitWorktree,NotebookEdit,RemoteTrigger,SendMessage,TaskStop,WebFetch,WebSearch / -ToolSearch,DeferredToolPlaceholder，digest 51d4b5a2143407cb → bd29b46fcf18e040）；顶层键序不变；thinking 不变；output_config 不变；cc_* 0 命中
- `cc-2.1.301-sdk-cli`：身份句 不变；主提示词 5599/26946 → 5599/27158；beta +prompt-caching-scope-2026-01-05,dangerous-tool-use-2026-09-03,afk-mode-2026-01-31 / -advanced-tool-use-2025-11-20；tools 22（+CronCreate,CronDelete,CronList,DesignSync,EnterWorktree,ExitWorktree,NotebookEdit,RemoteTrigger,SendMessage,TaskStop,WebFetch,WebSearch / -ToolSearch,DeferredToolPlaceholder，digest 2106a37964466cf3 → 31bf2e21ce4230bb）；顶层键 `model,messages,system,tools,metadata,max_tokens,thinking,context_management,output_config,stream` → `model,messages,system,tools,metadata,max_tokens,thinking,context_management,safeguards,output_config,stream`；thinking 不变；output_config 不变；cc_* 0 命中
- `cc-2.1.301-restricted`：身份句 不变；主提示词 3513/14138 → 3513/14332；beta +prompt-caching-scope-2026-01-05,dangerous-tool-use-2026-09-03,afk-mode-2026-01-31 / -advanced-tool-use-2025-11-20；tools 19（+CronDelete,CronList,DesignSync,EnterWorktree,ExitWorktree,NotebookEdit,SendMessage,TaskStop,WebSearch / -ToolSearch,DeferredToolPlaceholder，digest 60c5d5dd0a586e3a → f1cdf9a8cdeb2acb）；顶层键 `model,messages,system,tools,metadata,max_tokens,thinking,context_management,output_config,stream` → `model,messages,system,tools,metadata,max_tokens,thinking,context_management,safeguards,output_config,stream`；thinking 不变；output_config 不变；cc_* 0 命中

## 证据文件索引

| 文件 | gate | sampledAt | digest |
|---|---|---|---|
| `baseline-sdk-01.json` | baseline | 2026-11-02T05:32:21.213Z | d7b4025cc4b69752 |
| `baseline-sdk-02.json` | baseline | 2026-11-02T05:32:23.019Z | c8118551ee3c505d |
| `baseline-sdk-03.json` | baseline | 2026-11-02T05:32:24.834Z | f964177d46c74047 |
| `baseline-sdk-04.json` | baseline | 2026-11-02T05:32:26.676Z | ad63cc1bf2432f49 |
| `baseline-sdk-05.json` | baseline | 2026-11-02T05:32:28.509Z | 7212f1c1f48e26d2 |
| `baseline-sdk-06.json` | baseline | 2026-11-02T05:32:30.320Z | fa7054c2e9f93af3 |
| `baseline-sdk-07.json` | baseline | 2026-11-02T05:32:32.195Z | 2d2d11ee59805289 |
| `baseline-sdk-08.json` | baseline | 2026-11-02T05:32:33.975Z | 6001852b29b47409 |
| `baseline-sdk-09.json` | baseline | 2026-11-02T05:32:35.739Z | ecefc93f9cd60d01 |
| `baseline-sdk-10.json` | baseline | 2026-11-02T05:32:37.553Z | d375d794b3c5d6b2 |
| `baseline-sdk-11.json` | baseline | 2026-11-02T05:32:39.311Z | a13d1e6fe6267ca0 |
| `baseline-sdk-12.json` | baseline | 2026-11-02T05:32:41.094Z | 8c5d2dda23f8a055 |
| `profile-cc-2.1.301-cli.json` | cli | — | — |
| `profile-cli-cli-01.json` | profile-cli | 2026-11-02T05:38:17.975Z | 66e87c55624a26b8 |
| `profile-cli-cli-02.json` | profile-cli | 2026-11-02T05:38:42.995Z | 074d86b189d9bec6 |
| `profile-cli-cli-03.json` | profile-cli | 2026-11-02T05:39:07.852Z | 340042fd3911459d |
| `profile-cli-cli-04.json` | profile-cli | 2026-11-02T05:39:32.688Z | 136ceda0ec9c7691 |
| `profile-cli-cli-05.json` | profile-cli | 2026-11-02T05:39:57.519Z | e5a881e32f2d216f |
| `profile-cli-cli-06.json` | profile-cli | 2026-11-02T05:40:22.524Z | 87225f2fbf414579 |
| `profile-cli-cli-07.json` | profile-cli | 2026-11-02T05:40:47.622Z | 3b27a69fb82a93e0 |
| `profile-cli-cli-08.json` | profile-cli | 2026-11-02T05:41:12.649Z | 7f4feb3c806a83fd |
| `profile-cli-cli-09.json` | profile-cli | 2026-11-02T05:41:37.506Z | 362e7a9479fbec03 |
| `profile-cli-cli-10.json` | profile-cli | 2026-11-02T05:42:02.428Z | c7bf6a87a106546b |
| `profile-cli-cli-11.json` | profile-cli | 2026-11-02T05:42:27.492Z | 7e446ec9d2153889 |
| `profile-cli-cli-12.json` | profile-cli | 2026-11-02T05:42:52.415Z | 92345ed6b4cdc779 |
| `profile-restricted.json` | restricted | — | — |
| `profile-sdk-cli.json` | sdk-cli | — | — |
| `profiles.json` | — | — | — |
| `restricted-res-01.json` | restricted | 2026-11-02T05:43:24.714Z | 545ec3bd344528e5 |
| `restricted-res-02.json` | restricted | 2026-11-02T05:43:26.424Z | e9dc9e611456051a |
| `restricted-res-03.json` | restricted | 2026-11-02T05:43:28.165Z | c7e6dbbc667244ac |
| `restricted-res-04.json` | restricted | 2026-11-02T05:43:29.845Z | 80ae4efa179ab50f |
| `restricted-res-05.json` | restricted | 2026-11-02T05:43:32.150Z | 1414a0e60409c84b |
| `restricted-res-06.json` | restricted | 2026-11-02T05:43:33.869Z | 4556129361e8ff7f |
| `restricted-res-07.json` | restricted | 2026-11-02T05:43:35.583Z | 6a4091700326fd9a |
| `restricted-res-08.json` | restricted | 2026-11-02T05:43:37.299Z | d30df95f0a243523 |
| `restricted-res-09.json` | restricted | 2026-11-02T05:43:39.030Z | 480327c45288d585 |
| `restricted-res-10.json` | restricted | 2026-11-02T05:43:40.736Z | dff81acdfa030844 |
| `restricted-res-11.json` | restricted | 2026-11-02T05:43:42.467Z | 53ed4924a8ffc464 |
| `restricted-res-12.json` | restricted | 2026-11-02T05:43:44.164Z | 62ee929d00c4ae4a |
