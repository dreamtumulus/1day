# Canonical Claude Code 执行与多协议 API 改造技术方案

> 状态：**待可行性审计，未实施**。本文是实施任务书，不是现状说明，也不是发布记录。
>
> 目标读者：负责审计、拆分实施、测试和发布的 agent。
>
> 原始编写基线：本地仓库 `45457bf`，生产 `/opt/1dayapi` 为 `6571ab3`。2026-11-01 遥测修订时本地为 `cfd2260`、生产为 `949f6e9`；本次只修改设计文档。本地另有他人未提交修改，本文没有触碰。实施前必须重新读取 HEAD、worktree 和生产版本，不得把提交号或下列行号当作长期稳定的坐标。

## 0. 已拍板的目标与边界

### 0.1 目标

1. **上游执行身份统一**：订阅 OAuth 的 direct 与 worker 都由真实 Claude Code 形态承载。worker 运行节点上的官方 Claude Code 二进制，不再把“你是 API assistant、不是 Claude Code”写进上游提示词。
2. **下游按客户端分流**：
   - Claude Code 客户端：先做结构校验，再按同一版本 profile 归一化；是否允许 raw direct 由第 3 节的 `telemetryPolicy` 决定，不能无条件 direct 优先。
   - 非 Claude Code 客户端：经过 Messages / Chat Completions / Responses 适配层，由 canonical worker 提供可靠 API 体验。
3. **协议体验与上游身份解耦**：API 适配只发生在网关和 worker 边界，不改变 Claude Code 的原生身份、主提示词和授权方式。
4. **历史真实且可恢复**：正常路径使用 CC 原生会话历史和原生 resume；不再用 `[user]` / `[assistant]` 文本折叠冒充原生历史。
5. **不静默失真**：无法支持的语义必须明确拒绝或明确标记为估算/兼容模式，不得静默忽略后宣称成功。
6. **遥测真实可证**：worker 的 Messages 与遥测由同一个官方 CC、同一账号身份和同一固定出口产生。不得把“未关闭遥测”或假上游 200 当成生产遥测成功；raw direct 若不能提供同等证据，必须明确降档，不得混入 `native-required`。

### 0.2 非目标

- 不承诺 Claude 订阅 OAuth 与官方 Messages API 的每个高级参数完全等价。
- 不为了支持 Responses 而强制引入 OpenAI 上游；Responses 可以适配到内部 Messages 表示。
- 不把“真实 CC”理解成所有请求都必须有完全相同的 tools 集合。`cli`、`-p/sdk-cli`、`--restricted` 是不同官方运行 profile，分别留存证据，不能混拼字段。
- 不随机化 JA3，不把同一账号在 direct 的 `cli` 与 worker `-p` 的 `sdk-cli` 差异误判为“一号两软件”。
- 不在本改造中重做账号池组织/代理运营策略；但任何新遥测和后台行为不得扩大跨账号关联面。
- 不伪造、补发或跨会话重放遥测，不用其他账号/会话的事件掩盖某账号缺少原生遥测；不为采集遥测而在生产引入改变真实 CC TLS 出口的常驻 MITM。

### 0.3 不可妥协的不变量

- **I1 原生身份**：canonical worker 禁止出现 `--system-prompt` / `--system-prompt-file` 替换 CC 主提示词；禁止“不是 Claude Code”“没有内置工具”等与实际运行相矛盾的上游指令。
- **I2 无平台泄露**：上游提示词、Environment、遥测中不得出现 `1dayapi`、平台 scratch 真实路径或网关实现细节；客户原文中自然出现的字符串不属于此类泄露。
- **I3 无折叠历史**：canonical 模式不得调用 `messagesToPrompt()` 或 `workerSystemPrompt()` 构造正常会话；不得把整段历史变成一条带角色标签的 user 文本。
- **I4 工具边界**：普通 API 下游只能看到客户声明的 caller tools；Bash/Read/Edit/Glob/Grep/WebFetch 等 CC 内部工具及其事件不得泄露到下游。
- **I5 凭据与租户隔离**：任何客户提示词驱动的工具都不得读取 OAuth 凭据、节点秘密、其他账号/组织/会话文件，不得绕过 pinned proxy。
- **I6 会话线性一致**：同一 conversation generation 只能有一个可写的 native session revision；不得并发 resume 同一状态，不得重复执行客户工具。
- **I7 计费幂等**：resume、重试、工具续轮、max_tokens 截断均不得重复扣费；平台账保留实际全量消耗，客户账沿用既定基线规则。
- **I8 不静默跨组织**：已有组织隔离规则继续有效；native transcript 不跨节点、不跨组织搬运。
- **I9 可回滚但不混模**：灰度可以回滚，进行中的 conversation 不得从 native 历史突然切回折叠历史。
- **I10 无遥测伪证**：没有真实上游接受证据时只能标记 `unknown`，不能标记成功；告警只用于诊断，不得代替启用前硬门或宣称能降低封号风险。

## 1. 当前基线与已完成工作，避免重复实施

### 1.1 原始编写时已识别、当时生产尚未包含的提交

- `6c0f2fd`：direct 部分卫生修复、响应/错误头、`x-1day-mode`、参数忽略提示、custom entrypoint 全局开关等。
- `7b8aa10`：默认 `historyPolicy=passthrough`。
- `45457bf`：模型目录文档及 core/provider-node 机器常量一致性测试。

这些提交不等于覆盖本文目标，其当前部署状态必须在 R0 重新核对，不能沿用原始编写时的假设。R0 必须先审查、测试并单独发布仍需部署的小修复；canonical worker 不得与这批修复捆成一个不可回滚的大发布。

### 1.2 仍需改造的核心现状

