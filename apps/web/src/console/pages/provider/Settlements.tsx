import { api } from "../../api";
import { useCT } from "../../i18n";
import { Async, Card, PageHeader, StatCard, fmtUsd, useAsync } from "../../ui";
import { LedgerTable } from "../user/Wallet";
import type { ProviderOverviewData } from "./types";

export function ProviderSettlements() {
  const { t } = useCT();
  const ov = useAsync(() => api.get<ProviderOverviewData>("/api/provider/overview"), []);
  return (
    <>
      <PageHeader title={t("nav.settlements")} desc={t("provider.settlements.desc")} />
      <div className="space-y-6">
        <Async state={ov} rows={2}>
          {(d) => (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <StatCard label={t("provider.overview.lifetime")} value={fmtUsd(d.lifetimeEarningUsd, 4)} tone="info" />
              <StatCard label={t("provider.settlements.paid")} value={fmtUsd(d.paidOutUsd, 4)} tone="success" />
              <StatCard label={t("shell.unsettled")} value={fmtUsd(d.balanceUsd, 4)} tone="primary" sub={t("provider.settlements.unsettledSub")} />
            </div>
          )}
        </Async>
        <Card title={t("provider.settlements.records")} bodyClassName="">
          <LedgerTable path="/api/provider/ledger" emptyDesc={t("provider.settlements.empty")} />
        </Card>
      </div>
    </>
  );
}
