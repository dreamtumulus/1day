# 灰度分析：R1 第一轮真实流量（2026-11-02 00:33Z – 03:40Z）

数据源：`usage_logs`（按灰度账号 / 按迁入 Key 两种切法）、`/var/log/1dayapi-canary-traffic.log`、`/health.counters`、journald。报表命令见 `docs/operations.md §7.3`。

## 1. 时间线

| UTC | 事件 |
|---|---|
| 00:33 | mirasim.ai/Key-01、RuoMoe/sub、测活/monitor 迁入灰度组；`direct_profile_strict=canary` |
| 00:33–02:27 | **阶段一（worker）**：1515 请求落在灰度账号，1489 成功（98.3%） |
| 02:06 | 账号 `temp_unschedulable_until`（并发 9 打满，出现 `team_capacity_exhausted` / `account_pool_busy`） |
| 02:27 | 灰度账号 5h 窗口耗尽：`window_exhausted_until 05:43:38Z`，状态仍 `active`（看门狗盲区） |
| 02:30–03:40 | 三位用户全部 `503 no_available_account`（755 条，account_id 为空，账号维度统计看不见） |
| 03:00 | 阶段二开关 `direct_cc_entrypoint_normalize=canary` 按时打开——**但没有任何流量**，阶段二实际没有开始 |
| 03:40 | 人工 `canary-move-keys revert`；修看门狗（识别 paused、窗口恢复自动轮转回灰度组）；阶段二守护重新武装到 05:46Z |

## 2. 阶段一（worker）：客户侧体验

- 1515 条，**98.3% 成功**；p50 7.4s，**p95 66.5s**，首字 p50 1.6s；截断 11 条（0.7%）；`usage_estimated=0`（计量全部真实）。
- 输入 3950 万 token、输出 184 万、缓存读 2.02 亿、缓存写 0（worker 路径的缓存基线在起作用）；工具调用 1435 次。
- 模型：opus-5-5 占 80%（1210）、sonnet-5-5 201、opus-5 53、fable-5-1 36、haiku 15。流式 87%。
- 错误 26 条：`safeguards_refusal` 14（上游安全拒绝，与路径无关）、`client_closed` 8（客户端主动断）、`upstream_stream_error` 3 + `upstream_error` 1（02:00–02:27 窗口临近耗尽时出现）。
- 分小时 p95：00Z 38.7s → 01Z 50.6s → 02Z **103s**。p95 随负载抬升，02Z 已有并发打满（`concurrency=9`）的排队迹象；单账号承接 2 万请求/天的用户，吞吐就是瓶颈。
- 形态：1489 条全 `suspect`（预期：严格 profile 下全部降级到 worker），26 条 `non-cc`（RuoMoe 的 OpenAI 格式客户端，`ccr-chat`，12 条 100% 成功）。
- **结论**：worker 路径功能上没有客户可见的失败（无 session_lost / history_import 等 worker 特有错误码），体验问题只有一个——**延迟尾部随单账号负载恶化**，需要多账号分摊才能评估真实水平。

## 3. 阶段二（直连/归一化）：没有数据

开关 03:00Z 准时打开（`PHASE2 ON`，前一阶段快照已存 `/root/monitor/canary-phase-20261102T010155Z-before-direct_cc_entrypoint_normalize.txt`），
但灰度账号自 02:27Z 窗口耗尽，03:00–03:40 之间 0 条请求落到它身上，守护每 5 分钟都是 `n=0`。形态指标（`cc_profile_mismatch`、`[billing-suffix] mismatch`、`upstream_request_rejected`）全部为 0 只是因为没有流量，**不能作为通过依据**。
阶段二顺延到 05:46Z 窗口复位：看门狗把 Key 轮转回灰度组，守护（3 小时）重新开始。

## 4. 形态数据（计数器，累计到 03:37Z，涵盖所有 Key）

`cc_profile_unknown_total`：2.1.316=782、2.1.301=779、2.1.241=124、2.1.312=82、2.1.305=81、2.1.303=79、2.1.310=66、2.1.302=50、2.1.314=41、2.1.296=30、2.1.295=28、2.1.287=7、2.1.308=5、2.1.309=2；`custom_entrypoint_denied{mirasim}`=1407。
- 真实客户端版本极度分散（14 个版本），2.1.316 与 2.1.301 各占约 36%。只有 2.1.312 有采样 profile，严格模式下 **96% 的 CC 流量会被判 unknown**。切 `1` 之前必须补 2.1.316 和 2.1.301 的 profile（两者合计 72%），其余可先接受降级。
- `mirasim` 自定义入口 1407 次：几乎 mirasim.ai 的每条请求都带，阶段二放行+改写才有直连样本。

## 5. 两个必须记录的失误

1. **看门狗盲区**：只看 `status`，没看 `window_exhausted_until` / `temp_unschedulable_until`；用户 503 了 70 分钟才被发现。已修（`845d0ff`）：按"是否在服务"判断，并在窗口复位后自动轮转回灰度组。
2. **账号维度统计看不见选号失败**：`usage_logs.account_id` 为空的 503 不会计入按账号的报表。`canary-report` 需增加"按迁入 Key"的视角（待做）。

## 6. 一个重要背景：平台整体无供给

全平台 11-01 20:00Z 以来每小时成功数：20Z 0 / 21Z 0 / 22Z 6 / 23Z 1 / **00Z 245 / 01Z 920 / 02Z 324** / 03Z 0。默认组 2 个 active 账号都是 7 天窗口 98% 封顶（到 11-02 10:00Z 与 11-05 01:00Z），其余 28 个 `error`、1 个 `disabled`。
也就是说 **00:33–02:27 的 1489 条成功请求是整个平台这十几个小时里唯一的有效服务，全部来自灰度账号**。退回默认组对这三位用户没有改善（默认组同样 503），所以 05:46Z 轮转回灰度组是正确选择。
供给问题不在本次灰度范围内，但它决定了：灰度账号现在既是测试品也是唯一产能，p95 数据不能代表正常多账号情形。

## 7. 下一步

- 05:46Z：Key 自动轮转回灰度组，阶段二（直连）开始，守护 3h；窗口大约再撑 2 小时，之后再轮转。每个 5h 窗口约 2h 有效数据。
- 阶段二看：`passthrough-anthropic` 占比（预期 ≈ 2.1.312 份额，约 5%——比原估的 25% 低，因为 2.1.316/301 才是大头）、`cc_profile_mismatch=0`、`[billing-suffix] mismatch=0`、`upstream_request_rejected=0`。
- 今天的发布（一天一轮）内容建议：`usage_logs` 加 `cc_version`/`cc_profile_id`；`featureFor` 选号后按账号组补判；`canary-report` 加按 Key 视角。
- Pi：采样 2.1.316、2.1.301 的 profile（WP0 第四批）。
