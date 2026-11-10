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

## 2. gateway

**由对应分支补充**（计数器从 `/health` 迁到带令牌的 `/internal/metrics`、`packages/core/src/oauth.ts`、`settlement-journal.ts` 等）。

| # | 问题 | 风险 | 改动 | 位置 | 验证 | 需跟进 |
|---|---|---|---|---|---|---|
| | | | | | | |

## 3. console

**由对应分支补充**（`apps/console` 除 `routes/user.ts` 以外的部分）。

| # | 问题 | 风险 | 改动 | 位置 | 验证 | 需跟进 |
|---|---|---|---|---|---|---|
| | | | | | | |

## 4. provider-node

**由对应分支补充**。

| # | 问题 | 风险 | 改动 | 位置 | 验证 | 需跟进 |
|---|---|---|---|---|---|---|
| | | | | | | |

## 5. 合并与上线清单

### 5.1 其他分支需要加的调用点

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
| 前端重新认证弹窗 | §5.1 | web |
| worker-01 备份加密 | 套用同一把 `age` 公钥 | ops |
| 指标与集中日志 | 仍然没有；`health-extra` 只是巡检 | ops |
| `unit/console: test/audit-fixes.test.mjs` | 测试结束后仍有定时器访问已关闭的库 | console |
