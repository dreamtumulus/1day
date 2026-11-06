# 交互式（TUI）worker 方案 —— canonical 的下一步（2026-11-05）

> **状态：搁置（2026-11-06 用户决定）**——"等于在窗口里看对话，暂时不用"。I0 第一轮已跑，结论见文末；工具轮次 / 续轮 / resume 未验证。
> 后果已知：worker 继续以 `-p`（`sdk-cli`）运行，按 X-36 的实测以 ≈1.7× 速度消耗订阅窗口；入口标签同样不改。

> 决定（X-36）：worker 节点从 `claude -p`（入口标签 `sdk-cli`）改为驱动 **真正的交互式 Claude Code**（入口 `cli`），
> 不改写任何标签。目标版本 `v1.1`（与本方案一起打 tag）。参照实现：yetone/magpie 的 Claude 订阅桥（`internal/claudetui`、
> `internal/gateway/claude_subscription.go`），它默认即交互模式、从不回落 `-p`。

## 1. 为什么

| 事实 | 来源 |
|---|---|
| 同账号/同节点 IP/同 2.1.312/同设备身份，只变 `CLAUDE_CODE_ENTRYPOINT`：`sdk-cli` 每 5h 窗 1 点 = $1.45 / 191k tok；`claude-vscode` = $2.49 / 325k tok；sdk-cli 复测与首测完全一致 → **`-p` 烧额度 ≈1.7× 快** | `/root/monitor/ep-exp-main.log`，脚本 `/root/monitor/ep_exp.py`，X-36 |
| 同一现象上游 issue：headless 1.8×；kler 受控 harness：sdk-ts 2.97× / sdk-cli 2.83× 于 claude-vscode；差别只在 billing 头与 UA 的 `cc_entrypoint` | anthropics/claude-code#97074（无官方回复） |
| `CLAUDE_CODE_ENTRYPOINT=cli` 在 `-p` 下被 CC 强制改回 `sdk-cli`；非 cli 值原样接受 | 本机探针（fake upstream，2.1.312） |
| 改标签 = 向上游申报非事实入口（且 `claude-vscode` 等于冒充 VS Code 扩展） | 用户决定：不做 |

交互模式下入口天然是 `cli`，UA、billing 头、beta 列表（含交互模式才发的 redact-thinking）全部真实。额外收益：`-p` 特有的进程形态
（stream-json、`--no-session-persistence`、每轮一进程）消失，与真实用户会话的差异进一步缩小。

## 2. 目标架构（节点侧，provider-node）

```
gateway ──(cc_worker.open / turn / tool_result)──▶ node bridge ──▶ TuiDriver(pty) ──▶ claude (交互式)
                                                        │                 ▲
                                                        │  tail           │ paste + Enter
                                                        ▼                 │
                                       <CLAUDE_CONFIG_DIR>/projects/<cwd-slug>/<session>.jsonl
                                                        │
                                   转译器(现有 translate.ts 的 jsonl→SSE 部分) ──▶ gateway ──▶ 客户
                                   工具调用：现有 MCP `mcp__caller__*` 桥（不变）
```

- **进程**：`claude --session-id <id> --model <m> --permission-mode default --allowedTools "mcp__caller__*" --strict-mcp-config --mcp-config <file> --no-chrome`
  （去掉 `-p`、stream-json、`--no-session-persistence`、`--dangerously-skip-permissions`）。pty 200×50，`TERM=xterm-256color`，
  **不设 `CLAUDE_CODE_ENTRYPOINT`**（CC 自己写 `cli`），其余 env 与现在相同（`DISABLE_AUTOUPDATER`、`DISABLE_ERROR_REPORTING`、固定 cwd、
  每会话 HOME/TMPDIR、账号 `CLAUDE_CONFIG_DIR`）。
- **输入**：bracketed paste（`\x1b[200~ … \x1b[201~`）+ Enter；以 `/ ! # &` 开头的用户文本前加换行防被当命令；图片写文件后粘路径
  （magpie 做法）。超长输入先探粘贴上限。
- **输出**：不解析屏幕。tail 该会话的 `projects/<slug>/<session>.jsonl`（CC 自己写的 transcript，与 G3 导入同形态）：
  `assistant` 行 → content_block 事件；`stop_reason` / 下一条 `user`(tool_result) / 空闲提示符 → 轮次结束。
  流式：jsonl 是整条消息落盘，首字节延迟会变差；magpie 用 `tap.js` 钩 Bun fetch 偷 SSE 来补——**我们不做**（篡改 CC 请求链路）。
  先接受"整段落盘再流出"，再评估是否用 pty 屏幕增量做伪流式。
- **工具**：MCP 桥不变。交互模式下 MCP 工具调用要过权限：`--allowedTools mcp__caller__*` 让它们免确认；内建工具按
  `--permission-mode default` + 空 `--tools` 等价物处理（交互模式不接受 `--tools ""`？——探针确认，magpie 文档与代码在此有分歧）。
