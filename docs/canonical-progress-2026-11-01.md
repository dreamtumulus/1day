# Canonical 实施进度（对照 `canonical-implementation-spec-2026-11-01.md`，2026-11-01）

> 每轮更新。所有新行为都在三态开关后面，默认 `0` = 老行为；发布按 `iron-rules.md` 铁律 2。

## 已完成

| 工作包 | 内容 | 开关 / 入口 | 验证 |
|---|---|---|---|
| WP0 探针 | G1–G10 全部有结论（`docs/evidence/cc-2.1.312/README.md`）；三 profile × 12 采样；遥测结构 PoC（CA 注入） | — | `node tests/e2e/cc-probe/evidence.mjs` 脱敏 0 命中 |
| WP1 车道 A | profile 表（`cc-profile.ts`）、Key 白名单入口、不跨版本 pin、出站再校验 `cc_profile_mismatch`、CC 客户响应头 profile | `direct_profile_strict`、`cc_client_response_profile`、Key `allowedCustomEntrypoints` | `cc-profile.test`、`direct-profile-strict.test`、后缀不变量矩阵 |
| §6.2 Key policy | `{auto, override}` 两层 + 新字段；控制台 Key 页两层显示 | `key_policy_auto` | `cc-profile.test`（policy 用例） |
| WP8 判断器 | `key-policy-auto.ts` 规则 + 3 天滞回 + `key_policy_events`（迁移 35）；控制台日批 + 管理接口 | `key_policy_auto`（0 = 只记录） | `key-policy-auto.test` |
| WP5（部分） | I12 裸 `429 "Error"` 请求级；`responseMode=strict` 不提前 200 / 不心跳；`anthropic-ratelimit-*` 本就不转发 | Key `responseMode` | `key-policy-auto.test`（I12） |

## WP1 第 4 项的决定

探针证明：平台 Key 登录的真 CC **不带** `# userEmail`；带的是保留 OAuth 登录态的客户端。`direct_strip_user_email` / `direct_cc_canonical_fields` **保留**（默认 `0` 即零改体），不删代码：删了就没有退路，而开着 `0` 与删除对上游等价。

## 灰度步骤（R1，等灰度账号到位）

1. 控制台「设置」：`canary_group_id` 指向灰度组；灰度账号入组；签一把灰度 Key，放 `/root/monitor/canary-apikey.txt`。
2. 发布前 `backups/pre-wp1-<ts>-dist.tgz` + DB 快照；按 `operations.md §4` 蓝绿切换；`ops/bin/release-verify`。
3. 第一天只开 `direct_profile_strict=canary`（上游可见：版本不再被改写）。观察 ≥24h：`/health.counters` 的 `cc_profile_mismatch_total=0`、`cc_profile_unknown_total` 看是否有 2.1.316 等未采样版本（有则先补 profile 再切 `1`）、无 `429 "Error"`、无组织级错误文本。
4. 之后各开一轮（一天一轮）：`cc_client_response_profile=canary`（只影响下游）→ `key_policy_auto=canary`（先看一周 `key_policy_events` 的建议是否与人工一致）。
5. 任一异常：开关回 `0` 即回滚，无需重新发布。

## 未做（按 spec 顺序）

- WP2 canonical 进程（节点侧）、WP3 原生会话（G4 的"无 transcript 崩溃窗口"与 G3 的 thinking 剥离已有证据）、WP4 strict 参数契约 / Responses 第一档、WP5 raw-v1 节点能力、WP6 `telemetry_evidence` 表、WP7 组织预算与组织级熔断。
- 2.1.316 / 2.1.314 的 profile 采样（mirasim 客户版本），否则严格模式下它们是 `cc_profile_unknown`。
- 判断器缺的观测：外来历史比例、`ignored-params` 命中、探针形态（需在 usage_logs 加列，迁移只增）。
