# 铁律（运营方 2026-11-01 定，所有人、所有会话、所有发布必须遵守）

> 本文是规则的权威版本，随代码发布到服务器 `/opt/1dayapi/docs/iron-rules.md`。改规则 = 改本文 + 用户确认。
> 各规则的实现位置、开关与验证方法都写在下面，便于复核"系统是否真的照规则运行"。

## 铁律 1：订阅账号代理不通 → 账号冻结，人工解除

**规则**：订阅账号的绑定代理批不通时，暂停该账号的**一切**请求；不得私下换 IP，不得直连；账号直接变为不可用状态（`proxy_down`），
除非人工解除（代理已恢复）或人工更换 IP；控制台与巡检要有明显、带时间的提醒，直到清零。

**实现**（2026-11-01，`1520b81`）：
- 状态：`accounts.status='proxy_down'` + `proxy_down_since / proxy_down_reason / proxy_down_proxy_id`（迁移 33）。`listCandidates`、窗口巡检、保活都只选 `status='active'`，冻结即不调度。
- 触发：① 节点心跳判代理 dead（连续 2 次探测失败，`PROXY_DEAD_AFTER` 默认 2）；② 节点拒绝固定代理 `no_proxy_available`；③ 实测出口 IP 变化 / 与其他组织冲突 / 被隔离 / 超容量。
  节点侧无绑定旧账号的 sticky 代理死掉也不再改派（`pickForAccount` 返回 null）。
- 解除：仅 `POST /api/admin/accounts/:id/proxy-release`（要求代理 live 且对该账号可调度，否则拒绝并说明）或 `POST …/proxy-rebind`（同组织、同节点、容量校验）；`PATCH status=active` 对冻结账号返回 400 `proxy_down_use_release`。
- 提醒：账号列表橙色「代理失联」徽标（自何时、已多久、原因、代理、出口）、账号页横幅、首页横幅、`1day-health` 的 `proxy_down` 行、`proxy-down-alert.py` 每小时重复直到清零。
- 事件：`proxy_team_events.account_frozen_proxy_down / account_proxy_released`。
- 验证：`apps/console/test/proxy-freeze.test.mjs`（7 个场景）；线上 `SELECT name,proxy_down_since,proxy_down_reason FROM accounts WHERE status='proxy_down'`。

## 铁律 2：上游可见的改动必须经灰度测试组

**起因（已查明）**：2026-11-01 09:40 的发布在直连路径上把"删客户 `# userEmail` reminder"放在了**计费头后缀算完之后**。后缀是 Anthropic 对
"收到的首条用户文本"做的防伪校验码（第 4/7/20 个字符 + 版本哈希）；客户把 reminder 和很短的提示词放在同一个文本块时，删掉 reminder 改变了被哈希的字符，
后缀对不上 → Anthropic 回 `429 {"type":"rate_limit_error","message":"Error"}`（伪造 Claude Code 请求的标准拒绝；此前 7 天 0 次，发布后 3.5 分钟出现第一条）。
网关又把这个 429 当账号级限流换号重试，31 条请求 × 21 个账号 = 651 次，把同一条校验失败的请求轮流打到组织里每个号上，42 分钟后组织被停用 Claude Code 订阅访问。
修复：所有改体先做、后缀最后按出站 messages 重算（`alignBillingSuffix`），不会算后缀的版本禁止改首条用户文本；不变量测试 `apps/gateway/test/billing-suffix-invariant.test.mjs`
（7 种首条消息布局 × 8 种开关组合 × 3 个客户版本 × 2 种入口，出站后缀必须等于 `ccBuildSuffix(出站 messages)`）。

**规则**：
1. 任何**上游可见**的改动——请求头、请求体、UA、计费头、`metadata`、`# Environment`、系统提示词措辞、历史转发量、令牌刷新/探测节奏、代理与设备身份——
   必须放在**三态开关**后面：`0`（老行为）/ `canary`（只对灰度组）/ `1`（全量）。**默认 = 老行为**，不得直接改默认。
