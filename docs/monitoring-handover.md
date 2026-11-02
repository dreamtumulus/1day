# 1dayAPI 监控交接说明（给定时监控 bot）

本文给接管日常巡检的自动化助手（例如 Grok bot）。它只需要做三件事：**定时拉一份体检报告、按下面的规则判断、异常时把信息完整地报给负责人**。它没有也不需要任何修改权限。

## 1. 系统是什么

1dayAPI 是一个 Claude 模型中转平台。客户用平台 key 调 `https://api.1dayapi.com`（Anthropic Messages 方言和 OpenAI Chat 方言），平台用订阅账号在后端完成调用。

| 组件 | 位置 | 作用 |
|---|---|---|
| 主服务器 | 89.117.17.224（Contabo） | nginx、gateway（推理网关，蓝绿双实例 8400/8402）、console（控制台 + 节点注册中心，8401）、SQLite 数据库 |
| worker-01 | 62.146.171.208 | 节点：持有约 100 个订阅账号的出口代理、设备身份，并运行 Claude Code 执行降级请求 |
| worker-02 | 217.216.47.136 | 同上，约 20 个账号 |

请求有两条路径：**直连（passthrough）**，真 Claude Code 客户端的请求经节点代理原样转发给 Anthropic；**worker**，其他客户端的请求由节点上的 Claude Code 代为执行。节点与主服务器之间是一条经 Cloudflare 的 WebSocket 控制链路。

## 2. 怎么取数据

bot 持有一把**只能执行体检脚本**的 SSH 私钥（文件 `grok-monitor.key`，由负责人单独交付；不要向 bot 提供 root 密码或任何其他凭据）。这把钥匙在服务器上被强制绑定到一个只读脚本，无论发什么命令都只会得到体检报告：

```bash
ssh -i grok-monitor.key -o IdentitiesOnly=yes -o ConnectTimeout=15 root@89.117.17.224        # 近 15 分钟
ssh -i grok-monitor.key -o IdentitiesOnly=yes -o ConnectTimeout=15 root@89.117.17.224 60     # 近 60 分钟
```

建议节奏：**每 15 分钟拉一次 15 分钟窗口**；每小时额外拉一次 60 分钟窗口看趋势。脚本只读，不改任何状态，跑多少次都没有副作用。撤销这把钥匙：负责人删除主服务器 `/root/.ssh/authorized_keys` 里带 `grok-monitor-readonly@1dayapi` 的那一行即可。

## 2a. 必须立刻上报的一行（2026-11-01 起）

报告里 `-- proxy_down (frozen, needs operator): N account(s)` 这一行：**N > 0 就上报**，并把下面列出的账号名、节点、自何时起、原因原样转给负责人。
这些账号是因为绑定代理失联被平台冻结的，平台**不会**自动恢复它们（规则：代理不通就停、不换 IP、不直连，只能人工在控制台「解除冻结」或「更换代理 IP」）。
冻结时间越长损失越大，所以每次报告都要重复提醒，直到这一行归零。

## 2b. 灰度真实流量的看门狗日志（2026-11-02 起，负责人/值班看）

灰度组（铁律 2）在接真实用户流量时，主服务器 `/var/log/1dayapi-canary-traffic.log` 每 5 分钟一行：
`<时间> accounts=<账号=状态,…> n=<请求数> ok=<200 数> cc_genuine= suspect= stream= 4xx= 5xx= keys= errs=[错误码:次数,…]`。
- 出现 `REVERT` 行 = 灰度账号离开 `active`，用户 Key 已自动退回原组 → **立刻上报**，附该行和前后各一行。
- 连续 3 行 `5xx>0` 或 `errs` 里出现 `team_suspended` / `native_telemetry_unverified` / `org_` 开头的码 → 立刻上报。
- 连续 3 行 `n=0` 而迁入的用户平时有流量 → 黄：可能看门狗停了（`pgrep -af canary-watchdog`）或流量没进来。
完整报表：`cd /opt/1dayapi && HOURS=24 node --no-warnings ops/bin/canary-report`（只读），流程见 `docs/operations.md §7.3`。

## 3. 报告长什么样、每行什么意思

