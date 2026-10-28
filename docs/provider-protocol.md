# 1DayAPI Provider 协议契约（节点 ↔ 平台）

> 本文档是 provider-node（节点）、console（平台控制面）、gateway（隧道消费方）三方
> 共同遵守的唯一权威契约。协议形态参考行业同类产品（分析笔记在 `recon/notes/`，本地留存），
> 为本地重建做了简化：**只用 JSON+base64 数据面（json_base64_v1），不实现 binary_v1/credit_v1
> 流控、不实现自动升级、不实现 Jimeng/Cursor**。协议 v2（http_egress）见文末末节。
>
> 2026-10-27 的新订阅账号还要求本文末尾的 `team_isolation_v1` 增量；旧协议的任意同号商节点路由、全池粘性代理选择和普通 close 规则不能用于新隔离任务。

## 角色与连接

- 节点（apps/provider-node）：供应方机器上的守护进程，本地控制台 127.0.0.1:16889，
  出站 WebSocket 连平台 `wss://api.1dayapi.com/internal/provider/connect`
  （开发环境 `ws://localhost:8401/internal/provider/connect`）。
- 平台（apps/console）：HTTP `/internal/provider/*` + WS 控制面。
- 网关（apps/gateway）：收到推理请求后，若该 vendor 有在线节点则通过
  console 的隧道管理器（进程内 HTTP `127.0.0.1:8401/internal/tunnel/*`）开洞，
  隔着隧道自行对 vendor 域名做 TLS（节点只见加密字节）。

## 认证

