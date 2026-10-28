import { useState, type FormEvent } from "react";
import { SparkleIcon, WalletIcon } from "../../../components/Icon";
import { useAuth } from "../../../lib/auth";
import { api, type CacheRefundRow, type CacheRefundSummary, type CreditEvent, type LedgerRow, type Paged } from "../../api";
import { useCT } from "../../i18n";
import {
  Async,
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  Field,
  Input,
  Modal,
  Mono,
  PageHeader,
  Pagination,
  StatCard,
  fmtDateTime,
  fmtUsd,
  useAsync,
  useToast,
  type Column,
} from "../../ui";

/** Ledger table shared with the provider settlements page. */
export function LedgerTable({ path, emptyDesc }: { path: string; emptyDesc?: string }) {
  const { t } = useCT();
  const [page, setPage] = useState(1);
  const state = useAsync(() => api.get<Paged<LedgerRow>>(path, { page, pageSize: 20 }), [path, page]);
  const columns: Column<LedgerRow>[] = [
    { key: "time", header: t("common.time"), render: (r) => <Mono>{fmtDateTime(r.createdAt)}</Mono> },
    {
      key: "kind",
      header: t("common.type"),
      render: (r) => (
        <Badge tone={r.kind === "payout" ? "warning" : r.kind === "redeem" ? "success" : r.kind === "cache_refund" ? "info" : "neutral"}>{t(`ledger.${r.kind}`)}</Badge>
      ),
    },
    {
      key: "amount",
      header: t("common.amount"),
      align: "right",
      render: (r) => (
        <span className={`font-mono tabular-nums ${r.amountUsd >= 0 ? "text-success" : "text-error"}`}>
          {r.amountUsd >= 0 ? "+" : ""}
          {fmtUsd(r.amountUsd)}
        </span>
      ),
    },
    {
      key: "after",
      header: t("ledger.balanceAfter"),
      align: "right",
      render: (r) => <span className="font-mono tabular-nums text-on-surface-variant">{r.kind === "legacy_topup" ? "—" : fmtUsd(r.balanceAfter)}</span>,
    },
    { key: "ref", header: t("ledger.ref"), render: (r) => (r.ref ? <Mono>{r.ref}</Mono> : "—") },
    { key: "note", header: t("common.note"), render: (r) => <span className="text-on-surface-variant">{r.note || "—"}</span> },
  ];
  return (
    <Async state={state} rows={5}>
      {(p) => (
        <>
          <DataTable
            columns={columns}
            rows={p.items}
            rowKey={(r) => r.id}
            minWidth={760}
            loading={state.loading}
            empty={<EmptyState desc={emptyDesc} />}
          />
          <Pagination page={p.page} pageSize={p.pageSize} total={p.total} onPage={setPage} />
        </>
      )}
    </Async>
  );
}

/** Credit-line history: limit changes and settlements (docs/data-model.md §4). */
export function CreditEventTable({ path }: { path: string }) {
  const { t } = useCT();
  const [page, setPage] = useState(1);
  const state = useAsync(() => api.get<Paged<CreditEvent>>(path, { page, pageSize: 20 }), [path, page]);
  const columns: Column<CreditEvent>[] = [
    { key: "time", header: t("common.time"), render: (r) => <Mono>{fmtDateTime(r.createdAt)}</Mono> },
    { key: "kind", header: t("common.type"), render: (r) => <Badge tone={r.kind === "settlement" ? "success" : r.kind === "cache_refund" ? "primary" : "info"}>{t(`credit.${r.kind}`)}</Badge> },
    {
      key: "amount",
      header: t("common.amount"),
      align: "right",
      render: (r) => (
        <span className="font-mono tabular-nums">
          {r.kind === "limit_set" && r.amountUsd > 0 ? "+" : ""}
          {fmtUsd(r.amountUsd)}
        </span>
      ),
    },
    {
      key: "used",
      header: t("credit.usedChange"),
      align: "right",
      render: (r) => (
        <span className="font-mono tabular-nums text-on-surface-variant">
          {fmtUsd(r.usedBefore)} → {fmtUsd(r.usedAfter)}
        </span>
      ),
    },
    { key: "limit", header: t("credit.limitAfter"), align: "right", render: (r) => <span className="font-mono tabular-nums">{fmtUsd(r.limitAfter, 2)}</span> },
    { key: "note", header: t("common.note"), render: (r) => <span className="text-on-surface-variant">{r.note || "—"}</span> },
  ];
  return (
    <Async state={state} rows={4}>
      {(p) => (
        <>
          <DataTable columns={columns} rows={p.items} rowKey={(r) => r.id} minWidth={720} loading={state.loading} empty={<EmptyState desc={t("user.wallet.noCreditEvents")} />} />
          <Pagination page={p.page} pageSize={p.pageSize} total={p.total} onPage={setPage} />
        </>
      )}
    </Async>
  );
}

