# CC 2.1.312 探针证据（WP0 汇总，自动生成）

由 `node tests/e2e/cc-probe/evidence.mjs` 生成；逐项过程记录见 [PROGRESS.md](./PROGRESS.md)，
G3 见 [G3-matrix.md](./G3-matrix.md)，G10-B 见 [G10-B-mitm.md](./G10-B-mitm.md)。

- 证据文件：86 个 JSON（`docs/evidence/cc-2.1.312/`）
- 生成时间：2026-11-01T14:00:59.197Z
- 脱敏校验（`sk-ant-` / `@` / `/tmp/` / `/home/`）：通过（0 处命中）
- 所有 gate 的 CONNECT 目标：api.anthropic.com:443, raw.githubusercontent.com:443, downloads.claude.ai:443, github.com:443

| Gate | 结论 | 文件 | sampledAt | digest | spec 失败处置 | 是否触发 |
|---|---|---|---|---|---|---|
| G1 append | 通过 | `append.json`<br>`baseline.json` | 2026-11-01T12:52:05.691Z | d9abf4cfc19ff263 | 改用 caller-instructions / mid-conversation system | 未触发（追加位可用，客户 system 不进 argv） |
| G2 stream-json | 部分 | `streamjson.json`<br>`history-first.json` | 2026-11-01T12:52:21.942Z | bc8b20e17261811f | 不假设 assistant 注入；历史走 G3 | 未触发（assistant 注入被接受并原样入下一轮） |
| G3 history import | 通过（thinking 需剥离） | `history-import-user.json`<br>`history-import-assistant-text.json`<br>`history-import-tool-use.json`<br>`history-import-thinking-last.json`<br>`history-import-thinking-earlier.json`<br>`history-import-thinking-nosig.json`<br>`history-import-thinking-badsig.json`<br>`history-import-combined.json` | — | — | `history_import_unsupported` / historyPolicy=reset | 未触发（可导），但必须新增 thinking 剥离策略 |
| G4 resume | 部分（有会话丢失窗口） | `session.json`<br>`resume.json`<br>`resume-2.json`<br>`session-kill.json`<br>`resume-kill.json`<br>`session-kill-midflight.json`<br>`resume-midflight-early.json`<br>`session-kill-midflight-nofile.json`<br>`resume-midflight-nofile.json` | 2026-11-01T13:32:43.460Z | 1dc146d715e00882 | 不启用 native 灰度 | 未触发（可启用），需自建 DIRTY/LOST 状态机覆盖无 transcript 的崩溃窗口 |
| G5 tool interrupt | 通过 | `tool-interrupt.json`<br>`resume-mcp.json`<br>`tool-interrupt-builtin.json`<br>`resume-builtin.json` | 2026-11-01T13:36:02.262Z | 1b0ca9d56d4087fc | 409 `tool_continuation_lost` | 未触发（原生补 is_error tool_result、不重跑），caller 工具仍建议保留 409 兜底 |
| G6 restricted | 通过 | `restricted.json`<br>`restricted-read-creds.json`<br>`restricted-read-hostname.json`<br>`unrestricted-read-creds.json` | 2026-11-01T12:58:03.468Z | 765398c2f2eb6b92 | 只用 tools-disabled-canonical | 未触发 |
| G7 Bash | 通过 | `restricted-bash.json` | 2026-11-01T12:58:08.153Z | 70937ed772f9043c | 本期不开放 | 未触发（restricted 无 Bash 工具） |
| G8 --json-schema | 通过 | `schema.json` | 2026-11-01T12:52:09.848Z | 783aebc3dba18912 | `response_format` → `unsupported_parameter` | 未触发（schema 可解析，13 工具） |
| G9 profile | 通过 | `profiles.json`<br>`profile-sdk-cli.json`<br>`profile-cc-2.1.312-cli.json`<br>`profile-restricted.json` | 2026-11-01T13:38:17.125Z | a7ee6bfee5066e70 | 不做跨版本 pin | 未触发（按 2.1.312 三 profile 存证） |
| G10-A structure | 通过 | `baseline.json` | 2026-11-01T12:51:36.551Z | abfc9681a66e170b | `unknown` 不开放 | 未触发 |
| G10-B acceptance | 通过（CA 注入，无需 keylog） | `telemetry-structure.json` | 2026-11-01T13:47:25.009Z | afabb380a0ab0a0f | `unknown` 不开放 | 未触发（结构可取证；真实受理仍需专用测试账号） |

