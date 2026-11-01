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
3. 用灰度组的测试 Key 跑测试与真实流量，观察 **≥ 24 小时**：`profile` / `roles` 正常、窗口与错误率无异常、没有任何组织级错误文本
   （`organization has disabled` / `suspended for this organization`），再切 `1`。观察记录写进发布记录。
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
- 灰度组：控制台「设置 → 灰度测试账号组」选择；账号加入该组 = 账号页编辑分组；测试 Key = 该组下的 consumer Key。
- 发布核对：`ops/bin/release-verify` 先用灰度 Key（`/root/monitor/canary-apikey.txt`，如有）发请求，再用常规 Key。
- **出站不变量**：直连请求离开网关前，`system[0]` 计费头的后缀 ≡ `ccBuildSuffix(出站 messages, 版本)`；改体（设备身份、机器环境、删 reminder …）一律在算后缀之前，`alignBillingSuffix` 是最后一步；版本不是 2.1.312（不会算）时不碰首条用户文本（`canEditFirstUserText`）。运行时还有最后一道闸：对不上就原样转发客户 body 并打 `[billing-suffix] mismatch` 日志。
- 验证：`packages/core/test/canary.test.mjs`、`apps/gateway/test/direct-path-hygiene.test.mjs`（开关开/关两种形态）、`apps/gateway/test/billing-suffix-invariant.test.mjs`。

## 附：组织级熔断（待做，铁律 2 的配套）

任一账号收到组织级错误（`organization has disabled Claude subscription access` / `suspended for this organization`）→ 该组织全部账号立刻停止调度并告警，人工解除。
2026-11-01 的停用花了 3 分钟、几百个 502 才由各账号逐个失败而停下。实现后补到本文。
