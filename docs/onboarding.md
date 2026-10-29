# 账号接入平台（上号）契约

> 状态：**已实现**（2026-10-15 晚）。供给端 Claude 订阅账号的自助接入系统。
> 相关：`ccr-supply.md`（CCR 供给总设计）、`v3-design.md` §5（账户体系）、`provider-protocol.md`（节点协议）。
> 参考 sub2api 的账户添加形态，按 1DayAPI 架构精简。
>
> 2026-10-27 修订：订阅账号按实际 Claude 组织 UUID 接入；账号固定代理，一个实测出口 IP 默认两号、常规容量不足时最多三号，均须同组织。
> 旧账号、代理和会话不回填、不修改、不删除；旧未管理账号和任务也不参加自动维护。详细隔离与跨组织清空规则见 [`team-isolation.md`](team-isolation.md)，发布事实见 [`发布记录`](deployment/team-isolation-2026-10-27.md)。

## 1. 原则

1. **账号固定绑定代理，组织限定出口**：每个实测出口 IP 默认绑定两个账号；同组织授权范围内所有常规名额不足时才启用第三槽，三为硬上限。
   容量包括已绑定账号与有效上号预留，跨 URL、跨节点合并计算。账号绑定后，令牌刷新、巡检、推理和会话 API 都使用该固定出口，不自动改绑。
2. **代理即命脉**：绑定代理失联（节点探活失败）→ 账号立即不参与调度（`proxy_down`），恢复后自动回到调度。
3. **删除账号只释放名额，保留组织归属和历史**：暂停、失效、额度耗尽不自动释放名额。新隔离资源的组织认领不因删除账号、节点或代理池成员而清除。
   **旧式单账号代理的释放冷静期（历史兼容）**：被删除的旧账号若处于 `error` 状态（上游 401 吊销、on hold 等被拒账号），其代理释放后写
   `node_proxies.cooldown_until = now + proxy_release_cooldown_sec`（默认 24 小时）和 `cooldown_reason`；期间自动分配跳过它、
   手选它返回 400 `proxy_cooling`、上号选择器不显示它，代理池列表标「冷静期至 …」。健康账号删除释放的代理立即可用。
4. **一号一行，重复上号拒绝（2026-10-20 起）**：同一个底层 Claude 账号（按 OAuth `accountUuid` 判定，缺省回退 email）
   再次上号时**不允许上号**：作业以 `account_exists` 失败，提示"账号已存在（邮箱 / id / 状态），不允许重复上号，已有账号未替换"；
   已有账号行的凭据、状态、冷却、代理绑定一律不动，本次换到的 token 对直接丢弃，作业预留的代理也不会被占用。
   此重复检查只针对已纳入隔离管理的账号；无 team 的旧记录原样保留，不因新接入被更新或删除。新管理账号命中另一个组织中的同一上游身份时拒绝跨组织改挂。
   （2026-10-16 ～ 10-20 的旧行为是覆盖已有行并重绑代理，已按用户要求取消。）
   **例外（2026-10-22 起，§11）**：已有行处于 `error`（上游 401 吊销、on hold 等）且归属相同（同一号商，或都是平台池）时，
   再次上号**原地重授权**：换凭据、清错误与冷却，分组 / 优先级 / 限额 / 代理绑定不动，不插新行，作业返回 `reused: true`。健康行仍拒绝。
5. **多人可上号**：管理员上号立即可调度（`approved`），归属随节点：平台节点 → 平台池（`owner_id=NULL`），号商节点 → 归该号商（与 `POST /api/admin/accounts` 的 `nodeId` 规则一致，号商按分成结算）；号商上号进自己名下。**2026-10-26 起号商上号不再审核**：授权完成即 `approved`、`payout_rate` 取 `provider_default_payout_rate`、挂入该号商的 `users.onboard_group_id`（控制台用户详情「上号自动挂组」，`PATCH /api/admin/users/:id {onboardGroupId}`；未设则默认分组），落库即参与调度（2026-10-20～10-25 期间的 `pending` + 管理员审核流程仅保留给手工 `POST /accounts` 的 API 账号）。
6. **当前只接入 Claude（Anthropic）系列**：上号表单、模型选择、目录展示均只出现 Claude；其余平台隐藏（前端过滤，注册表不动）。
7. **新号冷静期（2026-10-20 起；号商自己上的号不适用，2026-10-26）**：授权完成落库时写 `temp_unschedulable_until = now + random(onboard_cooldown_min_sec, onboard_cooldown_max_sec)`
   （默认 3720～4200 秒 = 62～70 分钟；2026-10-20 先定 15～20 分钟，同日加长），`error_message` 以 `onboard_cooldown:` 开头；期间调度器不选它（与临时冷却同一字段），
   账号列表显示为「新号冷静期」而非错误，上号结果附 `cooldownUntil`。冷静期内仍会做授权后的 usage 基线探测与 profile 回填
   （真实 Claude Code 登录后也会立即做这两件事）。两项设置都为 0 = 关闭。

## 2. 上号方式与凭据分流

### 2.1 推荐：sessionKey 非浏览器直连（2026-10-18 协议验证通过）

号商粘贴账号的 `sessionKey` 后，平台直接用 SK 作为 Bearer 调用官方 OAuth authorize 接口，完成授权码 + PKCE 交换。
**不打开同意页，不启动 Chromium，也不依赖浏览器指纹。** 实现：`apps/console/src/onboard/direct-oauth.ts`
（2026-10-18 起为 `method=session_key` 的唯一实现，服务器浏览器 bot 已删除）。四个请求
（organizations → authorize → token → validate）**全部经该任务预留的节点代理发出**（http_egress 隧道，
`openEgressOnNode`，与网关同一条路径）。已知组织可直接预留该组织容量；未知组织先独占未认领出口完成发现，确认后永久认领发现出口，再在同组织内选最终名额并重新验证 token。最终绑定建立后不自动更换出口。
注意节点对 `api.anthropic.com/v1/*` 会补齐 Claude Code 指纹头（UA / x-app / stainless），authorize 与 token
两步因此带有这些头；控制台未发送 `anthropic-client-platform/version`。
`claude.ai/api/organizations` 一步在 Cloudflare 人机验证之后：请求按 claude.ai 前端自身 XHR 的形态发
（Chrome UA、Origin/Referer、sec-ch-ua / sec-fetch-*），否则节点默认的 `Bun/x` UA 会直接拿到 403 "Just a moment..."
（2026-10-18 首次真实上号即如此失败）；仍被拦即为该代理 IP 信誉问题，任务失败码 `cloudflare_challenge`——此时表单填「组织 UUID」
（`orgUuid`，§3）即可完全绕开这一步，不再有任何 claude.ai 请求。

