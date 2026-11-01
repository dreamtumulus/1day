# WP0 探针任务书（交给 KIMI CODE / Pi 执行，2026-11-01）

> 上位文档：`docs/canonical-implementation-spec-2026-11-01.md` §7（P0 实证门）与 §8 WP0。本文只负责"探针与证据"，**不改任何生产代码、不碰生产服务器**。
> 约束：`docs/iron-rules.md`、`docs/operations.md` §7.1（测试铁律）。违反任一条即停。

## 0. 绝对禁止

1. **不得使用任何真实 OAuth / access token**，不得让二进制连到 `api.anthropic.com` 或任何真实上游。探针只打本机假上游（`ANTHROPIC_BASE_URL=http://127.0.0.1:<port>`），CONNECT 代理只记录、必拒绝。
2. 不得读取、复制 `/var/lib/1dayapi-cc-worker/`、`~/.claude/`、`.credentials.json`、`data/` 等任何真实凭据或账号目录；探针用临时 HOME + 假凭据（脚本已内置）。
3. 不得登录 `89.117.17.224` / worker 节点；不得修改 `apps/`、`packages/` 下的代码；只允许写 `tests/e2e/cc-probe/` 与 `docs/evidence/cc-2.1.312/`。
4. 证据文件只存**结构**（长度、前缀、digest、键名），不存完整提示词全文、不存任何 token / 邮箱 / 真实路径（临时路径以 `<tmp-path>` 替代）。

## 1. 已有资产（勿重复造）

| 文件 | 作用 |
|---|---|
| `tests/e2e/cc-probe/run-gate.mjs` | 启动真实 CC 2.1.312（`/home/ubuntu/claude-code-re/2.1.312/package/claude`），临时 HOME/`CLAUDE_CONFIG_DIR`、假 OAuth、假上游、拒绝式 CONNECT 代理；`node tests/e2e/cc-probe/run-gate.mjs <gate>` 写 `docs/evidence/cc-2.1.312/<gate>.json` |
| `tests/e2e/cc-probe/mock-upstream-capture.mjs` | 假上游：记录 headers+body，回最小 SSE；可模拟首轮 tool_use（`firstToolUse`）与 `--json-schema` 回答 |
| `docs/evidence/cc-2.1.312/*.json`（13 份，2026-11-01 12:51–12:59Z） | 已跑：baseline / append / restricted / schema / streamjson / history-first / session / attachments / restricted-read-creds / restricted-read-hostname / restricted-bash / unrestricted-read-creds |
| `ops/cc-capture/capture-interactive.py` | 伪终端交互模式采样（entrypoint=cli 必须用它，`-p` 只能得到 sdk-cli） |
| 运行时 | Bun：`/home/ubuntu/claude-code-re/bun-runtimes/1.4.4/package/bin/bun`；Node 22 |

## 2. 已得结论（请在报告里复核，不要推翻只需确认）

| Gate | 结论 | 证据 |
|---|---|---|
| G1 append | **通过**：`--append-system-prompt-file` 保留计费头 + 身份句 + 主提示词，追加文本进入主提示词块尾部（5599→5655 字节，`hasMarker=true`）；身份句变为 "You are Claude Code, …, running within the Claude Agent SDK." | `append.json` vs `baseline.json` |
| G2 stream-json | **部分**：stdin 接受 `assistant` 角色注入，并原样进入下一轮 messages（REQ1 出现 `OK` + `INJECTED-ASSISTANT-TEXT` 两个连续 assistant 块）。**但**首条 user 一进来就触发真实 API 调用（REQ0），即"先喂历史"不是零成本导入 | `streamjson.json`、`history-first.json` |
| G6 restricted | **通过**：`--restricted` 下 Read 越界 → `… is outside <work>`；Bash → `No such tool available: Bash`；非 restricted 时 `--permission-prompts none` 下读凭据被 permission_denied | `restricted-*.json`、`unrestricted-read-creds.json` |
| G8 schema | **通过**：`--json-schema` 增加 1 个工具（12→13，StructuredOutput），第二轮注入 `[structured-output-enforce]` 用户块 | `schema.json` |
| G10-A（结构） | 所有 gate 的 CONNECT 尝试目标只有 `api.anthropic.com:443`（10～12 次/run），即遥测/bootstrap 不跟 `ANTHROPIC_BASE_URL`，与 spec §7 G10"INGEST_URL 硬编码"一致 | 各文件 `connectAttempts` |
| profile(sdk-cli) | UA `claude-cli/2.1.312 (external, sdk-cli)`；beta 顺序：`claude-code-20250219, oauth-2025-04-20, interleaved-thinking-2025-05-14, context-management-2025-06-27, per-turn-control-2026-07-01, thinking-token-count-2026-05-13, advanced-tool-use-2025-11-20, effort-2025-11-24, thinking-display-updates-2026-08-18, extended-cache-ttl-2025-04-11`；顶层键 `model, messages, system, tools, metadata, max_tokens, thinking, context_management, output_config, stream`；`thinking={type:adaptive,display:updates}`；默认 12 工具；`--restricted` 主提示词 3513 vs 默认 5599 | `baseline.json`、`restricted.json` |
| attachments | 不设 `CLAUDE_CODE_DISABLE_ATTACHMENTS` 时多一条 9509 字节的 `# Environment` system 消息（messages 内 role=system）；没有 `# userEmail`（假凭据无邮箱，**需用带 emailAddress 的假 `.claude.json` 重跑一次确认是否出现**） | `attachments.json` |