- `apps/gateway/src/ccr/translate.ts` 仍有 `workerSystemPrompt()` 和折叠历史逻辑；生产 worker 用它替换 CC 主提示词。
- `apps/provider-node/src/cc-worker.ts` 仍使用 `--tools ""`、`--no-session-persistence`、真实 scratch cwd，并在进程落空时从折叠 `history` 新开进程。
- custom entrypoint 当前是全局设置，不是按 Key/客户授权；版本 pin 仍不是完整版本 profile。
- Responses 对 Anthropic 订阅上游仍无适配。
- `x-1day-ignored-params` 只是过渡可见性修复，不是严格参数契约。
- 现有每组织 UID + 0700 scratch 不是完整的内置工具安全边界：同组织进程同 UID，且 CC 与它的工具子进程共享凭据可见性。开启工具前必须重新验证，不得沿用“scratch 是 0700 所以安全”的结论。

### 1.3 已确认的 2.1.312 官方能力

本机 `claude 2.1.312 --help` 已确认存在：

- `--append-system-prompt`；帮助文本还提到 `--append-system-prompt-file`，但文件变体仍需单独实测。
- `--input-format stream-json`、`--replay-user-messages`、`--include-partial-messages`。
- `--session-id`、`--resume`、`--fork-session`、原生 session persistence。
- `--system-prompt-snapshot on|off`，默认会保存本会话 system prompt 供后续请求/resume 使用。
- `--restricted`、`--permission-prompts none`、`--permission-mode`、`--add-dir`。
- `--json-schema`，可作为结构化输出适配的官方能力。

这些帮助信息只证明参数存在，不证明所需语义全部成立。第 2 节的实证门是通过实施的前提。

### 1.4 遥测现状与证据边界（2026-11-01 只读核查）

- CC 2.1.312 内嵌源码把 `INGEST_URL` 固定为 `https://api.anthropic.com/api/event_logging/v2/batch`，发送使用当前 session 的第一方凭证；它不跟随 `ANTHROPIC_BASE_URL`。因此仅给网关增加遥测路由，接管不了 raw direct 客户端遥测。
- 生产 SQLite 最近 30 天没有上述遥测、bootstrap、eval、mcp-registry 端点或遥测错误记录；15 份当前/轮转 nginx access log 命中为 0；三台 worker 的节点 journal 未检出相关成功/失败记录。现有 `http_egress` 只覆盖平台转发请求，不覆盖 worker 子进程自己发出的遥测。
- 主服务器 14 份 `/root/cc-upgrade` 抓包只有 `/api/hello` 与 `/v1/messages`。历史受控抓包的输出摘要曾显示 `telemetry_batches 1` 和正确的机器 `env`，但使用假 OAuth 与假上游；原始 `requests.ndjson` 已不存在，不能据此证明 Anthropic 接受。
- 文档中的“8 个会话、约 120 events、约 230 KB”只能作为历史受控实验记录，不能作为当前生产时间序列。**当前没有逐账号的真实遥测请求量、状态码、成功率或失败率，生产在这一层是盲的。**

## 2. P0 实证门：先回答，再写生产路径

建立 `tests/e2e/` 内的受控 CC 2.1.312 探针，使用临时 HOME、临时 CLAUDE_CONFIG_DIR、假 OAuth 材料和本机假上游；不得为测试消耗真实客户账号。输出只保存结构、状态和无秘密样本。G10 的真实接受验收另按 WP6 使用专用测试账号，绝不借用客户账号或生产双写。

| Gate | 必须回答的问题 | 通过标准 | 不通过时 |
|---|---|---|---|
| G1 append | append 是否保留 canonical system blocks 与原生 tools？file 变体是否存在？ | 假上游抓到 CC 原生 billing/identity/main prompt，客户 system 只出现在追加位置 | 无 file 变体时改用首个 user 消息中的明确 caller-instructions 块；不得把长文本放 argv |
| G2 stream-json | stdin 接受哪些 role/content？user/assistant/tool_result 如何表达？ | 官方进程实际接受并正确生成下一轮，无角色错置 | 不假设能注入 assistant；历史导入走 G3 |
| G3 外部历史导入 | 能否为**新建**会话生成 2.1.312 可读取的原生 transcript，再由官方 `--resume` 打开？ | user/assistant/tool_use/tool_result/thinking/signature 全 matrix 通过；CC 自己读取后上下文正确 | canonical 首批只支持单轮和平台原生会话；外部多轮历史返回 `history_import_unsupported`，Key 暂留 legacy |
| G4 resume | 进程退出、节点重启后，相同 account/config/cwd/session 能否 resume？ | 上下文无丢失、无重复 turn，session/revision 可追踪 | 不启用 native 灰度 |
| G5 工具中断 | awaiting caller tool 时进程死亡，能否原生 resume 并补 tool_result？ | 不重复执行 caller tool，不错误续写 | 返回 409 `tool_continuation_lost`，禁止从折叠历史恢复 |
| G6 restricted | `--restricted` 实际上游 tools 集和文件权限是什么？ | 文件工具限 cwd，OAuth/config/其他会话读取全部失败，事件形态有采样 | 只保留无内置工具 profile，不宣称完整 restricted |
| G7 Bash/网络 | 若未来开放 Bash，官方沙箱能否隔离凭据并强制出口？ | 读凭据失败；`curl --noproxy '*'`、直接 IP、云 metadata、跨会话网络均失败 | **不开放 Bash**；mount namespace 或 env proxy 本身不算通过 |
| G8 schema | `--json-schema` 的请求形态、输出及失败语义 | JSON Schema 输出可解析、校验失败有明确错误、流式可适配 | `response_format`/`text.format` 返回 `unsupported_parameter` |
| G9 profile | direct/worker 的完整 CC 请求 profile | 分版本、分 entrypoint 保存 headers/body 结构/beta/tools/system 模板证据 | 不做跨版本 pin |
| G10 telemetry | worker 原生遥测是否结构正确并被真实上游接受？raw direct 是否具备同等证据？ | WP6 的结构、身份、出口、真实响应和泄露矩阵全部通过；无证据维度保持 `unknown` | 不开放对应 `native-required`；raw direct 只能显式降档，禁止伪造/重放或全局关闭遥测充数 |

**禁止的手写假设**：不得凭经验假设 stream-json 支持 assistant 注入、resume 能恢复悬挂 MCP Promise、0700 能防同 UID 工具读文件、设置 HTTP_PROXY 能防 Bash 直连。

