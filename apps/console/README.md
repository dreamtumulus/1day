# @1dayapi/console

控制台 API（三角色）+ 会话登录 + 号商节点 WS 控制面与隧道管理器。Fastify v5，数据层用 `@1dayapi/core`（与网关共享同一个 SQLite）。
契约：`docs/v3-design.md`；接口细节：`docs/console-api.md`；节点协议：`docs/provider-protocol.md`。

## 运行

```bash
pnpm install && pnpm build                 # core / catalog 的 dist 必须先有
pnpm --filter @1dayapi/console seed        # 可选：admin / demo consumer($50 + API Key) / demo provider + 两个 mock 上游账户
pnpm --filter @1dayapi/console dev         # tsx watch，:8401；生产 pnpm --filter @1dayapi/console start
```

首次打开库时自动执行迁移（v2 库会被迁移，旧表改名 `legacy_v2_*` 保留）。没有 active 管理员时自动创建一个，
登录密钥写入 `data/admin-key.txt`（0600），日志只提示文件位置。

## 配置

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` / `HOST` | `8401` / `0.0.0.0` | 生产绑 `127.0.0.1`，由 nginx 反代 |
| `CONSOLE_CORS_ORIGINS` | `http://localhost:8402,http://127.0.0.1:8402` | 允许的前端源 |
| `COOKIE_SECURE` | 关 | `=1` 时会话 cookie 加 `Secure` |
| `TRUST_PROXY` | 关 | `=1` 时信任 `X-Forwarded-For`（nginx 后必开） |
| `PLATFORM_WS_URL` | 按 Host / `X-Forwarded-Proto` 推导 | 绑定响应里给节点的 WS 地址（生产建议显式设 `wss://…/internal/provider/connect`） |
| `DATA_DIR` / `DB_PATH` / `PROVIDER_CRED_KEY` / `INTERNAL_TOKEN` | `data/` 下文件 | 必须与网关一致 |
| `LOG_LEVEL` | `info` | |

## 端点概览

- 公共：`/health`、`POST /auth/login|logout`、`GET /auth/me`、`GET /api/models`、`/api/models/pricing`、`/api/site`。
- 用户（consumer、admin）：`/api/user/*`：概览、可用分组、API Key 增删改查与查看明文、用量与统计、流水、兑换码。
- 号商：`/api/provider/*`：概览、节点与绑定码、上游账户提交 / 修改 / 删除、收益明细、结算流水。
- 管理员：`/api/admin/*`：仪表盘、用户（建号发登录密钥 / 调账 / 结算 / 重置密钥）、Key、分组、上游账户（审核 / 测试）、模型定价、兑换码、用量、节点、设置。
- 内部：`/internal/provider/*` 与 WS `/internal/provider/connect`（节点凭证头）；`/internal/tunnel/*`（回环 + 内部令牌，网关专用）。

鉴权只认会话 cookie `oneday_session`。错误格式 `{"error":{"code","message","type"}}`。

## 脚本

- `scripts/seed.mjs [--mock http://127.0.0.1:19001]`：开发种子，明文只打印一次。
- `scripts/issue-key.mjs --role admin|consumer|provider --name "名称"`：建用户并打印登录密钥；`--reset <userId>` 重置登录密钥。
- `scripts/fake-node.mjs --bind-code bind_… [--platform http://127.0.0.1:8401]`：测试用假节点。
