# 加固发布（X-50）：发布记录（2026-11-10）

内容与行为变化见 `../code-review-2026-11-10.md`；决策登记 X-50。时间均为 UTC。提交 `a01c6dc`（分支 `hardening-2026-11-10`，基于 `39cbc48`，40 个提交）。

## 发布前

- 本地 `pnpm gate`：846 通过 / 0 失败（catalog 6、core 168、gateway 376、console 118、e2e 178；e2e 在仅回环的网络命名空间内）。
- 服务器 `ops/bin/release-build hardening-2026-11-10` → `/opt/1dayapi-releases/a01c6dcc…/`，闸门同样 846 / 0，`RELEASE_OK`。线上运行的 dist 取自这个目录（rsync，不在线上目录重新构建）。
- 节点的 root 属主测试在主服务器以 root 运行（bun 复制到 `/opt/1dayapi-test-bun/` 供降权用户执行）：trust-seed、account-files、device-identity、team-isolation、cc-worker 通过。`team-uid` 失败：夹具 `fake.mjs` 在该机的 711 临时目录下被降权进程报 Module not found，改动前同样失败（测试夹具问题，降权本身生效）。
- `ops/bin/device-identity-check --save /root/monitor/device-baseline-20261110T065155Z.txt`：三节点 74 个账号全部一致；无进行中的上号作业；三台节点都有 `ccworker`。
- 备份：`data/backups/1dayapi.db.pre-hardening-20261110T065155Z.bak`（VACUUM INTO，1.2 GB）、`backups/pre-hardening-20261110T065155Z-dist.tgz`；旧 web 在 `apps/web/dist.old`。

## 步骤与结果

| 时间 | 步骤 | 结果 |
|---|---|---|
| 06:52 | `git merge --ff-only`，同步 dist（catalog / core / gateway / console / provider-node；web 经 dist.new 交换） | main = `a01c6dc` |
| 06:52 | `systemctl restart 1dayapi-console` | `master key check value recorded`；启动时把 3 个节点复位为离线，2 秒内全部重连；无迁移 |
| 06:53 | `ops/bin/gateway-switch` | 切换前探针 `127.0.0.1:8400` HTTP 200 → live 8400，8402 排空 |
| 06:54 | worker-02 节点包 → `3b366e30…`（`/root/node-roll.sh … roll`，先 tar 全部 `.claude.json`） | 5 个账号新开会话，spawn_failed 0，身份告警 0 |
| 06:56 | ccr-tui 节点包 | 6 个账号新开会话，spawn_failed 0，身份告警 0 |
| 06:58 | worker-01 节点包（TUI + Claude Code 2.1.322 不变） | 4 个账号新开会话，spawn_failed 0，身份告警 0 |
| 07:04 | `ops/bin/release-verify` | `RELEASE VERIFIED`（真实请求 200、online 73、3 节点心跳、探针全绿、第 6 步设备身份 OK） |

每台节点滚动后都跑了 `device-identity-check`：始终 74 / 74 一致；三节点心跳 `identityDrift` 全为 0。
发布后 11 分钟（06:53–07:04）：215 个请求，200 × 210，502 × 5（2.3%；发布前一小时 11 / 851 = 1.3%），499 × 1。`retry_cap_tripped_total{same_failure}` 触发 1 次（同一请求在 3 个账号上都是 worker 502，按新规则直接回客户，不再继续换号）。

## 回滚

- 网关：`ops/bin/gateway-switch --rollback`（旧实例排空期内）；之后需恢复旧 dist（`backups/pre-hardening-…-dist.tgz`）再切。
- console：解包同一个 dist 备份后 `systemctl restart 1dayapi-console`。`settings.__master_key_check__` 一行可保留（旧代码不读）。
- 节点：各节点 `/root/node-roll.sh <unit> <app-dir> rollback`（旧包 `/root/node-bundle.bak-pre-hardening-<unit>.js`；账号配置备份 `/root/claude-json-pre-hardening-<unit>.tgz`）。
- 无数据库迁移，无需回退数据。

## 观察到的、与本次发布无关或待跟进的

- **TUI 节点图片粘贴失败**（`Claude Code did not take an image pasted as its path`）：发布前一小时 ccr-tui 384 次启动中 42 次，发布后仍在；worker-01 改 TUI 后，带图请求只有 worker-02（`-p`）能接。X-48 的待办，未修。
- TUI 节点偶发 `claude exited 1:`（原因行为空）；worker-01 切 TUI 后 3 次 `worker exited without a result`（opus-4-6 / sonnet-4-6），未查。
- console 在节点重连时为不再绑定该节点的旧账号目录逐个打一行 `device identity report ignored … account is not bound to this node`（限频，仅提示）。
- 仍未执行的服务器侧步骤：`code-review-2026-11-10.md` §5.2 的第 5–8 步（age 加密备份与恢复演练、收紧两机 root 互信、journald、发布目录迁移）、nginx `location ^~ /internal/tunnel/ { return 404; }`、审计重脱敏脚本（`apps/console/scripts/redact-audit-2026-11-10.mjs`，默认 dry-run，未运行）。
- `usage_credits_policy` 保持 `off`。
