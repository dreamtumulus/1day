# 主服务器迁移 runbook：89.117.17.224 → 13.140.243.112（2026-11-12）

目标：网关 + 控制台 + 数据库搬到新机（Contabo VDS XL，EPYC 7282 8c/16t，64 GB，480 GB NVMe），旧机转热备。
除切库那一步外客户无感；切库窗口预计 1–2 分钟，放在流量最低的 **00:00–02:00Z**。
回滚始终可用：Cloudflare 源站改回旧机 IP + 节点 `/etc/hosts` 改回，几十秒。

## 0. 已就位（2026-11-12 11:00–12:00Z，现网未动）

| 项 | 新机状态 |
|---|---|
| 运行时 | node v22.21.0、pnpm 9.15.9、bun 1.4.3（与旧机一致）；nginx 1.24；sqlite3 3.45；certbot |
| 用户 | `1dayapi` uid 995 / gid 986（与旧机一致） |
| 防火墙 | ufw：22 限速（旧机 IP 放行）、80、443 |
| 代码 | `/opt/1dayapi`（仓库 + dist + node_modules，= 旧机 main `e509940`）、`/opt/1dayapi-releases` |
| 配置 | nginx 站点（见 §1）、`conf.d`（Cloudflare real-ip、`gateway_live` → 8400）、systemd 单元与 drop-in（**未 enable**）、journald 配置、`/root/monitor`、Let's Encrypt 证书（到 2027-01-12） |
| 数据 | `internal.key`、`provider-cred.key`、settlement-journal、bundle-cache、数据库快照（`.backup`，切换时再增量同步） |
| 干跑 | 用空库起 console + gateway + mock-upstream：`/health` 200、事件循环 p99 20 ms、nginx → console 通、nginx → gateway 通 |
| SSH | 本机与旧机 root 公钥在新机 `authorized_keys`；旧机能免密到四台节点 |

**不搬**：`/opt/1dayapi/backups`（107 GB）、`data/backups`（17 GB）、`data/captures`（5 GB）。
**留在旧机的服务**：`sk.buox.org`（sk-oauth-service :8500）、tinyproxy、camoufox 上号/relay、work-ccr bridge（:18611）、si-lab。新机 nginx 把 `1dayapi.com` 下的 `/work-ccr/`、`/api/work-ccr/`、`/camoufox-onboarding/`、`/v1/`、`/downloads/` 反代回旧机（`snippets/old-main-proxy.conf`）。

## 1. 节点如何跟过去

四台节点 `/etc/hosts` 钉着 `89.117.17.224 1dayapi.com`（2026-11-12 起直连旧机、不经 Cloudflare），bridge 连 `wss://1dayapi.com/internal/provider/connect`。切换时把这一行改成新 IP；旧控制台一停，bridge 自动重连到新机。**不用重启节点，不杀会话。**

| 节点 | IP |
|---|---|
| worker-01 | 62.146.171.208 |
| worker-02 | 217.216.47.136 |
| ccr-tui | 217.216.46.202 |
| worker-03 | 13.140.243.88 |

## 2. 切换前 30 分钟（零影响）

在旧机：

```bash
# 2.1 预同步一次数据库，让窗口内的增量很小
sudo -u 1dayapi sqlite3 /opt/1dayapi/data/1dayapi.db ".backup /tmp/migrate-snapshot.db"
rsync -a --inplace -e "ssh -o BatchMode=yes" /tmp/migrate-snapshot.db root@13.140.243.112:/opt/1dayapi/data/1dayapi.db
# 2.2 代码一致性
ssh root@13.140.243.112 'cd /opt/1dayapi && git log --oneline -1'   # 应与旧机 main 相同
# 2.3 从外部确认新机 nginx + 证书可用（不改 DNS）
curl -sk --resolve api.1dayapi.com:443:13.140.243.112 -o /dev/null -w "%{http_code}\n" https://api.1dayapi.com/health   # 502 = nginx 与证书正常、网关尚未启动
curl -sk --resolve 1dayapi.com:443:13.140.243.112 -o /dev/null -w "%{http_code}\n" https://1dayapi.com/                 # 200 = 静态站正常
```

Cloudflare 源站不提前切：橙云记录改 IP 在边缘即时生效，放在 §3 服务起来之后改，窗口不会因此变长。

## 3. 切换窗口（00:00–02:00Z，预计 1–2 分钟）

在旧机顺序执行：