```http
POST https://api.anthropic.com/v1/oauth/{org}/authorize
anthropic-version: 2023-06-01
Authorization: Bearer <sessionKey>
Content-Type: application/json
anthropic-client-platform: desktop_app
anthropic-client-version: 2.42304.0

{
  "response_type": "code",
  "client_id": "<按 §2.3 选择>",
  "organization_uuid": "<org>",
  "redirect_uri": "<按 §2.3 选择>",
  "scope": "<按 §2.3 选择>",
  "state": "<随机值>",
  "code_challenge": "<SHA256(code_verifier) 的 base64url>",
  "code_challenge_method": "S256"
}
```

成功响应的 `redirect_uri` 含 `code` 与 `state`，随后交换 token：

```http
POST https://api.anthropic.com/v1/oauth/token
Authorization: Bearer <sessionKey>
Content-Type: application/json

{
  "grant_type": "authorization_code",
  "client_id": "<同 authorize>",
  "code": "<上一步 code>",
  "redirect_uri": "<同 authorize>",
  "state": "<同一个 state>",
  "code_verifier": "<原始 code_verifier>"
}
```

上述 JSON/Bearer 示例用于 Claude Code；Chrome Extension 的表单 token exchange 见 §2.3，不能混用。

- `organization_uuid` 来自 `GET https://claude.ai/api/organizations`。
- `accountUuid` 可由 SK 第 13–35 个字符做 Base64URL 解码得到 16 字节 UUID；Chrome 静默重授权时可附 `prompt=none`、`login_hint=<accountUuid>`。
- 旧 SK 可能返回 `session_stale_relogin`（授权所需的新鲜度不足），应与 token 无效区分处理。
- 已验证：`authorize` 返回 code，token endpoint 返回 access/refresh token，`/api/oauth/validate` 返回 `valid: true`。

### 2.2 备选：授权链接（`method=auth_url`，保留人工路径）

平台生成授权 URL（PKCE 参数由平台持有）→ 上号人**在自己已登录该账号的浏览器**中打开并完成同意
→ 浏览器跳转到回调地址 → 上号人把回调 URL 粘贴回平台 → 平台经绑定代理换取令牌并落库。

> 授权请求来自上号人自己的浏览器 IP。为保持 IP 一致性（见 `ccr-supply.md` §2 的实验结论），
> 上号人应在其账号日常使用的网络环境中操作，界面必须提示这一点。

### 2.3 client、scope 与用途不能混用

| 用途 | client_id / redirect_uri | scope | 已验证结论 |
|---|---|---|---|
| Chrome Extension | `dae2cad8-15c5-43d2-9046-fcaecc135fa4` / `chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/oauth_callback.html` | `user:profile user:inference user:chat` | token 有效，`/chrome/{accountUuid}` 返回 `waiting` |
| Claude Code runner | `9d1c250a-e61b-44d9-88ed-5944d1962f5e` / `https://console.anthropic.com/oauth/code/callback` | `user:ccr_inference user:file_upload` | token 有效，但 `/chrome/{accountUuid}` 返回 403；不得用于 Chrome Bridge |
| Bridge environment / SI | 同 Claude Code client | `user:sessions:claude_code user:file_upload` | `/v1/environments/bridge` 必需；token 可用于 environment/work/SI |
| 官方 Remote Control 全量接入 | 同 Claude Code client | `user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload` | 官方进程完成 environment、work、ack、worker/register 全链路 |

Chrome Extension 的 token exchange 使用 `POST https://platform.claude.com/v1/oauth/token`，请求体为
`application/x-www-form-urlencoded`；其 `redirect_uri` 与 client 必须保持上表一致。将 `ccr_inference` 放到
Chrome Extension client 上会被拒绝为“scope 未注册”。

### 2.4 已删除：服务器浏览器 bot

2026-10-18 起浏览器 bot（xvfb + Chromium 完成同意页）从代码库删除（`bot-runner.ts`、`recon/lab/onboard_bot.py`），
`ONBOARD_BOT_CMD` / `onboard_bot_unavailable` 不再存在；服务器上的 `/opt/ccr-lab/` 只剩实验脚本，不再被控制台调用。
测试/开发用 `ONBOARD_MOCK=1`（可配 `ONBOARD_MOCK_DELAY_MS`）跳过上游交换。
上号不再创建云端环境（`environment_providers/cloud/create`）：executor=ccr_worker 不需要，executor=ccr 懒 provisioning。

## 3. 上号参数

| 参数 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `method` | ✅ | — | `session_key` / `auth_url` |
| `sessionKey` | 方式一 | — | 站点会话 cookie，仅用于一次性授权，用完即弃（不落库明文之外的长期存储） |
| `orgUuid` | 方式一可选，管理员界面显示 | 自动查询 | 预期的实际组织 UUID，最终与授权结果核对；不是手工创建的隔离池 ID。可跳过 organizations 查询；格式无效则拒绝，实际组织不符则失败并记录隔离事件。组织名称和 UUID 不在非管理员界面或返回字段中展示 |
| `teamName` | 管理员可选 | profile 资料或空 | 组织显示名称，仅管理员设置和读取，不改变组织 UUID |
| `nodeId` | ✅ | — | 出网节点（该账号运行期请求的出口节点） |
| `proxyId` | — | `"auto"` | 指定或自动选择经实测、健康且组织兼容的出口；优先填已有一个账号的出口，常规两号容量不足后才使用第三槽 |
| `concurrencyLimit` | — | 0（不限） | 账号最大并发请求数 |
| `rpmLimit` | — | 0（不限） | 每分钟请求数上限 |
| `name` / `note` | — | 自动 | 备注 |
| `groupId` | 管理员可选 | default | 号商上号忽略此参数：挂该号商的 `users.onboard_group_id`（未设则默认分组，2026-10-26） |

