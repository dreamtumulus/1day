# TUI worker：节点以交互式 Claude Code 服务 canonical 会话（2026-11-08）

> 状态：开发完成，首个节点部署在 CCR 机（217.216.46.202，实例 `tui`，Claude Code 2.1.319）。worker-01 / worker-02 不变。
> 决策登记 X-43；真实性登记见 `iron-rules.md` 铁律 3。前史：`interactive-worker-plan-2026-11-05.md`（I0 探针）、X-36（入口计量）。

## 1. 为什么

- `claude -p` 在上游眼里是 Agent SDK：UA `sdk-cli`、identity "You are a Claude agent, built on Anthropic's Claude Agent SDK"、少 `redact-thinking` beta、工具集不同（claude-code#59105）。
- 订阅额度对 `sdk-cli` 入口按约 1.5–2 倍计（我方 X-36 单账号 ABA，上游 #97074 多方复现 1.3–3 倍，5 小时窗口；周窗口 1.14–1.32 倍）。
- 政策方向：2026-05-14 公告把 Agent SDK / `claude -p` / 第三方应用移出订阅限额（6-15 暂停，"advance notice before it takes effect"）；10-07 起 `-p` 走 API credits；官方文档写明 `--bare`（不读订阅凭据）将成为 `-p` 默认。交互式 Claude Code 是官方承诺留在订阅限额内的形态。
- 结论（运营方 11-08）：节点改用交互式 Claude Code，`-p` 不可靠。

## 2. 架构：一个垫片，其余不动

```
gateway ──stream-json──▶ console ──tunnel──▶ node cc-worker ──spawn──▶ cc-tui-shim <claude> <原 -p 参数>
                                                                            │  interactiveArgs：去 -p/stream-json/verbose/…，加 --permission-mode default --allowedTools mcp__caller --no-chrome
                                                                            ├─ pty 200×50：就绪检测（trust/onboarding/主题/Chrome 提示/❯）、bracketed paste、图片写文件粘路径
                                                                            ├─ tail <CLAUDE_CONFIG_DIR>/projects/*/<sid>.jsonl → assistant / result / rate_limit_event
                                                                            └─ tap.js（BUN_OPTIONS --preload）tee 主轮 /v1/messages 的 SSE → stream_event（只读响应，不改请求）
```

- 垫片对节点讲的仍是 `-p` 的 stream-json：`system/init{session_id}`、`stream_event`、`assistant`（带 uuid）、`user{tool_use_result}`、`rate_limit_event`、`result`。网关翻译层、MCP 桥（`mcp__caller__*`，HTTP，并行调用）、会话记忆、原生 transcript 导入、团队隔离、设备身份、出口绑定、计费一行不改。
- 节点侧（`apps/provider-node/src/cc-worker.ts`）：`CC_WORKER_TUI=1` 且 canonical 开 → canonical open 以 `spawn(shim, [claudeBin, ...args])` 启动（经 machine-identity launcher 时为 `launcher shim claudeBin args`）；环境加 `ONEDAY_CC_TUI_TRUST=1`（cwd 是账号自己的固定目录，垫片自己答 trust 对话框）、`ONEDAY_TUI_LISTED=<workDir>/mcp-listed`。MCP 服务（`mcp-server.ts`）答完 `tools/list` 就 touch 该文件，垫片等到它才粘第一条消息（magpie 的教训：工具列出前发的消息会在没有工具的情况下被回答）。
- legacy open（工具轮尾巴等 canonical 接不住的回落）在 TUI 节点上仍跑 `-p`。
- 心跳能力 `tui_v1`；`ccWorker.canonical.tui=true`。自检：`claude --version` 之外还跑 `shim --version`。

## 3. 第三方代码：magpie 的 `internal/claudetui`，原样引用、机械改名、两处补丁

见 `third_party/magpie-claudetui/README.md`。要点：

| 项 | 内容 |
|---|---|
| 来源 | github.com/yetone/magpie `internal/claudetui`（MIT，commit 见 `UPSTREAM`）；2752 行 Go + 164 行 tap.js + 2273 行测试 + 5 个 2.1.316 屏幕录像 |
| 依赖 | 上游内部包只用三个符号：`proc.Command`、`appdir.Getenv`、`wslrun.Tool.Linux`，以 stub 替代；外部仅 `golang.org/x/sys`、`x/text` |
| 改名（`rename.sed`） | `MAGPIE_CLAUDE_*` → `ONEDAY_CC_*`，`magpie-claude-*` 临时目录前缀 → `oneday-cc-*`，`mcp__magpie` → `mcp__caller`，`MAGPIE_TUI_TEST` → `ONEDAY_TUI_TEST` |
| 补丁（`patches/0001`） | ① 节点已传 `--session-id` 时沿用，不再追加第二个；② "工具已列出"标记文件改从 `ONEDAY_TUI_LISTED` 读（我们的 MCP 是 HTTP，不是它的 stdio 助手） |
| 不用的部分 | Windows / ConPTY / WSL 分支（编译时自动排除）、`/usage` 屏幕解析（节点永不发 `command` 消息）、第三方 400 回退 `-p`（在网关层属于拒绝，不回退） |
| 同步 | `sync.sh <magpie 检出>`：复制 → sed → patch → vet → build `dist/cc-tui-shim`。上游测试在有 pty 的机器跑 `go test ./internal/claudetui/`，CCR 实测 11-08 全过（仅 `TestShimInWSL` 因 stub 失败，预期） |
| 构建 | Go 1.26.10，静态 Linux amd64，4.6 MB；控制台从 `third_party/magpie-claudetui/dist/cc-tui-shim` 以一次性 code 下发（`GET /internal/provider/cc-tui-shim?code=`） |

