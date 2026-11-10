# 部署与运维

> 本文是脱敏的运维手册。逐次发布记录见 `deployment/`；凭据通过部署环境管理，本文不包含凭据。
>
> **版本说明**：v3 与协议 v2 自 2026-10-15 起使用；2026-10-27 增加实际组织隔离、对话阶段重置和代理两号/三号容量。
> **发布前必读 [`iron-rules.md`](iron-rules.md)**：上游可见改动必须三态开关 + 灰度测试组 + ≥24h 观察；一天最多一轮；必须有可回滚快照。
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
| 公网端口 | 22 / 80（301→443）/ 443；ufw **已启用**（22/tcp LIMIT、80/tcp、443/tcp ALLOW；2026-11-01 核对） |

## 2. 进程（systemd）

| unit | 命令 | 监听 | 关键环境变量 |
|---|---|---|---|
| `1dayapi-gateway@8400` / `@8402` | `node apps/gateway/dist/index.js` | 127.0.0.1:8400 / :8402 | `HOST=127.0.0.1`；nginx 仅指向一个在线入口，`ops/bin/gateway-switch --status` 查看 |
| `1dayapi-console` | `node apps/console/dist/index.js` | 127.0.0.1:8401 | `HOST=127.0.0.1`、`TRUST_PROXY=127.0.0.1,::1`、`COOKIE_SECURE=1`、`PLATFORM_WS_URL`；`TRUSTED_EXECUTION_NODE_IDS`、`REQUIRE_TEAM_UID_ISOLATION=1`；连接数从共享 SQLite 租约汇总 |
| `1dayapi-mock-upstream` | `node apps/gateway/scripts/mock-upstream.mjs` | 127.0.0.1:19001 | — |
| `1dayapi-node` | `/root/.bun/bin/bun /root/.1dayapi-node/node-bundle.js` | 本地控制台 127.0.0.1:16889 | 平台节点 server-node-1。**2026-10-16 起 `disable --now`**：主服务器暂不跑节点，节点行保留（控制台显示离线），要恢复 `systemctl enable --now 1dayapi-node` |
| `1dayapi-backup.timer` | 现网：`/usr/local/bin/1dayapi-backup.sh`（不在仓库）；目标：`ops/bin/backup`（unit 在 `ops/systemd/1dayapi-backup.{service,timer}`） | — | 每小时（`*:30`）。现网脚本把库和主密钥打进同一个明文包发到 worker-01，**待按 §5 切换到加密方案** |

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
pnpm install --frozen-lockfile
pnpm gate                                       # = ops/bin/test-gate：构建 + 单元测试 + e2e，对照 tests/e2e/known-failures.txt（见 §4.1）
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
ops/bin/gateway-switch            # 控制面与节点就绪后切换网关：先对新实例发一条真实请求，200 才切（见下）
ops/bin/release-verify            # 不通过 = 发布未完成；失败时它会打印回滚命令（ops/bin/gateway-switch --rollback）
# 核对 nginx 实际 live port；console 的连接数已读取跨实例共享租约。
```

没有 CI：`pnpm gate` 是唯一的合并 / 发布闸门，**不通过不得同步到服务器**。发布目录化（`ops/bin/release-build`）与迁移计划见 §4.2。

**网关发布是零中断的（2026-10-19 起）。** 网关有两个 systemd 实例 `1dayapi-gateway@8400` 与 `1dayapi-gateway@8402`
（模板 `ops/systemd/1dayapi-gateway@.service`），nginx 的 `api.1dayapi.com` 经 `upstream gateway_live`
（`/etc/nginx/conf.d/1dayapi-gateway-upstream.conf`，源文件 `ops/nginx/`）指向其中之一。`ops/bin/gateway-switch`
会：用当前构建启动空闲实例 → 等 `/health` 通过 → **切换前探针：用探针 Key 直接对新实例 `127.0.0.1:<端口>` 发一条真实请求，必须 200**（2026-11-10 起，见下）→ 改 upstream 并 `nginx reload`（不断开任何连接）→ 停掉旧实例
（旧实例最多排空 25 min，`DRAIN_TIMEOUT_MS=1500000`，要长于 worker 单轮上限 20 min；2026-10-19 09:10 前是 75 s，曾切断 4 条长流）。`gateway-switch --status` 查看哪个实例在线。旧的 `1dayapi-gateway.service` 已停用，
不要再 `systemctl restart 1dayapi-gateway`：那会先关监听端口再排空，期间 nginx 对新请求返回 502（2026-10-19 实测
每次重启丢 4 个请求，高峰会更多）。

**切换闸门与回滚（2026-11-10 加固）。** 此前只要静态 `/health` 回 ok 就切流量，而 `/health` 不经过鉴权、选号、节点隧道中的任何一环
（10-27 / 10-28 两次发布 `/health` 全程正常、平台 36 小时无法服务）。现在：

| 行为 | 说明 |
|---|---|
| 切换前探针 | 新实例 `/health` 通过后，用 `/root/monitor/apikey.txt`（`PROBE_KEY_FILE`）对 `http://127.0.0.1:<新端口>/v1/messages` 发一条与 `release-verify` 第 2 步相同的请求（`claude-sonnet-5-5`，`max_tokens 16`）。非 200 → 停掉新实例、nginx 不动、退出 1。没有探针 Key 时在**启动任何东西之前**拒绝运行 |
| `--no-probe` | 唯一的跳过方式，必须显式写出，并在发布记录里说明原因（例如全池窗口耗尽时的紧急发布） |
| 拒绝在排空期重入 | 目标实例仍是 `deactivating`（上一次切换的旧实例还在排空，最长 25 min）时拒绝运行：此时 `systemctl restart` 会切断它的在途流。目标实例意外 `active`（保留窗口或手工启动）同样拒绝，并提示怎么处理 |
| `--hold <秒>` | 切换后旧实例**先不排空**，保留 N 秒（systemd 临时定时器 `1dayapi-gateway-holdstop-<端口>` 到点再停）。保留期内旧进程内存里仍是**旧代码**，`--rollback` 是瞬时且真正回到旧版本。风险发布建议 `--hold 600`；保留期内两个实例都完全在线（与平时切换那十几秒的状态相同，只是更久） |
| `--rollback` | 把 nginx 指回上一个实例：① 上一个实例还在运行（保留期）→ 直接切回，不重启；② 正在排空 → 它已不监听、systemd 在排空结束前也无法再启动它，脚本拒绝并提示等待，或加 `--force-restart`（立即杀掉，**切断其在途流**）；③ 已停止 → 用**磁盘上当前的构建**启动它（过健康检查与探针）再切回。第 ③ 种只有先恢复了上一个版本的构建才算回滚代码 |
| `nginx -t` 失败 | upstream 文件还原，且（新增）把刚启动的新实例停掉，不再留一个无人知晓的在线实例 |

