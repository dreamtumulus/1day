# 代码评审加固记录（2026-11-10）

> 本轮是一次全仓评审后的加固：不加功能，只收紧「出了问题没人知道 / 出了问题回不去 / 一处失守全盘失守」的地方。
> 改动按文件归属分给四个并行分支（core·catalog·ops·测试·文档 / gateway / console / provider-node），由集成者合并。
> 本文 §1 是「core / catalog / ops / 测试闸门 / 文档」分支的完整记录；§2–§4 留给对应分支补充。
> **本轮没有任何一步在服务器上执行过**：需要运维动手的事项集中在 §5。

基线（提交 39cbc48，Node 22.22.3）：`pnpm build` 通过；单元测试 catalog 0 项（本轮新增）、core 128/128、gateway 210/210、console 93/94
（`test/audit-fixes.test.mjs` 既有失败）；e2e 8 套件 178 项检查 0 失败（在只有回环的网络命名空间里运行）。

## 1. core / catalog / ops / 测试闸门 / 文档

| # | 问题 | 风险 | 改动 | 位置 | 验证 | 需运维 / 他人跟进 |
|---|---|---|---|---|---|---|
| 1 | 主密钥文件缺失时静默生成新密钥 | `DATA_DIR` 配错或恢复漏了密钥文件 → 库里出现两代密钥，原有凭证全部解不开，无任何报错 | 库里已有 `enc:v1:` 密文时缺钥即拒绝启动（`MasterKeyError`，写明期望路径）；`ALLOW_NEW_MASTER_KEY=1` 才新建。新增 `verifyMasterKey()`：`settings.__master_key_check__` 保存固定串的密文，每次启动解密比对，不符拒绝启动；首次启用时先抽查已有密文。`internal.key` 重建会告警，且两进程同时首启用 `O_EXCL` 不再各写一份 | `packages/core/src/crypto.ts` | `packages/core/test/master-key.test.mjs` 7 项（空库新建 / 有密文拒绝 / 钥不符拒绝 / 环境变量供钥 / 无校验值时不登记错钥 …） | **gateway、console 入口各加一行 `verifyMasterKey()`**（见 §5.1）；在此之前只有「缺钥拒绝」生效，「钥不符拒绝」未接线 |
| 2 | 客户 API Key 可凭会话 cookie 无限次明文查看 | cookie 7 天有效，被盗即全部 Key 泄露，且无记录 | `POST /api/user/keys/:id/reveal` 需要重新认证：会话是 10 分钟内新登录的，或请求体带本人 `loginKey`（本体系只有登录密钥，没有密码）；每用户每小时 10 次（成功与被拒各自计数，来自 `admin_audit`，跨进程、重启不丢）；每次查看与每次被拒都显式写审计行。`key_enc` 数据未迁移、未删除 | `apps/console/src/routes/user.ts` | `apps/console/test/key-reveal.test.mjs` 5 项；e2e 原有 reveal 检查仍通过（登录后立即查看） | **前端 `apps/web/.../user/Keys.tsx` 需在 403 `reauth_required` 时弹登录密钥输入框并带 `loginKey` 重试**；在此之前登录超过 10 分钟的用户要重新登录才能查看 / 复制 Key |
| 3 | 每小时备份把库 + 主密钥 + 探针凭据打成一个明文包发到 worker-01；两机互持 root 公钥；现网脚本不在仓库 | worker-01 运行客户驱动的 Claude Code 进程：那里失守 = 全部凭证明文 + 主服务器 root | 新的规范脚本 `ops/bin/backup`：库快照单独打包、`age` 加密给 `/etc/1dayapi/backup.pub`（无公钥拒绝运行，没有明文退路）；密钥材料进另一个加密包，校验和变化才写，远端是独立设置且默认为空；`ops/bin/backup-restore-test` 解密 → 只读打开 → `integrity_check` + 行数 → PASS/FAIL，`-k` 可验证密钥包与库包配对；systemd unit + timer；文档写明一次性准备、`rrsync` 强制命令收紧互信、每月演练 | `ops/bin/backup`、`ops/bin/backup-restore-test`、`ops/systemd/1dayapi-backup.{service,timer}`、`docs/operations.md` §5.1–5.3 | 本地用假 `age`（同 CLI）+ 本地目录代替远端跑通 13 个场景（拒绝、保留份数、远端修剪、密钥包只在变化时生成、错私钥、错密钥包、损坏包）；**本机没有真 `age`，真加解密未验证** | 全部切换步骤（§5.2）：生成密钥对、装 `age`、换 unit、清理明文旧包、收紧 `authorized_keys` |
| 4a | `gateway-switch` 只凭静态 `/health` 就切流量；没有回滚命令 | 新构建能启动但不能服务时，流量已全部切过去（10-27 / 10-28 的 36 小时故障形态） | 切换前对新实例回环端口发一条真实请求（探针 Key，形状同 `release-verify`），非 200 不切；只有显式 `--no-probe` 可跳过；目标实例仍在排空（`deactivating`）或意外在线时拒绝运行；`--hold <秒>` 保留旧实例以便瞬时回滚；`--rollback [--force-restart]`；`nginx -t` 失败时停掉新实例；`release-verify` 失败时打印回滚命令与三种情形。网关计数器读取统一走新脚本 `ops/bin/gateway-counters`（先 `/internal/metrics` + 内部令牌，后 `/health`） | `ops/bin/gateway-switch`、`ops/bin/release-verify`、`ops/bin/gateway-counters`、`ops/bin/canary-{verify,report,phase-switch,cc-probe}` | 假 `systemctl`/`nginx` + 8400/8402 假网关，在隔离网络命名空间里跑通 10 个场景；`gateway-counters` 对 4 种响应形态 | `/internal/metrics` 的响应形状由 gateway 分支决定：脚本接受 `{counters}`、`{data:{counters}}`、纯数字映射、Prometheus 文本；若是别的形状需要对一下 |
| 4b | 服务直接从可变检出目录运行；回滚要现场重建；`DATA_DIR` 默认在代码目录里 | 半个构建被崩溃重启加载；换目录即生成空库 | `ops/bin/release-build <提交>`：导出 → 安装 → 构建 → 闸门 → `/opt/1dayapi-releases/<sha>/RELEASE_OK`，只构建不激活；新布局 unit 模板以 `.next` 后缀放在旁边（现有 unit 未改）；四阶段迁移计划 | `ops/bin/release-build`、`ops/systemd/*.next`、`docs/operations.md` §4.2 | 本地对当前提交完整跑通（115 秒，闸门通过，写出 `RELEASE_OK`；重复运行识别为已构建） | 阶段 0 可立即开始；阶段 1–3 需维护窗口，尚未执行 |
| 4c | `packages/core/src/db.ts` 在 import 时执行迁移 | 任何引用 core 的进程都会迁移它打开的库；蓝绿备用实例一启动就改了旧实例在用的结构；迁移发生在探针之前 | **未改代码**（`db.ts` 不属本分支）；作为开放项写入文档，附建议方案（显式 `migrate` 命令 + 启动只校验版本） | `docs/operations.md` §4.3 | — | 需 core / gateway / console 共同安排一轮 |
| 5 | 没有 CI，也没有「哪些失败是已知的」的记录 | 新回归混在既有失败里发布 | `ops/bin/test-gate`（`pnpm gate`）：构建 + 四个包的单元测试 + e2e，对照 `tests/e2e/known-failures.txt`；新失败、或名单条目已通过却没删，都非零退出；e2e 默认放进空网络命名空间；给所有测试一个临时默认 `DATA_DIR`（部分测试不设 `DATA_DIR`，在生产检出目录里会打开生产库）。`tests/e2e/run.sh` 用健康检查轮询替换固定 `sleep`，套件未改 | `ops/bin/test-gate`、`tests/e2e/run.sh`、`tests/e2e/known-failures.txt`、`package.json` | 全量跑通：627 通过、1 已知失败；反向用例（名单多一条 / 少一条）退出 1 | 名单现有 1 条（console `audit-fixes`），修掉后删行 |
| 6 | `packages/catalog` 零测试 | 手改 JSON 出错直接进账单 | 一致性测试：每个模型都有 input / output / cache 读 / cache 写 SKU、价格为正的十进制串、无孤儿 SKU、id 唯一、缓存价位次序合理；加 `test` 脚本并纳入闸门 | `packages/catalog/test/catalog.test.mjs`、`packages/catalog/package.json` | 6 项全过：**现有目录数据没有不一致** | — |
| 7 | `canary-move-keys`、`canary-phase-switch` 直接写生产库，无 busy_timeout、无事务、先改后记 | 与在线服务抢写锁时静默失败或半途中断，没有还原依据 | `busy_timeout=5000`；每次调用一个 `BEGIN IMMEDIATE` 事务（全部成功或全部不变）；还原记录先落盘（fsync）再改行；失败打印 `FAILED …` 并非零退出；阶段切换的回滚写入失败会重试并单独报错 | `ops/bin/canary-move-keys`、`ops/bin/canary-phase-switch` | 临时库上验证：正常迁移 / 另一进程持写锁时失败且无变化 / 还原 / 轮入；`set_setting` 的记录先行与重复记录拒绝 | 灰度组目前停用，改动保持最小 |
| 8 | journald 保留期（约 4 小时）远小于工具假设的 24 小时；磁盘、库体积、备份新鲜度、结算日志无人看 | 「24h 无异常」的结论实际只看了 4 小时；备份停了、WAL 涨了、结算卡住都没有信号 | `ops/systemd/journald-1dayapi.conf`（目标 ≥14 天，上限 30 天）；`ops/bin/health-extra`（journald 跨度、磁盘余量、库与 WAL、最新备份年龄、结算日志积压；只告警），由 `ops/bin/health` 末尾调用；`canary-verify` 第 5 步标出实际跨度 | `ops/systemd/journald-1dayapi.conf`、`ops/bin/health-extra`、`ops/bin/health`、`docs/operations.md` §7.0 | 伪造目录验证各 WARN 分支 | 安装 drop-in 前先量日志量：4G 是起始值；「约 4 小时」本轮未上机核实 |
| 9 | 本轮改动没有汇总 | — | 本文；`docs/operations.md` 运维工具表补全；`docs/auth.md` §3b、`docs/errors.md`、`docs/console-api.md`、`docs/development.md`、`docs/data-model.md` 同步 | `docs/` | — | 集成者补 §2–§4 |

