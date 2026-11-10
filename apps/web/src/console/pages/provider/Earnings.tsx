import { useState } from "react";
import { api, type Paged, type ProviderAccount } from "../../api";
import { cacheWriteText } from "../../CostBreakdown";
import { useCT } from "../../i18n";
import {
  Async,
  Button,
  Card,
  DataTable,
  EmptyState,
  Field,
  Input,
  Mono,
  PageHeader,
  Pagination,
  Select,
  StatCard,
  Toolbar,
  fmtDateTime,
  fmtNum,
  fmtUsd,
  localDay,
  useAsync,
  type Column,
} from "../../ui";
import type { EarningRow } from "./types";

type EarningsPage = Paged<EarningRow> & { sumEarningUsd: number };

export function ProviderEarnings() {
  const { t } = useCT();
  const [from, setFrom] = useState(localDay(-29));
  const [to, setTo] = useState(localDay(0));
  const [accountId, setAccountId] = useState("");
  const [applied, setApplied] = useState({ from: localDay(-29), to: localDay(0), accountId: "" });
  const [page, setPage] = useState(1);
  const accounts = useAsync(() => api.get<ProviderAccount[]>("/api/provider/accounts"), []);
  const state = useAsync(
    () => api.get<EarningsPage>("/api/provider/earnings", { ...applied, page, pageSize: 20 }),
    [applied, page],
  );

  const columns: Column<EarningRow>[] = [
    { key: "time", header: t("common.time"), render: (r) => <Mono>{fmtDateTime(r.createdAt)}</Mono> },
    { key: "acc", header: t("provider.earnings.account"), render: (r) => r.accountName ?? <Mono>{r.accountId ?? "—"}</Mono> },
    { key: "model", header: t("common.model"), render: (r) => <span className="font-mono text-[13px]">{r.model}</span> },
    {
      key: "tokens",
      header: `${t("common.input")} / ${t("common.output")} / ${t("common.cache")}`,
      align: "right",
      render: (r) => (
        <div className="font-mono text-[12.5px] tabular-nums">
          <div>
            {fmtNum(r.inputTokens)} / {fmtNum(r.outputTokens)} / {fmtNum(r.cacheTokens)}
          </div>
          {r.cacheReadTokens !== undefined && r.cacheTokens > 0 && (
            <div className="text-[11.5px] text-on-surface-faint">
              {t("common.cost.cacheRead")} {fmtNum(r.cacheReadTokens)} · {t("common.cost.cacheWrite")}{" "}
              {cacheWriteText({ cacheWriteTokens: r.cacheWriteTokens ?? 0, cacheWrite5mTokens: r.cacheWrite5mTokens, cacheWrite1hTokens: r.cacheWrite1hTokens })}
            </div>
          )}
        </div>
      ),
    },
    { key: "std", header: t("provider.earnings.standard"), align: "right", render: (r) => <span className="font-mono tabular-nums text-on-surface-variant">{fmtUsd(r.totalCost)}</span> },
    { key: "earn", header: t("provider.earnings.earning"), align: "right", render: (r) => <span className="font-mono font-semibold tabular-nums text-success">{fmtUsd(r.providerEarning)}</span> },
  ];

  return (
    <>
      <PageHeader title={t("nav.earnings")} desc={t("provider.earnings.desc")} />
      <Card bodyClassName="">
        <Toolbar>
          <Field label={t("common.from")}>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label={t("common.to")}>
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <Field label={t("provider.earnings.account")}>
            <Select
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              options={[{ value: "", label: t("common.all") }, ...(accounts.data ?? []).map((a) => ({ value: a.id, label: a.name }))]}
            />
          </Field>
          <Button
            variant="primary"
            onClick={() => {
              setPage(1);
              setApplied({ from, to, accountId });
            }}
          >
            {t("common.filter")}
          </Button>
        </Toolbar>
        <Async state={state} rows={6}>
          {(p) => (
            <>
              <div className="grid grid-cols-2 gap-4 p-5" style={{ borderBottom: "1px solid var(--outline-variant)" }}>
                <StatCard label={t("provider.earnings.sum")} value={fmtUsd(p.sumEarningUsd)} tone="success" />
                <StatCard label={t("common.requests")} value={fmtNum(p.total)} tone="info" />
              </div>
              <DataTable
                columns={columns}
                rows={p.items}
                rowKey={(r) => r.id}
                minWidth={900}
                loading={state.loading}
                empty={<EmptyState desc={t("provider.earnings.empty")} />}
              />
              <Pagination page={p.page} pageSize={p.pageSize} total={p.total} onPage={setPage} />
            </>
          )}
        </Async>
      </Card>
    </>
  );
}