2. 新行为先只对「灰度测试」账号组开启（settings `canary_group_id` 指向 `groups` 里的那一行；Key 属于该组或被选中的账号属于该组才吃到 `canary`）。
3. 灰度组必须接**真实流量**：把当时有流量的真实用户 Key 迁入灰度组（`ops/bin/canary-move-keys move <key_id>…`，原组自动记录、可一键回退），再加测试 Key 的探针。
   **只有探针（每小时几条「回复 OK」）不算观察**（2026-11-02 教训：灰度 7.5 小时只跑了探针，等于没灰度）。观察 **≥ 24 小时**（从真实流量接入那一刻计时）：
   `profile` / `roles` 正常、窗口与错误率无异常、没有任何组织级错误文本（`organization has disabled` / `suspended for this organization`），
   `ops/bin/canary-report` 的 VERDICT 干净，再切 `1`。观察记录（报表输出）写进发布记录。流程细节见 `docs/operations.md §7.3`。
4. 没有灰度组、没有观察记录的上游可见改动，一律不得发布。一天最多一轮发布，发布后至少观察 2 小时再做下一件事。
5. 发布前必须有可一键回滚的 dist 快照（`backups/pre-<name>-<ts>-dist.tgz`），发布记录写明快照名与回滚命令。

**实现**（2026-11-01）：
- 开关解析：`packages/core/src/canary.ts`（`featureFor(key, {groupId, accountId})`）。当前三态开关：
  | 开关 | 新行为 | 默认 |
  |---|---|---|
  | `direct_cc_entrypoint_normalize` | 放行客户自定义 UA 入口并改写成 `(external, cli)` 走直连 | `0` |
  | `direct_strip_user_email` | 直连删掉客户 `# userEmail` reminder | `0` |
  | `direct_cc_canonical_fields` | oauth beta 插到 claude-code 之后；`metadata.user_id` 键序重建 | `0` |
  | `worker_prompt_hide_platform_path` | worker 提示词不出现 `/var/lib/1dayapi-cc-worker` | `0` |
  | `history_policy_default` / `history_policy_canary` | Key 默认历史策略；灰度组 Key 用 canary 值 | `reset` / 空 |
  | `direct_profile_strict` | 直连不跨版本 pin、未知 profile 不直连、出站再校验同 profile（spec WP1） | `0` |
  | `cc_client_response_profile` | 对 Claude Code UA 不下发 `x-1day-*` 诊断头（只影响下游） | `0` |
  | `key_policy_auto` | Key 策略判断器的 auto 层生效（spec §6.2 / WP8） | `0` |
  | `canonical_history_import` | canonical 新会话导入外部历史（CC transcript 形态、剥 thinking，spec WP3 / G3） | `0` |
  | `canonical_cc_client_compat` | canonical 对真 CC 客户的兼容修补（X-42）：活轮尾部 `role:system` 当活轮尾巴不再回落 legacy；带客户 tools 的会话 `tools-disabled-canonical`（`--tools ""`）；加强版环境说明 | `0` |
  | `raw_preserve_headers` | 原样透传账号到节点出口不补 Claude Code 指纹头（raw-v1，spec WP5.4） | `0` |
  | `telemetry_evidence_required` | native-required 的 Key 开 canonical 会话前要求账号×profile 遥测证据 ≥ secondary（spec §6.4 / WP6） | `0` |
  | `worker_canonical` | 车道 B canonical 进程：节点官方 CC 原生身份 + `--restricted` + caller MCP + 原生 session，客户 system 追加（spec WP2；节点还需 `CC_WORKER_CANONICAL=1`） | `0` |
- 灰度组：控制台「设置 → 灰度测试账号组」选择；账号加入该组 = 账号页编辑分组；测试 Key = 该组下的 consumer Key。
- **开关按谁判定**：直连路径的形态判定与出站整形发生在选号之前，`featureFor` 只拿到 **Key 的组**（`proxy.ts` `strictProfile`、`upstream.ts` `UpstreamShaping`）；
  账号组只在选号之后的分支（CCR 车道、历史策略）参与。因此**把灰度账号加进默认组并不能灰度**——默认组 Key 落到灰度账号上仍走老行为；要让真实流量吃到新行为，
  必须把用户 **Key** 迁入灰度组。待办：选号后按账号组补判一次（spec §6.1 原文），非上游可见，随下一轮发布。