`release-verify` 失败时会在末尾打印上面的回滚命令和三种情况。**回滚代码**的步骤（当前目录布局）：`git -C /opt/1dayapi checkout <上一个提交>` →
`pnpm install --frozen-lockfile && pnpm build` → `ops/bin/gateway-switch --rollback`（或直接再跑一次 `gateway-switch`）；console 需同样 `systemctl restart 1dayapi-console`。
§4.2 的发布目录布局下只需把 `current` 软链指回上一个目录。数据库结构不随代码回滚（见 §4.3）。

网关计数器正从公开的 `/health` 迁到带内部令牌的 `/internal/metrics`：`ops/bin/gateway-counters` 先带 `x-1dayapi-internal`（`INTERNAL_TOKEN` 或 `<DATA_DIR>/internal.key`）
问在线实例的 `/internal/metrics`，失败再退回 `/health.counters`；`canary-verify`、`canary-report`、`canary-phase-switch`、`canary-cc-probe` 都经它读取。
两处都读不到计数器时它退出 3，`canary-verify` 记为失败（"读不到" 不等于 "全为零"）。计数器是进程内的：切换后新实例从 0 开始。

`gateway-switch` 更新 nginx 入口；2026-10-28 起 console 与所有网关共用账号租约、RPM 与用户在途预算。90 秒租约每 30 秒续期，失去租约立即取消上游，不能在到期后复活旧持有者。发布记录中的旧 `GATEWAY_URL` drop-in 可以保留，连接数已不再读取它。

切换不丢亲和：粘性会话 / 设备池自 2026-10-21 起落在 `affinity_bindings` 表（迁移 16），新实例启动日志有
`affinity: N session / M device bindings, K worker turn memories carried over`；在此之前每次切换都会把全部活跃对话和设备重新发牌、
worker 会话全部 fresh 重放（gateway.md §3、worker-sessions.md 进度 2026-10-22）。

**发布完成的定义（2026-10-28 起）**：`ops/bin/release-verify` 通过才算完成——网关 `/health`、一条真实 claude-sonnet-5-5 请求 200、
公开池 online 账号数不低于发布前、节点心跳新鲜、探针一轮全绿、**各节点账号设备 ID 与登记值一致（第 6 步，X-49）**。发布记录附它的输出。只有本地模拟测试通过的发布不算完成
（10-27 / 10-28 两次发布测试全过，上线后平台 36 小时无法服务，无人知晓）。

**节点变更的设备身份核对（2026-11-10 起，X-49，强制）**：账号的设备 ID（`.claude.json` 的 `userID` = `accounts.device_id`）、
机器身份、出口绑定是账号的「硬件」，任何发布都不得改变。凡是动节点包、Claude Code 版本、节点 unit / 环境变量、worker 根目录的发布：

1. **发布前**：`ops/bin/device-identity-check --save /root/monitor/device-baseline-<ts>.txt` 必须 `DEVICE IDENTITY OK`（不 OK 先查清，不带病发布）；
   在目标节点备份全部 `.claude.json`（`tar` 保留属主；worker-01 的做法见 `deployment/2026-11-10-x49-device-identity.md`）。
2. **先发一台**，等这台节点上**至少 3 个不同账号各完成一次新开会话**（节点日志 `started tun_…`），再跑一次 `ops/bin/device-identity-check`；
   通过才发下一台。只看「请求 200」不够：X-48 被改写设备 ID 的那一轮请求本身是 200。
3. **发布后 30 分钟**再跑一次，输出贴进发布记录；同时确认节点日志 `worker_spawn_failed` 为 0、网关日志没有 `fixed team device identity changed`。
4. 任一步出现 `DEVICE IDENTITY DRIFT`：立即回滚该节点（旧包 + 重启），按基线 / `accounts.device_id` 写回（脚本同上记录），再查原因。
5. 改到「节点替账号写文件」的代码（`.claude.json`、`.credentials.json`、`settings.json`、账号目录）时，评审必须回答：写完之后属主、权限是谁？
   Claude Code 以哪个 uid 读？并有以 root 运行的属主断言测试（参照 `apps/provider-node/test/trust-seed.test.mjs`）。
   假上游探针必须经 machine-identity launcher 以团队 uid 运行，以 root 直跑的探针发现不了这类问题。

`ops/bin/release-verify` 第 6 步已包含该检查；它失败 = 发布未完成。

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

### 4.1 测试闸门（没有 CI，2026-11-10）

`ops/bin/test-gate`（`pnpm gate`）= `pnpm build` + catalog / core / gateway / console 单元测试 + `tests/e2e/run.sh`，把失败的测试名与
`tests/e2e/known-failures.txt` 对照，打印一段摘要：

- 出现**不在名单里的失败** → 退出 1（新回归）；
- 名单里的条目**现在通过了或已不存在** → 也退出 1：修好它的那次改动必须同时删掉名单里的那一行，否则同一个测试以后再坏不会被发现；
- 构建失败、测试命令没跑出任何测试名就退出 → 退出 1。

名单格式：`unit/<包>: <顶层测试名>`、`e2e/<套件文件>: <检查名>`，每条上方写明起始日期、原因、谁负责。基线（2026-11-09，提交 39cbc48）：e2e 8 个套件 178 项检查
**0 失败**；单元测试只有 `unit/console: test/audit-fixes.test.mjs` 一条已知失败（测试结束后仍有定时器访问已关闭的库）。
旧说法“e2e 有 34 个既有失败（gpt-5.5 不在目录）”属于过期的 `~/1dayAPI.com` 检出，本仓库不存在。

e2e 只用临时 `DATA_DIR` 和本机 mock 上游。闸门在内核允许时把 e2e 放进**只有回环的空网络命名空间**（`unshare -n`），任何测试都不可能连到真实上游，
也不会和本机正在运行的服务抢端口；`E2E_NETNS=0` 关闭，`E2E_NETNS=1` 强制。`tests/e2e/run.sh` 等服务就绪改为轮询各自的 `/health`（上限 `E2E_WAIT_SEC`，默认 30 秒），
不再靠固定 `sleep`；每个套件结束打印一行 `SUITE-RESULT <文件> ok|failed|stack-failed` 供闸门解析。套件本身未改。

