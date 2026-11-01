# worker 持久会话：stream-json 双向进程池（设计 + 分期实施）

> 状态：2026-10-17 立项（用户："持久 stream-json 双向会话是重点，特别是回收与节点容量规划。原生工具、document、thinking 规划好，开工"）。
> 实施记录在文末"进度"。相关：ccr-supply.md §6/§8.1（现状）、claude-code-compat.md §10（设备身份）、provider-protocol.md（帧）。

## 0. 为什么

现状（§8.1）每个请求 fork 一个 `claude -p` 进程、把客户的全部历史折叠后一次性喂入、`result` 后进程退出：

| 现状代价 | 数据（2026-10-17 接量日） |
|---|---|
| 首 token 延迟 | p50 6 s，几乎全是进程冷启动（约 2 s 到 init，再到首次上游响应） |
| 缓存 | 每轮重发全量历史；分块后前缀能命中，但仍每轮重建 CC 侧对话 |
| 工具 | prompt 级 ```tool_call 围栏模拟，`tool_choice=any/tool` 不支持，流式需缓冲围栏前缀 |
| thinking / document | 丢弃 / 不支持 |

Claude Code 2.1.300 已具备做持久会话所需的全部开关（worker-01 二进制实测存在）：`--input-format stream-json`
双向多轮、`--replay-user-messages`、`--mcp-config`（http/sse/stdio/sdk）+ `--strict-mcp-config` + `--allowedTools`、
`--max-thinking-tokens`、`--session-id`、`--include-partial-messages`、`--system-prompt-file`。

## 1. 目标形态

```
客户请求 N（全量历史）──网关──隧道(每请求一条)──节点 ──┐
                                                       ├─ 会话池：reuseKey → 常驻 claude 进程（stdin/stdout stream-json）
