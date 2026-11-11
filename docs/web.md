# 前端（apps/web，v3）

> Vite 5 + React 18 + react-router-dom 6 + Tailwind 3 + TypeScript。代码：`apps/web/src/`。
> 生产为静态产物（`apps/web/dist`），nginx 托管并对未知路径回退 `index.html`。
> v3 只重做了**三角色控制台**（`/console`），公开站点视觉不变。

## 1. 结构

```
src/
  main.tsx            挂载 <BrowserRouter>，包 ThemeProvider / I18nProvider / AuthProvider
  App.tsx             路由：consoleRoutes（独立外壳）+ 公开站点（挂在 <Layout> 下）
  components/         Layout（公开站点顶栏 / 页脚）、AuthShell、CodeBlock、Icon
  lib/api.ts          apiFetch / ApiError / unwrap / listData，公开页类型，AuthMe
  lib/auth.tsx        AuthProvider：GET /auth/me、refresh、logout、roleFromKey
  i18n/               公开站点字典 en.ts / zh.ts + useT()
  theme.tsx           light / dark
  pages/              公开页面
  console/            v3 控制台（见 §3）
```

## 2. 公开站点路由

| 路径 | 组件 | 数据来源 | 说明 |
|---|---|---|---|
| `/` | Home | 静态 | 营销首页（不变） |
| `/models` | Models | `GET /api/models` + `/api/models/pricing` | 全部启用模型；v3 起不再按登录用户分组过滤（按分组看可用模型在控制台） |
| `/pricing` | Pricing | `GET /api/models/pricing` | 价格表 |
| `/docs` | Docs | 静态 | 快速上手，示例 Key 为 `sk-1d-…`；网关地址按域名生成（`*.1dayapi.com` → `https://api.1dayapi.com`，否则 `http://localhost:8400`） |
| `/docs/endpoints` | DocsEndpoints | 静态 | 网关端点 + v3 控制台主要端点 |
| `/tech` | Tech | 纯前端 | 技术说明：请求执行方式、worker / TUI 节点、检测项差异（见 §6）；旧地址 `/tools/verify` 跳转到这里 |
| `/tools/claude-api-cost-calculator` | CostCalculator | `GET /api/models/pricing` | 费用计算器 |
| `/provider` | Provider | 静态 | 号商介绍，按钮进 `/console` |
| `/login` | Login | `POST /auth/login` | 只粘贴登录密钥；提示"不开放注册，账户由管理员开通"；粘贴 `sk-1d-` 时提示应使用登录密钥；登录后跳 `?next=` 或 `/console` |
| `/register`、`/referral` | — | — | 重定向到 `/login`、`/` |
| `/dashboard/*` | — | — | 重定向到 `/console` |
| `*` | NotFound | — | |

顶栏导航：首页、模型、API 文档、验证、价格、号商（推荐入口已删除）；登录后右上角进入 `/console`。

## 3. 控制台 `/console`

文件：

| 文件 | 内容 |
|---|---|
| `console/routes.tsx` | `/console/*` 路由树；`/console` 首页按角色渲染（admin 仪表盘 / provider 概览 / consumer 概览），`/console/guide` 同理 |
| `console/ConsoleLayout.tsx` | 外壳：左侧导航（桌面固定，移动端抽屉）、角色徽章 + 名称 + 余额（号商显示"待结算"）、顶栏语言 / 主题 / 退出、`/api/site` 公告条；未登录跳 `/login?next=…`；`RoleGate` 角色守卫 |
| `console/ui.tsx` | UI 组件库（基于站点设计令牌 `card` / `wk-btn` / `wk-table` / `input`）：PageHeader、Card、StatCard、Badge / StatusBadge、Button、Field / Input / Select / Textarea / Toggle / ChipSelect、DataTable、Pagination、Toolbar、Modal、ConfirmButton、Segmented、KV、ProgressBar、CopyButton、SecretBox（一次性明文）、CodeBlock、Loading / ErrorState / EmptyState / Async、useAsync、Toast（useToast）及格式化函数 |
| `console/charts.tsx` | 无依赖 SVG 图表：BarChart（按天）、ShareBars（Top N） |
| `console/api.ts` | `api.get/post/patch/put/del`（自动解 `{data}`）与全部控制台响应类型、平台列表 `PLATFORMS` |
| `console/i18n/` | 控制台字典，按区域分文件：`common.ts`（外壳、导航、通用词、状态）、`user.ts`、`provider.ts`、`admin.ts`、`admin2.ts`；每个文件导出 `{en, zh}` 扁平键，`useCT()` 合并查找，缺词回退英文再回退键名 |
| `console/pages/{user,provider,admin}/` | 各角色页面 |

