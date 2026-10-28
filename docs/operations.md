# 部署与运维

> 本文是脱敏的运维手册。逐次发布记录见 `deployment/`；凭据通过部署环境管理，本文不包含凭据。
>
> **版本说明**：v3 与协议 v2 自 2026-10-15 起使用；2026-10-27 增加实际组织隔离、对话阶段重置和代理两号/三号容量。
> 当前在线实例、节点 bundle、迁移和只读验证见 [`team-isolation-2026-10-27.md`](deployment/team-isolation-2026-10-27.md)。
> 下文带旧日期的机器数量、账号数量和路径为当时快照，不能当作当前节点清单。

2026-10-28 的完整审计修复说明见 [逐项修复记录](audit-remediation-2026-10-28.md)。当前发布的实际提交、节点 bundle、备份与验证结果另见 `deployment/audit-fixes-2026-10-28.md`。
控制台连接数从 SQLite 的共享有效账号租约汇总，覆盖蓝绿排空实例，不再依赖 `GATEWAY_URL`。
生产订阅执行节点由 `TRUSTED_EXECUTION_NODE_IDS` 明确批准；worker 开启 `CC_WORKER_TEAM_UIDS=1`，按组织分配独立 Linux UID，控制面要求 `team_uid_isolation_v1` 能力。

## 1. 生产环境

| 项 | 值 |
|---|---|
| 主机 | Contabo 美西 VPS，Ubuntu 24.04，8 vCPU / 23 GiB / 435 GB |
| 运行时 | Node.js 22、pnpm/corepack、nginx；实测版本记录在每次发布记录中 |
| 代码目录 | `/opt/1dayapi`（从本地已提交版本发布，Git 提交与 bundle 同步留存） |
| 数据 | `/opt/1dayapi/data/`（`1dayapi.db`、`provider-cred.key`、`internal.key` 等） |
| 域名 | `1dayapi.com`、`www.1dayapi.com`（Web + 控制台 API）、`api.1dayapi.com`（网关），均经 Cloudflare 代理 |
| 证书 | Let's Encrypt（certbot nginx 插件，systemd timer 自动续期）；CF SSL 模式应为 Full (Strict) |
| DNS | 三台机器 `/etc/systemd/resolved.conf.d/10-public-dns.conf`：`DNS=1.1.1.1 8.8.8.8 1.0.0.1 8.8.4.4`，`FallbackDNS=` Contabo 两台（2026-10-19）。resolved 对全局与网卡（DHCP/Contabo）两组解析器并行查询、先回者胜；节点按域名连 `wss://1dayapi.com`，10-18 23:45 CEST Contabo 解析器故障曾让两个 worker 掉线 6 分钟 |
| 请求体上限 | nginx `client_max_body_size 32m`（2026-10-18，原 10m）= 网关 Fastify `bodyLimit` 32 MB = Anthropic 官方 32 MB；节点 http_egress spec 上限 48 MiB（body base64 ×4/3）。三者需一致，否则大请求在某一层被拒而其他层无感 |
| 公网端口 | 22 / 80（301→443）/ 443；ufw 未启用 |

## 2. 进程（systemd）

| unit | 命令 | 监听 | 关键环境变量 |
|---|---|---|---|
| `1dayapi-gateway@8400` / `@8402` | `node apps/gateway/dist/index.js` | 127.0.0.1:8400 / :8402 | `HOST=127.0.0.1`；nginx 仅指向一个在线入口，`ops/bin/gateway-switch --status` 查看 |
| `1dayapi-console` | `node apps/console/dist/index.js` | 127.0.0.1:8401 | `HOST=127.0.0.1`、`TRUST_PROXY=127.0.0.1,::1`、`COOKIE_SECURE=1`、`PLATFORM_WS_URL`；`TRUSTED_EXECUTION_NODE_IDS`、`REQUIRE_TEAM_UID_ISOLATION=1`；连接数从共享 SQLite 租约汇总 |
| `1dayapi-mock-upstream` | `node apps/gateway/scripts/mock-upstream.mjs` | 127.0.0.1:19001 | — |
| `1dayapi-node` | `/root/.bun/bin/bun /root/.1dayapi-node/node-bundle.js` | 本地控制台 127.0.0.1:16889 | 平台节点 server-node-1。**2026-10-16 起 `disable --now`**：主服务器暂不跑节点，节点行保留（控制台显示离线），要恢复 `systemctl enable --now 1dayapi-node` |
| `1dayapi-backup.timer` | `/usr/local/bin/1dayapi-backup.sh` | — | 每 6 小时备份到 worker-01（见 §5） |

