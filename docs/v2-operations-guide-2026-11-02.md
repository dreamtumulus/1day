# V2 使用说明（运维手册）

2026-11-02。面向：在主服务器 `root@89.117.17.224`、`/opt/1dayapi` 上操作的人。
配套：`docs/iron-rules.md`（铁律）、`docs/operations.md`（通用运维）、`docs/canonical-implementation-spec-2026-11-01.md`（V2 规格）、`docs/canary-real-traffic-plan-2026-11-02.md`（灰度）。

---

## 0. 一句话心智模型

V2 分两半：
- **运维/防御半边**（发布纪律、组织熔断、429 单次拒绝、可观测）——**已生效、无需"启用"**，它就是机制本身。
- **上游可见行为半边**（直连形态、响应形态、Key 策略自动层、canonical worker…）——**全部在三态开关后面，默认=老行为(V1)**。"启用 V2"= 把这些开关按铁律 2 的节奏逐个从 `canary` 切到 `1`。

**你只需要管两类东西**：①全局三态开关（settings 表）②每把 Key 的策略（api_keys.policy_json 的 override 层）。其余都是自动的。

---

## 1. 三态开关（全局，settings 表）

每个开关三个值：`0`=关(老行为) / `canary`=只对灰度组 / `1`=全量。改默认永远走 `0→canary→观察≥24h→1`，一天最多一轮，切前留 dist 快照（铁律 2）。

### 怎么看 / 怎么改
```bash
cd /opt/1dayapi
# 看所有 V2 开关当前值：
ops/bin/canary-verify            # 顶部就是三态开关 dump
# 改一个开关（示例设为 canary）：用控制台「设置」页，或直接改 settings：
node --no-warnings -e 'import("node:sqlite").then(({DatabaseSync})=>{const db=new DatabaseSync("data/1dayapi.db");db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run("直接改开关名","canary")})'
# 网关每请求读 settings，改完即时生效，无需重启。
```

### 开关清单（现值见 2026-11-02 07:34Z）

| 开关 | 作用 | 现值 | 切 1 的前提 / 风险 |
|---|---|---|---|
| `canary_group_id` | 指向灰度组（`canary-1cf43ccb`），所有 `canary` 开关只对这个组生效 | `canary-1cf43ccb` | 不是三态，是配置 |
| `direct_profile_strict` | 直连不跨版本 pin、未知 profile 不当 genuine、出站再校验同 profile（V2 主打） | **canary** | 需真实直连样本够 + 各版本 profile 已采样；切 1 前 `cc_profile_mismatch_total` 必须长期 0 |
| `direct_cc_entrypoint_normalize` | 放行客户自定义 UA 入口、改写成 `(external, cli)` 走直连 | **canary** | 上游可见；撞过 billing_header 失配（守护自动回滚过） |
| `cc_client_response_profile` | 对 Claude Code UA 不下发 `x-1day-*` 诊断头（只影响下游） | 0 | 低风险，没开过灰度 |
| `key_policy_auto` | 判断器 **auto 层**生效（否则只记录不生效） | 0 | 先看一周 `key_policy_events` 与人工是否一致 |
| `worker_canonical` | 车道 B 用节点官方 CC 原生身份跑（WP2） | 0 | 需先推节点包 + 节点 `CC_WORKER_CANONICAL=1` |
| `canonical_history_import` | canonical 新会话导入外部历史 | 0 | 排在最后 |
| `raw_preserve_headers` | 原样透传请求头、不补指纹（raw-v1） | 0 | 节点需 raw-v1 能力 |
| `telemetry_evidence_required` | native-required 的 Key 开 canonical 会话前要求遥测证据≥secondary | 0 | 需 7 个健康天 |
| `cc_shape_policy` | 伪 CC 形态判定后的处置：`observe`/`downgrade` | **downgrade** | 已是 downgrade（suspect→worker）；非三态 |
| `direct_strip_user_email` | 直连删客户 `# userEmail` reminder | 0 | 上游可见，谨慎 |
| `direct_cc_canonical_fields` | oauth beta 位置、metadata.user_id 键序重排 | 0 | 上游可见 |
| `direct_cc_version_pin` | 把直连请求 pin 到某个 CC 版本 | unset | strict 下自动忽略 |
| `history_policy_default` | Key 没配 historyPolicy 时的默认：`reset`/`reject`/`passthrough` | unset→**reset** | ⚠ 见 §3，reset 会截断多轮历史 |
| `history_policy_canary` | 灰度组 Key 的 historyPolicy 默认 | unset | 空则用 default |
| `worker_prompt_hide_platform_path` | worker 提示词隐藏平台路径 | 0 | 上游可见 |
| `ccr_worker_persistent` | worker 持久会话池（跨请求复用进程） | **1** | 非三态，已开 |
| `ccr_worker_native_tools` | worker 用原生 MCP 工具 | **1** | 非三态，已开 |
| `anthropic_window_threshold_percent` | 窗口用量到此 % 就提前停调 | **98** | 非三态 |
| `window_rest_min_sec`/`max_sec` | 窗口重置后额外"休息"时长 | unset→1h45m–2h05m | 已验证 Ultra(无5h窗口)账号自动不加休息 |

