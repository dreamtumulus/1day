# 2026-10-28 审计修复对照

本记录对应 2026-10-27 对组织隔离版本的代码与逻辑审计。用户已授权逐项修复、提交、发布和更新文档。以下说明最终代码行为及验证依据；生产发布事实、提交号、构建 hash 和服务核验由发布记录填写，不能仅凭本文件认定已经上线。

本轮策略：临时繁忙有界等待，真正耗尽才清空并换组织；同一用户跨 Key、跨网关共享并发和在途预算；管理中的 Claude 订阅只允许平台批准的可信节点；worker 按组织分配独立 Linux UID。继续保留旧数据，不回填旧账号/代理/会话/账本；旧未管理账号和上号任务退出自动维护。

## 请求、计费和授权

| 编号 | 修复后的行为 | 代码与验证依据 |
|---|---|---|
| R1 | 并发/RPM 暂时不足进入可取消的等待，默认 15 秒，`ACCOUNT_BUSY_WAIT_MS` 可设为 0–60000 毫秒。超时返回 `account_pool_busy`，保留 team、generation 和对话内容；已提交 SSE 头时用流内错误结束。真正耗尽才使用既有 CAS 清空切换。 | `gateway/src/proxy.ts`；`gateway/test/team-isolation.test.mjs` 覆盖忙碌等待、超时、主请求不被子请求撤销。 |
| R2 | 客户端取消贯穿准入等待、凭据刷新等待、开隧道、HTTP 头、流读取、云 CCR 和 worker 等待；中止即关闭相关隧道并释放槽位。正常工具交接保留原有语义。 | `gateway/src/lifecycle.ts`、`tunnel.ts`、`ccr/worker.ts` 和 console tunnel 路由；`lifecycle.test.mjs`、`team-isolation.test.mjs` 覆盖头前取消和 result 前取消。 |
| B1 | 收到 usage 不代表完成。Anthropic/OpenAI/Responses 各自要求相应完成事件；提前 EOF 记录失败并按现有失败零收费政策结算，向客户端传递可识别错误。 | `gateway/src/proxy.ts`；`team-isolation.test.mjs` 的 usage+EOF 回归。 |
| B2 | usage 统一校验有限、非负、安全整数及总量上界；缓存子集关系也校验。异常上游 usage 使用有标记的请求/文本估算；核心结算再次拒绝非法计数和金额。仅 request_id 唯一冲突可视为重复，其他 SQLite 错误显式暴露。 | `gateway/src/usage.ts`、`core/src/money.ts`、`billing.ts`；`usage-validation.test.mjs`、`core/test/audit-billing.test.mjs`。 |
| B3 | 先将结算内容和价格快照写入独立、fsync 的 0600 journal，再进行幂等入账；数据库故障保留待补账记录，10 秒周期重放。存在待补账或存储不可写时关闭新推理准入；修账不会重新执行模型。 | `core/src/settlement-journal.ts` 及 gateway 接入；`audit-billing.test.mjs` 注入数据库写失败、改价后重放、重复恢复和 journal 不可写。 |
| B4 | 用户所有 Key、所有网关共享在途预约；当时默认 `USER_MAX_INFLIGHT=4`、`USER_MAX_INFLIGHT_USD=10`（**2026-11-10 起改为 1000 / 不设金额上限**，X-52，见 data-model.md「默认在途额度政策」），同时受实时可用余额/授信和 Key 剩余额度限制。估算来自请求输入及最大输出；低余额仍可准入一笔后付费请求，该请求占满剩余预约预算。 | `core/src/request-budget.ts`、`gateway/src/proxy.ts`；`audit-billing.test.mjs` 验证共享预算、低余额、过期恢复和默认并发。这是估算准入，最终账单仍按实际用量，不能当作绝对的单笔费用硬上限。 |
| B5 | 新结算保存定价快照及退款基数，后续改价不改变历史退款。无快照的旧账单不补造价格，不纳入新的自动退款计算。 | `core/src/billing.ts`、`cache-refund.ts`；`audit-billing.test.mjs` 和 `cache-refund.test.mjs`。 |
| A1 | 推理时校验当前专属组授权；撤销后既有 Key 的新推理立即拒绝。Key 与历史账目保留。 | `gateway/src/auth.ts`；`exclusive-group-auth.test.mjs`。 |
| A2 | 先规范模型身份，再读取统一的 enabled、价格和 allowlist；点号、连字符和日期别名不能绕过基础模型禁用。显式配置的透传政策继续单独生效。 | `core/src/models.ts`、`allowlist.ts`；`audit-billing.test.mjs`、`model-alias.test.mjs`。 |
| A3 | 普通新增上号只允许 admin；ops 保留已有账号重授权、状态查看及有限管理权限。ops 不能借普通上号/取消入口创建或控制管理员新增任务。 | `console/src/routes/onboarding.ts`；`console/test/audit-fixes.test.mjs` 的真实 HTTP 角色矩阵。 |

## 账号、代理与会话生命周期

