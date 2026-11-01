import { all, one, run, tx } from "./db.js";

// docs/v3-design.md §3.1
export const SETTING_DEFAULTS = {
  default_group_id: "default",
  provider_default_payout_rate: "0.6",
  announcement: "",
  api_base_url: "https://api.1dayapi.com",
  // 控制台/内部端点（节点 WS、bundle 下载）的公网 base。api_base_url 是推理网关，
  // 两者不能混用（网关 vhost 不代理 /internal/）。
  console_base_url: "https://1dayapi.com",
  max_keys_per_user: "50",
  // Anthropic 订阅窗口调度（docs/gateway.md §3、ccr-supply.md §7，仿 sub2api account_scheduling_threshold）：
  // 绑定窗口用量 ≥ 阈值百分比即停调到窗口重置；100 = 关闭。巡检间隔（秒）；粘性会话 TTL（秒）。
  anthropic_window_threshold_percent: "95",
  window_poll_interval_sec: "300",
  // 主动 usage 探测只兜底：被动采样（每个网关响应头）为主，账号超过此秒数没有任何采样才探一次（默认 6h，最小 600）。
  window_passive_max_age_sec: "21600",
  // 5h 窗口用尽/被拒后的冷静期（docs/gateway.md §3）：窗口重置时刻再加 [min,max] 秒的随机值才重新调度，
  // 避免一到重置点就立刻打满（用户 2026-10-17 要求 1h45m～2h05m）。
  window_rest_min_sec: "6300",
  window_rest_max_sec: "7500",
  sticky_session_ttl_sec: "1800",
  // 设备亲和（docs/gateway.md §3）：同一客户端设备（metadata.user_id 的 device_id）最近用过的账号优先，
  // 最多记 N 个（0 = 关闭），TTL 秒。目的：一个账号少见多台机器 / 多个 CC 版本，被迫换号的会话也落在熟悉的账号上。
  device_affinity_pool_size: "3",
  device_affinity_ttl_sec: "7200",
  // Claude Code 形态判定（docs/gateway.md §2a）：带 CC UA 但形态不合规的请求怎么处理。
  // observe = 只记录（默认，基线观察）；downgrade = 按非 CC 客户端路由（走 ccr/worker，不碰订阅号直连）；reject = 400。
  cc_shape_policy: "observe",
  // 上号落库的订阅账号默认执行器（docs/onboarding.md）：ccr_worker = 节点上真 Claude Code；ccr = 云端会话。
  onboard_default_executor: "ccr_worker",
  // 上号落库账号的默认并发 / RPM 上限（上号表单留空或填 0 时采用；0 = 不限需事后在账号里改）。用户 2026-10-16 定：9 / 100。
  onboard_default_concurrency: "9",
  onboard_default_rpm_limit: "100",
  // 新上号账号冷静期（用户 2026-10-20 定，同日加长为 62～70 分钟：授权完成后随机取值，期间不参与调度）。
  // 落库时写 temp_unschedulable_until；两个都为 0 = 关闭。
  onboard_cooldown_min_sec: "3720",
  onboard_cooldown_max_sec: "4200",
  // 代理释放冷静期（用户 2026-10-20 定）：删除一个被上游拒绝的账号（status=error：401 吊销、on hold 等）时，
  // 其代理释放后 24 小时内不分配给新上号的账号（node_proxies.cooldown_until）。0 = 关闭。
  proxy_release_cooldown_sec: "86400",
  // 直连路径的「一账号一软件」（docs/gateway.md §3，用户 2026-10-20 定）：
  // direct_cc_entrypoint_normalize=1 → UA 里不是真实 Claude Code 入口（cli / sdk-cli / sdk-ts / sdk-py / claude-vscode / claude-desktop…）
  //   的后缀（如 "(external, mirasim)"）改成 "(external, cli)"，计费头的 cc_entrypoint 同步；0 = 原样透传。
  // direct_cc_version_pin = 直连 UA / 计费头 cc_version / stainless 包版本统一成这个 Claude Code 版本（与节点 worker 一致）；空 = 透传客户版本。
  direct_cc_entrypoint_normalize: "1",
  direct_cc_version_pin: "2.1.312",
  // CCR 路径（worker / 云端会话）客户可见缓存 = 上游缓存 − 身份上下文基线（docs/ccr-supply.md §7.1）。
  // 基线 = 真 Claude Code 系统提示词 + 工具集的 token 数，按执行模式实测（worker 2026-10-16：16608–16777）；0 = 上游缓存全额计给客户。
  ccr_cache_baseline_worker: "16600",
  ccr_cache_baseline_cloud: "28000",
  // CCR 路径的提示词缓存是本平台强加的（Claude Code 自动打 cache_control），客户并未要求：
  // "1" = 超出基线的 cache_creation 按普通输入计（1.0×，不收 1.25× 写入溢价），cache_read 仍按读价（0.1×）让利给客户；
  // "0" = 原样透传上游口径（写 1.25× / 读 0.1×）。2026-10-17 用户拍板默认 1。
  ccr_cache_write_as_input: "1",
  // 缓存重建返还（docs/data-model.md §3 cache_refunds，用户 2026-10-21 定）：粘性会话被迫换账号的请求
  // （usage_logs.account_switched=1）多付的缓存费（实付 − 全部提示词按缓存读价的理论价）按百分比返还：
  // 先冲减授信已用（消耗的是授信就还到授信），余下加到预付余额；console 定时任务每 interval 秒跑一轮。
  // enabled=0 只停自动跑，管理员仍可手动触发；percent 0 = 只标记不返钱。
  cache_refund_enabled: "1",
  cache_refund_percent: "80",
  cache_refund_interval_sec: "86400",
  // worker 持久会话（docs/worker-sessions.md）：1 = 同一对话复用节点上的常驻 claude 进程（增量喂入）；0 = 每请求一个进程。
  ccr_worker_persistent: "0",
  // worker 原生工具（docs/worker-sessions.md §3）：1 = 客户工具经节点 MCP 服务原生调用（需持久会话）；0 = prompt 级围栏模拟。
  ccr_worker_native_tools: "0",
} as const;