## 3. 目标架构与路由契约

```text
Claude Code 客户端
  └─ 原始结构 gate + telemetryPolicy
       ├─ raw direct（仅 passthrough-isolated）：同版本 profile + 设备/机器/附件归一化
       └─ canonical worker（native-required）：真实 CC -p + 原生历史 + 原生遥测 + API 边界过滤

Messages / Chat / Responses 客户端
  └─ 参数与协议适配
       └─ canonical worker：真实 CC -p + caller MCP tools + 原生历史 + 原生遥测

各路径共享：真实订阅 OAuth、账号固定设备、固定机器档、固定节点/代理、组织隔离、双账本
```

路由决策顺序固定为：

1. 认证、模型/额度准入、参数校验。
2. 解析 conversation identity 和既有 generation；既有会话的模式/native/telemetryPolicy 绑定优先于新请求的全局设置。
3. 识别 CC 客户端并执行原始结构 gate。custom entrypoint 仅在该 Key 明确 allowlist 时参与。
4. 读取 Key 的 `telemetryPolicy`：`native-required` 不得选择 raw direct；`passthrough-isolated` 才允许进入 direct 可用性判断。
5. direct 不可用或策略要求节点原生执行时，选择支持所需 canonical profile 且 G10 证据有效的 worker 节点。
6. 非 CC 请求只进入 API adapter + canonical worker。legacy worker 只在迁移期按既有 Key 显式保留。
7. 节点心跳没有能力声明时不得假定支持新协议；不得让旧节点静默忽略新字段。`native-required` 无合格节点时返回 503 `native_telemetry_unverified`，不得降级冒充完成。

建议新增 per-key policy（复用 `api_keys.policy_json`，首批不需要新列）：

```json
{
  "historyPolicy": "passthrough",
  "workerMode": "legacy|canonical",
  "telemetryPolicy": "native-required|passthrough-isolated",
  "allowedCustomEntrypoints": ["mirasim"],
  "parameterPolicy": "strict|warn",
  "responseMode": "keepalive|strict",
  "probeIntercept": true,
  "autoProbeIntercept": false
}
```

约束：

- 新 Key 默认 `parameterPolicy=strict`、`responseMode=strict`、`autoProbeIntercept=false`、`telemetryPolicy=native-required`；存量 Key 暂时保留 `warn/keepalive`，分批迁移。
- 存量 raw direct 若要保留现状，必须显式标记 `passthrough-isolated`：它只承诺 Messages 归一化，不承诺账号侧原生遥测，不能计入硬目标完成量。不得在客户无感知的情况下把存量 direct 批量切到节点执行。
- `workerMode` 与 `telemetryPolicy` 只决定新 conversation；已有 conversation 的记忆中固定模式与策略。灰度按 Key/测试账号，不按单个请求随机。
- 节点 env `CC_WORKER_CANONICAL=1` 与 Key `workerMode=canonical` 同时满足才启用。节点心跳声明 `canonicalProfiles`、`historyImport`、`restrictedTools`、`telemetryEvidence` 等 capability。

## 4. 工作包 WP1：direct 完整 profile 与归一化

### 4.1 版本 profile，禁止混合版本

在 `packages/core/src/` 增加版本化 profile 模块（具体文件名随现有命名约定），集中描述：

- CC/SDK/runtime 版本；entrypoint；billing 算法；identity/main prompt 模板版本。
- 功能相关 beta 及 canonical 顺序。
- tools 结构、context_management、thinking 规则和已知模型最低版本。
- profile 的证据来源、采样日期和 digest。

实施规则：

1. `direct_cc_version_pin` 默认关闭。没有完整目标 profile 时，禁止只改 UA/Stainless/billing 来冒充另一版本。
2. 同版本只修正 transport/device/machine/custom entrypoint；版本相关 body 保持该版本原样。
3. 未知版本在 `requireKnownProfile=1` 时不得 direct；若运营选择 observe，可原样 direct 并记录 `cc_profile_unknown`，但不得 pin 成 2.1.312。
4. worker 始终使用节点真实二进制的版本；不得把 `-p/sdk-cli` 改成 `cli`。
5. 2.1.316 等版本只有完成 G9 才能加入已知表；不能因“硬检查更少”而更容易通过。

### 4.2 custom entrypoint 按 Key 授权

修改 `packages/core/src/cc-shape.ts`、`apps/gateway/src/proxy.ts`、`apps/gateway/src/upstream.ts`：

1. gate 先对**原始请求**做结构校验，允许集合来自当前 Key 的 `allowedCustomEntrypoints`，不是全局布尔开关。
2. 原始 UA 与 billing 的 custom entrypoint 必须一致；其它 CC 结构不变。
3. 通过后才统一改 UA、billing entrypoint 和对应 identity block；保留客户额外指令和真实 messages。
4. 归一化后再次运行完整 gate + profile 一致性断言，最终请求必须为 genuine。
5. 全局 `direct_cc_entrypoint_normalize=1` 仅作为短期迁移开关；完成 Key 配置后关闭并删除。

必须增加“分类 → Key 授权 → normalize → buildUpstreamRequest → 再 gate”的集成测试，覆盖 mirasim 流式真实调用；不能只测 normalize 单函数。

### 4.3 身份与附件归一化

保留并扩展到 typed normalizer：

- `metadata.user_id` 固定为 `device_id, account_uuid, session_id` 顺序，值取账号绑定身份。
- `# Environment` 的 cwd/platform/shell/OS/scratch 与 `accountMachine(accountId)` 一致。
- 只剥离可识别的客户端本地附件：`userEmail`、真实 `gitStatus`、自动发现的 CLAUDE.md、宿主路径附件；不得用宽正则误删客户显式消息。
- 客户显式 system/user 指令保持语义，不能把“归一化”变成内容审查。
- direct 与 worker 的 device/account/machine/profileVersion 一致；entrypoint 允许按官方运行模式不同。

## 5. 工作包 WP2：canonical worker 进程与工具边界

### 5.1 启动参数和提示词

