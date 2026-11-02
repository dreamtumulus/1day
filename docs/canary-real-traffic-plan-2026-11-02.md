# 灰度真实流量测试计划（2026-11-02）

依据：`docs/iron-rules.md` 铁律 2、`docs/canonical-implementation-spec-2026-11-01.md` §6、`docs/canonical-progress-2026-11-01.md`。
本文回答三个问题：灰度组怎样接到真实流量、日志记在哪、怎样从日志得出测试结论。

## 0. 结论先行（2026-11-02 00:33Z 起执行）

- 之前的灰度（11-01 17:01Z 起）只有探针流量（每小时 5 条 "回复 OK"），**不构成有效灰度**。
- 现在把 **有真实流量的用户 Key** 移进灰度组 `canary-1cf43ccb`，由灰度账号 `claude-9d6edf2c`（team `dcaea0ca…`，executor ccr_worker）承接，开关按 Key 组判定，所以这些流量**走的是新行为**。
- 每条请求都落 `usage_logs`（见 §3），看门狗每 5 分钟写一行汇总到 `/var/log/1dayapi-canary-traffic.log`，`ops/bin/canary-report` 随时出报表。
- 灰度账号一旦离开 `active`（window_exhausted / error / proxy_down / disabled），看门狗**自动把用户 Key 退回原组**，不碰账号本身（铁律 1）。

## 1. 流量来源

| 用户 | Key | 原组 | 24h 请求 | CC genuine 比例 | 说明 |
|---|---|---|---|---|---|
| mirasim.ai | Key-01 `9ad5ac8d…` | default | ~21.6k | 26% | 自定义 entrypoint `mirasim`，多版本 CC（2.1.241/295/301/312/316） |
| RuoMoe | sub `b33e358d…` | default | ~4.4k | 10% | 有 CC 也有 API 客户端，13 个模型 |
| 测活-机器人 | monitor `12b16f76…` | default | ~330 | 0 | 运营方自己的测活，稳定低频 |
| 测试04 | canary-test `512dd4b8…` | canary | 探针 | — | `canary-verify` / `canary-cc-probe` |

选择标准：当时 3 小时内有流量、属于默认组、覆盖"真 CC / 自定义 entrypoint / 纯 API / 测活"四种形态。迁移记录（含原组、时间）在 `/root/monitor/canary-moved-keys.json`，`ops/bin/canary-move-keys revert` 一键恢复。

**为什么不是把灰度账号加进默认组**：开关 `featureFor` 在直连路径按 **Key 组**判定（`proxy.ts:826`、`upstream.ts:141`），账号组只在账号已选中后才参与；默认组的 Key 落到灰度账号上仍走老行为，测不出新形态。按账号判定的改法见 §6。

## 2. 当前生效的开关（11-02 00:33Z）

| 开关 | 值 | 对灰度组流量的含义 |
|---|---|---|
| `direct_profile_strict` | `canary` | 版本×entrypoint 无采样 profile → `cc_profile_unknown`，按 `cc_shape_policy=downgrade` 降级转发；出站再校验，失配 → 400 `cc_profile_mismatch` |
| 其余 V2 开关 | `0` | 老行为（`cc_client_response_profile`、`key_policy_auto`、`worker_canonical`、`telemetry_evidence_required`、`canonical_history_import`、`raw_preserve_headers`） |

判定器（`key_policy_auto=0`）只记录不生效，已读 `effectiveKeyPolicy` 代码确认。

## 3. 日志：记在哪、记什么

1. **每请求** `usage_logs`（SQLite `/opt/1dayapi/data/1dayapi.db`）：`api_key_id / group_id / account_id / model / endpoint / stream / status_code / error_code / error_scope / mode / cc_shape / upstream_status / duration_ms / first_token_ms / tokens / stream_truncated / created_at`。这就是"访问日志"，分析全部基于它。
2. **每 5 分钟** 看门狗一行：账号状态、请求数、200 数、genuine/suspect 数、stream 数、4xx/5xx、涉及 Key 数、错误码 Top5 → `/var/log/1dayapi-canary-traffic.log`（`ops/bin/canary-watchdog`，进程以 setsid 挂在后台，停：`touch /root/monitor/canary-watchdog.stop`）。
3. **计数器** `GET /health` → `counters`：`cc_profile_unknown_total{version}`、`custom_entrypoint_denied_total{entrypoint}`、必须为零的 `cc_profile_mismatch_total / team_suspended_total / native_telemetry_unverified_total / org_budget_exhausted_total`。
4. **组织级信号** `telemetry_evidence`、`upstream_teams.suspended_until / last_error_code`、journald（`cc_profile|org_|organization|disabled|native_telemetry`）。
5. **判定器轨迹** `key_policy_events`（每个 Key 的 auto 层提案和依据）。