**sessionKey 形态校验（2026-10-28）**：服务端在建任务、预留代理之前先检查 `sessionKey` 形如 `sk-ant-sid01-<base64url>`
（正则 `^sk-ant-sid\d{2}-[A-Za-z0-9_-]{40,}$`），不符合直接 400 `session_key_format`，不占代理、不出网（失败任务会封存出口，§12，
所以拿粘错的片段去试一次的代价是一条代理）。`ONBOARD_MOCK=1` 下不校验（测试夹具用短字符串）。前端单条与批量模式同一正则先行检查。

**常用组织（管理员，2026-10-28）**：`orgUuid` / `teamName` 可以从「常用组织」列表选择，而不是每次粘贴。列表是管理员的通讯录
（表 `onboard_orgs`，迁移 23：`id, org_uuid UNIQUE, name, note, created_by, created_at, updated_at`），只影响表单填充；
组织归属仍由服务端按 §12 验证。它与 `upstream_teams` / `proxy_team_claims` 无关，删除一条常用组织不影响任何账号或代理。

**旧代理回填的实际决定（2026-10-28）**：隔离发布把全部 525 条已有代理标为 `isolation_version=0`，而新分配逻辑只认版本 1，
上线后没有一条代理可分配（所有上号 400 `proxy_pool_empty`）。当日 09:31 UTC 按用户决定把 **未绑定且 live** 的 471 条旧代理直接标为
版本 1（备份 `data/backups/1dayapi.db.pre-proxy-backfill-20261028T083109Z.bak`），节点下一次心跳补齐出口 IP 后即可分配。
未回填的：WORK-CCR 节点的 50 条（隔离供给，不参与上号）和 4 条已绑定旧账号的代理（随旧账号一起留在旧路径）。
上文「现有行不回填」自此只对这两类成立。

## 4. API

号商前缀换成 `/api/provider`（号商只能选自己的节点与代理）。

```
POST /api/admin/accounts/onboard
  方式一 body: {method:"session_key", sessionKey, orgUuid?, teamName?, nodeId, proxyId?, concurrencyLimit?, rpmLimit?, name?}
       → {data:{jobId, status:"working"}}
  方式二 第一步 body: {method:"auth_url", nodeId, orgUuid?, teamName?, proxyId?, ...}
       → {data:{jobId, status:"pending_callback", authorizeUrl}}
  方式二 第二步 body: {method:"auth_url", jobId, callbackUrl}
       → {data:{jobId, status:"working"}}

GET  /api/admin/accounts/onboard/:jobId
  → {data:{status, accountId?, error?, authorizeUrl?}}
  status: pending_callback | working | done | failed

GET  /api/admin/nodes/:id/proxies?free=1
  → {data:[{id,label,host,port,status,boundAccounts,reservedAccounts,normalSlots,overflowSlots,...}]}
     // 不含用户名密码；free=1 表示有剩余容量，实际组织与预留条件在创建作业时再次校验
```

错误码：`proxy_pool_empty`（无符合组织与容量规则的健康出口，手选同样校验）、
`node_offline`、`callback_invalid`（回调 URL 无法解析 / state 不匹配）。任务态失败（`GET …/:jobId` 的 `error` 字段，
形如 `code: 摘要`）：`node_offline`（节点未接受隧道 / 预留代理已不存在）、`session_key_invalid`（claude.ai 或 authorize 返回 401/403）、
`cloudflare_challenge`（claude.ai 对该代理 IP 返回 Cloudflare 人机验证页，SK 根本未被评估——换代理重试）、
`session_stale_relogin`（登录新鲜度不足，需重新登录再取 SK，不等于 SK 无效）、`authorize_failed`（organizations/authorize 其他错误，含上游摘要）、
`token_exchange_failed`、`validate_failed`（仅 auth_url 路径：token 可用但 validate 不返回组织）。


常用组织（仅管理员，`requireAdmin`）：

```
GET    /api/admin/onboard/orgs            → {data:[{id, orgUuid, name, note, createdAt, updatedAt}]}（按名称排序）
POST   /api/admin/onboard/orgs            body {name, orgUuid, note?} → 201 {data:{…}}
PATCH  /api/admin/onboard/orgs/:id        body {name?, orgUuid?, note?|null} → {data:{…}}
DELETE /api/admin/onboard/orgs/:id        → {data:{ok:true}}
```

错误码：`invalid_request`（缺 name / orgUuid 非 UUID）、`org_exists`（同一 UUID 已保存，含改到别的行已有的 UUID）、404 `organization`。
`orgUuid` 落库统一小写。ops / 号商访问一律 403。


上号预检（管理员与号商各自前缀；号商只看到自己名下的账号）：

```
POST /api/admin/accounts/onboard/precheck     body {sessionKeys: string[]}（1–200 条）
POST /api/provider/accounts/onboard/precheck
  → {data:[{index, formatOk, accountUuid|null, existing:{id,email,status,teamId}|null}]}
```

只做两件事：按 §3 的正则检查形态；从 key 第 13–35 位解出 account uuid（§2.1）查 `accounts.account_uuid`。
不访问上游、不写库、不记日志。前端批量模式提交前先调它，已存在的 key 标「已存在，跳过」不再提交；单条模式在输入框下提示。

### 4.1 自带代理（2026-10-28）

上号时代理选择器多一项「自带代理」：操作者粘贴一条代理地址，平台解析、入池、等节点探活后再开任务。管理员与号商各自前缀。

```
POST /api/admin/accounts/onboard/proxy        body {nodeId, proxy, orgUuid?, dryRun?}
POST /api/provider/accounts/onboard/proxy
  → {data:{proxyId|null, nodeId|null, parsed:{scheme,host,port,username,display}, existed, added, pushed,
            status, lastError, exitIp, country, quarantined, quarantineReason, boundAccounts, reservedAccounts,
            blocked: null | legacy|dead|unprobed|exit_unverified|cooldown|quarantined|other_organization|needs_virgin_exit|reserved_by_other|full|not_in_pool}}
```

- **解析**（`node/proxy-parse.ts`）：接受 `socks5://u:p@h:port`、`socks5h://`、`http(s)://`、`u:p@h:port`、`h:port`、`h:port:u:p`、`u:p:h:port`，
  以及空格 / 逗号 / Tab / `|` / `;` 分隔的 `h port u p`（或 `u p h port`）；无 scheme 一律按 socks5；IPv6 用 `[…]:port`。
  规范化为 `scheme://user:pass@host:port`（userinfo 仅在含保留字符时百分号编码）；密码不出服务端，响应里只有 `display`（`user:***@host:port`）。
