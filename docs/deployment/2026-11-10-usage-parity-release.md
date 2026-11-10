# 用量与官方对齐发布（X-51 / X-53 – X-57）：发布记录（2026-11-10）

时间均为 UTC。最终提交 `0041de5`（main；基于 X-50 发布的 `84878d4`）。内容：
X-51 缓存写入分档（5 分钟 1.25× / 1 小时 2×）与官方同形的 `usage`；X-52 默认在途限额的代码默认值；X-53 TUI 节点上带图片 / PDF 的轮次改走非交互进程；
X-54 worker 通道扣除平台提示词开销（按键校准，迁移 43）；X-55 准入被拒（429 `user_inflight_limit`）可见；X-56 canonical 续接不再丢掉会话没见过的轮次；
X-57 缓存写入只在客户自己带 `cache_control` 时单列，档位按客户要求的 TTL。

## 发布前

- 本地与服务器（`ops/bin/release-build`）`pnpm gate`：最终 **944 通过 / 0 失败**（catalog 8、core 197、gateway 419、console 132、e2e 188；e2e 在仅回环的网络命名空间内）。
- 节点测试以 root 在主服务器运行：trust-seed、account-files、device-identity、media-plain、cc-worker、team-isolation 通过。
- X-53 的假上游探针（`probe2.ts`，Claude Code 2.1.319 与 2.1.322，线上启动参数与线上垫片）：TUI 文本开场 → 非交互进程 `--resume` 并带图片 + PDF → 再回 TUI，上游请求里三轮与两种媒体俱在。
- `ops/bin/device-identity-check --save /root/monitor/device-baseline-20261110T091321Z.txt`：74 / 74 一致；无进行中的上号作业；`settings` 里没有 `ccr_cache_write_as_input` / `ccr_overhead_calibration` 的覆盖行。
- 备份：`data/backups/1dayapi.db.pre-x51-20261110T091321Z.bak`、`backups/pre-x51-20261110T091321Z-dist.tgz`；各节点 `/root/node-bundle.bak-pre-x53-<unit>.js`、`/root/claude-json-pre-x53-<unit>.tgz`。

## 步骤

| 时间 | 步骤 | 结果 |
|---|---|---|
| 09:13 | ff-merge `6b32b37`，同步 dist，重启 console | 迁移 41 / 42 / 43 应用；三节点 2 秒内重连 |
| 09:15 | `gateway-switch` → 8400（`6b32b37`） | 切换前探针 200 |
| 09:16 | 实测一句话请求 | `input 2, cache_creation 94 (1h)`：客户没要求缓存却被记了缓存写入 → 当场补 X-57 |
| 09:31 | `8ad1206`（X-57 第一步）→ `gateway-switch` → 8402 | 一句话请求 `input 112`，无缓存写入 |
| 09:36–09:38 | 节点包 `7978da96…`：worker-02 → ccr-tui → worker-01（`/root/node-roll2.sh`） | 每台之后 `device-identity-check` 74 / 74；spawn_failed 0，身份告警 0；ccr-tui 重启后 21 次启动 0 失败，2 个媒体轮次走了非交互进程 |
| 09:39 | `0041de5`（X-57 档位按客户 TTL）→ `gateway-switch` → 8400 | 切换前探针 200 |
| 09:41 | `ops/bin/release-verify` | 第 1、2、4、5、6 步通过；第 3 步 online 72 < 基线 73（1 个账号处于正常冷却，`/api/pool`：online 72 / cooling 1 / error 1；active 账号数仍是 73）→ 脚本报 NOT VERIFIED，判定与本次发布无关 |

## 发布后实测（测试 Key，线上）

| 请求 | 结果 |
|---|---|
| PDF 文档块 × 3（问 PDF 里印的随机码） | 3 / 3 答对，HTTP 200，约 4.5–4.9 s；`input ≈1562` |
| 图片块（纯色 PNG，问颜色） | 答对，HTTP 200 |
| 一句话、不带 `cache_control`（claude-opus-5-5） | `input 7, output 4`，缓存读写 0（当天上午同类请求是 `cache_read ≈29,000`） |
| 约 2.4k token、带默认 `cache_control` | `input 2, cache_creation 1887`，全部在 5 分钟档 |

## 回滚

- 网关：`ops/bin/gateway-switch --rollback`（排空期内）；之后需先恢复 `backups/pre-x51-…-dist.tgz` 再切。
- console：解包同一 dist 备份后重启。迁移 41–43 只加列 / 加表，旧代码不读，可保留。
- 节点：各节点 `/root/node-roll2.sh <unit> <app-dir> rollback`。
- 行为开关：`ccr_cache_write_as_input=1`（缓存写入全部并入输入）、`ccr_overhead_calibration=off`（只用内置默认与旧基线）。

## 已知与待跟进

- X-54 的开销是学出来的：各键在攒够小请求样本前用内置默认值（TUI ≈ 29,000 / 带工具 ≈ 3,900 / `-p` ≈ 12,200），不同账号间有几百 token 的出入；管理端设置页的「平台开销」表可看每个键的取值与来源。
- TUI 节点的容量：Tokway 反馈的 8 个首字卡住请求（08:13–08:14Z）全部落在 ccr-tui 的全新会话上，45 秒无首字后客户端断开；该分钟 ccr-tui 有 32 次启动，12 核负载 5–7。交互式进程启动和空闲都吃 CPU（X-48 已记录每 12 核约 40–50 会话），容量上限尚未按 CPU 定。
- Tokway 的「只走直连」：其请求被判为非真 Claude Code 形态（`cc_shape` 空 / suspect），开 `directOnly` 会让几乎全部请求变 400；是否开由运营方与客户确认。
- `release-verify` 第 3 步的基线只升不降，账号正常冷却就会误报；可改为与发布前快照比较。
- 参考项目的新垫片（`20261110.6a253f8`，主服务器 `/root/shim-build/`）未部署。