export type SettingKey = keyof typeof SETTING_DEFAULTS;
export const SETTING_KEYS = Object.keys(SETTING_DEFAULTS) as SettingKey[];

export function getSettings(): Record<SettingKey, string> {
  const out: Record<string, string> = { ...SETTING_DEFAULTS };
  for (const r of all<{ key: string; value: string }>("SELECT key, value FROM settings")) {
    if (r.key in SETTING_DEFAULTS) out[r.key] = r.value;
  }
  return out as Record<SettingKey, string>;
}

export function getSetting(key: SettingKey): string {
  return getSettings()[key];
}

export function setSetting(key: SettingKey, value: string): void {
  run(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    key,
    value,
  );
}

const SETTINGS_REVISION_KEY = "__revision__";

export function settingsRevision(): number {
  const row = one<{ value: string }>("SELECT value FROM settings WHERE key = ?", SETTINGS_REVISION_KEY);
  const revision = Number(row?.value ?? 1);
  return Number.isSafeInteger(revision) && revision >= 1 ? revision : 1;
}

export class SettingsRevisionConflict extends Error {
  constructor(public readonly actual: number) {
    super(`settings revision conflict: current revision is ${actual}`);
    this.name = "SettingsRevisionConflict";
  }
}

/** Atomically validate and apply one settings document; no key-by-key lost updates. */
export function updateSettings(values: Partial<Record<SettingKey, string>>, expectedRevision: number): number {
  return tx(() => {
    const current = settingsRevision();
    if (current !== expectedRevision) throw new SettingsRevisionConflict(current);
    for (const [key, value] of Object.entries(values)) setSetting(key as SettingKey, value);
    const next = current + 1;
    run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", SETTINGS_REVISION_KEY, String(next));
    return next;
  });
}