- **复用而非失败**：先按规范化 URL 的 id（以及输入原样 URL 的 id）查 `node_proxies`，再按「host + port + 用户名 + 密码」指纹
  （忽略 scheme：一个端口只说一种协议）解密比对全部池子。命中即复用该行，`existed=true`，`nodeId` 是它所在的节点——
  若不是请求的节点，管理员端表单自动切到那个节点；号商只能命中自己节点上的行，命中别人的返回 400 `proxy_on_other_node`。
- **未命中**：`addNodeProxies` 追加到 `nodeId` 的池（`label` = `supplied:<操作者>`，`isolation_version=1`，状态 `unknown`），
  并立即向节点下发代理池；节点对新 URL 立刻探活并测出口（`replaceAll` 只对新增条目起一轮 `checkAll`），下一次心跳（10 s）回写
  `live` + `exit_ip`。`dryRun=true` 只解析和查找，不写不推（表单输入时的实时预览）。节点离线时非 dryRun 返回 400 `node_offline`。
- **容量规则不变**：`blocked` 由 `teamIncompatibleReason`（§6.1 的组织 / 隔离 / 冷却 / 封存条件）加占用数给出；同一出口常态 2 个账号、
  最多 3 个。前端拿到 `unprobed` / `exit_unverified` 时每 3 秒重调本接口，最多等 90 秒，`blocked=null` 后用 `proxyId` 正常
  `POST …/onboard`。其他 `blocked` 直接报原因，代理行留在池里。
- 顺带修正：`resolveTeamProxy` 对**显式指定**的 `proxyId`（下拉手选或自带）只检查硬上限 3；此前只要别的出口还有常态名额，
  手选一个已占 2 的代理会被拒为「无可用代理」。自动分配仍先填满常态 2 再用第 3 名额。显式指定的失败信息改为
  `proxy_not_found` / `proxy_unassignable: <原因码>` / `proxy_full`。
- **无人使用的旧行按新代理处理（2026-10-29）**：命中的行既没有绑定账号也没有在途预留，却因封存 / 冷却 / 探测失败 / 行级旧组织标记而不可分配时，
  `reset=true`：dryRun 只报告；正式调用解除封存（写 `proxy_quarantine_lifts`）、记事件 `resupplied`、删掉旧行，再把操作者的规范化 URL
  （无 scheme 一律 socks5）作为新行加到**操作者选的节点**并下发，随后像新代理一样等节点验证。出口 IP 上另一组织的归属（`proxy_team_claims`）
  是只增不删的，这种情况不重置，返回 `blocked=other_organization`。
- 节点页「代理池」粘贴也接受无 scheme 的行（`host:port[:user:pass]`、`user:pass@host:port`），服务端 `validateProxies` 统一规范化为 socks5；
  写了 http(s):// 的保持原样。
- 400 `proxy_unparseable`（解析失败）、`proxy_on_other_node`、`node_offline`、`invalid_request`；404 `node`。
  测试：`test/proxy-parse.test.mjs`、`test/proxy-supplied.test.mjs`。

### 4.2 代理分组（2026-10-29）

`node_proxies.group_name`（迁移 27，自由文本，NULL = 未分组）。用途：大池子按代理商 / 批次 / 用途归档，以及上号时「节点 → 分组 → 组内自动分配」。

```
POST/PUT /api/admin/nodes/:id/proxies   body {proxies:[{url,label?,group?}], group?}
  → 追加结果多一个 regrouped：本批里池中已有的行被移入 group 的条数（有 group 时不再按「已在池中」跳过）
GET  /api/admin/nodes/:id/proxy-groups  → {data:[{group|null,total,live,dead,bound,assignable}]}（未分组排最后）
GET  /api/provider/nodes/:id/proxy-groups（号商只看自己的节点）
POST /api/admin/nodes/:id/proxies/group body {proxyIds[], group|null} → {data:{changed, group, groups}}（null = 移出分组）
POST /api/{admin,provider}/accounts/onboard  多一个可选 proxyGroup：proxyId=auto 时只在该分组内挑选；
     无可用时 400 proxy_pool_empty，信息带 "in group <名>"。显式 proxyId 不受分组限制。
```

规则：单条的 `group` 优先于批量的 `group`；空串 = 未分组；名称去首尾空白、最长 60。`GET …/proxies` 与选择器视图多一个 `group`。
自带代理（§4.1）新入池的行归入 `supplied` 组。前端：节点页「代理池」顶部是分组筛选片（存活/总数，整组失效标红）+ 状态筛选，
行首复选框，批量「移到分组」「删除所选」；追加表单多一个「本批分组」。上号页自动分配 / 从池中选时若节点有分组，多一个「分组」下拉。
测试：`test/proxy-groups.test.mjs`。

解封代理（仅管理员）：

```
POST /api/admin/nodes/:id/proxies/:proxyId/unquarantine → {data:{ok:true, pushed}}
```

删除 `proxy_quarantine` 里该代理自身键 `proxy:<id>` 和它的出口资源键，代理行置 `unknown`、清 `last_error`（下一次心跳重新核验出口），
写 `proxy_team_events` 事件 `unquarantined`（含操作者），并向节点重新下发代理池。404 `proxy` / `node`；400 `proxy_not_quarantined`。
`GET /nodes/:id/proxies` 与选择器视图都带 `quarantined` / `quarantineReason`。

## 5. 数据模型（迁移 5 与 21）

- `accounts` 新增：`rpm_limit INTEGER NOT NULL DEFAULT 0`、`bound_proxy_id TEXT REFERENCES node_proxies(id)`。
  （`concurrency` 列沿用——语义即并发上限，0=不限。）
- 旧 `node_proxies.bound_account_id` 保留兼容，不能用于新资源的容量计算。新关系以多个 `accounts.bound_proxy_id` 和上号预留为准。
- 新表 `onboarding_jobs`：`id PK, requester_id, scope('admin'|'provider'), method, node_id, proxy_id,
  params_json, payload_enc, authorize_url, status, account_id, error, created_at, updated_at`。
  payload_enc 存 sessionKey / PKCE verifier+state（加密），job 完成后清空。
