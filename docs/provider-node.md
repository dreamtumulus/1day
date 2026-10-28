# 号商节点守护进程（apps/provider-node）

> 运行在号商机器或平台服务器上（管理台可 SSH / 本机部署，见 `provider-protocol.md` 协议 v2 节）。协议契约见 `provider-protocol.md`；
> 本文描述节点内部实现、本地控制台、CLI 与安装。代码：`apps/provider-node/src/`。**运行时为 Bun 1.4.x**（协议 v2 要求），
> 以单文件 bundle 分发；§8–§9 的 Node 安装路径是 v1 遗留。
>
> 2026-10-27 增量：新隔离账号要求 `team_isolation_v1`、固定代理白名单和对话阶段校验；完整规则见 [`team-isolation.md`](team-isolation.md)，实际节点升级情况见[发布记录](deployment/team-isolation-2026-10-27.md)。

## 1. 职责

1. 本地控制台（`127.0.0.1:16889`）：绑定平台、导入/粘贴凭证、查看状态。
2. 平台桥接：出站 WS 长连接到平台控制面，hello / 心跳 / 接收出口指令。
3. official-exit：按平台指令对**白名单内**的官方域名开裸 TCP 连接，双向搬运字节（不解密、不解析）。
4. 凭证采集：读取本机 Claude Code / Codex CLI 的 OAuth 凭证或手动粘贴，**上传到平台**（节点自身不保存 vendor token）。
   新 Claude 订阅凭据上传共用 token 实际验证、组织核验和固定出口名额流程，不能创建无组织、无固定代理的可调度账号。
   Codex 凭证同时上传 ChatGPT `accountId`（`tokens.account_id` 或 JWT 的 `chatgpt_account_id`）；其他供给类型按其审核规则处理。

## 2. 模块

| 文件 | 职责 |
|---|---|
| `index.ts` | 入口 `main()`：加载配置、建桥接、起控制台、处理 SIGINT/SIGTERM |
| `server.ts` | 本地控制台 HTTP API（Host 白名单 + CSRF） |
| `console-html.ts` | 内嵌单页控制台 HTML（每 5s 轮询 `/api/status`） |
| `bridge.ts` | `PlatformBridge`：WS 客户端、状态机、心跳、重连 |
| `official-exit.ts` | `OfficialExitManager`：v1 TCP 出口会话（保留） |
| `http-egress.ts` | `HttpEgressManager`：协议 v2 HTTP 出口（spec 行 → 强制代理 → Bun fetch → 头行 + body） |
| `proxy-pool.ts` | 代理池：平台推送 / 本地配置、隔离账号固定 pin 与组织/账号白名单、旧模式粘性分配、并发 4 探活与出口 IP 观测 |
| `isolation.ts` | team / conversation / generation 校验与不可逆阶段撤销 |
| `socks5-bridge.ts` | socks5(h) 上游 → 回环 HTTP CONNECT 桥（Bun fetch 不支持 SOCKS）；桥地址带每进程随机令牌（`http://x:<token>@127.0.0.1:port`，Bun / Claude Code 自动转成 `Proxy-Authorization`），本机其它进程不能借桥白嫖上游代理；IPv6 字面量按 ATYP=4 发送 |
| `fingerprint.ts` | vendored 的 Claude Code 指纹头兜底注入 |
| `whitelist.ts` | 出口域名白名单 |
| `protocol.ts` | WS 消息类型与常量 |
| `config.ts` | `NodeConfigStore`：配置读写、平台 URL 解析 |
| `crypto.ts` | 配置敏感字段加密 |
| `credentials.ts` | 本机凭证探测、JWT 元数据解析、脱敏 |
| `cli.ts` | `1dayapi-node` 命令行 |
| `service.ts` | systemd user 服务管理、`doctor` |
| `version.ts` | `NODE_VERSION = "0.1.0"` |

依赖只有 `fastify` 和 `ws`。

## 3. 配置与加密

- 路径：`PROVIDER_CONFIG_PATH`，默认 `~/.config/1dayapi-provider-node/config.json`（文件 0600、目录 0700，读取时会重新 chmod）。
- 字段：`nodeId`（首启生成 UUID，解绑后保留）、`nodeVersion`、`providerId`、`providerNodeSecret`、
  `platformWsUrl`、`platformHttpUrl`、`boundAt`。
