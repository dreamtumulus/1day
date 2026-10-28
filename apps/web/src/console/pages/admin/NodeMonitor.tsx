import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { TerminalIcon } from "../../../components/Icon";
import { api, type NodeMonitorRow } from "../../api";
import { useCT } from "../../i18n";
import { NodeTabs } from "./Nodes";
import { Async, Badge, EmptyState, PageHeader, StatCard, fmtDateTime, fmtNum, fmtUsd, useAsync, useRelTime, type Tone } from "../../ui";

// Node monitor (docs/operations.md §7.2): one card per node built from the latest
// heartbeat snapshot plus platform-side facts. Layout: identity + health header,
// six gauges (memory, load, sessions, accounts, proxies, in flight) with
// threshold-coloured bars, then a traffic strip. Refreshes every 15 s.

const REFRESH_MS = 15_000;

function health(n: NodeMonitorRow): { tone: "success" | "warning" | "error" | "neutral"; key: string } {
  if (!n.online) return { tone: "error", key: "offline" };
  if (n.heartbeatAgeSec != null && n.heartbeatAgeSec > 90) return { tone: "warning", key: "stale" };
  if (n.metrics?.host?.draining) return { tone: "warning", key: "draining" };
  if (!n.acceptingSessions) return { tone: "warning", key: "notAccepting" };
  if (n.metrics?.ccWorker && n.metrics.ccWorker.enabled === false) return { tone: "warning", key: "workerDisabled" };
  const host = n.metrics?.host;
  if (host && host.totalMemMb > 0 && 1 - host.freeMemMb / host.totalMemMb > 0.85) return { tone: "warning", key: "memHigh" };
  return { tone: "success", key: "healthy" };
}

function fmtUptime(sec: number | null | undefined): string {
  if (sec == null) return "—";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

const toneColor: Record<Tone, string> = {
  neutral: "var(--on-surface-faint)",
  primary: "var(--primary)",
  success: "var(--success)",
  warning: "var(--warning)",
  error: "var(--error)",
  info: "var(--info)",
};

/** Bar colour by fill ratio: ≥90% red, ≥75% amber, else the given base tone. */
function fillTone(ratio: number, base: Tone = "primary"): Tone {
  if (ratio >= 0.9) return "error";
  if (ratio >= 0.75) return "warning";
  return base;
}

function Gauge({
  label,
  value,
  unit,
  sub,
  ratio,
  tone,
  muted,
}: {
  label: ReactNode;
  value: ReactNode;
  unit?: ReactNode;
  sub?: ReactNode;
  /** 0..1 bar fill; undefined = no bar */
  ratio?: number;
  tone?: Tone;
  muted?: boolean;
}) {
  const t = tone ?? (ratio == null ? "neutral" : fillTone(ratio));
  const pct = ratio == null ? 0 : Math.max(0, Math.min(100, ratio * 100));
  return (
    <div className={`min-w-0 px-4 py-3 ${muted ? "opacity-60" : ""}`}>
      <div className="flex items-center justify-between gap-2 text-[11px] font-medium uppercase tracking-[0.08em] text-on-surface-faint">
        <span className="truncate">{label}</span>
        {ratio != null && (
          <span className="font-mono normal-case tracking-normal" style={{ color: toneColor[t] }}>
            {Math.round(pct)}%
          </span>
        )}
      </div>
      <div className="mt-1 truncate font-display text-[20px] font-bold tabular-nums tracking-[-0.02em] text-on-surface">
        {value}
        {unit && <span className="ml-1 text-[13px] font-medium text-on-surface-faint">{unit}</span>}
      </div>
      {ratio != null && (
        <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-pill" style={{ background: "var(--surface-variant)" }}>
          <div className="h-full rounded-pill transition-all" style={{ width: `${pct}%`, background: toneColor[t] }} />
        </div>
      )}
      {sub && <div className="mt-1 break-words text-[11.5px] leading-snug text-on-surface-faint">{sub}</div>}
    </div>
  );
}

function Figure({ label, value, sub, tone }: { label: ReactNode; value: ReactNode; sub?: ReactNode; tone?: Tone }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-on-surface-faint">{label}</div>
      <div className="mt-0.5 font-mono text-[15px] font-semibold tabular-nums text-on-surface" style={tone ? { color: toneColor[tone] } : undefined}>
        {value}
      </div>
      {sub && <div className="text-[11.5px] text-on-surface-faint">{sub}</div>}
    </div>
  );
}

