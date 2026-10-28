# 账号接入平台（上号）契约

> 状态：**已实现**（2026-10-15 晚）。供给端 Claude 订阅账号的自助接入系统。
> 相关：`ccr-supply.md`（CCR 供给总设计）、`v3-design.md` §5（账户体系）、`provider-protocol.md`（节点协议）。
> 参考 sub2api 的账户添加形态，按 1DayAPI 架构精简。

## 1. 原则

1. **一号一代理，全生命周期绑定**：上号必须绑定一条代理；授权（OAuth 同意）经该代理出口完成；
   之后该账号的一切平台侧请求（令牌刷新、巡检、会话 API）都经同一代理出口。
2. **代理即命脉**：绑定代理失联（节点探活失败）→ 账号立即不参与调度（`proxy_down`），恢复后自动回到调度。
3. **代理随号释放**：账号删除 → 代理释放回池（可再绑定其他账号）。账号停用/失效不自动释放（便于排查），删除才释放。
4. **一号一行，重复授权覆盖**：同一个底层 Claude 账号（按 OAuth `accountUuid` 判定，缺省回退 email）
   再次上号时**覆盖已有账号行**（换新凭据、状态重置 active、清除错误与冷却、按本次 job 重绑代理并释放旧绑定），
   不新建重复行——Anthropic 在重复授权时会吊销前一份 grant，旧行留着只会变成占着代理的死行。
5. **多人可上号**：管理员上号立即可调度（`approved`），归属随节点：平台节点 → 平台池（`owner_id=NULL`），号商节点 → 归该号商（与 `POST /api/admin/accounts` 的 `nodeId` 规则一致，号商按分成结算）；号商上号进自己名下（`review_status=pending`，管理员审核后调度）。
6. **当前只接入 Claude（Anthropic）系列**：上号表单、模型选择、目录展示均只出现 Claude；其余平台隐藏（前端过滤，注册表不动）。

## 2. 两种上号方式

### 方式一：sessionKey（`method=session_key`）

号商粘贴账号的 `sessionKey`（站点会话 cookie）。平台在服务器端真实浏览器（xvfb + Chromium）
经**绑定代理**完成官方同意页授权 → 换取令牌 → 创建云端环境 → 落库为账号。
全过程异步（约 1–2 分钟），经 job 轮询状态。

### 方式二：授权链接（`method=auth_url`）

平台生成授权 URL（PKCE 参数由平台持有）→ 上号人**在自己已登录该账号的浏览器**中打开并完成同意
→ 浏览器跳转到回调地址 → 上号人把回调 URL 粘贴回平台 → 平台经绑定代理换取令牌并落库。

> 注意：方式的授权请求来自上号人自己的浏览器 IP。为保持 IP 一致性（见 `ccr-supply.md` §2 的
> 实验结论），上号人应在其账号日常使用的网络环境（如配置了同一代理的指纹浏览器）中操作。
> 界面必须提示这一点。

## 3. 上号参数

| 参数 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `method` | ✅ | — | `session_key` / `auth_url` |
| `sessionKey` | 方式一 | — | 站点会话 cookie，仅用于一次性授权，用完即弃（不落库明文之外的长期存储） |
| `nodeId` | ✅ | — | 出网节点（该账号运行期请求的出口节点） |
| `proxyId` | — | `"auto"` | 手动指定代理，或 auto=平台从该节点的空闲健康代理中分配 |
| `concurrencyLimit` | — | 0（不限） | 账号最大并发请求数 |
| `rpmLimit` | — | 0（不限） | 每分钟请求数上限 |
| `name` / `note` | — | 自动 | 备注 |
| `groupId` | 管理员可选 | default | 号商上号不设分组，审核时由管理员指定 |

## 4. API

号商前缀换成 `/api/provider`（号商只能选自己的节点与代理）。

```
POST /api/admin/accounts/onboard
  方式一 body: {method:"session_key", sessionKey, nodeId, proxyId?, concurrencyLimit?, rpmLimit?, name?}
       → {data:{jobId, status:"working"}}
  方式二 第一步 body: {method:"auth_url", nodeId, proxyId?, ...}
       → {data:{jobId, status:"pending_callback", authorizeUrl}}
  方式二 第二步 body: {method:"auth_url", jobId, callbackUrl}
       → {data:{jobId, status:"working"}}

GET  /api/admin/accounts/onboard/:jobId
  → {data:{status, accountId?, error?, authorizeUrl?}}
  status: pending_callback | working | done | failed

GET  /api/admin/nodes/:id/proxies?free=1
  → {data:[{id, label, host, port, status}]}   // 脱敏（不含用户名密码），free=1 只返回未绑定且探活正常的
```

错误码：`proxy_pool_empty`（无空闲健康代理）、`proxy_bound`（手选的代理已被绑）、
`node_offline`、`onboard_bot_unavailable`（服务器未部署授权 bot）、`callback_invalid`（回调 URL 无法解析 / state 不匹配）、
`authorize_failed`（授权失败，含上游错误摘要）。

## 5. 数据模型（迁移 5）

- `accounts` 新增：`rpm_limit INTEGER NOT NULL DEFAULT 0`、`bound_proxy_id TEXT REFERENCES node_proxies(id)`。
  （`concurrency` 列沿用——语义即并发上限，0=不限。）
