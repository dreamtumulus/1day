# X-49：X-48 节点包改写账号设备 ID —— 事故记录、恢复与 worker-01 切 TUI（2026-11-10）

决策登记 X-49；发布核对项见 `../operations.md` §4「节点变更的设备身份核对」。时间均为 UTC。

## 经过

| 时间 | 事件 |
|---|---|
| 04:28 | X-48 节点包 `2e4a0d5f` 上到 ccr-tui（含 `seedFolderTrust`）。此后每个账号第一次新开会话，`.claude.json` 被换成 root:root 0600，Claude Code 读不了，按首次启动重建并生成新 `userID` |
| 04:54 | worker-01 试切 TUI + Claude Code 2.1.322（同一个 X-48 包、沿用原 worker 根目录）。切换前的假上游探针通过（以 root 直跑，不经 launcher，测不出本问题） |
| 04:58 | worker-01 5 条真实请求全 200；同一请求在两个刚跑过的账号上 `worker_spawn_failed`，网关日志 `fixed team device identity changed` → 核对发现 5 个账号 `userID` 已变 |
| 05:00 | worker-01 回滚（旧包 7fcad48c、`-p`、2.1.312），5 个 `.claude.json` 从切换前备份整文件恢复，202 个账号目录与基线一致 |
| 05:02 | 确认 ccr-tui 同症：38 个账号中 30 个（到 05:10 为 35 个）`userID` ≠ `accounts.device_id`，`firstStartTime` 全在 04:28 之后 |
| 05:06 | 修复提交 `4ad8a94`，节点包 `dbb831f0`（与 X-48 包只差这一处） |
| 05:10 | ccr-tui：停节点 → 写回 35 个账号 → 换包 → 启动。38/38 与登记值一致 |
| 05:14 | worker-01 用修复包重新切到 TUI + 2.1.322 |

## 根因

`apps/provider-node/src/cc-worker.ts` `seedFolderTrust`：`writeFileSync(tmp)` → `if (identity && !this.machineRuntime) chownSync(tmp)` → `renameSync(tmp, file)`。
条件照抄了 spawn 处「节点自己 setuid 时才传 uid」的写法；但开机器身份时降权由 launcher（`setpriv`）完成，文件仍需归团队 uid。节点是 root，于是替换后的文件 root 属主。
证据（worker-01）：Claude Code 自己的 `backups/.claude.json.backup.<ts>` 在改写瞬间只有 137 字节（`installMethod / autoUpdates / firstStartTime / firstStartVersion: 2.1.322`），之前的备份 57 KB。

## 影响

- ccr-tui 35 个账号、worker-01 5 个账号，各有至少一次会话（含遥测）以新设备 ID 访问上游。收不回。
- 被改写的账号在节点上被 `materializeConfig` 的校验拒绝（`worker_spawn_failed`，网关换号）：ccr-tui 04:25–05:10 共 17 次。
- 数据库 `accounts.device_id` 未被改动（`recordCcIdentities` 遇不一致跳过），因此可按它写回。

## 恢复

- ccr-tui：`/root/ccr-restore-ids.py`（脚本副本在主服务器 `/root/w01-tui-switch/`）。优先取 Claude Code 自己的最新一份 `userID` 仍为登记值的 `backups/.claude.json.backup.*` 整文件恢复（32 个），否则只改回 `userID` 字段（3 个）；保留属主与 0600。被改写的版本留证 `/root/x49-altered-claude-json-20261110T051034Z/`，旧包 `/root/node-bundle.bak-pre-x49-*.js`。
- worker-01：切换前备份 `/root/w01-tui/backup-20261110T045319Z/`（节点包、unit 与 drop-in、`team-device-owners.json`、全部 `.claude.json` 的 tar）；留证 `/root/w01-tui/altered-claude-json/`。

## worker-01 切 TUI 的做法（保留硬件 ID、账号、代理与绑定）

不走 `POST /api/admin/nodes/deploy`（那是新实例、新 worker 根目录）。原地改三样，其余不动：

1. 并排安装 `/opt/claude-2.1.322/claude`（`bun add @anthropic-ai/claude-code@2.1.322` 到临时目录后复制 ELF；`/opt/claude/claude` 2.1.312 与 `/usr/local/bin/claude` 不动）和 `/opt/cc-tui-shim/cc-tui-shim`（sha256 `cc55a350…`）。
2. 节点包换成含 TUI 代码的包（`dbb831f0`）。
3. drop-in `/etc/systemd/system/1dayapi-node.service.d/90-tui.conf`：`CC_WORKER_CLAUDE_BIN=/opt/claude-2.1.322/claude`、`CC_WORKER_TUI=1`、`CC_WORKER_TUI_SHIM=…`。

节点 id / `PROVIDER_CONFIG_PATH`、`CC_WORKER_ROOT`（账号目录 = 设备 ID 所在）、机器身份目录 `/opt/claude/machine-identity`、代理池与数据库绑定全部沿用。
脚本在 worker-01 `/root/w01-tui/`：`w01-backup.sh`、`w01-snap.sh`（设备 ID 快照）、`w01-switch.sh`、`w01-rollback.sh`（删 drop-in + 旧包 + 重启）、`w01-watch.sh`（盯真实会话，设备 ID 一变即回滚）。
验证：节点上报 `2.1.322 (Claude Code) (cc-tui-shim 20261108.04ed057)`、`canonical.tui=true`、`selfTestError` 空；切换前后 `accounts` / `node_proxies`（除 `last_check_at`）/ shares / claims 逐行一致；`ops/bin/device-identity-check` 三节点 74 个账号全部一致。
**未完成的验证**：05:14 重切后 worker-01 在 15 分钟内没有接到任何请求（全平台同期 62 个，落在 ccr-tui / worker-02），TUI 路径在修复包下尚未被真实流量验证；首批请求后须再跑 `device-identity-check`。

## 修复后的观察（ccr-tui，05:10–05:27）

58 个请求全部 200；3+ 个账号新开过会话，`userID` 未变；`worker_spawn_failed` 0；网关 `fixed team device identity changed` 0。

## 为什么没被发现、改了什么

- X-48 的验证只看 502 分类与首例 session_lost 重开；探针以 root 直跑；`release-verify` 无设备身份项；console 对节点上报的不一致静默跳过。
- 新增 `ops/bin/device-identity-check`（并入 `release-verify` 第 6 步）、`operations.md` §4 的强制核对步骤、回归测试 `apps/provider-node/test/trust-seed.test.mjs`。
- 待办（已列入 11-10 全量代码审查的第一优先项）：节点「root 写、降权读」的文件统一走一个原子、保留属主的写入函数并在 spawn 前硬校验；漂移自愈 + 告警；console 对不一致上报打日志计数。