**不要在生产检出目录里直接跑 `pnpm -r test`。** core 的若干单元测试（`pure`、`window`、`cc-shape` 等）和 console 的 `proxy-parse` 没有设置 `DATA_DIR`，
import core 时会打开「代码根目录/data」——在 `/opt/1dayapi` 里那就是生产库（打开即执行迁移，见 §4.3）。闸门会给所有测试一个一次性的默认 `DATA_DIR`，
所以在服务器上只通过 `pnpm gate` / `ops/bin/release-build` 跑测试。

### 4.2 发布目录与 `current` 软链（分阶段迁移计划，尚未执行）

现状的三个问题：① 服务直接从可变的检出目录 `/opt/1dayapi` 运行，`rsync` / `pnpm build` 的中间状态就是下一次进程重启会加载的代码
（`Restart=always`，网关崩溃重启会拿到半个构建）；② 回滚要在生产目录里现场 checkout + 重新构建；③ `DATA_DIR` 默认是「代码根目录/data」
（`packages/core/src/paths.ts`），代码目录一换，服务会在空目录里生成一个新库和**新主密钥**（现在由主密钥守卫挡住，见 §5.2）。

目标布局：

```
/opt/1dayapi-releases/<git sha>/      ops/bin/release-build 产出：该提交的导出 + node_modules + dist，带 RELEASE_OK 标记，建成后不再修改
/opt/1dayapi-releases/current  ->  <git sha>     各 unit 的 WorkingDirectory；发布 = 原子地改这个软链
/var/lib/1dayapi/data/                DATA_DIR：库、provider-cred.key、internal.key、settlement-journal …（阶段 3 之前仍是 /opt/1dayapi/data）
/opt/1dayapi/backups/                 备份落盘位置不变
```

`ops/bin/release-build <提交>`：在 `$RELEASES_DIR`（默认 `/opt/1dayapi-releases`）下 `git archive` 导出该提交（只含已提交内容）→
`pnpm install --frozen-lockfile` → `pnpm build` → `ops/bin/test-gate --no-build` → 改名为 `<sha>/` 并写 `RELEASE_OK`。任何一步失败都删除半成品目录、退出 1。
它**只构建**：不碰软链、服务、nginx、数据库。`release-build --list` 列出已有目录和 `current` 指向。`RELEASE_SKIP_GATE=1` 只写 `RELEASE_UNVERIFIED`，新布局的 unit 不会从这样的目录启动。

新布局的 unit 模板放在现有 unit 旁边，带 `.next` 后缀，**现在不安装**：`ops/systemd/1dayapi-gateway@.service.next`、`ops/systemd/1dayapi-console.service.next`
（`WorkingDirectory=/opt/1dayapi-releases/current`、显式 `DATA_DIR`、`ConditionPathExists=…/current/RELEASE_OK`）。现有 `1dayapi-gateway@.service` 的路径未改。

| 阶段 | 做什么 | 生产影响 | 退回 |
|---|---|---|---|
| 0（现在可做） | 每次发布前在服务器上跑 `ops/bin/release-build <提交>`，只当作「这个提交在生产机上能装、能构建、过闸门」的验证；生产仍从 `/opt/1dayapi` 运行 | 无 | — |
| 1 | 给 `1dayapi-console`、`1dayapi-gateway@` 加 drop-in `Environment=DATA_DIR=/opt/1dayapi/data`（与当前默认值相同，行为不变），随下一次例行重启生效；确认两个服务启动日志无 `[core/crypto]` 告警 | 无（值相同） | 删 drop-in |
| 2 | 低谷窗口：`ln -sfn <sha> current`；安装 `.next` 模板（console 先把现有 unit 的 `Environment=` 抄进 `/etc/1dayapi/console.env`）；`systemctl daemon-reload`；重启 console；`gateway-switch`；nginx 的 web 根目录改为 `/opt/1dayapi-releases/current/apps/web/dist`；`ops/bin/*` 的调用路径改用 `current/ops/bin/` | console 重启一次（会断在途隧道，同平时发布） | 装回旧 unit（发布前先 `cp` 备份）、`gateway-switch` |
| 3 | 维护窗口：停两个服务 → `mv /opt/1dayapi/data /var/lib/1dayapi/data` → 改 unit 的 `DATA_DIR`、`/etc/1dayapi/backup.conf`、ops 脚本里的默认路径 → 启动。`verifyMasterKey()` 会在路径配错时拒绝启动而不是新建密钥 | 停机数分钟 | `mv` 回去、改回 `DATA_DIR` |
| 之后 | 发布 = `release-build <sha>` → 改 `current` → 重启 console → `gateway-switch --hold 600` → `release-verify`；回滚 = 把 `current` 指回上一个 `<sha>` → `gateway-switch --rollback`（保留期内）或再 `gateway-switch`。保留最近 5 个发布目录，删除前确认没有进程的 `/proc/<pid>/cwd` 还指向它 | | |

阶段 2 之后，正在运行的进程持有的是旧目录的真实路径，`current` 改指向不影响它；这正是 `--hold` 回滚能回到旧代码的前提。

### 4.3 待办：迁移在 import 时执行（未改，开放项）

`packages/core/src/db.ts` 在**模块加载时**打开数据库并执行 `runMigrations`：任何 `import "@1dayapi/core"` 的进程——网关、console、
`apps/console/scripts/*.mjs`、一次性运维脚本、甚至指错了 `DATA_DIR` 的测试——都会对它打开的库执行全部未应用的迁移。后果：

- **无法「先看再迁」**：新代码第一次被任何进程加载的那一刻，生产库结构就变了；蓝绿切换里，备用网关实例一启动就迁移了**旧实例还在用**的库
  （旧代码面对新结构，靠迁移只增不改的约定兜底，没有机制保证）；
- **回滚不对称**：代码能回滚，结构不能（§4 注意事项），而迁移发生在切换**之前**，探针失败、nginx 没切，库也已经变了；
- **并发**：网关与 console 同时启动时各自跑迁移，靠 SQLite 写锁与 `busy_timeout` 排队；一个长迁移会让另一个进程在 import 阶段超时退出；
- **误伤**：在生产机上带着生产 `DATA_DIR` 跑任何引用 core 的脚本 = 执行迁移。

建议的后续（单独一轮改动，需 core / gateway / console 三方一起改，本轮**未动 `db.ts`**）：