## 关键结论

- **G1** 追加式客户 system 可用：`--append-system-prompt-file` 后主提示词 5599→5655，计费头与身份句保留。
- **G2** stdin 接受 `assistant` 注入并原样进入下一轮，但首条 user 立即触发真实调用 → 不能当零成本历史导入。
- **G3** 外部构造 transcript 的 8 个 case 全部被 `--resume` 读入（含 tool_use/tool_result 配对）；thinking **零校验**（假签名/无签名/垃圾签名原样转发）→ 线上必须剥离。
- **G4** 正常 resume 无丢无重（`system/init.session_id` == 传入值）；SIGKILL 后：收到 assistant 前被杀会**丢掉整个 transcript**（`No conversation found`），user 已落盘则 resume 伪造 `assistant:"No response requested."`；cwd 变化会追加 `# Environment update` system 块。
- **G5** caller 工具 parked 时被杀：resume 保留 `tool_use`、**不重发** tools/call，补 `tool_result{is_error:true,"Tool call interrupted…"}`；内置 Bash 同理不重跑。
- **G6/G7** `--restricted` 下读凭据/`/etc/hostname` 全败、Bash 不可用（工具表也去掉 Bash/Workflow，换成 Glob/Grep）。
- **G8** `--json-schema` 工具 12→13（StructuredOutput），第二轮注入结构化约束块。
- **G9** cc-2.1.312-cli: 12 次 / 2 组 beta / identity 「You are Claude Code, Anthropic's official CLI for Claude.」<br>cc-2.1.312-sdk-cli: 12 次 / 2 组 beta / identity 「You are a Claude agent, built on Anthropic's Claude Agent SDK.」<br>cc-2.1.312-restricted: 12 次 / 2 组 beta / identity 「You are a Claude agent, built on Anthropic's Claude Agent SDK.」
- **G9 细节**：beta 集/顺序与 `thinking`/`max_tokens` **随模型**变（haiku 8 个 beta、`thinking={type:enabled,budget_tokens:31999}`、无 `output_config`）；cli 主轮 12 个 beta（含 `dangerous-tool-use-2026-09-03`、`afk-mode-2026-01-31`）、tools 13、顶层多 `safeguards`；`cch`/`cc_prev_req`/`cc_prompt_id`/`cc_turn_origin` 在 36 次采样中 0 出现。
- **G10-A** 遥测不跟 `ANTHROPIC_BASE_URL`，只打 `api.anthropic.com:443`（cli 入口另试 `github.com` / `raw.githubusercontent.com` / `downloads.claude.ai`，均被拒）。
- **G10-B** `SSLKEYLOGFILE` 不可用（Bun 1.4.4 不写 keylog）；`NODE_EXTRA_CA_CERTS` 可用 → 受控 TLS 终结即可读到 `/api/event_logging/v2/batch` 等 9 个端点明文（UA `Bun/1.4.4`）。

## 证据文件索引