- WS 握手头：`x-provider-node-id`、`x-provider-node-secret`（不放 query string）。
- HTTP /internal/provider/*（节点→平台）：同样的两个头。
- 绑定码：`bind_` + 32 位 hex，平台生成，10 分钟有效，一次性。

## HTTP 端点（平台侧，apps/console）

| 方法/路径 | 说明 | 请求体 → 响应 |
|---|---|---|
| POST /internal/provider/bind | 兑换绑定码（无需节点凭证头） | `{bindingCode, nodeId, nodeVersion, runtimeIdentity{osType,osVersion,osArch}}` → `{providerId, nodeId, providerNodeSecret, platformWsUrl}`；码无效 401 `invalid_binding_code` |
| POST /internal/provider/unbind | 解绑（要凭证头） | → `{ok:true}`，节点 secret 作废 |
| GET /internal/provider/status | 节点状态 | → `{providerId, nodeId, online, credentials:[...]}` |
| GET /internal/provider/credentials | 凭证列表 | → `{data:[{credentialBindingId, vendor, accountEmail, subscriptionType, status, createdAt}]}` |
| POST /internal/provider/credentials | 上传凭证 | `{vendor, accessToken, refreshToken?, expiresAt?, accountId?, tokenType?, scope?, accountEmail?, subscriptionType?}` → `{credentialBindingId}`（v3：写入 `accounts`，待管理员审核） |
| POST /internal/tunnel/open | 网关专用（回环 + 内部令牌 `x-1dayapi-internal`）：按账户挑其号商的在线节点开 TCP 洞 | `{accountId, targetHost, targetPort}` → `{sessionId, nodeId}` 或 503 `no_online_node` |
| POST /internal/tunnel/:sessionId/data | 网关 → 节点方向写数据 | `{payloadBase64}` → `{ok:true}` |
| GET /internal/tunnel/:sessionId/read?timeout=ms | 长轮询读节点→平台数据 | → `{chunks:[{seq,payloadBase64}], closed, error?}` |
| POST /internal/tunnel/:sessionId/close | 关洞 | → `{ok:true}` |

网关与 console 同机部署，隧道数据面走 loopback HTTP 长轮询即可（简化；原站是平台常驻内存直连 WS）。
`/internal/tunnel/*` 四个端点都要求 socket 来源为回环地址**且**请求头 `x-1dayapi-internal` 等于 `data/internal.key`（或 `INTERNAL_TOKEN`），否则 403 `forbidden`。

## WS 消息（JSON，文本帧）

### 节点 → 平台

| type | 字段 |
|---|---|
| `provider.hello` | `nodeId, providerId?, nodeVersion, capabilities:["official_exit"], acceptingSessions` |
| `provider.heartbeat` | `nodeId, inFlight, healthy, riskState?("ready"/"cooling_down"/"auth_invalid"), officialExit?{activeSessions}, acceptingSessions`（10s 一次） |
| `official_exit.open_response` | `sessionId, accepted, reasonCode?` |
| `official_exit.data` | `sessionId, seq, payloadBase64` |
| `official_exit.close` | `sessionId, reasonCode?` |
| `official_exit.error` | `sessionId, errorCode, errorMessage?, retryable?` |

### 平台 → 节点

| type | 字段 |
|---|---|
| `platform.ready` | `nodeId`（hello 应答） |
| `official_exit.open` | `sessionId, routeMode:"official_exit", providerId, nodeId, credentialBindingId, targetHost, targetPort, deadlineMs` |
| `official_exit.data` | 同上 |
| `official_exit.close` | 同上 |

### 关闭码（WS close reason）抑制重连

`invalid_provider_secret`、`node_paused`、`node_revoked`、`provider_identity_mismatch`

### 重连

指数退避 base 2s / max 30s / jitter 25%，最多 10 次后回到 2s 重新循环。

## 出口白名单（节点强制执行；可用环境变量 PROVIDER_OFFICIAL_EXIT_ALLOWED_HOSTS 追加，平台不可远程放大）

`*.openai.com, *.chatgpt.com, *.anthropic.com, *.claude.com, *.claude.ai, *.aliyuncs.com, *.bigmodel.cn, *.z.ai, *.kimi.com, *.moonshot.ai, *.moonshot.cn, *.minimax.io, *.minimaxi.com, *.deepseek.com, generativelanguage.googleapis.com, *.x.ai, *.grok.com, ark.cn-beijing.volces.com`

`*.` 前缀匹配域及子域，否则精确匹配。

## 节点本地控制台 API（127.0.0.1:16889）

| 方法/路径 | 说明 |
|---|---|
| GET / | 控制台 HTML（单文件，内嵌） |
| GET /api/status | 桥接状态 + 绑定信息 + 凭证列表（脱敏） |
| POST /api/platform/bind | `{bindingCode, platformBindUrl?}` → 调平台 bind，落盘配置，重连 WS |
| POST /api/platform/unbind | 解绑并重置配置 |
| GET /api/oauth/local/detect | 探测本机凭证（~/.claude/.credentials.json、~/.codex/auth.json） |
| POST /api/platform/credentials/authorize-local | 导入本机凭证并上传平台 |
| POST /api/platform/credentials/authorize-token | `{vendor, tokenJson}` 手动粘贴上传 |

写操作要求 header `x-1dayapi-csrf`（GET /api/status 响应头里下发 `x-csrf-token`，控制台页面加载时取）。Host 头只接受 127.0.0.1/localhost/[::1]。

## 节点配置

`~/.config/1dayapi-provider-node/config.json`（0600，目录 0700，`PROVIDER_CONFIG_PATH` 可改）。
节点配置里**只有 `providerNodeSecret` 被加密落盘**（AES-256-GCM，前缀 `enc:v1:`）；主钥 =
同目录 `config.key`（32 随机字节 base64url → sha256，0600，自动生成）。

> vendor 的 `accessToken`/`refreshToken` **不写入节点配置**——节点探测/粘贴后直接上传平台，
> 加密存放在平台 DB 的 `accounts.credential_enc`（JSON：`{accessToken, refreshToken, expiresAt, accountId}`；平台侧用自己的 `PROVIDER_CRED_KEY`/
> `data/provider-cred.key` 做同样的 `enc:v1:` 加密）。节点与平台是两套独立的加密存储。

## 数据库（v3，`packages/core` 建表）

- `nodes`（原 `provider_nodes`）：`node_id`、`provider_id → users(id)`、`secret_hash`（sha256 节点密钥）、`node_version`、`os_type`、`os_arch`、
  `online`、`accepting_sessions`、`in_flight`、`last_heartbeat_at`。
- `node_bind_codes`（原 `provider_bind_codes`）：`code`、`provider_id`、`expires_at`、`used_at`。
- 节点上传的凭证不再有单独的表，直接成为上游账户：`accounts` 行 `type='oauth'`、`route='node'`、`owner_id=号商`、
  `review_status='pending'`；`credentialBindingId` 即 `accounts.id`（`cred_<uuid>`）。

完整 DDL 见 `v3-design.md` §3 与 `data-model.md`。

## 网关路由规则（apps/gateway，v3）

隧道不再是"每个请求先试一下"的全局路径，而是**账户的属性**：只有 `route='node'` 的上游账户（号商所有、已审核、active）走隧道。
网关按分组调度选中这类账户后：

1. `POST /internal/tunnel/open {accountId, targetHost, targetPort}`，目标取自账户 Base URL（OAuth 账户为平台固定出口，如 `api.anthropic.com:443`）。
2. console 选该号商在线且接受会话的节点（账户固定了 `node_id` 时只用它，否则轮询），下发 `official_exit.open`。
3. 成功后网关在隧道上 `tls.connect({socket: 隧道duplex, servername})`，发原始 HTTP/1.1 请求，流式读取响应。
4. 开不了洞（503 / 节点拒绝 / TLS 失败）→ 该账户本次跳过，换下一个候选；不再回退任何 `UPSTREAM_*` 直连。

凭证使用：网关通过 `@1dayapi/core` 直接解密账户凭证并自行写入请求头（Anthropic OAuth 为 `Authorization: Bearer` +
`anthropic-beta: oauth-2025-04-20`）；open 响应不再携带 `injectedHeaders`，节点永远看不到明文令牌也不构造请求。

## 用户态 API（控制台，会话认证）

号商侧接口已并入 v3 控制台：`POST /api/provider/bind-codes`、`GET /api/provider/nodes`、`DELETE /api/provider/nodes/:id`、
`GET|POST /api/provider/accounts`、`PATCH|DELETE /api/provider/accounts/:id` 等，仅 provider 角色可用。详见 `console-api.md` §3。
v2 的 `/api/provider/credentials` 已删除（凭证即账户）。

## 实现现状（相对本契约的简化与缺口）

v3 的变化：

- **凭证需审核**：节点上传的凭证先是 `pending`，管理员在控制台通过（指定分组、优先级、分成比例）后才参与调度。
  节点拉取的凭证列表里 `status` 在审核前显示 `pending` / `rejected`；节点本地控制台显示为"待审核"。
- **ChatGPT accountId**：节点上传 Codex 凭证时带 `accountId`（`tokens.account_id` 或 JWT 的 `chatgpt_account_id`）；平台缺失时也会从 accessToken 的 JWT 补取。
- **`deadlineMs` 改为相对毫秒**：平台下发 `official_exit.open` 时 `deadlineMs=15000`（连接超时），与节点实现（`min(deadlineMs, 60000)`）一致。
- **隧道按账户开洞**，open 请求只接受 `accountId`；内部端点要求内部令牌。
- **新增关闭码 4003**：号商解绑节点（`unbound_by_provider`）、管理员移除节点（`removed_by_admin`）、号商被禁用（`provider_disabled`）。
  号商被禁用后其节点密钥校验失败（4001）。
- **绑定冲突**：同一 `nodeId` 已绑定到其他号商时 bind 返回 409 `node_bound_elsewhere`。

仍未实现（与 v2 相同）：

- **心跳风险信号**：节点心跳恒 `healthy:true`，平台忽略 `healthy`/`riskState`/`officialExit`，只更新 `inFlight`/`acceptingSessions`/`lastHeartbeatAt`。
- **`node_paused`/`node_revoked`**：节点识别但平台从不发送。
- **字段不落库**：bind 的 `runtimeIdentity.osVersion`、上传凭证的 `tokenType`/`scope`。
- **原站特性**：`binary_v1`/`credit_v1` 流控、自动升级、`provider.drain`、`provider.credential_mirror_update`、Jimeng/Cursor/Ollama 等 vendor。

## 实现现状（协议 v2：http-egress，2026-10-15）

平台侧（apps/console + packages/core）已落地：

- **DB migration 2**：`node_proxies` / `node_proxy_assignments` 建表，`nodes` 加 `capacity`（默认 100）/`deploy_meta`；幂等（IF NOT EXISTS + PRAGMA 列检查），全新库由 SCHEMA_V3 直接带齐。
- **隧道 open 支持 kind**：`/internal/tunnel/open` 接受 `{accountId, kind:"http_egress"}`（免 targetHost/targetPort），WS `official_exit.open` 带 `kind` 字段；字节管道不变。
- **代理池台账**：`PUT/GET /api/admin/nodes/:id/proxies`；URL 以 `enc:v1:` 密文落库，脱敏展示（密码掩 `***`）；节点在线时 WS 推送 `proxies.set`（明文仅此一处）；心跳 `proxies[{id,live,error?}]`（id=sha256(url) 前 12 位）回写 `status/last_check_at/last_error`，`assignments` 全量覆盖回写。
- **容量硬校验**：`PATCH /api/admin/accounts/:id` 绑节点时校验存在/在线/`capacity`，`route:"direct"` 解绑清 `node_id`。
- **部署**：`POST /api/admin/nodes/deploy`（SSH，密码走 `sshpass -e`、密钥走 0600 临时文件，secrets 经 stdin  prelude 进远程环境变量，不进 argv；180s 超时 + 30s 等上线）、`POST /api/admin/nodes/local`（本机 bun 直接起，控制台端口 16889 起自动分配）。
- **bundle**：`GET /internal/provider/bundle`（`bun build --target=bun` 单文件，按 provider-node 版本+源码 mtime 缓存于 `data/bundle-cache/`）；内部令牌（回环）或一次性 bind code 认证。
- **绑定方式偏离契约（有意）**：deploy 是**平台侧建节点**——admin 端点直接生成 `nodeId`+secret 落库，bind code 只作 bundle 下载的一次性令牌（下载即消耗），节点不再走 `/internal/provider/bind` 兑换；节点配置里的明文 secret 由节点首启时自动转加密（config.ts 既有行为）。远程脚本在 systemd 不可用时退化 nohup；非 root 用 `systemctl --user` + `loginctl enable-linger`。

依赖节点侧（apps/provider-node，并行开发）：`kind:"http_egress"` 的执行（HttpEgressManager）、`proxies.set` 落盘、心跳上报（联调时已验证 `proxies.set` 与心跳回写链路）。部署目标机需能访问 bun.sh 与平台 bundle URL；console 主机需预装 `sshpass`（密码认证时）。

---

# 协议 v2：http-egress（节点侧 HTTP 出口 + 强制代理 + TLS 指纹）

> 2026-10-15 起生效。动机：v1 隧道里 TLS 在**网关**侧终止（OpenSSL），上游看到的 ClientHello 不是 Claude Code 的 Bun/BoringSSL。v2 把完整 HTTP 请求下沉到节点执行，**TLS 在节点终止**，配合 Bun 1.4.3 运行时（与 CC 2.1.300 同版本族）使 TLS 指纹与官方客户端一致。指纹头 canonical 集由节点上的 vendored `fingerprint.ts` 兜底注入——**节点更新即指纹更新**。

## 信任模型变化（重要）

v1 节点只见密文（凭证永不落节点）。v2 节点要发 HTTP 请求，**必然看到明文请求（含 x-api-key / Authorization）**。合理性：route=node 的账户本来就属于该号商（provider）本人。约束：节点**禁止记录/持久化**请求头与 body（代码层保证，日志只出状态码/字节数）。平台 WS 为 wss 加密传输。

## 隧道会话 kind = "http_egress"

复用既有字节管道（`/internal/tunnel/open|data|read|close`），`open` 请求体改为：
`{accountId, kind:"http_egress", proxyId?}`（不再传 targetHost/targetPort）。可选 `proxyId`
（docs/onboarding.md §6.2）把该会话钉到账户绑定的那条池代理，console 透传进 `http_egress.open` 信封。

字节管道上的应用层帧（均为管道字节，不是 WS 消息）：

1. **网关 → 节点**：一行 JSON（`\n` 结尾，≤8MB）：`{"url","method"?,"headers":{...},"bodyBase64":"...","proxyId"?}`；`method` 取 GET/POST/PUT/PATCH/DELETE/HEAD，缺省时有 body 为 POST、无 body 为 GET（HEAD 不读 body）
   —— spec 里的 `proxyId` 优先于 open 信封里的；两者都没有 = 既有粘性分配行为。
2. **节点 → 网关**：头行 JSON（`\n` 结尾）：成功 `{"status":200,"headers":{...}}`，失败 `{"error":"code","message":"..."}`；随后是成功时的**响应 body 字节流**（SSE 逐 chunk 转发），body 结束即关会话。Bun 已解压 body，因此头行里**不带** `content-encoding` / `content-length` / `transfer-encoding`。

节点侧 WS 信封（console ↔ 节点，镜像 v1 `official_exit.*` 命名，已实现于 apps/provider-node）：

| type | 方向 | 字段 |
|---|---|---|
| `http_egress.open` | 平台→节点 | `sessionId, routeMode:"http_egress", providerId, nodeId, credentialBindingId, accountId, proxyId?, deadlineMs, headersTimeoutMs?`（无 targetHost/targetPort；`accountId` 供代理粘性分配；`proxyId` 钉死代理，docs/onboarding.md §6.2）。**两个超时**：`deadlineMs` 只约束 spec 行到达（平台发 15000，节点上限 60 s）；spec 到达后改用 `headersTimeoutMs` 等上游响应头（网关传 `UPSTREAM_TIMEOUT_MS`=300 s，节点缺省 300 s、上限 600 s）——非流式长请求不会再被 15 s 掐断 |
| `http_egress.open_response` | 节点→平台 | `sessionId, accepted, reasonCode?`（接受后才发 spec 行） |
| `http_egress.data` | 双向 | `sessionId, seq, payloadBase64`（网关侧发 spec 行字节；节点侧发头行+body 字节） |
| `http_egress.close` | 双向 | `sessionId, reasonCode?`（节点正常结束用 `complete`） |
| `http_egress.error` | 节点→平台 | `sessionId, errorCode, errorMessage?, retryable?`（仅传输级异常；应用层错误走管道内 error 头行） |
| `proxies.set` | 平台→节点 | `proxies: string[]`（整体替换代理池，节点加密落盘并立即探活） |

心跳新增字段（`provider.heartbeat`）：`proxies: [{id, url, live, latencyMs}]`（`id`=sha256(url) 前 12 位 hex，`url` 已去 userinfo）、`assignments: {accountId: proxyId}`。
节点 `provider.hello` 的 `capabilities` 增加 `"http_egress"`。

心跳再增（2026-10-17，节点监控看板）：`host: {totalMemMb, freeMemMb, load1, load5, cpus, uptimeSec, processRssMb, processUptimeSec,
bunVersion, nodeVersion, bundleHash, draining}`（`bundleHash` = 运行中 bundle 文件 sha256 前 12 位，便于核对部署版本；`draining`
= 已收到 SIGTERM 正在优雅排空）与 `egress: {activeSessions}`（直连出口会话数）。平台把整条心跳的快照写进 `nodes.metrics`（迁移 12），
供 `GET /api/admin/nodes/monitor` 读取。所有新字段可选，旧节点不带也不影响。

头行 `error` 取值（节点实现）：`bad_spec` / `bad_url` / `target_not_allowed` / `no_proxy_available` / `upstream_connect_failed` / `spec_too_large`。

`upstream_connect_failed` 时节点区分故障层：代理层失败（SOCKS 握手/认证、连代理被拒、407 等）才计入代理的失败 strike（连续 `PROXY_DEAD_AFTER`=3 次才标 `dead`，onboarding.md §6.1）；上游侧失败（目标复位、TLS、超时）只触发该代理的一次立即重探，由探测结果决定 live/dead——一号一代理之下，一次上游抖动不能把账号下线。

**控制连接保活**：平台每 30 s `ping`，一次未 `pong` 即 `terminate()`；节点 90 s 收不到任何平台帧（消息/ping/pong）即主动断开重连；节点重连取代旧连接时，旧连接上的会话一律以 `node_reconnected` 失败；会话帧只接受来自会话所属节点的连接。平台在 `provider.hello` 后立即推送该节点的代理池（`proxies.set`），节点本地副本与平台永不长期分叉。

## 节点执行规则（HttpEgressManager）

1. 解析 spec 行 → 校验 `url` host 在出口白名单（同 v1）。
2. **强制代理**：带 `proxyId`（spec 或 open 信封）时用 `ProxyPool.getPinned(proxyId)` 取**恰好那条**池代理（在池且未标记死亡）；否则取该 `accountId` 的粘性代理；**钉死的代理缺失/已死、池空/代理不可用 → 立即返回 `{"error":"no_proxy_available"}`，绝不直连、钉死场景也不退化为粘性**。`REQUIRE_PROXY` 恒为 true（v2 无直连模式）。
3. 指纹兜底：请求头过 vendored `anthropicFingerprintHeaders`（缺啥补啥；网关已注入则原样保留）。
4. `Bun.fetch(url, {proxy, headers, body, ...})` 发请求，流式读回，按到达顺序写入管道。运行时必须是 Bun（`typeof Bun !== "undefined"`），Node 下启动直接拒绝服务（防指纹退化）。
5. 代理粘性：`assignments[accountId]=proxyUrl` 存配置（加密落盘）；代理失效时重hash到下一个存活代理并上报新分配。

## 代理池

- 来源：(a) 平台管理台录入 → WS 推送 `proxies.set` → 节点加密落盘；(b) 节点本地配置文件 `proxies` 数组。
- 格式：`http://[user:pass@]host:port` / `socks5://[user:pass@]host:port`（`socks5h://` 等价）。http(s) 代理直接交给 Bun fetch 的 `proxy`
  选项；**Bun fetch 不支持 SOCKS**（`UnsupportedProxyProtocol`），socks5 代理由节点内的 `socks5-bridge.ts` 以回环 HTTP CONNECT 代理桥接
  （每个 socks5 上游一个 127.0.0.1 监听；SOCKS5 握手含用户名密码认证，域名交给代理解析；TLS 仍在 Bun 终止，指纹不变）。
- 健康检查：节点每 5 分钟经代理 GET `https://api.anthropic.com/v1/models` 探活（任何 HTTP 响应算存活，传输/代理层失败记一次 strike，
  **连续 `PROXY_DEAD_AFTER`（默认 3）次才算失效**，成功即清零，见 onboarding.md §6.1），并发 4 个，池被替换时排队重跑一遍。状态随心跳上报 `proxies: [{id, url, live, latencyMs, error}]`（URL 脱敏；`live=null` 表示尚未探测，
  平台记为 `unknown` 而非 `dead`；`error` 为失败原因，管理台代理池表「失败原因」列可见）。
- 分配上报：心跳携带 `assignments: {accountId: proxyId}`，平台落 `node_proxy_assignments` 表供管理台展示。

## 数据库新增（v3 migration 2）

- `node_proxies`：`id, node_id, url_enc, label, status, last_check_at, last_error, created_at`（平台侧台账，脱敏展示）。
- `node_proxy_assignments`：`node_id, account_id, proxy_id, updated_at, PRIMARY KEY(node_id, account_id)`。
- `nodes` 加列：`capacity INTEGER NOT NULL DEFAULT 100`、`deploy_meta TEXT`（JSON：部署主机/方式/时间）。

## 平台管理 API（admin 角色）

- `GET /api/admin/nodes`：节点列表（在线、版本、容量、账号数、代理数、部署元数据）。
- `PUT /api/admin/nodes/:id/proxies` `{proxies:[{url,label}]}`：整体替换代理池，落库并推送在线节点。
- `GET /api/admin/nodes/:id/proxies`：脱敏列表 + 存活状态 + 分配数。
- `POST /api/admin/nodes/deploy` `{host, port?, username, password?|privateKey?, name?, proxies?[]}`：服务器侧 SSH 自动部署（装 Bun 1.4.3 → 拉 bundle → 写配置 → systemd → 回连验证），返回 `{nodeId, online}`。
- `POST /api/admin/nodes/local` `{name?, proxies?[]}`：在**本服务器**直接起一个节点（同 install 流程，host=127.0.0.1）。
- `GET /internal/provider/bundle?code=<bindCode>`：节点安装包（tar.gz：dist + 生产 node_modules + install.sh），bind code 做一次性认证。
- 账户绑定节点：`PATCH /api/admin/accounts/:id` `{route:"node", nodeId}`，校验节点容量（≤100）。

## 容量

每节点 `capacity`（默认 100）：`accounts.route='node' AND node_id=X` 的 active 账户数不得超过。控制台绑定接口硬校验。

## 网关侧变化（apps/gateway）

- `tunnel.ts`：`fetchViaTunnel` 改 v2——open 带 `kind:"http_egress"`，写 spec 行，读头行 JSON，body 流原样转 web ReadableStream；不再 `tls.connect`。
- 失败语义不变：开不了洞 = 基础设施跳过（换账户），头行 `error` = 节点/代理故障（换账户），HTTP 状态 ≥400 = 上游计费语义照 v1。
- 指纹头仍在网关 `buildUpstreamRequest` 先注入一遍（直连接路径需要），节点侧再兜底一遍（防网关旧版漏注）。

# 协议 v3 增量：cc_worker（节点跑真 Claude Code，docs/ccr-supply.md §8.1）

隧道 kind `"cc_worker"`：`POST /internal/tunnel/open` 请求体
`{accountId, kind:"cc_worker", proxyId?, model, prompt, stream, cred:{accessToken, refreshToken?, expiresAt?, subscriptionType?}}`
（console 校验该账户 `executor='ccr_worker'`）。所有参数随 open 走，字节管道上**没有 spec 行**；
节点→平台的数据帧即 worker 的 stream-json stdout 原样字节。

| type | 方向 | 字段 |
|---|---|---|
| `cc_worker.open` | 平台→节点 | `sessionId, routeMode:"cc_worker", providerId, nodeId, credentialBindingId, accountId, proxyId?, model, prompt, stream?, cred, deadlineMs`（`cred` 只出现在 WSS 信封，节点落盘 0600，日志绝不打印） |
| `cc_worker.open`（持久会话字段，docs/worker-sessions.md） | 平台→节点 | `persist, reuseKey, turnMode:"fresh"\|"continue"\|"tool_result", expectedTurn, deviceId, systemPrompt, tools[], results[], history[]`：节点按 `reuseKey` 复用常驻 claude 进程，`continue` 只喂 `content`（新一轮）；进程不能接（busy / 停泊等工具结果 / 已退出 / `expectedTurn` 不符）时用 `history`（continue 随带的全量分块，2026-10-22）起新进程并对齐计数，没有 `history` 则回 `cc_worker.error session_lost`，绝不以增量起进程。`tools` = 客户工具定义，节点以回环 MCP 服务提供；`tool_result` 以 `results[{callId,content,isError}]` 回复挂起的 MCP 调用、同一轮续写 |
| （data 帧内）`{"type":"1dayapi_tool_call",callId,name,input}` | 节点→平台 | 节点合成的 stdout 行：一个 MCP `tools/call` 已挂起等待客户结果；网关据此结束当前响应（`stop_reason: tool_use`）。`cc_worker.close` 的 `reasonCode:"awaiting_tool_result"` 表示进程停泊等待 |
| `cc_worker.open_response` | 节点→平台 | `sessionId, accepted, reasonCode?`；拒绝码：`node_identity_mismatch / node_draining / claude_not_installed / bad_request / bad_credential / duplicate_session / no_proxy_available / worker_overloaded / self_test_failed: <原因>`（节点启动自检未过，见 ccr-supply.md §8.1） |
| `cc_worker.data` | 节点→平台 | `sessionId, seq, payloadBase64`（stdout 字节流，行 JSON 族：system/assistant/stream_event/result） |
| `cc_worker.close` | 双向 | `sessionId, reasonCode?`（节点正常结束 `complete`；平台→节点 = 杀进程） |
| `cc_worker.error` | 节点→平台 | `sessionId, errorCode, errorMessage?, retryable?`（`worker_failed` 退出码+stderr 尾巴（≤300 字，不含 token）/ `worker_timeout`（600s 强杀）/ `worker_spawn_failed` / `session_lost`（continue 落空且 open 无全量历史，2026-10-22）） |

节点执行规则（`CcWorkerManager`）：

1. 钉代理：`proxyId` → `ProxyPool.getPinned`（缺失/已死 → 拒绝 `no_proxy_available`）；缺省走粘性分配；绝不直连。
   socks5 经既有本地桥转成回环 http 代理，注入 `HTTPS_PROXY/HTTP_PROXY/https_proxy/http_proxy`。
2. 凭证物化：`<workerRoot>/cc-accounts/<accountId>/`（0700；workerRoot 见 ccr-supply.md §8.1，降权时为 `/var/lib/1dayapi-cc-worker`）下 `.credentials.json`（0600，
   `claudeAiOauth:{accessToken,refreshToken,expiresAt(ms),scopes 五件套,subscriptionType}`）+ `settings.json`
   （`hasCompletedOnboarding:true`）。
3. spawn：`claude -p <prompt> --model <model> --output-format stream-json --verbose`（`stream:true` 加
   `--include-partial-messages`），env `CLAUDE_CONFIG_DIR` 指向该目录。
4. 并发护栏：`cc_worker_max_concurrency`（默认 floor((可用内存MB-512)/320)，下限 1；env `CC_WORKER_MAX_CONCURRENCY`），
   超限 FIFO 排队（accept 先入队），队列 >30 拒 `worker_overloaded`；进程 600s 强杀。
5. 心跳新增 `ccWorker: {enabled, claudeVersion, maxConcurrency, active, queued}`；`provider.hello` capabilities 含 `"cc_worker"`。
   平台侧落 `nodes.deploy_meta.ccWorker`（节点页数据结构透出）。install.sh 加装 `@anthropic-ai/claude-code@2.1.300`
   （npm 优先、bun 兜底；装不上仅告警，节点其余能力不受影响）。

网关侧：`openCcWorker()`（tunnel.ts）开洞拿 stdout 字节流；`ccr/worker.ts` 按行解析喂给共享 `SessionTranslator`
转 Messages SSE/JSON；请求侧复用 `messagesToPrompt` 折叠（tools 的 ```tool_call 围栏约定与云端模式一致）。
开不了洞（节点离线/拒收）= 基础设施跳过换账户；`worker_failed`/`worker_timeout` = 502 瞬态。


## 链路宽限（link grace，2026-10-19）

节点 ↔ 平台的控制 WebSocket 经 Cloudflare，偶发被回收（10-19 当天三次，每次 2 秒内重连）。此前任一方一见 socket 关闭就把该节点上
全部会话判失败：console `failNodeSessions(node_disconnected)`，节点 `closeAll(transport_lost)`，11:47 一次抖动切断了 11 条 worker 流。
现在双方都保留会话等待重连：

| 侧 | 行为 |
|---|---|
| console | socket 关闭后，已建立的会话保留 `NODE_LINK_GRACE_MS`（默认 30 s）；期间网关写入的帧（`*.data` / `*.close`）按节点排队（上限 5000 帧），`writeTunnel` 仍返回 true；未完成的 open 立即失败。同一 nodeId 重连后，`provider.hello` 里的 `sessions: [...]` 列出节点仍在运行的会话：不在列表里的会话以 `node_lost_session` 失败，在列表里的继续，排队的帧按序下发；`platform.ready` 回 `retainedSessions: [...]`。hello 没有 `sessions` 字段（旧 bundle）→ 全部以 `node_reconnected` 失败（旧行为）。宽限到期仍未重连 → `node_disconnected`。 |
| 节点 | socket 关闭后不再 `closeAll`，启动 35 s 宽限（比平台长，让平台先裁决）；期间三个 manager 产生的会话帧缓冲在 bridge（上限 5000 帧 / 48 MiB，超限则放弃并关闭全部会话）；hello 带 `sessions`；收到 `platform.ready` 后，`retainedSessions` 之外的本地会话以 `platform_lost_session` 关闭，其余会话的缓冲帧按序补发；`platform.ready` 没有该字段（旧平台）→ 关闭全部会话。平台明确要求不重连（`SUPPRESS_RECONNECT_REASONS`）或节点 stop() 时仍立即关闭。 |

兼容矩阵：新 console + 旧节点 = 旧行为（节点自己关会话，console 据 hello 无列表全失败）；旧 console + 新节点 = 节点保留 35 s，
重连后平台 ready 无 `retainedSessions` → 节点关闭全部（旧行为）；两侧都新 = 抖动对网关和客户不可见（读长轮询最多多等一次 25 s 上限）。
console 自身重启仍会切断所有在途会话（会话表在内存里）。测试：`apps/console/test/link-grace.test.mjs`。

## 组织隔离增量（team_isolation_v1，2026-10-27）

组织使用真实 Claude 组织 UUID；不复用计费 group 或 provider 身份。平台与节点共同验证组织、账号、固定代理和对话阶段，旧节点不接新的隔离任务，也不会收到新隔离代理 URL。

| 消息 / 数据 | 新字段与语义 |
|---|---|
| `provider.hello` | capabilities 含 `team_isolation_v1`；`runtimeTeamId?` 限定专属服务实例；`isolatedContexts?` 报告现存执行上下文供重连撤销 |
| `proxies.set` | `proxyTeams: Record<proxyId,teamId>` 与 `proxyAccounts: Record<proxyId,accountId[]>` 是平台授权的组织和账号白名单，随代理列表加密持久化 |
| `provider.heartbeat.proxies[]` | `exitIp` 是节点实测公网出口，不以 URL host 或 URL hash 代替；平台规范化 IP 后合并容量与检查归属 |
| `cc_worker.open` / `http_egress.open` | 对话执行携带 `isolation:{teamId,conversationId,generation}`；凭据刷新/探活等后台出口同样校验 team 和账号白名单 |
| `isolation.reset` | 平台发送 `{isolation,resetId}`，精确终止旧阶段的队列、worker 进程组、挂起 MCP 与 HTTP 出口 |
| `isolation.reset_ack` | 节点完成强制撤销后返回 `resetId`，与普通 `*.close` 的语义不同 |

新账号必须固定节点和代理，节点只允许使用该账号的固定设备身份。代理缺失、归属不符或账号不在白名单时拒绝，不退回其他代理或同号商的其他节点。一个出口正常两号、常规名额不足时最多三号，所有账号必须同组织。

网关先持久切换代次，平台对旧阶段读、写、缓冲和迟到输出立即封锁；仅执行过旧阶段的节点参与撤销确认。不确认的旧节点会被撤销连接，保留重连后重置任务，不阻止新组织接手。新对话阶段使用清空后的输入和新的上游会话身份，不能携旧消息、system/developer、工具结果或远端续接句柄。

为避免节点快速返回时丢帧，平台在发送 open 前预注册会话；即使 accepted、数据和 close 在同一个 TCP 包内到达，也必须保留已收到的队列与关闭状态。

部署与兼容性验证见 [`team-isolation.md`](team-isolation.md)、[`operations.md`](operations.md) 和[发布记录](deployment/team-isolation-2026-10-27.md)。