1. 增加显式命令 `node packages/core/dist/migrate.js [--dry-run]`（或 `ops/bin/migrate`）：打印待执行迁移 → 先调用 `ops/bin/backup` → 在一个事务里执行 → 打印结果；
2. 服务启动时改为**只校验**：库的 `schema_migrations` 版本低于代码要求 → 拒绝启动并提示先跑迁移；高于代码已知版本 → 按兼容策略告警或拒绝；
3. 过渡期用环境变量 `MIGRATE_ON_IMPORT=1` 保留旧行为（测试与开发默认开），生产 unit 不设；
4. 发布流程相应变为：`release-build` → **`migrate`（显式、有备份、有记录）** → 重启 console → `gateway-switch`。

在此之前的纪律：结构迁移只增不改；发布记录写明本次包含哪些迁移号；不在生产机上对生产 `DATA_DIR` 运行临时脚本，除非清楚它会触发迁移。

## 5. 数据与备份

> **2026-11-10 评审结论**：现网每小时备份把数据库快照、`provider-cred.key`、`internal.key` 和探针凭据打进**同一个明文 tar.gz**，再 rsync 到 worker-01——
> 一台运行客户驱动的 Claude Code 进程的机器；两机还互持对方 root 的 SSH 公钥。这与本节自己写的「主密钥必须与库分开备份」相矛盾：
> worker-01 上任何一次越权都等于拿到全部号商凭证和客户 API Key 的明文。新方案见 §5.1（脚本已入库，**切换需运维执行**）；下面带日期的条目是切换前的现状记录。

- **互备（2026-10-16 起）**，两台机器各有 `1dayapi-backup.timer`，`Persistent=true`。主服务器自 2026-10-3x 起改为**每小时**（timer drop-in `1dayapi-backup.timer.d/hourly.conf`，`OnCalendar=*-*-* *:30:00`）；worker-01 仍为每 6 小时：
  - 主服务器 `/usr/local/bin/1dayapi-backup.sh`：`VACUUM INTO` 在线快照 + `PRAGMA integrity_check` → 加 `provider-cred.key`、`internal.key`、
    systemd 单元、nginx `sites-enabled`、`/root/monitor` 凭据 → `backups/auto/<ts>.tar.gz`（0600）→ rsync 到 worker-01 `/backup/1dayapi-main/`。
    保留份数：脚本原为本地 28 份 / 对端 60 份，按 6 小时节奏即 7 天 / 15 天；改为每小时后只覆盖 28 小时 / 60 小时（2026-11-01 审计发现），目标值为本地 168 份（7 天）/ 对端 360 份（15 天，worker-01 磁盘 671 GB 可用，约 80 GB），以服务器上脚本实际 `tail -n +N` 为准。
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

### 5.1 加密备份方案（`ops/bin/backup`，2026-11-10；脚本入库，切换待执行）

| 项 | 做法 |
|---|---|
| 数据库 | `VACUUM INTO` 在线快照 + `PRAGMA integrity_check` → 只含快照的 tar.gz → 用 `age` 加密给 `/etc/1dayapi/backup.pub` 里的公钥 → `/opt/1dayapi/backups/enc/db-<UTC 时间>.tar.gz.age`（0600）；本地留 `BACKUP_KEEP_LOCAL`（168 = 7 天）份；rsync 推到 `BACKUP_REMOTE`，并用 rsync 自身把对端修剪到 `BACKUP_KEEP_REMOTE`（360 = 15 天）份 |
| 密钥材料 | `provider-cred.key`、`internal.key`、`BACKUP_KEYS_EXTRA`（默认探针 Key 与告警配置）进**另一个**加密包 `/opt/1dayapi/backups/keys-enc/keys-<时间>-<校验和>.tar.gz.age`，只有内容校验和变化时才写新包；只推到 `BACKUP_KEYS_REMOTE`——这是独立设置，**默认为空**：不设就只留本机，并在每次运行时打印醒目的提醒。默认绝不发往运行 worker 的节点 |
| 没有明文退路 | 没装 `age`、没有公钥文件、公钥文件里混进了私钥 → 拒绝运行（退出 2），不会降级成明文包 |
| 私钥 | 不在任何服务器上。解密只在恢复演练 / 真实恢复时、在运维自己的机器上进行 |
| 结果 | 末行 `BACKUP OK: …` 或 `BACKUP FAILED: <哪一步>`（退出 1）；`journalctl -u 1dayapi-backup`；`ops/bin/health-extra` 每次巡检报告最新备份的年龄 |

配置 `/etc/1dayapi/backup.conf`（`KEY=value`，root 所有，0600），全部可省略：

```bash
BACKUP_REMOTE=root@<worker-01>:/            # 对端是强制 rrsync 的目录（见下），必须以 / 结尾；留空 = 只在本机（会告警）
BACKUP_SSH_KEY=/root/.ssh/backup_push       # 专用密钥对，不要用 root 的默认密钥
BACKUP_KEYS_REMOTE=                          # 密钥包的去处：留空 = 仅本机 + 提醒；要设就设一台不跑 worker 的机器
# DATA_DIR / BACKUP_DIR / BACKUP_KEEP_LOCAL / BACKUP_KEEP_REMOTE / BACKUP_KEYS_DIR / BACKUP_KEYS_EXTRA 见脚本头部
```

**一次性准备（运维执行；本仓库没有对任何主机执行过）**

1. **离线生成 age 密钥对**（在运维自己的机器上，不在服务器上）：`age-keygen -o 1dayapi-backup-identity.txt`，输出里的 `Public key: age1…` 是公钥。
   私钥文件存入密码管理器 + 一份离线介质（打印或加密 U 盘），**不上任何服务器、不进仓库、不进 `secrets/` 的同步范围**。丢了私钥 = 全部备份作废，所以至少两份。
2. 主服务器：`apt install age`；`install -d -m 700 /etc/1dayapi`；把**公钥那一行**写入 `/etc/1dayapi/backup.pub`（0644 即可，公钥不保密）；写 `/etc/1dayapi/backup.conf`。
3. `ops/bin/backup --check` → `ops/bin/backup` 手工跑一次，确认 `BACKUP OK`；把生成的包拷到运维机器，跑一次 §5.3 的恢复演练，**通过后**再继续。
4. 把首个密钥包 `keys-*.tar.gz.age` 手工拷出服务器（运维机器 / 密码管理器附件）。以后只有主密钥或探针 Key 变化时才会出现新包，`health-extra` 会显示它的日期。
5. 换 unit：`cp ops/systemd/1dayapi-backup.{service,timer} /etc/systemd/system/`，删除旧 drop-in `1dayapi-backup.timer.d/hourly.conf`，`systemctl daemon-reload && systemctl restart 1dayapi-backup.timer`。
   旧脚本 `/usr/local/bin/1dayapi-backup.sh` 改名留档，不再被任何 unit 引用。