```
== 2026-10-19 12:25:54 CEST  window: last 15 min ==
services: gateway=active(1dayapi-gateway@8400) console=active nginx=active resolved=active
load: 0.08 0.04 0.05  mem avail: 22.5 GiB  disk /: 2%
w2: node=active claude_procs=2 load=0.00 mem_avail=93.0G bundle=c41dbe8f
w1: node=active claude_procs=2 load=0.71 mem_avail=86.9G bundle=c41dbe8f
-- console node events (15m):            节点链路事件（断开、重连、宽限保留、重新注册）
-- console tunnel/open 4xx (15m): 0      平台拒绝开会话的次数
-- gateway warn/error lines (15m): 0  nginx 5xx in last 5000 lines: 2
-- cc-shape verdicts (15m):  21 genuine ;   自称 Claude Code 的请求判定：genuine 直连 / suspect 降级
-- gateway recent warnings:              最近 6 条网关告警原文
-- usage_logs: 160 req, 1 non-200 (0.6%)  窗口内请求总数与失败数
   400 safeguards_refusal [ccr-anthropic] x1  ...   失败按 状态码/错误码/路径 分组，附一条样例
   ok [ccr-anthropic] x134 avg 38039ms max 306080ms stream 130   成功请求按路径的数量与耗时
-- accounts: 130 total, 124 active, cooling 0, overload 0, window_exhausted 2, temp_unschedulable 0
-- proxies: c375060d live 150/150, c3e5ba42 live 100/100
-- traffic per hour (UTC, last 24h, total(failed)): 05Z:558(43) 06Z:467(9) 07Z:730(19) ...   每小时请求量，括号内为失败数
-- traffic totals: last 1h 922 req (60 failed), last 24h 5543 req (184 failed)
-- top consumers (window): Daydreaming.work/cb8ded68:121(4 failed), mirasim.ai/9ad5ac8d:40 direct 12   窗口内请求最多的 key
-- tokens (window): input 9814518, cache_read 9913764, cache_write 0, output 557572, billed $62.05
-- cooling detail (3 shown):                     正在冷却 / 耗尽的账号明细：账号 @节点 状态:恢复时刻 | 原因
   claude-8582b2c5 @c375060d window_exhausted:2026-10-19T11:32:55Z | window exhausted until ... (reset 09:40Z + rest)
-- accounts by status: active 124, disabled 5, error 1; active per node: c375060d 101, c3e5ba42 23
-- node c375060d: online=1 accepting=1 in_flight=9 worker active/queued/max=9/0/295 claude=2.1.300 heartbeat 9s ago
-- node c3e5ba42: online=1 accepting=1 in_flight=0 worker active/queued/max=0/0/296 claude=2.1.300 heartbeat 5s ago
```

`w1:` / `w2:` 行里有每台 worker 的 `load1/5/15`、CPU 核数、内存已用/总量、磁盘、开机天数和 bundle 版本；`-- node` 行是平台从心跳里看到的该节点在途请求数、worker 并发（active/queued/max）和心跳新鲜度。节点 ID 前缀对应：`c375060d` = worker-01（62.146.171.208），`c3e5ba42` = worker-02（217.216.47.136）。

`ccr-anthropic` / `ccr-chat` 是 worker 路径，`passthrough-anthropic` 是直连。时间是服务器本地时间 CEST（UTC+2）。

## 4. 判定规则

### 4.1 立即报警（红）