- 真实流量工具链（2026-11-02，`ops/bin/`）：`canary-move-keys`（迁入/回退/状态，记录 `/root/monitor/canary-moved-keys.json`）、`canary-watchdog`（每 5 分钟写
  `/var/log/1dayapi-canary-traffic.log`；灰度账号离开 `active` 即自动把用户 Key 退回原组，不碰账号——铁律 1）、`canary-report`（按灰度账号读 `usage_logs` 出 13 节报表 + VERDICT）、
  `canary-verify` / `canary-cc-probe`（探针）。
- 发布核对：`ops/bin/release-verify` 先用灰度 Key（`/root/monitor/canary-apikey.txt`，如有）发请求，再用常规 Key。
- **出站不变量**：直连请求离开网关前，`system[0]` 计费头的后缀 ≡ `ccBuildSuffix(出站 messages, 版本)`；改体（设备身份、机器环境、删 reminder …）一律在算后缀之前，`alignBillingSuffix` 是最后一步；版本不是 2.1.312（不会算）时不碰首条用户文本（`canEditFirstUserText`）。运行时还有最后一道闸：对不上就原样转发客户 body 并打 `[billing-suffix] mismatch` 日志。
- 验证：`packages/core/test/canary.test.mjs`、`apps/gateway/test/direct-path-hygiene.test.mjs`（开关开/关两种形态）、`apps/gateway/test/billing-suffix-invariant.test.mjs`。

## 铁律 3：请求真实性只能升、不能降（运营方 2026-11-08 定）

**起因**：canonical 车道上线后的几次"可用性修补"各自看起来都合理，合起来却在悄悄改变上游看到的东西：节点 CC 钉在 2.1.312 而线上客户已到 2.1.319；
入口永远是 `sdk-cli`；追加的平台说明文字越来越长；为了修内建工具抢用又要去掉 13 个内建工具。没有一条规则逼着每次改动回答"上游看到的请求是更像真实用户了，还是更不像了"。
平台的最终目标是 canonical 完全替代 legacy，并且**可用性和真实性都更高**；可用性可以用修补追，真实性一旦降了，账号层面的代价是不可逆的。

**定义——"请求真实性"**：上游在**一个账号**上看到的全部东西与**一个真实 Claude Code 用户**的差距，包括：
传输层（UA、`x-app`、stainless 头、`anthropic-beta` 集合与顺序、`anthropic-version`）；计费头与入口标签（`cc_version` / `cc_entrypoint` / 后缀）；
设备、机器、账号身份（`metadata.user_id`、device_id、`# Environment`）；system 前缀（主提示词、identity 块、我方追加的任何文字）；tools 列表与顺序；
消息形态（`role:system` 中途消息、attachments、`cache_control` 标记、thinking 块）；会话连续性（session_id、transcript / `--resume`）；
以及**流量形态**：一个账号上出现的版本数与入口数、版本随时间是否单向前进、并发会话数、请求节奏。

**规则**：
1. **每一次版本变动**——我方发布、节点 Claude Code 升级或钉版、三态开关从 0 切到 canary / 1、提示词或追加文字措辞、路由策略——动手前必须回答一个问题，
   并把答案写进提交说明和 `docs/issues-and-decisions.md` 的对应行：**这次改动让上游看到的请求比改动前更像真实用户（↑）、一样（=）、还是更不像（↓）？**
2. **↓ 默认禁止**。只有运营方明示接受、并在决策登记里写明"接受降低真实性，原因是……"的，才可以做。任何人不得以"客户体验""可用性""省额度"为由默默降真实性。
3. 判定依据是**差分**，不是感觉：用 `tests/e2e/cc-probe` 的捕获器（或 `data/captures` 抓样）比对改动前后上游侧收到的请求——头、system、tools、messages 形态——
   逐项列出差异及其方向。没有差分的改动按 ↓ 处理。