6. 新方案连续成功 ≥ 7 天且做过一次恢复演练后，**清理明文旧包**：worker-01 的 `/backup/1dayapi-main/*.tar.gz` 与主服务器的 `backups/auto/*.tar.gz` 里都含主密钥
   （`shred -u` 或至少 `rm`）。这些包在 worker-01 上存在过的这段时间应视为主密钥有暴露面：若 worker-01 有过任何可疑迹象，需要轮换主密钥（目前没有重加密工具，属开放项）。

**收紧两机之间的 root SSH 互信**

现状是两台机器互持对方 root 公钥、不带任何限制：worker-01 上拿到 root 就能登录主服务器。备份只需要「往一个目录里写文件」，用强制命令把密钥限制到这一件事：

```bash
# 两端各生成一把备份专用密钥（不要复用 root 的默认密钥）
ssh-keygen -t ed25519 -N '' -f /root/.ssh/backup_push -C backup-push@$(hostname)

# worker-01 的 /root/.ssh/authorized_keys：主服务器的 backup_push.pub 只能对这个目录做 rsync
command="/usr/bin/rrsync /backup/1dayapi-main-enc",restrict ssh-ed25519 AAAA… backup-push@main

# 主服务器的 /root/.ssh/authorized_keys：worker-01 的 backup_push.pub 只能往它自己的目录里写（-wo = 只写，不能读回、不能列别的目录）
command="/usr/bin/rrsync -wo /opt/1dayapi/backups/worker-01",restrict ssh-ed25519 AAAA… backup-push@worker-01
```

- `rrsync` 随 `rsync` 包安装（Ubuntu 22.04+ 在 `/usr/bin/rrsync`，更早版本在 `/usr/share/doc/rsync/scripts/`）；`restrict` 同时关掉 pty、端口转发、agent 转发、X11。
  对端路径相对于受限目录，所以 `BACKUP_REMOTE=root@<worker-01>:/`。主服务器侧不用 `-wo`，因为 `ops/bin/backup` 要列目录来修剪旧包。
- 配好并验证备份能推之后，**从两端的 `authorized_keys` 里删掉对方原来那把不受限的 root 公钥**。主服务器 → 节点方向的运维登录
  （`ops/bin/health`、`device-identity-check`）若仍需要，单独保留一把只在主服务器上的密钥；**节点 → 主服务器方向不应存在任何不受限的密钥**。
- 验证：从 worker-01 执行 `ssh -i /root/.ssh/backup_push root@<main> id` 应被拒绝（只允许 rsync）；`rsync -e 'ssh -i …' root@<main>:/ /tmp/x/` 应因 `-wo` 失败。
- worker-01 自己的备份包（节点配置、账号凭据目录）目前仍是明文推到主服务器；方向上是从低信任到高信任，暂不改，后续可同样套用 `age`。

### 5.2 主密钥守卫（`packages/core/src/crypto.ts`，2026-11-10）

此前 `provider-cred.key` 不存在时会**静默生成一把新的**：`DATA_DIR` 配错、恢复时漏了密钥文件、发布目录换了位置，都会得到一个「两代密钥」的库——
新写入的凭证用新钥，原有的全部解不开，且没有任何报错。现在：

- **缺密钥文件时**只有两种情况允许新建：库里还没有任何 `enc:v1:` 密文（扫描所有 `*_enc` 列：`accounts.credential_enc`、`api_keys.key_enc`、`node_proxies.url_enc` 等），
  或显式设置 `ALLOW_NEW_MASTER_KEY=1`。否则进程在加载 core 时抛 `MasterKeyError`，信息里写明期望的路径、`DATA_DIR`、库路径和含密文的列。
- **密钥校验值**：`verifyMasterKey()` 在 `settings.__master_key_check__` 里保存一个固定字符串的密文（不在设置页显示）；每次启动解密比对，
  不一致即拒绝启动（「库是用另一把钥写的」）。首次在已有库上启用时，先抽查各 `*_enc` 列最近 20 行：当前密钥一行都解不开就拒绝，不会把错的钥登记成基准。
- `ALLOW_NEW_MASTER_KEY=1` 是「我确认放弃旧密文」的开关：缺钥时生成新钥、校验值不符时改写校验值，都会在日志里大写告警。只用于一次启动，用完从 unit 里删掉。
- `internal.key` 丢失不影响已存数据，仍会重建，但会打印告警（网关与 console 必须同时重启才能拿到同一份）；两个进程同时首启时用 `O_EXCL` 创建，不再各写一份。
- 调用点：`verifyMasterKey()` 需要在各服务入口、库打开之后调用一次（`apps/gateway/src/index.ts`、`apps/console/src/app.ts`）。恢复演练（§5.3）用同一套算法离线验证「库备份 + 密钥备份」是一对。

### 5.3 每月恢复演练（`ops/bin/backup-restore-test`）

没恢复过的备份不算备份。每月第一周、以及每次改动备份脚本 / 配置之后：

1. 把最新的 `db-*.tar.gz.age` 和当前的 `keys-*.tar.gz.age` 从服务器拷到运维机器（私钥所在的机器；不要把私钥带上服务器）。
2. `ops/bin/backup-restore-test -i <私钥文件> -k keys-<…>.tar.gz.age --max-age-hours 3 <目录或 db 包>`
   - 解密到权限 0700 的临时目录（退出即删）→ 只读打开 → `PRAGMA integrity_check`、`foreign_key_check` → 必备表存在 → `users / api_keys / accounts / usage_logs` 行数、
     结构版本、最新一条 usage 的时间；
   - `-k`：解开密钥包，用其中的 `provider-cred.key` 解密库里的主密钥校验值（或一条账号密文），证明这两个包**配得上**；
   - `--max-age-hours`：最新包或包内最新 usage 太旧则失败（备份其实已经停了）。
