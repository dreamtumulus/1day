# 问题清单与决策记录

> §1 是 2026-10-14 逐行核对 v2 代码得到的问题清单，"v3 状态"列记录 2026-10-15 v3 重构后的结论：
> ✅ 已解决 / 🟡 部分解决 / ⏳ 仍存在 / — 不再适用。§2 是已拍板的决策，§3 是遗留问题与后续顺序。
> 契约见 [`v3-design.md`](./v3-design.md)。

严重度：**P0** 上真实上游 / 真实号商前必须解决；**P1** 影响正确性或可用性；**P2** 改进项。

## 1. 问题清单

### 1.1 资金与计费

| ID | 级别 | 问题（v2） | v3 状态 |
|---|---|---|---|
| B-1 | P0 | `/api/topup` 是 mock，任意密钥可无限加余额 | ✅ 已删除；余额只来自兑换码与管理员调账 |
| B-2 | P0 | 目录外模型照样转发且成本为 0 | ✅ 不在注册表的模型 404 `model_not_found` |
| B-3 | P0 | OpenAI Chat 流式不带 usage → 成本 0 | ✅ 强制注入 `include_usage`，按需剔除 usage 块 |
| B-4 | P0 | Responses 流式 usage 未抽取 | ✅ 从 `response.completed` 抽取 |
| B-5 | P1 | 只检查余额 > 0，并发可透支 | 🟡 仍为后结算，允许透支但不丢单（决策 Q5-A） |
| B-6 | P1 | 流水与余额未包事务 | ✅ 结算 / 兑换 / 调账均单事务 |
| B-7 | P1 | OpenAI `cached_tokens` 不识别 | ✅ 计为缓存读；5m/1h 缓存写在覆盖价下合并为一个单价 |
| B-8 | P1 | 号商没有收益记账 | ✅ `usage_logs.provider_earning` + 未结算余额 + `payout` 出账 |
| B-9 | P2 | 金额用浮点 REAL | 🟡 仍为 REAL，入库前量化 8 位 |
| B-10 | P2 | 视频不计费、图片 501 | — 图片 / 视频统一 501 |

### 1.2 路由与协议

| ID | 级别 | 问题（v2） | v3 状态 |
|---|---|---|---|
| R-1 | P1 | 只区分 `claude-*`/其他，其余厂商被发往 OpenAI | ✅ 账户按平台 / 模型列表匹配；10 个平台有默认 Base URL，其余可配第三方中转 |
| R-2 | P1 | `/v1/messages`、`/v1/responses` 不按模型路由 | ✅ 端点 × 账户协议矩阵，含 Anthropic ↔ OpenAI 双向转换 |
| R-3 | P1 | 上游 4xx/429 一律变 502 | ✅ 400/404/413/422 透传；429/401/5xx 故障转移；全部限流时 429 |
| R-4 | P1 | 转换丢 tools / 图片，`max_tokens` 缺省 4096 | 🟡 tools、图片、tool_result 已支持；`response_format` 等仍未转换；缺省 8192 |
| R-5 | P1 | 不透传 `anthropic-beta` | ✅ 透传；OAuth 账户追加 oauth beta |
| R-6 | P1 | 无超时 / 故障转移 | ✅ 最多 3 个账户 + 冷却；上游超时 `UPSTREAM_TIMEOUT_MS`（见 §3 X-2） |
| R-7 | P2 | 每请求先试隧道 | ✅ 隧道是账户属性，只有 `route=node` 账户才开洞 |
| R-8 | P2 | 模型 `status` 不生效 | ✅ 注册表 `enabled` 控制上下架 |

### 1.3 访问控制与密钥管理

| ID | 级别 | 问题（v2） | v3 状态 |
|---|---|---|---|
| A-1 | P0 | 内部隧道端点只靠"来源是否回环"，且曾返回凭证明文 | ✅ 要求回环 socket + 内部令牌；凭证不再经 HTTP 传递。⏳ 生产 nginx 仍需只放行 `/internal/provider/*` |
| A-2 | P1 | 未配置 `trustProxy` | 🟡 新增 `TRUST_PROXY=1` 开关，需在生产配置 |
| A-3 | P1 | 会话 cookie 无 `Secure`；会话 token 明文入库 | 🟡 `COOKIE_SECURE=1` 可加 Secure；token 仍明文存储 |
| A-4 | P1 | 首个 admin 明文进日志；`deployment/` 含凭据 | 🟡 日志不再打印明文，只写 `admin-key.txt`；`deployment/` 问题不变 |
| A-5 | P2 | 无审计日志 | 🟡 ledger 记 `created_by`；其他管理操作仍无审计 |
| A-6 | P2 | `/api/usage-limits` 公开全站数据 | ✅ 已删除 |
| A-7 | P2 | 主钥与 DB 同盘、无轮换 | ⏳ |

### 1.4 号商供应链

