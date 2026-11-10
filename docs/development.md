# 开发指南（v3 本地开发与联调）

> 先读 [`README.md`](./README.md)（文档地图）与 [`architecture.md`](./architecture.md)。
> 契约见 [`v3-design.md`](./v3-design.md)。

## 1. 前置条件

- **Node.js >= 22**（`node:sqlite`）。provider-node 的安装脚本 / `doctor` 仍按 >= 20 校验，见 `issues-and-decisions.md`。
- **pnpm 9**。
- 仓库 **2026-10-17 起纳入本地 git**（`main` 分支，无远端）；`.gitignore` 排除 `node_modules/`、`dist/`、`data/`（库与密钥文件）、
  `secrets/`、`docs/deployment/`（含明文访问信息）、`recon/`（211 MB 研究资料，内含第三方仓库）。生产部署不走 git：仍是 rsync
  工作树到服务器后 `pnpm build`（operations.md §4），所以**提交前先确认工作树就是线上跑的版本**。
- WSL 环境遵守 `/home/admin/AGENTS.md`：命令行网络操作绕过 Windows 宿主代理（`env -u http_proxy -u https_proxy …` 或 `curl --noproxy '*'`）。

## 2. 布局与端口

| 包 | 包名 | 角色 | 端口 |
|---|---|---|---|
| `packages/catalog` | `@1dayapi/catalog` | 内置模型目录与价目 | — |
| `packages/core` | `@1dayapi/core` | 共享库：DB + 迁移、加密、注册表、计价、调度、结算 | — |
| `apps/gateway` | `@1dayapi/gateway` | 推理网关 | 8400 |
| `apps/console` | `@1dayapi/console` | 控制台 API + 节点控制面 | 8401 |
| `apps/web` | `@1dayapi/web` | 前端（Vite dev server） | 8402 |
| `apps/provider-node` | `@1dayapi/provider-node` | 号商节点 | 本地控制台 127.0.0.1:16889 |
| `tests/e2e` | — | 端到端测试 | 18400 / 18401 / 19101 |

辅助脚本：`apps/gateway/scripts/mock-upstream.mjs`（mock 上游）、`apps/console/scripts/seed.mjs`（种子）、
`apps/console/scripts/issue-key.mjs`（建用户 / 重置登录密钥）、`apps/console/scripts/fake-node.mjs`（假节点）。

## 3. 安装与构建

```bash
pnpm install
pnpm build          # catalog → core → gateway / console / web / provider-node
```

gateway、console 和各脚本通过包导出引用 `@1dayapi/core` 与 `@1dayapi/catalog` 的 **`dist/`**：
改了 `packages/*` 后要重新 build 对应包（`pnpm --filter @1dayapi/core build`），`tsx watch` 不会替你编译依赖包。

## 4. 本地启动

```bash
# 1) mock 上游（127.0.0.1:19001）
node apps/gateway/scripts/mock-upstream.mjs &

# 2) 种子：admin / demo consumer（$50 + 一把 API Key）/ demo provider，
#    以及两个指向 mock 的上游账户（mock-anthropic、mock-openai，挂 default 组）
pnpm --filter @1dayapi/console seed          # 可加 -- --mock http://127.0.0.1:19001

# 3) 服务
pnpm dev:console    # :8401；首次打开库会执行迁移；无管理员时生成 data/admin-key.txt
pnpm dev:gateway    # :8400
pnpm dev:web        # :8402，代理 /api、/auth 到 :8401
```

seed 输出（明文只打印这一次）：

```
admin    login key : 1dk_admin_…
consumer login key : 1dk_consumer_… (balance $50)
consumer API key   : sk-1d-…
provider login key : 1dk_provider_…
mock accounts      : http://127.0.0.1:19001 (anthropic) / http://127.0.0.1:19001/v1 (openai) in group 'default'
```

seed 每次运行都会新建一组用户（mock 账户按名称去重）。

冒烟：

```bash
curl -s --noproxy '*' http://127.0.0.1:8400/v1/chat/completions \
  -H "Authorization: Bearer sk-1d-…" -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-5","messages":[{"role":"user","content":"hi"}]}'
```

浏览器打开 http://127.0.0.1:8402/login，粘贴登录密钥，进入 `/console`。

### mock 上游

- 路径：`/v1/messages`（Anthropic）、`/v1/chat/completions`、`/v1/responses`（也接受不带 `/v1` 的路径）。支持 SSE；
  Chat 流只在 `stream_options.include_usage` 时发 usage（与真实 OpenAI 一致）；请求带 tools 时返回工具调用。