修改 `apps/gateway/src/ccr/worker.ts`、`apps/provider-node/src/cc-worker.ts` 和协议类型：

- canonical open 使用 `profileId`，不再发送 legacy `systemPrompt`。
- 移除 `--system-prompt-file` 和 `--tools ""`；保留真实 `-p --output-format stream-json --verbose --include-partial-messages`。
- 首轮使用官方默认 system prompt，`--system-prompt-snapshot on`。客户 system 经 G1 验证的 append-file 追加；无安全 file 变体时作为首个 user 的 caller-instructions 内容，不放 argv。
- 客户 system hash、model、tools schema、thinking/effort/maxTokens、profileId 继续进入 reuseKey；变化时创建新 native session，不能在旧会话悄悄换 system。
- 保留防模型自动 fallback、固定代理和机器身份；不得设置 `DISABLE_TELEMETRY` 或 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` 来关闭原生遥测。遥测是否真实、被接受以及证据如何留存由 G10/WP6 决定，不能仅凭进程参数宣称生产成功。删除“不是 CC/没有工具/不得自称 CC”等提示。
- `CLAUDE_CODE_DISABLE_ATTACHMENTS` 是否继续启用以采样为准：必须避免账号 email、宿主机附件进入客户可见上下文，同时保留官方 Environment。不得为“看起来真实”盲目开启全部附件。

### 5.2 首批工具 profile：`restricted-default`

首批建议使用真实官方 `--restricted` + 默认内置工具集 + caller MCP，而不是直接开放 Bash：

- CC 内置 Read/Glob/Grep 等只能在当前隔离工作区运行；Bash/PowerShell 等代码执行工具在 G7 通过前不开放。
- caller tools 继续由回环 MCP 注册；MCP 只回环、每会话随机令牌、工具调用仍交给客户执行。
- `--permission-prompts none`，任何需要人工权限的操作自动拒绝；无交互式许可绕过。
- `--strict-mcp-config`，禁止加载节点/客户HOME中的其他 MCP 配置。
- 工作区为空、非 git、无 CLAUDE.md；不得把真实客户项目或节点文件挂入。

若审计发现 restricted 的上游 tools 集不符合目标 profile，可灰度 `tools-disabled-canonical` 作为临时官方 profile，但必须准确命名，不能宣称是默认工具 profile。

### 5.3 下游内部工具过滤

在 `SessionTranslator` 增加明确的事件分类，不靠名称字符串偶然透传：

1. `mcp__caller__<name>`：映射为客户声明的工具名，生成客户 tool_use，停泊等待客户 tool_result。
2. CC 内置工具：只消费 CC 自己产生的流事件，不向客户发出 start/delta/stop；索引重新映射，不能留下空块或错误 stop_reason。
3. 内置工具引起的上游继续调用属于同一客户请求，不能提前以 `stop_reason: tool_use` 结束下游。
4. 只有 caller tool 停泊或 CC 最终结果才能结束客户响应。
5. `internal_tool_event_leaked_total` 必须恒为 0；添加 Read/Bash/WebFetch 与 caller tool 混合、并行工具、文本与工具交错的测试。

### 5.4 合成 cwd 与真实隔离分离

在 `machine-runtime.ts` 的私有 mount namespace 内，将真实 scratch bind 到该账号的 `accountMachine.workingDir`，然后 chdir 到合成路径：

- 真实文件仍只存在每会话 scratch；不同会话绝不共享可写目录。
- 挂载点在 namespace 内创建，不能污染宿主机 `/home`、`/opt`、`/srv`，不能跟随客户可控 symlink。
- `# Environment`、进程 cwd、遥测一致显示合成 cwd；OAuth config 与秘密仍在工作区之外。
- 启动自检必须验证 cwd、读写、挂载传播、清理和其它会话不可见。自检失败则节点拒绝 canonical session，不静默回退到平台路径。

### 5.5 Bash 是独立安全发布，不随首批自动开放

仅凭 UID、0700、LD_PRELOAD、HTTP_PROXY 都不够。开放前至少要有：

- 官方工具沙箱或等价强制机制，证明工具子进程不能读 `CLAUDE_CONFIG_DIR/.credentials.json`。
- 网络命名空间/宿主机 egress 强制，拒绝直连、绕过代理、link-local、云 metadata 和未授权内网。
- CPU/内存/进程数/磁盘/执行时间限制，完整进程组清理。
- 针对提示词注入的凭据读取、跨会话读取和 exfiltration 测试。

G7 不通过就保持 restricted，这是安全边界，不是可以用灰度开关绕过的可选项。

## 6. 工作包 WP3：native 会话、恢复与外部历史

### 6.1 生命周期

fresh 会话：

1. 网关生成 conversation revision 和期望 native session UUID。
2. 节点以 `--session-id <uuid>` 启动，**移除 `--no-session-persistence`**。
3. 以 `system/init` 和最终 `result` 中的真实 session_id 为权威；与期望不符则拒绝并告警。
4. live process 优先继续使用 stream-json，保持现有低延迟优势。

进程回收/重启后：

1. 同 accountId + teamId + config generation + profileId + synthetic cwd + nativeSessionId 必须全部匹配。
2. 使用官方 `--resume <nativeSessionId>`；同一线性会话不使用 `--fork-session` 来掩盖并发冲突。
3. fork 只用于明确的客户分支，并生成新的 revision/nativeSessionId。
4. transcript 只留在原节点原账号配置区；节点丢失时返回可重试供给错误，不转移到别的组织。

### 6.2 状态机和元数据

建议状态：

```text
READY → RUNNING → COMMITTED
                  ├→ AWAITING_CALLER → RUNNING
                  └→ DIRTY / LOST
READY/RUNNING 的任何不可恢复异常 → DIRTY 或 LOST
```

- `COMMITTED`：本轮 result 完整、翻译完成、usage 基线已记录，可接受下一轮。
- `AWAITING_CALLER`：仅在 G5 证明可恢复时才允许进程回收；否则保留进程至工具超时。
- `DIRTY`：max_tokens 截断、abort、stdout 中断、result 缺失等；不得直接当下一会话的干净基线。
- `LOST`：transcript 不存在、revision 冲突、进程/节点不可恢复；明确报错，绝不折叠恢复。

