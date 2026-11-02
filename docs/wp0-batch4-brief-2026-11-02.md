# WP0 第四批（交给 Pi）：采样 Claude Code 2.1.316 与 2.1.301 的请求 profile

## 为什么
灰度真实流量（2026-11-02）里 96% 的 Claude Code 请求来自没有采样 profile 的版本：2.1.316 与 2.1.301 合计 72%，其余 2.1.314 / 2.1.283 / 2.1.305 / 2.1.303 / 2.1.241。
`direct_profile_strict` 下这些请求全部判 `cc_profile_unknown` → 降级走 worker，直连形态数据为零。没有这两个版本的 profile，V2 的形态校验就测不到。

## 已备好的东西
- 二进制（linux-x64 官方 npm 包，已解包）：
  - `/home/ubuntu/claude-code-re/2.1.316/package/claude`（`--version` = 2.1.316）
  - `/home/ubuntu/claude-code-re/2.1.301/package/claude`（`--version` = 2.1.301）
  - 对照：`/home/ubuntu/claude-code-re/2.1.312/package/claude`（已采样）
- 探针工具链（上一批写的，全部对本地假上游，不碰真实上游、不碰服务器）：`tests/e2e/cc-probe/`
  - `run-gate.mjs`（sdk-cli / restricted 单次采样；`CC_PROBE_BIN`、`CC_PROBE_OUT` 环境变量可指定二进制与输出目录）
  - `profile-sample.mjs sdk-cli|restricted`（≥12 次 = 4 prompts × 3 models，折叠成 profile）
  - `profile-cli.mjs` + `capture-cli.py`（pty 下跑交互模式，得到 `cli` 入口的 profile）
  - `build-profiles.mjs`（合并为 `profiles.json`）、`scrub-evidence.mjs`（去敏）、`evidence.mjs`（生成 README）
  - 这些脚本里 `docs/evidence/cc-2.1.312` 与 `binaryVersion: "2.1.312"` 是写死的，需要参数化（如 `CC_PROBE_VERSION`、`CC_PROBE_OUT`），**保持对 2.1.312 的默认行为不变**。
- Bun 运行时：`/home/ubuntu/claude-code-re/bun-runtimes/1.4.4/package/bin`（跑 pnpm 测试时加到 PATH）。
- 参考成品：`docs/evidence/cc-2.1.312/profiles.json`、`docs/evidence/cc-2.1.312/README.md`、`docs/wp0-probe-handoff-2026-11-01.md`（上三批的做法与坑）。

## 要交付
1. `docs/evidence/cc-2.1.316/profiles.json` 与 `docs/evidence/cc-2.1.301/profiles.json`：各含 `cc-<ver>-cli`、`cc-<ver>-sdk-cli`（restricted 可选），每个 ≥12 样本；字段与 2.1.312 的完全一致（samples / betaSets / betaByModel / identityBlock(s) / mainPromptLen / mainPromptDigests / toolsDigest / tools / topLevelKeys / thinking / outputConfig / ccFields / byModel / requestShapes / evidence）。
2. 每个版本的传输常量：`x-stainless-runtime-version`（Bun 的 Node ABI 字串，2.1.312 是 v26.12.1）、`x-stainless-package-version`（SDK 版本，2.1.312 是 0.128.0）、UA 原文。写进 profiles.json 顶层 `transport` 字段。
3. **计费后缀核对**：对每个版本的样本，记录 `system[0]` 计费头的后缀是否等于 `ccBuildSuffix(出站 messages, 该版本)`（函数在 `packages/core/src/fingerprint.ts`，若它只支持 2.1.312 就如实写"算法未知"）。这决定直连能否改首条用户文本，不要猜。
4. `docs/evidence/cc-<ver>/README.md`（`evidence.mjs` 生成）并通过去敏校验（不含 `sk-ant-`、`@`、`/tmp/`、`/home/`）。
5. `docs/wp0-probe-handoff-2026-11-01.md` 追加"第四批"一节：做了什么、与 2.1.312 的差异（beta 集、identity、工具列表、顶层键序、thinking/output_config）、坑。
6. **不要**改 `packages/core/src/cc-profile.ts`（由我按你的 profiles.json 加条目并跑测试）；**不要** git commit；**不要**连服务器或真实上游；**不要**杀 PID 22701（用户自己的 pi 会话）。

## 做法提示
- 先把 2.1.312 的现有流程跑一遍确认环境还能用，再换二进制。
- 2.1.316 的解包 JS 在 `/home/ubuntu/claude-code-re/2.1.316/payload/`，可用来核对 beta 常量、identity 句、runtime 版本字串。
- 每个版本的采样输出放各自目录；完成后在 `docs/evidence/cc-<ver>/PROGRESS.md` 写一行状态，最后一行写 `DONE` 或 `BLOCKED: <原因>`。