```bash
# 3.1 停看门狗（否则它会把"网关不响应"当故障去切）和监控定时器
systemctl stop 1dayapi-gateway-watchdog 1dayapi-monitor.timer
# 3.2 节点指向新机（bridge 在旧控制台停掉后重连到新机）
for n in 62.146.171.208 217.216.47.136 217.216.46.202 13.140.243.88; do
  ssh -o BatchMode=yes root@$n 'sed -i "s/^89\.117\.17\.224 1dayapi\.com/13.140.243.112 1dayapi.com/" /etc/hosts && getent hosts 1dayapi.com'
done
# 3.3 停写：网关（在途流断一次）、控制台（隧道断一次）
systemctl stop 1dayapi-gateway@8400 1dayapi-gateway@8402 1dayapi-console
# 3.4 最后一次库同步（WAL 已合入；--inplace 只传差量，几秒）
sudo -u 1dayapi sqlite3 /opt/1dayapi/data/1dayapi.db ".backup /tmp/migrate-final.db"
rsync -a --inplace -e "ssh -o BatchMode=yes" /tmp/migrate-final.db root@13.140.243.112:/opt/1dayapi/data/1dayapi.db
rsync -a -e "ssh -o BatchMode=yes" /opt/1dayapi/data/settlement-journal/ root@13.140.243.112:/opt/1dayapi/data/settlement-journal/
ssh root@13.140.243.112 'chown -R 1dayapi:1dayapi /opt/1dayapi/data && chmod 600 /opt/1dayapi/data/1dayapi.db && sudo -u 1dayapi sqlite3 -readonly /opt/1dayapi/data/1dayapi.db "pragma quick_check; select count(*) from usage_logs;"'
```

在新机：

```bash
# 3.5 起服务（顺序：mock-upstream → console → gateway@8400）
systemctl enable --now 1dayapi-mock-upstream 1dayapi-console
sleep 3; journalctl -u 1dayapi-console --since -1min -o cat | grep -iE "migration|listen|error" | head
systemctl enable --now 1dayapi-gateway@8400
curl -s http://127.0.0.1:8400/health
# 3.6 nginx 已指向本机 8400 / 8401（预先配置好），只需确认
curl -sk --resolve api.1dayapi.com:443:127.0.0.1 -o /dev/null -w "%{http_code}\n" https://api.1dayapi.com/health   # 200
# 3.7 节点是否已连上
sudo -u 1dayapi sqlite3 -readonly /opt/1dayapi/data/1dayapi.db "select substr(node_id,6,8), online, last_heartbeat_at from nodes"
# 3.8 看门狗 + 监控
systemctl enable --now 1dayapi-gateway-watchdog 1dayapi-monitor.timer
```

Cloudflare（人工，面板；或给我一个仅限该 zone DNS 编辑权限的 API token 由我改）：`api.1dayapi.com`、`1dayapi.com`、`www.1dayapi.com` 三条 A 记录 → `13.140.243.112`，保持橙云。边缘即时生效；客户的下一次请求就到新机。

从 §3.3 停旧服务到此处生效，就是客户感知到的窗口：预计 60–120 秒。

## 4. 验证（切换后 10 分钟内）

```bash
# 新机
cd /opt/1dayapi && ops/bin/release-verify        # 真实请求 200、节点 4 个心跳、设备身份 OK
journalctl -u 1dayapi-gateway@8400 --since -5min -o cat | grep -E "team-pick.*took=" | tail -3
tail -5 /var/log/1dayapi-gateway-watchdog.log
sudo -u 1dayapi sqlite3 -readonly data/1dayapi.db "select substr(created_at,12,5), count(*), sum(status_code=200), sum(status_code=499), sum(status_code>=500) from usage_logs where created_at>=strftime('%Y-%m-%dT%H:%M:%SZ','now','-10 minutes') group by 1"
```

旧机：`ss -ltnp | grep -E '8400|8401|8402'` 应为空；nginx 保留（sk.buox.org 等服务不动）。

## 5. 回滚

任何一步不对：
1. Cloudflare：A 记录改回 `89.117.17.224`。
2. 旧机：`systemctl start 1dayapi-console 1dayapi-gateway@8400`（库在旧机原地没动，§3.3 之后的写入只在新机，需要时从新机 `.backup` 回传）。
3. 节点 hosts 改回 `89.117.17.224 1dayapi.com`。
4. 旧机：`systemctl start 1dayapi-gateway-watchdog 1dayapi-monitor.timer`。

## 6. 切换后 1–3 天

- 旧机转热备：装 Litestream（或每 5 分钟 `.backup` + rsync）从新机复制库；旧机的 console/gateway 单元保留但 disabled。
- 旧机的 `1dayapi-backup.timer` 改为备份新机（或在新机启用 backup 单元：需要 `/etc/1dayapi/backup.conf` + `backup.pub`，确认后再开）。
- 新机：改 root 密码、关闭密码登录（用户决定"到时候全部一起换密钥登录"）。
- 文档：`operations.md` 里的主机 IP、`ops/bin/health` 的硬编码。
- GitHub / 本地 `origin` 远程改指新机。