首批可复用 `worker_turn_memory.data` 存版本化 JSON，不急着加表；至少记录：

```text
schemaVersion, mode, profileId, accountId, teamId, nodeId,
nativeSessionId, revision, expectedTurn, state,
clientHistoryHash, assistantResponseHash,
configGeneration, syntheticCwd, usageBaseline,
pendingCallerCalls, expiresAt
```

native transcript 本体不进 SQLite，不打日志。TTL 初始建议 24h、可配置，到期安全删除；删除后返回 `session_expired`，而不是折叠重放。最终 TTL 由隐私与产品要求确认。

### 6.3 崩溃与幂等

- revision 单调递增；open/resume/commit 都可重试且重复请求不得推进两轮。
- 网关蓝绿切换后从持久元数据恢复；节点必须拒绝旧 revision 的迟到写。
- 每轮开始前保留 CC 原生文件的干净 checkpoint；DIRTY 时只能恢复该原生 checkpoint 或明确失败，不能手写猜测状态。
- awaiting caller tool 丢失且 G5 未通过：409 `tool_continuation_lost`，不重放客户 tool_result、不重复执行工具。
- 计费沿用 request_id 唯一约束和 settlement journal；resume 的 usage 是累计值，按最后确认的 baseline 取增量，冲突时停止而不是重复收费。

### 6.4 外部多轮历史导入

`historyPolicy=passthrough` 意味着客户可能带来平台从未见过的历史，canonical 不能忽略这一入口：

- 首选 G2 官方输入能力；若不足，才使用 G3 验证过的版本化 transcript importer。
- importer 只创建新 native session，不修改生产已有 transcript；保留 role、原始内容块、tool id 配关系和有效 thinking signature。
- 不支持的 assistant prefill、跨组织 opaque handle、失效 signature 等明确返回 400/409，不转成伪 user 文本。
- G3 未通过前，这类 Key 保持 legacy；canonical 对未知外部多轮历史返回 `history_import_unsupported`。单轮和平台自己建立的 native 会话不受影响。

## 7. 工作包 WP4：下游 API 适配与严格参数契约

### 7.1 共用内部表示

以 Anthropic Messages 为内部 canonical request/response 表示，复用现有转换器但先补字段矩阵：

- Messages：文本、图片、document、thinking、tools/tool_result、stream/non-stream、usage、stop_reason。
- Chat：system/developer、messages、function tools、tool messages、stream usage、finish_reason。
- Responses：`instructions`、`input` 字符串/列表、function call/output、流式 response events、usage。

转换器必须做“输入校验 → 映射 → 不支持字段决策”，不能只丢字段。所有适配共享 conversation identity、工具和错误语义。

### 7.2 参数策略

- `strict`：会改变结果且无法保证的参数返回 400 `unsupported_parameter`，错误体包含参数名、路径和原因。
- `warn`：存量迁移期保留 `x-1day-ignored-params`，不得称为严格兼容。
- 显式默认值且无实际语义的参数可以接受，例如 `n=1`；`n>1`、`logprobs=true`、非零 penalties、seed 等按 strict 拒绝。
- `temperature/top_p/top_k` 没有可靠 CC 映射时 strict 拒绝，不静默忽略。
- 强制 `tool_choice=any/tool` 若仍只是提示词约束，strict 拒绝；`auto/none` 按实测支持。
- `response_format` / Responses `text.format`：优先用 G8 通过的 `--json-schema`，否则 strict 拒绝；不得用“请输出 JSON”的提示冒充保证。
- `max_tokens`、stop sequences、thinking/effort 保留现有实现，并补 native DIRTY 状态和流式截断测试。

### 7.3 Responses 分两档交付

第一档即可发布的能力：

- 自包含 `input`/`instructions`，文本、图片/文件按已验证 Messages 映射处理。
- function tools 和 function_call_output。
- stream/non-stream、标准 response id、output text、usage、错误映射。
- JSON Schema（G8 通过后）。

以下能力未实现前明确 400：`previous_response_id`、后台任务、内置 OpenAI 工具、container/files handle、store 的服务端语义、其他高级字段。若后续支持 `previous_response_id`，必须新增同 API Key 范围内的 response→conversation/native revision 持久映射，不能凭 response id 猜会话。

### 7.4 token、usage 与 ID

- `count_tokens` 可沿用 media-aware 估算，但响应/文档必须标为估算；不能称官方精确 tokenizer。图片不得按 base64 字符数估算。
- message_start 的 input usage、message_delta 的最终 usage 在流式中保持完整；Chat/Responses 同步映射。
- native CC 内部工具循环产生的实际消耗进入平台全量账；客户账按已批准基线规则计算，不能因过滤内部工具事件而漏计。
- 所有协议生成合法且稳定的 ID；重试不重复结算，response id 与日志 request_id 可关联。

## 8. 工作包 WP5：响应头、错误、保活和 raw relay

### 8.1 响应头与 Retry-After

allowlist 转发 `request-id`、`anthropic-ratelimit-*`、`retry-after` 等已验证头，加入 CORS expose；不转发 hop-by-hop、Set-Cookie 或内部身份信息。平台 429/503 统一 Retry-After，错误体保持各客户端方言。

CC 客户端使用独立的下游响应 profile：吸收 CPA 的做法，清除会被 CC 客户端用于识别网关的响应头；`x-1day-mode`、`x-1day-ignored-params` 和其他平台诊断头默认只给普通 API 客户端，CC 默认不下发。已知第三方网关前缀清单只能作为种子，必须通过 CC 源码和抓包验证，不能当作完整名单。响应头清理只降低网关暴露，不等于解决遥测 device/session 身份。

**提前 200 的限制必须写进契约**：一旦 keepalive 已发 200/SSE ping，就无法再补上游响应头，也无法恢复真实 HTTP 错误状态。

