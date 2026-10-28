# 1dayAPI 订阅直连形态要求（mirasim.ai 接入说明）

日期：2026-10-19　对象：mirasim.ai 的接入 agent　范围：`POST https://api.1dayapi.com/v1/messages`

## 1. 结论：先回答你们的三个问题

**直通没有关，订阅号也没有满。** 2026-10-19 全天订阅直连都在正常服务。你们自己的 47 条真 Claude Code 请求
（06:00–06:18 UTC，北京时间 14:00–14:18）全部走了直连，而且那已经是判据收紧之后。

**判据在 2026-10-19 05:36 UTC（北京时间 13:36）收紧了。** 收紧前只核对 5 项：UA、`x-app`、`claude-code-20250219` beta、
计费头 system 块、`metadata.user_id` 结构。收紧后把真 Claude Code 每条都发的 4 组头提成硬条件：`x-stainless-lang` /
`x-stainless-runtime`、`x-claude-code-session-id`（且必须等于 `metadata.user_id` 里的 `session_id`）、`accept`、`anthropic-version`，
另加「UA 版本不低于 Anthropic 对该模型要求的最低 Claude Code 版本」。收紧原因：有第三方只补齐了前 5 项、用非 node 运行时伪装成
Claude Code 打到订阅号上。完整清单见第 3 节。

**你们下午的重放不是「原样」。** 12:00–12:20 UTC（北京时间 20:00–20:20）重放的 19 条全部被判 suspect。最常见的缺失组合是
`x-stainless-*`、`x-claude-code-session-id`、`accept` 三组头同时没有，这正是用 curl / requests 之类工具重放时最容易丢的头。
逐条原因见第 4 节。

**现在的处置策略是 downgrade。** suspect 请求不报错，静默改走 cc-worker 路径。所以「开关开、关都返回 200」是预期行为，
请求成功不代表走了直连。

**其他两件事。** cc-worker 不是降级品，它同样是真实的 Claude 订阅服务，只是执行方式不同，见第 9 节。cc-worker 回包里泄露号主邮箱的问题已在 2026-10-19 修复。`/api/pool` 返回 404 与直连判定无关，另行处理。

## 2. 判定流程

1. 看 `user-agent`。不以 `claude-cli/x.y.z` 或 `claude-code/x.y.z` 开头 → 判为 `not_cc`，不做后续检查，按普通客户端走 worker 路径。
   你们 10-17 的 761 条和 10-19 的 158 条请求就是这一类，这是正常的非 CC 通道，不是故障。
2. UA 是 CC → 逐项跑第 3 节的硬检查。
3. 全部通过 → `genuine` → 订阅号直连（回包 id 以 `msg_01` 开头）。
4. 任一失败 → `suspect` → 当前策略 downgrade → 走 cc-worker 路径，仍返回 200。
5. 硬检查只看结构，不比对具体字符串。Claude Code 升级改了 beta 列表、工具数、主提示词都不会被误判。

## 3. 硬检查清单（9 项必须全部满足）