| 编号 | 修复后的行为 | 代码与验证依据 |
|---|---|---|
| L1 | 无 team 的旧账号不参加自动 usage 探测或 token 保活；`isolation_version=0` 的旧上号任务不被超时清理改写；旧代理、设备身份与代理映射也不接受心跳回写。 | `console/src/ccr/window-poll.ts`、`onboard/reservations.ts`；`audit-fixes.test.mjs`、`team-tunnel.test.mjs` 对旧账号、任务、代理及映射逐字段比较。 |
| P1 | 所有新增/导入/节点上传共用节点容量检查；在同一写事务中计算节点已绑定账号及有效新增预约。禁用/失效账号仍占物理账号名额；固定账号重授权不重复占位，并拒绝同账号重叠重授权。 | `console/src/node/capacity.ts`、`onboard/jobs.ts`、admin/provider/node 路由；`audit-fixes.test.mjs` 覆盖预约与导入竞争、provider 顺序导入、取消后释放。节点账号容量、IP 最多三号、worker 并发是独立限制。 |
| L2 | 公开池不再把旧未管理账号标成 online；分别显示 `unmanaged`、`unavailable`、`offline`、`cooling`、`busy`。online 检查组织、固定代理、组资格、节点可信/接单状态及窗口；并发忙碌来自共享租约。 | `console/src/routes/public.ts`；`audit-fixes.test.mjs`、公开池前端类型/标签构建验证。 |
| L3 | 新上号任务保存绝对 expires_at；auth_url 等待 30 分钟、交换执行 3 分钟。15 秒独立清理，不依赖 token 刷新和巡检；分配、回调和提交也检查期限。未知身份但已出站的资源按原隔离规则封存。 | `console/src/onboard/reservations.ts`、`jobs.ts`、`node/proxies.ts`；`audit-fixes.test.mjs` 和原有过期作业测试。旧 v1 任务可按原时间字段推算期限，迁移不回填。 |
| C1 | 云 CCR 池条目持续保存已消费事件水位；每轮只翻译新增事件，旧 result 不再提前结束下一轮。 | `gateway/src/ccr/client.ts`、`executor.ts`、`session-pool.ts`；`team-isolation.test.mjs` 的完整历史、两轮不同答案与流式水位回归，以及 CCR 端到端用例。 |
| C2 | 同 key 忙碌时的新会话不能覆盖已有池条目；临时溢出会话一次性使用，回收时核对 entry 身份，旧 release 不会误删新 session。 | `gateway/src/ccr/session-pool.ts`；`session-pool.test.mjs` 的 busy overflow 和旧条目回收回归。 |
| C3 | 退役云 session 先持久化加密归档意图；即使账号已删除或节点暂时离线，也保留固定 node/team/proxy 快照重试。清理通道只可调用固定 archive 路径，并校验不可变 account_bound 历史和组织出口认领，不能执行一般推理或任意 URL。成功记录 done，不删除历史；凭据被上游永久撤销等失败保留诊断状态。 | `gateway/src/ccr/executor.ts`、`console/src/node/archive-cleanup.ts`、`egress-request.ts`；`audit-fixes.test.mjs` 验证删除账号、节点离线、加密预约和真实本地 WS 恢复归档。 |

## 前端与接入操作

| 编号 | 修复后的行为 | 验证依据 |
|---|---|---|
| F1 | 已管理订阅普通编辑不发送凭据或只读组织 UUID；名称、优先级、并发等可正常保存，凭据更新走重授权。 | `_p2AccountForm.tsx`、`Accounts.tsx`；前端类型检查/生产构建和服务端固定绑定测试。 |
| F2 | SK 和 auth_url 共用管理员组织 UUID/名称输入；已知组织可使用第二/第三槽，服务端继续验证实际组织。 | `console/pages/shared/Onboard.tsx`；前端构建和上号接口组织校验测试。 |
| F3 | 取消调用后端真实终止任务，清除敏感载荷并释放预约；迟到授权不得创建账号。管理员/号商可查询最近作业并恢复 auth_url 等待；上号员列表保留作用域隔离。 | `routes/onboarding.ts`、`onboarder.ts`、`jobs.ts` 和前端取消/恢复操作；`audit-fixes.test.mjs` 验证取消幂等、权限、晚到结果和释放。 |
| F4 | 批量提交期间及仍有活动作业时锁定节点选择，避免界面节点与闭包实际提交节点不一致。 | `pages/OnboardSite.tsx`；前端构建和节点参数接口校验。 |
| F5 | 负数、NaN 和非法 Key 配额显式报错，不能静默变成 0（无限额）。 | `console/pages/user/Keys.tsx`；前端构建、现有服务端有限非负数校验。 |
| F6 | 重新加载立即清除前一筛选条件的数据；加载/失败状态明确显示，批量操作不能基于旧列表继续。 | `console/ui.tsx`、账号批量操作；前端构建。 |
| F7 | Verify 与网关使用同一 `host:bodyHash` 签名输入。该功能仍是标注为 stub 的响应证明，不宣称提供真实 TEE 远程证明。 | `pages/Verify.tsx`、`gateway/src/http.ts`；前端/网关构建。 |

