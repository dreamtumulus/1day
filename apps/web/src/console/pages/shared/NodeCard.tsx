import type { ReactNode } from "react";
import { type NodeRow } from "../../api";
import { useCT } from "../../i18n";
import { Badge, ProgressBar, StatusBadge, fmtDateTime, fmtNum, useRelTime } from "../../ui";

// One card per node (admin node page, provider node page): identity + liveness
// in the header, four figure tiles (in flight, accounts / capacity, proxies,
// version), deployment / binding facts and the caller's actions in the footer.

function Tile({ label, value, sub, tone }: { label: ReactNode; value: ReactNode; sub?: ReactNode; tone?: "warning" | "error" }) {
  const color = tone === "error" ? "var(--error)" : tone === "warning" ? "var(--warning)" : undefined;
  return (
    <div className="min-w-0 px-4 py-3">
      <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-on-surface-faint">{label}</div>
      <div className="mt-1 truncate font-display text-[20px] font-bold tabular-nums tracking-[-0.02em] text-on-surface" style={color ? { color } : undefined}>
        {value}
      </div>
      {sub && <div className="mt-0.5 truncate text-[11.5px] text-on-surface-faint">{sub}</div>}
    </div>
  );
}

export function NodeCard({
  node,
  actions,
  showProvider = false,
  showPool = true,
}: {
  node: NodeRow;
  /** Buttons for the footer (capacity, proxy pool, remove…). */
  actions?: ReactNode;
  /** Admin view: who owns the node. */
  showProvider?: boolean;
  /** Provider view hides pool facts it cannot act on. */
  showPool?: boolean;
}) {
  const { t } = useCT();
  const rel = useRelTime();
  const name = node.deployMeta?.name || node.nodeId;
  const meta = node.deployMeta;
  const failed = meta?.status === "failed";
  const capPct = node.capacity > 0 ? node.accountCount / node.capacity : 0;
  const dot = node.online ? "var(--success)" : "var(--on-surface-faint)";

  return (
    <section className="card flex flex-col overflow-hidden" style={failed ? { borderColor: "color-mix(in oklab, var(--error) 45%, var(--outline-variant))" } : undefined}>
      <header className="flex items-start justify-between gap-3 px-5 pb-3 pt-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="relative mt-[7px] inline-flex h-2.5 w-2.5 shrink-0">
            {node.online && <span className="wk-live-dot absolute inline-flex h-full w-full rounded-full" style={{ background: dot, opacity: 0.6, transform: "scale(1.9)" }} />}
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full" style={{ background: dot }} />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h3 className="truncate font-display text-[16px] font-semibold tracking-[-0.01em] text-on-surface" title={name}>
                {name}
              </h3>
              <StatusBadge status={node.online ? "online" : "offline"} />
              {node.online && !node.acceptingSessions && <Badge tone="warning">{t("admin.nodes.draining")}</Badge>}
              {showProvider &&
                (node.platformNode ? (
                  <Badge tone="info">{t("admin.nodes.platformNode")}</Badge>
                ) : (
                  <Badge tone="neutral">{node.providerName ?? node.providerId.slice(0, 8)}</Badge>
                ))}
            </div>
            <div className="mt-0.5 truncate font-mono text-[12px] text-on-surface-faint" title={node.nodeId}>
              {node.nodeId}
            </div>
          </div>
        </div>
        <div className="shrink-0 text-right text-[12px] leading-5 text-on-surface-faint">
          <div title={node.lastHeartbeatAt ? fmtDateTime(node.lastHeartbeatAt) : undefined}>
            {t("admin.nodes.heartbeat")} · <span className={node.online ? "text-on-surface" : ""}>{node.lastHeartbeatAt ? rel(node.lastHeartbeatAt) : t("common.never")}</span>
          </div>
          <div className="font-mono">{[node.osType, node.osArch].filter(Boolean).join(" / ") || "—"}</div>
        </div>
      </header>

      <div className="grid grid-cols-2 border-t border-outline-variant sm:grid-cols-4" style={{ background: "var(--surface-container-low)" }}>
        <Tile label={t("admin.nodes.cardInFlight")} value={fmtNum(node.inFlight)} tone={!node.online && node.inFlight > 0 ? "warning" : undefined} />
        <Tile
          label={t("admin.nodes.cardAccounts")}
          value={
            <span>
              {fmtNum(node.accountCount)}
              <span className="text-[14px] font-medium text-on-surface-faint"> / {fmtNum(node.capacity)}</span>
            </span>
          }
          sub={<ProgressBar value={node.accountCount} max={node.capacity} />}
          tone={capPct >= 1 ? "error" : capPct >= 0.8 ? "warning" : undefined}
        />
        {showPool ? (
          <Tile
            label={t("admin.nodes.cardProxies")}
            value={fmtNum(node.proxyCount)}
            sub={node.proxyCount === 0 ? <span className="text-warning">{t("admin.nodes.poolEmptyBadge")}</span> : undefined}
            tone={node.proxyCount === 0 ? "warning" : undefined}
          />
        ) : (
          <Tile label={t("admin.nodes.accepting")} value={node.online && node.acceptingSessions ? "✓" : "—"} />
        )}
        <Tile label={t("admin.nodes.cardVersion")} value={<span className="font-mono text-[15px]">{node.nodeVersion ?? "—"}</span>} />
      </div>

      <footer className="mt-auto flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-outline-variant px-5 py-3">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-on-surface-faint">
          {meta ? (
            <>
              <Badge tone={failed ? "error" : "neutral"}>{meta.method === "local" ? t("admin.nodes.deployLocal") : meta.method ?? "ssh"}</Badge>
              {meta.host && (
                <span className="font-mono">
                  {meta.host}
                  {meta.port ? `:${meta.port}` : ""}
                </span>
              )}
              {meta.deployedAt && (
                <span>
                  {t("admin.nodes.deployedOn")} {fmtDateTime(meta.deployedAt)}
                </span>
              )}
              {failed && (
                <span className="truncate text-error" title={meta.error}>
                  {t("admin.nodes.deployFailed")}
                  {meta.error ? ` · ${meta.error}` : ""}
                </span>
              )}
            </>
          ) : (
            <>
              <Badge tone="neutral">{t("admin.nodes.boundByCode")}</Badge>
              <span>{t("admin.nodes.boundAt", { at: fmtDateTime(node.createdAt) })}</span>
            </>
          )}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </footer>
    </section>
  );
}