## 3. 待做（按顺序，每项有机器可验产出）

### T1 G4 resume（必做）
```bash
CC_PROBE_KEEP=1 node tests/e2e/cc-probe/run-gate.mjs session     # 输出 {home, session}
CC_PROBE_HOME=<home> CC_PROBE_SESSION=<session> node tests/e2e/cc-probe/run-gate.mjs resume
```
通过标准：`resume.json` 的 REQ0 messages 含第一轮 user + assistant("OK") + 第二轮 user，**无重复**、无缺失；`system/init` 的 session_id 等于传入值。再做一次"进程被 SIGKILL 后 resume"：在 `run-gate.mjs` 增加 gate `session-kill`（首轮收到 `assistant` 事件后立刻 `SIGKILL`），随后 `resume`，记录 transcript 是否丢最后一轮。

### T2 G5 工具中断（必做）
新增 gate `tool-interrupt`：假上游首轮回 `tool_use`（用 `firstToolUse`，工具名用 MCP 形态 `mcp__caller__lookup` 需先给进程一个假 MCP server——可用 `--mcp-config` 指向 `apps/provider-node/src/mcp-server.ts` 的最小仿品，或先用内置 `Read`），在进程等待工具结果时 `SIGKILL`，然后 `--resume`。记录：resume 后 messages 里 tool_use 是否仍在、是否补发 tool_result、是否重复执行。失败处置见 spec §7 G5（409 `tool_continuation_lost`）。

### T3 G3 外部历史导入（必做）
目标：构造一份 **CC 原生 transcript**（`~/.claude/projects/<cwd-hash>/<session>.jsonl` 格式，样本从 T1 的 `home` 里取——**不要**去节点取真实样本），包含 user / assistant(text) / assistant(tool_use) / user(tool_result) / assistant(thinking+signature) 五类，写入新 HOME，再 `--resume <session>` 看二进制是否读取并把全部历史发到假上游。矩阵：五类各一份 + 组合一份。产出 `history-import-<case>.json` 与一份 `docs/evidence/cc-2.1.312/G3-matrix.md`（哪类能导、哪类被丢、thinking signature 是否被校验）。

### T4 G9 profile 采样 ≥12 次 × 3 profile（必做）
- `sdk-cli`：`run-gate.mjs baseline` 换 ≥4 种提示词 × 3 模型（`claude-sonnet-5-5` / `claude-opus-5-5` / `claude-haiku-4-5`），记录 beta 集与顺序、tools 名单、system 三块长度/digest、顶层键顺序、`thinking`、`output_config`、`cc_*` 字段（看 body 里是否出现 `cch`/`cc_prev_req`/`cc_prompt_id`/`cc_turn_origin`——目前 0 次，需确认）。
- `restricted`：同上加 `--restricted --permission-prompts none`。
- `cli`：用 `ops/cc-capture/capture-interactive.py`（伪终端），指向同一个假上游与假 HOME，≥12 次；重点：身份句 `You are Claude Code, Anthropic's official CLI for Claude.`、beta 集（compat.md §11 记录含 `mid-conversation-tool-changes-2026-07-01`、`dangerous-tool-use-2026-09-03`、`afk-mode-2026-01-31`，需实测确认）、辅助请求（无 system 小请求、标题生成 structured-outputs）。
- 产出：`docs/evidence/cc-2.1.312/profiles.json`，结构：
  ```json
  { "cc-2.1.312-cli": { "samples": 12, "betaSets": [["…"]], "betaByModel": {"claude-opus-5-5": ["…"]}, "identityBlock": "…", "mainPromptLen": [..], "mainPromptDigests": ["…"], "toolsDigest": "…", "topLevelKeys": ["…"], "ccFields": [], "evidence": [{"file": "…", "sampledAt": "…", "digest": "…"}] }, "cc-2.1.312-sdk-cli": {…}, "cc-2.1.312-restricted": {…} }
  ```
  这份 JSON 是 `packages/core/src/cc-profile.ts` 的数据源，字段名请严格照上。