| # | 项目 | 要求 | 失败代号 |
|---|---|---|---|
| 1 | `user-agent` | `claude-cli/<x.y.z> (external, <entrypoint>)`。交互式 entrypoint 为 `cli`，`-p` / Agent SDK 为 `sdk-cli` | （不是 CC 则 `not_cc`） |
| 2 | `x-app` | 恒为 `cli` | `x_app_cli` |
| 3 | `anthropic-beta` | 逗号分隔，必须包含 `claude-code-20250219`。其他 beta 按真 CC 发什么就带什么 | `beta_claude_code` |
| 4 | `system[0]` 计费头块 | `system` 必须是数组；第 0 块是 text 块，内容形如 `x-anthropic-billing-header: cc_version=2.1.301.f23; cc_entrypoint=sdk-cli;`，无 `cache_control` | `billing_header` |
| 4b | 计费头版本 | `cc_version=` 的 `x.y.z` 必须等于 UA 里的版本（后缀如 `.f23` 可有） | `billing_version_mismatch` |
| 5 | `metadata.user_id` | **JSON 字符串**（不是对象）：`{"device_id":"<64 位 hex>","account_uuid":"","session_id":"<uuid>"}`。旧拼接格式 `user_xxx_account_xxx_session_xxx` 不通过 | `metadata_user_id` |
| 6 | `x-stainless-lang` / `x-stainless-runtime` | 分别恒为 `js` 和 `node` | `stainless_js_node` |
| 7 | `x-claude-code-session-id` | uuid，且必须等于第 5 项里的 `session_id`（大小写不敏感） | `session_id_header` / `session_id_mismatch` |
| 8 | `accept` | 必须包含 `application/json`（真 CC 即使 `stream:true` 也发 `application/json`，不是 `text/event-stream`） | `accept_json` |
| 9 | `anthropic-version` | 恒为 `2023-06-01` | `anthropic_version` |
| 10 | UA 版本下限 | 这是 Anthropic 自己的门槛，低于它直连只会收 400。当前：`claude-opus-5-5*` ≥ 2.1.280，`claude-fable-5-1*` ≥ 2.1.251；sonnet 暂无 | `version_below_model_minimum` |

建议：UA 版本直接用你们真实安装的 Claude Code 版本（≥ 2.1.300），计费头块里的版本跟着 UA 走。

## 4. 你们近 36 小时失败的具体原因

数据来自你们 Key-01 在 2026-10-18 02:00 UTC 至 10-19 12:30 UTC 的判定日志。

| 缺失项 | 次数 | 发生时间（UTC） | UA 版本 | 含义 | 修法 |
|---|---|---|---|---|---|
| `metadata_user_id` | 17 | 06:02–06:04 | 2.1.301 sdk-cli | 其他全对，只有 `metadata.user_id` 不是要求的 JSON 结构。很可能是你们的中间层改写/删掉了 `metadata`，或还在用旧拼接格式 | 按第 3 节第 5 项发 JSON 字符串；`session_id` 与 `x-claude-code-session-id` 一致 |
| `stainless_js_node,session_id_header,accept_json` | 9 | 12:00–12:20 | 2.1.284 / 2.1.301 | 重放时丢了 `x-stainless-*`、`x-claude-code-session-id`、`accept` 三组头。这就是「上午原请求重放也不直通」的原因 | 重放工具要把原请求的**全部**头原样带上，不能只带 UA、x-app、beta |
| `stainless_js_node,session_id_header` | 5 | 12:01–12:19 | 2.1.284 / 2.1.301 | 同上，少了两组头 | 同上 |
| `beta_claude_code,stainless_js_node,session_id_header,accept_json` | 4 | 12:00–12:20 | 2.1.284 | 除上面三组头，`anthropic-beta` 还缺 `claude-code-20250219` | 同上，并补 beta |
| `billing_version_mismatch,stainless_js_node,session_id_header,accept_json` | 2 | 12:20 | 2.1.301 | 计费头块里的版本与 UA 版本不一致（例如 UA 换成了别的版本但 system 块没改） | 两处版本保持一致 |
| `billing_header` | 2 | 06:02 | 2.1.301 | `system` 不是数组，或第 0 块不是计费头 | 按第 3 节第 4 项 |
| `x_app_cli,billing_header,metadata_user_id` | 2 | 05:56 | 1.0.100 | 老版本 / 新探针形状，缺三项 | 不要用 1.x 的 UA；按第 5 节的样例发 |
| `x_app_cli` | 1 | 06:16 | 2.1.301 | 只缺 `x-app: cli` | 补头 |
| `billing_header,metadata_user_id` | 1 | 05:59 | 2.1.301 | 缺计费头块和 metadata | 按第 3 节 |
| 全缺（6 项） | 1 | 12:14 | 1.0.100 | 只改了 UA | 按第 5 节的样例发 |

要点：06:00–06:18 UTC 那批通过直连的 47 条，和同一时段失败的 20 条，来自同一个 Key、同一个出口 IP。
说明你们有一条链路（真 Claude Code）是合格的，另一条链路（自建探针 / 重放 / 中间层改写）不合格。把不合格链路对齐到合格链路即可。

