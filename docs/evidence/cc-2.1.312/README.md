# CC 2.1.312 探针证据（WP0 汇总，自动生成）

由 `node tests/e2e/cc-probe/evidence.mjs` 生成；逐项过程记录见 [PROGRESS.md](./PROGRESS.md)，
G3 见 [G3-matrix.md](./G3-matrix.md)，G10-B 见 [G10-B-mitm.md](./G10-B-mitm.md)。

- 证据文件：125 个 JSON（`docs/evidence/cc-2.1.312/`）
- 生成时间：2026-11-01T16:53:57.503Z
- 脱敏校验（`sk-ant-` / `@` / `/tmp/` / `/home/`）：通过（0 处命中）
- 所有 gate 的 CONNECT 目标：api.anthropic.com:443, raw.githubusercontent.com:443, downloads.claude.ai:443, github.com:443

| Gate | 结论 | 文件 | sampledAt | digest | spec 失败处置 | 是否触发 |
|---|---|---|---|---|---|---|
| G1 append | 通过 | `append.json`<br>`baseline.json` | 2026-11-01T12:52:05.691Z | d9abf4cfc19ff263 | 改用 caller-instructions / mid-conversation system | 未触发（追加位可用，客户 system 不进 argv） |
| G2 stream-json | 部分 | `streamjson.json`<br>`history-first.json` | 2026-11-01T12:52:21.942Z | bc8b20e17261811f | 不假设 assistant 注入；历史走 G3 | 未触发（assistant 注入被接受并原样入下一轮） |
| G3 history import | 通过（thinking 需剥离；gateway 导入器真机验证通过） | `history-import-user.json`<br>`history-import-assistant-text.json`<br>`history-import-tool-use.json`<br>`history-import-thinking-last.json`<br>`history-import-thinking-earlier.json`<br>`history-import-thinking-nosig.json`<br>`history-import-thinking-badsig.json`<br>`history-import-combined.json`<br>`history-import-gateway.json` | — | — | `history_import_unsupported` / historyPolicy=reset | 未触发（可导），但必须新增 thinking 剥离策略 |
| G4 resume | 部分（有会话丢失窗口） | `session.json`<br>`resume.json`<br>`resume-2.json`<br>`session-kill.json`<br>`resume-kill.json`<br>`session-kill-midflight.json`<br>`resume-midflight-early.json`<br>`session-kill-midflight-nofile.json`<br>`resume-midflight-nofile.json`<br>`resume-streamjson.json`<br>`resume-streamjson-t7.json`<br>`append-resume.json` | 2026-11-01T15:09:59.558Z | 7774f419927ebd8c | 不启用 native 灰度 | 未触发（可启用）；resume 期 append 只在 transcript **没有** prompt_snapshot 时生效（T11：导入会话首次 resume 生效、之后被固化快照覆盖） |
| G5 tool interrupt | 通过 | `tool-interrupt.json`<br>`resume-mcp.json`<br>`tool-interrupt-builtin.json`<br>`resume-builtin.json` | 2026-11-01T13:36:02.262Z | 1b0ca9d56d4087fc | 409 `tool_continuation_lost` | 未触发（原生补 is_error tool_result、不重跑），caller 工具仍建议保留 409 兜底 |
| G6 restricted | 通过 | `restricted.json`<br>`restricted-read-creds.json`<br>`restricted-read-hostname.json`<br>`unrestricted-read-creds.json` | 2026-11-01T12:58:03.468Z | 765398c2f2eb6b92 | 只用 tools-disabled-canonical | 未触发 |
| G7 Bash | 通过 | `restricted-bash.json` | 2026-11-01T12:58:08.153Z | 70937ed772f9043c | 本期不开放 | 未触发（restricted 无 Bash 工具） |
| G8 --json-schema | 通过 | `schema.json` | 2026-11-01T12:52:09.848Z | 783aebc3dba18912 | `response_format` → `unsupported_parameter` | 未触发（schema 可解析，13 工具） |
| G9 profile | 通过 | `profiles.json`<br>`profile-sdk-cli.json`<br>`profile-cc-2.1.312-cli.json`<br>`profile-restricted.json`<br>`beta-midconv.json` | 2026-11-01T13:38:17.125Z | a7ee6bfee5066e70 | 不做跨版本 pin | 未触发（按 2.1.312 三 profile 存证） |
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

## 第二批（T7–T10）