- `providerNodeSecret` 和结构化敏感字段 `proxies` / `proxyAssignments` / `proxyTeams` / `proxyAccounts` 加密落盘。主钥文件同目录 `config.key`（32 随机字节 base64url，0600），
  AES 密钥 = `sha256(文件内容)`。
- 密文格式：`enc:v1:` + `base64url(iv).base64url(tag).base64url(ciphertext)`。
  平台侧（v3 存于 `accounts.credential_enc`）同样用 `enc:v1:` 前缀但格式是 `base64(iv‖ct‖tag)`，**两者不兼容**，
  不能互相解密（两者本就是独立存储，目前不影响功能，但前缀相同容易误导）。

平台 URL 解析：

- WS：`PROVIDER_PLATFORM_WS_URL` > 配置中的 `platformWsUrl`（来自绑定响应）> `ws://localhost:8401/internal/provider/connect`。
- HTTP：`PROVIDER_PLATFORM_HTTP_URL` > 配置中的 `platformHttpUrl`（绑定时所用地址）> 由 WS URL 推导（`ws→http`、去掉 `/internal/provider/connect`）。
- 生产号商需要显式指定平台地址（环境变量或绑定时的 `platformBindUrl`），否则默认连本机 8401。

## 4. 本地控制台 API（`server.ts`）

监听 `PROVIDER_CONSOLE_HOST:PROVIDER_CONSOLE_PORT`（默认 `127.0.0.1:16889`）。

两道全局防护：

- **Host 头白名单**（防 DNS rebinding）：只接受 `127.0.0.1`、`localhost`、`[::1]`、`::1`，否则 403 `forbidden_host`。
- **写请求只接受本机来源**：非 GET 请求的对端地址必须是回环（即使 `PROVIDER_CONSOLE_HOST=0.0.0.0`），否则 403 `loopback_only`——bind/unbind/authorize-local 交出节点身份与本机 OAuth 令牌。
- **CSRF**：所有非 GET/HEAD/OPTIONS 请求必须带 `x-1dayapi-csrf: <token>`，token 是进程启动时随机生成的，
  通过 `GET /api/status` 的响应头 `x-csrf-token` 下发；否则 403 `csrf_token_invalid`。

| 方法 路径 | 说明 |
|---|---|
| `GET /` | 控制台页面 |
| `GET /api/status` | `{nodeId, nodeVersion, bound, providerId, boundAt, bridge:{state,...}, officialExit:{activeSessions}, credentials, credentialsSource, runtime, time}`；已绑定时实时拉平台凭证列表（3s 超时），失败用缓存（`credentialsSource: platform|cache|none`） |
| `POST /api/platform/bind` | `{bindingCode, platformBindUrl?}`：`bindingCode` 必须以 `bind_` 开头；调平台 `/internal/provider/bind`，成功后保存绑定并立即重连 WS。错误：400 `invalid_binding_code`、502 `platform_unreachable`、平台错误码透传 |
| `POST /api/platform/unbind` | 通知平台解绑（失败也继续），清空本地绑定并重连（变为未绑定状态）。返回 `{ok, platformAcknowledged, platformError}` |
| `GET /api/oauth/local/detect` | 探测本机凭证，返回脱敏列表 |
| `POST /api/platform/credentials/authorize-local` | `{vendor?|vendors?}`（默认 anthropic+openai）：探测到的凭证逐个上传平台，返回 `{data:[{vendor,credentialBindingId}], errors}`；未绑定 409 `not_bound` |
| `POST /api/platform/credentials/authorize-token` | `{vendor: "anthropic"|"openai", tokenJson}`：手动粘贴 token（字符串或对象，兼容 `accessToken/access_token`、`expires_in` 等写法）并上传；400 `invalid_vendor`、409 `not_bound` |

节点 → 平台的 HTTP 调用统一带 `x-provider-node-id` / `x-provider-node-secret`，默认 10s 超时。

## 5. 本机凭证探测（`credentials.ts`）