- **按上游 API Key 注入故障**：`mock-429`（429 + `retry-after: 30`）、`mock-401`、`mock-500`、`mock-400`，其他任意 Key 成功。
  在控制台建一个 Key 为 `mock-429` 的账户即可观察故障转移与冷却。
- **订阅账号（Bearer 调用）**：`/v1/messages` 响应带 `anthropic-ratelimit-unified-5h/7d-*` 头（5h 42%、7d 10%）；Bearer 为 `mock-window-429`
  时返回 429 且 5h 窗口 `rejected`（reset +2h）。
- **云端会话（CCR）**：`POST /v1/environment_providers/cloud/create`、`POST /v1/code/sessions`、`POST|GET /v1/code/sessions/:id/events`、
  `GET /api/oauth/usage`（Bearer 为 `mock-window-full` 时报 100% 用量）。事件形状按 `ccr-supply.md` 附录 A 首抓结果。
  本地试：建一个 `type=oauth, platform=anthropic, executor=ccr, baseUrl=http://127.0.0.1:19001, accessToken=任意, orgUuid=任意` 的账户。
- `MOCK_PORT`（默认 19001）、`MOCK_HOST`（默认 127.0.0.1，勿暴露公网）。

### 节点隧道联调

```bash
# provider 登录控制台 → 节点 → 生成绑定码，然后：
node apps/console/scripts/fake-node.mjs --bind-code bind_… --platform http://127.0.0.1:8401
```

管理员再建一个 `route=node`、`ownerId=<号商>`、Base URL 指向 `http://127.0.0.1:19001` 的账户（http 不做 TLS），
请求就会经 fake-node 中继。fake-node 同时实现 v1 `official_exit`（裸 TCP）与 v2 `http_egress`（spec 行 → 本机 fetch → 头行 + body，
无代理池、无指纹，仅测试用）；不校验出口白名单；`FAKE_NODE_TARGET=host:port` 只影响 v1；`FAKE_NODE_HEARTBEAT_MS` 调心跳。

## 5. 测试

```bash
pnpm --filter @1dayapi/core test     # 单元测试：pure（白名单通配、q8、Base URL）、window（CCR 窗口过滤 / usage 解析）、migration3（临时库）
pnpm --filter @1dayapi/gateway test  # 单元测试：CCR 翻译层（折叠、工具模拟、事件 → SSE）
pnpm build && pnpm test:e2e          # 端到端：bash tests/e2e/run.sh
```

`tests/e2e/run.sh` 对每个 `*.test.mjs` 都起一套**全新隔离环境**（临时 `DATA_DIR`、mock :19101、console :18401、gateway :18400、seed），
跑完自动清理；端口可用 `E2E_GATEWAY_PORT`、`E2E_CONSOLE_PORT`、`E2E_MOCK_PORT` 改。它依赖已构建的 `dist/`。

| 套件 | 覆盖 |
|---|---|
| `gateway.test.mjs` | 协议矩阵（透传 / 互转 / 流式 / 工具）、include_usage 注入与剔除、Responses、未知模型、错误方言 |
| `ccr.test.mjs` | `executor=ccr` 账户：Messages / Chat 非流式与流式、模拟工具、能力矩阵 400、混合分组回落直连、窗口巡检与耗尽跳过、会话 API 401 置 error 并故障转移 |
| `console.test.mjs` | 登录与角色、分组与专属组、Key 创建 / 查看、白名单、倍率、故障转移与冷却、4xx 透传、号商提交—审核—收益—结算、兑换码、额度、禁用用户、自定义模型、设置 |
| `node.test.mjs` | 绑定码 → fake-node 上线 → 固定节点建账户（归属推导 / 平台节点）→ 经隧道（v2）非流式 / 流式 → 号商收益 → 节点离线 503 |
| `window.test.mjs` | 订阅窗口：响应头被动采样、429 按被拒窗口冷却、阈值停调、usage 探测、按会话 ID 的粘性 |

### 5.1 对线上发请求的规则

对生产环境做任何验证都只能打 `https://api.1dayapi.com` 并使用平台签发的 Key，让请求经网关和账号绑定的节点代理出去。
**绝不**用账号的 OAuth token 直连 Anthropic，会封号。详见 docs/operations.md §7.1。

## 6. 环境变量

