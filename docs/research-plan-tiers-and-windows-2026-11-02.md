# 研究：订阅档位变更（Max 20x → Ultra）、平台能否识别账号属性、窗口/计费是否被动（2026-11-02）

## 1. Anthropic 这边发生了什么（2026-10-30/31）

- Max 5x 改名 **Max**（$100），Max 20x 改名 **Ultra**（$200）；价格不变，订户无需操作。
- **只有"已验证（verified）"的 Ultra 账号取消 5 小时会话限额**；较新的 Ultra 账号在验证完成前仍有临时 5 小时限额（防欺诈/滥用），验证完成会收到邮件。Pro 与 Max 的 5 小时限额不变。
- 周限额不变：Ultra 为 Pro 的 10×/周（名字里的 20x 从来不等于周配额）。Max/Ultra 另有 Fable 独立周限额。
- 自查：claude.ai → Settings → Usage，看不到 "Current session" 条 = 已验证。
- 来源：Anthropic 帮助中心 "Using Claude Code with your Pro or Max plan"（"verified Ultra accounts don't have a five-hour session limit"）、TNW 2026-11-01 报道、Anthropic X 公告 2116220869479428500。

## 2. 对灰度账号意味着什么（证据）

灰度账号 `claude-9d6edf2c`（onboarding 时 `rate_limit_tier=default_claude_max_20x`，11-01 刚授权）**仍然有 5 小时限额**：
02:26:58Z worker 收到 Claude Code 原文 `You've hit your 5-hour limit · resets 4:50am (Europe/Berlin)`（= 03:50Z），网关据此 `window_exhausted`。
也就是：它是 Ultra 档位但**未验证**（或验证尚未下发）。请在该账号的 claude.ai 用量页确认是否有 "Current session"。

另外平台自己又加了 **1h45m–2h05m 的"重置后休息"**（settings `window_rest_min_sec=6300` / `window_rest_max_sec=7500`，2026-10-17 的规则，避免一到重置点就打满），
所以账号实际停到 05:43Z，比 Anthropic 的重置晚近 2 小时。11-02 03:58Z 已为灰度测试人工免除这次休息。

## 3. 平台现在能识别哪些账号属性

| 属性 | 来源 | 现状 |
|---|---|---|
| 邮箱、plan 大类（max/pro/team/enterprise） | `GET /api/oauth/profile`（`profile.ts`） | 存 `accounts.subscription_type`，只有大类 |
| `rate_limit_tier`（如 `default_claude_max_20x`） | 同上 | **解析了但没存**，无法区分 Max/Ultra/是否验证 |
| 5h / 7d / Fable-7d 用量与重置时间 | 直连响应头 `anthropic-ratelimit-unified-{5h,7d,7d_oi}-*`（被动）；`GET /api/oauth/usage`（主动，仅当被动样本 >6h 未更新） | 直连路径准确；**worker 路径完全看不到**（本次 1515 条请求期间 `window_5h_used` 一直是 0） |
| Claude Code 每轮结尾的 `rate_limit_event` | stream-json 事件：`status`(allowed/allowed_warning/rejected)、`rateLimitType`(five_hour/seven_day/seven_day_opus/seven_day_sonnet/seven_day_overage_included/overage)、`utilization`、`resetsAt`、`surpassedThreshold`、`isUsingOverage`、`overageDisabledReason` | **节点收到了但没解析**（CC 自己的 SDK adapter 也忽略它）；这是 worker 路径唯一的实时用量来源 |
| 限额命中 | worker：CC 原文 `You've hit your <window> limit · resets …`（`ccLimitReset`）；直连：429 + 头 | 只有撞墙才知道 |
| 新头 `unified-grace-{5h,7d}-utilization`、`unified-fallback`、`overage-disabled-reason`（2.1.312 已读） | 直连响应头 | 未解析 |

## 4. 结论：是被动的，而且在 worker 路径上是盲的

- **计费/计量**：不是问题。`usage_logs` 的 token 来自上游真实 usage（worker 的 `modelUsage` / 直连的 usage 块），本轮 `usage_estimated=0`。
- **窗口/配额**：被动采样 + 6 小时兜底探测。直连账号基本准确；**worker 账号在两次探测之间是盲的**，只能等 Claude Code 报"hit your limit"才知道，此时用户已经吃到 502/限额文本（本轮 02:27Z 的 3 条 `upstream_stream_error` 就是）。98% 阈值提前停调（`anthropic_window_threshold_percent`）在 worker 路径上形同虚设。
- **档位识别**：只知道 "max"，不知道 Ultra、不知道是否验证、不知道有没有 5h 限额。

## 5. 要补的（按收益排序，均非上游可见，可随下一轮发布）

1. **节点解析 `rate_limit_event`** → 上报网关 → `recordWindowUsage`：worker 路径实时拿到 5h/7d/overage 用量与 `resetsAt`；`status=allowed_warning` 时提前停调，`rejected` 直接 `window_exhausted`（不再靠文本解析）。
2. **存 `rate_limit_tier`**（新列）并在控制台显示；`default_claude_max_20x`/`ultra` 等原值保留。
3. **推断"无 5h 限额"**：`/api/oauth/usage` 的 `five_hour` 为空、或连续 N 轮 `rate_limit_event` 只报 `seven_day*` → 标记 `no_five_hour_window=1`，调度时不再按 5h 算，也不加"重置后休息"。
4. 解析 `grace-*`、`fallback`、`overage-disabled-reason` 头，存入快照。
5. 灰度期间 `window_rest_*` 的处理：当前全局 1h45m–2h05m；建议加按组覆盖（灰度组 0），避免再浪费 2 小时。
6. `usage_logs` 加 `cc_version` / `cc_profile_id`；`canary-report` 加按 Key 视角（选号失败的 503 现在按账号看不见）。

