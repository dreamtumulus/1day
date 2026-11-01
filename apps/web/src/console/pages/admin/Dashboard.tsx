import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRightIcon, BellIcon, ChartIcon, PlugIcon, ShieldIcon, TerminalIcon, WalletIcon } from "../../../components/Icon";
import { api, type DailyPoint, type Totals } from "../../api";
import { BarChart, ShareBars } from "../../charts";
import { useCT } from "../../i18n";
import { Async, Card, PageHeader, Segmented, StatCard, fmtDuration, fmtNum, fmtPct, fmtUsd, useAsync } from "../../ui";

interface Dashboard {
  users: { consumer: number; provider: number; admin: number; ops?: number; disabled: number };
  today: Totals;
  month: Totals;
  daily: DailyPoint[];
  topModels: Array<{ model: string; requests: number; costUsd: number }>;
  topUsers: Array<{ userId: string; name: string | null; requests: number; costUsd: number }>;
  accounts: { total: number; active: number; pending: number; error: number; cooling: number; proxyDown?: number; proxyDownOldestSince?: string | null };
  nodes: { total: number; online: number };
  balances: { consumerTotalUsd: number; providerUnsettledUsd: number; creditLimitTotalUsd: number; creditOutstandingUsd: number };
}

type Metric = "revenue" | "requests" | "errors";