- 迁移 21 新增 `upstream_teams`、`accounts.team_id`、代理的组织/出口资源字段、上号任务的组织与预留字段。
  `proxy_team_claims`、`proxy_quarantine` 和 `proxy_team_events` 为追加记录，删除账号或重新导入代理不能擦除过去归属。
- 现有行不回填，旧无 team 订阅账号和旧代理不自动纳入新隔离池；新建表从新接入与新观测开始记录。

## 6. 运行时行为

### 6.1 代理绑定与调度

- 上号成功后，在同一事务提交账号的 team / 固定代理、出口组织认领和分配事件。
- 调度过滤（gateway `listCandidates` 之后）：`bound_proxy_id` 非空而代理 `status!='live'` → 跳过该账号
  （不计入错误冷却，代理恢复即自动可用）。
- auto 在授权节点范围内选择健康、实测且组织兼容的资源，先用占用小于二的名额并优先填已有一个账号的出口；全部常规名额用完才允许第三个。
  手动选择也不能绕过组织、全局 IP 容量、隔离和预留检查。

代理"死"的判定在节点侧只认代理层失败（SOCKS 握手/认证、连不上代理、407）；上游侧的复位/超时只触发一次立即重探，不直接把代理标 dead。
**判死放宽（2026-10-17，用户要求"代理池只是有波动，评判标准放宽"）**：一次代理层失败（探活或真实请求）只记一次 strike，代理进入
"suspect"但照常使用、钉死照常生效，并立即重探一次；**连续** `PROXY_DEAD_AFTER`（默认 3，即 5 分钟探活连续 3 次 ≈ 15 分钟）次失败才标 dead、
撤销粘性分配、心跳报 `live:false` → 平台 `status='dead'` → 绑定账号退出调度；期间任何一次成功（探活或请求）清零 strike。探活并发 8 → 4，
减少供应商对突发连接的误拒。节点重启后代理在重探完成前报 `live:null`，平台保留上一次的 live/dead 结论（不再整批翻成 `unknown`），绑定账户的调度不因节点重启中断。

### 6.2 账号操作出口（CCR 账号）

`executor=ccr` 的账号，其会话 API 请求（建环境/建会话/events 推拉）与令牌刷新、巡检，
一律经隧道 `http_egress` 下行到 `accounts.node_id` 对应节点，节点用**钉死的代理**
（spec 新增 `proxyId` 字段，绕过粘性分配；代理缺失或死亡 → `no_proxy_available` 硬错误）。
新订阅账号即使使用 `executor=direct`，平台侧请求也经固定节点代理；不能把 direct 理解为主服务器直接出网。

### 6.3 并发与 RPM 限额

网关在共享 SQLite 中按账号维护：90 秒可续约在途租约（并发上限）与 60 秒滑动窗口记录（RPM 上限）；蓝绿实例共用计数，管理页汇总全部有效租约。
候选循环中超限账号跳过（不算失败、不触发冷却）。两者默认 0=不限。
限额是平台侧自我保护，与订阅窗口配额（`ccr-supply.md` §7）正交。

### 6.4 删除释放

删除账号（admin/号商自有）→ 释放该账号名额并追加释放事件，保留出口组织认领和历史。旧式单账号字段仅按兼容逻辑处理。
删除节点（管理员或号商自删）在同一事务里释放其全部资源：绑定在其代理上的账户解绑并 `disabled`、删代理与分配、进行中的上号任务置 `failed`。代理池替换（`PUT /nodes/:id/proxies`）保留仍在列表中的条目（含绑定），已绑定账号的代理不能被移除（400 `proxy_bound`）。平台在节点每次 `provider.hello` 后推送整份代理池，节点本地副本与平台不会长期分叉。

### 6.5 预留与过期

上号任务创建时在事务中预留一个容量名额，已绑定与有效预留合计不能超过三。组织未知的发现出口先独占，不允许拿其他组织出口探测。
`working` 超过交换期限或 `pending_callback` 超过 30 分钟后失败并释放预留；已实际出站但组织无法确认或出现冲突的资源保留隔离记录，不能当作全新空闲出口。迟到授权结果不能复活失败任务。

## 7. 前端（web）

- 新增「账号接入」页（admin 与 provider 控制台均有入口）：
  方式切换（sessionKey / 授权链接）、参数表单（并发/RPM/节点选择/代理选择器含 auto）、
  job 状态轮询（pending_callback 时展示授权链接与回调粘贴框；working 时转圈；done 跳转账号详情；failed 展示错误）。
- 代理选择器：`GET .../proxies?free=1` 下拉，展示探活、已绑定与预留占用。组织字段与历史只向管理员展示，非管理员错误不返回组织身份。
- **全站 Claude-only**：公开站点模型页/价格页、控制台分组模型选择器只显示 `platform=anthropic` 的模型；
  其余平台前端隐藏（注册表与网关行为不变，方便日后恢复）。

**2026-10-28 常用组织与批量上号**（`console/pages/shared/Onboard.tsx`，管理员）：

- 组织一栏是下拉：「不指定」/ 已保存的常用组织 / 「手动输入…」。选常用组织时自动带出 `orgUuid` 与 `teamName`；手动输入时可一键
  「保存为常用组织」。「管理常用组织」弹窗支持新增、编辑、删除（删除有二次确认），UUID 实时格式检查。
- sessionKey 方式新增「单条 / 批量」切换。批量：一次粘贴多条 key（按行、逗号、空白切分，去掉首尾引号），前端按与服务端相同的正则逐条
  标记「格式错误 / 重复」并只提交有效且去重后的条目；共用同一组织与参数（代理固定 `auto`）；相邻两条之间随机等待 5–7 秒
  （区间可改，0–600 秒）；每条 key 一个独立任务，进度表逐行显示排队 / 进行中 / 成功（邮箱）/ 失败（错误码）；
  「停止」只停止后续提交，已提交的任务照常跑完。批量编排在浏览器侧，关闭页面即停止提交，已创建的任务不受影响。

**2026-10-28 自带代理**（§4.1）：代理下拉第二项「自带代理（手动填写）」，下方出现地址输入框；输入 400 ms 后以 `dryRun` 预览
「解析为 socks5://user:***@host:port · 代理池已有（节点 X）· live · 已占 n/3」或「代理池中没有：上号时会先加入该节点并探测」。
提交时先登记 / 复用，代理在别的节点上则自动切换节点并提示，新代理显示「等待节点验证…n 秒」（最多 90 秒），验证通过后再创建任务；
不能分配时按 `blocked` 原因码给出中英文提示（`onboard.proxyBlocked.*`）。批量模式下也可用同一条自带代理（第 4 条起会因上限 3 失败）。

