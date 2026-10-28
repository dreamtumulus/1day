# 1DayAPI.com

多模型 AI API 中转平台（参考 sub2api 的分组 / 账户 / 计费体系，v3 重构于 2026-10-15）。
对外提供 OpenAI（Chat Completions / Responses）与 Anthropic（Messages）兼容协议，网关自动在两种协议间转换。

## 核心概念

- **登录密钥**（`1dk_<role>_…`）：登录控制台用，角色为管理员 / 用户 / 号商 / 账号运维（ops）。**不开放注册**，账户由管理员开通。
- **API Key**（`sk-1d-…`）：用户在控制台自建多把，各自绑定分组、额度、过期时间，用于调用网关。
- **分组**：倍率 + 模型白名单 + 上游账户池。实扣 = 模型标准价 × 分组倍率。
- **上游账户**：官方 API Key、第三方中转 API（Base URL + Key）、订阅 OAuth（经节点验证接入）。API 供给按审核规则接入；订阅账号按实际授权组织归属，按用量记收益。
- **组织（team）**：Claude 实际组织 UUID，独立于计费分组。一个对话阶段只使用同组织账号；当前组织真正耗尽时，清空旧上下文后重新选择组织。组织名称与 UUID 仅管理员可见。
- **固定代理**：账号保持固定代理绑定；每个实测出口 IP 默认承载两个同组织订阅账号，常规名额不足时最多三个，分配与归属保留历史。
- **请求准入**：暂时繁忙仅在本 team 内有界等待；默认每用户最多 4 个在途请求和 10 美元估算预算，同时受余额/授信和 Key 配额约束。
- **余额**：只来自兑换码与管理员调账。

契约见 `docs/v3-design.md`，组织隔离与重置规则见 [`docs/team-isolation.md`](docs/team-isolation.md)，文档地图见 `docs/README.md`。

## 结构

```
packages/
  catalog/      内置模型目录与价目（注册表种子）
  core/         共享库：SQLite + 迁移、加密、模型注册表与计价、调度、结算
apps/
  gateway/      推理网关 :8400
  console/      控制台 API + 节点控制面 :8401
  web/          前端：公开站点 + /console 三角色控制台 :8402
  provider-node/ 号商节点守护进程（本地控制台 127.0.0.1:16889）
tests/e2e/      端到端测试（隔离环境）
docs/           开发文档（可共享；脱敏规范见 docs/README.md）
recon/          协议分析参考资料（本地留存，不共享）
secrets/        凭据库（本地留存，禁止外发）
data/           运行数据（库、密钥文件、备份），不入库
```

## 快速开始

```bash
pnpm install && pnpm build

node apps/gateway/scripts/mock-upstream.mjs &     # mock 上游 :19001
pnpm --filter @1dayapi/console seed               # 打印 admin / consumer / provider 登录密钥与一把 sk-1d- Key
pnpm dev:console                                  # :8401
pnpm dev:gateway                                  # :8400
pnpm dev:web                                      # :8402 → http://127.0.0.1:8402/login
```

调用示例（生产网关 https://api.1dayapi.com；本地 http://127.0.0.1:8400）：

```bash
curl http://127.0.0.1:8400/v1/chat/completions \
  -H "Authorization: Bearer sk-1d-..." \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-5","messages":[{"role":"user","content":"hi"}]}'
```

## 测试

```bash
pnpm --filter @1dayapi/core test   # 单元测试
pnpm -r test                      # 全部包测试（临时数据库）
pnpm test:e2e                      # 端到端（需先 pnpm build）：网关协议矩阵、控制台三角色、节点隧道
```

## 说明

- TEE 证明是 HMAC 桩，仅在请求带 `x-1dayapi-tee-proof-mode` 头时输出。
- 数据库为 `node:sqlite` 单文件 `data/1dayapi.db`；v2 库首次启动自动迁移，旧表保留为 `legacy_v2_*`。
- 组织隔离迁移 21/22 仅新增结构，不回填、修改或删除旧账号、代理绑定、用户、Key、余额与账本；旧订阅账号和代理不会被自动认领到新隔离池。
- 代码现由 Git 管理；运行数据、凭据和私有发布记录不入库。完整审计修复见 [`docs/audit-remediation-2026-10-28.md`](docs/audit-remediation-2026-10-28.md)。
- 发布与实测记录见 [`docs/deployment/team-isolation-2026-10-27.md`](docs/deployment/team-isolation-2026-10-27.md)。