---

## 2. 每把 Key 的策略（api_keys.policy_json，override 层）

一把 Key 的实际策略 = **override（人工，恒生效）** ?? **auto（判断器，受 `key_policy_auto` 门控）** ?? **系统默认**。你平时只动 override 层。

字段：
- `historyPolicy`：`reset`（默认，不被认作"我们服务过的"多轮会被截成最后一问）/ `passthrough`（原样整条转发，绑定到服务它的组）/ `reject`（409，让多上游客户端自己换线）。
- `responseMode`：`keepalive`（默认，早发 200+心跳，出错只能塞进 200 的流里）/ `strict`（不早发 200，出错回真实 4xx/5xx）。
- `parameterPolicy`：`warn`（默认，不支持的参数只告警）/ `strict`（不支持就 400）。
- `workerMode`：`legacy`（默认）/ `canonical`（需 `worker_canonical` 开）。
- `directOnly`：true=这把 Key 只能走直连、非 genuine 直接拒。
- `allowedCustomEntrypoints`：允许的自定义 UA 入口白名单（如 `["mirasim"]`），独立于全局开关。

### 怎么改一把 Key 的 override
控制台用户/Key 页，或脚本（保留 auto 层）：
```bash
cd /opt/1dayapi && node --no-warnings -e '
import("./packages/core/dist/index.js").then(async core=>{
  const { DatabaseSync } = await import("node:sqlite");
  const db=new DatabaseSync("data/1dayapi.db");
  const KEY="<api_key_id>";
  const cur=db.prepare("SELECT policy_json FROM api_keys WHERE id=?").get(KEY)?.policy_json??null;
  const override=core.sanitizeKeyPolicyLayer({ historyPolicy:"passthrough", responseMode:"strict", directOnly:false });
  override.at=new Date().toISOString();
  db.prepare("UPDATE api_keys SET policy_json=? WHERE id=?").run(core.withKeyPolicyOverride(cur,override), KEY);
  console.log("effective:", JSON.stringify(core.parseKeyPolicy(db.prepare("SELECT policy_json FROM api_keys WHERE id=?").get(KEY).policy_json, "<group_id>")));
})'
```

### 当前灰度组 Key（2026-11-02 07:34Z）
- `Key-01`(mirasim.ai)：`historyPolicy=passthrough, responseMode=strict` ← 已为其丢历史投诉开通。
- `monitor`(测活)：`historyPolicy=reset`。
- `sub`(RuoMoe)、`canary-test`：override 空 → 吃默认 `reset`。⚠ RuoMoe 也发多轮，可能同样被 reset 截断，要不要也给 passthrough 待定。

---

## 3. ⚠ 最容易踩的坑：historyPolicy=reset 会丢历史