## 6. 已实现（2026-11-02，提交 `3954508`，迁移 38；待发布）

- `/api/oauth/profile` 全字段入库：`rate_limit_tier`、`plan_label`（Ultra (ex Max 20x) / Max (ex Max 5x) / Pro / Team · … / Enterprise）、`org_type`、`billing_type`、`seat_tier`、`subscription_status`、去凭证原文 `profile_json`；控制台账号徽章显示套餐档位，详情页显示组织/计费/席位/状态、窗口模型、原始 profile 与 usage 返回体。
- `/api/oauth/usage` 原文入库（`usage_json` / `usage_checked_at`）；探测结果里 `five_hour` 为空 → `window_model.five_hour=false`（已验证 Ultra），日志 `[window] … no five_hour window — Ultra verified?`。
- `window_model`（五小时/每周/Fable 各自是否存在、来源、观测时间、连续样本数）：usage 探测与 `rate_limit_event` 直接判定；响应头缺 5h 需连续 3 次才认。
- 无 5h 窗口的账号：窗口耗尽只停到重置点，不加 1h45m–2h05m 的"重置后休息"；有 5h 的账号行为不变。
- worker 路径解析 Claude Code 每轮的 `rate_limit_event`（status / rateLimitType / utilization / resetsAt）→ 与响应头同一套窗口记账：`five_hour` 事件写 5h 用量，`rejected` 直接 `window_exhausted`，`allowed_warning` 或 ≥90% 记日志。worker 账号不再在两次探测之间失明。
- 测试：`packages/core/test/window-model.test.mjs`（4 项）、`profile.test.mjs` 扩展。

实测（04:12Z，发布前）：灰度账号 profile 仍为 `default_claude_max_20x`（→ 显示 "Ultra (ex Max 20x)"），usage 仍返回 `five_hour`（1%，重置 09:00Z），即 API 侧暂未体现"无 5h"；发布后由 09:00Z 前是否再撞墙、以及 `rate_limit_event` 是否再报 `five_hour` 来定。

## 7. 发布后实测（2026-11-02 04:54Z，`3954508` 已上线，迁移 38 已应用，网关切到 8402）

`/api/oauth/profile` 全文（去凭证）现已入库并可在控制台查看。灰度账号的关键字段：
- `organization.plan_display_name = "Ultra"`、`plan_display_label = "Ultra plan"`（**上游新字段**，直接说明套餐；代码已改为优先用它，`33625c9`）
- `rate_limit_tier = default_claude_max_20x`（旧名）、`organization_type = claude_max`、`billing_type = stripe_subscription`、`subscription_status = active`、`has_extra_usage_enabled = false`
- `account.created_at = 2026-10-25`、`subscription_created_at = 2026-10-25`（账号 8 天新）
- 其余：`claude_code_trial_*`、`cc_onboarding_flags`、`payment_auth_hosted_invoice_url`、`claude_ai_*_feedback_enabled`、`application = Claude Code`、`enabled_plugins`

`/api/oauth/usage`（04:55Z）：`five_hour` **仍在计数**——07%（04:12Z 为 1%），重置 09:00Z；`seven_day` 18%。`window_model.five_hour = true`。
结论：这是 **Ultra 但尚未验证** 的账号（Anthropic：新账号在验证前保留临时 5h 限额；此账号 10-25 才创建），claude.ai 界面没有 "Current session" 条不等于 API 不计数。
平台现在能自动分辨：一旦 usage 返回 `five_hour: null`，或 worker 的 `rate_limit_event` 连续只报 `seven_day`，`window_model.five_hour` 会翻成 false，调度立刻不再按 5h 处理。

## 8. 待判定：这个 5h 限额是真执行还是显示上的尾巴（2026-11-02 05:06Z 起观测）

操作者假设：账号一直在用，所以 5h 只是官方没摘掉的尾巴。
已有反证：02:26:58Z 上游原文 `You've hit your 5-hour limit · resets 4:50am` 连拒两条——那一桶（00:33–02:27Z，1515 条）是真打满、真被拒；现在能用是因为 03:50Z 桶复位，新桶（04:00–09:00Z）到 05:06Z 只用了 7%。
仍可能成立的情形：验证在 02:27Z 之后下发，usage 的 `five_hour` 对象只是还挂着、不再拒绝。
判定方法：`/root/monitor/canary-window-watch.py`（每 15 分钟经控制台 admin 接口刷 `/api/oauth/usage`，写入 `/var/log/1dayapi-canary-traffic.log` 的 `window-watch:` 行）。
- 5h 到 ≥95% 后请求仍 200、无 `hit your 5-hour limit` → 尾巴（届时 `window_model.five_hour` 应人工或按下一次 usage `five_hour: null` 翻 false）；
- 再出现 `hit your 5-hour limit` / `rate_limit_event rejected five_hour` → 真限制，账号属"未验证 Ultra"。
停：`touch /root/monitor/canary-window-watch.stop`。
