# 充值额度（usage credits）感知与调度策略

> 2026-11-10。代码：`packages/core/src/usage-credits.ts`（纯解析）、`packages/core/src/accounts.ts`（策略与调度）、
> `apps/console/src/shapes.ts`（接口字段）、`apps/web/src/console/pages/shared/UsageCredits.tsx`（界面）。
> 默认关闭，行为与此前完全一致。**开启前必须先做「开启前核对」一节。**

## 1. 背景（Anthropic 帮助中心，2026-11）

- Max / Ultra 套餐除 5 小时会话上限、全模型周上限外，另有一条 **Fable 专属周上限**（Fable 5 / 5.1 / 5.2）。
- **充值额度**（usage credits，旧称 extra usage）是付费套餐（Pro / Max / Ultra；Team 由 owner 设支出上限）上的预付按量资金。
  账号主在 Settings > Usage 里开通后，任一 5 小时上限、周上限或 Fable 周上限用尽时，请求**自动**改按标准 API 价从充值额度扣费并继续可用
  （Claude Code 同样适用）；到月支出上限、或余额用完且未开自动充值时才停。打折的 usage bundle 也只是预付额度。
- 平台此前的行为：窗口或 Fable 份额用尽 → 该账号（对该模型）停调到重置。开通了充值额度的账号其实还能继续服务，这部分供给被浪费了。

## 2. 识别了什么

控制台巡检 `GET /api/oauth/usage`（`apps/console/src/ccr/window-poll.ts`）把脱敏后的响应体存在 `accounts.usage_json`。
`parseUsageCredits(usageJson)` 从中归一化出：

| 字段 | 来源 | 说明 |
|---|---|---|
| `known` | 有 `spend` 或 `extra_usage` 块 | false = 没探过 / 体被截断（存储上限 8000 字符）/ 形态不认识 |
| `enabled` | `spend.enabled`、`extra_usage.is_enabled` | 至少一个为 true 且没有任何一个明确为 false |
| `everEnabled` | `extra_usage.credits_ever_enabled` | |
| `canToggle` / `canPurchase` | `spend.can_toggle` / `spend.can_purchase_credits` | |
| `balance` | `spend.balance` | 预付余额；null = 未上报 |
| `monthlyCap` | `spend.cap` → `spend.limit` → `extra_usage.monthly_limit` | 月支出上限；null = 无上限或未上报 |
| `used` | `spend.used` → `extra_usage.used_credits` | 本月已用 |
| `spendLimitReached` | `extra_usage.spend_limit_reached`；或有上限且 `used ≥ cap` / `percent ≥ 100`；或 `spend.severity` 为 exceeded 类 | |
| `autoReload` | `spend.auto_reload`（布尔或 `{enabled}`） | null = 未上报 |
| `disabledReason` | `spend.disabled_reason` → `extra_usage.disabled_reason` → `user_disabled` | 截到 120 字符 |
| `promo` | `promo_credits` | 赠送额度余额；**不**计入可用判断 |
| `fableShare` | `limits[]` 里 `scope.model` 含 Fable 的那条 + `weekly_scoped_shares[limit_index]` | `usedPercent` = 占 Fable 份额本身的百分比；`allowancePercentOfWeekly` = 份额占周上限的百分比（现为 50） |

金额统一成 `{amountMinor, currency, exponent}`。接受三种写法：`{amount_minor, currency, exponent}`（`spend.used` 的实测形态）、
`{amount | value: 12.5}`（小数主单位）、裸数字（整数按**分**——`extra_usage` 的惯例；非整数按小数主单位）。
裸整数若实际是主单位，显示会小 100 倍，但不影响「可用」判断（只看是否 > 0）。解析绝不抛异常，任何读不懂的地方都落到「不可用」。
接口和界面只带归一化结果，不带原始 `disclaimer` 文案。

`creditsUsable(c)`——按上次巡检的数据，超出套餐上限的请求现在能不能从额度里扣：

1. 未开通 / 状态未知 → 否；
2. 已达支出上限 → 否（不管余额）；
3. 余额已知且 > 0 → 是；
4. 自动充值开 → 是（余额空了会从付款方式补）；
5. 余额未上报 → 是（已开通且没到上限；后付费 / owner 管理的形态不报余额）；
6. 余额已知为 0 且自动充值未开 → 否。

