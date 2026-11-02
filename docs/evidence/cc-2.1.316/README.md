# CC 2.1.316 探针证据（WP0 汇总，自动生成）

由 `node tests/e2e/cc-probe/evidence.mjs` 生成；逐项过程记录见 [PROGRESS.md](./PROGRESS.md)。

- 证据文件：40 个 JSON（`docs/evidence/cc-2.1.316/`）
- 生成时间：2026-11-02T05:50:08.072Z
- 脱敏校验（token 前缀 / 邮箱符号 / 临时目录 / 家目录路径）：通过（0 处命中）
- 所有 gate 的 CONNECT 目标：api.anthropic.com:443, raw.githubusercontent.com:443, downloads.claude.ai:443, github.com:443

| Gate | 结论 | 文件 | sampledAt | digest | spec 失败处置 | 是否触发 |
|---|---|---|---|---|---|---|
| G9 profile | 通过 | `profiles.json`<br>`profile-sdk-cli.json`<br>`profile-cc-2.1.316-cli.json`<br>`profile-restricted.json` | 2026-11-02T05:31:52.063Z | 7f019c0df399afd7 | 不做跨版本 pin | 未触发（按 2.1.316 三 profile 存证） |

## 采样概要（第四批：只采 profile）

| profile | samples | 身份句 | 主提示词长度 | tools | beta 组数 | 顶层键 | cc_* 字段 | 计费后缀核对 |
|---|---|---|---|---|---|---|---|---|
| `cc-2.1.316-cli` | 12 | 「You are Claude Code, Anthropic's official CLI for Claude.」 | 5758 / 5948 / 27282 | 13 (`51d4b5a2143407cb`) | 2 | `model, messages, system, tools, metadata, max_tokens, thinking, context_management, safeguards, output_config, stream` | 0 | 12/12 命中 |
| `cc-2.1.316-sdk-cli` | 12 | 「You are a Claude agent, built on Anthropic's Claude Agent SDK.」 | 5503 / 5693 / 26946 | 12 (`2106a37964466cf3`) | 2 | `model, messages, system, tools, metadata, max_tokens, thinking, context_management, output_config, stream` | 0 | 12/12 命中 |
| `cc-2.1.316-restricted` | 12 | 「You are a Claude agent, built on Anthropic's Claude Agent SDK.」 | 3417 / 3607 / 14138 | 12 (`60c5d5dd0a586e3a`) | 2 | `model, messages, system, tools, metadata, max_tokens, thinking, context_management, output_config, stream` | 0 | 12/12 命中 |

## 传输常量（二进制真实发出的请求头）

- `x-stainless-runtime-version`：`v26.12.1`
- `x-stainless-package-version`：`0.128.0`
- UA 原文：`claude-cli/2.1.316 (external, cli)`<br>`claude-cli/2.1.316 (external, sdk-cli)`

| profile | UA | x-stainless-runtime-version | x-stainless-package-version | os/arch/lang |
|---|---|---|---|---|
| cli | `claude-cli/2.1.316 (external, cli)` | `v26.12.1` | `0.128.0` | Linux/x64/js |
| sdk-cli | `claude-cli/2.1.316 (external, sdk-cli)` | `v26.12.1` | `0.128.0` | Linux/x64/js |
| restricted | `claude-cli/2.1.316 (external, sdk-cli)` | `v26.12.1` | `0.128.0` | Linux/x64/js |

## 计费后缀核对（system[0] 的 `x-anthropic-billing-header`）

- 算法：`sha256("59cf53e54c78" + firstUserText[4,7,20] + "2.1.316").slice(0,3)`（与 `packages/core/src/fingerprint.ts#ccBuildSuffix` 同盐、同取位、同截断；盐与取位在 2.1.316 客户端代码中逐字确认）
- 结果：带计费头样本 `36` 个，命中 `36`，不符 `0`（matchRate `36/36`）；headerVersion 均为 2.1.316：true
- 观测后缀：`057` / `39e` / `3c9` / `1f8`；重算后缀：`057` / `39e` / `3c9` / `1f8`
- 结论：该版本的计费后缀可由出站 messages 重算 → 直连改首条用户文本在该版本上没有形态障碍（仍需在 cc-profile 中登记版本并让 canEditFirstUserText 按版本放行）。

## 与 2.1.312 的差异

- `cc-2.1.316-cli`：身份句 不变；主提示词 5854/27282 → 5758/5948/27282；beta 无新增；tools 13（无新增，digest 51d4b5a2143407cb → 51d4b5a2143407cb）；顶层键序不变；thinking 不变；output_config 不变；cc_* 0 命中
- `cc-2.1.316-sdk-cli`：身份句 不变；主提示词 5599/26946 → 5503/5693/26946；beta 无新增；tools 12（无新增，digest 2106a37964466cf3 → 2106a37964466cf3）；顶层键序不变；thinking 不变；output_config 不变；cc_* 0 命中
- `cc-2.1.316-restricted`：身份句 不变；主提示词 3513/14138 → 3417/3607/14138；beta 无新增；tools 12（无新增，digest 60c5d5dd0a586e3a → 60c5d5dd0a586e3a）；顶层键序不变；thinking 不变；output_config 不变；cc_* 0 命中