### 3.1 对照表：magpie 网关侧逻辑 ↔ 我们的实现位置

这些在 magpie 的 `claude_subscription.go` 里，与其路由、账号模型耦合，不可拿；以后看它改了什么，对照这里改。

| magpie | 我们 | 现状 |
|---|---|---|
| `readOutput` 的 `onCall` / `callFirst`（工具调用先于 transcript 落盘时合成 tool_use 回复，调用前文字丢失） | `apps/gateway/src/ccr/translate.ts` 原生工具停泊 | 我们走 tap 的 `message_delta`+`1dayapi_tool_call` 帧，不依赖 transcript 时机；首批真实流量要验证是否仍有文字丢失 |
| `replaySession`（两行伪 jsonl `--resume`） | `apps/gateway/src/ccr/native-session.ts` 完整 transcript 导入 | 完整导入优先；两行兜底待做 |
| `refused` / `heldIfRefused`（CC 遇 refusal 同模型重试一次） | `translate.ts` refusal 透传（X-42 ⑤） | 我们 `CLAUDE_CODE_NO_MODEL_FALLBACK=1`；同模型重试那一轮由翻译层按续写处理，待实测 |
| `textCalls` / `textCallsAsk` | `translate.ts` `transcriptGuard`（canonical 下关） | canonical 不折叠历史，暂不需要 |
| `claudeRoom` / `oversized` | `cc-worker.ts` 内存高水位 LRU 驱逐 | 可补"单进程 RSS 超预算退休" |
| `tuiStarts`（交互启动全局串行） | 节点 `maxConcurrency` | 不串行；Linux 无 Keychain，启动约 3 秒 |

## 4. 部署：同机第二实例（CCR）

控制台 `POST /api/admin/nodes/deploy` 新增字段：`instance`（unit `1dayapi-node-<instance>`、`~/.1dayapi-node-<instance>`、`~/.config/1dayapi-provider-node-<instance>`、worker root `/var/lib/1dayapi-cc-worker-<instance>`）、`consolePort`、`tui: true`、`claudeVersion`。非默认版本装到 `/opt/claude-<version>/claude` 并以 `CC_WORKER_CLAUDE_BIN` 指给该节点，**不动** `/opt/claude/claude` 与 `/usr/local/bin/claude`（同机 mirasim 节点仍用 2.1.312）。

CCR 实例：`1dayapi-node-tui`，端口 16890，Claude Code 2.1.319（latest 通道，运营方定"用最新版"），垫片 `/opt/cc-tui-shim/cc-tui-shim`。同机保留 mirasim 的 `1dayapi-node`（16889）；WORK-CCR 三个 unit 已停用（文件保留）。部署记录见 `deployment/2026-11-08-tui-node-ccr.md`。

账号与流量：账号在控制台正常上号后绑到该节点；建测试分组只含这些账号，测试 key 走它。请求是否走 TUI 由**账号所在节点**决定，网关不另设开关。

## 5. 与 `-p` 相比，翻译层要容忍的差异

- `result` 不带 usage（垫片按 `turn_duration` 合成 `{subtype:"success"}`）：用量来自 tap 的 `message_start` / `message_delta`。
- 同一消息既有 `stream_event` 又有整条 `assistant`：翻译层按 `streamedMessageIds` 去重（`-p` 下本就如此）。
- 无 tap（Bun 没加载 preload）时整条落盘再发，无 token 级流。
- 交互模式没有 `rewind_conversation`，客户端放弃回合只能结束进程。
- 真交互式 CC 启动时发一个计量探测请求（haiku, max_tokens 1），会打开空闲账号的 5 小时窗口；真实用户同样如此。

## 6. 版本

节点钉 Claude Code 版本（当前 2.1.319）；升级前在 CCR 跑垫片 + 假上游探针（`tests/e2e/cc-probe`），并重跑上游 `claudetui` 测试。magpie 修了什么，`sync.sh` 跟进，补丁打不上才需人看。

## 7. 待办

- 两行伪 jsonl 兜底；单进程 RSS 预算；工具调用前文字丢失的度量（captures `toolUses` 与 tap 事件对照）。
- 控制台节点页显示 `tui_v1`。
- `apps/provider-node/test/team-isolation.test.mjs` 读 `init.cwd/mcp-config.json`，自 11-05 固定 cwd 后失效（旧问题，与本次无关）。