/** cache_refunds history (docs/data-model.md §3): one row per refund run; shared with the admin user detail. */
export function CacheRefundTable({ path, showUser = false }: { path: string; showUser?: boolean }) {
  const { t } = useCT();
  const [page, setPage] = useState(1);
  const state = useAsync(() => api.get<Paged<CacheRefundRow>>(path, { page, pageSize: 20 }), [path, page]);
  const period = (r: CacheRefundRow) => (r.periodFrom && r.periodTo ? `${fmtDateTime(r.periodFrom)} → ${fmtDateTime(r.periodTo)}` : "—");
  const columns: Column<CacheRefundRow>[] = [
    { key: "time", header: t("common.time"), render: (r) => <Mono>{fmtDateTime(r.createdAt)}</Mono> },
    ...(showUser ? [{ key: "user", header: t("common.user"), render: (r: CacheRefundRow) => r.userName ?? <Mono>{r.userId.slice(0, 8)}</Mono> } as Column<CacheRefundRow>] : []),
    { key: "period", header: t("cacheRefund.colPeriod"), render: (r) => <span className="font-mono text-[12px] text-on-surface-variant">{period(r)}</span> },
    { key: "rows", header: t("cacheRefund.colRows"), align: "right", render: (r) => <span className="font-mono tabular-nums">{r.rows}</span> },
    { key: "excess", header: t("cacheRefund.colExcess"), align: "right", render: (r) => <span className="font-mono tabular-nums text-on-surface-variant">{fmtUsd(r.excessUsd)}</span> },
    {
      key: "refund",
      header: t("cacheRefund.colRefund"),
      align: "right",
      render: (r) => (
        <span className="font-mono tabular-nums text-success">
          +{fmtUsd(r.refundUsd)} <span className="text-on-surface-faint">({r.percent}%)</span>
        </span>
      ),
    },
    {
      key: "split",
      header: t("cacheRefund.colSplit"),
      align: "right",
      render: (r) => (
        <span className="font-mono tabular-nums text-on-surface-variant">
          {fmtUsd(r.toCreditUsd)} / {fmtUsd(r.toBalanceUsd)}
        </span>
      ),
    },
    { key: "by", header: t("cacheRefund.colBy"), render: (r) => <Badge tone={r.createdBy === "scheduler" ? "neutral" : "info"}>{r.createdBy === "scheduler" ? t("cacheRefund.byScheduler") : t("cacheRefund.byAdmin")}</Badge> },
  ];
  return (
    <Async state={state} rows={4}>
      {(p) => (
        <>
          <DataTable columns={columns} rows={p.items} rowKey={(r) => r.id} minWidth={860} loading={state.loading} empty={<EmptyState desc={t("user.wallet.cacheRefundNone")} />} />
          <Pagination page={p.page} pageSize={p.pageSize} total={p.total} onPage={setPage} />
        </>
      )}
    </Async>
  );
}

/**
 * Cache-rebuild refund card (docs/data-model.md §3 cache_refunds): why the user is
 * owed something, how much is pending, when the timer pays, totals so far, and a
 * button opening the full history.
 */
function CacheRefundCard({ tick }: { tick: number }) {
  const { t } = useCT();
  const state = useAsync(() => api.get<CacheRefundSummary>("/api/user/cache-refund"), [tick]);
  const [open, setOpen] = useState(false);
  return (
    <Card
      title={t("user.wallet.cacheRefundTitle")}
      desc={t("user.wallet.cacheRefundDesc")}
      actions={
        <Button size="md" onClick={() => setOpen(true)}>
          {t("user.wallet.cacheRefundHistory")}
        </Button>
      }
    >
      <Async state={state} rows={3}>
        {(s) => {
          const hours = Math.max(1, Math.round(s.intervalSec / 3600));
          return (
            <div className="space-y-4">
              <p className="text-[13px] leading-relaxed text-on-surface-variant">{t("user.wallet.cacheRefundExplain", { percent: s.percent, hours })}</p>
              {!s.enabled && <p className="text-[13px] text-warning">{t("user.wallet.cacheRefundDisabled")}</p>}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <StatCard
                  label={t("user.wallet.cacheRefundPending")}
                  value={fmtUsd(s.pending.refundUsd, 4)}
                  sub={s.pending.rows > 0 ? t("user.wallet.cacheRefundPendingSub", { n: s.pending.rows, excess: fmtUsd(s.pending.excessUsd, 4) }) : t("user.wallet.cacheRefundNothingPending")}
                  tone="info"
                />
                <StatCard
                  label={t("user.wallet.cacheRefundNext")}
                  value={<span className="font-mono text-[15px]">{fmtDateTime(s.nextScheduledRunAt)}</span>}
                  sub={t("user.wallet.cacheRefundNextSub", { percent: s.percent, hours })}
                />
                <StatCard
                  label={t("user.wallet.cacheRefundTotal")}
                  value={fmtUsd(s.totals.refundUsd, 4)}
                  sub={t("user.wallet.cacheRefundTotalSub", { runs: s.totals.runs, credit: fmtUsd(s.totals.toCreditUsd, 2), balance: fmtUsd(s.totals.toBalanceUsd, 2) })}
                  tone="success"
                />
              </div>
            </div>
          );
        }}
      </Async>
      <Modal open={open} size="lg" title={t("user.wallet.cacheRefundHistory")} onClose={() => setOpen(false)}>
        <CacheRefundTable path="/api/user/cache-refunds" />
      </Modal>
    </Card>
  );
}