function Chip({ k, v }: { k: string; v: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 font-mono text-[11.5px]" style={{ background: "var(--surface-variant)", color: "var(--on-surface-variant)" }}>
      <span className="text-on-surface-faint">{k}</span>
      <span className="text-on-surface">{v}</span>
    </span>
  );
}

function NodeMonitorCard({ n }: { n: NodeMonitorRow }) {
  const { t } = useCT();
  const rel = useRelTime();
  const h = health(n);
  const host = n.metrics?.host ?? null;
  const cw = n.metrics?.ccWorker ?? null;
  const p = cw?.pool ?? null;
  const memUsed = host ? host.totalMemMb - host.freeMemMb : 0;
  const memRatio = host && host.totalMemMb > 0 ? memUsed / host.totalMemMb : undefined;
  const loadRatio = host && host.cpus > 0 ? host.load1 / host.cpus : undefined;
  const errRate1h = n.traffic.req1h > 0 ? n.traffic.err1h / n.traffic.req1h : 0;
  const errRate24h = n.traffic.req24h > 0 ? n.traffic.err24h / n.traffic.req24h : 0;
  const name = n.name || n.providerName || n.nodeId.slice(0, 16);
  const dot = n.online ? toneColor[h.tone] : "var(--on-surface-faint)";
  const liveProxyGap = n.accounts.active - n.accounts.onLiveProxy;

  return (
    <section
      className="card flex flex-col overflow-hidden"
      style={h.tone === "error" || h.tone === "warning" ? { borderColor: `color-mix(in oklab, ${toneColor[h.tone]} 45%, var(--outline-variant))` } : undefined}
    >
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-5 pb-3 pt-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="relative mt-[7px] inline-flex h-2.5 w-2.5 shrink-0">
            {n.online && h.tone === "success" && <span className="wk-live-dot absolute inline-flex h-full w-full rounded-full" style={{ background: dot, opacity: 0.6, transform: "scale(1.9)" }} />}
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full" style={{ background: dot }} />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h3 className="truncate font-display text-[16px] font-semibold tracking-[-0.01em] text-on-surface" title={n.nodeId}>
                {name}
              </h3>
              <Badge tone={h.tone}>{t(`admin.monitor.health.${h.key}`)}</Badge>
              {n.platformNode ? <Badge tone="info">{t("admin.monitor.platformNode")}</Badge> : n.providerName && <Badge tone="neutral">{n.providerName}</Badge>}
            </div>
            <div className="mt-0.5 truncate font-mono text-[12px] text-on-surface-faint" title={n.nodeId}>
              {n.nodeId}
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              <Chip k={t("admin.monitor.nodeVersion")} v={n.nodeVersion ?? "—"} />
              {host?.bundleHash && <Chip k={t("admin.monitor.bundle")} v={host.bundleHash} />}
              {host?.bunVersion && <Chip k="Bun" v={host.bunVersion} />}
              {cw?.claudeVersion && <Chip k="Claude Code" v={cw.claudeVersion} />}
            </div>
          </div>
        </div>
        <div className="shrink-0 text-right text-[12px] leading-5 text-on-surface-faint">
          <div title={n.lastHeartbeatAt ? fmtDateTime(n.lastHeartbeatAt) : undefined}>
            {t("admin.monitor.heartbeat")} ·{" "}
            <span className={h.key === "stale" ? "font-semibold text-warning" : "text-on-surface"}>{n.lastHeartbeatAt ? rel(n.lastHeartbeatAt) : t("admin.monitor.neverSeen")}</span>
          </div>
          {host && <div>{t("admin.monitor.uptimeLine", { p: fmtUptime(host.processUptimeSec), h: fmtUptime(host.uptimeSec) })}</div>}
          <Link to="/console/admin/nodes" className="font-medium text-primary hover:underline">
            {t("admin.monitor.openNode")}
          </Link>
        </div>
      </header>

      {n.online && host ? (
        <div className="grid grid-cols-2 border-t border-outline-variant sm:grid-cols-3 xl:grid-cols-6" style={{ background: "var(--surface-container-low)" }}>
          <Gauge
            label={t("admin.monitor.gaugeMemory")}
            value={fmtNum(memUsed)}
            unit={`/ ${fmtNum(host.totalMemMb)} MB`}
            ratio={memRatio}
            sub={t("admin.monitor.rssLine", { node: fmtNum(host.processRssMb), workers: p ? fmtNum(p.rssMb) : "—" })}
          />
          <Gauge
            label={t("admin.monitor.gaugeLoad")}
            value={host.load1.toFixed(2)}
            ratio={loadRatio}
            sub={t("admin.monitor.ofCpus", { load: host.load1, n: host.cpus, load5: host.load5 })}
          />
          <Gauge
            label={t("admin.monitor.gaugeSessions")}
            value={p ? fmtNum(p.live) : "—"}
            unit={p ? `/ ${fmtNum(p.maxLive)}` : undefined}
            ratio={p && p.maxLive > 0 ? p.live / p.maxLive : undefined}
            sub={p ? t("admin.monitor.sessionsSub", { busy: p.busy, idle: p.idle, parked: p.awaitingTools ?? 0 }) : t("admin.monitor.noMetrics")}
          />
          <Gauge
            label={t("admin.monitor.gaugeAccounts")}
            value={fmtNum(n.accounts.active)}
            unit={`/ ${fmtNum(n.capacity)}`}
            ratio={n.capacity > 0 ? n.accounts.active / n.capacity : undefined}
            tone={liveProxyGap > 0 ? "warning" : undefined}
            sub={
              <span className={liveProxyGap > 0 ? "text-warning" : undefined}>
                {t("admin.monitor.accountsSub", { live: n.accounts.onLiveProxy, cooling: n.accounts.cooling })}
              </span>
            }
          />
          <Gauge
            label={t("admin.monitor.gaugeProxies")}
            value={fmtNum(n.proxies.live)}
            unit={`/ ${fmtNum(n.proxies.total)}`}
            ratio={n.proxies.total > 0 ? n.proxies.live / n.proxies.total : 0}
            tone={n.proxies.total === 0 || n.proxies.live < n.proxies.total ? (n.proxies.live === 0 ? "error" : "warning") : "success"}
            sub={n.metrics?.proxies ? t("admin.monitor.proxiesSub", { dead: n.metrics.proxies.dead, unknown: n.metrics.proxies.unknown }) : undefined}
          />
          <Gauge
            label={t("admin.monitor.gaugeInFlight")}
            value={fmtNum(n.inFlight)}
            unit={cw ? `/ ${fmtNum(cw.maxConcurrency)}` : undefined}
            ratio={cw && cw.maxConcurrency > 0 ? n.inFlight / cw.maxConcurrency : undefined}
            tone="info"
            sub={cw ? t("admin.monitor.inFlightSub", { max: cw.maxConcurrency, egress: n.metrics?.egress?.activeSessions ?? 0 }) : undefined}
          />
        </div>
      ) : (
        <div className="border-t border-outline-variant px-5 py-3 text-[13px]" style={{ background: "var(--surface-container-low)" }}>
          {n.online ? (
            <span className="text-on-surface-faint">{t("admin.monitor.noMetrics")}</span>
          ) : (
            <span className="text-on-surface-variant">{t("admin.monitor.offlineHint", { at: n.lastHeartbeatAt ? fmtDateTime(n.lastHeartbeatAt) : t("admin.monitor.neverSeen") })}</span>
          )}
          <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-[12.5px] text-on-surface-faint">
            <span>
              {t("admin.monitor.capacity")} <span className="font-mono text-on-surface">{fmtNum(n.accounts.active)} / {fmtNum(n.capacity)}</span>
            </span>
            <span>
              {t("admin.monitor.gaugeProxies")} <span className="font-mono text-on-surface">{fmtNum(n.proxies.live)} / {fmtNum(n.proxies.total)}</span>
            </span>
            <span>
              {t("admin.monitor.inFlight")} <span className="font-mono text-on-surface">{fmtNum(n.inFlight)}</span>
            </span>
          </div>
        </div>
      )}

      <footer className="mt-auto grid grid-cols-2 gap-x-6 gap-y-3 border-t border-outline-variant px-5 py-3 sm:grid-cols-4">
        <Figure
          label={t("admin.monitor.req1h")}
          value={fmtNum(n.traffic.req1h)}
          sub={
            <span className={errRate1h > 0.05 ? "font-semibold text-error" : errRate1h > 0 ? "text-warning" : undefined}>
              {fmtNum(n.traffic.err1h)} {t("admin.monitor.errors")} · {(errRate1h * 100).toFixed(1)}%
            </span>
          }
        />
        <Figure label={t("admin.monitor.avgMs1h")} value={n.traffic.avgMs1h == null ? "—" : `${fmtNum(n.traffic.avgMs1h)} ms`} tone={n.traffic.avgMs1h != null && n.traffic.avgMs1h > 15000 ? "warning" : undefined} />
        <Figure
          label={t("admin.monitor.req24h")}
          value={fmtNum(n.traffic.req24h)}
          sub={
            <span className={errRate24h > 0.05 ? "font-semibold text-error" : undefined}>
              {fmtNum(n.traffic.err24h)} {t("admin.monitor.errors")} · {(errRate24h * 100).toFixed(1)}%
            </span>
          }
        />
        <Figure
          label={t("admin.monitor.cost24h")}
          value={fmtUsd(n.traffic.cost24h, 2)}
          sub={p && Object.keys(p.evictions ?? {}).length > 0 ? `${t("admin.monitor.evictions")} ${Object.entries(p.evictions).map(([k, v]) => `${k}:${v}`).join(" ")}` : undefined}
        />
      </footer>
    </section>
  );
}