`history_policy_default` 默认 `reset`。含义：当一个会话**没绑定 team / 亲和绑定过期（空闲数小时）/ 从别的线路切来**时，平台认为"这段历史不是我们服务的"，于是**只把最后一问转给模型、把 `reset_active` 粘到会话行上**——客户发了完整对话，模型却说"这是新对话"。这就是 mirasim 2026-11-02 投诉的根因。
- 修法：给这类"每次发完整历史"的经销商 Key 设 `historyPolicy=passthrough`，并清掉其已 `reset_active=1` 的老会话：
```bash
node --no-warnings -e 'import("node:sqlite").then(({DatabaseSync})=>{const db=new DatabaseSync("/opt/1dayapi/data/1dayapi.db");const n=db.prepare("UPDATE conversations SET reset_active=0,reset_anchor=NULL,reset_prefix=NULL WHERE api_key_id=? AND reset_active=1").run("<key_id>");console.log("cleared",n.changes)})'
```

---

## 4. 运维脚本（`/opt/1dayapi/ops/bin/`）

| 脚本 | 干什么 |
|---|---|
| `canary-verify` | 一键核对：三态开关 dump + 灰度 Key 三协议各发一条 + 必须为零的计数器 + 24h journald 告警行。每轮切开关、每次观察结束各跑一次，输出贴进发布记录。|
| `canary-cc-probe` | 用灰度 Key 发一条真 2.1.312 cli 形态请求，验直连。|
| `canary-report` | 按灰度账号读 usage_logs 出 13 节报表（状态/错误/mode/端点/模型/形态/分小时/延迟分位/团队/必须为零计数器 + VERDICT）。`HOURS=24` 或 `SINCE=/UNTIL=` 看某阶段。第 2a 节含"按 Key 视角"（能看见选号失败的 503）。|
| `canary-move-keys` | `move/revert/cycle-in/status`：把真实用户 Key 迁进/退出灰度组，记录可回滚。|
| `canary-watchdog` | 后台每 5 分钟写 `/var/log/1dayapi-canary-traffic.log`：账号状态、direct/worker、retries、错误。账号掉出 active 自动把用户 Key 退回原组（不碰账号，铁律1）。|
| `canary-phase-switch` | 定时把某开关切到某值 + 之后 N 小时守护，命中 `upstream_request_rejected`/`cc_profile_mismatch`/5xx 占比/账号离线即自动回滚。用于灰度阶段推进。|
| `gateway-switch` | 蓝绿发布：`gateway-switch` 切到新构建，`--status` 看当前实例(8400/8402)。|
| `release-verify` | 发布后业务核对（真实请求 + 探针 + 池 online 数 + 节点在线）。不过不算发布完成。|

常看的日志：`/var/log/1dayapi-canary-traffic.log`（看门狗/阶段切换/窗口观测）、`journalctl -u 1dayapi-gateway@<live端口>`（`[cc-shape]`/`[cc-profile]`/`[ccr-worker]`/`[billing-suffix]`）。

---

## 5. 发布流程（铁律 2，一天一轮）

```bash
cd /opt/1dayapi
git pull                                   # 或本机 push 到此
TS=$(date -u +%Y%m%dT%H%M%SZ); tar czf backups/pre-<名字>-$TS-dist.tgz apps/*/dist packages/*/dist   # 快照
pnpm install --frozen-lockfile && pnpm build
systemctl restart 1dayapi-console          # 若有迁移
ops/bin/gateway-switch                     # 蓝绿切网关
ops/bin/release-verify                     # 核对
# 回滚：tar xzf 对应快照 → systemctl restart 1dayapi-console && ops/bin/gateway-switch
```
节点包（worker_canonical 等需要）：控制台「节点」或把 `data/bundle-cache/node-bundle-*.js` scp 到节点 `/root/.1dayapi-node/node-bundle.js` 后 `systemctl restart 1dayapi-node`，看 `self-test PASSED`。

---

## 6. 账号属性 / 窗口（2026-11-02 新增，自动）