- **会话连续**：进程常驻（现有 pool/TTL 不变），下一轮只粘新话；进程没了 → `claude --resume <id>` 交互式恢复（G4 已证 -p 下可行，交互式待探）；
  历史导入（G3 jsonl）→ 交互式 `--resume` 读取同一文件。
- **结束/中断**：客户端断开 → 交互模式不能 `rewind_conversation`，只能 Esc 中断当前轮（探针确认 Esc 行为）或杀进程。
- **弹窗**：首次信任目录（`Yes, I trust`）、onboarding、主题选择、`/usage` 等——用固定 cwd + 预写 `settings.json`/`.claude.json` 跳过；
  驱动器仍要识别并处理残余提示（magpie `claudetui/tui.go` 的正则清单可直接借）。

## 3. 工作包

| WP | 内容 | 验收 |
|---|---|---|
| I0 探针 | 主服务器 2.1.312 + fake upstream（`tests/e2e/cc-probe` 的捕获器）+ pexpect：启动 TUI、粘贴、读 jsonl、看请求 | 捕获请求 UA `(external, cli)`、billing 头 `cc_entrypoint=cli`；一轮文本、一轮 MCP 工具（免确认）、`--resume` 续轮都成功；记录弹窗/超时/粘贴上限 |
| I1 驱动器 | provider-node `tui-driver.ts`（node-pty 或 python 子进程？→ 选 node-pty 保持单运行时）；jsonl tail → 现有转译器 | 单测用假 TUI；真 CC 在节点 selftest 过 |
| I2 桥接 | `cc-worker.ts` 增 `mode: "interactive"`（gateway `CcWorkerParams.mode`）；能力 `interactive_v1`；gateway 新三态开关 `worker_interactive`（0/canary/1） | canonical 的全部网关测试在 interactive 下通过；回落链：interactive→canonical→legacy |
| I3 计量复核 | 节点上重跑 `ep_exp.py` 的 A/B：interactive vs `-p` 同工作量 | 每点成本比 ≈ 1.7（与 X-36 一致） |
| I4 灰度 | 测试BOOK → circulation → 全部 | 两周 0 新增 on-hold；上下文/工具/缓存指标不劣于 canonical |
| I5 收尾 | 文档、`v1.1` tag、legacy 删除计划 | — |

## 4. 风险与未知

- **版本漂移**：magpie 记录 2.1.281（Windows）无 FetchSession、2.1.316 `--json-schema` 交互下无效、`/usage` 输出变化等；我们钉 2.1.312，升级时过 I0 探针。
- **流式体验**：jsonl 落盘粒度 = 整条消息；长回复首字节会从秒级变成"整段到达"。需评估客户（agent 多数不在乎，聊天前端在乎）。
- **工具调用的回复文本丢失**：magpie 文档记录"工具调用前的文字有时取不到"。
- **并发/内存**：交互进程比 `-p` 重（TUI 渲染），单节点并发上限要重测（现 252/292）。
- **权限提示**：任何没被 `--allowedTools` 覆盖的工具都会卡在确认框；驱动器必须能识别并拒绝/放行。

## 5. 不做

- 不改 `CLAUDE_CODE_ENTRYPOINT`、不伪造 UA/billing 头。
- 不预载脚本进 Bun 钩 fetch、不改写请求体（`safeguards` 等）。
- 不回放工具轮次（2.1.312 探针结论不变）。

## I0 第一轮结果（2026-11-06，主服务器，2.1.312，fake upstream，零真实流量）

- pty 里启动交互式 Claude Code（预写 `.claude.json` 的 `hasCompletedOnboarding` 与 `projects[cwd].hasTrustDialogAccepted`）：约 3 s 出现输入框，无弹窗；键入 + 回车 → 回答渲染 → 会话 jsonl 落盘。
- 捕获 3 个请求，UA 全部 `claude-cli/2.1.312 (external, cli)`：REQ0 启动额度探测（`user:"quota"`，`max_tokens=1`）；REQ1 会话起标题侧请求（第一轮）；REQ2 主轮——billing `cc_version=2.1.312.6b4; cc_entrypoint=cli`，13 个内建工具，adaptive thinking，beta 含 `mid-conversation-tool-changes` / `per-turn-control` / `dangerous-tool-use` / `extended-cache-ttl`。
- 主轮 `messages` 里有一条 `role: "system"` 的 `# Environment` 消息（2.1.31x 会话中途 system 消息形态，与 X-37 的 2.1.318 直连 400 同机制）。
- 会话 jsonl 含 `api-request-blob` 行（CC 自己记录发出的 system / 消息内容）与 `assistant` 行：节点若要读每轮实际发送内容与回复，不需要代理或钩子。
- 证据：`docs/evidence/cc-2.1.312/interactive-i0-report.json`、`interactive-i0-requests.ndjson`（fake token 已脱敏）。驱动脚本 `/root/monitor/tui_probe.py`、`/root/monitor/tui-capture.mjs`。