| vendor | 默认路径（可用环境变量覆盖） | 读取字段 |
|---|---|---|
| anthropic | `~/.claude/.credentials.json`（`PROVIDER_CLAUDE_CREDENTIALS_PATH`） | `claudeAiOauth.{accessToken, refreshToken, expiresAt, scopes, subscriptionType}` |
| openai | `~/.codex/auth.json`（`PROVIDER_CODEX_AUTH_PATH`） | `tokens.{access_token, id_token, refresh_token}`；套餐与邮箱取自 JWT 声明 |

JWT 只做 base64 解码取展示用元数据，不验签。脱敏显示为 `前 8 位…后 4 位`。
注意：上传的是**订阅 OAuth token**，平台用它以 `Bearer` 方式调用官方 API（合规问题见 `issues-and-decisions.md`）。

## 6. 平台桥接（`bridge.ts`）

状态：`disabled`（未绑定）→ `connecting` → `connected` → `ready`；断线 → `backing_off`；
收到抑制重连的关闭原因 → `suppressed`。

- 连接：WS 握手头带节点凭证；open 后发 `provider.hello {nodeId, providerId, nodeVersion,
  capabilities:["official_exit","http_egress","cc_worker","team_isolation_v1"], acceptingSessions}`；专属实例还报告 `runtimeTeamId`，重连时报告现存 `isolatedContexts`。
- `platform.ready`：nodeId 不匹配则忽略；匹配则进入 `ready` 并启动心跳。
- 心跳：每 10s `provider.heartbeat {nodeId, inFlight, healthy:true, officialExit:{activeSessions}, acceptingSessions, proxies[], assignments{}}`。
  `healthy` 恒为 true，从不发 `riskState`。
- `official_exit`、`http_egress`、`cc_worker` 各走对应管理器。`isolation.reset` 强制撤销旧阶段的排队、进程、HTTP 出口和挂起工具，并回复确认；不能用保留挂起工具的普通 close 代替。
- 重连：`delay = min(30s, 2s × 2^min(n,9))`，±25% 抖动，`n` 每 10 次归零。
- 抑制重连：关闭原因属于 `invalid_provider_secret / node_paused / node_revoked / provider_identity_mismatch`
  时停止重连，直到重新绑定/解绑（`reconnectNow`）。
- 断线与重连由既有链路保留机制处理；对组织隔离上下文，平台以持久代次判定有效性，重连时撤销旧阶段，不能把旧队列或迟到结果写入新阶段。
- SIGTERM 会进入 `bridge.beginDrain()`，心跳停止接新会话，按 `NODE_DRAIN_MS` 等待在途任务后退出。

保活：记录最后一帧（消息/ping/pong）时间，90 s 无平台帧即 `terminate()` 重连（平台每 30 s ping）；`reconnectNow()` 对尚在 CONNECTING 的 socket 用 `terminate()` 并保留一个空的 error 监听（ws 在 CONNECTING 阶段 close 会抛 error，无人监听会把整个进程打死）。

`cc-worker`：提示词经 **stdin** 交给 `claude -p`（argv 对本机所有用户可见且单参数上限 128 KiB）；子进程 `detached` 自成进程组，超时/关闭时杀整棵树；子进程环境去掉 `NO_PROXY`/`ALL_PROXY`；排队中的会话也能被平台 close 撤回；桥启动期间被关闭的会话不再拉起进程。

## 7. official-exit（`official-exit.ts`）

处理 `official_exit.open` 的校验顺序（失败即回 `open_response {accepted:false, reasonCode}`）：

1. `nodeId` / `providerId` 与本机绑定一致 → 否则 `node_identity_mismatch`
2. 未在排空 → 否则 `node_draining`
3. `targetHost` 在白名单 → 否则 `target_not_allowed`
4. 端口为 1–65535 的整数 → 否则 `invalid_target_port`
5. `sessionId` 未占用 → 否则 `duplicate_session`

然后 `net.connect(targetHost, targetPort)`：

- 连接成功才回 `open_response {accepted:true}`，并取消超时。
- 连接超时 = `min(deadlineMs, 60s)`，无 `deadlineMs` 时 15s。v3 起平台发相对毫秒 `deadlineMs=15000`；平台只等 4s 的 open_response。
- 上行数据：`official_exit.data` 的 base64 解码后写 socket（空包或 >4MiB 丢弃）。
- 下行数据：socket 每个 data 事件发一条 `official_exit.data {seq}`（seq 从 1 递增）。
- 结束：对端关闭 → `official_exit.close {reasonCode:"target_closed"}`；出错 → `official_exit.error
  {errorCode, retryable:true}`；平台发 close → `socket.end()`。