### 评审中确认「没有问题」或与预期不同的地方

- **e2e 基线是 0 失败，不是 34**。「34 个既有失败（`gpt-5.5` 不在目录）」来自过期的 `~/1dayAPI.com` 检出；本仓库的 `tests/e2e/seed-models.mjs` 自带该模型。`known-failures.txt` 因此只有一条单元测试。
- **catalog 数据一致**：新测试没有发现缺 SKU、零价、孤儿或重复 id。
- **journald「只保留 4 小时」未核实**，文档里按「据此前记录」表述，并让 `health-extra` 给出实测值。

### 本分支没有做的事

- 没有改 `packages/core/src/db.ts`、`apps/gateway/**`、`apps/console/**`（除 `routes/user.ts`）、`apps/provider-node/**`、`apps/web/**`。
- 没有主密钥轮换 / 重加密工具（§5.2 第 6 步提到的暴露面只能靠清理旧包与收紧访问缓解）。
- worker-01 自身的备份包（节点配置、账号凭据目录）仍是明文推到主服务器。
- 没有引入 CI 服务；闸门靠人执行 `pnpm gate` / `release-build`。

## 2. gateway（分支提交 3a2041e … a63fad7）

| # | 问题 | 改动 | 位置 |
|---|---|---|---|
| A | 按组织调度的路径没有尝试上限：一个坏请求走遍全池并跨组织续试（11-01「打 21 个号」同类） | 每请求总尝试上限 6、重试总时限 120 s（带 scope 也生效、跨组织累计）；连续 3 个账号同类失败 → 判为请求级 / 上游级，原样回客户，不再冷却、不切组织。`retry_cap_tripped_total{reason}` + `[retry-cap]` 日志 | `apps/gateway/src/retry-policy.ts`、`proxy.ts` |
| B | OAuth 刷新会被客户端断连中止，已轮换的 refresh token 丢失 → 授权被吊销 | token 端点调用与落库只受自身超时（20 s）约束；调用方 signal 只取消自己的等待 | `packages/core/src/oauth.ts`、`upstream.ts` |
| C | 直连 401/403 一次即 `status='error'`，不看响应体 | 只有 `authentication_error` / 明确的 OAuth 失效算账号级；10 分钟内 3 次才置 error，单次冷却 60 s；HTML / 非 JSON 403、`permission_error` 只算本次失败；组织不匹配 / 解密失败跳过并 `[ALERT][credential]`，不改状态 | `direct-auth.ts`、`proxy.ts` |
| D | 账号处置靠对自由文本做正则，文本里混有客户与模型内容 | 单次生效的只有 Claude Code 结构化 result、上游 HTTP body、shim 原因头（仅 auth 类）；屏幕 / stderr 引用累计到阈值才处置；客户请求里自带的同类字样永不累计 | `ccr/failure-evidence.ts`、`translate.ts`、`worker.ts` |
| E | 流中途断开只收约 1 个 output token；客户端 / 网关自身异常被当成上游故障（0 计费 + 冷却账号 + 上游不取消） | 结算写成显式决策表（24 格逐格测试）；断开按 `max(上报, 已转发内容估算)` 计费并标 `usage_estimated` / `stream_truncated`；本地故障不冷却账号；所有出口 `reader.cancel()`；有 `streamError` 永不按成功结算 | `stream-settlement.ts`、`usage.ts`、`proxy.ts` |
| F | 会话归属变更时不取消上游、不留痕 | 抛出前 cancel；写 409 `context_reset` 零成本行 + 日志 + 计数。客户端仍收到 200 的 RESET_NOTICE（合同未改，见开放项） | `proxy.ts` |
| G | 任何一次结算写失败 → 全站 503；一条毒条目永久关闭准入 | 非 2xx 零成本行改为尽力而为、不进 journal、不影响 `healthy`；重放失败 5 次的条目移入 `settlement-journal/dead-letter/` 并 `[ALERT][settlement]`；租约 / 预算续期失败先重试 3 次 | `packages/core/src/settlement-journal.ts`、`limits.ts`、`lifecycle.ts` |
| H | 公网 `/health` 返回带组织 UUID / 账号 ID 的计数器，标签基数由客户端控制 | `/health` 只返回 `{status, service, time}`；计数器在 `/internal/metrics`（头 `x-1dayapi-internal`）；标签清洗、截断 64 字符、键数上限 | `routes.ts`、`metrics.ts` |