## 证据文件索引

| 文件 | gate | sampledAt | digest |
|---|---|---|---|
| `baseline-sdk-01.json` | baseline | 2026-11-02T05:31:52.063Z | 7f019c0df399afd7 |
| `baseline-sdk-02.json` | baseline | 2026-11-02T05:31:53.888Z | b63ae42efa5fc8a4 |
| `baseline-sdk-03.json` | baseline | 2026-11-02T05:31:55.687Z | a1d5ff82a65ffe28 |
| `baseline-sdk-04.json` | baseline | 2026-11-02T05:31:57.435Z | 62a415f51bf8b94b |
| `baseline-sdk-05.json` | baseline | 2026-11-02T05:31:59.213Z | 3c105edeb487962d |
| `baseline-sdk-06.json` | baseline | 2026-11-02T05:32:01.017Z | 2c553951073d4edf |
| `baseline-sdk-07.json` | baseline | 2026-11-02T05:32:02.832Z | 06b408bdcea69c81 |
| `baseline-sdk-08.json` | baseline | 2026-11-02T05:32:04.622Z | a96c7cd77b84bd78 |
| `baseline-sdk-09.json` | baseline | 2026-11-02T05:32:06.424Z | c52a629af0a8cb93 |
| `baseline-sdk-10.json` | baseline | 2026-11-02T05:32:08.364Z | 383b151105e81307 |
| `baseline-sdk-11.json` | baseline | 2026-11-02T05:32:10.223Z | d07134f37ecd7d34 |
| `baseline-sdk-12.json` | baseline | 2026-11-02T05:32:12.032Z | 785fdc24aaddfac4 |
| `profile-cc-2.1.316-cli.json` | cli | — | — |
| `profile-cli-cli-01.json` | profile-cli | 2026-11-02T05:33:11.565Z | 8b68d6aac53edad8 |
| `profile-cli-cli-02.json` | profile-cli | 2026-11-02T05:33:36.660Z | 063669a13406038f |
| `profile-cli-cli-03.json` | profile-cli | 2026-11-02T05:34:01.662Z | e38499cdb0f259b9 |
| `profile-cli-cli-04.json` | profile-cli | 2026-11-02T05:34:26.677Z | a95152261e8a41e3 |
| `profile-cli-cli-05.json` | profile-cli | 2026-11-02T05:34:51.571Z | 2c89912f9cef36a3 |
| `profile-cli-cli-06.json` | profile-cli | 2026-11-02T05:35:16.514Z | 8ede242525e25125 |
| `profile-cli-cli-07.json` | profile-cli | 2026-11-02T05:35:41.576Z | f8f4a1af3c448204 |
| `profile-cli-cli-08.json` | profile-cli | 2026-11-02T05:36:06.501Z | bc15ece44adcc938 |
| `profile-cli-cli-09.json` | profile-cli | 2026-11-02T05:36:31.560Z | f4b9b9f6da65d108 |
| `profile-cli-cli-10.json` | profile-cli | 2026-11-02T05:36:56.558Z | 67541fa53ca0235f |
| `profile-cli-cli-11.json` | profile-cli | 2026-11-02T05:37:21.419Z | 740a6a4bdd2872dd |
| `profile-cli-cli-12.json` | profile-cli | 2026-11-02T05:37:46.337Z | 8d25b880b13516a8 |
| `profile-restricted.json` | restricted | — | — |
| `profile-sdk-cli.json` | sdk-cli | — | — |
| `profiles.json` | — | — | — |
| `restricted-res-01.json` | restricted | 2026-11-02T05:42:59.280Z | 210898cbf27e7e89 |
| `restricted-res-02.json` | restricted | 2026-11-02T05:43:01.048Z | 266169ee48e05813 |
| `restricted-res-03.json` | restricted | 2026-11-02T05:43:02.789Z | eca103fedf9e63a5 |
| `restricted-res-04.json` | restricted | 2026-11-02T05:43:04.595Z | 404eab4b0a3e0fd7 |
| `restricted-res-05.json` | restricted | 2026-11-02T05:43:06.360Z | 94f2994eb174a7c3 |
| `restricted-res-06.json` | restricted | 2026-11-02T05:43:08.133Z | 770cd4afcd058c7f |
| `restricted-res-07.json` | restricted | 2026-11-02T05:43:09.939Z | 297efa7d3abdfa49 |
| `restricted-res-08.json` | restricted | 2026-11-02T05:43:11.704Z | 3abadd408c592077 |
| `restricted-res-09.json` | restricted | 2026-11-02T05:43:13.468Z | 7931ec3ff652493e |
| `restricted-res-10.json` | restricted | 2026-11-02T05:43:15.255Z | 137492f93e69d7e1 |
| `restricted-res-11.json` | restricted | 2026-11-02T05:43:17.022Z | 854ba3989a5289e4 |
| `restricted-res-12.json` | restricted | 2026-11-02T05:43:18.775Z | adf6fd43a0e174fb |