## 3. 策略 `usage_credits_policy`

系统设置（控制台 → 系统设置 → 充值额度策略；`PUT /api/admin/settings`）：

| 值 | 行为 |
|---|---|
| `off`（默认） | 不利用充值额度。用尽即停调到重置，**与此前完全一致**。 |
| `fable_only` | Fable 周份额用尽（`model_cooldowns.fable` 冷却中）的账号，若额度可用，继续参与 **Fable** 请求的调度。5 小时 / 周窗口照旧。 |
| `all` | 在 `fable_only` 之上，5 小时 / 周窗口用尽（`window_exhausted_until` 或超过调度阈值）的账号，若额度可用，也继续调度。 |

没有按账号的开关：账号表里没有现成的按账号策略字段，本次不做迁移。需要排除个别账号时，目前只能关策略或停用该账号。

### 调度规则（`listCandidates`）

- **暂停状态照常写**：`window_exhausted_until`、`window_reason`、`model_cooldowns.fable` 的写入与没有策略时完全相同；
  策略只在选号时决定「这个额度暂停还算不算排除」。所以把策略改回 `off` 立即生效，不需要等下一次采样。
- **没有可用额度的账号不受任何影响**：策略为 `off` 时不读取额度状态；非 `off` 时，`creditsLive` 为假的账号走原来的排除路径。
- **排在最后**：走额度的账号在候选里标 `onCredits = true`，排序为
  未冷却优先 → **套餐额度优先于充值额度** → 分组优先级 → 账号优先级 → 最久未用 → 随机。普通 429 软冷却的账号仍排在所有账号之后。
  注意：网关的粘性会话 / 设备亲和会在未冷却的候选里重排，粘在某账号上的会话可能先选到走额度的账号——见文末「网关补丁」。
- **只桥接真正的额度用尽**：窗口已过重置时刻、只剩「重置后冷静期」的暂停不算（那时已是套餐额度，冷静期照旧）。
  组织级模型停用（`model:<id>`）、过载、认证失败、代理冻结等冷却一律不受额度影响。
- **上游拒绝后立刻收手**：以下任一发生时，在 `model_cooldowns.credits` 写 `{rejectedAt, reason}`，原有冷却照常生效；
  此后该账号视为额度不可用，直到**晚于该拒绝**的一次成功用量巡检再次显示额度可用：
  - 429 带被拒窗口（`window_rejected`，硬排除不变）；
  - Fable 的 429 `credits_required` / `7d_oi` 被拒（`model_window_rejected`）；
  - worker 路径上 Claude Code 报「hit your … limit」（`window_exhausted`）；
  - 账号正在走额度时收到的普通 429（没点名窗口也按「额度没了」处理）。
  管理员「恢复账号」（`clearAccountState`）会连同冷却一起清掉这个标记。
- **可见性**：
  - `window_reason` / `model_cooldowns.fable.reason` 末尾加 ` · on usage credits`；
  - 接口 `onCredits`、`onCreditsScopes`（`window` / `fable`）、`creditsLive`、`creditsRejectedAt`；
  - 进程内计数 `usageCreditsCounters()`（每次 `listCandidates` 因额度保留一个账号 +1，按账号和 scope 分；一次请求会多次列候选，
    所以它是「决策次数」不是「请求数」），首次保留时打一行 `[credits] account … kept schedulable on usage credits`。

## 4. 费用警告

**走充值额度的请求由 Anthropic 按标准 API 价计到账号主（供给方）的付款方式上**——Fable 约 $10 / $50 每百万 token（入 / 出），
直到账号主自己设的月上限或余额用完。这不是平台的钱，是账号主的钱：

- 开启前要和供给方约定清楚（结算比例是否覆盖这部分成本），平台目前**没有**把「这一笔走了额度」记进用量 / 结算；
- `all` 比 `fable_only` 敞口大得多：5 小时窗口每天都会用尽；
- 上次巡检可能是几小时前的数据。余额在两次巡检之间花完时，第一笔请求会被上游拒绝（客户侧表现为一次换号），之后才收手。