| ID | 级别 | 问题（v2） | v3 状态 |
|---|---|---|---|
| P-1 | P1 | 凭证永不失效、无刷新 | ✅ 冷却 / error 状态 + OAuth 刷新 |
| P-2 | P1 | 心跳健康字段被忽略；无暂停 / 吊销 | 🟡 可解绑 / 移除节点、禁用号商（close 4003）；风险信号仍忽略 |
| P-3 | P1 | `deadlineMs` 语义不一致 | ✅ 平台改发相对毫秒 |
| P-4 | P1 | `platformWsUrl` 可能是 `ws://` | ⏳ 生产需设 `PLATFORM_WS_URL` 或转发 `X-Forwarded-Proto` |
| P-5 | P1 | 无分发渠道；Dockerfile 引用已删 `vendor/` | 🟡 Dockerfile 已修；`releases.1dayapi.com` 仍未部署 |
| P-6 | P2 | 隧道是长轮询，无背压，不能多实例 | ⏳ |
| P-7 | P2 | console 重启后 `online` 不重置；上传不去重 | ⏳ |
| P-8 | — | 合规：平台转卖订阅 OAuth 令牌是否符合厂商条款 | ⏳ 未解决，见 §3 |

### 1.5 工程化

| ID | 级别 | 问题（v2） | v3 状态 |
|---|---|---|---|
| E-1 | P1 | 未纳入 git，rsync 部署 | ✅ 2026-10-17 `git init`（本地 `main`，无远端；`.gitignore` 见 development.md §1）；部署仍是 rsync + 服务器 build |
| E-2 | P1 | 没有自动化测试 | ✅ core 单元测试 + `pnpm test:e2e`（三套端到端） |
| E-3 | P1 | 无迁移框架，两份 DDL | ✅ `packages/core` 版本化迁移，DDL 只有一份 |
| E-4 | P2 | 无 CI、lint | ⏳ |
| E-5 | P2 | 无监控、定时备份 | ⏳ |
| E-6 | P2 | 前端类型与 catalog 类型重复 | ⏳ 控制台类型另在 `console/api.ts` 声明 |

### 1.6 其他

| ID | 问题（v2） | v3 状态 |
|---|---|---|
| D-1 | gateway `seed.mjs` 是 Auth v1 遗留 | ✅ 已删除，用 console `seed.mjs` |
| D-2 | Verify 页 HMAC 算法与网关不一致 | ⏳ 仍存在；且对称签名本身无法给第三方验证 |
| D-3 | 隧道时 TEE 证明的 `upstream_host` 写直连主机 | ✅ 取实际请求 URL 的 host |
| D-4 | 视频任务可被任意 Key 查询 | — 视频端点改为 501 |

## 2. 决策记录（2026-10-15 已拍板）

| # | 决策 | 结论 | 对应 v2 问题 |
|---|---|---|---|
| D1 | 鉴权模式 | 保持密钥登录（`1dk_<role>_…` → 会话 cookie），无用户名密码 | Q9 |
| D2 | 注册 / 推荐 | 取消自助签发与推荐返利；账户只由管理员开通 | B-1 |
| D3 | 账户与 Key | 登录密钥代表账户，用户自建多把 `sk-1d-` API Key（独立分组 / 额度 / 过期 / 启停） | Q9 |
| D4 | 上游接入 | 管理员与号商都能接入（官方 Key、第三方中转、订阅 OAuth）；号商需审核，按用量记收益 | Q1、Q3、B-8 |
| D5 | 计费 | 按量扣余额 + 兑换码 / 调账；删除 mock 充值；不做订阅套餐 | Q2、Q4、Q5（后结算） |
| D6 | 技术栈 | 保留 TS + Fastify + SQLite + React/Tailwind；首页不动，重做三角色控制台 | Q8（部分） |

Q6（上游错误呈现）按建议落地：4xx 透传、限流 429、其余 502。Q7（Billing v2）被 v3 整体取代。

## 2.1 决策记录（2026-10-15 供给端技术选型，追加）

