# @1dayapi/provider-node

1DayAPI 供应端节点守护进程。协议契约见 `docs/provider-protocol.md`。

- 本地控制台：`http://127.0.0.1:16889`（Host 头白名单 + `x-1dayapi-csrf` 写保护）
- 平台桥接：出站 WS 到 `platformWsUrl`（默认 `ws://localhost:8401/internal/provider/connect`，
  `PROVIDER_PLATFORM_WS_URL` 覆盖），hello → platform.ready → 10s 心跳，指数退避重连
- official-exit：裸 TCP 中继，目标域名白名单强制（`PROVIDER_OFFICIAL_EXIT_ALLOWED_HOSTS` 追加）
- http-egress（协议 v2）：节点侧 Bun fetch HTTP 出口，强制代理池（池空/全死即
  `no_proxy_available`，绝不直连），Claude Code 指纹头兜底注入；代理池来自平台
  `proxies.set` 推送或本地配置 `proxies`，粘性分配 `proxyAssignments`，每 5 分钟探活并
  随心跳上报（URL 脱敏、id=sha256(url)[:12]）
- 组织隔离：`team_isolation_v1` 能力、代理组织与账号白名单、固定账号设备身份、对话阶段校验。
  隔离账号只能使用平台指定的固定代理，不能退回全节点代理池。每个实测出口 IP 默认两号，常规容量不足时最多三号，均须同组织。
- 配置：`~/.config/1dayapi-provider-node/config.json`（0600），敏感字段 `enc:v1:` AES-256-GCM
  （`providerNodeSecret`、`proxies`、`proxyAssignments`、`proxyTeams`、`proxyAccounts`），
  主钥 `config.key` 自动生成（0600），`PROVIDER_CONFIG_PATH` 可改路径

## 运行时：必须 Bun

v2 出口依赖 Bun 的 TLS 指纹（与 Claude Code 同为 Bun/BoringSSL）。**Node 下 `serve`
直接拒绝启动**；`NODE_ALLOW_NODE_RUNTIME=1` 仅为本地开发逃生门（日志大字警告，指纹退化）。
安装脚本固定装 Bun 1.4.3（与 CC 2.1.300 同版本族），已装且版本一致则跳过。

## 安装

**一键脚本（Linux x64/arm64）**

```bash
curl -fsSL https://releases.1dayapi.com/provider-node/install.sh | bash
1dayapi-node install-service && 1dayapi-node restart
```

环境变量：`1DAYAPI_NODE_DIST`（发布地址）、`1DAYAPI_NODE_VERSION`、`PREFIX`（安装前缀，
默认系统目录 `/opt/1dayapi-provider-node` + `/usr/local/bin`）、`1DAYAPI_NODE_BUNDLE_URL`
（平台单文件 bundle，同 `--bundle-url`，如 `…/internal/provider/bundle?code=bind_...`）。
没有 Bun 1.4.3 时自动安装（`curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.3"`，
装到当前用户 `~/.bun`）。macOS 暂不支持。

**安装后自检（worker 隔离）**：`install.sh` 最后一步 `verify_worker_isolation` 会以 `ccworker` 用户在
`/var/lib/1dayapi-cc-worker/cc-sessions/` 下的私有目录里跑一次 `claude --version`，打印
`worker isolation self-test PASSED/FAILED`；节点进程启动时也做同样的自检（日志 `[cc-worker] workers run as …` /
`SELF-TEST FAILED …`），失败则该节点拒绝所有 cc_worker 会话（原因码 `self_test_failed: …`，网关侧 502 文本可见），
不会把问题留到客户流量上。常见失败原因：节点数据目录在 `/root` 下且 `/root` 为 0700（2026-10-16 事故，已把 worker
根目录默认移到 `/var/lib/1dayapi-cc-worker`）、claude 二进制在 `/root/.bun` 下不可执行（脚本会复制到 `/opt/claude/claude`）、
`ccworker` 用户不存在。详见 docs/operations.md §6 "新增 worker 节点"。

**本地仓库安装（开发）**

```bash
pnpm install && pnpm --filter @1dayapi/provider-node build
sudo bash apps/provider-node/packaging/install.sh --local /path/to/1dayAPI.com
# 免污染试装：PREFIX=/tmp/1dayapi-root bash apps/provider-node/packaging/install.sh --local .
```

**Docker**

```bash
docker compose -f apps/provider-node/compose.yaml up -d --build
# 控制台 http://127.0.0.1:16889，配置持久化在 provider-node-data 卷（/data）
```

**源码直接跑**

```bash
pnpm --filter @1dayapi/provider-node build
bun apps/provider-node/dist/cli.js serve   # 或 pnpm --filter @1dayapi/provider-node start
```

## CLI

| 命令 | 说明 |
|---|---|
| `1dayapi-node serve` | 前台运行守护进程（控制台 + WS 桥接） |
| `1dayapi-node bind --value bind_...` | 兑换平台绑定码 |
| `1dayapi-node status` | 节点/桥接状态（JSON） |
| `1dayapi-node list` | 已上传凭证列表 |
| `1dayapi-node import [--vendor openai]` | 探测并导入本机 CLI 凭证 |
| `1dayapi-node install-service` | 写 `~/.config/systemd/user/1dayapi-provider-node.service` 并 enable |
| `1dayapi-node uninstall-service` | disable 并删除 unit |
| `1dayapi-node start/stop/restart` | systemctl --user 控制；restart 后等控制台就绪 |
| `1dayapi-node logs` | `journalctl --user-unit -f` |
| `1dayapi-node doctor` | 检查 Node/配置/systemd/Docker/控制台 |
| `1dayapi-node version` | 版本 |

## systemd 服务

`install-service` 生成 user unit：`ExecStart=/usr/local/bin/1dayapi-node serve`，
`Restart=always RestartSec=5`，`WantedBy=default.target`。登出后保活：
`sudo loginctl enable-linger $USER`。无 systemd 的环境（WSL/容器）用 `serve` 前台跑或 Docker。

每组织独立服务使用 [`packaging/linux/1dayapi-team@.service`](packaging/linux/1dayapi-team@.service)：
`PROVIDER_TEAM_ID` 限定组织，各实例独立系统身份、状态目录、节点配置和控制台端口。安装与限制见
[`TEAM-RUNTIMES.md`](packaging/linux/TEAM-RUNTIMES.md)。共享实例不设置该变量时仍执行协议与状态隔离，不能宣称为独立操作系统隔离。

节点升级保留已有 `config.json`、`config.key`、账号目录和设备身份，只替换 bundle 并按服务排空流程重启。
连上平台后应报告 `team_isolation_v1`；未升级节点不会收到新的隔离任务或其代理配置。

## 说明

- `ws` / `@types/ws` 使用 registry semver（`^8.20.0` / `^8.18.1`）；`Dockerfile` 不再引用已删除的 `vendor/` 目录，可正常构建。
- 新上传的 Claude 订阅凭据经实际 token 验证、组织核验和代理容量预留后固定到当前节点；不能通过旧上传入口创建无组织、无固定代理的订阅供给。其他供给类型仍按其审核规则处理。Codex 凭证会一并上传 ChatGPT `accountId`。
- **运行时**：v2 起必须 Bun（>= 1.4，安装脚本固定 1.4.3）；`tsc` build 仍供 CI，`engines.node`
  仅为构建/工具链保留。`Dockerfile`（node:22 基底）尚未适配 Bun 运行时，容器部署待跟进。
- Docker 容器内控制台监听 `0.0.0.0`（`PROVIDER_CONSOLE_HOST`），宿主机映射到 127.0.0.1；
  Host 头白名单仍然生效。