菜单（`menuFor(role)`）：

| 角色 | 菜单 → 路径 |
|---|---|
| consumer | 概览 `/console` · API 密钥 `/keys` · 使用记录 `/usage` · 钱包 `/wallet` · 可用模型 `/models` · 接入指南 `/guide` |
| provider | 概览 `/console` · 节点 `/nodes` · 上游账户 `/accounts` · 收益明细 `/earnings` · 结算记录 `/settlements` · 接入指南 `/guide` |
| admin | 运营管理：仪表盘 `/console` · 用户 `/admin/users` · API 密钥 `/admin/keys` · 分组 `/admin/groups` · 上游账户 `/admin/accounts` · 模型定价 `/admin/models` · 兑换码 `/admin/redeem` · 使用记录 `/admin/usage` · 节点 `/admin/nodes`；我的账户：API 密钥 `/keys` · 使用记录 `/usage`；系统：设置 `/admin/settings` |

（路径省略 `/console` 前缀。）`/wallet` 仅 consumer；`/keys`、`/usage`、`/models` 允许 consumer 与 admin；号商页面仅 provider；
`/admin/*` 仅 admin。越权访问重定向到 `/console`。页面调用的接口见 `console-api.md`。

admin 上游账户页 `/admin/accounts`：新建 / 编辑表单在 `type=oauth` 时多出 orgUuid、environmentId 输入（可选），且在 `platform=anthropic` 时可选「执行器」（直连 / 云端会话 CCR，
见 ccr-supply.md）；列表里 ccr 账户带执行器徽标并显示窗口水位（已用百分比进度条 + 相对重置时间，未巡检显示"窗口尚未巡检"），`windowExhaustedUntil` 在未来时显示"窗口耗尽"徽标；
ccr 行多一个「刷新水位」按钮（`POST /api/admin/accounts/:id/window`），结果就地更新该行，不整页重载。

admin 用户页 `/admin/users`（2026-10-23 改版）：表格不再横向滚动——每行两行式单元格：用户（名称 + 角色徽标 + 非活跃状态 + 密钥前缀/备注）、可用额度（下行授信/待结或预付）、近 30 天（费用，下行请求数 / 密钥数 / 伪造 CC）、最近访问（`lastRequestAt` 相对时间，下行最近登录）、创建日期、详情。
`?open=<userId>` 直接打开该用户详情（财务面板的客户链接用）。详情弹窗多一个「消耗」标签页：该用户各密钥按小时 / 按天的消耗（`pages/admin/_consumption.tsx` 的 `ConsumptionPanel`，今天 / 昨天 / 近 7 天 / 近 30 天）。

admin 财务页 `/admin/finance`「消耗明细」卡（2026-10-23）：数据来自 `GET /api/admin/usage/breakdown`，随页面日期范围；按小时 / 按天切换（小时视图只取范围内最近 7 天，本地时间标注；天按 UTC），费用 / 请求数切换；上方合计 / 请求 / 活跃客户 / 峰值四个数字 + 汇总柱图，下方每个客户一行热力条（色深相对该行自身峰值）+ 费用 / 请求（失败数）/ Token / 最近访问，点开看逐桶明细表，可导出 CSV。
网页是静态文件，控制台若还是旧版本（接口 404）该卡显示「暂不可用」提示而不是报错。客户表的名称下行也带最近访问时间。