客户请求 N+1 ──网关：算出"只多了这一轮"──隧道────────┘   同 key、同历史 → 只喂新一轮；否则起新进程全量折叠
```

- **网关/console/隧道层不变**：仍是"一个请求一条隧道"；持久的是**节点内的进程**，隧道结束进程不退出。
- **reuseKey** = `accountId | stickyKey | upstreamModel | sha256(systemPrompt) | thinkingBudget | toolsHash`。
  任一变化 → 新进程（系统提示、思考预算、工具集都是进程级参数）。stickyKey 来自 proxy.ts `stickyKey()`（metadata.session_id
  → cache_control 块 → "系统提示 + 首条 user 消息"兜底），同一对话必然落同一账号才有意义（粘性已保证）。
- **增量判定在网关**（节点不懂折叠规则）：网关按 reuseKey 记 `{lastBlocksHash, lastAssistantText, turn}`。新请求的分块
  `blocks` 若满足 `blocks[0..k] == 上次全部分块` 且 `blocks[k+1] == fold(assistant, lastAssistantText)`（客户原样回传了上一轮
  回答），则 `tail = blocks[k+2..]`，发 `turnMode:"continue", tail, expectedTurn`；否则 `turnMode:"fresh", content=全量`。
  记忆写穿到 SQLite `worker_turn_memory`（迁移 17，2026-10-22，core `affinity.ts`）：网关蓝绿切换后新实例查不到再读库，
  同一对话继续 `continue` 到节点上的活进程；此前重启 = 记忆丢失 = 全部 fresh（节点孤儿会话靠 idle TTL 回收）。正确性不依赖记忆：错了只会多一次 fresh。
- **节点**：`SessionPool`。`continue` 且存在 idle 会话、`session.turn === expectedTurn` → 向 stdin 写一条
  `{"type":"user","message":{"role":"user","content":tail}}`，本轮 stdout 事件照旧经隧道回网关；`result` 后标 idle、turn+1。
  其余情况（无会话 / busy / 停泊等工具结果 / turn 不匹配 / 进程已死）→ 用 open 里的 `history`（continue 随带的全量历史；tool_result 的
  `content` 本身就是全量）起新进程，并把旧会话（若有）退休。**绝不以增量起新进程**；open 里没有全量历史时拒绝该会话（`cc_worker.error`
  `session_lost`，可重试）而不是答错（2026-10-22 事故，见进度）。

## 2. 回收与容量（重点）

实测（worker-01，24 核 / 96 GB）：一个 `claude` 进程 RSS **235–260 MB**（启动即 235，回答中缓慢增长），CPU 几乎为零。

| 参数 | 默认 | 依据 |
|---|---|---|
| `CC_WORKER_MAX_SESSIONS`（live 上限，含 idle） | 公式默认 `floor(0.75 × 物理内存 / 300 MB)`（96 GB ≈ 241）；**worker-01/02 生产用 systemd drop-in `1dayapi-node.service.d/pool.conf` 固定为 400**（用户 2026-10-17 指定 300，2026-10-18 提到 400；400×250 MB ≈ 100 GB 已超两台机器的 94 GB 物理内存，实际由 75% 高水位（≈70 GB，满 RSS 时约 280 个）先按 LRU 退 idle 兜底，400 是给轻量 idle 会话的余量；改值 = 编辑 drop-in → `daemon-reload` → 重启节点，启动时读一次） | 实测单进程 235–260 MB，300 MB 预算含上下文增长；75% 与内存高水位同口径，高水位会先按 LRU 退休 idle，上限只兜最坏情况。实际 live 一般两位数（2026-10-17 白天 5–17） |
| `CC_WORKER_IDLE_TTL_MS` | 10 min | 上游缓存 5 min；客户多轮间隔通常 < 10 min；超过即退休，下次 fresh |
| `CC_WORKER_MAX_TURNS` | 50 | 与云端 session-pool 同；防单进程无限增长 |
| `CC_WORKER_MAX_AGE_MS` | 60 min | 兜底；也压低 CC 自行刷新 token 与 console 保活刷新"抢刷新"的概率（见 §5 风险） |
| 内存高水位 `CC_WORKER_MEM_HIGH` | 75% 物理内存 | 看门狗每 30 s：高于则按 LRU 退休 idle 会话；仍高于 → 拒新会话 `worker_overloaded` |
| busy 并发 | 沿用 `maxConcurrency`（按内存推算的进程并发）；**idle 不计入账号并发**（调度器只看 busy） | |
| 退休顺序 | 先 idle 最久未用 → 再超龄 → 永不杀 busy（busy 只受 600 s 单轮超时约束） | |

退休 = 关 stdin、等 2 s、SIGTERM 进程组、删 scratch 目录；会话事件 `evicted(reason)` 计数进心跳。
心跳 `ccWorker` 新增：`live, idle, busy, evictions{idle,age,turns,memory,capacity}, rssMb`（控制台节点页展示）。

**容量规划口径**：节点可承载的"活跃对话"≈ `MAX_SESSIONS`；按客户当前 500 req/h、对话间隔 1–3 min 估算同时活跃对话 ≈
30–60，worker-01 余量 2–4 倍。扩容信号：心跳 `evictions.capacity > 0` 或 `live/MAX > 0.8` 持续 10 min → 加节点
（账号绑定代理在节点上，扩容 = 新节点 + 新账号批次，不是迁移）。

## 3. 原生工具（阶段 2）

- 节点为每个**有工具的**会话写 `mcp-config.json`：`{"mcpServers":{"caller":{"type":"http","url":"http://127.0.0.1:<port>/mcp/<sid>/<token>"}}}`，
  启动参数加 `--mcp-config <file> --strict-mcp-config --allowedTools "mcp__caller__*"`（无需权限交互）。
- 节点内置一个 MCP HTTP 服务（Bun.serve，仅回环）：`initialize` / `tools/list`（客户 `tools` 定义原样）/ `tools/call`。
- `tools/call` 不在节点执行：节点发帧 `cc_worker.tool_call {sessionId, callId, name, input}` → 网关把它翻成客户可见的
  `tool_use` 块并**结束本次客户响应**（`stop_reason: tool_use`），**CC 这一轮悬而未决**（MCP 调用挂起）。
- 客户下一请求（同 reuseKey）带 `tool_result` → 网关识别 tail 全为 tool_result → `turnMode:"tool_result", results[]` →
  节点逐个回复挂起的 MCP 调用 → CC 继续**同一轮** → 输出流入新的客户响应。挂起超时 10 min → 以错误结果回复并退休会话。
- 翻译层：有了原生 `tool_use` 事件（`content_block_start type=tool_use name=mcp__caller__X` + `input_json_delta`），
  直接透传为客户 tool_use（去 `mcp__caller__` 前缀），**围栏模拟仅保留给云端 executor**。`tool_choice=any/tool` 仍不支持
  （CC 无对应开关），文档写明。

## 4. thinking 与 document（阶段 3/4）

- thinking：客户 `thinking:{type:"enabled",budget_tokens}` → 进程参数 `--max-thinking-tokens <budget>`（进 reuseKey）；
  翻译层把 `thinking_delta` / `signature_delta` / thinking 块原样透传（本就是原生 Messages 事件）。客户未开启 → 继续丢弃。
- document：worker 的 `ccrUnsupportedReason` 放行 `document`，随轮次进内容块（与 image 同路径）；先用平台 key 实测 CLI 接受
  base64 PDF 再放开。

## 5. 风险与对策

| 风险 | 对策 |
|---|---|
| 常驻进程期间 CC 自行刷新 OAuth token，与 console 保活刷新竞争（refresh token 轮换） | 会话 max age 60 min ≪ token 8 h；console 已提前保活刷新，CC 极少触发；若出现 `auth` 失败，console 下次 open 会下发新凭据（fresh 进程重写 .credentials.json） |
| 增量误判（客户改了历史却恰好前缀相同） | 比对的是全量分块哈希 + 上一轮回答原文，改历史 = 不同哈希 → fresh；只可能"该复用没复用"，不会"错复用" |
| 串味 | reuseKey 含 accountId + stickyKey；无 stickyKey（匿名单轮）永不复用（与云端池同） |
| 内存失控 | 高水位看门狗 + LRU；busy 不杀但受 600 s 超时 |
| 节点重启 | 已有优雅排空：draining 时不接新会话、等 busy 跑完（idle 直接退休），最多 60 s |
| 客户在 tool_use 悬挂期间不再回来 | 10 min 超时回错误结果并退休；期间该会话占 1 个 live 名额 |

## 6. 分期与验收

| 阶段 | 内容 | 验收 |
|---|---|---|
| 1 | 节点会话池 + 回收/容量 + 网关增量判定 + 协议字段（`reuseKey/turnMode/tail/expectedTurn`）+ 心跳容量指标；设置 `ccr_worker_persistent`（0/1）灰度 | 平台 key 三轮对话：第 2/3 轮首 token < 2 s、节点日志 `reused session`、上游 cache_read 持续增长；满载/高水位人为测试触发 LRU |
| 2 | MCP 原生工具 | 自定义工具三轮往返（tool_use → tool_result → 续写）全程同一进程；围栏路径仅云端 |
| 3 | thinking 透传 | 客户开 thinking 时收到 thinking 块与 signature；未开不出现 |
| 4 | document | PDF 问答 200 |

## 7. 阶段 2 开工清单（原生工具）

落点与顺序（每步可独立验证）：

1. **节点 MCP 服务**（`apps/provider-node/src/mcp-server.ts`，新）：`Bun.serve` 回环 HTTP，路径 `/mcp/<sid>/<token>`，实现 JSON-RPC
   `initialize` / `tools/list` / `tools/call`（Streamable HTTP 传输，JSON 响应即可）。`tools/call` 挂起为 Promise，交由 `CcWorkerManager`
   决定何时回复。单测：直接 POST JSON-RPC。
2. **进程参数**：有 `tools` 的会话写 `<workDir>/mcp-config.json`，参数追加 `--mcp-config <file> --strict-mcp-config --allowedTools mcp__caller__*`；
   `tools` 的 JSON 进 reuseKey（已在）。先在 worker-01 用平台 key 验证模型会发出 `tool_use(name=mcp__caller__X)`（`stream_event` 里）。
3. **协议帧**：节点→平台 `cc_worker.tool_call {sessionId, callId, name, input}`；平台→节点 `cc_worker.open` 的 `turnMode:"tool_result"`
   携带 `results:[{callId, content, isError}]`（console registry / routes 透传；`provider-protocol.md` 登记）。
4. **网关**：翻译层把原生 `tool_use` 事件透传给客户（去 `mcp__caller__` 前缀），收到 `cc_worker.tool_call` 后结束响应
   （`stop_reason: tool_use`）并在 SessionMemory 记"悬挂的 callId 列表"；下一请求 tail 全为 `tool_result` → `turnMode:"tool_result"`。
   围栏模拟仅保留给云端 executor（`simulateTools` 只在 executor.ts 为真）。
5. **超时与回收**：悬挂 10 min → 节点回 MCP 错误结果并退休该进程；网关 memory 同步 forget。
6. **验收**：平台 key 三轮往返（tool_use → tool_result → 续写）同一进程；`tool_choice=any/tool` 仍返回 400 并写文档。

阶段 3（thinking）：`--max-thinking-tokens` 进 reuseKey，翻译层透传 thinking/signature 块（客户开启时）。
阶段 4（document）：`ccrUnsupportedReason` 放行 + 分块随轮次，先实测 CLI 接受 base64 PDF。

## 进度

- 2026-10-17：立项，容量实测（235–260 MB/进程），设计定稿；阶段 1 开工。
- 2026-10-17 **阶段 1 上线**（设置 `ccr_worker_persistent=1`）：
  - 节点 `CcWorkerManager` 会话池：`Proc{key, turn, busy, …}`，`launch()` 决定 continue / fresh（`expectedTurn` 不符 → fresh 并把
    计数器对齐到网关的值，下一轮即可复用）；`result` 行结束一轮、进程常驻；`retire()` 统一退休（idle/age/turns/memory/capacity/
    replaced/client_closed/turn_failed/drain）；30 s 看门狗；池满且无 idle → 降级一次性进程（`capacity_oneshot`）。
    worker-01/02：max 300 live（drop-in；公式默认 241，原 120）、idle 600 s、50 轮、1 h、内存 75%。心跳 `ccWorker.pool{live,idle,busy,maxLive,rssMb,evictions}`。
  - 网关 `session-memory.ts`：按 reuseKey 记（全量分块哈希、上一轮回答折叠块、turn、**进程累计 usage**）；`planTurn` 判 continue。
    首轮也按 `[user]\n…` 分块（`alwaysBlocks`），否则第 2 轮前缀对不上（首测踩坑）。
  - **计费踩坑**：Claude Code 的 `result.modelUsage` 是进程累计值；续写轮必须减去上一轮累计（`usageBaseline`），`system/init`
    事件（新进程）清零。修复前曾按累计值计费约 22 条测试请求（$0.07，仅平台 key）。
  - 实测（sonnet，4 轮）：延迟 1.9 → 1.1 → 0.9 → 0.9 s（此前每轮 4.2–4.7 s）；客户可见 cache_read 1259 → 3872 → 6086 → 7268。
    **待核实**：持久进程从第 2 轮起上游上下文比"每轮全量折叠重放"多约 3.8k token（第 2 轮一次性 cache_creation ≈ 首条用户消息大小，
    之后稳定），疑为 CC 内部对首条消息的二次持有；按读价计费影响很小，但要抓包确认来源。
  - 下一步：阶段 2 MCP 原生工具（需要持久会话 + 挂起的 tools/call），阶段 3 thinking，阶段 4 document。
- 2026-10-17 **阶段 2 上线**（设置 `ccr_worker_native_tools=1`，依赖 `ccr_worker_persistent=1`）：
  - 节点 `mcp-server.ts`：回环 Streamable-HTTP MCP（`initialize`/`tools/list`/`tools/call`），`tools/call` 挂起为 Promise；
    会话以 `reuseKey`（一次性进程以 sessionId）注册，`/mcp/<sid>/<token>`。进程参数 `--mcp-config <workDir>/mcp-config.json
    --strict-mcp-config --allowedTools mcp__caller`；worker 环境 `NO_PROXY=127.0.0.1,localhost`（此前为防绕过删了 NO_PROXY，
    MCP 回环请求会被送进代理 → ConnectionRefused，首测踩坑）。实测 `--tools ""` 不影响 MCP 工具加载。
  - 挂起的调用以合成 stdout 行 `{"type":"1dayapi_tool_call",callId,name,input}` 经现有 data 帧到网关，**协议无新帧**；网关翻译层把
    `mcp__caller__<name>` 的原生 tool_use 透传为客户 tool_use（去前缀），全部 tool_use 都有挂起调用后结束响应（`stop_reason: tool_use`），
    `SessionMemory` 记 `pendingCalls`；客户下一请求的 `tool_result` → `turnMode:"tool_result", results[{callId,content,isError}]` →
    节点回复 MCP → 同一轮续写流入新响应。节点 `handleClose` 时若有挂起调用则**停泊**（`awaiting_tool_result`）而非退休，10 min 超时退休。
  - 竞态：客户的 tool_result 常比上一条隧道的 close 帧先到节点（进程仍 busy）；节点以"结果引用了本进程挂起的 callId"为凭据直接
    拆下旧会话并续写（日志 `tool results arrived before the close … detached`）。一次性进程（池满/同 key 忙）也注册 MCP，否则模型拿到
    "你有工具"的系统提示却无工具可调，会把调用写成 `<invoke>` 文本（首测踩坑）。
  - 计费：停泊时把本响应已计的原始 usage 累加进进程总量，续写请求只计增量（`rawUsage`）。
  - 实测（sonnet，流式/非流式各一组）：tool_use 2.0–2.4 s → tool_result 续写 1.0–1.3 s → 第 3 轮 0.9–1.1 s，全程同一进程，
    客户可见 cache_read 154 → 530 → 640。围栏模拟只剩云端 executor 在用。`tool_choice=any/tool` 仍 400（CC 无对应开关）。
- 2026-10-17 **阶段 3（thinking）+ 阶段 4（document）上线**：
  - document：worker 的 `ccrUnsupportedReason` 放行 `document`，随轮次进内容块（`source` + title/context/citations，客户 cache_control 不透传）。
    实测：812 字节 base64 PDF 问"暗号是什么"→ 正确答出 `PELICAN-7`，2.0 s。
  - thinking：客户 `thinking:{type:"enabled",budget_tokens}` → 进程 `--max-thinking-tokens N --settings {"alwaysThinkingEnabled":true}` +
    env `MAX_THINKING_TOKENS`（进 reuseKey）；翻译层透传 thinking / redacted_thinking 块与 `thinking_delta` / `signature_delta`，未开启则照旧丢弃。
    **实测发现**：仅凭预算，sonnet/opus 5.5 都不思考（`thinkingTokens: 0`，连三箱水果谜题也不）；Claude 5 在 CC 里是**自适应思考**，
    触发它的开关是 **`--effort`**。于是把客户的 `effort`（或 `output_config.effort`，low/medium/high/xhigh/max）透传为 `--effort`（进 reuseKey）：
    opus `effort:high` → thinkingTokens 16，`effort:max` → 1017，客户收到 `thinking` 块**带签名但正文为空**（上游在该模式下不下发思考正文，
    只给可回传的 signature）。结论：结构透传完成；思考正文是否可见由上游决定，不是翻译层能补的。
  - 顺带：这是 worker 路径第一个被透传的"采样类"参数（effort）；`max_tokens/temperature/top_p/stop_sequences` 仍无对应开关（ccr-supply §6）。
- 2026-10-17 **停泊从未发生的根因**：生产观测到 78 条"parked on N tool call(s)"却 0 条节点 `parked with`、挂起进程 600 s 后 `worker_timeout`。
  根因在隧道层：网关 `_destroy` 的 `POST …/close` 无 body 但带 JSON 头，Fastify 回 400，节点从未收到 `cc_worker.close`（也意味着客户端断线
  从未让节点停止生成）。修复后停泊路径生效（`close frame … pending 1` → `parked`），`tool_timeout`（10 min）接管未回传结果的会话。
  附带诊断：网关日志 fresh 原因 `(no_memory|expired|prefix@i/n|echo|no_tail, N blocks)`。首批样本：`prefix@62/63`（客户改写了最后一条
  用户消息）、`echo`（客户回传的 assistant 内容与我方折叠不一致，待对比长度/位置）、`no_memory`（网关重启清空记忆）。
- 2026-10-17 **保真度修复**（用户："翻译以后失真很厉害"；实测工具：自写 11 用例 + [veridrop](https://github.com/canarybyte/veridrop) full 模式，
  Sonnet 5.5 78.8 / Haiku 4.5 77.7，官方 100；thinking 签名、PDF、协议、ID 全过，失分集中在下面几项）：
  - `tool_choice: any/tool` 原 400（veridrop「结构化输出」0 分，权重 12%）→ worker 路径在本轮内容末尾追加 `[Caller requirement] …exactly one tool call…`
    文本块（`toolChoiceInstruction`，原生/围栏两种措辞），**不进会话哈希**（下一请求无需回显），`ccrUnsupportedReason(..., {toolChoice:true})` 放行。
  - `max_tokens` 原被忽略（cap 50 → 1273 tokens；Haiku 同题输出 [582,803,370] vs 官方 [52,47,52]）→ 网关把 `max_tokens` 经 console →
    节点传成进程 env `CLAUDE_CODE_MAX_OUTPUT_TOKENS`（bundle 校验：任意正整数，超模型上限则截到上限；进 reuseKey `max:<n>`）。
    上游 `message_delta.stop_reason=max_tokens`（或无 partials 时 `assistant.stop_reason`）→ 翻译层 `finishEarly`：关块、`done`、`cutShort`，
    网关取消隧道 → 节点 `handleClose` 退休该进程。原因：Claude Code 自己会在 max_tokens 后注入 "Your response was cut off… Continue from
    where you left off" 再调一次，必须在它续写前掐断。usage 取自 stream 事件（message_start input + message_delta output），无 result 也完整。
  - `stop_sequences` 原被忽略 → 翻译层在纯文本路径（非围栏模拟）扫描块文本，最早的完整匹配处截断、`stop_reason: stop_sequence` +
    `stop_sequence: <串>`，同样 `cutShort` 取消会话；流式扣住"最长停止串 − 1"个字符的尾巴，保证不会把半个停止串发给客户。
  - 流式 `message_start.usage.input_tokens` 原为 0（veridrop 两项扣分）→ 用上游 message_start 的 usage 经基线换算填入（上游 message_start
    先于首个内容块到达）。
  - **计费**：Haiku 上 Claude Code 前缀（~600 token）低于 2048 缓存下限不进缓存、上游记成普通 input，基线只从 cache 字段里减 → 客户每请求
    多付 ~590 input（count_tokens 15 vs 账单 606）。`usageOut()` 现按 read → creation → input 顺序扣基线。副作用：基线（700）高于某进程实际
    前缀时会少算客户几十 token，可接受。另一条未解：同账号两次 `cacheCreation≈4140`（常态 ~770）、10 词提示记 3442 input，触发条件未定位。
  - 身份泄露（"built on Anthropic's Claude Agent SDK"）：bundle `jzn()` 在非交互模式**无条件**前置身份句、无开关 → 只能在 worker 系统提示附注里
    要求"采用调用方身份、不得自称 Claude Code / Agent SDK"，属缓解。
  - **隐藏 thinking**（修复后复测发现）：Claude Code 对支持的模型默认开启 thinking（settings `alwaysThinkingEnabled` 缺省即开），Haiku 4.5 一条
    短答案 94 个输出 token 里 73 个是客户看不见却要付费的思考；`max_tokens: 80` 时预算被思考吃光、正文为空（veridrop 响应完整性 40 分）。
    节点：客户未请求 thinking 且未传 effort → 进程 env `MAX_THINKING_TOKENS=0`（bundle：`h===0 → {type:"disabled"}`）；传了 effort 不能关
    （CC 拒绝"thinking 关闭时的 effort"）。
  - 复测（veridrop full）：Sonnet 5.5 78.8 → **95.3**，Haiku 4.5 77.7 → **93.6**；11 用例中 tool_choice / max_tokens / stop_sequences 全部转绿。
    剩余扣分：Token 用量（短/长提示 input 增量偶尔偏大——同账号进程前缀波动；Haiku 基线 700 高于实际 ~590 导致少算客户几十 token）。
  - 未修：`temperature/top_p/top_k`（无开关）、assistant 预填（模型重头写）、围栏模拟路径下的 stop_sequences、按模型分别校准缓存基线。
- 2026-10-17 **真实编程任务实测（agent 循环：list_files/read_file/write_file/run_tests/run_node，7 个红测试的小项目）暴露并行工具调用缺陷**：
  模型首轮并行发出 `list_files + run_tests` 两个 tool_use，网关 64 s 才返回、第二轮模型又重新 list_files、第三轮连接被掐（stream idle 300 s）。
  根因：Claude Code 对 MCP 工具默认**串行**执行（bundle：`isConcurrencySafe = annotations.readOnlyHint ?? false`），第 1 个调用挂起等客户结果，
  第 2 个要等 CC 的 MCP 单调用超时（默认 60 s，`MCP_TOOL_TIMEOUT` 下限 60 s）后才发出；网关要等齐全部挂起调用才结束响应；超时的调用还让模型拿到
  错误结果。修复：① 节点 MCP `tools/list` 为每个客户工具声明 `annotations: {readOnlyHint: true, destructiveHint: false, openWorldHint: false}`
  （节点本身不执行任何东西，并行无害）→ CC 并行发出全部调用；② worker 环境 `MCP_TOOL_TIMEOUT=600000`（= 节点 TOOL_RESULT_WAIT_MS）、
  `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY=50`（默认 10）；③ 网关兜底：`stop_reason: tool_use` 后 3 s 内挂起调用仍不齐 → 直接把 tool_use 消息交给客户、
  忘记会话记忆（下一请求全量重放起新进程），不再死等（`readFor(1s)` 带超时读、`parkProgress` 诊断日志）。
  **修复后复测（agent 循环，Sonnet 5.5）**：任务 1（修 2 bug + 2 命令，7 测试）流式 4 轮 11 调用 32 s、非流式 4 轮 12 调用 26 s；任务 2（CSV 导出 +
  预算 + 格式层重构，14 测试）4 轮 15 调用 37 s。每轮 tool_use id/名称/入参合法，10 个并行 read_file 一轮内全部挂起→返回，tool_result 续写同一进程，
  客户可见 cache_read 逐轮增长（539 → 1235 → 1373 → 8218），模型最终总结与实际改动一致，test/ 未被改动。顺带发现 X-23 流式漏计费回归（已修）。
  测试脚本与样例项目在会话 scratchpad `agent-task/`（agent.mjs + template/ template2/）。
- 2026-10-17 **thinking 自适应模式透传**（用户看到 veridrop「思维签名验证：加密验证未通过」）：该检测对 Claude 5 模型发
  `thinking:{type:"adaptive"} + output_config.effort`，期望响应里有带 Anthropic 服务端签名的 thinking 块（签名 ≥ 50 字符即 100 分；
  无 thinking 块 = 0 分 = "加密验证未通过"）。此前 worker 只把 `type:"enabled"` 当作"客户要 thinking"：adaptive 请求下模型其实在想
  （effort → `--effort`），翻译层却因 `thinking:false` 把签名块丢掉，客户只看到正文。`planThinking()`：enabled/adaptive 都透传；adaptive
  未带 effort 时补 API 默认 `high`（CC 里自适应思考的开关）。复测：Sonnet/Opus 5.5 非流式与流式都返回 thinking 块 + 1.3k 字符签名
  （正文为空，上游在 CC 模式下只给签名），本地 veridrop（补了 Claude 5 模型定义）Sonnet 5.5 总分 98.6、思维签名 100。
  - 协议：`cc_worker.open` 新增可选 `maxTokens`，老节点忽略（max_tokens 继续无效），其余改动全在网关/console。
- 2026-10-22 **网关侧记忆跨发布保持**（用户：切换时对话 / 设备 / 账号要一一对应回去）：`SessionMemory` 增加可选 `TurnMemoryStore`，worker.ts 接
  core `loadTurnMemory / saveTurnMemory / deleteTurnMemory`（表 `worker_turn_memory`，key = reuseKey，JSON 整条 TurnMemory 含 usage 基线与
  pendingCalls，TTL 同进程内 10 min）。进程内 Map 仍是热缓存：remember / forget 写穿，get 查不到或过期再读库回填。蓝绿切换后新实例对同一对话
  算出 `continue`（expectedTurn 与节点进程一致），不再 fresh 全量折叠；usage 基线也回来了，续写轮仍只计增量。网关每 10 min 清过期行，
  启动日志 `affinity: … N worker turn memories carried over`。同日同机制的粘性会话 / 设备池见 gateway.md §3「跨发布保持」。
- 2026-10-22 **事故：对话历史被砍短**（客户 mirasim 报告，一会话 149 次请求 20 次只收到 system + tools + 新增几条；另一用户 10-21 同样）。
  链路：原生工具轮次结束、进程停泊等客户 tool_result → 客户回传的 tool_result 后面跟着 Claude Code 2.1.x 的 `role:"system"` 中途消息
  （per-turn-control）→ 网关 `planToolResult` 只看最后一条消息，判成普通 `continue` → 节点把增量当用户消息写进一个正阻塞在 MCP 调用里的
  进程，进程不读，请求挂死 → 客户端约 120 s 超时重发 → 节点见进程仍 busy，`continue miss -> fresh`，**只用增量起了新进程** → 模型只看到
  system + tools + 3 条新消息。7.5 小时内 worker-01 上 107 次砍短、278 个进程因工具结果永远等不到而 tool_timeout。
  修复（网关 + console + 节点）：① 网关 continue 的 open 随带 `history`（全量分块），节点落空时据此起进程，没有全量历史则拒绝
  （`session_lost`）；② 节点 continue 不再接受停泊中（awaitingTools）的进程，视为落空；③ 网关 `planToolResult` 在尾部 system 消息之前找
  tool_result 的 user 消息，旁带文本（同消息里的 text 块、尾部 system 消息）并入最后一个结果；④ 节点真的 fresh 时翻译层已按 init 清基线，
  网关加日志 `node restarted <key> from full history`。console 只是转发新字段 `history`。测试：节点 `cc-worker.test.mjs` 新增三段
  （mismatch 用全量历史、无历史拒绝 + busy 一次性全量、停泊进程不被续写），网关 `session-memory.test.mjs` 新增尾部 system 消息用例。
- 2026-10-23 **模型续写转录（opencode 客户"回复格式莫名出问题"）**：客户收到的正文是 `[assistant]\n… ```tool_call {"id":"toolu_…","name":"bash",…}``` \n[user]\n[tool_result for toolu_…]\nremoved …`——
  围栏里带 `id` 正是网关折叠历史用的格式（模型自己的调用协议没有 id），即模型在"续写转录"而不是回答，`rm`/`nginx -t`/`reload` 及其"输出"全是编的，
  客户以为已执行。触发条件：`fresh` 全量折叠 + 长对话（整段历史是一条 user 消息里的带标签文本）+ 原生工具模式下历史里的 tool_use 仍是围栏且没有任何说明。
  **根因之一是分块**：`messagesToBlocks` 超过 64 条消息后 `chunk = ceil(n/64)`，上一轮回答的折叠块与新 user 消息并进同一块，`planTurn` 永远在倒数第二块
  `prefix@` 失配——网关 3 小时统计 6080 次 open：fresh 5286 / tool_result 642 / continue 152，fresh 里 2152 次是分块历史（prefix 1260、no_memory 526、
  echo 216、no_tail 150）；每轮全量重放还意味着整段历史 cache 写（一轮 opus-4-6 写 12.3 万 token，$1.71）和冷启动首字延迟。
  修复（全在网关 `translate.ts` / `worker.ts`）：① 分块改为"前 ⌊n/64⌋·64 条每 64 条一块、尾部逐条一块"，边界从头对齐，只有每第 64 条消息会把一串单块
  收成一组（每 64 条 fresh 一次），超过 64 组时组大小翻倍；② 原生工具模式历史里的 `tool_use` 折成 `[tool_use <id> <name>]` 行，系统提示说明转录格式并禁止续写、禁止编造工具输出
  （系统提示变化 → 发布后在途会话各 fresh 一次）；③ `SessionTranslator` 转录护栏 `transcriptGuard`：开头 `[assistant]` 标题去掉（流式先扣住 12 字符）；
  `\n[tool_result for ` 出现即截断（去掉悬空的 `[user]` 行，`end_turn`、cutShort 取消会话、忘记记忆），流式多扣 26 字符保证不漏；原生模式下文本围栏
  → 转成 `tool_use`（`toolNames` 校验，无停泊 MCP 调用，客户回传 tool_result 时按全量历史 fresh），围栏后的续写丢弃；围栏模拟模式 `finalizeBlocks`
  同样先丢围栏后的续写再抽取调用。日志 `[ccr-worker] <id> transcript guard on <account> (<plan>, <n> blocks): <kinds>`。
  测试：gateway `translate.test.mjs` 新增 5 条（折叠样式、分块边界、三种护栏、围栏模拟丢尾）。**遗留**：`echo` 失配 405 次/3 h 说明有客户端没有原样回传上一轮回答，待抓样本。
- 2026-10-23 **前缀失配四连修**（诊断日志 `prefix miss` 抓到的真实原因，上午 15 分钟 4186 次 open 里 fresh prefix 1090、echo 244、continue 仅 114）：
  ① Claude Code per-turn-control 的尾部 `role:"system"` 消息（`<total_tokens>…`、"The user stepped away…"）下一请求会被改写或删掉 → `ephemeralTailCount()`
  把尾部非 user/assistant 消息算作"临时块"：随本轮内容送给进程、**不进哈希**，continue 时追加在新块之后；② Claude Code 的建议侧请求
  （最后一条 user 以 `[SUGGESTION MODE` 开头，同会话同模型）此前会吃掉活进程的一轮并覆盖记忆，真正的下一轮必失配 → `isSuggestionRequest()`
  判定后按一次性进程处理（不读写记忆，日志 `one-shot suggestion`）；③ 子代理与主线程共用 `metadata.user_id` 的 session id，交错落在同一 reuseKey
  → reuseKey 加入 `root:<首块哈希>`；④ 翻译层此前把空文本块（模型先开文本块再直接 tool_use）原样上线，客户端回传时把空块写成 `"."`，
  与网关记住的折叠不符 → `fresh echo`；现在文本块**延迟宣告**（首个非空 delta 才发 `content_block_start`，空块直接丢，tool_use 顶上它的下标）。
  仍未解释：同一 tool_use id 的 tool_result 长度在相邻请求间来回变（12721 ↔ 13312）、assistant 块变长（398 → 1104），疑为客户端侧的结果截断 / 微压缩，待抓样本。
  gateway 单测 101。
- 2026-10-23 下午 **第二轮（按 PID 统计后的真实数据）**：上一条的 ① 只跳过"尾部"system 消息是错的——Claude Code 的 `<total_tokens>…` 等 `role:"system"`
  消息在后续历史里**保留**（只去掉本轮追加的指令段），于是下一轮在期望 assistant 折叠的位置撞上这条保留块 → `fresh echo`（11:09 后 14 分钟 74 次）。
  改为 `messagesToBlocksWithRoles()` 给每个块标角色，**所有 system 角色块一律不进哈希**（原位置照常发送；continue 时发送回显块之后的全部块）。
  另：Claude Code 会把旧 tool_result 正文换成占位符（2301 → 17 字），且时而往 tool_result 里塞 `<system-reminder>`，`normalizeForHash()` 对
  `[user]\n[tool_result for …]` 块只按结果 id 哈希、其它文本去掉 system-reminder 再哈希。gateway 单测 103。
  **统计口径**：`journalctl --since "HH:MM"` 按服务器本地时间（CEST）解析，之前几轮"切换后"统计混进了两小时旧进程日志；以后按 `_PID=<MainPID>` 过滤。


## 8. canonical 模式（2026-11-01，spec WP2，`worker_canonical` 三态 + 节点 `CC_WORKER_CANONICAL=1` → capability `canonical_v1`）

与 legacy 的差别（`apps/provider-node/src/cc-worker.ts` 分支、`apps/gateway/src/ccr/worker.ts canonicalTurn`）：

| 项 | legacy（默认） | canonical |
|---|---|---|
| 系统提示词 | `--system-prompt-file` 替换为平台的 "API assistant" 文本 | **不替换**；客户 system（去掉其计费头行）用 `--append-system-prompt-file` 追加（G1：进主提示词块尾部） |
| 历史 | 全量折叠成 `[user]/[assistant]` 转录喂入 | **不折叠**：fresh 只接受单条 user（原样 content 块）；多轮只能是活进程的 `continue`；否则 409 `history_import_unsupported`；continue 不带 `history` 回退（miss → `session_lost`，不会从折叠转录重启） |
| 内置工具 | `--tools ""` | `--restricted --permission-prompts none`（G6/G7：文件工具限 cwd、无 Bash）；`tools-disabled-canonical` 档再加 `--tools ""`；内置工具的 tool_use/结果只被翻译器消费（`internalTools`），不下发、不当成客户的 tool_use 停止 |
| 客户工具 | prompt 围栏模拟或 MCP | 一律 MCP（`mcp__caller__*`）；需 `ccr_worker_persistent=1`，否则 400 `canonical_requires_persistent_session` |
| session | `--no-session-persistence` | `--session-id <uuid>`，transcript 落在账号 CLAUDE_CONFIG_DIR（节点清理定时器按天清），供 WP3 `--resume` |
| thinking | 无请求则 `MAX_THINKING_TOKENS=0` | 保持 CC 默认（adaptive），I1 |
| attachments | 关 | 仍关（`# Environment` 会带真实 scratch 路径，I2；合成 cwd 待 WP2 后续） |
| 心跳 | — | `ccWorker.canonical = { enabled, profiles: ["cc-<ver>-restricted"] }` |

计数：`canonical_worker_open_total{profile,result}`（`/health.counters`）。控制台只把 canonical open 派给声明 `canonical_v1` 的节点，旧 bundle 永不把它当 legacy 跑（I9）。

## 9. 原生会话、恢复与外部历史（2026-11-01，spec WP3 / §6.3）

- **记忆**：`TurnMemory.native = { sessionId, profileId, revision, state, resumes, imported }`（`worker_turn_memory` 写穿）。`sessionId` 以 CC `system/init.session_id` 为权威；
  `revision` 每提交一轮 +1；`state`：COMMITTED / AWAITING_CALLER（工具轮停泊）；翻译器报错 → 记忆删除（LOST / DIRTY，日志标明），下一请求按新对话处理。
- **continue 失配 → `--resume`**：open 带 `nativeSession:{id, action:"resume", revision}`；节点活进程能接就 stdin 续轮，不能接（exited / busy / turn 不符）就以 `--resume <id>` 起新进程、只喂新一轮
  （G4 实证：正常 resume 不丢不重）。没有可 resume 的会话 → `session_lost`，**绝不**从折叠转录重启（I3/I9）。计 `native_resume_total{result}`。
- **外部历史导入（G3）**：开关 `canonical_history_import`（三态，默认 `0` = 409 `history_import_unsupported`）。开 → 网关 `buildNativeTranscript` 把最后一轮之前的 messages 写成
  CC 自己的 jsonl 形态（`parentUuid` 链、`entrypoint:"sdk-cli"`、`version`；**thinking / redacted_thinking 一律剥掉**——G3 证明二进制对签名零校验、真上游会 400），
  节点写到账号 config dir 的 `projects/<cwd-hash>/<id>.jsonl` 后 `--resume`，再喂最后一轮。工具轮做尾巴的历史不导入（没有生成可接续）。计 `native_history_import_total`。
- **已知窗口**（Pi 探针 T1）：请求在途被杀且 transcript 未落盘 → `--resume` 报 "No conversation found" → 翻译器报错 → 记忆删除（LOST）；有 user 无 assistant 的 transcript resume 会出现
  `assistant:"No response requested."`。两者都只影响被杀那一轮，下一轮在网关侧表现为"会话丢失，重新开始"。
- **未验证项**：`--resume` 与 `--input-format stream-json` 同用是否被真二进制接受（Pi 的探针用的是位置参数提示词）——灰度前先用探针 gate 跑一次。
