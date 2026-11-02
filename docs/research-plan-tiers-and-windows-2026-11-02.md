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