控制台账号详情页现在显示：套餐档位（Ultra/Max/Pro/Team，来自 `/api/oauth/profile` 的 `plan_display_name`）、`rate_limit_tier`、组织/计费/席位/状态、原始 profile 与 usage 返回体，以及**窗口模型**（该账号实际受 5h/7d/Fable 哪些窗口约束）。
- 已验证的 Ultra（无 5h 窗口）会被自动识别，调度不再按 5h 停调、不加"重置后休息"。
- worker 路径解析 Claude Code 每轮的 `rate_limit_event`，实时写 5h/7d 用量（以前 worker 对窗口是瞎的）。
- 重新探测一个账号：控制台账号页「测试/刷新」，或 `python3 -I /root/monitor/acct-probe.py https://1dayapi.com <account_id>`。

---

## 7. 故障速查（现象 → 看哪里 / 什么意思）

| 现象 | 含义 / 处置 |
|---|---|
| 客户"这是新对话/看不到历史" | historyPolicy=reset 截断。§3：给 Key 设 passthrough + 清 reset_active。|
| 回包 `msg_`+24 位、cache_read=0、input 很小 | 走了 worker 路径且历史没带全。查 `[ccr-worker] <rid> ... (no_memory/continue, N blocks)`。|
| 回包 `msg_011C…` | 直连透传（正常，完整）。|
| 出错被塞进 HTTP 200（5h limit/org disabled/只回 ping） | responseMode=keepalive 的早 200 所致。给 Key 设 `responseMode=strict` 回真实状态码。|
| `cc_profile_mismatch_total` > 0 | 直连出站再校验失败，请求被 400 拒、**未发上游**。看 `[cc-profile] <rid> ... IN sys0=.. OUT sys0=..` 定位归一化哪步弄坏了形态。|
| `[billing-suffix] mismatch` | 计费头后缀与出站 messages 对不上，已原样转发客户 body。|
| `429 {"rate_limit_error","Error"}` | 伪造形态被上游拒。V2 当单次 `upstream_request_rejected`，不换号重试（这是 11-01 封组织的根因）。|
| `503 no_available_account` | 池里没可用账号（供给问题，与形态无关）。|
| `session_lost` / `409 tool_continuation_after_reset` | worker 续不上会话 / 工具轮边界丢失（常见于停机后余波）。|
| 账号 `proxy_down` | 铁律 1：代理不通冻结，只能人工解除/换 IP，不自动恢复。|

---

## 8. 当前灰度进度（2026-11-02 07:34Z）与下一步

- 已开：`direct_profile_strict=canary`、`direct_cc_entrypoint_normalize=canary`（真实 genuine→直连已在跑、暂 0 失配）；mirasim Key 已 passthrough+strict。
- 待办顺序（每个一天、报表干净再下一个）：补齐各 CC 版本 profile → `direct_profile_strict=1` → `cc_client_response_profile` → `key_policy_auto` →（推节点包+`CC_WORKER_CANONICAL=1`）`worker_canonical` → 7 健康天后 `telemetry_evidence_required` → `canonical_history_import` → R4 raw/strict。
- 全部切 1 且稳定两周后 → R5 删除 V1 旧分支。
- 硬前提：真实样本够、供给够、24h 干净观察攒够。没数据不切。

---

## 9. "我要做 X 怎么办" 速查

- **把某功能对灰度组开**：对应开关设 `canary` → `ops/bin/canary-verify` → 观察 `ops/bin/canary-report`。
- **把某功能全量开**：确认 ≥24h 干净 → 开关设 `1` → 观察 2h。
- **某功能出问题**：开关设 `0`（即时回滚，无需重新发布）。
- **给一个客户修丢历史/错误码**：§2 改那把 Key 的 override（passthrough / strict）+ §3 清 reset_active。
- **让一个真实用户参与灰度**：`ops/bin/canary-move-keys move <key_id>`（+ 启动 `canary-watchdog`）。
- **看现在灰度健康不健康**：`HOURS=24 node --no-warnings ops/bin/canary-report`，末尾 VERDICT。