**2026-10-29 页面改版（三步式）**：表单按 ① 凭据 → ② 出口 → ③ 归属与限额 三张编号卡片从上到下排列，右侧（桌面端粘性）是「接入摘要」
卡：方式 / 凭据 / 节点 / 代理 / 组织 / 分组 一览与唯一的提交按钮，按钮文字随场景变化（开始接入 / 批量接入 N 条 / 生成授权链接），
摘要卡里显示错误。改动点：

- sessionKey 不再有「单条 / 批量」切换：一个输入框，1 行按单条处理（格式 + 重复预检实时提示），≥2 行自动按批量处理（显示有效 / 格式错误 / 重复
  统计与逐行问题，并提示提交间隔）。
- 代理改为三选一分段按钮：自动分配 / 从池中选（显示可用条数，选中后出现下拉）/ 自带代理（出现地址框与实时预览，颜色区分可用 / 等待 / 不可用）。
  批量模式下三种方式都可用。
- 名称、备注、并发、RPM、批量间隔折叠进「高级」；组织选择与分组留在第 ③ 步。
- 上游授权返回 404 时（账号不属于所填组织）服务端错误信息写明原因，前端给出 `onboard.hint.orgNotFound` 提示。

## 8. （已废弃）授权 bot 服务化

浏览器 bot 已删除，见 §2.4。本节编号保留以免引用失效。

## 9. Bridge environment 与 session-ingress token（2026-10-18 已验证）

### 9.1 注册环境

```http
POST https://api.anthropic.com/v1/environments/bridge
Authorization: Bearer <accessToken>
Content-Type: application/json
anthropic-version: 2023-06-01
anthropic-beta: environments-2025-11-01
x-organization-uuid: <org>

{
  "machine_name": "1dayapi-worker",
  "directory": "/path/to/workdir",
  "max_sessions": 1,
  "metadata": {"worker_type": "claude_code"}
}
```

成功响应包含 `environment_id`、`environment_secret` 与 `environment_secret_expires_in=2592000`（30 天）。
`environment_secret` 只用于该环境的 work/ack/heartbeat 等后续调用，不能与 OAuth access token 混用。

### 9.2 work/poll 与 work.secret

```http
GET https://api.anthropic.com/v1/environments/{environment_id}/work/poll
Authorization: Bearer <environment_secret>
anthropic-version: 2023-06-01
anthropic-beta: environments-2025-11-01
```

work 中的 `secret` 是 **Base64URL 编码的 JSON**，不是普通文本 token。解码后的基本结构：

```json
{
  "version": 1,
  "session_ingress_token": "<SI token>",
  "api_base_url": "https://api.anthropic.com",
  "claude_code_args": [],
  "mcp_config": {"content": "...", "path": "..."}
}
```

后续 `worker/register` 和 `work/{workId}/ack` 都使用解码得到的 `session_ingress_token`：

```http
POST {api_base_url}/v1/code/sessions/{session_id}/worker/register
Authorization: Bearer <session_ingress_token>
Content-Type: application/json
anthropic-version: 2023-06-01
```

实测返回 HTTP 200 与 `worker_epoch`。`ack` 路径为
`POST /v1/environments/{environment_id}/work/{work_id}/ack`，heartbeat 路径为
`POST /v1/environments/{environment_id}/work/{work_id}/heartbeat`。

注意：`POST /v1/code/sessions/{id}/bridge` 返回的 `worker_jwt` 属于另一条 worker 凭据链，
不要与 `work.secret.session_ingress_token` 混淆。空会话或没有用户任务的会话不会自动产生 work；
官方 Remote Control 的实际顺序是 environment 注册 → 初始 work → ack → worker/register → 子进程取得 SI token。

### 9.3 Chrome Extension Bridge 握手

Chrome Extension 使用 OAuth access token 连接：

```text
wss://bridge.claudeusercontent.com/chrome/{accountUuid}
```

首条消息：

```json
{
  "type": "connect",
  "client_type": "chrome-extension",
  "device_id": "<本地生成并持久化的随机 UUID>",
  "os_platform": "Linux",
  "extension_version": "1.0.101",
  "scoped_peer_disconnect": true,
  "oauth_token": "<accessToken>"
}
```

`device_id` 只是本地持久化随机 ID，不是浏览器指纹。实测 `user:profile user:inference user:chat` 返回 `waiting`；
`user:ccr_inference user:file_upload` 用于该地址则返回 403。`waiting` 表示服务器已接受凭据并等待扩展/执行端配对，
不代表浏览器工具已经执行。

## 10. 上号员站点（/onboard，2026-10-16）

独立于控制台登录体系的上号工作站，供外包上号员使用：

- 管理员在控制台「上号员」页签发令牌（`1dk_onb_…`，`onboard_tokens` 表，migration 8），**令牌绑定目标节点**（签发时选择）。
- 上号员在 `https://1dayapi.com/onboard` 凭令牌进入（Bearer 鉴权，无 cookie 会话），只能看到并使用被绑定的节点：
  查看节点在线/容量/空闲代理 → 选代理（或自动分配）→ auth_url 流程上号。
- **重复上号**：已管理的健康账号仍拒绝重复接入；同归属、同组织且已失效的账号可走 §11 原地重授权，结果为 `reused: true`。上号员界面只返回通用失败摘要，不回显组织 UUID 或管理员诊断信息。
- **落库默认值与资料回填（2026-10-16）**：新账号 `executor` 取 settings `onboard_default_executor`（默认 `ccr_worker`，可改 `ccr`）；
  并发 / RPM 上限在表单留空或 0 时取 settings `onboard_default_concurrency` / `onboard_default_rpm_limit`（用户定：9 / 100；0 = 不限
  只能事后在账号里改）。
  作业完成后 console 立即经该账号的节点/绑定代理调用 `GET /api/oauth/profile`（Bearer，UA 为 Claude Code 辅助调用形态），回填
  `account_email` 与 `subscription_type`（`has_claude_max` → `max`、`has_claude_pro` → `pro`，否则取组织 `billing_type` / `rate_limit_tier`）；
  失败只记日志，管理员可 `POST /api/admin/accounts/:id/profile` 重试。env `ONBOARD_PROFILE_FETCH=0` 关闭（测试用）。