4. 以下一律视为 ↓：伪造或改写入口标签、UA、版本号；向请求加入真实 CC 不会发出的文字或字段；去掉真实 CC 会发出的字段、工具或 beta；
   让一个账号同时呈现多个客户端版本或入口；节点 CC 版本长期落后线上客户主流版本；用非 CC 的工具链（预载脚本、运行时钩子、改请求体）介入 CC 的请求链路；
   把客户自己的真实请求拆开重组后再发。
5. 以下视为 ↑：原样转发客户自己的真实 CC 请求；节点版本跟上主流；去掉我方注入的文字；入口标签回到真实交互入口；一号一设备一版本。
6. 真实性与可用性冲突时，先登记差分，由运营方拍板，再动手。修补可以等，真实性不等人。
7. 每次发布记录必须有一行：`真实性变化：↑ / = / ↓（具体差异）`。没有这一行的发布记录视为不完整。

**对已上线与待上线改动的回溯登记（2026-11-08）**：
- X-40 `CANONICAL_ENV_NOTE`：↓（追加了真实 CC 不会发的平台文字；运营方已接受，为纠正"我在 Linux 沙箱"误答）。
- X-42 ① 活轮尾部 `role:system` 当活轮尾巴：↑（更多真 CC 首轮以原生形态上行，不再被 legacy 折叠成转录）。
- X-42 ② 带客户工具时 `--tools ""`：**↓**（tools 列表少了 13 个内建工具；请求仍由真 CC 以合法参数生成，但这种形态在真实用户里少见）。**运营方 2026-11-08 书面接受（"不用灰度了，直接切吧，现在客户流量都是测试性质的，很少"），生产值 1。**
- X-42 ③ `CANONICAL_ENV_NOTE_V2`：↓（追加文字比 v1 更长）。同上，运营方 2026-11-08 已接受。
- X-42 ④ 流式请求级拒绝不冷却账号：=（只影响我方调度，上游不可见）。
- X-42 ⑤ 上游 refusal 原样下发客户（`stop_reason: "refusal"` + `stop_details`）：=（只影响下游响应形态，上游不可见）。
- X-43 TUI worker（CCR 实例 `tui`）：入口 `sdk-cli`→`cli` ↑；identity 块回到 "Claude Code, Anthropic's official CLI" ↑；beta 列表回到交互集 ↑；节点版本 2.1.312→2.1.319 跟上主流 ↑；tap.js 以 `BUN_OPTIONS --preload` 进入 CC 进程、tee 主轮响应 ↓（只读、不改请求、不改头；运营方 11-08 书面接受："不钩 Bun 运行时、不改请求体、不改标签 这个限制可以放宽"）。

## 附：请求级拒绝不扩散（已做，2026-11-01，spec I12）

上游裸 `429 {"type":"rate_limit_error","message":"Error"}`（事故里的那条）现在在 `classifyDirectRateLimit` 归 **请求级** `upstream_request_rejected`：只答一次，不冷却账号、不换号重试。
验证：`packages/core/test/key-policy-auto.test.mjs`（I12 用例）。此前它被当账号级限流，一条坏请求被轮到 21 个账号上 651 次。

## 附：组织级熔断（已做，2026-11-01，spec WP7.2）

任一账号收到组织级错误文本（`organization has disabled` / `suspended for this organization`（非按模型限时的那种）/ `oauth_not_allowed_for_organization`）→
`suspendTeam`：`upstream_teams.status='suspended'` + `suspended_reason / last_error_code`（`listCandidates` 只调度 `status='active'` 的组织，所以**整个组织立刻停**），
事件 `proxy_team_events.team_suspended_org_error`，journald `[ALERT][org]` 一行；该请求换别的组织的账号继续，不重试、不 reauth。
解除：`PATCH /api/admin/teams/:id {status:"active"}`（`resumeTeam`，清 reason，记 `team_resumed`）。直连与 worker 路径（`markCcrFailure`）同一套。
预算（spec WP7.1）：`upstream_teams.daily_token_budget / daily_cost_budget / max_concurrency`（迁移 37，null = 不限），只拦**新对话**的组织绑定（`teamBudgetState`），在途不杀；计 `org_budget_exhausted_total`。
验证：`packages/core/test/org-guard-telemetry.test.mjs`。此前 2026-11-01 的停用花了 3 分钟、几百个 502 才由各账号逐个失败而停下。