- **T7 stream-json 续轮** `通过`：`--resume <id> --input-format stream-json` 的 REQ0 = 历史 + stdin 新一轮（角色序 `user:text+text > system:string > assistant:text > user:text`），无重复、无 `No response requested.`、`system/init.session_id` 与传入值一致。
- **T8 append × resume** `通过`：resume 时再带 `--append-system-prompt-file` **不重复追加**——transcript 里持久化了 `prompt_snapshot`（system 10 块 + tools），resume 回放快照、**静默忽略**当次 append（file 与 inline 都忽略，主提示词仍是 5599 而非 5655）；首轮带 append 的会话 resume 后仍为 5655 且 marker 恰好 1 次 → 客户 system 必须在建会话时固定。
- **T9 gateway 导入器真机验证** `通过`：`buildNativeTranscript`（`apps/gateway/dist/ccr/native-session.js`）生成 8 行 transcript，resume 后 tool_use/tool_result 两对按序保真、thinking/redacted_thinking（2 块）全部剥离、image 块保留、无重复。
- **T10 beta 触发条件** `attachments-context (CLAUDE_CODE_DISABLE_ATTACHMENTS unset)`：`mid-conversation-tool-changes-2026-07-01` 只在 attachments 上下文开启时出现（4/4），关闭 attachments 时 0/3，与入口（cli/sdk-cli）和 MCP 工具集无关；G9 的 36 次采样都设了 `CLAUDE_CODE_DISABLE_ATTACHMENTS=1`，所以未见该 beta。

## 第三批（T11–T12）

- **T11 导入 transcript × append** `通过`：快照-less 的导入会话里，resume 当轮的 `--append-system-prompt-file` **生效且只追加一次**（主提示词 5599→5657，marker 1 次，计费头/身份句保留）；但这次 resume 结束会把二进制自己的快照（10 块 + tools）写回 transcript，**之后的 resume 换 marker 0 命中**（第二次 marker 0 次）→ 客户 system 只能"首次 resume 定终身"。手写最小 `prompt_snapshot` 会被回放但**整块替换**主提示词（74B，默认 5599B 全丢、工具仍默认 12），且此时 append 被忽略。
- **T12 resume 后的 `# Environment update`** `通过`：导入的 transcript（无 `environment` attachment）在 cwd 同/异 × attachments 开/关 × stdin/positional 六种组合下 **0 次**出现该块；T1 的 99B 块 **0/4 精确复刻**（另 3 次 native positional、1 次 stdin 也 0）→ 不是 resume 的固定行为。二进制侧（只读）确认它是 environment 的 **diff 渲染**（`workingDirectory` 等字段与存储值不同才输出，`(was …)` 取存储值），`CLAUDE_CODE_DISABLE_ATTACHMENTS` 不控制它（只控制整块 `# Environment`，ON 时 9507B）→ 续轮走 stdin stream-json + 不写陈旧 environment attachment 才是护栏，cwd 改写保留作防御。

## 证据文件索引