- 作业以 `scope='onboarder'`、`requester_id='onb:<tokenId>'` 落库：账号**归平台池**（owner NULL、approved、进默认分组），
  与管理员上号的区别仅在于无分组选择权。
- 吊销令牌即断该上号员的访问；job 状态/列表接口均校验 requester 归属。
- **节点可选（2026-10-20）**：签发令牌时可选「全部节点」（`node_id='*'`），上号员在站点顶部下拉选择本次上号的节点（显示名称 / 在线 / 容量 / 空闲代理），
  单次与批量作业都带 `nodeId`，服务端校验必须在令牌允许的节点内；绑定单节点的令牌行为不变。`GET /api/onboard/me` 新增 `nodes[]`、`anyNode`，
  `GET /api/onboard/proxies?nodeId=`。
- **批量 SK 上号**：站点新增「批量 SK 上号」面板，每行一个 `sessionKey`；组织由服务端授权验证，非管理员表格不回显组织 UUID。
  前端解析、去重后按随机间隔（默认 5–7 s，可调）逐条 `POST /api/onboard/jobs {method:"session_key", sessionKey, orgUuid, proxyId:"auto"}`，
  每条作业 3 s 轮询一次，表格显示 待提交 / 提交中 / 授权中 / 已新增 / 重新授权 / 失败，失败行可一键复制重试。
  令牌失效或节点无兼容容量时停止提交，当前行留在队列。所有方式共用组织验证、出口名额和追加历史规则。

### 10.1 组织方案：组织 → 域名 → 节点 · IP 分组（2026-10-29）

把「常用组织」（`onboard_orgs`）扩成**组织方案**（迁移 28）：`domains_json`（该组织账号使用的邮箱域名列表）、`routes_json`
（允许上号的 `{nodeId, group|null}` 路线列表，`group=null` = 该节点整个池）、`status`（active / disabled）。令牌表
`onboard_tokens.org_ids_json`：该上号员可见的方案 id 列表，NULL = 全部启用中的方案。

```
GET/POST/PATCH/DELETE /api/admin/onboard/orgs[/:id]   body 多 domains（数组或按行/逗号分隔文本）、routes、status
  → 每条多 domains[]、routes[]（含 nodeName/nodeOnline/capacity/used/assignable/groupExists）、status、accounts
POST/PATCH /api/admin/onboard-tokens[/:id]            body 多 orgIds: string[] | null（PATCH 还可改 label / nodeId）
GET  /api/onboard/me                                  → 多 orgs[]（不含 orgUuid；令牌绑定单节点时 routes 只剩该节点）
GET  /api/onboard/proxies?nodeId=&group=              → 可按分组过滤
POST /api/onboard/jobs  body 多 orgId、domain、proxyGroup
```

服务端规则（`routes/onboarder.ts`）：令牌可见方案非空时 **必须带 `orgId`**（400 `org_required`）；`orgId` 不在可见列表 → `org_not_allowed`；
方案有域名而 `domain` 不在其中 → `domain_invalid`；方案有路线而 `(nodeId, proxyGroup)` 不匹配任一路线 → `route_invalid`
（`group=null` 的路线接受该节点任意分组）。通过后组织 UUID 取方案的 `org_uuid`（客户端传的 `orgUuid` 被忽略），
`teamName` 取方案名，自动分配限定在路线分组内，`params.expectedDomain = domain`。

**完成时的域名校验**（`jobs.ts finishJob`）：有 `expectedDomain` 时先经作业自己的出口拉 `/api/oauth/profile` 拿邮箱
（`fetchProfileViaEgress`，失败重试一次；mock 模式用 mock 邮箱），邮箱域名不等于所选域名 → 作业以 `domain_mismatch` 失败、不写账号；
该码不在污染名单里，组织已验证一致，出口按「kept_for_team」处理。拿不到邮箱时只记日志、照常落库（事后 profile 回填仍会写邮箱）。
管理员上号页也可传 `domain`（选了组织方案后出现「邮箱域名规则」下拉），同样在完成时校验。

**管理台「上号员」页**（`admin/Onboarders.tsx`）：上半是组织方案表（名称 + UUID、域名片、路线列表带在线点与可分配数、账号数；
新增 / 编辑 / 停用 / 删除；编辑弹窗里路线是「节点下拉 + 分组下拉（取该节点实时分组）」多行），下半是令牌表（多「组织」列，
签发时可选「全部组织」或勾选若干，事后可改）。

**上号员站点**（`pages/OnboardSite.tsx`）：按步骤卡片 ① 组织（卡片：名称、域名、路线数）→ ② 邮箱域名（片）→ ③ 节点 · IP 分组
（片：在线点、容量、可分配数；离线 / 0 可分配标红）→ ④ 凭据（粘贴 sessionKey：1 行单条、多行自动批量；或授权链接），
右侧摘要卡 + 唯一的开始按钮；只有一个可选项的步骤自动选中；上一步未完成下一步不出现。常见失败给出中文解释
（组织 404、域名不符、分组无代理）。最近作业表多「组织 @域名」列。令牌没有可见方案时退回老流程（选节点、选代理）。
测试：`test/onboarder-orgs.test.mjs`。

**2026-10-29 调整（用户要求"上号员应该可以选择节点和 IP 分组"）**：方案里的路线只是**推荐默认值**，不再是限制。
`POST /api/onboard/jobs` 接受令牌可见范围内的任意 `nodeId` 与任意存在于该节点的 `proxyGroup`（不存在 → `group_invalid`；`route_invalid` 已删除）；
新增 `GET /api/onboard/node-groups?nodeId=` 返回该节点各 IP 分组的 total/live/assignable。站点第 ③ 步固定显示节点下拉 + 分组 chips，
推荐路线以 chips 形式列在上方，点选即填入；令牌绑定单节点时下拉只有一项并提示找管理员改为「任意节点」。
**开始前核对**：所选节点 / 分组不在推荐路线内，或与上一次上号的（组织、节点、分组）不同，提交前弹出核对卡片，确认后才创建作业。

## 11. 原地重授权（2026-10-22）

