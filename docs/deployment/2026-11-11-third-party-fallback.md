# X-65：canonical/TUI third-party 400 按指纹回退 legacy `-p`（2026-11-11）

> 状态：灰度已上线，Kevin 的真实 third-party 拒绝已被回退接住；24h 观察与公开池 online 基线复验仍未完成。

## 1. 背景与证据

X-64 中 Kevin 的 OpenCode 流量从 02:22Z 起集中收到
`Third-party apps now draw from extra usage, not plan limits…`。生产捕获确认：这些失败集中在 canonical/TUI，
TUI 自己生成原生 Claude Code 的 UA / beta / metadata / 主 system，但调用方 system 又由网关通过
`--append-system-prompt-file` 追加。相同 OpenCode 请求在 legacy 车道有成功样本，节点在故障开始时没有换版或重启。

本次不改写 system、UA、beta 或 metadata，也不改 `canonicalTurn` / `appendSystemPrompt` / reuseKey。
采用参考项目 magpie #4503 的车道回退，而非身份字段修补。

## 2. 参考项目核对

- 文档记录的参考项目：`https://github.com/yetone/magpie`。
- 审查 HEAD：`7476328901e9c9236446640e9fbd33fe67930a6d`（2026-11-11 11:07:57 +0800）。
- 我们 vendored 的 `04ed05733eba7c73ccb975468bea19cff044fb9d` 已有同一段回退逻辑；HEAD 与此处 diff 为 0。
  X-43 移植时在 `tui-worker-2026-11-08.md` 主动标为“不用”，本次是在网关接回，不需要升级节点 shim。
- 参考实现：`internal/gateway/claude_subscription.go` 的 `redoAsPrint`、`thirdPartyKey`、`thirdPartyFor`。
- 已运行：`/root/.local/go/bin/go test ./internal/gateway -run 'TestClaude(TUIThirdParty|ThirdParty|TUIRefusal)' -count=1`，通过。

## 3. 行为契约

三态设置：`canonical_third_party_fallback`，代码默认与生产初始值均为 `0`（旧行为）。

启用后：

1. canonical/TUI 返回 third-party 400，且回答尚未产出时：
   - 非流式：读取 worker 的 502 JSON；不是 `(after partial output)` 才允许重试。
   - 流式：只预读下游尚未看到的第一个 SSE chunk；首 chunk 必须只含该错误事件。
   - 当前轮在同一账号以 `runCcrWorker({canonical:false})` 重试一次。legacy 再失败不循环、不冷却、不换号。
2. 已经产出回答：当前请求绝不重放，避免重复文本或重复工具副作用；只为后续请求记录回退。
3. 指纹：`callerSystemText` 去掉客户端计费头，trim 后前 2048 字符做 SHA-256。
   日期、cwd、项目说明等后段变化不导致每个对话各撞一次。
4. 命中指纹后 12h 内直接从 legacy `-p` 开始；到期再试 canonical/TUI。
5. 未命中指纹或未发生该错误的 prompt，请求体、system、reuseKey、账号选择与 canonical 车道完全不变。

`canonical_no_legacy_fallback` 只约束原有能力缺口回落；本次是独立的、显式开启的 third-party 兼容策略，不绕过其三态开关。

## 4. 双网关共享状态

参考项目的 `sync.Map` 不直接照搬：生产有 8400/8402 两个实例及蓝绿发布，内存 map 会让同一 prompt 在不同实例重复失败。

复用现有 `affinity_bindings`，不新增迁移：

- `key = 'tui-third-party:' + sha256`；`kind = 'tui_third_party'`；账号字段为 NULL；
- `expires_at = 拒绝发生时间 + 12h`；读写位于 `packages/core/src/affinity.ts`；
- 既有 10 分钟 sweeper 清理过期行，两个实例与后续发布共享。

只存哈希，不存 system 原文。

## 5. 代码落点

- `apps/gateway/src/ccr/third-party-fallback.ts`：指纹、两种 third-party 文案、非流式/流式首包检查。
- `apps/gateway/src/proxy.ts`：开关、直接回退、当前轮一次重试、已输出后的记录、计数器。
- `packages/core/src/{affinity.ts,settings.ts}`：共享指纹与三态设置。
- `apps/gateway/test/third-party-fallback.test.mjs`：6 个单元测试。
- `packages/core/test/affinity.test.mjs`：共享行 upsert / 过期 / sweeper。
- `tests/e2e/third-party-fallback.test.mjs`：11 项真实 HTTP 场景。
- `apps/console/scripts/fake-{node,claude}.mjs`：仅在 E2E 注入 canonical 能力和 third-party 故障；默认 fixture 行为不变，不进入真实节点包。

计数器：

