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
  // 每个实测出口 IP 最多承载的订阅账号数（2026-11-01 起可配，此前写死 3；team-isolation.md "固定代理与容量"）。
  // 自动分配仍"先铺开"（每个出口先各一个）。1～10。
  proxy_exit_max_accounts: "3",
  // 组织出口认领的最短保留天数（2026-11-01，team-isolation.md）：组织下已无账号、无在途上号且最近一次账号释放距今 ≥ N 天，
  // 管理员才能"释放认领"让该出口回到可被其他组织发现/认领的状态；0 = 随时可释放（仍需手动）。
  team_claim_release_min_days: "7",
  // 代理释放冷静期（用户 2026-10-20 定）：删除一个被上游拒绝的账号（status=error：401 吊销、on hold 等）时，
  // 其代理释放后 24 小时内不分配给新上号的账号（node_proxies.cooldown_until）。0 = 关闭。
  proxy_release_cooldown_sec: "86400",
  // 直连路径的「一账号一软件」（docs/gateway.md §3，用户 2026-10-20 定）：
  // direct_cc_entrypoint_normalize=1 → UA 里不是真实 Claude Code 入口（cli / sdk-cli / sdk-ts / sdk-py / claude-vscode / claude-desktop…）
  //   的后缀（如 "(external, mirasim)"）改成 "(external, cli)"，计费头的 cc_entrypoint 同步；0 = 原样透传。
  // direct_cc_version_pin = 直连 UA / 计费头 cc_version / stainless 包版本统一成这个 Claude Code 版本（与节点 worker 一致）；空 = 透传客户版本。
  // 2026-11-01 起三态开关（"0" | "canary" | "1"，core/canary.ts）；默认 "0" = 封禁前的老行为（硬拒自定义入口 → worker）。
  direct_cc_entrypoint_normalize: "0",
  // ---- 灰度（铁律 2，CLAUDE.md）：上游可见的改动一律三态开关，默认老行为 ----
  // 灰度测试账号组（groups.id）。Key 属于该组、或被选中的账号属于该组的请求，才吃到 "canary" 档的开关。空 = 没有灰度组（"canary" 等于关）。
  canary_group_id: "",
  // 直连删掉客户 Claude Code 自带的 `# userEmail` system-reminder（2026-11-01 审计 A4）。
  direct_strip_user_email: "0",
  // 直连按真实 2.1.312 客户端对齐细节：补 oauth beta 时插到 claude-code 之后而非末尾；metadata.user_id 重建为 device_id, account_uuid, session_id 顺序。
  direct_cc_canonical_fields: "0",
  // worker 系统提示词里不出现平台路径 /var/lib/1dayapi-cc-worker（审计 A1）。
  worker_prompt_hide_platform_path: "0",
  // Key 没显式配置 historyPolicy 时的默认值（reset | reject | passthrough）；history_policy_canary 非空时灰度组的 Key 用它。
  history_policy_default: "reset",
  history_policy_canary: "",
  // Key 没显式配置 workerMode 时的默认值（legacy | canonical）。2026-11-05 用户定：全部 Key 默认 canonical（真 CC 直连不受影响）；
  // 账号所在节点没有 canonical_v1 能力时，网关把该轮交给同账号的 legacy worker（canonical_node_unavailable 回落）。
  worker_mode_default: "legacy",
  // 充值额度（usage credits，docs/usage-credits.md）：账号主开通后，5h / 周 / Fable 周额度用尽的请求按 API 价从其充值额度扣费继续可用。
  // off = 不利用（默认，用尽即停调到重置，与此前完全一致）；fable_only = 仅 Fable 周额度用尽的账号继续调度 Fable；all = 5h / 周窗口用尽也继续调度。
  // 注意：走充值额度的请求按 API 价（Fable 约 $10 / $50 每百万 token 入 / 出）计到账号主的付款方式。
  usage_credits_policy: "off",
  // 代理(出口 IP) ↔ 组织 绑定校验：1 = 一个出口只许一个组织（other_organization / needs_virgin_exit，运行时 registry 与节点
  // getPinned 同样强制）；0 = 取消该绑定校验（2026-11-06 用户定），只按账号 ↔ 代理 的绑定放行，容量上限(exitCap)与死/隔离/冷却仍生效。
  proxy_org_binding_enforce: "1",
  // 授权失败后是否隔离(冻结)出口：1 = 上游判定类失败(EXIT_TAINTING_CODES)隔离出口并把代理标 dead；0 = 只释放槽位、不隔离
  // （2026-11-06 用户定："事实证明没什么作用"，且误杀过健康出口）。观测到的出口容量超限仍隔离。
  proxy_quarantine_on_failure: "1",
  // 代理事件是否冻结账号（status proxy_down）：1 = 代理 dead / 出口变化 / 隔离 / 节点无代理时冻结其上账号（2026-11-01 铁律）；
  // 0 = 不冻结（2026-11-06 用户定），调度门 boundProxyDown 照常跳过代理不可用的账号，代理恢复即自动回到调度。
  account_freeze_on_proxy: "1",
  // ---- canonical 实施（docs/canonical-implementation-spec-2026-11-01.md WP1 / WP5 / WP8），全部三态，默认老行为 ----
  // 车道 A profile 严格模式：开 → 直连不再跨版本 pin（忽略 direct_cc_version_pin，客户版本必须有已采样 profile，否则按
  // cc_shape_policy 当 suspect 处理，missing=cc_profile_unknown）；归一化之后再过一遍形态 gate 并断言 profile 不变，
  // 不 genuine → 400 cc_profile_mismatch（上游不会收到混拼体）。上游可见（版本不再被改写）。
  direct_profile_strict: "0",
  // 真 Claude Code 客户的下游响应 profile：开 → 不向 CC UA 的客户下发 x-1day-* 诊断头（request-id / retry-after 保留）。
  cc_client_response_profile: "0",
  // Key 策略判断器（spec §6.2）：0 = 只记录建议（auto 层写入但不生效）；canary = 灰度组 Key 生效；1 = 全部生效。
  key_policy_auto: "0",
  // 车道 B canonical 进程（spec WP2）总闸：开 → Key 生效 workerMode=canonical 的非直连请求由节点官方 Claude Code 以原生身份执行
  // （--restricted、caller MCP、原生 session、追加式客户 system；不折叠历史、不替换主提示词）；节点需 CC_WORKER_CANONICAL=1。上游可见。
  worker_canonical: "0",
  // 遥测证据（spec §6.4 / WP6）：native-required 的 Key 开 canonical 会话前，账号 × profile 的证据等级必须 ≥ secondary，
  // 否则跳过该账号（计 native_telemetry_unverified_total；无合格账号 → 503 native_telemetry_unverified）。
  // 0 = 不要求（观察期：让健康天数先累积）；canary；1。secondary = profile 有 controlled 结构证据 + 账号连续 telemetry_health_days 天健康。
  // canonical 外部历史导入（spec WP3 / G3）：开 → 带着外部多轮历史的 canonical 新会话由网关按 Claude Code transcript 格式构造
  // （剥掉 thinking：G3 证明零校验、真上游会 400）、节点写入后 --resume；关 → 409 history_import_unsupported。上游可见（导入的历史会上行）。
  canonical_history_import: "0",
  // canonical 对真 Claude Code 客户的兼容修补（2026-11-08，X-42），三件事一起灰度：
  // ① 活轮尾部的 role:system 消息（2.1.31x 的 # Environment / 环境更新 / 任务通知）当活轮尾巴（文本块跟在用户块之后），不再当外部历史
  //    判 history_import_unsupported 回落 legacy（11-08：首轮走 legacy、第 2 轮切回 canonical 的车道翻转由此而来）；
  // ② 客户带 tools 的会话以 tools-disabled-canonical 档启动（--restricted --tools ""），节点 CC 自带的 Read/Glob/Grep 不再与客户同名工具并存
  //    （11-08：模型拿内建 Read 去读 Windows 客户的 F:\ 路径，内建轮次被翻译层吞掉，客户只看到"我在 Linux 沙箱里读不到"）；
  // ③ 加强版环境说明 CANONICAL_ENV_NOTE_V2（内建工具只见沙箱、不因沙箱看不到就断定路径不存在、不复述沙箱路径）。
  // 关 → 老行为。上游可见（更多首轮进 canonical；带工具会话的 tools 列表少了内建工具；追加 system 文本变化）。
  canonical_cc_client_compat: "0",
  // canonical 渲染导入（方案 A，2026-11-09）：原生 transcript 接不住的历史——停在工具轮中间的会话、半路到达的会话、原会话已失——
  // 不再回落 legacy，而是把整段对话按 legacy 的折叠格式渲染成**新原生会话的第一条用户消息**（magpie renderClaudePrompt 做法），
  // 之后的工具轮在这条活会话上原生续。关 → 老行为（history_import_unsupported → legacy）。上游可见（这些轮次改走 canonical 进程）。
  canonical_rendered_import: "0",
  // 渲染导入的折叠字符上限：超过则仍按 history_import_unsupported 回落 legacy（TUI 粘贴 / stdin 的安全边界）。11-09 实测：
  // 成功渲染的会话 32–53 万字符；仍回落的 22 次全是 61–101 万字符（321–462 条消息）的 Agent SDK 会话。
  canonical_rendered_import_max_chars: "600000",
  // 关掉 canonical→legacy 回落（legacy 退场第一步，2026-11-09）：0 = 照旧回落；canary = 灰度组 Key / 账号的 canonical 拒绝原样回客户端
  //（409/400 带原因），不再悄悄跑 legacy -p——TUI 稳定性测试要的就是"失败可见"；1 = 全站不回落。
  canonical_no_legacy_fallback: "0",
  // raw-v1（spec WP5.4）：原样透传账号的请求到节点出口也不补 Claude Code 指纹头（preserveHeaders）。默认 0 = 节点照旧补齐。上游可见。
  raw_preserve_headers: "0",
  telemetry_evidence_required: "0",
  telemetry_health_days: "7",
  direct_cc_version_pin: "2.1.312",
  // CCR 路径（worker / 云端会话）客户可见缓存 = 上游缓存 − 身份上下文基线（docs/ccr-supply.md §7.1）。
  // 基线 = 真 Claude Code 系统提示词 + 工具集的 token 数，按执行模式实测（worker 2026-10-16：16608–16777）；0 = 上游缓存全额计给客户。
  ccr_cache_baseline_worker: "16600",
  ccr_cache_baseline_cloud: "28000",
  // CCR 路径的提示词缓存是本平台强加的（Claude Code 自动打 cache_control），客户并未要求：
  // "1" = 超出基线的 cache_creation 按普通输入计（1.0×，不收 1.25× 写入溢价），cache_read 仍按读价（0.1×）让利给客户；
  // "0" = 原样透传上游口径（写 1.25× / 读 0.1×）。2026-10-17 用户拍板默认 1。
  ccr_cache_write_as_input: "1",
  // worker 路径抓样（2026-11-03，gateway ccr/capture.ts）：按比例把「客户请求 → 发给节点的内容 → 返回」记成 NDJSON
  // （<DATA_DIR>/captures/worker-<日期>.ndjson），用 ops/bin/worker-capture-review 看 worker 回的是不是用户要的东西。
  // worker_capture_sample：0 = 关；0.05 = 5%；1 = 全部。worker_capture_keys：逗号分隔的 api_keys.id（或前缀），这些 Key 100% 抓。
  worker_capture_sample: "0",
  worker_capture_keys: "",
  worker_capture_keep_days: "7",
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