| 现象 | 含义 |
|---|---|
| `services:` 里任一项不是 active | 主服务器进程挂了 |
| `w1:` 或 `w2:` 行出现 `node=inactive`、`failed`，或整行是 ssh 错误 | 节点进程挂了或节点失联 |
| `console node events` 出现 `did not return within`、`failing N held session(s)`，或 `missed a ping` 后 1 分钟内没有 `reported device identities` | 节点链路断开超过 30 秒 |
| `usage_logs` 非 200 比例 > 10%，且窗口内请求 ≥ 30 | 大面积失败 |
| 出现 `503 no_available_account` ≥ 3 次 | 没有可用供给（账号耗尽、节点全离线或代理池崩） |
| 出现 `502 upstream_stream_error` 且样例含 `fetch failed`、`node_disconnected`、`tunnel closed by node` ≥ 5 次 | 链路或节点层故障 |
| `accounts:` 中 `cooling` 或 `overload` ≥ 10，或 `window_exhausted` 比上一次猛增 ≥ 10 | 上游在成批限流或账号被批量耗尽 |
| `proxies:` 任一节点 live 数低于总数的 80% | 代理池大面积故障 |
| `mem avail` 低于 2 GiB，或 `load` 第一个数 > CPU 数 × 2 持续两次 | 资源异常 |
| `disk /:` ≥ 85% | 磁盘将满 |
| `cc-shape verdicts` 窗口内 suspect 数超过 genuine 数，且请求 ≥ 20 | 判定规则可能与新版 Claude Code 不匹配，真客户被误降级 |
| `-- node` 行 `online=0`，或 `heartbeat` 超过 120s ago | 节点失联（与 `w1:`/`w2:` 行互相印证） |
| 整份报告取不到（SSH 被拒或超时）且 `https://api.1dayapi.com/health` 不是 200 | 主服务器宕机或宿主机维护：先看 `contabo status` 一节 / https://contabo-status.com ，再通知负责人 |
| `-- node` 行 `queued` > 0 连续两次，或 `active` 达到 `max` 的 90% | worker 并发打满，请求在排队 |
| `w1:`/`w2:` 行 `load1` 超过 `cpus`，或 `mem_used` 超过总量的 85% | 节点资源吃紧 |
| `traffic totals` 最近 1 小时请求量比前一小时同比（看 per hour）骤降 70% 以上，且不是北京时间凌晨 | 流量异常消失，可能入口故障 |

### 4.2 记录并在下一次汇总中提及（黄）

| 现象 | 含义 |
|---|---|
| 非 200 比例 5%–10% | 看失败分组是什么，若全是下表的良性项则降为绿 |
| `gateway warn/error lines` ≥ 20 | 看 recent warnings 内容 |
| `console tunnel/open 4xx` > 0 | 开会话被平台拒绝，正常应为 0 |
| `nginx 5xx` 一次比一次明显增长（如 +20） | 关注；少量稳定值是扫描器噪音 |
| 同一错误码连续三个窗口都出现且数量上升 | 趋势性问题 |
| `-- contabo status` 出现新的 `[OPEN]` 条目，尤其含 reboot / maintenance / VPS / 机房名 | 服务商维护，意味着三台机器随时可能被重启；提前通知负责人，并在之后的窗口里把节点掉线归因到它 |
| `cooling detail` 里同一账号反复出现 `rate_limited` 或 `temp_unschedulable` | 该账号不稳定，提醒负责人检查 |
| `top consumers` 某把 key 的失败数占其请求数 30% 以上 | 单个客户的问题，附上该 key 的失败样例 |

### 4.3 已知良性，不要报警（绿）

| 现象 | 为什么正常 |
|---|---|
| `400 safeguards_refusal` | Anthropic 安全分类器拒绝了客户内容，平台已按请求级错误处理，不换账号、不冷却 |
| `400 prompt_too_long` | 客户会话超出模型上下文，返回 Claude Code 原句让客户端自动压缩 |
| `400 invalid_request` / `upstream_client_error` / `404 model_not_found` | 客户请求本身的问题，上游或平台原样拒绝 |
| `502 upstream_stream_error` 样例含 `session limit · resets`，每次 1–2 条 | 某个订阅账号 5 小时窗口用尽，平台自动把它标记为 `window_exhausted`，重置点再加随机 1h45m–2h05m 冷静期后恢复。`accounts:` 里 `window_exhausted` 个位数是常态 |
| `502 upstream_stream_error` 样例含 `claude exceeded 1200000ms`、`worker timed out` 或 `tool_timeout`，零星 | worker 单轮 20 分钟上限（2026-10-19 起，此前 10 分钟），既定策略 |
| `console node events` 出现 `link lost; holding N session(s)` 紧跟 `back after <数字>ms` 和 `reconciled: N session(s) continue` | 链路抖动在 30 秒内自愈，会话无损，这正是链路宽限机制在工作 |
| `reported device identities for N account(s)` | 节点（重）连接或负责人新增账号时的正常对账 |
| `cc-shape` 有少量 suspect，missing 里是 `billing_header` / `metadata_user_id` / `stainless_js_node` | 只带 UA 的路由器或 SDK 流量被正确降到 worker 路径 |
| `nginx 5xx` 在 5000 行里个位数到二十来个且不增长 | 扫描器探测 `.env`、`wp-admin` 之类 |
| `gateway recent warnings` 里 `PROOF_SECRET not set` | 启动时的固定提示 |
| 用量日志里 `mode=probe`（费用 0，200 或 503 `no_available_account`） | 测活接管（gateway.md §2c，2026-10-29）：重复的极小请求由平台按号池状态直接作答，没有碰任何账号 |
| `[oauth] refresh … failed: HTTP 429 → back-off until …` 偶发，随后 `token endpoint back-off until …, not refreshing` | 令牌端点限流退避（gateway.md §8，迁移 31）：10 分钟内不再重试；**持续数小时 0 次 `refreshed access token` 才是问题**（2026-10-29 09Z 起出现过一整天） |
| `[proxy] … 401 while the token endpoint back-off runs … → cooldown, not status error` | 退避期内令牌到期，账号临时冷却而非标死（哪怕文案写着 revoked——过期也是这句）；退避结束自动恢复 |
| `[oauth] keep-alive tick: a/b refreshed, n in back-off, m deferred (same exit)` | 保活每轮汇总：同一出口 IP 每轮只刷一个号是设计行为 |
| 负责人发布期间（gateway 蓝绿切换无中断；节点或 console 重启会切断当时在途的 worker 请求）出现一分钟内的集中失败 | 发布代价，之后应立刻归零；若 5 分钟后仍有同类失败则升级为红 |