- `responseMode=strict`：禁用提前 200 和非流式空白填充，等待上游真实 header；接受并文档化 Cloudflare 长请求超时风险。
- `responseMode=keepalive`：保留现有可用性折衷，明确可能得到 200 + 错误事件，且只能保证平台响应头。
- 不得宣称在 keepalive 已触发后还能完整转发上游 header。

### 8.2 reset/probe/refusal

- 默认 passthrough 已确定，不再改回全局 reset。reset/reject 仅作为显式 Key 策略。
- 不再用合成 assistant 文本通知 reset；使用真实错误码/响应头。现存 409 兼容分支单列迁移，不扩大。
- probeIntercept 只响应显式 `x-1day-probe: 1`；重复小请求的自动接管通过 `autoProbeIntercept` 独立控制，默认关闭。
- direct 原生 refusal 原样透传；worker CLI 文本形式的 safeguards refusal 暂不伪造 200 或 `stop_reason=refusal`，保留明确结构化错误并记录为非标准兼容项。

### 8.3 raw passthrough

在 tunnel request spec 增加 `preserveHeaders:true`（或等价版本化标记）：

- provider-node 对该请求跳过 `anthropicFingerprintHeaders`，只替换网关明确指定的凭证/transport。
- 节点心跳声明 raw-v1 capability；旧节点没有能力声明时，网关不得发送并假定“原样”。
- 测试覆盖 api.anthropic.com 与第三方 relay，验证 UA、x-stainless、accept-encoding、beta 和 body 均按契约。

## 9. 工作包 WP6：遥测真实性、边界与验收

### 9.1 先承认两条路径的拓扑不同

- **raw direct**：Messages 可以经网关归一化，但客户本地 CC 的遥测由客户进程产生。2.1.312 的 event ingest 地址硬编码且不跟随 `ANTHROPIC_BASE_URL`，网关无法通过增加几个路由就接管，也无法把 Messages 的 `metadata.user_id` 归一化等同于遥测归一化。
- **canonical worker**：节点官方 CC 同时产生 Messages 与遥测，才能让二者共享账号身份、native session、机器档和固定出口。
- sub2api 的“吞掉并返回 200”至多是客户端兼容/隐私隔离，不是账号侧真实遥测；CPA 的响应头清理只降低网关识别信息。两者都不能作为 G10 的通过证据。

### 9.2 worker 原生遥测契约

- 官方 CC 自己生成并发送遥测，网关不构造、不补发、不改写事件体。保留 bootstrap/eval/mcp-registry/event_logging；只沿用现有的 Sentry 与 autoupdater 关闭策略。
- 每个账号使用固定 `.claude.json`、device/account、OAuth、机器档和代理。nativeSessionId 以 CC 实际 init/transcript 为权威；同一 native session 内 Messages 与遥测的 session 一致，跨 direct/worker 不要求复用同一个 session UUID。
- `# Environment`、进程 cwd 与遥测 cwd 经 WP2 的 mount namespace 对齐；不得出现真实 scratch、节点 hostname、代理凭据、其他账号/客户标识。
- `cli`、`sdk-cli`、restricted 等 profile 可以产生不同的官方事件集，分别与对应版本基线比较，不要求逐字段相同。
- 保留 CC 原生异步遥测语义，不能把遥测失败简单转成客户 Messages 的错误；但 `native-required` 的账号/profile 没有启用前有效证据时不得接新会话。运行时证据缺失只能标 `unknown`，不能标绿。

### 9.3 direct 两档策略，禁止混称

1. `native-required`：硬目标默认。raw direct 不合格；由节点官方 CC 承载 Messages 与遥测。无合格节点或 G10 证据失效时返回 503 `native_telemetry_unverified`，不静默降级。
2. `passthrough-isolated`：仅为存量迁移或明确接受边界的 Key 保留 raw direct。只承诺 Messages profile 归一化，明确没有账号侧原生遥测保证，不计入硬目标完成量。
   - 不伪造 worker 遥测补齐，不把其他会话的事件重放到该账号。
   - 客户遥测的实际目的地址、凭证和失败行为必须经实测并写入接入文档。
   - 如某客户主动选择关闭客户端遥测，必须单独验证不会影响 Messages，并获得客户确认；不得全局偷偷设置 `DISABLE_TELEMETRY`，也不得把该档改名为 native。

### 9.4 G10 分两阶段验收

**A. 受控结构验收（假 OAuth、本机假上游）**

- 覆盖首轮、多轮、resume、restricted、caller tool、进程退出和异常恢复。
- 记录版本化 endpoint/event 结构、device/account/machine/cwd/native session/model/entrypoint 与出口绑定；resume 不得重复上报整批历史。
- 验证无平台路径、节点秘密、代理凭据和跨账号/跨客户泄露。只保存无秘密结构样本和 digest，不默认保存完整事件正文。
- 假上游 200 只能证明 CC 发出了预期结构，永远不计入“真实接受”。

**B. 真实接受验收（专用测试账号/组织）**

- 使用专用测试账号，不借用客户账号，不对生产请求双写。由官方 CC 经该账号固定代理发正常受控会话，记录真实上游 endpoint、HTTP 状态和证据时间。
- 测量必须保持官方 CC 到 Anthropic 的真实 TLS 和固定代理，不得用 MITM 替换出口后仍声称验证的是同一链路。优先使用官方 CC 可提供的原生结果证据；拿不到真实状态时该项为 `unknown`，G10 不通过。
- 账号/profile/固定出口绑定首次启用 `native-required` 前必须有覆盖证据；CC 版本、profile、账号或出口绑定变化后重新验收。未覆盖账号不得启用该策略。
- 真实 2xx 只证明该次 HTTP 接受，不证明账号以后不会受限，也不证明所有后续批次成功。禁止把一次验收包装成“不会封号”。

### 9.5 证据保存与告警边界

新增版本化 `telemetryEvidence` 记录，至少包含：`accountId/profileId/nodeId/proxyId/nativeSessionId`、CC 版本、endpoint、真实状态、证据来源、观测时间、结构 digest 和有效期；不记录 OAuth、API Key、完整事件正文或 URL query。