## 5. 最小合格请求示例

agent 可以直接照抄结构，替换凭证、session id、device id 和业务内容。

### 请求头

```http
POST /v1/messages HTTP/1.1
host: api.1dayapi.com
authorization: Bearer <你们的 1dayAPI key>
content-type: application/json
accept: application/json
user-agent: claude-cli/2.1.301 (external, sdk-cli)
x-app: cli
anthropic-version: 2023-06-01
anthropic-beta: claude-code-20250219,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05
anthropic-dangerous-direct-browser-access: true
x-claude-code-session-id: 7c1b0f4e-3f0a-4b1e-9a7c-2d6e8f1a2b3c
x-stainless-lang: js
x-stainless-runtime: node
x-stainless-runtime-version: v22.21.0
x-stainless-os: Linux
x-stainless-arch: x64
x-stainless-package-version: 0.128.0
x-stainless-retry-count: 0
x-stainless-timeout: 600
```

硬检查只看其中的 `user-agent`、`x-app`、`anthropic-beta`、`accept`、`anthropic-version`、`x-claude-code-session-id`、
`x-stainless-lang`、`x-stainless-runtime`。其余 `x-stainless-*` 和 `anthropic-dangerous-direct-browser-access` 真 CC 都发，建议一并带上。

### 请求体

```json
{
  "model": "claude-opus-5-5",
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "<你们的用户消息>", "cache_control": { "type": "ephemeral" } }
      ]
    }
  ],
  "system": [
    {
      "type": "text",
      "text": "x-anthropic-billing-header: cc_version=2.1.301.f23; cc_entrypoint=sdk-cli;"
    },
    {
      "type": "text",
      "text": "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
      "cache_control": { "type": "ephemeral" }
    },
    {
      "type": "text",
      "text": "<你们的主系统提示词，真 CC 这一块约 27KB>",
      "cache_control": { "type": "ephemeral" }
    }
  ],
  "tools": [],
  "metadata": {
    "user_id": "{\"device_id\":\"3f9c1e2d4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0\",\"account_uuid\":\"\",\"session_id\":\"7c1b0f4e-3f0a-4b1e-9a7c-2d6e8f1a2b3c\"}"
  },
  "max_tokens": 32000,
  "thinking": { "type": "adaptive", "display": "omitted" },
  "context_management": { "edits": [ { "type": "clear_thinking_20251015", "keep": "all" } ] },
  "stream": true
}
```

必须注意的三处：

- `system[0]` 是计费头块，**没有** `cache_control`；`cc_version` 的 `2.1.301` 必须和 UA 一致。
- `metadata.user_id` 是**序列化后的 JSON 字符串**，`device_id` 64 位 hex（每台机器固定一个），`session_id` 每个会话一个 uuid，
  并且和请求头 `x-claude-code-session-id` 相同。
- `tools` 有的话按名称字母序排列，且不要带 `strict` 字段；`thinking` 对 5.x 模型用 `{"type":"adaptive"}`，不要发 `budget_tokens` 或 `disabled`。

## 6. 软检查（只记录不判定，建议对齐）

这些项目当前不影响判定，但描述的是真 Claude Code 的样子。平台会持续观察，未来可能提成硬条件，建议现在就对齐：

- `stream: true`
- `system[1]` 是身份句（`You are Claude Code, Anthropic's official CLI for Claude.` 或 `You are a Claude agent, built on Anthropic's Claude Agent SDK.`），带 `cache_control`
- 有一块超过 4000 字符且带 `cache_control` 的主提示词
- `tools` 按名称字母序、无 `strict`
- 带 `thinking` 对象
- 带 `context_management`

你们 12:20 UTC 的请求在软检查上还缺：`stream_true`、`main_prompt_cached`、`thinking`、`context_management`。

## 7. 自检与验收