掉授权的账号不用删行重上。两条路都落到同一段引擎代码（`jobs.ts` `reauthorizeInPlace`）：

- **行操作「重新授权」**：`POST /api/admin/accounts/:id/reauth`，body 与上号相同
  （`{method:"session_key", sessionKey, orgUuid?}`；或 `{method:"auth_url"}` → `authorizeUrl`，第二步 `{method:"auth_url", jobId, callbackUrl}`）。
  限 Anthropic 订阅（oauth）账号且 **status ≠ active**（active 返回 400 `account_active`：新授权不能和仍在用旧 token 的会话抢；要换先停用）。
  作业钉在账号自己的节点（须在线）和**绑定代理**，原账号的固定名额不重复计数；固定出口不可用时失败，不能自动挑其他代理改绑。
  授权完成后校验账号身份和实际组织 UUID，均必须与这一行一致；不符则失败，不改变账号的组织或固定代理。
  作业的 `params_json.reauthAccountId` 记录目标行；auth_url 第二步会校验 jobId 属于该账号（否则 404）。
- **普通上号撞到 error 行**（§1 原则 4 例外）：同样原地重授权；归属不同仍拒绝（`account_exists`）。作业预留的代理不消耗（绑定代理保留时）。

原地重授权做的事：`credential_enc` 换新；`status='active'`，`error_message` / 四个冷却字段 / `window_reason` / `model_cooldowns` 清空（窗口水位保留）；
`account_email` 若新拿到则更新；`route='node'`，`team_id` / `node_id` / `bound_proxy_id` 保持固定；分组、优先级、并发 / RPM、owner、review 状态、名字一律不动。
**不加新号冷静期**（这是已知账号的再登录）；授权后仍做 profile 回填。作业 `jobOut` 带 `reused: true`，`params_json.reauthorized=true`。

谁能做：admin 与 ops（账号管理员，`auth.md` §2）。控制台「账号池」行菜单对非 active 的订阅账号显示「重新授权」（error 行高亮），弹窗内两种方式与上号页一致。


## 12. 审计修订：容量、期限、取消与恢复（2026-10-28）

新 Claude 订阅只能经平台批准的可信执行节点接入，服务配置以 `TRUSTED_EXECUTION_NODE_IDS` 指定；号商自建节点的自报组织和出口不作为严格隔离池的独立验证依据。节点未获批准返回 403 `trusted_node_required`。开发临时栈可显式设 `ALLOW_UNTRUSTED_EXECUTION=1`，生产保持关闭。

节点 `capacity` 指绑定在该节点的账号行数加有效新增预约，包含 disabled/error 账号；这是账号承载上限，与 worker 并发和 IP 三号上限无关。普通新增、SK/auth_url、管理员/号商手动导入、节点凭据上传均在最终写事务中共用检查。固定账号重授权不重复占位，但同一账号已有授权任务时返回 `reauth_in_progress`。普通新增只允许 admin；ops 可对已有失效账号重授权和查询状态，不能通过新增入口创建账号。

新作业有 `expiresAt`：auth_url 回调等待 30 分钟，实际授权交换最多 3 分钟。回填回调后转换为交换期限。清理由独立 15 秒定时器执行，关闭 usage 巡检不影响它；分配和提交也检查期限。旧 v0 作业不清理、不回填。无论取消或过期，已出站但组织不明或不匹配的资源按既有规则隔离，不能释放为其他组织的 virgin IP。

| 作用域 | 查询最近作业 | 终止任务 |
|---|---|---|
| 管理员 | `GET /api/admin/accounts/onboard` | `POST /api/admin/accounts/onboard/:jobId/cancel` |
| 号商 | `GET /api/provider/accounts/onboard` | `POST /api/provider/accounts/onboard/:jobId/cancel` |
| 上号员 | `GET /api/onboard/jobs` | `POST /api/onboard/jobs/:jobId/cancel` |

管理员/号商列表最多返回最近 30 项，包含 `jobId/method/nodeId/expiresAt/status/authorizeUrl`；号商只能读写自己的作业，上号员按令牌归属隔离。ops 的最近列表只含重授权任务，取消也只允许重授权任务。重复取消是幂等操作；已 done 的作业不会被改失败。取消会中止实际出口请求，清除作业敏感载荷、释放预约并追加历史，迟到结果不得再新增账号。

控制台可从最近任务恢复未完成 auth_url，或取消它后重新开始。管理员的 SK 和 auth_url 表单都支持输入已知组织 UUID，后台仍验证实际组织；已知组织可使用同组织第二/第三槽。上号员批量提交和活动任务期间锁定节点选择，界面目标与实际提交保持一致。

完整修复对照和测试边界见 [审计修复记录](audit-remediation-2026-10-28.md)。

### 12.1 失败即封存的边界（2026-10-28）

上号任务失败时，只有**上游对已出网的出口给出的判决**才污染该出口并封存（`proxy_quarantine` 写入代理键与出口键）：
`session_key_invalid`、`session_stale_relogin`、`authorize_failed`、`token_exchange_failed`、`validate_failed`、
`team_mismatch`、`cloudflare_challenge`、`organization_mismatch`、`oauth_verification_failed`。封存仍要求出口尚未被本组织认领
（或 `team_mismatch`），与此前一致。

平台侧失败（`node_offline`、`job_expired`、`job_cancelled`、`callback_expired`、`callback_invalid`、`account_exists`、`proxy_*` 等）不封存：
出网前失败的直接释放；已出网且表单指定了组织的，把该出口**认领给这个组织**（`proxy_team_claims`，事件 `exit_kept_for_team`），
本组织的其他账号可以继续用它，其他组织永远拿不到——出过网的出口不会再变回「干净」；已出网但组织未知（自动识别途中失败）的
仍按未知出网封存。2026-10-28 的心跳时序问题曾把 4 条代理因 `node_offline` 永久封存，这是本条的由来。
`slot_released` 事件的 reason 记录错误码以及「exit quarantined / exit kept for the specified organization / released before egress」三种结论之一。

封存记录本身只增不删（迁移 21 触发器）；解封写 `proxy_quarantine_lifts`（迁移 25），有 lift 的封存视为不生效，再次封存会删掉 lift。
所有封存判断统一走 core 的 `quarantineActive()`。

封存可由管理员在节点代理池弹窗「解封」（§4 接口），解封是一次有记录的操作决定，不改变历史事件。
