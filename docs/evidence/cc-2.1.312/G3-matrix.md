# G3 外部历史导入矩阵（CC 2.1.312，2026-11-01）

问题（spec §7 G3）：把**外部构造**的 CC 原生 transcript（`CLAUDE_CONFIG_DIR/projects/<cwd-hash>/<session>.jsonl`）
放进一个全新 HOME，`--resume <session>` 能否读入并把全部历史发给上游？

方法：`node tests/e2e/cc-probe/history-import.mjs`（每个 case = 一个全新临时 HOME，假 OAuth + 假上游 +
拒绝式 CONNECT 代理；transcript 用 2.1.312 自己写出的行格式构造，样本取自本探针自己的临时 HOME，**未**取自任何节点）。
每个 case 跑一次 `run-gate.mjs resume`，证据 = `history-import-<case>.json`（结构）+ 汇总 `history-import-summary.json`。
`sig` 探针用的假签名 = base64("fake-signature-for-probe-only")（40 字符）。

| case | transcript 里的块 | resume 后 REQ0 到达上游的顺序 | 导入 | 备注 |
|---|---|---|---|---|
| `user` | user(text) ×1 + assistant(text) ×1 | user(string) → system(agent 列表) → assistant(text) → user(text+text) → system | ✅ | 纯文本历史完整；早期 user 被写成**字符串** content，本轮 user 是块数组 |
| `assistant-text` | 2 轮 user/assistant 文本 | u → system → a → u → a → u → system | ✅ | assistant 文本原样保留（含 `IMPORTED-ASSISTANT-TEXT-7c1` 标记） |
| `tool-use` | assistant(tool_use) + user(tool_result) | u → system → a(tool_use) → u(tool_result) → a → u → system | ✅ | `tool_use.id` 与 `tool_result.tool_use_id` 成对保留（`toolu_imported_01` 两侧一致） |
| `thinking-last` | assistant(thinking+sig)+text，两轮都带 | u → system → a(thinking+text) → u → a(thinking+text) → u → system | ✅ | 签名逐字节原样转发（sigLen=40, digest 与输入一致） |
| `thinking-earlier` | thinking 只在**较早**一轮，后面还有 2 轮 | u → system → a(thinking+text) → u → a → u → a → u → system | ✅ | **没有**被剥离：非最后一轮的 thinking 也照样发给上游 |
| `thinking-nosig` | thinking **无 signature 字段** | 同上，thinking 块仍在 | ✅ | 上游会收到 `{type:"thinking",thinking:"…"}`（无 `signature`）：CC 端**不校验、不拒绝、不丢弃** |
| `thinking-badsig` | signature = `!!!not-a-signature!!!` | 同上，thinking 块仍在 | ✅ | 垃圾签名原样转发（sigLen=21）；CC 端零校验 |
| `combined` | 五类全有（2×thinking、1×tool_use/tool_result、4×文本） | u → system → a(thinking+text) → u → a(tool_use) → u(tool_result) → a → u → a(thinking+text) → u → system | ✅ | 11 条 messages，顺序 = transcript 顺序，无重复、无丢失、无合成块 |

结论：

1. **能导**：`--resume` 会读任意合法命名的 `<session>.jsonl`（含外部构造的），五类块全部原样进入 REQ0；不需要 `--session-id` 参与，只要 `projects/<cwd-hash>/<uuid>.jsonl` 里 `sessionId` 与传入值一致即可（本探针 8 个 case 的 `system/init.session_id` 都等于传入值，`stderr` 全空）。
2. **丢什么**：只丢 transcript 里没有的东西。CC 在历史后追加两类**设备侧**消息：`role=system` 的 `Available agent types…`（附件渲染，跟着首条 user 走）和（cwd 漂移时）尾部 `# Environment update`；本轮 live 提问是块数组，早期 user 一律回写为字符串。
3. **thinking signature 是否被校验 → 不校验**（本探针能证明的部分）：假签名、无签名、垃圾签名三种都被逐字节转发，CC 端无本地校验、无告警、exit 0。真实上游会做校验（真 Anthropic 对 unsigned/foreign thinking 返回 400），因此**导入带 thinking 的历史在线上等于必然 4xx**——除非签名真的来自同一组织/同一模型。
4. 对 WP3 的直接结论：G3 技术上"能做"，但**不能整段照搬**。安全子集 = 文本 + tool_use/tool_result（id 可保真重建）；`thinking`/`thinking_signature` 必须**剥掉后重建**（或整轮丢弃），否则导入即被上游拒绝。`history_import_unsupported` 不是必须选项，但 `historyPolicy=strip-thinking` 是必须的默认值。