- 证据只覆盖其明确测量的账号/profile/出口，不能外推到整个节点或账号池。
- 生产拿不到真实状态的维度必须保留 `unknown`；没有数据不等于成功，也不等于失败。
- 硬门位于账号/profile 启用和版本/出口变更之前；告警只用于事后诊断，不能替代硬门或宣称降低封号风险。
- 不为持续观测引入常驻 MITM 或第二上游客户端；若官方原生证据不足，审计必须把这列为阻塞，而不是补一套伪造采集器。

## 10. 协议与兼容性清单

建议新增/扩展：

1. `CcWorkerOpen`：`profileId`、`appendSystemPrompt`（或 callerInstructions）、`nativeSession {id, action, revision}`、`checkpointId`、`builtInToolProfile`。legacy 字段仅旧模式使用。
2. 节点→平台 typed `cc_worker.state`：nativeSessionId、revision、state、checkpointId、reasonCode；不要继续用特殊 stdout 字符串扩展核心控制面。
3. `cc_worker.close/commit`：携带 revision 和幂等语义；迟到帧不得覆盖新状态。
4. heartbeat：`ccWorker.canonicalProfiles`、capabilities、native session 计数、resume/restore 失败计数、磁盘使用、`telemetryEvidence` 覆盖与有效期；心跳只报告证据元数据，不上传事件正文。
5. HTTP egress spec：`preserveHeaders:true` + capability 协商。
6. `docs/provider-protocol.md` 登记所有字段、旧节点行为、重试/乱序规则和错误码。

兼容原则：新增可选字段不等于兼容；只有旧端“忽略它仍然正确”时才可直接发。涉及安全或语义的字段必须 capability gate。

## 11. 测试与验收矩阵

### 11.1 静态/单元/集成

- profile：每版本/entrypoint 的 headers/body/beta/tools/system 一致；禁止混合版本。
- custom entrypoint：未授权 Key 不走 direct；授权 mirasim 经完整链路后 genuine。
- telemetryPolicy：`native-required` 永远不到 raw direct；证据缺失返回 `native_telemetry_unverified`；`passthrough-isolated` 不被计入 native 完成量。
- canonical prompt：默认 CC system 保留，客户 system 仅追加；无 API-assistant 注释和平台路径。
- translator：内置工具零泄露，caller tools 名称/id/input/并行/结果正确，块索引连续。
- native state：revision 冲突、重复 open/commit、迟到 close、DIRTY、LOST、TTL。
- 参数：strict/warn 两模式，错误包含准确参数路径。
- Responses/Chat/Messages 的流式和非流式 golden tests。
- core/node 机器常量一致性继续保留。

### 11.2 真实 CC 受控测试

- G1–G10 全部留下版本化结果；测试失败不得改断言来迁就实现。
- 进程 kill、节点重启、网关蓝绿切换后 resume；至少三轮普通对话和一轮 caller tool 对话。
- 客户修改历史、重复请求、并发同一 conversation、跨账号/跨节点错误路由均不能串味。
- restricted 工具尝试读取 OAuth、其他会话、`/etc/hostname`，并尝试网络绕过，全部符合策略。
- 大图片、PDF、长 system、长工具结果、max_tokens、stop sequence、thinking signature、JSON Schema。
- 真实 mirasim CC 请求在其明确选择的策略下成功；普通 API 请求经 canonical worker 成功。
- G10 真实接受验收与 Messages 业务验收分开记录，不能用 Messages 200 代替遥测接受证据。

### 11.3 项目标准验证

实施完成后必须在最终 deliverable 上运行：

```bash
pnpm build
PATH=/home/ubuntu/claude-code-re/bun-runtimes/1.4.4/package/bin:$PATH pnpm -r test
PROBE_INTERCEPT=0 PATH=/home/ubuntu/claude-code-re/bun-runtimes/1.4.4/package/bin:$PATH pnpm test:e2e
```

随后执行真实平台 Key 的 Messages/Chat/Responses（已支持范围内）、流式/非流式、工具轮、native resume 和 `cc_dual_mode`。发布走现有备份、蓝绿和 `ops/bin/release-verify`，不得只验证 import/compile。

### 11.4 上线硬指标

- canonical 请求中 legacy system prompt、折叠构造、平台路径命中数为 0。
- 内部工具泄露、跨会话数据读取、未授权 direct 归一化为 0。
- native resume 不重复 turn、不重复工具、不重复扣费。
- `native-required` 新会话的账号/profile/出口有效证据覆盖率为 100%；未覆盖即阻断。raw direct 错标 native、伪造/重放遥测、把假上游 200 计为真实接受的次数均为 0。
- strict 模式不支持参数 100% 明确拒绝；无静默字段丢失。
- 测试期间无 OOM、无失控进程、无凭据/客户内容进入日志。
- 记录改造前 p50/p95、错误率、cache/usage 和节点 RSS/磁盘基线；灰度期间不得出现无法解释的错误率或资源持续增长。

## 12. 灰度、发布与回滚

### R0：基线小修复

1. 重新确认本地未提交修改的归属并完成审查，不把他人 worktree 变更顺手带入。
2. 单独测试/发布已有 direct/API 小修复；生产升级前重新读取当时 HEAD 并核对 schema 和配置差异，不沿用本文历史提交号作发布依据。
3. 更新生产文档和错误说明，记录哪些问题已关闭、哪些由本方案继续处理。

### R1：证据与只读能力

- 合入 G1–G10 探针、profile/telemetry 证据、节点 capability 心跳；生产默认不改变路由。
- 不做生产双写 shadow： duplicate 上游请求会增加费用并改变上游行为。对比只用受控测试流量；真实接受验收只用专用测试账号。

### R2：canonical 单轮 + live 多轮

- 一个测试 Key、一个测试账号/组织、一个已升级节点；G10 未通过不得开放 `native-required`。
- 先单轮、live process 多轮、restricted 工具和 caller MCP；尚未通过 G3 的外部历史不进入 canonical。
- 观察至少一个完整测试周期，再扩大少量内部 Key。

### R3：native resume + 外部历史