### gateway

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` / `HOST` | `8400` / `0.0.0.0` | 生产绑 127.0.0.1 |
| `CONSOLE_BASE` | `http://127.0.0.1:8401` | 隧道管理器 |
| `GATEWAY_MAX_ATTEMPTS` | `3` | 每请求最多尝试账户数 |
| `UPSTREAM_TIMEOUT_MS` | `300000` | 等待上游响应头的超时（不限制流式响应体） |
| `PROOF_SECRET` | 随机 | TEE 桩 HMAC 密钥 |
| `PROVIDER_TUNNEL_TARGET_HOST` / `_PORT` | 空 | 开发用隧道目标覆盖 |
| `CCR_POLL_INTERVAL_MS` / `CCR_SESSION_TIMEOUT_MS` / `CCR_HTTP_TIMEOUT_MS` | `1000` / `600000` / `60000` | 云端会话：events 轮询间隔、整次会话上限、单次会话 API 调用超时 |
| `LOG_LEVEL` | `info` | |

### console

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` / `HOST` | `8401` / `0.0.0.0` | |
| `CONSOLE_CORS_ORIGINS` | `http://localhost:8402,http://127.0.0.1:8402` | 允许的前端源（带凭证） |
| `COOKIE_SECURE` | 关 | `=1` 时会话 cookie 加 `Secure`（生产 HTTPS 必开） |
| `TRUST_PROXY` | 关 | `=1` 时信任 `X-Forwarded-For`（nginx 后必开，登录限流才按真实 IP） |
| `PLATFORM_WS_URL` | 按 Host / `X-Forwarded-Proto` 推导 | 绑定响应里给节点的 WS 地址 |
| `CCR_WINDOW_POLL` | 开 | `=0` 关闭 CCR 窗口巡检定时器（e2e 用） |
| `LOG_LEVEL` | `info` | |

### 两者共用（必须一致）

| 变量 | 默认 | 说明 |
|---|---|---|
| `DATA_DIR` | `<repo>/data` | 数据目录 |
| `DB_PATH` | `$DATA_DIR/1dayapi.db` | 库文件 |
| `PROVIDER_CRED_KEY` | `$DATA_DIR/provider-cred.key` | 凭证加密主钥 |
| `INTERNAL_TOKEN` | `$DATA_DIR/internal.key` | 网关 → console 内部令牌 |
| `ALLOW_NEW_MASTER_KEY` | 未设 | `1` = 允许在库里已有密文时新建 / 更换主密钥（旧密文作废）。只用于一次启动；平时缺密钥文件会拒绝启动（operations.md §5.2） |
| `KEY_REVEAL_FRESH_SESSION_SEC` / `KEY_REVEAL_MAX_PER_HOUR` | `600` / `10` | 再次查看 API Key：多新的会话算刚登录 / 每用户每小时次数（auth.md §3b） |

已删除：`UPSTREAM_ANTHROPIC_*`、`UPSTREAM_OPENAI_*`、`PROVIDER_TUNNEL_ENABLED`、`SEED_BALANCE_USD`。

provider-node 的环境变量见 `provider-node.md`。

## 7. 容易踩的坑

- **改了 core / catalog 没重建**：服务仍跑旧 `dist`。
- **两个进程的 `DATA_DIR` 不一致**：网关读不到账户、内部令牌对不上（隧道 403 `forbidden`）、凭证解密失败。
- **丢了 `provider-cred.key`**：所有账户凭证与可查看的 API Key 都解不开（迁移时会跳过无法解密的账户）。
  2026-11-10 起库里已有密文而密钥文件不在时，进程拒绝启动（`MasterKeyError`，写明期望路径），不再悄悄生成一把新的；
  本地想重来就删掉整个 `data/`，或设 `ALLOW_NEW_MASTER_KEY=1` 启动一次。
- **测试默认数据目录**：没设 `DATA_DIR` 的测试会用 `<repo>/data`；`pnpm gate` 会给一个临时目录，直接 `pnpm -r test` 则会在检出目录里留下 `data/`。
- **粘性会话**：同一把 Key、同一模型、同一首条消息会固定到上次的账户；测试故障转移时换提示词。
- **新分组没挂账户**：Key 绑到没有账户的分组会得到 503 `no_available_account`。
- **模型必须在注册表里**：第三方中转提供的非目录模型要先在"模型定价"里添加并定价，否则 404 `model_not_found`。
- **Base URL 约定**：`protocol=openai` 的 Base URL 含 `/v1`（网关拼 `/chat/completions`）；`protocol=anthropic` 是站点根（网关拼 `/v1/messages`）。
- **运行中删库**：服务持有旧文件句柄，需重启服务。
- **控制台不收 Bearer**：脚本调控制台 API 需先 `POST /auth/login` 拿 cookie。

## 8. 部署

生产档案在 `docs/deployment/`（含明文凭据，仅本地保存）。生产目前仍是 v2；v3 发布要点见 `architecture.md` §3 与 `operations.md`。