| 文件 | gate | sampledAt | digest |
|---|---|---|---|
| `append.json` | append | 2026-11-01T12:52:05.691Z | d9abf4cfc19ff263 |
| `attachments.json` | attachments | 2026-11-01T12:52:24.296Z | 1353801c1ff74b2f |
| `baseline-sdk-01.json` | baseline | 2026-11-01T13:38:17.125Z | a7ee6bfee5066e70 |
| `baseline-sdk-02.json` | baseline | 2026-11-01T13:38:18.936Z | 027fc1bb4e9451cd |
| `baseline-sdk-03.json` | baseline | 2026-11-01T13:38:20.714Z | 82e22136465d2620 |
| `baseline-sdk-04.json` | baseline | 2026-11-01T13:38:22.495Z | cdfb451c1e95b072 |
| `baseline-sdk-05.json` | baseline | 2026-11-01T13:38:24.321Z | af4a555a1912208a |
| `baseline-sdk-06.json` | baseline | 2026-11-01T13:38:26.077Z | 33d781cb0595bd84 |
| `baseline-sdk-07.json` | baseline | 2026-11-01T13:38:27.852Z | 691b4fe8f522f3f9 |
| `baseline-sdk-08.json` | baseline | 2026-11-01T13:38:29.624Z | c22d7363ee523c28 |
| `baseline-sdk-09.json` | baseline | 2026-11-01T13:38:31.385Z | 50eae3decde32f09 |
| `baseline-sdk-10.json` | baseline | 2026-11-01T13:38:33.186Z | d66b0c50726e1d87 |
| `baseline-sdk-11.json` | baseline | 2026-11-01T13:38:35.048Z | f03bf0397738fb09 |
| `baseline-sdk-12.json` | baseline | 2026-11-01T13:38:36.822Z | f0c5bffaed206b2f |
| `baseline.json` | baseline | 2026-11-01T12:51:36.551Z | abfc9681a66e170b |
| `history-first.json` | history-first | 2026-11-01T12:58:22.348Z | c56cb2cbea25075b |
| `history-import-assistant-text.json` | assistant-text | — | — |
| `history-import-combined.json` | combined | — | — |
| `history-import-summary.json` | — | — | — |
| `history-import-thinking-badsig.json` | thinking-badsig | — | — |
| `history-import-thinking-earlier.json` | thinking-earlier | — | — |
| `history-import-thinking-last.json` | thinking-last | — | — |
| `history-import-thinking-nosig.json` | thinking-nosig | — | — |
| `history-import-tool-use.json` | tool-use | — | — |
| `history-import-user.json` | user | — | — |
| `profile-cc-2.1.312-cli.json` | cli | — | — |
| `profile-cli-cli-01.json` | profile-cli | 2026-11-01T13:41:04.583Z | 65c409405762e04d |
| `profile-cli-cli-02.json` | profile-cli | 2026-11-01T13:41:29.511Z | 2c1555b2387c4fae |
| `profile-cli-cli-03.json` | profile-cli | 2026-11-01T13:41:54.430Z | 3a5228618e821c00 |
| `profile-cli-cli-04.json` | profile-cli | 2026-11-01T13:42:19.490Z | 688dbe83aef360ad |
| `profile-cli-cli-05.json` | profile-cli | 2026-11-01T13:42:44.563Z | e25ae128396557f1 |
| `profile-cli-cli-06.json` | profile-cli | 2026-11-01T13:43:09.404Z | 9f54b73ed4402228 |
| `profile-cli-cli-07.json` | profile-cli | 2026-11-01T13:43:34.492Z | 8743d67b98fbb9e6 |
| `profile-cli-cli-08.json` | profile-cli | 2026-11-01T13:43:59.444Z | de1fed8368329f57 |
| `profile-cli-cli-09.json` | profile-cli | 2026-11-01T13:44:24.391Z | 9a5485a50e740948 |
| `profile-cli-cli-10.json` | profile-cli | 2026-11-01T13:44:49.251Z | b9e7693f86d706c1 |
| `profile-cli-cli-11.json` | profile-cli | 2026-11-01T13:45:14.222Z | 754b03f81594f606 |
| `profile-cli-cli-12.json` | profile-cli | 2026-11-01T13:45:39.264Z | b85989d543e3f1ec |
| `profile-restricted.json` | restricted | — | — |
| `profile-sdk-cli.json` | sdk-cli | — | — |
| `profiles.json` | — | — | — |
| `restricted-bash.json` | restricted-bash | 2026-11-01T12:58:08.153Z | 70937ed772f9043c |
| `restricted-read-creds.json` | restricted-read-creds | 2026-11-01T12:58:03.468Z | 765398c2f2eb6b92 |
| `restricted-read-hostname.json` | restricted-read-hostname | 2026-11-01T12:58:05.593Z | 88a83a6544d1d96f |
| `restricted-res-01.json` | restricted | 2026-11-01T13:39:10.672Z | fba2c9c95a2a3d60 |
| `restricted-res-02.json` | restricted | 2026-11-01T13:39:12.433Z | 17d6c42bd2b9a094 |
| `restricted-res-03.json` | restricted | 2026-11-01T13:39:14.219Z | 36582a265099d6a9 |
| `restricted-res-04.json` | restricted | 2026-11-01T13:39:15.954Z | 4bd772471036b61a |
| `restricted-res-05.json` | restricted | 2026-11-01T13:39:17.704Z | 656c26b7643652b4 |
| `restricted-res-06.json` | restricted | 2026-11-01T13:39:20.002Z | b8e198b69a6c95c3 |
| `restricted-res-07.json` | restricted | 2026-11-01T13:39:21.742Z | 9a6ebbfd313c7899 |
| `restricted-res-08.json` | restricted | 2026-11-01T13:39:23.524Z | 77af9f837a4e8a44 |
| `restricted-res-09.json` | restricted | 2026-11-01T13:39:25.332Z | 612882e73a6709e1 |
| `restricted-res-10.json` | restricted | 2026-11-01T13:39:27.104Z | de66f9984b6d5879 |
| `restricted-res-11.json` | restricted | 2026-11-01T13:39:28.871Z | bdbd130a0c43678f |
| `restricted-res-12.json` | restricted | 2026-11-01T13:39:30.667Z | 4f23f024b1406243 |
| `restricted.json` | restricted | 2026-11-01T12:52:07.791Z | 14a720b87ba16c43 |
| `resume-2.json` | resume | 2026-11-01T13:32:44.699Z | 86c892d23147e3db |
| `resume-builtin.json` | resume-builtin | 2026-11-01T13:36:21.277Z | 151d38e2564187d7 |
| `resume-g3-assistant-text.json` | resume | 2026-11-01T13:37:32.115Z | 63f9fdf6ec82afac |
| `resume-g3-combined.json` | resume | 2026-11-01T13:37:43.225Z | 494c012cff9912fb |
| `resume-g3-thinking-badsig.json` | resume | 2026-11-01T13:37:41.424Z | 4ef5d921c2da4b18 |
| `resume-g3-thinking-earlier.json` | resume | 2026-11-01T13:37:37.694Z | f42170d51416810e |
| `resume-g3-thinking-last.json` | resume | 2026-11-01T13:37:35.805Z | 5b7301478a5a598b |
| `resume-g3-thinking-nosig.json` | resume | 2026-11-01T13:37:39.630Z | 4bcdcb619a6c0b8c |
| `resume-g3-tool-use.json` | resume | 2026-11-01T13:37:33.919Z | b10b59954a7b91d4 |
| `resume-g3-user.json` | resume | 2026-11-01T13:37:30.300Z | ec8caf761df97e8e |
| `resume-kill.json` | resume | 2026-11-01T13:32:48.736Z | 78cb5692dc86f3c2 |
| `resume-mcp.json` | resume-mcp | 2026-11-01T13:36:02.262Z | 1b0ca9d56d4087fc |
| `resume-midflight-early.json` | resume | 2026-11-01T13:33:26.648Z | 1738ae4c6e312a43 |
| `resume-midflight-late.json` | resume | 2026-11-01T13:33:59.541Z | c07c9aa1d351a08a |
| `resume-midflight-nofile.json` | resume | 2026-11-01T13:34:46.661Z | ef6028990470d033 |
| `resume-midflight-slow.json` | resume | 2026-11-01T13:35:25.591Z | 61daca425ee37526 |
| `resume-slow.json` | resume | 2026-11-01T13:32:31.296Z | 0eb060a268495b8d |
| `resume.json` | resume | 2026-11-01T13:32:43.460Z | 1dc146d715e00882 |
| `schema.json` | schema | 2026-11-01T12:52:09.848Z | 783aebc3dba18912 |
| `session-kill-midflight-nofile.json` | session-kill-midflight | 2026-11-01T13:34:15.279Z | 97b091c91d3cf25e |
| `session-kill-midflight-slow.json` | session-kill-midflight | 2026-11-01T13:34:58.229Z | 53d2050b04561fad |
| `session-kill-midflight.json` | session-kill-midflight | 2026-11-01T13:33:32.067Z | f061ea5226b73931 |
| `session-kill.json` | session-kill | 2026-11-01T13:32:45.972Z | 98b5ec48c950ece1 |
| `session.json` | session | 2026-11-01T13:32:42.135Z | 94f79fa1c1a9856b |
| `streamjson.json` | streamjson | 2026-11-01T12:52:21.942Z | bc8b20e17261811f |
| `telemetry-structure.json` | telemetry-structure | 2026-11-01T13:47:25.009Z | afabb380a0ab0a0f |
| `tool-interrupt-builtin.json` | tool-interrupt-builtin | 2026-11-01T13:36:13.693Z | e8d28ce96e7b7651 |
| `tool-interrupt.json` | tool-interrupt | 2026-11-01T13:35:52.610Z | 3f5e6549e618b9fc |
| `unrestricted-read-creds.json` | unrestricted-read-creds | 2026-11-01T12:58:10.223Z | 0eb1e1b8dd2aee39 |