export function UserWallet() {
  const { t } = useCT();
  const toast = useToast();
  const { me, refresh } = useAuth();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);

  async function redeem(e: FormEvent) {
    e.preventDefault();
    if (!code.trim()) return;
    setBusy(true);
    try {
      const r = await api.post<{ valueUsd: number; balanceUsd: number }>("/api/user/redeem", { code: code.trim() });
      toast.success(t("user.wallet.redeemed", { value: fmtUsd(r.valueUsd, 2), balance: fmtUsd(r.balanceUsd, 2) }));
      setCode("");
      setTick((x) => x + 1);
      await refresh();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  const balance = me?.balanceUsd ?? 0;
  const limit = me?.creditLimitUsd ?? 0;
  const used = me?.creditUsedUsd ?? 0;
  const available = me?.availableUsd ?? balance;
  const hasCredit = limit > 0;

  return (
    <>
      <PageHeader title={t("nav.wallet")} desc={t("user.wallet.desc")} />
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <StatCard
          label={hasCredit ? t("shell.available") : t("shell.balance")}
          value={<span className={available <= 0 ? "text-error" : ""}>{fmtUsd(available, 4)}</span>}
          sub={available <= 0 ? (hasCredit ? t("user.wallet.exhausted") : t("user.wallet.negative")) : hasCredit ? t("user.wallet.availableSub") : t("user.wallet.balanceSub")}
          tone="primary"
          icon={<WalletIcon width={16} height={16} />}
        />
        <StatCard label={t("shell.creditLimit")} value={fmtUsd(limit, 2)} sub={t("user.wallet.creditLimitSub")} tone="info" />
        <StatCard label={t("shell.outstanding")} value={<span className={used > 0 ? "text-warning" : ""}>{fmtUsd(used, 4)}</span>} sub={t("user.wallet.outstandingSub")} tone="warning" />
        <StatCard label={t("shell.prepaid")} value={<span className={balance < 0 ? "text-error" : ""}>{fmtUsd(balance, 4)}</span>} sub={t("user.wallet.prepaidSub")} />
      </div>
      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[1fr_1.4fr]">
        <Card title={t("user.wallet.creditTitle")} desc={t("user.wallet.creditDesc")}>
          <p className="text-[13px] leading-relaxed text-on-surface-variant">{hasCredit ? t("user.wallet.creditExplain") : t("user.wallet.noCreditExplain")}</p>
        </Card>
        <Card title={t("user.wallet.redeemTitle")} desc={t("user.wallet.redeemDesc")}>
          <form onSubmit={(e) => void redeem(e)} className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <Field label={t("user.wallet.code")} className="flex-1">
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="XXXXXXXXXXXXXXXXXXXXXXXX"
                className="font-mono tracking-wider"
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
            <Button type="submit" variant="primary" size="md" loading={busy} disabled={!code.trim()}>
              <SparkleIcon width={15} height={15} />
              {t("user.wallet.redeem")}
            </Button>
          </form>
        </Card>
      </div>
      <div className="mt-6">
        <CacheRefundCard tick={tick} />
      </div>
      <div className="mt-6">
        <Card title={t("user.wallet.creditEvents")} desc={t("user.wallet.creditEventsDesc")} bodyClassName="">
          <CreditEventTable path="/api/user/credit-events" />
        </Card>
      </div>
      <div className="mt-6">
        <Card title={t("user.wallet.ledger")} desc={t("user.wallet.ledgerDesc")} bodyClassName="">
          <LedgerTable key={tick} path="/api/user/ledger" />
        </Card>
      </div>
    </>
  );
}