| 文件 | gate | sampledAt | digest |
|---|---|---|---|
| `append-resume.json` | append-resume | 2026-11-01T15:08:55.822Z | c8fcfa2f0c9847b2 |
| `append.json` | append | 2026-11-01T12:52:05.691Z | d9abf4cfc19ff263 |
| `attachments-apikey-email.json` | attachments-apikey-email | 2026-11-01T14:06:11.964Z | 93405e5883e031f3 |
| `attachments-email.json` | attachments-email | 2026-11-01T14:06:10.399Z | 6428c86053cf9608 |
| `attachments-mcp-t10.json` | attachments-mcp | 2026-11-01T15:14:25.416Z | 8dd534797107033d |
| `attachments-t10.json` | attachments | 2026-11-01T15:14:23.574Z | 60331aaac65d90ea |
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
| `beta-midconv.json` | beta-midconv | 2026-11-01T15:14:21.786Z | 66957903e9a203a9 |
| `history-first.json` | history-first | 2026-11-01T12:58:22.348Z | c56cb2cbea25075b |
| `history-import-append.json` | history-import-append | 2026-11-01T16:43:41.921Z | ccb7c5dee315f8e5 |
| `history-import-assistant-text.json` | assistant-text | — | — |
| `history-import-combined.json` | combined | — | — |
| `history-import-gateway.json` | history-import-gateway | 2026-11-01T15:09:46.463Z | 80a969175bacc0b8 |
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
| `resume-append-inline-t8c.json` | resume-append-inline | 2026-11-01T15:09:04.662Z | 2c790a85c21dc4d6 |
| `resume-append-t8a.json` | resume-append | 2026-11-01T15:08:59.955Z | c8fcfa2f0c9847b2 |
| `resume-append-t8b.json` | resume-append | 2026-11-01T15:09:03.271Z | 3ad1dee072af1000 |
| `resume-builtin.json` | resume-builtin | 2026-11-01T13:36:21.277Z | 151d38e2564187d7 |
| `resume-env-update.json` | resume-env-update | 2026-11-01T16:52:39.386Z | 91e4142c159a18e2 |
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
| `resume-streamjson-append-t11a.json` | resume-streamjson-append | 2026-11-01T16:43:48.854Z | 2feb3dbdd43bda53 |
| `resume-streamjson-append-t11b.json` | resume-streamjson-append | 2026-11-01T16:43:55.805Z | ccb7c5dee315f8e5 |
| `resume-streamjson-append-t11d.json` | resume-streamjson-append | 2026-11-01T16:44:09.682Z | 9fea63a687dfaa93 |
| `resume-streamjson-t11c.json` | resume-streamjson | 2026-11-01T16:44:02.742Z | afba4d2009915c0a |
| `resume-streamjson-t12a.json` | resume-streamjson | 2026-11-01T16:52:46.315Z | c211e747221397c7 |
| `resume-streamjson-t12b.json` | resume-streamjson | 2026-11-01T16:52:53.254Z | 91e4142c159a18e2 |
| `resume-streamjson-t12c.json` | resume-streamjson | 2026-11-01T16:53:00.203Z | 93578b12764b2384 |
| `resume-streamjson-t12d.json` | resume-streamjson | 2026-11-01T16:53:07.174Z | 0ed06ff6ac650343 |
| `resume-streamjson-t12n1.json` | resume-streamjson | 2026-11-01T16:53:19.722Z | 5f3065a7b0858c93 |
| `resume-streamjson-t7.json` | resume-streamjson | 2026-11-01T15:10:09.141Z | 7774f419927ebd8c |
| `resume-streamjson-t9.json` | resume-streamjson | 2026-11-01T15:09:46.448Z | 80a969175bacc0b8 |
| `resume-streamjson.json` | resume-streamjson | 2026-11-01T15:09:59.558Z | 7774f419927ebd8c |
| `resume-t12e.json` | resume | 2026-11-01T16:53:09.141Z | e2de0c7e87528233 |
| `resume-t12f.json` | resume | 2026-11-01T16:53:10.986Z | 245abd0abf6ec5a4 |
| `resume-t12n2.json` | resume | 2026-11-01T16:53:21.010Z | 4846f231424204bc |
| `resume-t12n3.json` | resume | 2026-11-01T16:53:22.290Z | 31211c9b5b54eac8 |
| `resume-t12n4.json` | resume | 2026-11-01T16:53:23.602Z | 2ef023920be38be1 |
| `resume-t12r1a.json` | resume | 2026-11-01T16:53:26.695Z | 7b7cfb9bd399979e |
| `resume-t12r1b.json` | resume | 2026-11-01T16:53:28.013Z | 8d6fbb0e62ddff6a |
| `resume-t12r2a.json` | resume | 2026-11-01T16:53:31.118Z | 4afc3948a61a9dbe |
| `resume-t12r2b.json` | resume | 2026-11-01T16:53:32.391Z | e2593e0bfcfce488 |
| `resume.json` | resume | 2026-11-01T13:32:43.460Z | 1dc146d715e00882 |
| `schema.json` | schema | 2026-11-01T12:52:09.848Z | 783aebc3dba18912 |
| `session-append-t8b.json` | session-append | 2026-11-01T15:09:01.759Z | 37eaade0e674f255 |
| `session-kill-midflight-nofile.json` | session-kill-midflight | 2026-11-01T13:34:15.279Z | 97b091c91d3cf25e |
| `session-kill-midflight-slow.json` | session-kill-midflight | 2026-11-01T13:34:58.229Z | 53d2050b04561fad |
| `session-kill-midflight.json` | session-kill-midflight | 2026-11-01T13:33:32.067Z | f061ea5226b73931 |
| `session-kill.json` | session-kill | 2026-11-01T13:32:45.972Z | 98b5ec48c950ece1 |
| `session-t12n0.json` | session | 2026-11-01T16:53:12.783Z | b29217447f45fc10 |
| `session-t12r1s.json` | session | 2026-11-01T16:53:25.441Z | 49c73a1eb7c11c11 |
| `session-t12r2s.json` | session | 2026-11-01T16:53:29.870Z | a9363b3d45877fb8 |
| `session-t7.json` | session | 2026-11-01T15:10:01.419Z | 0703a2b56b748ba2 |
| `session-t8a.json` | session | 2026-11-01T15:08:58.668Z | 8e67001a96852cb7 |
| `session.json` | session | 2026-11-01T13:32:42.135Z | 94f79fa1c1a9856b |
| `streamjson.json` | streamjson | 2026-11-01T12:52:21.942Z | bc8b20e17261811f |
| `telemetry-structure.json` | telemetry-structure | 2026-11-01T13:47:25.009Z | afabb380a0ab0a0f |
| `tool-interrupt-builtin.json` | tool-interrupt-builtin | 2026-11-01T13:36:13.693Z | e8d28ce96e7b7651 |
| `tool-interrupt.json` | tool-interrupt | 2026-11-01T13:35:52.610Z | 3f5e6549e618b9fc |
| `unrestricted-read-creds.json` | unrestricted-read-creds | 2026-11-01T12:58:10.223Z | 0eb1e1b8dd2aee39 |