- `ccr_tui_third_party_fallback_total{from=refusal|memory}`；
- `ccr_tui_third_party_remembered_total{from=retry|started}`。

## 6. 自动化验证

已完成：

- core 全套：198/198；
- 新增回退单测：6/6；
- 新 E2E：11/11，覆盖默认关闭、非流式重试、12h 直接回退、非目标 prompt 不变、流式首包重试、
  非流式/流式 partial output 不重放及其下轮回退；
- magpie 参考项目针对性 Go 测试通过；
- 完整 `pnpm gate`：**964 passed / 0 failed**（catalog 8、core 198、gateway 427、console 132、E2E 199；120s，`GATE: PASS`）。

## 7. 生产发布记录（2026-11-11 03:39–03:58Z）

- commit：`705a2b7`，已推送服务器 `main`；dist 快照
  `/opt/1dayapi/backups/pre-third-party-20261111T033937Z-dist.tgz`。
- `pnpm install --frozen-lockfile && pnpm build` 通过；gateway 蓝绿切到 **8402**，切换前真实请求 200。
- 03:40Z 首轮 `release-verify` 通过：canary / 常规请求均 200、online 100、三节点心跳、监控矩阵、
  三节点设备身份（38 / 47 / 27）全部正常。
- 初始开关保持 `0`，随后 `canonical_third_party_fallback=canary`，并启动 2h phase guard 与持续 canary watchdog。
- 灰度探针连续 8 次 200，上游当时没有自然拒绝，因此未把它们冒充回退证据。另做 5 分钟人工指纹验证，
  确认生产 direct-memory 车道返回 200 后已删除该测试指纹。

### Kevin 真实流量

- 03:48:46Z，运营方要求将 Kevin `test`（`3a927676…`）迁入灰度组。
- 03:50:54Z，首个真实 third-party 拒绝被记录；日志确认随后多个请求直接 `starting on legacy -p`。
  之后自然回退指纹增至 3 个；Kevin 迁入后的 `third_party_extra_usage` 为 **0**。
- 初期灰度组只有 3 个账号，出现 `team_capacity_exhausted`。运营方随后指定扩容：
  先补至 12 个，再把 `NGO team 01` 与 `1103 普通team`、`1103普通team 02`、`普通03 Team`、`普通04 team`
  的 active/approved 账号追加进来，最终 **47 个账号**。原分组、节点、代理与设备绑定不变。
- 扩容使普通节点碰到旧设置 `canonical_no_legacy_fallback=canary`：能力缺口被直接回 400。
  已恢复该旧开关为 `0`；新 third-party 开关仍为 `canary`。
- 03:56:30Z 后采样窗口 **16/16 请求 200**，无 third-party 400，也无容量错误。

### 尚未通过的复验

03:58Z 再次 `release-verify`：真实请求、监控矩阵、节点心跳和设备身份均通过，但公开池
`online=89 < baseline=100`，所以脚本结论为 **RELEASE NOT VERIFIED**。没有重置基线。
同期 03:46–03:52 新增 7 个 OAuth refresh 失效账号，另有窗口暂停及 1 个代理冻结；
这些是独立供给变化，需单独处置并恢复公开池后复验，不能据此声称发布全绿。

## 8. 灰度配置与回滚

- 立即功能回退：`canonical_third_party_fallback=0`；已有指纹不再被读取，无需删表。
- Kevin / canary-test 的原组记录在 `/root/monitor/canary-moved-keys.json`，用 `canary-move-keys revert <key_id>` 恢复。
- 追加账号的精确撤销清单：`/root/monitor/canary-third-party-added-accounts.json`、
  `/root/monitor/canary-third-party-team-expansion.json`。
- 旧 `canonical_no_legacy_fallback` 的恢复记录：`/root/monitor/canary-third-party-restore-canonical_no_legacy_fallback.json`。
- 代码回滚：先恢复 `pre-third-party-20261111T033937Z-dist.tgz` / 上一个提交，再执行
  `ops/bin/gateway-switch --rollback`；节点包无需回滚。发布时的 600 秒旧实例保留期已结束，不能再按“旧进程仍在”处理。
- 24h 观察继续：目标 prompt 的 third-party 400、非目标车道、窗口消耗、499/502 与组织级错误；
  公开池 online 基线恢复后必须再跑 `release-verify`。

## 9. 真实性变化（铁律 3）

- 未命中 third-party 拒绝的请求：**=**，上游看到的请求与之前一致。
- 命中拒绝的 prompt：**↓**，从交互式 `cli` 回退到 `sdk-cli`，且该通道额度成本更高。
- 运营方 2026-11-11 明示“暂时这样改吧”，接受这一有限范围的降级，以恢复可用性；不全局关闭 TUI，12h 后自动重试 canonical。