| # | 决策 | 结论 | 依据 |
|---|---|---|---|
| D7 | 订阅账号供给形态 | **双轨**：直连路径（已实现，功能完整）+ 云端会话路径（CCR，规划中，契约 `ccr-supply.md`）。CCR 为订阅账号的主演进方向：模型调用由官方云端 worker 执行，平台只做会话编排与协议翻译，客户端兼容性问题消失 | 行业同类产品机制分析 + 官方客户端 2.1.300 能力核验（`environment_kind=bridge`、`ccr-byoc-2025-07-29`、`/v1/code/sessions` 均为官方一等能力） |
| D8 | 账号授权接入 | **2026-10-18 修订：sessionKey 可走非浏览器直连 OAuth**（`POST /v1/oauth/{org}/authorize`，SK 作为 Bearer，授权码 + PKCE），不再要求服务器浏览器。旧三次实验只否定当时的全 scope/请求组合，不再扩大为“所有直连均不可用”。Chrome Extension、Claude Code runner、Bridge environment/SI 分别使用各自 client/scope，详见 `onboarding.md` §2、§9。**浏览器 bot 已删除**（用户拍板“完全放弃”），控制台 `direct-oauth.ts` 经节点代理完成全部请求 | 新实测：authorize/code/token/validate 均通过；Chrome Bridge 返回 `waiting`；worker/register 返回 200。旧实验记录保留在 `recon/` 供对照 |
| D9 | 令牌生命周期运营 | access_token 8h + refresh 轮换自动保活（无新鲜度要求）；`/api/oauth/validate` 做免费健康巡检（注意 scope 门槛，最小 scope 403 属预期）；CCR 路径叠加 `/api/oauth/usage` 窗口水位巡检 | 实测 + 官方客户端行为分析 |
| D10（2026-10-16） | 分流器 | **真 CC 形态请求才走直连**（`x-app: cli`、`claude-code-20250219` beta、计费头系统块与版本一致、`metadata.user_id`），其余一律 worker；策略 `cc_shape_policy=downgrade`。普通 429 为软冷却（排最后、不排除），窗口 429 为硬冷却；巡检被动优先 | `gateway.md` §2a/§3；用户："严格判定是不是真的 CC 请求，这是系统的关键" |
| D11（2026-10-16） | 供给形态落地 | 全部订阅账号 `executor=ccr_worker`（节点上真实 Claude Code 进程），云端会话 executor 保留但停用；上号默认 worker、并发 9、RPM 100 | 用户拍板；`onboarding.md` §7 |
| D12（2026-10-16～17） | 定价与缓存计费 | 模型价 100% 官方价（倍率在分组）；CCR 客户缓存 = 上游 − 身份基线（worker 700 / cloud 28000）；**强加的缓存写按输入价**（`ccr_cache_write_as_input=1`），缓存读 0.1× 让利；粘性被迫换账号本轮 input 按读价（sub2api ForceCacheBilling）；估算行媒体块固定 1600 token | `ccr-supply.md` §7.1、`gateway.md`；用户："缓存创建、缓存读取的计费一块修改" |
| D13（2026-10-16） | worker 隔离 | 非特权 `ccworker`、每会话 scratch 目录、`--tools ""`、`--system-prompt-file` 替换 CC 默认身份、启动自检；worker 根目录 `/var/lib/1dayapi-cc-worker` | 事故驱动（客户文件写进节点 `/root`；模型吐 `<invoke>` 标记）；`ccr-supply.md` §8.1 |
| D14（2026-10-17） | 一号一设备 | 节点 `.claude.json` 为设备身份真相源，同步到 `accounts.device_id/account_uuid`；直连改写客户 `metadata.user_id` 的 device_id/account_uuid，保留 session_id | 用户："一个账号一个设备，并且保持用户的粘性对话"；`claude-code-compat.md` §10 |
| D15（2026-10-17） | 代理判死 | 连续 `PROXY_DEAD_AFTER`=3 次代理层失败才 dead，成功清零，探活并发 4；节点上报 live/suspect/dead | 用户："代理池只是有波动，评判标准要放宽"；`onboarding.md` §6.1 |
| D16（2026-10-17） | 发布稳定性 | 节点 SIGTERM 先排空（60 s），console 新会话等节点重连（20 s），网关 open 超时 25 s；console 重启仍打断在途隧道，只能挑低谷 | 一次节点重启打断 12 条客户请求；`operations.md` §2 |
| D18（2026-10-17） | worker 鉴权失败与 token 刷新 | Claude Code 文本型鉴权失败按"单次 5 分钟冷却、30 分钟内 3 次禁用"处理（gateway.md §3）；根因怀疑是同一账号多处刷新 OAuth token（网关直连路径 + 多个 claude 进程各持一份 `.credentials.json`，节点不回写刷新结果），尚未坐实；下一步应让平台成为唯一刷新者并在每次 launch 前重写最新 token | 2026-10-17 账号 claude-633a683d 同一秒两条 "revoked/expired" 后 1 分钟即恢复 |
| D17（2026-10-17） | worker 持久会话 | stream-json 双向进程池为 worker 路径主线：阶段 1（复用 + 回收/容量 + 增量计费）已上线，阶段 2 原生工具（MCP）、3 thinking、4 document 按序推进；sub2api 没有此形态，其余计费/调度逻辑先查 sub2api 再造 | 用户："持久 stream-json 双向会话是重点…规划好，开工"；`worker-sessions.md` |
| D19（2026-10-18） | 缓存写入计价 | 直连路径的 `cache_creation_input_tokens` 全部按目录通用 `cache_write_tokens` 单价（= 官方 1 小时写入价，Opus 5.5 $8/M）计费，**不**按上游 `usage.cache_creation` 的 5m/1h 拆分区分；审计时不要把它当多收（API key 模式的 Claude Code 默认 5m 写入，按官方 5m 价会低 37.5%，key「cc企业池」累计差额约 $71）。Haiku 5.5 超 10 万 token 的 `prompt_tiers` 同样暂不应用（累计少收约 $5） | 用户："我约定得就是按照1H，暂时不动吧"；bed43dea 审计：单价与公式均与官方价格页一致，21.8 万 token 收 $0.062 是因为 99.4% 为缓存命中（Opus 5.5 命中价 = 输入价 5%） |
| D-CR（2026-10-21） | 缓存重建返还 | 粘性会话被迫换账号的请求（`usage_logs.account_switched=1`）多付的缓存费（实付 − 全部提示词按读价）**返还 80%**；不实时，console 定时每 24h 一轮自动入账；消耗在授信上的先冲减授信已用、余下加预付余额；用户钱包页有「缓存返还」卡片 + 明细按钮并写明规则；管理员可对单人 / 全体立即返还；比例、间隔、开关在设置页 | 用户 2026-10-21："因为账号跳跃造成的缓存异常计费……返还 80%……24 小时返还一次……如果是消耗的授信就返还到授信，并且在页面说明清楚"；`data-model.md` cache_refunds、`console-api.md` §2/§4 |
| D-AF（2026-10-21） | 亲和绑定跨网关发布保持 | 粘性会话表与设备池写穿到 SQLite `affinity_bindings`（迁移 16），进程内 Map 只作热缓存、查不到再读库；蓝绿切换后新实例接着旧绑定继续，对话 / 设备 → 账号的对应不变，跳号检测（`account_switched`）也不再因重启失效；worker 持久会话的网关侧轮次记忆同样落盘（`worker_turn_memory`，迁移 17），切换后同一对话 `continue` 到节点活进程而非全量 fresh。CCR 云端会话池（executor=ccr）未落盘：当前 128 个账号全是 ccr_worker，该池无人使用 | 用户 2026-10-21："当网关切换的时候，所有的对话，设备ID，账号，要一一对应回去，要不然会增加不必要的风控风险"；19:54 切换后 10 min 内输入 token 翻倍，而重启造成的跳号在旧实现下无法被标记；`gateway.md` §3「跨发布保持」 |
| D-WS（2026-10-22） | worker 持久会话：续写落空绝不以增量起进程 | 网关 continue 随带全量 `history`，节点落空（busy / 停泊 / 退出 / 轮次不符）用它起新进程，无历史则拒绝 `session_lost`；停泊等工具结果的进程不接受 continue；`planToolResult` 在尾部 `system` 消息之前找 tool_result | 客户 mirasim 10-22 报告 20 次「只收到 system + tools + 新增消息」；节点日志 `continue miss: busy -> fresh` 107 次 / 7.5h；`worker-sessions.md` 进度 2026-10-22 |
| D20（2026-10-19） | 请求级错误只答一次 | worker / 节点路径里"换账号也没用"的失败统一为 400：`prompt_too_long`、`safeguards_refusal`（Claude Code 原句）、`invalid_request`（空 prompt、console 开会话校验、节点 bad_spec）、413 `request_too_large`；不换号、不冷却。503 `no_available_account` 只表示真的无供给 | 2026-10-18/19 日志：console 400 被走遍全部账号 → 误报 503；安全拒绝一次冷却 2 个好账号 |
| D21（2026-10-19） | 节点 Claude Code 关闭文件引用 | worker 进程 `CLAUDE_CODE_DISABLE_FILE_MENTIONS=1`；不按会话大小设阈值（膨胀倍数 1.7–3.8 与大小无关，fresh 会话 150 万 token 也成功过） | `@/etc/hostname` 探测返回节点主机名；"Prompt is too long … attachment content"。用户决定不轮换订阅 token |
| D22（2026-10-19） | 直连路径 thinking 归一化 + 点号模型别名 | `normalizeThinking`（5.x 拒 budget / Fable、Opus 5.5 拒 disabled / Sonnet 5.5 between_tools）；`claude-opus-5.5` → 上游 `claude-opus-5-5`，计费记客户写法 | 10 × 400 thinking.disabled（Claude Code 2.1.220）；22 × 404 `claude-opus-5.5` |
| D23（2026-10-19） | 网关零中断发布 + 公共 DNS | 蓝绿实例 `1dayapi-gateway@8400/@8402` + nginx `upstream gateway_live` + `ops/bin/gateway-switch`，禁止再 `systemctl restart 1dayapi-gateway`；三台机器 systemd-resolved 并行使用 1.1.1.1/8.8.8.8/1.0.0.1/8.8.4.4，Contabo 解析器降为 fallback | 每次 restart 丢约 4 个请求（监听先关、排空 75 s）；10-18 23:45 CEST Contabo DNS 故障让两个节点掉线 6 分钟 |
| D24（2026-10-19） | CC 形态判定收紧 | 四项软检查升为硬条件（stainless js/node、session 头、accept json、anthropic-version），新增 session 头 = metadata session_id 一致性与按模型的 Claude Code 最低版本门槛（opus-5-5 2.1.280、fable-5-1 2.1.251）；worker 系统提示剥掉客户的计费头行 | 用户：「判断要足够精确」；24h 内 8 个 router 伪形状请求以外来运行时通过 genuine；2.1.303 实抓确认不变量 |
| D25（2026-10-19） | 节点链路宽限 | console 保留会话 30 s + 排队帧，节点保留 35 s + 缓冲帧，hello `sessions` / ready `retainedSessions` 对账；旧版本任一侧退回旧行为 | 11:47 一次 2 秒的 Cloudflare WebSocket 回收切断 11 条 worker 流；用户：「治本吧」 |
| D26（2026-10-19） | worker 单轮上限 10 → 20 min | 节点 `CC_WORKER_TIMEOUT_MS`（默认 1_200_000）与网关 `CCR_SESSION_TIMEOUT_MS=1200000` 同步；蓝绿排空放宽到 25 min | 用户：「放宽到 20 分钟吧」；12:36 窗口 15 分钟内 4 次撞 10 分钟上限 |
| D27（2026-10-19） | 用户计费改为充值授信 | 管理员设授信额度，用量先扣预付余额再累计到本期已用，`额度 − 已用 + 余额 ≤ 0` 时 402 `credit_exhausted`；管理员结算（全额 / 部分）后授信恢复；额度 0 的用户维持旧预付逻辑；审计表 `credit_events` | 用户：「现在的用户计费系统改为充值授信的方式，管理员负责结算，结算完授信恢复」 |