新环境变量与默认值见 `apps/gateway/README.md` 配置表（`GATEWAY_MAX_TOTAL_ATTEMPTS=6`、`GATEWAY_RETRY_DEADLINE_MS=120000`、`GATEWAY_SAME_FAILURE_STREAK=3`、`AUTH_FAILURE_THRESHOLD=3`、`AUTH_FAILURE_WINDOW_MS=600000`、`DIRECT_AUTH_COOLDOWN_MS=60000`、`SETTLEMENT_REPLAY_MAX_ATTEMPTS=5` 等）。
测试：gateway 210 → 376，core 128 → 168（含其他分支）。集成时加：网关启动 `verifyMasterKey()`；走充值额度的账号排在有套餐额度的账号之后（含粘性会话）。

## 3. console（分支提交 808455d … e479356）

| # | 问题 | 改动 | 位置 |
|---|---|---|---|
| 1 | 节点心跳报代理 dead 时不校验归属就冻结账号；共享代理后写者胜 | 只有 home 节点的报告改 `node_proxies` 行；冻结要求更新生效 + 节点 trusted，且只冻结上报节点自己的账号；共享节点的视图存内存（`localView`），量到不同出口 IP 只记日志 | `node/registry.ts` `recordProxyHealth`、`node/proxies.ts` |
| 2 | 删除节点连带禁用其他节点上（经共享绑定）的账号，无护栏、无事件 | 仍有账号或代理被共享时 409（`node_has_dependents` / `node_shared_with_other_nodes`，带受影响清单）；`?force=1` 仅 admin 可影响其他节点，每个账号写 `proxy_team_events`；share 行总是清理 | `node/removal.ts`、`node/proxies.ts` |
| 3 | 节点上报的设备 ID 与登记值不一致时静默跳过（X-49 没被发现的原因之一） | `[registry] ALERT device identity mismatch …`（每账号 10 分钟一条）+ 计数 + `proxy_team_events` + `GET /api/admin/health/identity`；assignments 空 / 不可信报告不再清空映射；解密失败、凭据不可读、审计写失败都有限频日志 | `node/registry.ts`、`audit.ts` |
| 4 | 供应商可把 `proxy_down` / 管理员禁用的账号改回 active；approve 无条件 active | 供应商只能启用自己停用的账号（`disabled by the provider` 标记，存量回退查 `admin_audit`）；`proxy_down` 只能走 release / rebind；approve 只接受 pending | `routes/provider.ts`、`routes/admin.ts` |
| 5 | 上号员令牌的组织限制 fail-open | `org_ids_json` 非空即受限：必须提交列表内且启用的组织，否则 403 | `routes/onboarder.ts` |
| 6 | 审计表明文保存代理密码、OAuth 回调码；键名正则误杀两个设置项 | 按值脱敏（URL userinfo、代理行、`code=`/`state=`、各类 token）+ 精确键名；自带代理 dryRun 不入审计；`scripts/redact-audit-2026-11-10.mjs`（默认 dry-run，未对任何真实库运行） | `audit-redact.ts` |
| 7 | SSH 部署不校验主机密钥 | `accept-new` + `<DATA_DIR>/ssh/known_hosts`；密钥变化即失败；部署结果带指纹；`GET/DELETE /api/admin/nodes/ssh-host-pins` | `node/deploy.ts` |
| 8 | `/internal/tunnel/*` 的回环检查在 nginx 之后无效 | 带任一反代头（XFF / X-Real-IP / CF-* / Forwarded / Via）即拒绝；内部令牌保留 | `node/routes.ts` |
| 9 | console 重启后在途上号作业悬挂并可能隔离健康出口；`nodes.online` 不复位 | 启动时 `working` 作业以 `console_restarted` 失败（不隔离出口）；`online=0, in_flight=0` | `onboard/jobs.ts`、`app.ts` |
| 10 | 下载码可拿去绑定节点 / 覆盖已有节点密钥 | 下载码前缀 `dl_bundle_` / `dl_shim_`，bind 只收 `bind_`；已存在的节点须出示当前密钥，否则 409 `node_already_bound` | `node/deploy.ts`、`node/routes.ts` |

