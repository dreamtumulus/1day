# @1dayapi/gateway

1dayAPI 推理网关：OpenAI（Chat Completions / Responses）与 Anthropic（Messages）兼容协议。Fastify v5，数据层用 `@1dayapi/core`。
详细说明见 `docs/gateway.md`，契约见 `docs/v3-design.md` §7。

## 运行

```bash
pnpm install && pnpm build
pnpm --filter @1dayapi/gateway dev      # tsx watch，:8400；生产 pnpm --filter @1dayapi/gateway start
node scripts/mock-upstream.mjs          # 本地 mock 上游 :19001（Key 为 mock-429/401/500/400 时注入故障）
```

推理只接受控制台创建的 API Key（`Authorization: Bearer sk-1d-…` 或 `x-api-key`）。上游一律在控制台以"上游账户"配置，
v2 的 `UPSTREAM_*` 环境变量直连兜底已删除。

## 配置

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` / `HOST` | `8400` / `0.0.0.0` | 生产绑 `127.0.0.1` |
| `CONSOLE_BASE` | `http://127.0.0.1:8401` | 隧道管理器（console）地址 |
| `GATEWAY_MAX_ATTEMPTS` | `3` | 每请求最多尝试的上游账户数 |
| `UPSTREAM_TIMEOUT_MS` | `300000` | 直连上游超时 |
| `PROOF_SECRET` | 随机 | TEE 桩签名密钥（仅请求带 `x-1dayapi-tee-proof-mode` 时输出证明） |
| `DATA_DIR` / `DB_PATH` / `PROVIDER_CRED_KEY` / `INTERNAL_TOKEN` | `data/` 下文件 | 必须与 console 一致 |
| `PROVIDER_TUNNEL_TARGET_HOST` / `_PORT` | 空 | 开发用：隧道目标指向本地明文 mock |
| `LOG_LEVEL` | `info` | |

## 端点

`/v1/models`、`/v1/models/pricing`、`/v1/chat/completions`、`/v1/messages`、`/v1/messages/count_tokens`、`/v1/responses`
（均可不带 `/v1` 前缀）；图片 / 视频返回 501；`/health`。