## 3. 遗留问题与建议顺序

| ID | 问题 | 建议 |
|---|---|---|
| X-1 | **合规（P-8）**：转卖 Claude / ChatGPT 订阅 OAuth 令牌可能违反厂商条款，直接决定号商订阅账号模式能否上线 | 上线前取得结论；在此之前只启用官方 API Key / 第三方中转账户 |
| X-2 | ~~直连上游的超时信号同样作用于流式响应体，长流会被中断~~ | ✅ 已修复：超时只限制等待响应头（`UPSTREAM_TIMEOUT_MS`），流开始后不再中断 |
| X-3 | 调度状态（粘性、并发计数、OAuth 刷新锁）在网关进程内，只支持单实例 | 量起来再考虑外置 |
| X-4 | Verify 页校验永远失败；TEE 只是 HMAC 桩 | 要么修正算法并说明是对称签名，要么下线该页 |
| X-5 | provider-node 的 Node 版本要求不一致（engines ≥22，安装脚本 / wrapper / doctor ≥20） | ✅ 已切换：运行时强制 Bun（1.4.3），Node 要求不复存在 |
| X-6 | ~~未纳入 git~~，无 CI | ✅ git 已建（2026-10-17）；备份：主/worker 互备 6 h 定时器、探针 10 min、observe 脚本（operations.md §5/§7）；CI 仍无 |
| X-7 | ~~生产仍是 v2~~ v3 + 协议 v2 已全部上线（2026-10-15） | ✅ 已发布；nginx `/internal/` 放行、CF WS HTTP/1.1 均已落实 |
| X-8 | 会话 token 明文存库；主钥无轮换；管理操作无审计 | 后续加固 |
| X-9 | 透支：后结算允许单请求把余额扣成负数 | 需要时加单请求上限或预扣 |
| X-10 | CCR/worker 翻译层能力折损（thinking 不透传、强制 tool_choice 不支持、多轮折叠、首轮延迟高、采样参数被忽略） | 2026-10-17 起按 `worker-sessions.md` 分期补：阶段 1 持久会话已上线（首 token 4.5 s → 1 s 级、多轮缓存命中）；阶段 2 原生工具、3 thinking、4 document 待做；`max_tokens/temperature` 在 `claude -p` 形态下无解，文档写明 |
| X-11 | CCR 事件流 schema 未首抓（`ccr-supply.md` 附录 A 空） | 授权接入管线就绪后用测试账号跑 M2 PoC 补齐；翻译层已按临时假设实现，核对清单在附录 A（A1–A7） |
| X-12 | ~~CCR 会话复用策略未定~~ | ✅ 2026-10-16 拍板并实现：粘性键会话池 + archive 释放（`ccr-supply.md` §5.3；池单测 + ccr e2e 池段全绿） |
| X-13 | 授权接入管线 | ✅ 2026-10-18 sessionKey 非浏览器直连落地（`onboarding.md` §2.1）；浏览器 bot 删除 |
| X-14 | CCR 会话驱动器落位：契约原写 console，实现放在 gateway（与翻译层同进程） | 已按实现更新 `ccr-supply.md` §8；若后续要经号商节点出口，复用 `fetchViaTunnel`，不必搬回 console |
| X-15 | CCR 窗口耗尽在会话 API 上的信号未知 | 附录 A5；A6（usage 字段名）已由 sub2api 源码证实。2026-10-15 按 sub2api 移植：粘性键三级来源、响应头被动采样、429 按被拒窗口冷却、阈值百分比停调、console 令牌保活（`gateway.md` §3/§5.1） |
| X-17 | 生产「1day 核心节点」410 个代理中 405 个 socks5 全部"失效"：Bun 1.4.3 fetch 不支持 SOCKS 代理；且节点心跳把未探测/失败都报 `live=false` 且不带原因 | ✅ 2026-10-15 修复：节点内置 SOCKS5→HTTP CONNECT 桥（`socks5-bridge.ts`，Bun 测试 `apps/provider-node/test/`），心跳上报 `live: null|bool` + `error`，探测并发限 8、池替换后排队重探 |
| X-18 | 全系统核对（2026-10-15，文档 vs 代码）发现并已修：① `parseUsageSnapshot` 把 usage 探测的百分比按 0..1 解析（0.5% 会被当成 50%）；② console 保活刷新对 `route=node` 账户从平台直连而非经节点（违反 onboarding §1 一号一代理）；③ 节点 `doctor` 仍检查 Node ≥ 20，而运行时是 Bun；④ fake-node 只有 v1（X-16）。另修正文档陈述：gateway.md §8/§9（v1 隧道描述）、operations.md §2/§6（`UPSTREAM_*`、`PROVIDER_TUNNEL_ENABLED`、"节点不在服务器"）、provider-node.md（模块表 / 能力 / 心跳 / deadline / doctor）、console-api.md（窗口字段、settings 键、NodeRow）、errors.md（新错误码）、development.md、README（加 onboarding.md） | ✅ 代码已修并通过全部 5 套 e2e；文档已更新 |
| X-19 | 仍待处理（核对中发现、未改）：① 网关懒刷新与 CCR 建环境 / 建会话仍从网关直连（onboarding §6.2 要求经节点钉死代理；core `oauth.ts` 已有 transport 参数，网关侧接线由上号工作流承接）；② 节点代理粘性仍按账号哈希分配，`bound_proxy_id` 钉死语义需 http_egress spec 带 `proxyId`（onboarding §6.2）；③ `/internal/provider/credentials` 只列 `owner_id=号商` 的账户，平台节点的本地控制台看不到自己承载的账号；④ 「1day 核心节点」无 systemd 托管；⑤ 服务器 `/opt/1dayapi/console/` 残留目录；⑥ provider-node 的 install.sh / Dockerfile / CLI wrapper 仍是 Node 时代产物，与 Bun bundle 部署不一致 | 按上号工作流推进时一并处理 |
| X-16 | ~~`tests/e2e/node.test.mjs` 三项失败：fake-node 只实现 v1 中继~~ | ✅ 2026-10-15 fake-node 补了 `http_egress.open/data/close`（spec 行 → fetch → 头行 + body），node 套件恢复全绿 |

