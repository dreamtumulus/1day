# G10-B 取证 PoC：Bun 打包的 CC 2.1.312 是否尊重 `SSLKEYLOGFILE`（2026-11-01）

**结论（一句话）**：`SSLKEYLOGFILE` **不可用**（Bun 1.4.4 没有实现 keylog，文件根本没被创建）；但**不需要它** ——
二进制**尊重 `NODE_EXTRA_CA_CERTS`**，只要在受控出口上做 TLS 终结（自签 CA 注入），就能直接读到遥测请求的明文
header/body，9 个端点全部可见，`/api/event_logging/v2/batch` 的内容结构完全可读。

## 方法（`tests/e2e/cc-probe/telemetry-mitm.mjs`，全程不出本机）

1. 临时目录内 `openssl` 生成自签 CA + 叶子证书（SAN: `api.anthropic.com` / `*.anthropic.com` / `downloads.claude.ai` / `github.com` / `raw.githubusercontent.com`）。
2. 本机 HTTPS 服务（叶子证书）+ 本机 CONNECT 代理：只对 `*anthropic.com:443` 回 `200 Connection Established` 并把 socket 桥接到该 HTTPS 服务（TLS 终结）；其它主机一律 `502` 拒绝。
3. 启动真二进制：`ANTHROPIC_BASE_URL=http://127.0.0.1:<fake>`（假上游，`/v1/messages` 只走它）、`HTTPS_PROXY` 指向上面的代理、
   `NODE_EXTRA_CA_CERTS=<自签CA>`、`SSLKEYLOGFILE=<tmp>`；假 OAuth（`sk-ant-oat01-probe-fake-token`）、临时 HOME/`CLAUDE_CONFIG_DIR`。
4. 证据只记结构：URL、header（auth/token 类全 redact）、body 长度 + digest、`events[]` 的 `event_type` 与 `event_data` **键名**，不存任何值。

## 结果（`telemetry-structure.json`，exitCode 0）

- TLS 握手**成功**（`tlsRequests=9`），`SSLKEYLOGFILE` 文件 **不存在**（`fileExists=false, lines=0`）→ 前者可用、后者不可用。
- 8 次 CONNECT 全部是 `api.anthropic.com:443`（本次没有出现 github/downloads 的拉取，因为预热已在别的 gate 里被拒过）。
- 端点清单（这是官方 CC 自己发的，网关不应构造/补发）：
  | 方法 | 路径 | 备注 |
  |---|---|---|
  | POST | `/api/eval/sdk-zAZezfDKGoZuXXKe` | 远端 flag 拉取，body 键 `attributes, forcedVariations, forcedFeatures, url` |
  | GET | `/api/oauth/profile` | |
  | GET | `/api/claude_cli/bootstrap?entrypoint=sdk-cli&model=…` | **entrypoint 与 model 走 query** |
  | GET | `/api/claude_code_penguin_mode` / `/api/claude_code_grove` | 灰度/开关 |
  | GET | `/mcp-registry/v0/servers?version=latest&limit=100&visibility=…` | |
  | GET | `/api/oauth/organizations/<uuid>/referral/eligibility?campaign=claude_code_guest_pass` | |
  | POST | `/api/event_logging/v2/batch` ×2 | 3837 B / 3 events；260643 B / 123 events |
- 遥测请求身份：`user-agent: Bun/1.4.4`（**不是** `claude-cli/2.1.312 …`）、`anthropic-beta: oauth-2025-04-20`、`x-service-name: claude-code`、`authorization: Bearer <oauth>`。
- `event_logging` 结构：`{ events: [ { event_type: "ClaudeCodeInternalEvent", event_data: { event_id, event_name, client_timestamp, device_id, auth, session_id, model, user_type, is_interactive, client_type, entrypoint, env, betas, model, process, additional_metadata, skill_name, plugin_name, marketplace_name } } ] }`。
- `stderr` 空、`/v1/messages` 只落在假上游 → 证明"遥测不跟 `ANTHROPIC_BASE_URL`"（与 §7 G10-A 一致），且本次没有把任何东西发到真实上游。

## 怎么做（给 WP6 / 上号运维的可用配方）

- 想拿到**真实受理**证据（G10-B `real`）：**不要**用 MITM，按 spec §6.4 用专用测试账号 + 固定代理跑真流量；
  需要看**结构**时用本 PoC 的做法即可（自签 CA + `NODE_EXTRA_CA_CERTS`），**不需要** `SSLKEYLOGFILE`，也不要尝试 MITM 生产账号。
- 若某天必须解密而客户端换成真的 Node/undici（而非 Bun 打包），`SSLKEYLOGFILE` 才有效；当前二进制上这条路是死的（keylog 文件不会被创建）。