### T5 G10-B 取证 PoC（尽力）
只回答一个问题：Bun 1.4.4 打包的 CC 二进制是否尊重 `SSLKEYLOGFILE`（能否在**受控测试代理**上解出遥测请求内容）。方法：仍用假上游 + 本机自建 TLS 终结（自签证书 + `NODE_EXTRA_CA_CERTS`），看 `/api/event_logging/v2/batch`、`/api/claude_cli_feedback`、bootstrap 请求的 header/body 结构。**不得**连真实上游。产出 `telemetry-structure.json` + 一段结论（能/不能、怎么做）。

### T6 `evidence.mjs` 汇总器（必做）
`tests/e2e/cc-probe/evidence.mjs`：读 `docs/evidence/cc-2.1.312/*.json`，输出 `docs/evidence/cc-2.1.312/README.md`：G1–G10 每个 gate 一行（结论 / 文件 / sampledAt / digest / 失败处置是否触发），并校验所有文件不含 `sk-ant-`、`@`、`/tmp/`、`/home/` 字样（有则 exit 1）。

## 4. 回报格式

一条消息，按 T1–T6 逐项：通过/失败/未做 + 文件名 + 一句关键发现。失败的 gate 把 `stdoutTail` / `stderrTail` 贴上。不要贴完整 JSON。

## 5. 与开发侧的接口

- 开发侧（本会话）正在做 WP1（车道 A profile / Key 白名单 / 再校验）与 Key policy 两层结构，**只依赖 T4 的 `profiles.json`**（用于填 `CC_PROFILES` 表）；T4 没出来之前用 `baseline.json`/compat.md §11 的值占位，字段 `evidence[].source` 标 `interim`。
- T1–T3 的结论决定 WP3 的方案选择（stream-json 续轮 / transcript 导入 / 明确拒绝），请把"不能做"写得和"能做"一样清楚。


## 6. 第二批（2026-11-01 晚，开发侧 WP2/WP3 落地后新增；同样只用假上游、假凭据）

### T7 `--resume` + `--input-format stream-json`（WP3 依赖，必做）
节点 canonical 续轮失配时用 `claude -p --resume <id> --input-format stream-json --output-format stream-json …`，新一轮从 stdin 喂。Pi 的 T1 用的是位置参数提示词。
请在 `run-gate.mjs` 增 gate `resume-streamjson`：第一步 `session` 落 transcript，第二步以上述参数 resume 且只喂一条 `{"type":"user",…}`。通过标准：REQ0 messages = 历史 + 新一轮，无重复、无 "No response requested."。

### T8 `--append-system-prompt-file` × `--resume`（必做）
resume 时再次带 `--append-system-prompt-file`：追加文本是否只出现一次（主提示词块尾部），还是被重复追加。记录 system 三块长度。

### T9 historyImport 真机验证（必做）
用 `apps/gateway/dist/ccr/native-session.js` 的 `buildNativeTranscript`（node 可直接 import）把一段含 tool_use/tool_result 的客户 messages 生成 transcript，按 T3 方法写入后 `--resume` + stdin 新一轮；确认工具对与顺序保真、无 thinking。

### T10 `mid-conversation-tool-changes-2026-07-01` 触发条件（选做）
cli 入口 12 次采样未见该 beta，而 10-28 采样见过；试 `--mcp-config` 带一个假 MCP server 的交互会话，看是否出现。结论写进 `profiles.json` 的 `betaPolicy.byFeature`。