admin 节点页 `/admin/nodes`（协议 v2；2026-10-23 改为卡片）：顶部 4 张汇总卡（在线节点、在途请求、账号 / 容量、代理池总数），每个节点一张卡（`pages/shared/NodeCard.tsx`，号商节点页复用）：
头部状态点（在线时呼吸动画）+ 名称 + 在线 / 排空 / 平台或号商徽标 + 节点 id，右侧最近心跳与 OS/arch；四格数字（在途、账号/容量 + 进度条、代理数（为 0 时黄色警示）、版本）；
底部部署信息（方式徽标 + host:port + 部署时间，失败时红框并显示原因；绑定码接入的显示绑定时间）与操作（容量、代理池、添加账号、移除）。
旧表格描述：节点表含容量用量（accountCount/capacity + ProgressBar）、代理数、部署元数据（deployMeta：method/host/失败原因）；
「部署节点」弹窗走 SSH（密码 / 私钥切换、初始代理池 textarea 一行一条 `url [label]`、提交后同步等待并展示 online 状态与部署日志）；
「本机节点」弹窗在控制台主机直接起节点；每行「代理」按钮打开代理池弹窗（脱敏 URL、live/dead 状态、分配账号数，textarea 整体替换保存——
已存密码不回显，需重新输入完整 URL）。

## 4. 与后端通信

- `apiFetch(path, init)`：相对路径 + `credentials:"include"`；非 2xx 解析 `{error:{code,message}}` 抛 `ApiError{status, code, message}`。
- 控制台只靠会话 cookie；SPA **从不调用网关**。
- 开发：`vite.config.ts` 把 `/api`、`/auth` 代理到 `CONSOLE_PROXY`（默认 `http://localhost:8401`）；dev 端口 `WEB_PORT`（默认 8402）。
  例如联调隔离测试栈：`CONSOLE_PROXY=http://127.0.0.1:18401 pnpm dev:web`。
- 生产：同源，由 nginx 反代 `/api`、`/auth` 到 console。

## 5. 国际化与主题

- 语言 `en` / `zh`：`?lang=` > `localStorage["oneday-lang"]` > `en`。公开站点用 `useT()`（`i18n/`），控制台用 `useCT()`（`console/i18n/`），共享同一个语言状态。
- 主题：`data-theme` + `localStorage["oneday-theme"]`，默认 dark；颜色全部是 CSS 变量。

## 6. 技术说明页（`/tech`，2026-11-11 取代 Verify 页）

- 导航「验证」改为「技术说明」；原 Verify 页（TEE 证明解析，HMAC 校验因算法不一致永远失败，X-4）及其文案已删除，`/tools/verify` 跳转到 `/tech`。
- 内容：请求路径、worker 节点（一号一出口 / 一号一设备 / 组织隔离 / system 追加 / 工具由调用方执行 / 不换模型 / 额度窗口）、
  TUI 交互模式（做法、原因、代价、回落）、常见检测项为何对不上（消息 ID、思考签名、Token 用量、身份、采样参数、首字延迟）、
  为什么不为检测分数改动上游可见的东西（避免烧号）、更有意义的验证方式、不适合的场景。
- 中英文长文案写在 `apps/web/src/pages/Tech.tsx` 里（按 `lang` 取），不进 i18n 字典；改运行方式时要同步改这一页。
- 首页「信任」区块的按钮与页脚链接指向本页；该区块正文仍是 TEE / 加密证明的旧说法，与本页不一致，待运营方决定是否改写。

## 7. 构建

`pnpm --filter @1dayapi/web build` = `tsc -b && vite build`。无路由级代码分割、无 SSR。