测试：console 94 → 118，全过（原偶发失败 `audit-fixes.test.mjs` 的收尾时序已修）。集成时加：启动 `verifyMasterKey()`；`deploy_meta.ccWorker.identityDrift`；节点端 bind 带当前密钥、unbind 遇 409 保留本地绑定。

## 4. provider-node（分支提交 d86e6b6、2b1e423、d37e61d）

X-49 的根治：节点（root）替账号写文件的地方收敛成一处，并在起进程前硬校验。

| # | 改动 | 位置 |
|---|---|---|
| 1 | 统一写入：`writeFileAtomic`（同目录临时文件 → mode → 属主 → rename；内容不变不写；未给属主时沿用被替换文件的属主；目标是符号链接即拒绝）、`ensureDir`、lchown 语义的 `chownTree`。`.claude.json`、`.credentials.json`、`settings.json`、`team-account.json`、机器身份文件、mcp 配置、系统提示文件、导入的转写、`team-device-owners.json` 全部改走它 | `src/account-files.ts`、`cc-worker.ts`、`machine-runtime.ts`、`mcp-server.ts` |
| 2 | 历史导入：`projects/` 及其子目录以运行身份为属主创建（疑为 X-48 那 17 次 `--resume` 失败的原因，未实证） | `cc-worker.ts` |
| 3 | 起进程前硬校验（`-p` / canonical / TUI 共用）：`.claude.json` 是普通文件、属主 = 运行 uid、0600、可解析、`userID` = 平台下发的 deviceId；不过 → `worker_spawn_failed` + ALERT | `preSpawnIdentityCheck`、`src/device-identity.ts` |
| 4 | 漂移自愈 + 告警（团队与非团队账号）：`[cc-worker] ALERT device identity drift account=… had=… want=… reason=… action=…`；留证 `.claude.json.drift-<ts>`（最多 3 份）；优先用 Claude Code 自己的 `backups/` 整文件恢复，否则只改回 `userID`；心跳 `ccWorker.identityDrift {healed, failed, detected, lastAt}`；该账号的常驻进程空闲后回收 | `ensureDeviceIdentity`、`healDeviceIdentity` |
| 5 | 每轮结束 `refreshIdentity` 即比对，变了立刻 ALERT，下次 open 自愈 | `cc-worker.ts` |
| 6 | root 节点找不到降权用户 → 自检 `self_test_failed: no_unprivileged_user`（`CC_WORKER_ALLOW_ROOT=1` 才放行） | `selfTest` |

