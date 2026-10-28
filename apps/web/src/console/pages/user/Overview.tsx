import { Link } from "react-router-dom";
import { ArrowRightIcon, ChartIcon, KeyIcon, RocketIcon, WalletIcon } from "../../../components/Icon";
import { useAuth } from "../../../lib/auth";
import { api, type DailyPoint, type Totals } from "../../api";
import { BarChart, ShareBars } from "../../charts";
import { useCT } from "../../i18n";
import { Async, Card, EmptyState, PageHeader, StatCard, fmtNum, fmtTokens, fmtUsd, useAsync } from "../../ui";

interface Overview {
  balanceUsd: number;
  creditLimitUsd: number;
  creditUsedUsd: number;
  availableUsd: number;
  creditSettledAt: string | null;
  keyCount: number;
  today: Totals;
  month: Totals;
  daily: DailyPoint[];
  topModels: Array<{ model: string; requests: number; costUsd: number }>;
}

const LOW_BALANCE_USD = 1;

export function UserOverview() {
  const { t } = useCT();
  const { me } = useAuth();
  const state = useAsync(() => api.get<Overview>("/api/user/overview"), []);
  const isConsumer = me?.role === "consumer";

  return (
    <>
      <PageHeader
        title={t("user.overview.title", { name: me?.name ?? "" })}
        desc={t("user.overview.desc")}
        actions={
          <>
            <Link to="/console/guide" className="wk-btn wk-btn-sm wk-btn-ghost">
              <RocketIcon width={15} height={15} />
              {t("nav.guide")}
            </Link>
            <Link to="/console/keys" className="wk-btn wk-btn-sm wk-btn-primary">
              <KeyIcon width={15} height={15} />
              {t("user.overview.createKey")}
            </Link>
          </>
        }
      />
      <Async state={state} rows={6}>
        {(d) => (
          <div className="space-y-6">
            {d.availableUsd < LOW_BALANCE_USD && isConsumer && (
              <div
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg px-4 py-3 text-sm"
                style={{ background: "var(--warning-container)", color: "var(--warning)" }}
              >
                <span className="font-medium">
                  {d.creditLimitUsd > 0
                    ? d.availableUsd <= 0
                      ? t("user.overview.creditExhausted")
                      : t("user.overview.creditLow")
                    : d.availableUsd <= 0
                      ? t("user.overview.noBalance")
                      : t("user.overview.lowBalance")}
                </span>
                <Link to="/console/wallet" className="inline-flex items-center gap-1 font-semibold underline-offset-2 hover:underline">
                  {d.creditLimitUsd > 0 ? t("user.overview.goWallet") : t("user.overview.goRedeem")}
                  <ArrowRightIcon width={14} height={14} />
                </Link>
              </div>
            )}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard
                label={d.creditLimitUsd > 0 ? t("shell.available") : t("shell.balance")}
                value={<span className={d.availableUsd <= 0 ? "text-error" : ""}>{fmtUsd(d.availableUsd, 2)}</span>}
                sub={
                  d.creditLimitUsd > 0
                    ? t("user.overview.creditSub", { limit: fmtUsd(d.creditLimitUsd, 2), used: fmtUsd(d.creditUsedUsd, 2) })
                    : t("user.overview.keyCount", { n: d.keyCount })
                }
                tone="primary"
                icon={<WalletIcon width={16} height={16} />}
              />
              <StatCard
                label={t("common.today")}
                value={fmtUsd(d.today.costUsd)}
                sub={t("user.overview.reqTokens", { req: fmtNum(d.today.requests), tok: fmtTokens(d.today.tokens) })}
                tone="info"
                icon={<ChartIcon width={16} height={16} />}
              />
              <StatCard
                label={t("common.thisMonth")}
                value={fmtUsd(d.month.costUsd)}
                sub={t("user.overview.reqTokens", { req: fmtNum(d.month.requests), tok: fmtTokens(d.month.tokens) })}
                tone="success"
              />
              <StatCard
                label={t("user.overview.avgCost")}
                value={fmtUsd(d.month.requests > 0 ? d.month.costUsd / d.month.requests : 0)}
                sub={t("user.overview.perRequest")}
              />
            </div>
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1.6fr_1fr]">
              <Card title={t("user.overview.dailyCost")} desc={t("common.last14d")}>
                <BarChart data={d.daily.map((p) => ({ label: p.day, value: p.costUsd }))} format={(v) => fmtUsd(v)} />
              </Card>
              <Card title={t("user.overview.topModels")} desc={t("common.thisMonth")}>
                {d.topModels.length === 0 ? (
                  <EmptyState
                    title={t("user.overview.noUsage")}
                    desc={t("user.overview.noUsageDesc")}
                    action={
                      <Link to="/console/guide" className="wk-btn wk-btn-sm wk-btn-soft">
                        {t("nav.guide")}
                      </Link>
                    }
                  />
                ) : (
                  <ShareBars
                    items={d.topModels.map((m) => ({ label: m.model, value: m.costUsd, sub: `${fmtNum(m.requests)} req` }))}
                    format={(v) => fmtUsd(v)}
                  />
                )}
              </Card>
            </div>
          </div>
        )}
      </Async>
    </>
  );
}