| X-20 | 双模路由（`ccr-supply.md` §5.2）实现细节：判定只看自报 UA（`isClaudeCodeUa`，`claude-cli|claude-code/` 前缀）——可伪造，但伪造结果只是拿到订阅 token 的真实直连行为，平台无额外风险；`modeFor` 加 `ccClient` 参数，CC 客户端 + `executor=ccr` 落到既有直连矩阵（`passthrough-anthropic`/`chat-via-anthropic`），不经翻译层。同时 X-19 ①② 已闭环：懒刷新与 CCR 会话 API 对 `route=node` 的 ccr 账户经隧道钉 `bound_proxy_id` 出网（core `oauth.ts` transport + http_egress spec/open 信封 `proxyId` + `ProxyPool.getPinned`）；绑定代理钉死对**一切**平台侧请求生效（含直连 Messages，onboarding §1） | ✅ 2026-10-16 实现，单测（gateway dual-mode）+ e2e（ccr 套件双模段）通过 |
| X-21 | 管理端「上游账户」页重做（2026-10-15）：`GET /api/admin/accounts` 改为分页接口（`kind=api\|subscription`、`sort/order`、`nodeId` 过滤、`counts`），每行带 `usage`（5h/7d/30d/累计 请求·费用·token、rpm、errors24h）与 `inFlight`；网关新增 `GET /internal/inflight`（内部令牌）供 console 回环读实时在途数（`GATEWAY_URL`，缺省 8400，e2e 由 run.sh 指到 18400）。页面：API / 订阅两个标签、服务端分页与排序、勾选批量启停删、5H/7D 水位条 + 重置倒计时环、连接数/RPM 条、费用与请求分栏、出口（直连 / 节点 + 绑定代理）、添加与最近使用时间。e2e console 套件加了 3 条分页检查。同日 ccr / worker 套件各有 2–3 条失败（`cache_read_input_tokens` 期望 4 实得 0，`usageEstimated=true`），出自 `apps/gateway/src/ccr/translate.ts` 当时正在进行的改动，与本项无关 | ✅ 代码与文档已更新；未部署（等 X-20 / 上号工作流落地后一起发） |
| X-22 | 全项目代码审计（2026-10-15，三路并行：网关+core / 控制台+上号 / 节点）后修复，全部有单测或 e2e 覆盖：**网关** ① 流在终止符前出错（`event: error` / `{error}` 块 / 执行器错误）或读流异常仍按估算用量结算扣费 → 改为不结算、写 `502 upstream_stream_error`、账户 transient 冷却，转换模式下向客户端发本方言错误且不发正常终止符；② 非流式 body 读失败是无记录的 500 → 502 + 用量行 + 冷却；③ 客户端断开不取消上游读取、流无空闲超时 → 取消 + `STREAM_IDLE_TIMEOUT_MS`；④ gzip/br 解码 `pipe()` 不转发源错误 → 永久挂死已修；⑤ CCR 会话 API 400/404 透传给客户端且账户永不冷却 → 冷却换账户，环境被拒清掉重建；⑥ 只有 executor=ccr 的刷新走节点 → 所有 route=node 账户；⑦ 翻译层空文本块复用 index、message_start 的 output_tokens 多算 1；⑧ chat→anthropic 同时带 temperature 与 top_p。**节点/协议** ⑨ 15 s 的 spec 期限被当响应头超时，经节点的非流式长请求必死 → 分离 `headersTimeoutMs`；⑩ 代理池只在 PUT/部署时推送，重连不同步 → hello 后推送；⑪ 任何 fetch 失败都把代理标 dead → 只认代理层失败，否则立即重探；⑫ 节点重启全部代理翻 unknown 致绑定账户整批停调 → 平台保留上次结论；⑬ CONNECTING 时 reconnectNow 打死进程；⑭ 双向无保活（半开连接） → ping/pong + 90 s；⑮ 重连取代旧连接时旧会话悬挂、会话帧不校验来源节点；⑯ spec 无 `method`；⑰ 头行带已失效的 content-encoding/length；⑱ 回环 socks 桥是本机开放代理 → 令牌；⑲ cc_worker 提示词走 argv（可见 + 128 KiB 上限）、进程树不杀、排队会话不可撤、NO_PROXY 可绕过钉死代理；⑳ 本地控制台写请求非回环可达。**控制台** ㉑ accounts↔node_proxies 循环外键无 ON DELETE：有绑定账号后改代理池 / 删节点 / 删号商全部 500（删节点还留半截状态） → 替换保留绑定且拒删已绑定代理（`proxy_bound`）、删节点/删号商同事务释放；㉒ 上号不预留代理，并发任务抢同一条、输家在真实授权后才失败 → 创建即预留；㉓ 管理员在号商节点上号得到平台自有账号绕过归属规则 → 按节点归属；㉔ 平台节点上传的凭证归管理员用户并产生分成 → 平台自有；㉕ bot 参数（sessionKey / 代理口令 / PKCE）走 argv、超时只杀 xvfb-run → stdin + 进程组；㉖ SSH 部署 host/username 未校验（`-o…` 注入）；㉗ 巡检 tick 可重叠、保活含已驳回/出错账户；㉘ 任务永不过期、重启后永久 working → 清扫；㉙ 号商 PATCH 能改 OAuth 令牌/平台、status 被覆盖；㉚ 管理员 PATCH 给 nodeId 不给 route 留下脏数据；㉛ 登录限流 map 无上界；㉜ 节点密钥非恒时比较；㉝ 缺索引（迁移 6）。**未改（记录）**：粘性缓存无硬上限（>2 万活跃会话才有感）；经隧道的 CCR 轮询超时沿用 300 s；候选全被并发门拒时报 400 而非 503；cc_worker 侧 Claude Code 自行轮换的刷新令牌不回传平台（厂商行为待证实）；非 anthropic 域名不做指纹回退；裸 code 回调跳过 state 校验 | ✅ 2026-10-15 代码、测试、文档；bot 脚本改为 `--args-stdin`，部署时需同步更新服务器 `/opt/ccr-lab/onboard_bot.py` |
| X-23（2026-10-17） | **流式请求漏计费回归**：`144faa3`（CC 鉴权失败分类）在 `deliverStream` 的结算分支前插入 `else if (completed) { authFailures.clear() }`，正常结束的流式请求再也不走 `settleSuccess`——约 10:50Z 上线到 20:30Z 修复，期间所有 message_stop / [DONE] 正常结束的流都无 usage 行、不扣费（worker 路径核对：130 条、上游表价约 $3.5；直连路径未量化；非流式不受影响）。靶场：真实编程任务 4 个 200 响应在 usage_logs 里一条都没有。日志只有 request_id/账号/用量，没有 api key，**无法事后补账** | ✅ `d0be6be` 修复 + e2e billing 新增"正常结束的流必须结算"用例。教训：e2e 套件已失修（gpt-5.5 下线、基线语义变化导致十余项红），红了没人看，回归无人拦；需要修回绿并在部署前跑 |
| X-24（2026-10-17） | **原生工具并行调用卡 60 s**：Claude Code 对 MCP 工具默认串行（`isConcurrencySafe = annotations.readOnlyHint`），第 1 个挂起等客户结果、第 2 个要等 60 s MCP 超时才发出，网关等齐全部挂起调用才返回；超时的调用给模型错误结果。真实 agent 任务首轮 64 s、模型重复 list_files、第三轮被 300 s idle 掐断 | ✅ `cb86130`：节点 MCP `tools/list` 声明 `readOnlyHint:true`、`MCP_TOOL_TIMEOUT=600000`、`CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY=50`；网关 3 s 兜底不再死等。复测：10 个并行 read_file 一轮 2.8 s 全部挂起并返回 |
| X-25（2026-10-18） | **大请求在直连路径 503 空转**：Claude Desktop（agent-sdk，key「cc企业池」）上下文 ~50 万 token，请求体 > ~6 MB；节点 http_egress 的 spec 上限 8 MiB（body 经 base64 ×4/3）拒绝 `spec_too_large`，网关把它当成"节点不可用"逐个账号重试 ~30 个（17 s）后报 503 `no_available_account`，客户端每 20 s 重试 → 1 小时 154 个 503；nginx `client_max_body_size 10m` 则把更大的直接 413 | ✅ `addbb26`：节点 MAX_SPEC_BYTES 48 MiB + spec 拼接改为只在新帧找换行（原实现每帧全量 concat，O(n²)）；网关把 `spec_too_large/bad_spec/bad_url/target_not_allowed` 视为请求级错误（`TunnelRequestError`）立即 413/400、不再遍历账号；nginx 两个 vhost `client_max_body_size 10m → 32m`（备份在 `/etc/nginx/backup/`）。实测 10 MB / 31 MB CC 形态请求端到端送达上游，分别收到 Anthropic 自己的 400「prompt is too long」/「too many total text bytes: 32506033 > 32000000」——链路上限已与官方一致 |
| X-26（2026-10-18） | **ztest 深度检测 40 分**（key「daydreaming.work」，模型 claude-fable-5，报告 01M577X2…）：探针是冒用 CC UA、缺 billing_header/metadata 的普通 API 请求，被形态闸门判 suspect 降级到 worker，失分全是 worker 翻译痕迹（直连路径同项全过，D3/D11 身份判定一致）。逐项复现：D17 自造 id 带下划线不符 `^msg_[A-Za-z0-9]+$`；D7 fable + max_tokens≤300 非流式工具参数为空（≥1500 正常，sonnet 不受影响）；D19 及一批 502 是账号触发安全分类器后 CC 的 refusal-fallback 静默切到 Opus 并泄露该名；D21 worker 接受 `thinking:disabled`（真 fable/opus-5.5/sonnet-5.5 均 400 拒）；S1 CC 脚手架计入输入且流式/非流式口径不一（同请求流式 199、非流式 1141）；D8 子进程结构性延迟；另发现子进程把底层订阅账号邮箱带进回答 | ✅ 两项上线（gateway 重建 + 节点 bundle 8f258e87aecb 到 worker-01/02）：翻译器 id 改 `msg_`/`toolu_` + 24 位 base62（`anthropicId()`，测试断言形状）；子进程环境加 `CLAUDE_CODE_NO_MODEL_FALLBACK=1`，所请求模型被拒/不可用时把它的原始结果发回调用方、绝不换模型（用户："把原文发回用户，用户允许就替换，正常 claude code 也是这样"）。❌ 暂不做（用户）：工具轮给子进程设 max_tokens 下限（D7）。待定：S1 口径与基线、D21 按模型校验、邮箱注入抑制、D8 |

建议顺序（2026-10-15 版）：X-1 合规结论 → X-6 工程基线 → ~~X-7 发布 v3~~ → M1 授权接入管线（X-13）→ M2 全链路 PoC（X-11/X-12）→ X-4 修复 → 其余改进。

**下一阶段（2026-10-17 起）**：`worker-sessions.md` 阶段 2 原生工具 → 阶段 3 thinking → 阶段 4 document（§7 开工清单）；
并行小项：心跳 `ccWorker.pool` 透传到 console `deploy_meta` 与节点页、探活失败 strike 60 s 最小间隔、持久进程第 2 轮多出的
约 3.8k 上下文抓包核实、Cloudflare 1010 规则对裸 `Python-urllib` UA 的 403 是否放开、X-4 Verify 页、X-8 加固。