export function AdminDashboard() {
  const { t } = useCT();
  const state = useAsync(() => api.get<Dashboard>("/api/admin/dashboard"), []);
  const [metric, setMetric] = useState<Metric>("revenue");

  return (
    <>
      <PageHeader title={t("admin.dashboard.title")} desc={t("admin.dashboard.desc")} />
      <Async state={state} rows={6}>
        {(d) => {
          const errRate = d.today.requests + (d.today.errors ?? 0) > 0
            ? (d.today.errors ?? 0) / (d.today.requests + (d.today.errors ?? 0))
            : 0;
          const series = d.daily.map((p) => ({
            label: p.day,
            value: metric === "revenue" ? p.costUsd : metric === "requests" ? p.requests : (p.errors ?? 0),
          }));
          return (
            <div className="space-y-6">
              {d.accounts.pending > 0 && (
                <div
                  className="flex flex-wrap items-center gap-3 rounded-lg px-4 py-3"
                  style={{ background: "var(--warning-container)", border: "1px solid color-mix(in oklab, var(--warning) 30%, transparent)" }}
                >
                  <BellIcon className="h-5 w-5 shrink-0 text-warning" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-on-surface">
                      {t("admin.dashboard.pendingTitle", { n: d.accounts.pending })}
                    </div>
                    <div className="text-[13px] text-on-surface-variant">{t("admin.dashboard.pendingDesc")}</div>
                  </div>
                  <Link to="/console/admin/accounts?reviewStatus=pending" className="wk-btn wk-btn-sm wk-btn-primary">
                    {t("admin.dashboard.review")}
                    <ArrowRightIcon width={14} height={14} />
                  </Link>
                </div>
              )}
              {(d.accounts.proxyDown ?? 0) > 0 && (
                <div
                  className="flex flex-wrap items-center gap-3 rounded-lg px-4 py-3"
                  style={{ background: "var(--warning-container)", border: "1px solid color-mix(in oklab, var(--warning) 45%, transparent)" }}
                >
                  <ShieldIcon className="h-5 w-5 shrink-0 text-warning" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-on-surface">{t("admin.dashboard.proxyDownTitle", { n: d.accounts.proxyDown ?? 0 })}</div>
                    <div className="text-[13px] text-on-surface-variant">
                      {t("admin.dashboard.proxyDownDesc", {
                        since: (d.accounts.proxyDownOldestSince ?? "").slice(5, 16).replace("T", " "),
                        dur: d.accounts.proxyDownOldestSince ? fmtDuration(Date.now() - Date.parse(d.accounts.proxyDownOldestSince)) : "?",
                      })}
                    </div>
                  </div>
                  <Link to="/console/admin/accounts?status=proxy_down" className="wk-btn wk-btn-sm wk-btn-primary">
                    {t("admin.dashboard.proxyDownLink")}
                    <ArrowRightIcon width={14} height={14} />
                  </Link>
                </div>
              )}

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <StatCard
                  label={t("admin.dashboard.todayRevenue")}
                  value={fmtUsd(d.today.costUsd)}
                  sub={t("admin.dashboard.todayStdCost", { v: fmtUsd(d.today.totalCostUsd ?? 0) })}
                  tone="primary"
                  icon={<WalletIcon className="h-4 w-4" />}
                />
                <StatCard
                  label={t("admin.dashboard.todayRequests")}
                  value={fmtNum(d.today.requests)}
                  sub={`${fmtNum(d.today.tokens)} ${t("common.tokens")}`}
                  icon={<ChartIcon className="h-4 w-4" />}
                />
                <Link to="/console/admin/errors" className="block rounded-lg transition hover:ring-2 hover:ring-primary/40" title={t("admin.dashboard.errorsLink")}>
                  <StatCard
                    label={t("admin.dashboard.todayErrors")}
                    value={fmtNum(d.today.errors ?? 0)}
                    sub={
                      <>
                        {t("admin.dashboard.errorRate", { v: fmtPct(errRate, 1) })}
                        <span className="ml-2 font-medium text-primary">{t("admin.dashboard.errorsLink")} →</span>
                      </>
                    }
                    tone={(d.today.errors ?? 0) > 0 ? "error" : "neutral"}
                  />
                </Link>
                <StatCard
                  label={t("admin.dashboard.monthRevenue")}
                  value={fmtUsd(d.month.costUsd)}
                  sub={t("admin.dashboard.monthRequests", { v: fmtNum(d.month.requests) })}
                  tone="success"
                />
                <StatCard
                  label={t("admin.dashboard.users")}
                  value={fmtNum(d.users.consumer + d.users.provider + d.users.admin + (d.users.ops ?? 0))}
                  sub={
                    t("admin.dashboard.usersSub", d.users) +
                    (d.users.disabled ? ` · ${t("admin.dashboard.disabledUsers", { n: d.users.disabled })}` : "")
                  }
                  icon={<ShieldIcon className="h-4 w-4" />}
                />
                <StatCard
                  label={t("admin.dashboard.consumerBalance")}
                  value={fmtUsd(d.balances.consumerTotalUsd, 2)}
                  sub={t("admin.dashboard.consumerBalanceSub")}
                />
                <StatCard
                  label={t("admin.dashboard.creditOutstanding")}
                  value={fmtUsd(d.balances.creditOutstandingUsd ?? 0, 2)}
                  sub={t("admin.dashboard.creditOutstandingSub", { limit: fmtUsd(d.balances.creditLimitTotalUsd ?? 0, 2) })}
                  tone="info"
                  icon={<WalletIcon className="h-4 w-4" />}
                />
                <StatCard
                  label={t("admin.dashboard.providerUnsettled")}
                  value={fmtUsd(d.balances.providerUnsettledUsd, 2)}
                  sub={t("admin.dashboard.providerUnsettledSub")}
                  tone="warning"
                />
                <Link to="/console/admin/node-monitor" className="block rounded-lg transition hover:ring-2 hover:ring-primary/40" title={t("admin.dashboard.nodesLink")}>
                  <StatCard
                    label={t("admin.dashboard.nodes")}
                    value={fmtNum(d.nodes.online)}
                    sub={t("admin.dashboard.nodesSub", d.nodes)}
                    tone={d.nodes.online > 0 ? "success" : "neutral"}
                    icon={<TerminalIcon className="h-4 w-4" />}
                  />
                </Link>
              </div>

              <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
                <Card
                  className="xl:col-span-2"
                  title={t("admin.dashboard.trend")}
                  actions={
                    <Segmented<Metric>
                      value={metric}
                      onChange={setMetric}
                      options={[
                        { value: "revenue", label: t("admin.dashboard.revenue") },
                        { value: "requests", label: t("admin.dashboard.requests") },
                        { value: "errors", label: t("admin.dashboard.errors") },
                      ]}
                    />
                  }
                >
                  <BarChart
                    data={series}
                    height={200}
                    format={metric === "revenue" ? (v) => fmtUsd(v) : fmtNum}
                    color={metric === "errors" ? "var(--error)" : "var(--primary)"}
                  />
                </Card>

                <Card
                  title={t("admin.dashboard.supply")}
                  actions={
                    <Link to="/console/admin/accounts" className="text-[13px] font-medium text-primary hover:underline">
                      {t("admin.dashboard.viewAll")}
                    </Link>
                  }
                >
                  <div className="mb-4 flex items-center gap-2 text-sm text-on-surface-variant">
                    <PlugIcon className="h-4 w-4" />
                    {t("admin.dashboard.accounts")}
                    <span className="ml-auto font-mono font-semibold text-on-surface">{d.accounts.total}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    {(
                      [
                        ["accountsActive", d.accounts.active, "var(--success)", "status=active"],
                        ["accountsPending", d.accounts.pending, "var(--warning)", "reviewStatus=pending"],
                        ["accountsError", d.accounts.error, "var(--error)", "status=error"],
                        ["accountsCooling", d.accounts.cooling, "var(--info)", ""],
                      ] as const
                    ).map(([k, n, color, q]) => (
                      <Link
                        key={k}
                        to={`/console/admin/accounts${q ? `?${q}` : ""}`}
                        className="rounded-md p-3 transition-colors hover:bg-surface-variant"
                        style={{ border: "1px solid var(--outline-variant)" }}
                      >
                        <div className="flex items-center gap-1.5 text-[12.5px] text-on-surface-faint">
                          <span className="h-2 w-2 rounded-full" style={{ background: color }} />
                          {t(`admin.dashboard.${k}`)}
                        </div>
                        <div className="mt-1 font-display text-[22px] font-bold tabular-nums">{n}</div>
                      </Link>
                    ))}
                  </div>
                </Card>
              </div>

              <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                <Card title={t("admin.dashboard.topModels")}>
                  {d.topModels.length ? (
                    <ShareBars
                      items={d.topModels.map((m) => ({ label: m.model, value: m.costUsd, sub: `${fmtNum(m.requests)} req` }))}
                      format={(v) => fmtUsd(v)}
                    />
                  ) : (
                    <p className="py-6 text-center text-sm text-on-surface-faint">{t("common.empty")}</p>
                  )}
                </Card>
                <Card
                  title={t("admin.dashboard.topUsers")}
                  actions={
                    <Link to="/console/admin/users" className="text-[13px] font-medium text-primary hover:underline">
                      {t("admin.dashboard.viewAll")}
                    </Link>
                  }
                >
                  {d.topUsers.length ? (
                    <ShareBars
                      items={d.topUsers.map((u) => ({
                        label: u.name ?? u.userId.slice(0, 8),
                        value: u.costUsd,
                        sub: `${fmtNum(u.requests)} req`,
                      }))}
                      format={(v) => fmtUsd(v)}
                    />
                  ) : (
                    <p className="py-6 text-center text-sm text-on-surface-faint">{t("common.empty")}</p>
                  )}
                </Card>
              </div>
            </div>
          );
        }}
      </Async>
    </>
  );
}