**未执行的验证**：需要 root 的真实属主测试块（trust-seed、team-uid、account-files / device-identity 的属主部分）在开发机（uid 1000）全部跳过，属主逻辑只经 chown 调用的 spy 验证。**上线前必须在一台 root 机器上跑 `pnpm --filter @1dayapi/provider-node test`。**

## 4b. 充值额度（usage credits）感知（分支提交 d9ccdab … 04193dc）

详见 `usage-credits.md`。从已采集的 `accounts.usage_json` 解析充值额度状态与 Fable 周份额（`packages/core/src/usage-credits.ts`）；新设置 `usage_credits_policy`（`off` 默认 / `fable_only` / `all`）：开启后有可用额度的账号在限额用尽时仍可调度，排在有套餐额度的账号之后，上游拒绝后要等下一次用量巡检确认才恢复；console shapes 与管理端 / 供给方账号页、设置页已展示。
2026-11-10 生产 62 个账号全部未开通、不可自购，**已开通形态为推断**，开启策略前须按 `usage-credits.md` §5 用第一个真实开通账号核对。走额度的请求按 API 价扣账号所有者的钱，平台尚不单独记账（开放项）。

## 5. 合并与上线清单

集成分支 `hardening-2026-11-10`（基于 39cbc48，五个分支无冲突合并 + 三个集成提交）。`pnpm gate`：**846 通过 / 0 失败 / 0 已知失败**（catalog 6、core 168、gateway 376、console 118、e2e 178；e2e 在仅回环的网络命名空间内运行）。provider-node 的 root 属主测试已在主服务器以 root 运行（`team-uid` 因夹具问题仍失败，改动前相同）。**2026-11-10 06:52–07:04Z 已发布**（X-50，记录见 `deployment/2026-11-10-hardening-release.md`）；§5.2 第 5–8 步的服务器侧运维步骤尚未执行。