**从回包判断。** 你们现在用的办法仍然成立：直连回包 `id` 以 `msg_01` 开头（Anthropic 原生 id）；cc-worker 路径的 id 是 `msg_` 加 24 位随机
base62，不会以 `01` 开头。流式回包看 `message_start.message.id`。

**不要用「能不能成功」判断。** downgrade 策略下 suspect 请求照样 200，只是换了路径。

**联合验收流程。**

1. 按第 3、5 节改好后，用同一个 Key 发 5 条请求（建议 opus-5-5 和 sonnet-5-5 各发几条，流式与非流式都覆盖）。
2. 把发送时间（UTC）告诉我们，我们按 Key 查每条的判定结果和缺失项清单回给你们。
3. 5 条全部 `genuine` 后，再用你们的真实流量验证。

## 8. 注意事项

- **不合格的 CC 形状绝不会放行直连**，这不是针对你们。带 Claude Code UA 但形态不对的请求打到订阅号上，Anthropic 会直接回 429
  （实测缺计费头块就是 429），同时是账号上的异常样本，会把号打坏。平台宁可降级走 worker 也不冒这个风险。
- **最省事的做法**是直接用真 Claude Code（`claude -p`）或 Claude Agent SDK，把 `ANTHROPIC_BASE_URL` 指到 `https://api.1dayapi.com`，
  不要自己拼请求。你们 06:00 UTC 那 47 条合格请求就是这么来的。
- 如果一定要自建客户端或走中间层，中间层**不要改写** `metadata`、`system[0]` 和上述请求头，只替换凭证。
- 判据只看结构，不比对具体字符串。Claude Code 升级后 beta 列表、工具列表、主提示词变化不会被误判，你们跟着真 CC 升级即可。

## 9. cc-worker 路径也是正规的 Claude 服务

你们把「进了 cc-worker」当成失败来看，这里把它的性质说清楚。

**它跑的是同一批号、同一批模型。** 直连和 cc-worker 用的是同一个 Anthropic 订阅账号池，模型就是你们请求的 `claude-opus-5-5` /
`claude-sonnet-5-5` 等。区别只在执行方式：直连是把你们的请求体原样转发给 Anthropic；cc-worker 是平台节点上用该账号跑一个**真实的
Claude Code 进程**，把你们的请求喂进去，再把它的输出翻译回 Messages API 格式。回答是真实模型生成的，不是缓存、不是小模型、不是转述。

**用量是真实的。** 回包里的 `usage` 来自 Anthropic 对那次 Claude Code 会话的真实计量，平台只是扣掉了节点自身的上下文开销（Claude Code
的内置系统提示等），所以你们看到的数字通常**低于**直连同样内容的数字，不会被改高。计费按同一张价目表。

**它也是所有非 Claude Code 客户端的正常通道。** 你们不带 CC UA 的 900 多条请求一直走的就是这条路径，并且是 200。

**和直连的真实差异**，这些是执行方式带来的，不是故障：

| 项目 | 直连 | cc-worker |
|---|---|---|
| system 提示 | 原样透传 | Claude Code 自己的环境段在前，你们的 system 作为内容传入（这就是你们说的「CC 环境段被换掉」） |
| 多轮历史 | 原样 | 折叠进当前轮的输入 |
| 自定义 tools | 原生 | 提示层模拟，合成 `tool_use` 块；`tool_choice: tool/any` 以指令方式要求 |
| thinking | 原样 | 正文不下发，只回签名；`adaptive` 映射成 effort |
| temperature / top_p / top_k | 透传 | 忽略（Claude Code 没有这些开关） |
| prompt caching | 原生 | 无跨请求缓存控制，usage 如实报告 |
| 首轮延迟 | 低 | 高，需要拉起会话，秒级到十几秒 |
| 回包 id | `msg_01…` | `msg_` + 24 位随机 |

**结论：** 如果你们的业务需要请求体字节级透传（自定义 tools 原生执行、thinking 正文、采样参数、跨请求缓存），就按第 3、5 节把形态对齐，
走直连。如果只是普通问答和 agent 对话，cc-worker 的结果是可用的、可计费的正常 Claude 输出，不需要当成事故处理。
