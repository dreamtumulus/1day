# X-65：canonical/TUI third-party 400 按指纹回退 legacy `-p`（2026-11-11）

> 状态：代码与自动化测试完成，待灰度发布。发布结果、生产验证与回滚快照在发布时补记。

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

生产发布验证结果在发布时补记。

## 7. 发布与回滚计划

- 初始保持 `canonical_third_party_fallback=0` 发布代码，灰度组才设 `canary`。
- 灰度真实流量至少观察 24h：目标 prompt 的 third-party 400 应消失；非目标 prompt 不应出现车道变化；
  检查 `ccr_tui_third_party_*`、窗口消耗、499/502、组织级错误。
- 立即功能回退：设置改回 `0`。已有指纹不再被读取，无需删表。
- 代码回滚：恢复发布前 dist 快照 / 上一个提交后执行 `ops/bin/gateway-switch --rollback`；节点包无需回滚。

发布时补记：快照名、灰度 Key、生产验证、release-verify 输出、commit。

## 8. 真实性变化（铁律 3）

- 未命中 third-party 拒绝的请求：**=**，上游看到的请求与之前一致。
- 命中拒绝的 prompt：**↓**，从交互式 `cli` 回退到 `sdk-cli`，且该通道额度成本更高。
- 运营方 2026-11-11 明示“暂时这样改吧”，接受这一有限范围的降级，以恢复可用性；不全局关闭 TUI，12h 后自动重试 canonical。