「1day 核心节点」（node_0065de07，310 条代理，无 systemd 托管）已于 2026-10-16 删除：目录归档在 `/opt/1dayapi/backups/core-node-archive-<ts>.tar.gz`
（含加密代理清单与 `config.key`），平台侧节点行已删。该段为 2026-10-16 的节点快照；当前供给节点以控制台和最新发布记录为准。

服务类 unit 均为 `WorkingDirectory=/opt/1dayapi`、`Restart=always`、已 enable。日志在 journald：
`journalctl -u '1dayapi-gateway@*' -f`。节点更新时保留配置、密钥、账号目录与设备身份，只替换构建后的 bundle 并重启实际托管服务。
新的隔离任务要求节点 hello 报告 `team_isolation_v1`，不能仅根据版本号判断节点已升级。

## 3. nginx

- `1dayapi.com` / `www`：`root /opt/1dayapi/apps/web/dist`，`try_files $uri /index.html`；
  `/api/`、`/auth/`、`/internal/` 反代 `127.0.0.1:8401`（带 `Host`、`X-Real-IP`、`X-Forwarded-For`；
  `/internal/` 额外带 WebSocket 升级头，`proxy_read_timeout 3600s`）。
- `api.1dayapi.com`：全路径反代 `gateway_live` 指定的在线端口（8400 或 8402），SSE 必需：`proxy_buffering off; proxy_cache off;
  proxy_http_version 1.1; proxy_set_header Connection ""; proxy_read_timeout 660s;`（2026-10-16 由 300s 调高，worker 单请求上限 600s）。
  注意 nginx 加载 `sites-enabled/*` 全部文件，**备份副本不能放在该目录**（会报 duplicate listen），放 `/etc/nginx/backup/`。
  经 Cloudflare 的非流式响应仍受其约 100s 空闲限制，长请求请用 `stream:true`。
- 经 Cloudflare 的 WebSocket 必须走 HTTP/1.1。