- G3/G4/G5 通过后开放进程回收 resume、节点重启恢复和外部历史导入。
- 未通过的能力保持明确错误，不得以折叠 fallback 充数。

### R4：API 扩展与全量迁移

- Responses 第一档、strict 参数、strict response mode、raw-v1 分批开放。
- 存量 raw direct Key 必须显式选择 `passthrough-isolated` 或迁移到 `native-required`；不得默认改策略，也不得把例外算作完成。
- 存量 Key 按 conversation 自然结束后迁移；最后关闭 legacy 新会话入口，legacy 代码保留一个观察周期后删除。

### 回滚

- 新 conversation 停止分配 canonical，节点保留新二进制以读取已有 native 会话。
- 已有 canonical conversation 继续 drain/resume；不得直接切回 legacy 折叠。必须终止时返回明确 `session_migration_required`，由客户开启新会话。
- `native-required` 证据失效时停止对应新会话并返回明确错误；不得为可用性自动改走 raw direct。只有事前已是 `passthrough-isolated` 的 Key 才走其原有例外路径。
- direct/profile、raw、Responses、strict mode 均可独立开关回滚；数据库迁移只新增，不做破坏性降级。
- 回滚后核对在途请求、pending caller tools、未结算 usage 和节点进程/磁盘。

## 13. 可观测性与文档

新增计数/日志字段（不记录正文、token、完整 URL query）：

- `canonical_worker_open_total{profile,result,reason}`
- `native_resume_total{result,reason}`、`native_history_import_total{result,reason}`
- `native_session_state{state}`、resume 延迟、transcript 字节、checkpoint 失败数
- `internal_tool_event_leaked_total`、`caller_tool_park_total{result}`
- `cc_profile_mismatch_total{type}`、`custom_entrypoint_denied_total`
- `cc_telemetry_evidence_total{profile,result,source}`、`cc_telemetry_evidence_unknown_total`、`native_telemetry_unverified_total`
- `unsupported_parameter_total{format,param}`、`early_response_total{mode}`
- `raw_passthrough_header_mutation_total`（目标 0）

这些指标只描述证据覆盖和系统行为，不把 unknown 当成功，也不把告警当预防。实施时同步更新 `architecture.md`、`gateway.md`、`claude-code-compat.md`、`ccr-supply.md`、`worker-sessions.md`、`provider-protocol.md`、`team-isolation.md`、`client-notes-2026-10-19.md`、`errors.md`。旧文档中“worker 替换 system、无内置工具、折叠恢复、Responses 必然不可用、保留遥测即证明生产正常”等描述必须改为实际状态；发布记录与设计方案分开写。

## 14. 实施顺序与完成定义

建议任务顺序（每一步都可独立审查）：

1. R0 + G1/G2/G8/G9 + G10 拓扑与受控结构基线。
2. WP1 direct profile + 按 Key entrypoint + 集成测试。
3. WP2 canonical system/cwd/restricted + 内部工具过滤；WP6 完成真实接受验收后才开放 native-required。
4. G3/G4/G5 → WP3 native resume/importer/state machine。
5. WP4 参数与 Responses → WP5 transport/raw。
6. 全量测试、受控真实 CC 验收、灰度、发布、文档收尾。

**只有以下全部成立才可宣称本方案完成**：

- direct 与 worker 都是各自真实官方 CC profile，未混合版本或替换 CC 主身份；raw direct 只以明确的 `passthrough-isolated` 例外存在。
- `native-required` 的账号/profile/出口都有 G10 真实接受证据；未覆盖项保持 unknown 且未接流量，没有伪造、重放或假上游证据冒名。
- 普通 API 的常用 Messages/Chat/Responses 契约可用，未支持能力明确失败。
- canonical 正常路径无折叠历史，原生会话能按能力边界恢复；失败明确而非静默降级。
- caller tools 完整可用，CC 内部工具不泄露且安全测试通过。
- 同账号设备/机器一致、组织隔离、pinned egress、计费幂等均无回归。
- 最终 build/test/e2e、真实请求、蓝绿发布验证通过，文档与线上一致。

## 15. 审计 agent 必须给出结论的问题

1. `--append-system-prompt[-file]` 在 `-p + stream-json + resume` 下是否始终保留同一 canonical system snapshot？
2. G3 的外部 transcript importer 是否值得维护，还是应只接受官方输入/平台原生历史？若 importer 不可靠，给出不破坏 API 的替代契约。
3. `--restricted` 是否满足“真实 CC + 内置工具 + 安全”的组合？其工具列表是否与 direct profile 的差异被准确描述？
4. native session 与现有 `worker_turn_memory`、组织 generation、会话租约能否统一 revision，是否存在蓝绿/重试竞态？
5. max_tokens/客户断开后的 DIRTY 处理是否能避免自动续写、重复 usage 和坏 transcript resume？
6. Responses 的自包含 input 与 function tool 映射是否足够第一档使用，哪些字段必须 strict 拒绝？
7. 提前 200 与上游响应头/真实错误状态的冲突是否被完整隔离到 keepalive 模式？
8. 所有新增节点字段是否有 capability gate，旧节点/旧 console 是否会产生静默错误行为？
9. 内置工具是否可能通过模型输出、MCP 名称、事件索引、日志或遥测泄露平台路径/账号信息？
10. 每个阶段是否可独立回滚，且不会把 native conversation 强制折叠？
11. CC 遥测硬编码地址和第一方凭证是否使 raw direct 的账号侧归一化不可实现？若是，是否同意 raw direct 只能作为明确例外？
12. 不改变官方 CC 的真实 TLS/固定代理时，能否取得逐账号的真实遥测接受状态？若不能，G10 必须保持阻塞，不能降级为假上游证据或事后告警。
13. `telemetryEvidence` 的覆盖、有效期和版本/出口变更失效规则是否足够防止跨账号外推？运行时哪些维度仍只能是 unknown？

审计输出建议按“阻塞实施 / 需修改设计 / 可接受风险 / 已验证事实”分类，并引用实际测试或源码证据；不要仅以参数存在或单元测试通过判定可行。