## 5. 开启前核对（必须）

截至 2026-11-10，生产 62 个账号**全部未开通**充值额度，所以：

- 已验证的只有「未开通」形态（`packages/core/test/usage-credits.test.mjs` 里的 `REAL_DISABLED` 是真实存储体）；
- 「已开通」时 `spend.enabled / balance / cap / limit / auto_reload`、`extra_usage.is_enabled / monthly_limit / used_credits` 的
  取值形态是**按字段名推断**的（金额是分还是小数、`auto_reload` 是布尔还是对象、余额在哪个字段都没见过实物）；
- 走额度时上游响应头 / `rate_limit_event` 长什么样（窗口是否仍报 100%、是否有 `isUsingOverage`）也没见过。

第一个真实开通的账号出现后，先做完下面几步再把策略改离 `off`：

1. 管理端 → 账号详情 → 「原始 profile / usage」，取该账号的 `usage` 体（或 `SELECT usage_json FROM accounts WHERE id = ?`）；
2. 对照 Settings > Usage 页面上的真实余额 / 月上限 / 自动充值，核对接口里的 `usageCredits` 每个字段，尤其金额量级；
3. 把这份真实体加进 `usage-credits.test.mjs` 作为第二个实测夹具，推断错的地方改 `parseUsageCredits`；
4. 确认该体没被 8000 字符截断（截断 → `known: false` → 永远不可用）；
5. 先用 `fable_only`，观察一个 Fable 份额用尽的账号：`onCredits` 徽标出现、请求成功、账号主账单上出现对应扣费；
   同时确认被动采样没有把走额度的成功响应当成 429 / 被拒。

## 6. 怎么验证

```bash
pnpm --filter @1dayapi/core test        # usage-credits.test.mjs：解析表、creditsUsable 各分支、三种策略的调度、拒绝后的收手
pnpm --filter @1dayapi/console test
pnpm --filter @1dayapi/web build
```

线上（只读）：

```sql
-- 各账号的额度状态一览
SELECT id, name, usage_checked_at,
       json_extract(usage_json, '$.spend.enabled')            AS spend_enabled,
       json_extract(usage_json, '$.extra_usage.is_enabled')   AS extra_enabled,
       json_extract(usage_json, '$.spend.balance')            AS balance,
       json_extract(usage_json, '$.extra_usage.spend_limit_reached') AS cap_reached
FROM accounts WHERE usage_json IS NOT NULL;

-- 正在靠额度保留调度的账号、被上游拒绝过的账号
SELECT id, name, window_reason, model_cooldowns FROM accounts
WHERE window_reason LIKE '%on usage credits' OR model_cooldowns LIKE '%on usage credits%' OR model_cooldowns LIKE '%"credits"%';
```

控制台：管理端 / 供给方账号列表的额度列下方显示「充值额度 未开通 / 已开通 · 余额 $X / 已达上限 / 自动充值」、Fable 周额度条、
走额度时的「额度计费中」徽标；被上游拒绝后显示「上游已拒绝，等待下次用量查询」。

## 7. 已知限制

- **巡检新鲜度**：主动用量探测只给「长时间没有被动采样」的账号做（`window_passive_max_age_sec`），而且跳过窗口冷却中的账号。
  一直有流量的账号 `usage_json` 可能很旧；被上游拒绝后的账号在窗口冷却期内不会被重新探测，也就不会自动恢复走额度。
  管理端「刷新窗口」会立即探一次。要让策略及时感知开通 / 余额变化，需要让巡检按 `usage_checked_at` 的年龄也探（见集成说明）。
- **Fable 冷却的来源**：Fable 份额用尽目前靠响应头 `7d_oi` / usage 体的 `seven_day_fable` 触发；实测 usage 体里的 Fable 份额在
  `limits[]`（`weekly_scoped`）里，`parseUsageSnapshot` 还没有用它——`fableShare` 目前只用于展示。
- 计数器是进程内的（网关进程），重启清零；跨进程看 `window_reason` 后缀。
- 走额度的请求没有单独记账（见第 4 节）。