## 4. 怎样出结论（`ops/bin/canary-report`）

```
cd /opt/1dayapi && HOURS=24 node --no-warnings ops/bin/canary-report
```
输出 13 节：灰度账号/团队状态 → 请求总数（灰度组 Key vs 其他 Key）→ 状态/错误码 → mode → 端点×stream → 模型 → 客户端形态 → Key 组 → 分小时序列（n/ok/err/p95）→ 最近 20 条错误 → telemetry evidence → key-policy events → 必须为零的计数器 + VERDICT。

**通过标准（≥24h 观察）**
- 必须为零的计数器全零；`upstream_teams` 无 suspended；journald 无组织级错误。
- 灰度账号未因新行为进入 `error`/`disabled`（window_exhausted 属容量问题，不算失败，但要记录发生时刻）。
- 错误率（非 200 / 总数，剔除 `no_available_account`）不高于同一用户迁入前 24h 的错误率 + 2 个百分点。
- p95 延迟不高于迁入前 1.5 倍。
- 对 `direct_profile_strict`：记录 `cc_profile_unknown_total` 按版本分布，决定是先补 2.1.301/2.1.316 的 profile 再切 `1`，还是接受降级。

**失败处理**：任一组织级信号出现 → 立即 `ops/bin/canary-move-keys revert`，把对应开关回 `0`，写发布记录；不换 IP、不直连（铁律 1）。

## 5. 时间线

| 时间 (UTC) | 动作 |
|---|---|
| 11-01 16:33 | R1 发布（dist 快照 `pre-canonical-r1-20261101T162830Z`），所有开关 0 |
| 11-01 17:01 | `direct_profile_strict=canary`，探针开始 |
| 11-02 00:33 | 三个真实用户 Key 迁入灰度组；看门狗启动；**真实流量灰度从此刻计时** |
| 11-03 00:33 后 | 跑 24h 报表 → 决定 `direct_profile_strict` 切 `1` 或补 profile；再按顺序开 `cc_client_response_profile=canary` → `key_policy_auto=canary` → （推节点包 + `CC_WORKER_CANONICAL=1`）`worker_canonical=canary` → 7 天健康后 `telemetry_evidence_required` → `canonical_history_import=canary` → R4 strict/raw |

每一步仍遵守：一天一轮发布、切开关后至少观察 2 小时、下一开关前等 ≥24h。

## 6. 待办

- [ ] 改 `featureFor` 调用：直连路径在账号选定后按账号组补判一次（规范 §6.1 原文"或被选中的账号属于灰度组"），这样把灰度账号加进默认组也能灰度。非上游可见，随下一轮发布。
- [ ] 采样 2.1.301 / 2.1.316 / 2.1.295 的 profile（mirasim.ai 的真实客户端），交给 Pi（WP0）。
- [ ] mirasim 自定义 entrypoint：若确认是其正常客户端，给该 Key 的 `allowedCustomEntrypoints` 加 `mirasim`（override 层）。
- [ ] cron `/etc/cron.d/1dayapi-canary`（每小时 `canary-verify` + `canary-cc-probe`）由您安装；我这边系统权限拦截。

## 7. 「V2 上线了没？怎么启用？」

V2 的**代码**已在 11-01 16:33Z 全部上线（网关 8400、控制台、迁移 35–37），但每个上游可见的行为都在三态开关后面、默认 `0`，所以线上**行为仍是 V1**，只有灰度组走 `direct_profile_strict`。"正式启用 V2" = 按 §5 的顺序把开关逐个从 `canary` 切到 `1`（控制台「设置」或 `settings` 表），每个开关一天，期间 `canary-report` 必须干净。节点侧 `worker_canonical` 还需先把节点包推到 node 并设 `CC_WORKER_CANONICAL=1`。全部切 `1` 并稳定两周后，R5 删除 V1 旧分支。