- 没有流控/背压：下行数据全部立即发送，依赖 WS 缓冲。

白名单（`whitelist.ts`，18 项，`*.` 匹配本域及子域，否则精确匹配，大小写与末尾点归一）：

```
*.openai.com  *.chatgpt.com  *.anthropic.com  *.claude.com  *.claude.ai  *.aliyuncs.com
*.bigmodel.cn  *.z.ai  *.kimi.com  *.moonshot.ai  *.moonshot.cn  *.minimax.io  *.minimaxi.com
*.deepseek.com  generativelanguage.googleapis.com  *.x.ai  *.grok.com  ark.cn-beijing.volces.com
```

`PROVIDER_OFFICIAL_EXIT_ALLOWED_HOSTS`（逗号分隔）只能**追加**；平台无法远程修改。

## 8. CLI（`1dayapi-node`，`cli.ts`）

CLI 通过本地控制台 API 工作（`PROVIDER_CONSOLE_URL`，默认 `http://127.0.0.1:16889`），写操作前自动取 CSRF token。

| 命令 | 说明 |
|---|---|
| `serve` | 前台运行守护进程 |
| `bind --value bind_...` | 兑换绑定码 |
| `status` / `list` | 状态 / 平台上的凭证列表（JSON；v3 起未审核的凭证状态为 `pending`） |
| `import [--vendor anthropic|openai]` | 探测并上传本机凭证 |
| `install-service` / `uninstall-service` | 写入/删除 `~/.config/systemd/user/1dayapi-provider-node.service` |
| `start` / `stop` / `restart` | `systemctl --user`；start/restart 等待控制台就绪（`PROVIDER_CONSOLE_READY_TIMEOUT`，默认 15s） |
| `logs` | `journalctl --user-unit ... -f` |
| `doctor` | 检查运行时（必须是 Bun）、配置、wrapper、systemd、unit、Docker、控制台可达 |
| `version` / `help` | |

systemd unit：`Type=simple`，`ExecStart=<PROVIDER_NODE_BIN 或 /usr/local/bin/1dayapi-node> serve`，
`Restart=always`、`RestartSec=5`，`WantedBy=default.target`。无 systemd 的环境（WSL/容器）只写文件并提示手动步骤；
登出保活需 `loginctl enable-linger`。

## 9. 安装与分发

| 方式 | 说明 |
|---|---|
| `packaging/install.sh` | 仅 Linux x64/arm64。无 Node 20+ 时自动安装（Debian/Ubuntu 用 NodeSource，其他用官方 tarball）。`--local <repo>` 用 `pnpm deploy --prod` 从本仓库安装；否则从 `1DAYAPI_NODE_DIST`（默认 `https://releases.1dayapi.com/provider-node`）下载 `v${1DAYAPI_NODE_VERSION:-0.1.0}` 并校验 `checksums.txt`。安装到 `/opt/1dayapi-provider-node`，wrapper 到 `/usr/local/bin/1dayapi-node`；`PREFIX` 可沙箱试装 |
| `packaging/linux/1dayapi-node` | POSIX sh 启动器：依次用 `PROVIDER_NODE_NODE`、安装时记录的 `node-path`、PATH 找 Node 20+，找不到退出 70 |
| `Dockerfile` + `compose.yaml` | node:22 多阶段构建；容器内控制台监听 0.0.0.0，compose 只映射到宿主 127.0.0.1:16889；配置卷 `/data`；默认连 `ws://host.docker.internal:8401/...` |

**发布渠道尚不存在**：`releases.1dayapi.com` 未部署，release tarball / checksums 没有构建流程，
`Dockerfile` 已去掉对已删除 `vendor/` 目录的 COPY（2026-10-15），镜像可以构建。

## 10. 未实现（相对原站）

风险状态机与冷却、排空、凭证镜像更新、自动升级、设备码/授权码 OAuth 流程（只支持导入本机文件和粘贴 token）、
binary_v1/credit_v1、Grok/Cursor/Jimeng 等 vendor、macOS/Windows 安装。
