import { Link } from "react-router-dom";
import { ArrowRightIcon, PlugIcon, TerminalIcon, WalletIcon } from "../../../components/Icon";
import { useAuth } from "../../../lib/auth";
import { api } from "../../api";
import { BarChart } from "../../charts";
import { useCT } from "../../i18n";
import { Async, Card, KV, PageHeader, StatCard, StatusBadge, fmtNum, fmtUsd, useAsync } from "../../ui";
import type { ProviderOverviewData } from "./types";

export function ProviderOverview() {
  const { t } = useCT();
  const { me } = useAuth();
  const state = useAsync(() => api.get<ProviderOverviewData>("/api/provider/overview"), []);

  return (
    <>
      <PageHeader
        title={t("provider.overview.title", { name: me?.name ?? "" })}
        desc={t("provider.overview.desc")}
        actions={
          <>
            <Link to="/console/nodes" className="wk-btn wk-btn-sm wk-btn-ghost">
              <TerminalIcon width={15} height={15} />
              {t("provider.overview.bindNode")}
            </Link>
            <Link to="/console/accounts" className="wk-btn wk-btn-sm wk-btn-primary">
              <PlugIcon width={15} height={15} />
              {t("provider.overview.addAccount")}
            </Link>
          </>
        }
      />
      <Async state={state} rows={6}>
        {(d) => (
          <div className="space-y-6">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard
                label={t("shell.unsettled")}
                value={fmtUsd(d.balanceUsd, 4)}
                sub={t("provider.overview.unsettledSub")}
                tone="primary"
                icon={<WalletIcon width={16} height={16} />}
              />
              <StatCard label={t("common.today")} value={fmtUsd(d.today.earningUsd)} sub={t("provider.overview.requests", { n: fmtNum(d.today.requests) })} tone="success" />
              <StatCard label={t("common.thisMonth")} value={fmtUsd(d.month.earningUsd)} sub={t("provider.overview.requests", { n: fmtNum(d.month.requests) })} tone="info" />
              <StatCard label={t("provider.overview.lifetime")} value={fmtUsd(d.lifetimeEarningUsd, 2)} sub={t("provider.overview.paidOut", { v: fmtUsd(d.paidOutUsd, 2) })} />
            </div>
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1.6fr_1fr]">
              <Card title={t("provider.overview.dailyEarning")} desc={t("common.last14d")}>
                <BarChart data={d.daily.map((p) => ({ label: p.day, value: p.earningUsd }))} format={(v) => fmtUsd(v)} color="var(--success)" />
              </Card>
              <div className="space-y-6">
                <Card
                  title={t("nav.accounts")}
                  actions={
                    <Link to="/console/accounts" className="inline-flex items-center gap-1 text-[13px] font-medium text-primary hover:underline">
                      {t("provider.overview.manage")}
                      <ArrowRightIcon width={13} height={13} />
                    </Link>
                  }
                >
                  <KV
                    items={[
                      [t("provider.overview.total"), fmtNum(d.accounts.total)],
                      [<StatusBadge key="a" status="active" />, fmtNum(d.accounts.active)],
                      [<StatusBadge key="p" status="pending" />, fmtNum(d.accounts.pending)],
                      [<StatusBadge key="e" status="error" />, fmtNum(d.accounts.error)],
                    ]}
                  />
                </Card>
                <Card
                  title={t("nav.nodes")}
                  actions={
                    <Link to="/console/nodes" className="inline-flex items-center gap-1 text-[13px] font-medium text-primary hover:underline">
                      {t("provider.overview.manage")}
                      <ArrowRightIcon width={13} height={13} />
                    </Link>
                  }
                >
                  <div className="flex items-baseline gap-2">
                    <span className="font-display text-[28px] font-bold tabular-nums">{d.nodes.online}</span>
                    <span className="text-sm text-on-surface-variant">/ {d.nodes.total} {t("provider.overview.nodesOnline")}</span>
                  </div>
                  {d.nodes.total === 0 && <p className="mt-2 text-[13px] text-on-surface-faint">{t("provider.overview.noNodes")}</p>}
                </Card>
              </div>
            </div>
          </div>
        )}
      </Async>
    </>
  );
}
