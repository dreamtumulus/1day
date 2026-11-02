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

## 8. 用户侧体验：worker 路径暴露的三个问题（2026-11-02 05:30Z 复盘，样本 1515 + 152）

按 Key 看（含选号失败）：mirasim.ai/Key-01 全程 2720 条、**成功 59%**——1044 条 `503 no_available_account` 全部落在 02:30–03:40Z（账号窗口耗尽、看门狗盲区），其余时段 98%+。测活机器人 54 条、67%，同因。这是真实的用户体感，不能只看"落到账号上的请求"。

1. **上游限流被 worker 吞成延迟**（最大的体验差异）。Claude Code 在节点上收到 429/529 会自己退避重试（25s → 36s → 47s → 59s → 74s → 93s → 123s …），日志 `slow turn … system/api_retry ×N`；整轮 71 次重试，集中在 01:40–02:27Z（5h 窗口临近耗尽）。用户看到的是 60–176 秒的首字等待，而不是一个可失败转移的 429。直连路径上网关会立刻拿到 429 → 换号。
   → 处置：节点把 `api_retry` 事件上报给网关（和 `rate_limit_event` 同通道），网关对 ≥2 次重试的轮次记指标并考虑在首字前切账号；至少先在 `usage_logs` 记 `upstream_retries`，让这段延迟可归因。
2. **节点 chown 竞争**：`tunnel closed by node: ENOENT … lchown … .claude.json.lock`，2 条 502（02:00:45Z、02:06:24Z）。并发 9 时同账号多个会话同时起，节点给账号目录改属主的遍历撞上 Claude Code 刚删掉的锁文件。已修（`chownTree` 跳过 ENOENT），**需推节点包**（节点 `20261028T024559Z-audit-fixes` 仍是旧包）。
3. **5h 窗口对 worker 路径不可见**：02:26:58Z 才由 Claude Code 原文 `hit your 5-hour limit` 得知，此前 `window_5h_used` 一直是 0；两条 `502 upstream_stream_error` 就是撞墙那一刻的请求。已修（`rate_limit_event` 解析入库，`3954508`），但该事件只在 `allowed_warning` / `rejected` 时带窗口类型，提前量有限；根治仍靠 1 的 `api_retry` 上报 + usage 探测加密。

无问题的部分：`safeguards_refusal` 14 条是 Opus 5.5 上游安全拒绝（`API Error: Opus 5.5's safeguards flagged this session`），网关正确地 400 给客户、不冷却账号、不换号；`client_closed` 8 条为客户端主动断开（6 条发生在首字前，很可能是等不及 1 的长延迟）；工具调用 1530 次、`usage_estimated=0`、无截断、无 worker 特有错误码。

## 9. 形态数据：仍为零，原因与进度

阶段二开关在线，但 04:00Z 以来的 152 条仍全部 `cc_profile_unknown`（2.1.301 ×50、2.1.316 ×30、2.1.314 ×27、2.1.283 ×21、2.1.305/303/241）——没有 2.1.312 客户端出现。直连样本 = 0，`cc_profile_mismatch` / `[billing-suffix] mismatch` / `upstream_request_rejected` 为零不构成证据。
进度：2.1.316 与 2.1.301 的官方二进制已拿到（`/home/ubuntu/claude-code-re/<ver>/package/claude`），Pi 正按 `docs/wp0-batch4-brief-2026-11-02.md` 采样 profile（cli / sdk-cli 各 ≥12 样本 + 传输常量 + 计费后缀核对）。采样入库后，2.1.316/301（72% 的 CC 流量）即可判 genuine → 直连，形态校验才有数据。

### §8.1 处置进展（05:40Z）
- 已实现（待发布）：翻译器统计 Claude Code 的 `system/api_retry`（attempt / retry_delay_ms / error_status）→ `TurnFacts` → `usage_logs.upstream_retries`（迁移 39）；worker/cloud 两条车道都记；重试 >0 的轮次打 `[ccr-worker] … upstream retried N× … the client saw it as latency` 并计 `ccr_upstream_retry_total{lane}`；`canary-report` 第 4 节加 `retried_turns` / `upstream_retries`，看门狗行加 `retries=`。
- 下一步（需数据后再定）：对首字前已重试 ≥2 次的轮次，网关是否提前换号（上游可见：会在另一账号重放同一请求，须走三态开关）。