nginx 使用 `ops/nginx/cloudflare-realip.conf` 中 Cloudflare 官方 IPv4/IPv6 网段，仅从可信 CDN 连接接受 `CF-Connecting-IP`；各反代 location 用 `$remote_addr` **覆盖** X-Forwarded-For，同时设置 X-Forwarded-Proto。console 仅信任回环代理地址，生产启用 `COOKIE_SECURE=1`。网段来源为 [Cloudflare IPv4](https://www.cloudflare.com/ips-v4)、[IPv6](https://www.cloudflare.com/ips-v6)，机制见 [nginx realip 文档](https://nginx.org/en/docs/http/ngx_http_realip_module.html)。网段变动时需重新核验。

`/internal/tunnel/*` 的服务端鉴权始终同时检查实际回环 socket 和内部密钥，不依赖可转发的请求 IP。

## 4. 发布流程（当前为手工）

组织隔离发布会同时改变网关、控制面、前端和节点协议，需在维护窗口协调切换。按“代码与构建备份 → 同步与构建 → 新增结构迁移 → 控制面 → 节点 bundle → 网关入口 → 验证”执行。只更新主服务器、未更新节点时，旧节点不能接收新的隔离任务。

旧账号、代理、会话、用户、Key、余额和账本不回填、不修改、不删除。迁移 21/22 仅新增结构，发布前后按旧字段投影核对；不要使用自动建号、重新上号、重新导入代理或真实计费调用代替部署验证。

```bash
# 本地
pnpm install --frozen-lockfile && pnpm build
pnpm -r test && pnpm test:e2e                   # 临时库和本地上游替身
rsync -az \
  --exclude node_modules --exclude dist --exclude recon --exclude .git --exclude /data \
  --exclude /secrets --exclude /backups --exclude docs/deployment --exclude docs/customers \
  ./ <server>:/opt/1dayapi/                     # 注意：packages/catalog/data/*.json 必须带上
# 不要带 --delete：服务器 /opt/1dayapi/backups/（互备落盘）与 data/ 只存在于服务器（2026-10-21 干跑时 --delete 会把 backups/ 全删）
# 服务器
cd /opt/1dayapi && pnpm install --frozen-lockfile && pnpm build
# 在维护窗口按发布记录完成迁移、console 和节点升级；不运行旧数据回填或清理。
systemctl restart 1dayapi-console
# 替换实际 worker 服务的 bundle，保留每个节点的配置、密钥、账号和设备目录，再重启并验证能力。
ops/bin/gateway-switch            # 控制面与节点就绪后切换网关（见下）
# 核对 nginx 实际 live port；console 的连接数已读取跨实例共享租约。
```

**网关发布是零中断的（2026-10-19 起）。** 网关有两个 systemd 实例 `1dayapi-gateway@8400` 与 `1dayapi-gateway@8402`
（模板 `ops/systemd/1dayapi-gateway@.service`），nginx 的 `api.1dayapi.com` 经 `upstream gateway_live`
（`/etc/nginx/conf.d/1dayapi-gateway-upstream.conf`，源文件 `ops/nginx/`）指向其中之一。`ops/bin/gateway-switch`
会：用当前构建启动空闲实例 → 等 `/health` 通过 → 改 upstream 并 `nginx reload`（不断开任何连接）→ 停掉旧实例
（旧实例最多排空 25 min，`DRAIN_TIMEOUT_MS=1500000`，要长于 worker 单轮上限 20 min；2026-10-19 09:10 前是 75 s，曾切断 4 条长流）。`gateway-switch --status` 查看哪个实例在线。旧的 `1dayapi-gateway.service` 已停用，
不要再 `systemctl restart 1dayapi-gateway`：那会先关监听端口再排空，期间 nginx 对新请求返回 502（2026-10-19 实测
每次重启丢 4 个请求，高峰会更多）。

`gateway-switch` 更新 nginx 入口；2026-10-28 起 console 与所有网关共用账号租约、RPM 与用户在途预算。90 秒租约每 30 秒续期，失去租约立即取消上游，不能在到期后复活旧持有者。发布记录中的旧 `GATEWAY_URL` drop-in 可以保留，连接数已不再读取它。

切换不丢亲和：粘性会话 / 设备池自 2026-10-21 起落在 `affinity_bindings` 表（迁移 16），新实例启动日志有
`affinity: N session / M device bindings, K worker turn memories carried over`；在此之前每次切换都会把全部活跃对话和设备重新发牌、
worker 会话全部 fresh 重放（gateway.md §3、worker-sessions.md 进度 2026-10-22）。

**发布完成的定义（2026-10-28 起）**：`ops/bin/release-verify` 通过才算完成——网关 `/health`、一条真实 claude-sonnet-5-5 请求 200、
公开池 online 账号数不低于发布前、节点心跳新鲜、探针一轮全绿。发布记录附它的输出。只有本地模拟测试通过的发布不算完成
（10-27 / 10-28 两次发布测试全过，上线后平台 36 小时无法服务，无人知晓）。

**告警（2026-10-28 起）**：`/root/monitor/func.py` 末尾挂了 `ops/monitor/func-alert-hook.py`，连续 2 轮失败经 `ops/monitor/alert.py`
推送（Telegram 或 webhook，配置 `/root/monitor/alert.conf`）；worker-01 上 `1dayapi-extprobe.timer` 每 2 分钟从外部打
`/health` 和 `/v1/models`，主服务器整机故障时由它报警。`python3 /root/monitor/alert.py test` 验证通道。

发布后验证：

```bash
curl -s https://api.1dayapi.com/health
curl -s https://api.1dayapi.com/v1/models -H "Authorization: Bearer <consumer key>" | head -c 200
curl -s -o /dev/null -w '%{http_code}\n' https://1dayapi.com/login   # 期望 200
```

注意事项：

- 普通 rsync 排除 `data/`、`backups/`、凭据和历史部署目录；本次新建的脱敏发布记录可单独同步，不能把凭据文件混入。
- 先完成新增结构迁移，再重启 console，升级并验证节点，最后切换 gateway。console 重启会短暂断开节点链路，节点自动重连。
- **gateway 优雅停机**：收到 SIGTERM 后停止接新连接、等待在途请求；当前模板使用 `DRAIN_TIMEOUT_MS=1500000`，旧实例最多排空 25 min。实际值以已安装 unit 为准；不要照旧文档的 75s 超时重建 unit。
- **节点自 2026-10-17 起也优雅停机**：SIGTERM → `bridge.beginDrain()`（立即心跳 `acceptingSessions:false`，不再接新会话）→ 等在途
  会话跑完，最多 `NODE_DRAIN_MS`（默认 60s；unit `TimeoutStopSec` 90s）→ 关闭。配合 console `waitForNodeConn`（新会话找不到可接单的
  节点时最多等 `NODE_WAIT_MS`=20s，网关 `OPEN_TIMEOUT_MS` 相应 25s），节点重启对客户表现为最多几十秒的延迟而不是 502/503
  （此前一次重启打断 12 条在途请求）。**console 重启仍会打断全部在途隧道**（数据面经它中转），只能挑低谷；本日两次 console 重启各打断
  约 10 条。
- 回滚使用发布前代码/构建和服务配置快照。新增结构保留，不能为了回滚代码而覆盖或删除运行中的数据库；涉及数据库回退需单独决定。
- 改 catalog 价格、改表结构都需要重新构建并重启两个服务。

## 5. 数据与备份

- **互备（2026-10-16 起）**，两台机器各有 `1dayapi-backup.timer`，每 6 小时一次，`Persistent=true`：
  - 主服务器 `/usr/local/bin/1dayapi-backup.sh`：`VACUUM INTO` 在线快照 + `PRAGMA integrity_check` → 加 `provider-cred.key`、`internal.key`、
    systemd 单元、nginx `sites-enabled`、`/root/monitor` 凭据 → `backups/auto/<ts>.tar.gz`（0600）→ rsync 到 worker-01 `/backup/1dayapi-main/`。
    本地保留 28 份，对端 60 份。
  - worker-01 `/usr/local/bin/1dayapi-backup.sh`：节点配置 `/root/.config/1dayapi-provider-node/`（`config.json` 含节点密钥与加密代理池、
    `config.key`）+ `cc-worker-root.tar.gz`（`/var/lib/1dayapi-cc-worker/cc-accounts/<id>/.credentials.json`，排除 cc-sessions 与
    Claude Code 的 projects/skills/plugins 缓存）+ `1dayapi-node.service`
    → `/backup/1dayapi-worker-local/<ts>.tar.gz` → rsync 到主服务器 `/opt/1dayapi/backups/worker-01/`。
  - 两机互相持有对方 root 的 ed25519 公钥（仅用于备份 rsync，密码登录未改）。手动触发：`systemctl start 1dayapi-backup.service`；
    看结果：`journalctl -u 1dayapi-backup`。
  - worker-01 另有 `1dayapi-cc-cleanup.timer`（每日 04:15）删除 1 天前的 Claude Code worker 对话记录（`/var/lib/1dayapi-cc-worker/cc-accounts/*/projects`，是客户内容，
    每请求新进程不会复用；首日已达 100 MB）。2026-10-16 起 worker 以 `--no-session-persistence` 运行，不再产生新记录；该定时器只清历史。
  - worker 以服务用户 `ccworker` 运行，二进制在 `/opt/claude/claude`（`/usr/local/bin/claude` 指向它）；worker 根目录为
    `/var/lib/1dayapi-cc-worker/`（`cc-accounts/` 账号凭据 **和账号的设备身份** `.claude.json`（userID / oauthAccount.accountUuid，平台经心跳同步到
    `accounts.device_id / account_uuid`，直连路径也用它改写客户的 metadata.user_id —— **这个目录不能清空重建**，否则 99 个账号同时"换设备"；
    备份 `cc-worker-root.tar.gz` 已包含它）、`cc-sessions/` 每会话 scratch，正常情况下后者为空；ccr-supply.md §8.1
    "worker 隔离"）。旧位置 `/root/.config/1dayapi-provider-node/cc-accounts/` 已不再使用（含隔离前的客户对话记录，保留；本次发布不清理或迁移）。
- 手工备份仍应用 `VACUUM INTO` 或 `sqlite3 .backup`，不要直接 cp 主库文件。
- `provider-cred.key` 必须与 DB 分开备份、分开保管；丢失它则所有号商凭证不可解密，
  与 DB 一起泄露则全部可解密。
- `admin-key.txt` 是首启生成的 admin 明文，确认已转存后应删除；该明文也出现在当次启动日志里。
- 表结构变更前先备份；Auth v2 迁移时的旧库备份为 `data/1dayapi.db.authv1.bak`。

## 6. 常见运维操作

| 操作 | 方法 |
|---|---|
| 签发密钥 | Dashboard「密钥管理」，或服务器上 `node apps/console/scripts/issue-key.mjs --role <role> --label <name>` |
| 吊销密钥 | Dashboard 或 `DELETE /api/admin/keys/:id`（admin 密钥） |
| 调余额 | Dashboard 或 `POST /api/admin/keys/:id/adjust-balance` |
| 切换真实上游 | 控制台「上游账户」（v3 起无 `UPSTREAM_*` 环境变量） |
| 关闭号商隧道 | 停用 `route=node` 的账户或禁用号商 / 移除节点（v3 起无 `PROVIDER_TUNNEL_ENABLED`） |
| 查看前端错误 | `data/client-errors.log`（目前前端未上报） |
| 证书续期 | certbot timer 自动；手动 `certbot renew --dry-run` 检查 |
| 发布后验证 | `ops/bin/release-verify`（真实请求 + 探针 + 池 online 数）；不通过不算发布完成 |
| 告警通道 | `/root/monitor/alert.conf`；`python3 /root/monitor/alert.py test` |
| 新增 worker 节点 | 见下方检查清单 |

**新增 worker 节点检查清单**（每一步都有机器可验的产出，别跳）：

1. 控制台「节点」→ SSH 部署（2026-10-17 起脚本自带：unzip、bun、claude 2.1.312 → `/opt/claude/claude`（2026-10-28 起；此前 2.1.300）、`ccworker`、worker 根目录、隔离自检，
   自检失败则整个部署失败并把输出留在 `deployMeta.log`），或手工 `install.sh`（一键或 `--local`）；日志里必须看到
   `worker isolation self-test PASSED: ccworker ran claude <ver>`；看到 `FAILED`
   先按提示修（`id ccworker`、`ls -ld /var/lib/1dayapi-cc-worker` 应为 `drwx--x--x root`、`sudo -u ccworker claude --version`）。
2. `1dayapi-node install-service && 1dayapi-node restart` 后 `journalctl -u 1dayapi-node` 必须出现
   `[cc-worker] workers run as ccworker (uid N), tools: none, root /var/lib/1dayapi-cc-worker`，且**没有** `SELF-TEST FAILED`。
   节点为 root 时默认降权；若日志显示 `the node user (no privilege drop)`，说明 `ccworker` 用户缺失，worker 会以节点用户跑，不合格。
3. 控制台节点页 `deploy_meta.ccWorker.enabled` 为 true、`selfTestError` 为空；为 false/非空时节点会以 `self_test_failed: …` 拒绝会话。
4. 把一个账号绑到该节点后，用平台 key 走 `https://api.1dayapi.com` 发一条非 CC 请求（见 §7.1），`/api/admin/errors/summary` 无该节点 502；
   再发一条带图片的请求确认 worker 路径（图片只在 worker 可用）。
5. 顺手确认 `/root/.config/1dayapi-provider-node/` 下**没有** `cc-accounts/`、`cc-sessions/`（旧位置，有就是旧 bundle）。
6. 新隔离节点 hello 必须包含 `team_isolation_v1`，平台与节点均校验 team / account / proxy / generation。需要每组织独立系统身份时，使用 `apps/provider-node/packaging/linux/1dayapi-team@.service`，分别配置 `PROVIDER_TEAM_ID`、状态目录和本地端口。
7. 保留旧目录与设备身份。本次发布不安装或运行旧数据清理任务；历史备份与清理机制见 §5，不能将历史说明当作本次的执行指令。

## 7. 监控与告警

没有指标、告警、日志集中与错误追踪。现有的只有一个功能探针：主服务器 `1dayapi-monitor.timer`
每 10 分钟跑 `/root/monitor/func.py`（经公网打 messages / chat 的流式与非流式、工具调用，再以 admin 登录控制台核对
usage 行、账户与节点状态），每次一行 JSON 追加到 `/root/monitor/func.jsonl`，`journalctl -u 1dayapi-monitor` 可看摘要。
探针里的 `cc_dual_mode`（带 Claude Code UA 走订阅号直连）2026-10-16 起改为发送 Claude Code 形态的 body（计费头 system 块 +
`metadata.user_id`，见 docs/claude-code-compat.md §5）：此前它不带计费头，Anthropic 对这种请求恒回 429，每 10 分钟把账户
打入一次 429 冷却。`PROBE_CC_DUAL_MODE=0` 可临时关掉这一项。
最低建议补齐：外部探活 `/health`、磁盘与 DB 大小、journald 中 `[billing] failed` 与 `unhandled error` 的计数。

**Claude Code 形态判定（gateway.md §2a）上线后的观察项**：`journalctl -u 1dayapi-gateway | grep '\[cc-shape\]'` 看 suspect 行
（谁、缺了什么），控制台「用户」列表看「伪造 CC（30 天）」。策略默认 `observe`，确认真实 CC 用户长期为 0 suspect 后在「设置」切到
`downgrade`。genuine 但带 `soft=` 的行说明 Claude Code 发了新版本、形态有漂移，要去 docs/claude-code-compat.md 核对并更新常量。
判定只在网关（主服务器）执行，节点（worker-01 / 核心节点）只负责出口，不需要任何改动。

## 7.1 测试与探针的铁律：只经平台 Key 走网关

**任何测试、探针、冒烟请求都必须打 `https://api.1dayapi.com`，用平台签发的 Key**（探针用 `/root/monitor/apikey.txt`，
人工验证用控制台里签发的 consumer key）。网关会经账号绑定的节点代理出去，上游看到的仍是该账号一贯的 IP 与指纹。

**禁止**拿订阅账号的 OAuth / access token 直连 `api.anthropic.com`（或任何上游），包括"只是快速看一眼"、挂一个别的 socks
代理也不行：账号与节点代理终身绑定（docs/onboarding.md §1），换 IP 直连会导致**封号**。2026-10-16 已删除直连脚本
`survival_watch.py`（服务器 `/opt/ccr-lab/` 与仓库 `recon/lab/`）；`recon/lab/direct_probe.py`、`direct_full.py`、`survival_check.py`
同属直连脚本，只作历史记录，不得再运行或扩展。确需直连验证的，先找管理员拍板。

## 7.2 节点监控看板（`/console/admin/node-monitor`，2026-10-17）

管理员仪表盘「在线节点」卡片可点击进入；左侧导航「节点监控」。每个节点一张卡，数据两部分：

- **节点心跳快照**（`provider.heartbeat` 的 `host` / `egress` / `ccWorker` / `proxies`，console 收到后写进 `nodes.metrics` JSON，
  每 30 秒刷新）：节点版本、bundle 指纹（sha256 前 12 位，与 `data/bundle-cache/node-bundle-<hash>.js` 对应）、Bun / Claude Code 版本、
  主机内存与负载、节点进程 RSS、worker 进程 RSS 合计、常驻会话池 live/idle/busy/parked 与上限、退休原因计数、直连出口会话数、
  在途请求、worker 并发、节点视角的代理 live/dead/unknown。
- **平台侧事实**（admin 路由里现算）：账号 总数/活跃/代理正常/冷却中、容量占用、代理池 live/total、经该节点的流量
  1h 请求/错误/平均耗时、24h 请求/错误/计费。

健康徽标判定顺序：离线 → 心跳过期（>90s）→ 排空中 → 不接新会话 → worker 自检失败 → 内存占用 >85% → 健康。
页面每 15 秒自取 `GET /api/admin/nodes/monitor`。旧 bundle 的节点没有 `host` 字段，卡片会显示「尚无心跳指标」，推新 bundle 即可。
排障入口仍然是 journald（§2）；看板只回答"哪台、哪项不对"，不替代日志。

## 8. v3 发布要点（已于 2026-10-15 执行完毕，存档备查）

- 发布前在服务器备份 `data/`（**必须包含 `provider-cred.key`**，否则迁移后的账户凭证无法解密）；首次启动 v3 会自动执行迁移 1，旧表保留为 `legacy_v2_*`。
- 先启动 console 再启动 gateway（两者都能执行迁移，有并发保护）；两个 unit 的 `DATA_DIR` / `DB_PATH` 必须一致。
- console：`TRUST_PROXY=127.0.0.1,::1`、`COOKIE_SECURE=1`、`CONSOLE_CORS_ORIGINS=https://1dayapi.com`、`PLATFORM_WS_URL=wss://…/internal/provider/connect`。
- gateway：删除 `UPSTREAM_*`、`PROVIDER_TUNNEL_ENABLED`；上游改为在控制台"上游账户"里配置（迁移会把原 env-fallback 账户带过来，Base URL 为平台默认，需按实际修改或停用）。
- nginx：对公网只放行 `/internal/provider/*`（节点用），`/internal/tunnel/*` 不应对外（即使对外也有内部令牌保护）。
- v2 的运维操作对应关系：签发密钥 → 控制台"用户"新建；吊销 → 禁用用户 / 重置登录密钥；调余额 → 用户详情"调账"；切换上游 → "上游账户"；
  关闭号商隧道 → 停用 `route=node` 账户或禁用号商；`data/client-errors.log` 不再写入。
- 回归：`pnpm build && pnpm test:e2e`。
