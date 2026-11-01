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

**起因**：2026-11-01 上午三轮发布在一小时内改了上游可见的请求形态（入口改写、删 userEmail、beta 顺序、键序、提示词措辞、默认历史策略），
没有灰度、没有观察期，42 分钟后整个组织（29 个订阅号）被 Anthropic 停用 Claude Code 订阅访问。因果无法证明，但不可排除。

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
- 灰度组：控制台「设置 → 灰度测试账号组」选择；账号加入该组 = 账号页编辑分组；测试 Key = 该组下的 consumer Key。
- 发布核对：`ops/bin/release-verify` 先用灰度 Key（`/root/monitor/canary-apikey.txt`，如有）发请求，再用常规 Key。
- 验证：`packages/core/test/canary.test.mjs`、`apps/gateway/test/direct-path-hygiene.test.mjs`（开关开/关两种形态）。

## 附：组织级熔断（待做，铁律 2 的配套）

任一账号收到组织级错误（`organization has disabled Claude subscription access` / `suspended for this organization`）→ 该组织全部账号立刻停止调度并告警，人工解除。
2026-11-01 的停用花了 3 分钟、几百个 502 才由各账号逐个失败而停下。实现后补到本文。