3. 末行 `RESTORE TEST PASS: …` / `RESTORE TEST FAIL: <原因>`。把整段输出贴进当月运维记录；FAIL 当天处理，不留到下个月。
4. 每季度做一次完整恢复：在一台临时机器上按 §4 装好代码，把解出的库和密钥放进 `DATA_DIR`，启动 console，确认 `verifyMasterKey` 通过、能登录、账号列表可读；**不接任何真实流量、不连节点**。

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
| 发布后验证 | `ops/bin/release-verify`（真实请求 + 探针 + 池 online 数 + 设备身份）；不通过不算发布完成 |
| 设备身份核对（X-49） | `ops/bin/device-identity-check [--save 基线文件]`（只读；各节点账号 `.claude.json` 的 `userID` 对 `accounts.device_id`、属主、权限）；节点包 / Claude Code / unit 变更前后各跑一次 |
| 灰度核对（铁律 2） | `ops/bin/canary-verify`（灰度 Key 打三协议、列三态开关、网关计数器必须为零项、24h journald 告警行；journald 实际保留不足 24h 时会在第 5 步标出）；每轮开关切 `canary` 后与 24h 观察结束时各跑一次，输出贴进发布记录 |
| 告警通道 | `/root/monitor/alert.conf`；`python3 /root/monitor/alert.py test` |
| 测试闸门（无 CI） | `pnpm gate` = `ops/bin/test-gate [--no-build] [--no-unit] [--no-e2e]`：构建 + 单元测试 + e2e，对照 `tests/e2e/known-failures.txt`；出现新失败、或名单条目已通过却没删，都退出 1（§4.1） |
| 构建发布目录 | `ops/bin/release-build <提交>`：导出 → 安装 → 构建 → 闸门 → `/opt/1dayapi-releases/<sha>/RELEASE_OK`；只构建不激活；`--list` 查看（§4.2） |
| 网关切换 / 回滚 | `ops/bin/gateway-switch [--no-probe] [--hold 秒]`（切换前真实请求探针；目标实例仍在排空时拒绝）、`--rollback [--force-restart]`、`--status`（§4） |
| 读网关计数器 | `ops/bin/gateway-counters [--pretty]`：先 `/internal/metrics`（带内部令牌），再退回 `/health.counters`；都没有则退出 3 |
| 备份 | `ops/bin/backup [--check]`：`age` 加密的数据库包 + 单独的密钥包；没有公钥就拒绝运行；`systemctl start 1dayapi-backup` 手动触发（§5.1） |
| 恢复演练 | `ops/bin/backup-restore-test -i <私钥> [-k <密钥包>] [目录或包]`：解密 → 只读打开 → `integrity_check` + 行数 → `RESTORE TEST PASS/FAIL`；每月一次（§5.3） |
| 巡检 | `ops/bin/health [分钟]`（末尾自动附 `ops/bin/health-extra`：journald 保留跨度、磁盘余量、库与 WAL 体积、最新备份年龄、结算日志积压；只告警不失败，§7.0） |
| 灰度 Key 迁移 / 阶段切换 | `ops/bin/canary-move-keys`、`ops/bin/canary-phase-switch`（灰度组目前停用）。两者直接写生产库：`busy_timeout=5000`、单个 `BEGIN IMMEDIATE` 事务、**先落盘还原记录再改行**，失败打印 `FAILED` 并非零退出 |
| 新增 worker 节点 | 见下方检查清单 |

**新增 worker 节点检查清单**（每一步都有机器可验的产出，别跳）：

1. 控制台「节点」→ SSH 部署（脚本自带：unzip、Bun 1.4.4、claude 2.1.312 → `/opt/claude/claude`、`gcc`/`libc6-dev`/`util-linux`、`ccworker`、worker 根目录与隔离自检），或手工 `install.sh`（一键或 `--local`）；日志里必须看到
   `worker isolation self-test PASSED: ccworker ran claude <ver>`；看到 `FAILED`
   先按提示修（`id ccworker`、`ls -ld /var/lib/1dayapi-cc-worker` 应为 `drwx--x--x root`、`sudo -u ccworker claude --version`）。
2. `1dayapi-node install-service && 1dayapi-node restart` 后 `journalctl -u 1dayapi-node` 必须出现
   `[cc-worker] workers run as ccworker (uid N), tools: none, root /var/lib/1dayapi-cc-worker` 与
   `machine identity: per-account kernel/distro/arch via /opt/claude/machine-identity`，且**没有** `SELF-TEST FAILED`。
   节点为 root 时默认降权；若日志显示 `the node user (no privilege drop)`，说明 `ccworker` 用户缺失，worker 会以节点用户跑，不合格。
   `CC_WORKER_MACHINE_IDENTITY=1` 要求 root、编译器和 `unshare`/`setpriv`；失败时不得以关闭该开关冒充完成部署。
3. 控制台节点页 `deploy_meta.ccWorker.enabled` 为 true、`selfTestError` 为空；为 false/非空时节点会以 `self_test_failed: …` 拒绝会话。
   按账号机器身份覆盖 Claude Code 与遥测看到的内核、发行版、架构和 Shell；直连与 worker 必须同源。它不改变 UID/scratch 的实际权限边界，也不等于独立 VM。
4. 把一个账号绑到该节点后，用平台 key 走 `https://api.1dayapi.com` 发一条非 CC 请求（见 §7.1），`/api/admin/errors/summary` 无该节点 502；
   再发一条带图片的请求确认 worker 路径（图片只在 worker 可用）。
5. 顺手确认 `/root/.config/1dayapi-provider-node/` 下**没有** `cc-accounts/`、`cc-sessions/`（旧位置，有就是旧 bundle）。
6. 新隔离节点 hello 必须包含 `team_isolation_v1`，平台与节点均校验 team / account / proxy / generation。需要每组织独立系统身份时，使用 `apps/provider-node/packaging/linux/1dayapi-team@.service`，分别配置 `PROVIDER_TEAM_ID`、状态目录和本地端口。该模板的 `DynamicUser`/`NoNewPrivileges` 与 root mount namespace 不兼容，不得在其中开启 `CC_WORKER_MACHINE_IDENTITY`；标准 root worker 节点才使用按账号机器身份。
7. 保留旧目录与设备身份。本次发布不安装或运行旧数据清理任务；历史备份与清理机制见 §5，不能将历史说明当作本次的执行指令。

## 7. 监控与告警

没有指标、告警、日志集中与错误追踪。现有的只有一个功能探针：主服务器 `1dayapi-monitor.timer`
每 **30 分钟**（2026-10-29 起，drop-in `/etc/systemd/system/1dayapi-monitor.timer.d/interval.conf`，此前 10 分钟：每条探测都在某个号上起一次 worker 会话，太密）跑 `/root/monitor/func.py`（经公网打 messages / chat 的流式与非流式、工具调用，再以 admin 登录控制台核对
usage 行、账户与节点状态），每次一行 JSON 追加到 `/root/monitor/func.jsonl`，`journalctl -u 1dayapi-monitor` 可看摘要。
探针里的 `cc_dual_mode`（带 Claude Code UA 走订阅号直连）2026-10-16 起改为发送 Claude Code 形态的 body（计费头 system 块 +
`metadata.user_id`，见 docs/claude-code-compat.md §5）：此前它不带计费头，Anthropic 对这种请求恒回 429，每 10 分钟把账户
打入一次 429 冷却。`PROBE_CC_DUAL_MODE=0` 可临时关掉这一项。
最低建议补齐：外部探活 `/health`、磁盘与 DB 大小、journald 中 `[billing] failed` 与 `unhandled error` 的计数。
其中磁盘、库体积、备份新鲜度、日志保留跨度已由 `ops/bin/health-extra` 覆盖（§7.0，2026-11-10）；仍然没有指标采集与集中日志。