### 4.4 每日汇总（建议北京时间 09:00 发一次）

用 60 分钟和 24 小时的数据写一段简报：24 小时请求总量和失败率、每小时流量曲线中的峰谷、窗口内 top consumers、`billed` 金额、当前冷却 / 耗尽账号数量与明细、两台 worker 的负载和并发峰值、代理池存活。这份汇总不需要触发任何规则，是给负责人看的运营视图。

### 4.5 服务商维护

三台机器都是 Contabo 的 VPS。Contabo 打宿主机补丁时会软重启 VM（2026-10-19 13:10–13:21 主服务器因此全站中断 11 分钟，同一分钟 worker-02 也被重启）。报告里的 `-- contabo status` 一节来自 https://contabo-status.com/rss ，`[OPEN]` 表示仍在进行。重启后所有服务都会自启，节点 30 秒内重连；bot 要做的是：把这类事件和中断联系起来，不要误报成软件故障，并在主服务器回来后确认 `services:`、两节点和 `api health` 恢复。

## 5. 报警时带什么信息

把触发规则的那几行原文、窗口起止时间、上一次正常报告的时间一起发给负责人。不要只发"系统异常"。如果能，同时附上 60 分钟窗口的报告，方便看趋势。

## 6. bot 不要做的事

- 不要尝试任何修改、重启、部署：这把钥匙做不到，也不应该做。gateway 永远不能用 `systemctl restart`（会丢请求），只能用蓝绿切换脚本，这是负责人的事。
- 不要把报告里的账号名、request id、IP 发到任何外部服务。
- 不要用 root 密码或别的凭据登录；只用这把只读钥匙。

## 7. 近期背景（2026-10-19）

当天做了一批修复：passthrough 路径的 `thinking` 参数归一化、点号模型别名、请求级错误不再换账号冷却、worker 的 Claude Code 关闭文件引用和账号邮箱泄露、Claude Code 形态判定收紧、gateway 蓝绿零中断发布、三台机器公共 DNS、节点链路宽限。详细见 `docs/issues-and-decisions.md` D20–D25 和 `docs/client-notes-2026-10-19.md`。

## 8. 错误码速查

| code | 状态 | 含义 | 性质 |
|---|---|---|---|
| `no_available_account` | 503 | 没有可用账号或节点 | 供给问题，红 |
| `upstream_stream_error` | 502 | 流式响应在结束前中断，看样例文字判断 | 视内容 |
| `upstream_error` | 502 | 上游 5xx / 网络错误，所有候选都失败 | 黄，成批则红 |
| `upstream_rate_limited` | 429 | 尝试过的账号都被限流 | 黄，持续则红 |
| `safeguards_refusal` / `prompt_too_long` / `invalid_request` / `request_too_large` / `model_not_found` / `upstream_client_error` | 4xx | 客户请求本身的问题 | 绿 |
| `quota_exhausted` / `insufficient_balance` | 429 / 402 | 客户 key 额度或余额问题 | 绿 |