### 5.0 上线后的行为变化（发布说明必须包含）

- 计费：客户端中途断开的流按已转发内容估算 output（以前约 1 token）；流内上游先报错、客户端随后断开的改为零费用失败行。
- 客户可见：连续同类上游失败时原样返回上游状态码与错误体（529 / 500 / 429），不再是统一 502 文案；查看 / 复制 API Key 需登录 10 分钟内或再输登录密钥（前端已做输入提示）。
- 账号处置：直连 401/403 与 worker 的引用文本信号要 10 分钟内 3 次才停用账号；团队账号的设备 ID 漂移改为自愈 + 告警，网关日志不再出现 `fixed team device identity changed`（监控改看 `ALERT device identity drift` / `ALERT device identity mismatch`）。
- **非团队账号也会被改回平台登记的设备 ID**：发布前 `ops/bin/device-identity-check` 必须全部一致，否则不一致的账号在上线后第一次 open 会被改写一次。
- root 节点必须有降权用户（`ccworker` 或 `CC_WORKER_USER`），否则节点拒绝全部会话；mirasim 自有节点需先核对。
- 运维：`/health` 不再带计数器（脚本经 `ops/bin/gateway-counters` 读 `/internal/metrics`）；删除节点 / 用户可能 409 需 force；供应商启用账号可能 403 `disabled_by_platform`（存量无审计记录的需 admin 启用一次）；节点重绑需当前密钥；`dead-letter/` 里的金额行未入账，需人工移回重放。
- nginx（服务器上手工改）：console 的 server 块加 `location ^~ /internal/tunnel/ { return 404; }`，并确认 `/internal/metrics` 不对外。


