# 文档地图（docs/）

1DayAPI.com 的开发与运维文档。v3 上线于 2026-10-15，2026-10-27 的组织隔离规则见 `team-isolation.md`；
未同步改写的旧日期段落作为历史参考，不能覆盖新版规则。当前本地与服务器代码由发布流程同步，实际发布与验证见 `deployment/`。

## 协作与脱敏规范（先读）

本目录（docs/）**可以共享给外部协作者（包括 AI 助手）**。共享前遵守：

- **凭据零明文**：密钥、密码、令牌、代理凭据只放 `secrets/`（本地留存，禁止外发）；
  文档中一律写"见 secrets/"。
- **研究资料隔离**：`recon/`（协议分析原始材料、竞品研究、实验脚本）为本地工作区，不共享。
- **措辞中性**：统一使用「兼容性分析 / 客户端兼容性对齐 / 账号可用性 / 平台合规」；
  不使用「逆向 / 指纹伪造 / 封号 / 风控绕过」等表述。
- 新增文档默认进 docs/ 即视为可共享；含敏感材料的放 recon/ 或 secrets/ 并在本节登记。

## 推荐阅读顺序

1. [`v3-design.md`](./v3-design.md) —— v3 契约与已拍板的决策（主文档）
2. [`architecture.md`](./architecture.md) —— 系统全貌、拓扑、核心时序、成熟度
3. [`ccr-supply.md`](./ccr-supply.md) —— 云端会话供给（CCR）设计（供给主线；附录 A 为实测 schema）
3a. [`onboarding.md`](./onboarding.md) —— 上号契约：sessionKey / 授权链接、实际组织验证、固定代理的两号/三号容量、账号生命周期
3b. [`team-isolation.md`](./team-isolation.md) —— 同组织换号、耗尽后清空上下文换组织、节点与设备隔离
4. [`development.md`](./development.md) —— 把环境跑起来、跑测试
5. [`issues-and-decisions.md`](./issues-and-decisions.md) —— 决策记录与遗留问题
6. 按需深入下面的子系统文档

## 文档清单

### 契约（"应当如何"，实现必须遵守）

| 文档 | 领域 |
|---|---|
| [`v3-design.md`](./v3-design.md) | **v3 主契约**：角色、数据模型、API Key、上游账户、定价、网关流程、结算、控制台 API、前端、错误码 |
| [`ccr-supply.md`](./ccr-supply.md) | **云端会话供给**：授权接入、环境 provisioning、会话生命周期、events 翻译、配额窗口（附录 A：实测 schema） |
| [`onboarding.md`](./onboarding.md) | **上号**：sessionKey / 授权链接、实际组织验证、固定代理与容量、调度门控、Bridge/SI 协议 |
| [`auth.md`](./auth.md) | 鉴权（登录密钥 + 会话；API Key；上游 OAuth 凭证生命周期） |
| [`provider-protocol.md`](./provider-protocol.md) | 节点 ↔ 平台 ↔ 网关协议（含协议 v2：http_egress）；组织隔离增量见 `team-isolation.md` |
| [`claude-code-compat.md`](./claude-code-compat.md) | Claude Code 客户端请求兼容性规范（直连路径使用；§10 一号一设备） |
| [`direct-gateway.md`](./direct-gateway.md) | **worker-0 独立直连网关**：Bun 单文件二进制、Native CC / Agent 双路径、独立设备与代理状态、Profile 升级和验收契约 |
| [`worker-sessions.md`](./worker-sessions.md) | **worker 持久会话**（2026-10-17 立项）：stream-json 双向进程池、回收与容量、原生工具 / thinking / document 分期计划与进度 |

### 现状参考（"是什么"）

| 文档 | 内容 |
|---|---|
| [`architecture.md`](./architecture.md) | 定位、组件、部署拓扑、核心数据流、设计决策、成熟度 |
| [`data-model.md`](./data-model.md) | v3 表、字段语义、不变量、迁移、`data/` 文件 |
| [`gateway.md`](./gateway.md) | 鉴权顺序、选账户、协议模式、错误分级与冷却、流式用量、结算、OAuth 刷新、隧道、环境变量 |
| [`console-api.md`](./console-api.md) | 控制台全部端点（公共 / 用户 / 号商 / 管理员 / 内部） |
| [`web.md`](./web.md) | 公开站点 + `/console` 控制台结构、菜单、i18n、UI 组件库 |
| [`provider-node.md`](./provider-node.md) | 号商节点实现：本地控制台、桥接、出口、CLI、安装 |
| [`catalog.md`](./catalog.md) | 内置模型目录与价目（注册表的种子） |
| [`errors.md`](./errors.md) | 网关 / 控制台 / 节点错误码、协议原因码、WS 关闭码 |
| [`monitoring-handover.md`](./monitoring-handover.md) | **给监控 bot 的交接说明**：只读体检钥匙、报告字段、红黄绿判定规则、良性模式白名单 |
| [`client-notes-2026-10-19.md`](./client-notes-2026-10-19.md) | **给接入方的适配说明**：2026-10-19 起对 API 客户可见的行为变化（新错误码、模型 ID、thinking、重试建议） |
| [`operations.md`](./operations.md) | 生产环境与运维（脱敏） |
| [`team-isolation.md`](./team-isolation.md) | Claude 实际组织隔离、跨组织上下文重置、代理容量与历史 |
| [`development.md`](./development.md) | 前置条件、启动、mock、测试、环境变量、开发坑 |

### 决策与规划

| 文档 | 内容 |
|---|---|
| [`issues-and-decisions.md`](./issues-and-decisions.md) | 决策记录 D1–D8、遗留问题与顺序 |

### 历史 / 背景资料（不代表当前实现）

| 文档 | 内容 |
|---|---|
| [`billing-groups.md`](./billing-groups.md) | Billing v2 设计，**已被 v3-design.md 取代** |

协议分析笔记已移至 `recon/notes/`（本地，不共享）。

### 运维记录

[`deployment/`](./deployment/) —— 服务器档案与部署记录（已脱敏）。凭据在 `secrets/`。

## 权威顺序（冲突时）

1. 代码本身（现状）。
2. 契约：`v3-design.md` 为主，`ccr-supply.md`、`auth.md`、`provider-protocol.md` 为分领域细化；代码与契约不一致时记入 `issues-and-decisions.md` 决定改哪边。
3. 现状参考文档。
4. 历史 / 背景资料。

## 维护约定

- 改代码同步更新对应现状文档；改接口或表结构先改 `v3-design.md`。
- 新问题记到 `issues-and-decisions.md`，带 ID 引用。
- 文档里不写任何密钥、密码、令牌明文（凭据只放 `secrets/`），不出现敏感措辞（见顶部规范）。

完整审计修复与验证映射：[2026-10-28 审计修复](audit-remediation-2026-10-28.md)。
2026-11-10 代码评审加固（主密钥守卫、Key 查看重新认证、加密备份、切换前探针与回滚、测试闸门）：[逐项记录与上线清单](code-review-2026-11-10.md)。