前端构建证明类型与产物可生成，不等同于逐页真实浏览器验收；生产页面、静态产物和只读 API 核验记入发布记录。

## 运维、资源和执行边界

| 编号 | 修复后的行为 | 验证与部署要求 |
|---|---|---|
| O1 | nginx 仅对配置的 Cloudflare CIDR 使用 CF-Connecting-IP，并重写传给 console 的 XFF；console 仅信任本地 nginx 地址，登录限流按真实来源分桶。启用 `COOKIE_SECURE=1`。 | 代码支持受限 trustProxy；生产必须同时检查 nginx 真实 IP 配置和实际 console 环境，不可只设置全局信任 XFF。上线核验见发布记录。 |
| O2 | 账号并发/RPM 改用共享 SQLite 租约和滑动窗口，蓝绿两个进程共用计数；租约 90 秒，30 秒续约，正常完成释放。管理页看到所有活跃实例的合计。 | `gateway/src/limits.ts`；`limits.test.mjs` 及网关回归。 |
| O3 | bundle 缓存签名包括源码内容、lockfile、包/编译配置、Bun 版本和构建参数；产物仍记录内容 SHA256，mtime/size 不再作为身份依据。 | `console/src/node/bundle.ts`；全仓构建及发布 artifact hash 核验。 |
| O4 | 网关写入等待 drain，长时间无消费取消；生产者按流需求推进。SSE 单事件、非流式响应、proof 缓冲、console 单隧道及节点队列均有预算，溢出关闭相关会话而不无限累积。 | `gateway/src/lifecycle.ts`、`proxy.ts`、`console/src/node/registry.ts`；`lifecycle.test.mjs` 的慢消费者/取消/响应大小测试。当前 console 入站队列为单隧道 8 MiB、单节点 64 MiB，SSE 残余事件上限 2 MiB。 |
| O5 | 公开池明细只对当前页账号按 account/time 索引汇总 30 天记录；空页不扫描 usage。明细缓存 60 秒、摘要缓存 5 秒，并加公开端点每 IP 限流和缓存大小上限。 | `console/src/routes/public.ts`；console 构建/HTTP 回归；百万记录生产接口时延只读核验见发布记录。 |
| S1 | 节点管理 API 要求独立管理凭据，存于受保护配置目录的 management.token（0600），不会由公开状态接口返回。CLI 自动读取并发 Bearer，浏览器需管理员输入；Host、loopback 和 CSRF 继续保留。绑定平台地址固定到受保护服务配置。 | `provider-node/src/management-auth.ts`、`server.ts`、`cli.ts`、`console-html.ts`；`provider-node/test/management-auth.test.mjs` 检查缺失/错误凭据、0600、响应不泄露凭据及平台地址固定；生产另核对文件权限。没有执行此前被自动检查拦截的凭据窃取实验。 |
| S2 | 管理中的 Claude 订阅新增、组织验证及执行仅使用 `TRUSTED_EXECUTION_NODE_IDS` 中的节点。生产配置三个平台控制节点，号商注册节点不能凭自报验证结果进入严格隔离池。`ALLOW_UNTRUSTED_EXECUTION=1` 只用于明确的本地开发测试。 | `console/src/node/trust.ts`、上号引擎和 registry；临时测试显式开启开发选项，生产不得开启。节点 root/平台操作员仍属于信任边界，不把心跳当独立硬件证明。 |
| S3 | `CC_WORKER_TEAM_UIDS=1` 为每个 team 动态创建独立系统 UID/GID，按该身份运行 Claude 进程并隔离账号目录；创建失败拒绝执行，不回落公共 UID。平台要求节点报告 `team_uid_isolation_v1`，防止旧节点进入强隔离执行路径。 | `provider-node/src/cc-worker.ts`、`bridge.ts` 和 console registry；`provider-node/test/team-uid.test.mjs` 在临时目录验证两个组织进程的不同 UID 和 0700 账号目录；生产三个 worker 开启 UID 模式和平台强制能力。UID 与目录隔离仍共享可信 root manager 和内核，不宣称是每 team 独立虚拟机。实际 UID/能力核验见发布记录。 |

## 数据与发布核验

migration 22 只新增 expires_at、共享租约/预算、定价快照及加密 CCR 归档任务结构；没有对旧行做组织补填、凭据替换、账本重算或删除。新增租约、上号任务和新账单属于本轮正常业务状态。

发布前应完成全仓构建、core/gateway/console/provider-node 测试及七套本地端到端回归。报告中的本地复现实验由正式回归覆盖，测试只用临时数据库和本地上游/节点替身。发布时备份代码、配置和数据库，在独立目录构建并核对本地/服务器 hash，切换网关及 console，更新三个标准 worker，最后核验 health、前端、只读权限、节点能力和新增结构。回滚代码不覆盖运行数据库。