**Claude Code 形态判定（gateway.md §2a）上线后的观察项**：`journalctl -u 1dayapi-gateway | grep '\[cc-shape\]'` 看 suspect 行
（谁、缺了什么），控制台「用户」列表看「伪造 CC（30 天）」。策略默认 `observe`，确认真实 CC 用户长期为 0 suspect 后在「设置」切到
`downgrade`。genuine 但带 `soft=` 的行说明 Claude Code 发了新版本、形态有漂移，要去 docs/claude-code-compat.md 核对并更新常量。
判定只在网关（主服务器）执行，节点（worker-01 / 核心节点）只负责出口，不需要任何改动。

## 7.0 日志保留与巡检补充项（2026-11-10）

**日志保留与工具的假设不一致。** `ops/bin/canary-verify` 第 5 步（「24 小时 journald 必须为空」）、`ops/bin/health` 的 24 小时流量视图、铁律 2 的「≥24h 观察」
和每一次事故复盘，都假设 journald 至少留着 24 小时的网关 / console 日志；而据此前排查记录，生产 journald 只保留约 **4 小时**（本轮未上服务器核实，以 `health-extra` 的输出为准）。
在保留期补足之前：`canary-verify` 的「24h 为空」实际只代表「最近约 4h 为空」（脚本现在会在第 5 步标出实际跨度）；观察期结论要另外依据 `usage_logs` 与
`/var/log/1dayapi-canary-traffic.log`，不能只凭 journald。

修复：`ops/systemd/journald-1dayapi.conf` → `/etc/systemd/journald.conf.d/10-1dayapi.conf`，`systemctl restart systemd-journald`
（`SystemMaxUse=4G`、`SystemKeepFree=20G`、`MaxRetentionSec=30day`，目标 ≥ 14 天）。**4G 是评审给的起始值，不是实测值**：安装前先按文件头的三条命令量一下
「当前占用 ÷ 当前保留小时数 × 336」。如果现在已经是 4G 上限却只留得住 4 小时，那么任何合理的上限都装不下 14 天，要先降日志量
（网关 unit 开着 `TUNNEL_TRACE=1`、按请求打日志），单靠这个文件解决不了。装好后以 `health-extra` 每次打印的保留跨度为准，不到 14 天就继续调。

**`ops/bin/health-extra`**（`ops/bin/health` 末尾自动调用；只读；每项一行 `ok` / `WARN`，退出码恒为 0）：

| 检查 | WARN 条件（环境变量可调） |
|---|---|
| 网关 unit 在 journald 里最早一条日志的年龄 | 不足 `JOURNAL_MIN_HOURS`（24）小时 |
| `/`、`DATA_DIR`、备份目录、`/var/log/journal` 所在文件系统的剩余空间 | 低于 `DISK_MIN_FREE_PCT`（15）% |
| `1dayapi.db` 与 `-wal` 的大小 | WAL 超过 `WAL_WARN_MB`（1024）MiB：checkpoint 完不成，通常是有长时间不结束的读事务 |
| 最新加密备份的年龄、密钥包是否存在、旧明文脚本是否还在写 | 最新包超过 `BACKUP_MAX_AGE_MIN`（120）分钟；没有密钥包；只有旧方案的明文包；旧脚本 24 小时内仍在产出 |
| 结算日志目录 `<DATA_DIR>/settlement-journal/` 的文件数 | 有超过 `SETTLEMENT_STUCK_SEC`（60）秒的 `*.json`：计费写入没落库，网关此时拒绝新推理（`packages/core/src/settlement-journal.ts`）；另报超过 5 分钟的残留临时文件 |

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

## 7.3 灰度真实流量：接入、日志、报表、回退（2026-11-02）

铁律 2 的落地流程（`docs/iron-rules.md`、`docs/canary-real-traffic-plan-2026-11-02.md`）。所有脚本在 `/opt/1dayapi/ops/bin/`，以 root 在主服务器运行，只读的除外都会写 DB，先看清再敲。

**a. 前提**
- settings `canary_group_id` 指向灰度组（现为 `canary-1cf43ccb`「灰度测试」，`is_exclusive=1`）；灰度账号在该组（现为 `claude-9d6edf2c`，team `dcaea0ca…`，executor ccr_worker）。
- 灰度测试 Key 的明文只在 `/root/monitor/canary-apikey.txt`（0600），脚本直接读，不进任何日志/提示词。
- 要灰度的开关设为 `canary`（控制台「设置」或 `settings` 表），其余保持 `0`。**开关按 Key 的组判定**（见 iron-rules「开关按谁判定」），所以真实流量必须靠迁 Key。

**b. 接入真实流量**
```bash
cd /opt/1dayapi
node --no-warnings ops/bin/canary-move-keys status                       # 当前灰度组里有哪些 Key、迁移记录
node --no-warnings ops/bin/canary-move-keys move <key_id> [<key_id>…]    # 迁入：记原组到 /root/monitor/canary-moved-keys.json，补 user_allowed_groups
node --no-warnings ops/bin/canary-move-keys revert [<key_id>…]           # 回退（不带参数 = 全部未回退的）
```
选 Key 的标准：最近 3 小时有流量、原组 default、形态覆盖"真 CC / 自定义 entrypoint / 纯 API / 测活"。找候选：
`usage_logs` 按 `api_key_id` 聚合近 24h 的 `COUNT(*)`、`SUM(cc_shape='genuine')`、`MAX(created_at)`，联 `api_keys`/`users` 看名字和组。
迁入后用户的**全部**流量只走灰度组账号，容量以灰度账号为限（单 Max 账号接 2 万请求/天几小时就会 `window_exhausted`），这是预期内的容量问题，不是新行为失败，但要记时间。