### 5.1 调用点（集成提交 40d9ab5、及其后一个提交已加）

```ts
// apps/gateway/src/index.ts —— import core 之后、listen 之前
import { verifyMasterKey } from "@1dayapi/core";
verifyMasterKey();

// apps/console/src/app.ts —— buildApp() 里 ensureInitialAdmin(...) 之前（或 apps/console/src/index.ts 的 listen 之前）
import { verifyMasterKey } from "@1dayapi/core";
verifyMasterKey();
```

`verifyMasterKey()` 同步、无参数、自己开一个短连接读写 `settings`；不符时抛 `MasterKeyError`，不要捕获，让进程以非零退出。
前端：`apps/web/src/console/pages/user/Keys.tsx` 的 `reveal()` 与复制路径处理 403 `reauth_required`（弹出登录密钥输入 → `POST …/reveal {loginKey}`）、403 `reauth_failed`、429 `reveal_rate_limited`。

### 5.2 运维步骤（按此顺序；每步都可单独回退）

1. **合并后、发布前**：`pnpm gate` 通过。
2. **首次带主密钥守卫发布**：确认两个服务的 `DATA_DIR` 下 `provider-cred.key` 存在且就是库对应的那把（现网一直在用即可）；启动日志应出现一次
   `[core/crypto] master key check value recorded`，之后每次启动无此行、无告警。若出现 `MasterKeyError`，**不要**设 `ALLOW_NEW_MASTER_KEY=1`，先查 `DATA_DIR` 与密钥文件。
3. **Key 查看**：发布说明里告知用户「查看 / 复制 API Key 需在登录后 10 分钟内，或重新输入登录密钥」；前端跟进前这是可见的行为变化。
4. **网关切换**：`ops/bin/gateway-switch` 现在需要 `/root/monitor/apikey.txt` 可读且该 Key 能出 200；风险发布用 `--hold 600`。`ops/bin/harden-2026-11-01.sh deprivilege-apply` 内部调用它，同样受探针约束。
5. **备份切换**：`docs/operations.md` §5.1 的六步（离线生成 age 密钥对 → 装 `age` 与公钥 → 手工跑通并做一次恢复演练 → 把密钥包拷出服务器 → 换 unit → 7 天后清理明文旧包）；同时按同节收紧两机 `authorized_keys`。
6. **journald**：量日志量 → 安装 `ops/systemd/journald-1dayapi.conf` → `systemctl restart systemd-journald` → 两周后看 `health-extra` 的跨度。
7. **发布目录**：从阶段 0 开始（每次发布前 `ops/bin/release-build <提交>` 只做验证）；阶段 1–3 另排维护窗口（§4.2）。
8. **每月**：`ops/bin/backup-restore-test`，输出贴进运维记录（§5.3）。

### 5.3 开放项

| 项 | 说明 | 建议归属 |
|---|---|---|
| import 时迁移 | `docs/operations.md` §4.3 | core + gateway + console |
| 主密钥轮换工具 | 需要对全部 `*_enc` 列重加密并更新校验值 | core |
| 前端重新认证 | 已用 `window.prompt` 实现输入登录密钥；可换成正式弹窗 | web |
| worker-01 备份加密 | 套用同一把 `age` 公钥 | ops |
| 指标与集中日志 | 仍然没有；`health-extra` 只是巡检 | ops |
| 充值额度的费用归属 | 走额度的请求不单独记账、不进结算；是否调整分成、是否按账号授权 | 产品 |
| 用量巡检新鲜度 | 冷却中的账号不重探，被拒后不会自动恢复走额度（`ccr/window-poll.ts`） | console |
| 号商分成与分组倍率、缓存写入分档计费 | 评审 core #7 / #8，属定价规则，未改 | 产品 |
| 会话归属变更的客户合同 | 仍返回 200 的 RESET_NOTICE，建议改为真正的 409 | gateway |
| 流无终止事件但客户端在线 | 仍按上游失败零费用处理 | gateway |
| 较低优先项 | TUI kill 只到 shim、驱逐停泊中的工具轮、重连帧乱序、转写 / cwd 清理、主机名与沙箱路径、console 开隧道的全池解密 | 各自模块 |