- 节点页每行有「添加账号」：打开上游账户表单并预填「经节点出网 + 固定到该节点 + 归属号商」；上游账户表单里固定节点改为下拉选择（名称 · 号商 · 在线状态 · 账号数/容量），选节点后归属号商自动跟随（平台节点 → 平台自有）；节点页号商列对管理员部署的节点显示「平台节点」。
- 上游账户表单的「出网方式」合并为一个下拉：直连 / 归属号商任一在线节点 / 指定节点（节点 · 名称 · 平台或号商 · 在线状态 · 账号数/容量）；列表的归属列显示经哪个节点；「测试」对经节点的账号也可用，结果里显示接单节点。

## 节点监控（管理员，`/console/admin/node-monitor`，2026-10-17）

仪表盘「在线节点」卡片可点击进入，导航「节点监控」。顶部 6 张汇总卡（在线节点、在途请求、常驻会话 忙/空闲/停泊、活跃账号、代理存活、
近 1 小时请求）+ 每节点一张卡（2026-10-23 改版，在线优先、按 1h 请求量排序）：
- 头部：状态点（健康时呼吸动画）+ 节点名（`deployMeta.name`，接口 `name` 字段；旧 console 没有时退回号商名 / id）+ 健康徽标 + 平台 / 号商徽标 +
  节点 id + 版本芯片（节点版本、构建指纹、Bun、Claude Code）；右侧最近心跳（相对时间，过期标黄）、进程 / 主机运行时长、「节点页」链接。
- 六个仪表（在线且有心跳指标时）：内存、负载（load1 / CPU 数）、常驻会话 / 上限、账号 / 容量、代理存活 / 总数、在途 / worker 上限，每个带百分比与
  阈值着色进度条（≥75% 黄、≥90% 红；代理有失效黄、全失效红；账号有不在正常代理上的标黄），下行是忙/空闲/停泊、代理正常/冷却、失效/未探测等补充。
  离线或无指标的节点只显示一行提示 + 容量 / 代理 / 在途三个平台侧数字。
- 底部流量条：1h 请求（错误数与错误率，>5% 红）、1h 平均耗时（>15 s 黄）、24h 请求、24h 计费（下行退休统计）。
健康徽标：健康 / 离线 / 心跳过期 / 排空中 / 不接新会话 / worker 不可用 / 内存偏高；心跳过期或离线的卡边框按色调描边。
数据源 `GET /api/admin/nodes/monitor`，页面每 15 秒刷新（`pages/admin/NodeMonitor.tsx`）。

## 错误日志（管理员，`/console/admin/errors`，2026-10-16）

仪表盘「今日错误」卡片可点击进入。页面 = 过滤栏（范围：今天 / 7 天 / 30 天 / 自定义；错误码、路径、账号下拉由汇总接口填充；
搜索框匹配报错内容 / 错误码 / 请求 ID）+ 四张统计卡（失败数、错误率、最常见错误、涉及账号）+ 每小时失败柱状图 + 按错误码 / 账号 / 路径
占比 + 分页表（25 条/页；列：时间、结果、发生了什么、用户 / 密钥、模型、路径、账号 / 节点、耗时）。点击报错内容或「详情」弹出完整信息
（请求 ID、上游响应状态、完整报错、Claude Code 形态等）。数据源 `GET /api/admin/usage?status=error…` 与 `GET /api/admin/errors/summary`。

## 使用记录页的通道与原因标记（管理员，2026-10-16）

「使用记录」表新增「通道」列（共享组件 `pages/admin/_path.tsx`）：`passthrough-*` → 直连，`chat-via-anthropic` / `anthropic-via-chat` → 直连 · 协议转换，
`ccr-*` → 按账号当前 executor 显示 worker 或 云端会话（前端用 `/api/admin/accounts` 的 executor 映射），无 mode 的历史行显示"未路由"。
「结果」列对失败行显示错误码下方的具体原因（`errorMessage`，两行截断，悬停看全文）和上游 HTTP 状态；账号列附节点后 8 位。错误日志页复用同一组件。