**c. 看门狗（必须随真实流量一起开）**
```bash
(setsid nohup bash ops/bin/canary-watchdog >/dev/null 2>&1 &)     # INTERVAL=300 默认；日志 /var/log/1dayapi-canary-traffic.log
touch /root/monitor/canary-watchdog.stop                          # 停（下个周期退出）；重启前 rm 这个文件
pgrep -af canary-watchdog                                         # 是否在跑（注意 pkill -f 会把自己的 ssh 会话一起杀掉，按 pid kill）
```
每行：`<时间> accounts=<账号=状态,…> n= ok= cc_genuine= suspect= stream= 4xx= 5xx= keys= errs=[错误码:次数,…]`。
灰度账号状态不是 `active` 时写 `REVERT …` 并自动执行 `canary-move-keys revert`，之后继续只记状态。看门狗**不碰账号**（铁律 1：proxy_down 只能人工解除）。
还没有 systemd/cron 托管：服务器重启后要手动再拉起。

**d. 日志在哪**
| 层 | 位置 | 内容 |
|---|---|---|
| 每请求 | `usage_logs`（`/opt/1dayapi/data/1dayapi.db`） | key / group / account / model / endpoint / stream / status / error_code / error_scope / mode / cc_shape / upstream_status / duration / ttft / tokens / truncated |
| 每 5 分钟 | `/var/log/1dayapi-canary-traffic.log` | 看门狗汇总行、REVERT 行 |
| 计数器 | `GET https://api.1dayapi.com/health` → `counters` | `cc_profile_unknown_total{version}`、`custom_entrypoint_denied_total{entrypoint}`、必须为零的 `cc_profile_mismatch_total` / `team_suspended_total` / `native_telemetry_unverified_total` / `org_budget_exhausted_total` |
| 组织级 | `telemetry_evidence`、`upstream_teams.suspended_until/last_error_code`、`journalctl -u 1dayapi-gateway` grep `cc_profile|org_|organization|disabled|native_telemetry` | 熔断、遥测证据 |
| 判定器 | `key_policy_events` | 每把 Key 的 auto 层提案与依据（`key_policy_auto=0` 时只记录不生效） |
| 探针 | `ops/bin/canary-verify`、`node --no-warnings ops/bin/canary-cc-probe` | 三种协议 + 2.1.312 真形态各一条，手工或 cron 每小时 |

**e. 出结论**
```bash
cd /opt/1dayapi && HOURS=24 node --no-warnings ops/bin/canary-report        # 只读；HOURS 可改；API_BASE 默认 127.0.0.1:8400
```
13 节：账号/团队状态 → 请求数（灰度组 Key vs 其他 Key，成功率、p50/p95、ttft、截断、tokens）→ 状态/错误码 → mode → 端点×stream → 模型 → cc_shape → Key 组 →
分小时序列 → 最近 20 条错误 → telemetry evidence → key_policy_events → 必须为零的计数器 + `VERDICT`。
通过标准（≥24h）：VERDICT 干净；`upstream_teams` 无 suspended；journald 无组织级错误；错误率（剔除 `no_available_account`）不高于迁入前 + 2pp；p95 不高于迁入前 1.5 倍；
`cc_profile_unknown_total` 的版本分布决定是先补 profile 再切 `1` 还是接受降级。报表原文贴进发布记录。
失败处理：出现任何组织级信号 → `canary-move-keys revert` → 对应开关回 `0`（不用重新发布）→ 写发布记录。不换 IP、不直连。

**f. 「启用 V2」= 开关按顺序切 `1`**（一个开关一天、每步报表干净、切后至少观察 2 小时）：
`direct_profile_strict` → `cc_client_response_profile` → `key_policy_auto` →（先推节点包、节点 `CC_WORKER_CANONICAL=1`）`worker_canonical` → 7 天健康后 `telemetry_evidence_required` → `canonical_history_import` → R4 `raw_preserve_headers` / strict。
V2 代码自 2026-11-01 16:33Z 起已在线，开关全 `0` 即 V1 行为；全部 `1` 稳定两周后进 R5 删 V1 分支。

**f2. 阶段切换**：`ops/bin/canary-phase-switch`（`TARGET`/`SETTING`/`VALUE`/`GUARD_HOURS`）到点改一个开关、先存前一阶段报表、之后 2 小时守护自动回滚（`upstream_request_rejected`、`cc_profile_mismatch`、5xx 占比、账号离线）。
`canary-report` 加 `SINCE`/`UNTIL` 看单个阶段。worker→直连不是改 executor，而是让请求变 genuine（见 plan §8）：executor=`direct` 会把非 CC 形态也直连到订阅号，禁止。

**g. 已知坑**
- sshd 被暴力登录占满 `MaxStartups` 时表现为 TCP 通、无 banner 即断（2026-11-01 23:13–00:29Z，90 分钟 962 次尝试），网关不受影响；需要时装 fail2ban 或改 `MaxStartups`。
- 远程命令里写 `pkill -f <脚本名>` 会命中自己的 `bash -c` 会话，用 pid。
- `usage_logs.created_at` 是 ISO `YYYY-MM-DDTHH:MM:SSZ`，与 SQLite `datetime('now',…)`（空格分隔）比较会错；脚本里用 JS 生成 ISO 再比较。

## 8. v3 发布要点（已于 2026-10-15 执行完毕，存档备查）

- 发布前在服务器备份 `data/`（**必须包含 `provider-cred.key`**，否则迁移后的账户凭证无法解密）；首次启动 v3 会自动执行迁移 1，旧表保留为 `legacy_v2_*`。
- 先启动 console 再启动 gateway（两者都能执行迁移，有并发保护）；两个 unit 的 `DATA_DIR` / `DB_PATH` 必须一致。
- console：`TRUST_PROXY=127.0.0.1,::1`、`COOKIE_SECURE=1`、`CONSOLE_CORS_ORIGINS=https://1dayapi.com`、`PLATFORM_WS_URL=wss://…/internal/provider/connect`。
- gateway：删除 `UPSTREAM_*`、`PROVIDER_TUNNEL_ENABLED`；上游改为在控制台"上游账户"里配置（迁移会把原 env-fallback 账户带过来，Base URL 为平台默认，需按实际修改或停用）。
- nginx：对公网只放行 `/internal/provider/*`（节点用），`/internal/tunnel/*` 不应对外（即使对外也有内部令牌保护）。
- v2 的运维操作对应关系：签发密钥 → 控制台"用户"新建；吊销 → 禁用用户 / 重置登录密钥；调余额 → 用户详情"调账"；切换上游 → "上游账户"；
  关闭号商隧道 → 停用 `route=node` 账户或禁用号商；`data/client-errors.log` 不再写入。
- 回归：`pnpm build && pnpm test:e2e`。