/** Pure render of the monitor payload (exported so it can be smoke-rendered without a browser). */
export function MonitorBody({ nodes, generatedAt }: { nodes: NodeMonitorRow[]; generatedAt: string }) {
  const { t } = useCT();
  const online = nodes.filter((n) => n.online);
  const sum = (f: (n: NodeMonitorRow) => number) => online.reduce((a, n) => a + f(n), 0);
  const pool = (n: NodeMonitorRow) => n.metrics?.ccWorker?.pool;
  const sorted = [...nodes].sort((a, b) => Number(b.online) - Number(a.online) || b.traffic.req1h - a.traffic.req1h);
  return (
    <>
      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        <StatCard label={t("admin.monitor.sumNodes")} value={`${online.length}/${nodes.length}`} tone={online.length === nodes.length ? "success" : online.length === 0 ? "error" : "warning"} icon={<TerminalIcon className="h-4 w-4" />} />
        <StatCard label={t("admin.monitor.sumInFlight")} value={fmtNum(sum((n) => n.inFlight))} sub={t("admin.monitor.sumInFlightSub")} tone="info" />
        <StatCard label={t("admin.monitor.sumSessions")} value={fmtNum(sum((n) => pool(n)?.live ?? 0))} sub={t("admin.monitor.sumSessionsSub", { busy: sum((n) => pool(n)?.busy ?? 0), idle: sum((n) => pool(n)?.idle ?? 0), parked: sum((n) => pool(n)?.awaitingTools ?? 0) })} />
        <StatCard label={t("admin.monitor.sumAccounts")} value={fmtNum(sum((n) => n.accounts.active))} sub={t("admin.monitor.sumAccountsSub", { live: sum((n) => n.accounts.onLiveProxy), cooling: sum((n) => n.accounts.cooling) })} tone={sum((n) => n.accounts.active - n.accounts.onLiveProxy) > 0 ? "warning" : "neutral"} />
        <StatCard label={t("admin.monitor.sumProxies")} value={`${fmtNum(sum((n) => n.proxies.live))}/${fmtNum(sum((n) => n.proxies.total))}`} tone={sum((n) => n.proxies.total - n.proxies.live) > 0 ? "warning" : "success"} />
        <StatCard label={t("admin.monitor.sumTraffic")} value={fmtNum(sum((n) => n.traffic.req1h))} sub={t("admin.monitor.sumTrafficSub", { err: sum((n) => n.traffic.err1h), cost: fmtUsd(sum((n) => n.traffic.cost24h), 2) })} tone={sum((n) => n.traffic.err1h) > 0 ? "warning" : "neutral"} />
      </div>

      {nodes.length === 0 && <EmptyState title={t("admin.monitor.empty")} />}
      <div className="grid grid-cols-1 gap-5">
        {sorted.map((n) => (
          <NodeMonitorCard key={n.nodeId} n={n} />
        ))}
      </div>
      <div className="mt-4 text-[12px] text-on-surface-faint">{t("admin.monitor.footer", { at: generatedAt })}</div>
    </>
  );
}

export function AdminNodeMonitor() {
  const { t } = useCT();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((x) => x + 1), REFRESH_MS);
    return () => clearInterval(id);
  }, []);
  const state = useAsync(() => api.get<{ nodes: NodeMonitorRow[]; generatedAt: string }>("/api/admin/nodes/monitor"), [tick]);

  return (
    <>
      <PageHeader title={t("admin.monitor.title")} desc={t("admin.monitor.desc")} />
      <NodeTabs />
      <Async state={state} rows={4}>
        {(res) => <MonitorBody nodes={res.nodes} generatedAt={res.generatedAt} />}
      </Async>
    </>
  );
}