- `node_proxies` 新增：`bound_account_id TEXT REFERENCES accounts(id)`（NULL=空闲）。
- 新表 `onboarding_jobs`：`id PK, requester_id, scope('admin'|'provider'), method, node_id, proxy_id,
  params_json, payload_enc, authorize_url, status, account_id, error, created_at, updated_at`。
  payload_enc 存 sessionKey / PKCE verifier+state（加密），job 完成后清空。

## 6. 运行时行为

### 6.1 代理绑定与调度

- 上号成功 → `accounts.bound_proxy_id` + `node_proxies.bound_account_id` 同时写入（单事务）。
- 调度过滤（gateway `listCandidates` 之后）：`bound_proxy_id` 非空而代理 `status!='live'` → 跳过该账号
  （不计入错误冷却，代理恢复即自动可用）。
- auto 分配策略：该节点上 `status='live' AND bound_account_id IS NULL` 中按 `last_check_at` 最久未用优先。

代理"死"的判定在节点侧只认代理层失败（SOCKS 握手/认证、连不上代理、407）；上游侧的复位/超时只触发一次立即重探，不直接把代理标 dead。节点重启后代理在重探完成前报 `live:null`，平台保留上一次的 live/dead 结论（不再整批翻成 `unknown`），绑定账户的调度不因节点重启中断。

### 6.2 账号操作出口（CCR 账号）

`executor=ccr` 的账号，其会话 API 请求（建环境/建会话/events 推拉）与令牌刷新、巡检，
一律经隧道 `http_egress` 下行到 `accounts.node_id` 对应节点，节点用**钉死的代理**
（spec 新增 `proxyId` 字段，绕过粘性分配；代理缺失或死亡 → `no_proxy_available` 硬错误）。
直连路径（`executor=direct`）行为不变。

### 6.3 并发与 RPM 限额

网关在内存中按账号维护：在途请求计数（并发上限）与 60s 滑动窗口计数（RPM 上限）。
候选循环中超限账号跳过（不算失败、不触发冷却）。两者默认 0=不限。
限额是平台侧自我保护，与订阅窗口配额（`ccr-supply.md` §7）正交。

### 6.4 删除释放

删除账号（admin/号商自有）→ 同事务释放 `bound_proxy_id`（`bound_account_id` 置 NULL）。
删除节点（管理员或号商自删）在同一事务里释放其全部资源：绑定在其代理上的账户解绑并 `disabled`、删代理与分配、进行中的上号任务置 `failed`。代理池替换（`PUT /nodes/:id/proxies`）保留仍在列表中的条目（含绑定），已绑定账号的代理不能被移除（400 `proxy_bound`）。平台在节点每次 `provider.hello` 后推送整份代理池，节点本地副本与平台不会长期分叉。

### 6.5 预留与过期

上号任务从创建起就**预留**所选代理（自动挑选跳过 `working`/`pending_callback` 任务已选的代理，显式指定则 400 `proxy_bound`；挑选与建任务在同一事务），避免两个并发任务在真实授权完成后才发现抢了同一条代理。`working` 超过 6 分钟（bot 超时 + 余量，含 console 重启）或 `pending_callback` 超过 30 分钟的任务由启动时与每个巡检周期的清扫置为 `failed`，并清掉 `payload_enc`（PKCE verifier / sessionKey）。

## 7. 前端（web）

- 新增「账号接入」页（admin 与 provider 控制台均有入口）：
  方式切换（sessionKey / 授权链接）、参数表单（并发/RPM/节点选择/代理选择器含 auto）、
  job 状态轮询（pending_callback 时展示授权链接与回调粘贴框；working 时转圈；done 跳转账号详情；failed 展示错误）。
- 代理选择器：`GET .../proxies?free=1` 下拉，展示 label/host/探活状态。
- **全站 Claude-only**：公开站点模型页/价格页、控制台分组模型选择器只显示 `platform=anthropic` 的模型；
  其余平台前端隐藏（注册表与网关行为不变，方便日后恢复）。

## 8. 授权 bot 服务化（服务器侧）

- 位置：服务器 `/opt/ccr-lab/onboard_bot.py`（console 通过 `ONBOARD_BOT_CMD`  spawn，默认
  `xvfb-run -a /opt/ccr-lab/venv/bin/python /opt/ccr-lab/onboard_bot.py`）。
- 模式：`--sk --proxy`（浏览器授权全流程）/ `--callback --job-state --proxy`（仅换码 + 建环境）。
- 输出：最后一行 `RESULT {json}`（accessToken/refreshToken/expiresAt/orgUuid/accountUuid/environmentId/email）。
- 本地开发机无浏览器环境：`session_key` 方式返回 `onboard_bot_unavailable`；`auth_url` 方式可用
  （换码仅需代理，不需要浏览器）。

## 7. 上号员站点（/onboard，2026-10-16）

独立于控制台登录体系的上号工作站，供外包上号员使用：

- 管理员在控制台「上号员」页签发令牌（`1dk_onb_…`，`onboard_tokens` 表，migration 8），**令牌绑定目标节点**（签发时选择）。
- 上号员在 `https://1dayapi.com/onboard` 凭令牌进入（Bearer 鉴权，无 cookie 会话），只能看到并使用被绑定的节点：
  查看节点在线/容量/空闲代理 → 选代理（或自动分配）→ auth_url 流程上号。
- 作业以 `scope='onboarder'`、`requester_id='onb:<tokenId>'` 落库：账号**归平台池**（owner NULL、approved、进默认分组），
  与管理员上号的区别仅在于无分组选择权。
- 吊销令牌即断该上号员的访问；job 状态/列表接口均校验 requester 归属。
