# 1DayAPI 鉴权体系（v3）

> 权威契约：[`v3-design.md`](./v3-design.md) §2、§4。本文是鉴权部分的说明。
> 相比 Auth v2：**登录方式不变**（密钥登录 + 会话 cookie）；删除自助签发、推荐码、`/api/topup`；
> 推理改为只认 API Key（`sk-1d-…`）；控制台不再接受 `Authorization: Bearer 1dk_…` 直调。

## 1. 两种密钥

| 密钥 | 格式 | 用途 | 谁签发 | 存储 |
|---|---|---|---|---|
| 登录密钥 | `1dk_<role>_<48 hex>` | 登录控制台 | 管理员（创建用户 / 重置）、首启自动生成的管理员、CLI | `users.login_key_hash`（sha256）+ 前 16 位预览；明文只出现一次 |
| API Key | `sk-1d-<48 hex>` | 调用推理网关 | 用户在控制台自建 | `api_keys.key_hash`（sha256）+ `key_enc`（加密，供用户再次查看）+ 预览 `sk-1d-xxxx…abcd` |

- 一个登录密钥 = 一个账户 = 一个余额；一个账户下可以有多把 API Key（上限 `max_keys_per_user`，默认 50），每把单独设分组、额度、过期、启停。
- 没有注册入口：`/register`、`/referral` 前端只做重定向；`POST /api/keys/self-issue` 已删除。

## 2. 角色

| 角色 | 控制台能力 | 推理 |
|---|---|---|
| admin | 全部管理端点 + 用户端点（管理自己的 Key） | ✅（用自己的 API Key） |
| consumer | 用户端点 | ✅ |
| provider | 号商端点 | ❌ 403 `role_not_permitted` |
| ops（账号管理员，2026-10-22） | 只有账号池：`GET /api/admin/accounts`、`PATCH /api/admin/accounts/:id`（**仅 `status`**，带其他字段 403）、`window` / `profile` / `test` 探测、上号 `POST /api/admin/accounts/onboard` + 作业查询、重新授权 `POST /api/admin/accounts/:id/reauth`、`GET /api/admin/groups`、`GET /api/admin/nodes`、`GET /api/admin/nodes/:id/proxies`（只返回脱敏选择器形态）。用户 / Key / 财务 / 分组写 / 定价 / 兑换码 / 设置 / 节点部署 / 删号一律 403 | ❌ 403 `role_not_permitted` |

ops 的定位：盯账号死活，掉授权时手动补齐（控制台「账号池」行操作「重新授权」，见 `onboarding.md` §11），不碰别的。
登录密钥前缀 `1dk_ops_…`；管理员在「用户」页选角色「账号管理员」开通，或 `issue-key.mjs --role ops`。

## 3. 控制台登录（会话）

- `POST /auth/login {key}` → 按哈希查 `users`；不存在 401 `invalid_login_key`；被禁用 401 `user_disabled`；
  同一 IP 10 分钟内失败 ≥ 20 次 → 429 `too_many_attempts`（部署在 nginx 后需 `TRUST_PROXY=127.0.0.1,::1`，并由 nginx 仅信任 Cloudflare 网段后覆盖 XFF 才能按真实 IP 计）。
- 成功：写 `user_sessions`（随机 32 字节 hex，7 天），下发 `oneday_session=<token>; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`，
  `COOKIE_SECURE=1` 时加 `Secure`；返回 `{data: {id, role, name, status, keyPreview, balanceUsd}}`，`GET /auth/me` 同形状。
- `POST /auth/logout` 删除会话。会话随用户禁用、登录密钥重置而立即失效；过期会话每小时清理。

## 4. 推理鉴权

见 `gateway.md` §2：Key 存在 → Key 启用且未过期 → 用户启用且非号商 → 分组可用 → 余额 > 0 → 额度未用尽。

**兼容旧密钥**：v2 → v3 迁移时，每个 consumer/admin 的旧登录密钥都生成了一把 `name='legacy'` 的 API Key，
**哈希与旧密钥相同**，所以客户端里配置的 `1dk_consumer_…` 仍可调用推理（同时它也仍是该用户的登录密钥）。
legacy Key 没有 `key_enc`，控制台不能再次显示。建议用户改用新建的 `sk-1d-` Key 后停用 legacy Key。

## 5. 运维

- 首次启动 console 时若没有 active 管理员，自动创建 `initial-admin`，登录密钥写入 `data/admin-key.txt`（0600），日志只提示文件位置。
- CLI（直接写库，需与服务相同的 `DATA_DIR`）：
  - `node apps/console/scripts/issue-key.mjs --role provider --name "张三"`：建用户并打印登录密钥。
  - `node apps/console/scripts/issue-key.mjs --reset <userId>`：重置登录密钥（清会话）。
- 开发种子：`pnpm --filter @1dayapi/console seed`，见 `development.md`。

## 6. 错误码

`unauthorized`、`invalid_login_key`、`user_disabled`（401）、`role_not_permitted`（403）、`too_many_attempts`（429）；
网关侧 `invalid_api_key`、`key_disabled`、`key_expired`、`user_disabled`（401）等，完整列表见 `errors.md`。

## 7. 上游账号 OAuth 凭证生命周期（订阅账号供给）

> 账户体系契约见 `v3-design.md` §5；云端会话路径见 `ccr-supply.md`。
> 非浏览器接入的完整请求与 Bridge/SI 流程见 `onboarding.md` §2、§9。

- 凭证形态：`{accessToken, refreshToken?, expiresAt?, accountId?}`，加密入库（`enc:v1:`）。
- **接入方式（2026-10-18 修订）**：sessionKey 可直接作为 Bearer 调
  `POST https://api.anthropic.com/v1/oauth/{org}/authorize`，再从 `redirect_uri` 取 code 并调用
  `/v1/oauth/token`。授权码 + PKCE 全程不需要打开同意页或浏览器；服务器浏览器 bot 已删除（2026-10-18），全部请求经账号绑定的节点代理发出。
- **scope 必须按用途分流**：Chrome Extension 用 `user:profile user:inference user:chat`；
  Claude Code runner 用 `user:ccr_inference user:file_upload`（但不能用于 `/chrome`）；
  Bridge environment/SI 用 `user:sessions:claude_code user:file_upload`；官方 Remote Control 全量接入再加
  `user:profile user:inference user:mcp_servers`。不同 client、redirect_uri、scope 不得混用。
- **令牌参数（Claude）**：access_token 有效期 28800s；refresh_token 长期有效、刷新即轮换；
  刷新端点 `https://platform.claude.com/v1/oauth/token`，无会话新鲜度要求，可长期自动保活。
- **刷新时机**：`expiresAt` 距今 < 5 分钟时调度前刷新，成功加密回写，失败标 `error`（见 `gateway.md`）。
- **健康巡检**：`POST /api/oauth/validate`（Bearer，免费）。注意 scope 门槛：
  `user:profile / user:office / user:ccr_inference / user:chrome_bridge` 之一才返回 200，
  最小 scope（`user:inference`）令牌返回 403 属预期，不视为故障；authorize 的
  `session_stale_relogin` 表示 SK 新鲜度不足，不等同于 token 无效。
- **窗口配额巡检**（CCR 路径）：`GET /api/oauth/usage`，回写账户窗口水位，见 `ccr-supply.md` §7。
- **Bridge/SI 凭据**：environment 注册另返回 `environment_secret`（30 天）；work.secret 是 Base64URL JSON，
  解码后取 `session_ingress_token` 与 `api_base_url` 用于 `worker/register`、ack 和 heartbeat，见 `onboarding.md` §9。
