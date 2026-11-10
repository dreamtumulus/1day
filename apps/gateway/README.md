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
| `GATEWAY_MAX_ATTEMPTS` | `3` | 每请求最多尝试的上游账户数（仅无会话作用域的请求） |
| `GATEWAY_MAX_TOTAL_ATTEMPTS` | `6` | 每请求跨所有账户 / 组织的上游尝试总数上限（含组织绑定会话） |
| `GATEWAY_RETRY_DEADLINE_MS` | `120000` | 请求开始后超过该时长不再发起新的重试 |
| `GATEWAY_SAME_FAILURE_STREAK` | `3` | 连续 K 个账户同类失败 → 视为请求级 / 上游级：原样返回上游错误，不再冷却账户、不切组织 |
| `AUTH_FAILURE_THRESHOLD` / `AUTH_FAILURE_WINDOW_MS` | `3` / `600000` | 直连 401/403 认证失败、worker 引用文本信号：窗口内 N 次才置 `status=error` |
| `DIRECT_AUTH_COOLDOWN_MS` | `60000` | 未达阈值的直连认证失败的冷却时长 |
| `LEASE_RENEW_TRIES` / `LEASE_RENEW_BACKOFF_MS` | `3` / `250` | 预算 / 会话 / 账户租约续期失败的重试次数与首次退避（翻倍） |
| `CLIENT_WRITE_STALL_MS` | `30000` | 客户端不读流多久后放弃该流（已产出部分照常结算） |
| `OAUTH_REFRESH_TIMEOUT_MS` | `20000` | token 端点调用自身的超时（不受客户端断开影响） |
| `SETTLEMENT_REPLAY_MAX_ATTEMPTS` / `SETTLEMENT_REPLAY_MIN_INTERVAL_MS` | `5` / `10000` | 结算日志重放失败 N 次（每次计数至少间隔）后移入 `settlement-journal/dead-letter/` |
| `METRICS_MAX_SERIES_PER_NAME` / `METRICS_MAX_KEYS` | `100` / `2000` | 计数器标签基数上限，溢出进 `{other=1}` |
| `UPSTREAM_TIMEOUT_MS` | `300000` | 直连上游超时 |
| `PROOF_SECRET` | 随机 | TEE 桩签名密钥（仅请求带 `x-1dayapi-tee-proof-mode` 时输出证明） |
| `DATA_DIR` / `DB_PATH` / `PROVIDER_CRED_KEY` / `INTERNAL_TOKEN` | `data/` 下文件 | 必须与 console 一致 |
| `PROVIDER_TUNNEL_TARGET_HOST` / `_PORT` | 空 | 开发用：隧道目标指向本地明文 mock |
| `LOG_LEVEL` | `info` | |

## 端点

`/v1/models`、`/v1/models/pricing`、`/v1/chat/completions`、`/v1/messages`、`/v1/messages/count_tokens`、`/v1/responses`
（均可不带 `/v1` 前缀）；图片 / 视频返回 501；`/health`（公开，仅 `{status, service, time}`）；
`/internal/metrics`（需 `x-1dayapi-internal: $INTERNAL_TOKEN`，返回 `{status, service, time, counters}`）。
