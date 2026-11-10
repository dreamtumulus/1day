import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ChartIcon, RefreshIcon, ScaleIcon, WalletIcon } from "../../../components/Icon";
import { api, type AdminUser, type CreditEvent, type LedgerRow, type Paged, type Totals, type UsageStats } from "../../api";
import { BarChart, ShareBars } from "../../charts";
import { useCT } from "../../i18n";
import {
  Async,
  Badge,
  Button,
  Card,
  DataTable,
  Field,
  Input,
  PageHeader,
  Segmented,
  Select,
  StatCard,
  errMessage,
  fmtDate,
  fmtDateTime,
  fmtNum,
  fmtPct,
  fmtTokens,
  fmtUsd,
  useAsync,
  useRelTime,
  type Column,
} from "../../ui";
import { ConsumptionPanel } from "./_consumption";

// Finance panel (admin). Read-only: every figure comes from existing admin
// endpoints (/dashboard, /usage/stats, /users, /redeem-codes); usage_logs days
// are UTC on the server, so ranges here are UTC days too.

interface Dashboard {
  today: Totals;
  month: Totals;
  balances: { consumerTotalUsd: number; providerUnsettledUsd: number; creditLimitTotalUsd: number; creditOutstandingUsd: number };
  cacheRefunds: { monthUsd: number; monthRows: number; pendingUsd: number; pendingExcessUsd: number; pendingRows: number; pendingUsers: number; percent: number };
}

interface RedeemCode {
  code: string;
  valueUsd: number;
  status: "unused" | "used" | "disabled" | string;
  batch: string | null;
  usedAt: string | null;
  expiresAt: string | null;
}

type Preset = "today" | "yesterday" | "d7" | "d30" | "month" | "lastMonth" | "all" | "custom";

interface Range {
  from: string; // YYYY-MM-DD (UTC), "" = open
  to: string;
}

const DAY_MS = 86_400_000;

function utcDay(offsetDays = 0, base = Date.now()): string {
  return new Date(base + offsetDays * DAY_MS).toISOString().slice(0, 10);
}

function presetRange(p: Preset): Range {
  const today = utcDay(0);
  const monthStart = `${today.slice(0, 8)}01`;
  switch (p) {
    case "today":
      return { from: today, to: today };
    case "yesterday":
      return { from: utcDay(-1), to: utcDay(-1) };
    case "d7":
      return { from: utcDay(-6), to: today };
    case "d30":
      return { from: utcDay(-29), to: today };
    case "month":
      return { from: monthStart, to: today };
    case "lastMonth": {
      const lastDay = utcDay(-1, Date.parse(`${monthStart}T00:00:00Z`));
      return { from: `${lastDay.slice(0, 8)}01`, to: lastDay };
    }
    default:
      return { from: "", to: "" };
  }
}

function daysIn(r: Range): number {
  if (!r.from || !r.to) return 0;
  return Math.round((Date.parse(`${r.to}T00:00:00Z`) - Date.parse(`${r.from}T00:00:00Z`)) / DAY_MS) + 1;
}

/** The equal-length range right before `r` (for period-over-period). */
function previousRange(r: Range): Range | null {
  const n = daysIn(r);
  if (n <= 0) return null;
  const fromMs = Date.parse(`${r.from}T00:00:00Z`);
  return { from: utcDay(-n, fromMs), to: utcDay(-1, fromMs) };
}

async function allPages<T>(path: string, params: Record<string, string | number>): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= 50; page++) {
    const r = await api.get<Paged<T>>(path, { ...params, page, pageSize: 100 });
    out.push(...r.items);
    if (out.length >= r.total || r.items.length === 0) break;
  }
  return out;
}

function Delta({ now, prev }: { now: number; prev: number | null | undefined }) {
  const { t } = useCT();
  if (prev == null) return null;
  if (prev === 0) return <span className="text-on-surface-faint">{t("admin.finance.vsPrevNone")}</span>;
  const d = (now - prev) / prev;
  const color = d > 0 ? "var(--success)" : d < 0 ? "var(--error)" : "var(--on-surface-faint)";
  return (
    <span style={{ color }} className="font-medium">
      {d > 0 ? "▲" : d < 0 ? "▼" : "■"} {fmtPct(Math.abs(d), 1)}
      <span className="ml-1 font-normal text-on-surface-faint">{t("admin.finance.vsPrev", { v: fmtUsd(prev, 2) })}</span>
    </span>
  );
}

interface CustomerRow extends AdminUser {
  mode: "credit" | "prepaid";
  dailyAvg: number;
  runwayDays: number | null;
}

function toCustomer(u: AdminUser): CustomerRow {
  const ageDays = Math.max(1, Math.ceil((Date.now() - Date.parse(u.createdAt)) / DAY_MS));
  const dailyAvg = u.cost30d / Math.min(30, ageDays);
  return {
    ...u,
    mode: u.creditLimitUsd > 0 ? "credit" : "prepaid",
    dailyAvg,
    runwayDays: dailyAvg > 0 ? Math.max(0, u.availableUsd) / dailyAvg : null,
  };
}

function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadCsv(name: string, header: string[], rows: unknown[][]) {
  const text = "﻿" + [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function AdminFinance() {
  const { t } = useCT();
  const [preset, setPreset] = useState<Preset>("d30");
  const [custom, setCustom] = useState<Range>(presetRange("d30"));
  const [reload, setReload] = useState(0);
  const range = preset === "custom" ? custom : presetRange(preset);
  const prev = previousRange(range);
  const rangeKey = `${range.from}|${range.to}|${reload}`;

  const dash = useAsync(() => api.get<Dashboard>("/api/admin/dashboard"), [reload]);
  const stats = useAsync(() => api.get<UsageStats>("/api/admin/usage/stats", { from: range.from, to: range.to }), [rangeKey]);
  const prevStats = useAsync(
    () => (prev ? api.get<UsageStats>("/api/admin/usage/stats", { from: prev.from, to: prev.to }) : Promise.resolve(null)),
    [rangeKey],
  );
  const users = useAsync(() => allPages<AdminUser>("/api/admin/users", {}), [reload]);
  const codes = useAsync(() => allPages<RedeemCode>("/api/admin/redeem-codes", {}), [reload]);

  const presets: Array<{ value: Preset; label: string }> = (
    ["today", "yesterday", "d7", "d30", "month", "lastMonth", "all", "custom"] as const
  ).map((p) => ({ value: p, label: t(`admin.finance.range.${p}`) }));

  return (
    <>
      <PageHeader
        title={t("admin.finance.title")}
        desc={t("admin.finance.desc")}
        actions={
          <Button onClick={() => setReload((n) => n + 1)}>
            <RefreshIcon className="h-4 w-4" />
            {t("admin.finance.refresh")}
          </Button>
        }
      />

      <div className="space-y-6">
        <Overview dash={dash.data} users={users.data} codes={codes.data} />

        <Card
          title={t("admin.finance.revenueTitle")}
          desc={
            range.from
              ? t("admin.finance.rangeDesc", { from: range.from, to: range.to, n: daysIn(range) })
              : t("admin.finance.rangeAll")
          }
          actions={
            <>
              <div className="hidden lg:block">
                <Segmented<Preset> value={preset} onChange={setPreset} options={presets} />
              </div>
              <Select className="lg:hidden" value={preset} onChange={(e) => setPreset(e.target.value as Preset)} options={presets} />
            </>
          }
        >
          {preset === "custom" && (
            <div className="mb-5 flex flex-wrap items-end gap-3">
              <Field label={t("admin.finance.from")}>
                <Input type="date" value={custom.from} max={custom.to} onChange={(e) => setCustom({ ...custom, from: e.target.value })} />
              </Field>
              <Field label={t("admin.finance.to")}>
                <Input type="date" value={custom.to} min={custom.from} onChange={(e) => setCustom({ ...custom, to: e.target.value })} />
              </Field>
            </div>
          )}
          <Async state={stats} rows={4}>
            {(s) => <RevenuePanel stats={s} prev={prevStats.data ?? null} days={daysIn(range)} />}
          </Async>
        </Card>

        <ConsumptionPanel path="/api/admin/usage/breakdown" by="user" range={range} linkFor={(id) => `/console/admin/users?open=${encodeURIComponent(id)}`} />

        <Async state={stats} rows={3}>
          {(s) => <BreakdownPanel stats={s} />}
        </Async>

        <Async state={users} rows={5}>
          {(list) => <CustomersPanel users={list} />}
        </Async>

        <FundsFlowPanel users={users.data} />

        <Async state={codes} rows={3}>
          {(list) => <RedeemPanel codes={list} />}
        </Async>
      </div>
    </>
  );
}

// ---------- top: money position ----------

function Overview({ dash, users, codes }: { dash: Dashboard | null; users: AdminUser[] | null; codes: RedeemCode[] | null }) {
  const { t } = useCT();
  const today = utcDay(0);
  const dayOfMonth = Number(today.slice(8, 10));
  const daysInMonth = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).getUTCDate();
  // Month run-rate: completed days only, so a fresh UTC day does not drag the projection down.
  const completed = dash ? dash.month.costUsd - dash.today.costUsd : 0;
  const projection = dash && dayOfMonth > 1 ? (completed / (dayOfMonth - 1)) * daysInMonth : null;

  const customers = (users ?? []).filter((u) => u.role !== "provider");
  const creditCustomers = customers.filter((u) => u.creditLimitUsd > 0);
  const prepaid = customers.filter((u) => u.balanceUsd > 0);
  const unusedCodes = (codes ?? []).filter((c) => c.status === "unused");
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard
        label={t("admin.finance.todayRevenue")}
        value={dash ? fmtUsd(dash.today.costUsd, 2) : "…"}
        sub={dash ? t("admin.finance.reqSub", { n: fmtNum(dash.today.requests) }) : undefined}
        tone="primary"
        icon={<WalletIcon className="h-4 w-4" />}
      />
      <StatCard
        label={t("admin.finance.monthRevenue")}
        value={dash ? fmtUsd(dash.month.costUsd, 2) : "…"}
        sub={projection != null ? t("admin.finance.monthProjection", { v: fmtUsd(projection, 0) }) : t("admin.finance.reqSub", { n: fmtNum(dash?.month.requests ?? 0) })}
        tone="success"
        icon={<ChartIcon className="h-4 w-4" />}
      />
      <StatCard
        label={t("admin.finance.receivable")}
        value={dash ? fmtUsd(dash.balances.creditOutstandingUsd, 2) : "…"}
        sub={t("admin.finance.receivableSub", {
          n: creditCustomers.length,
          limit: fmtUsd(dash?.balances.creditLimitTotalUsd ?? 0, 0),
        })}
        tone="info"
        icon={<ScaleIcon className="h-4 w-4" />}
      />
      <StatCard
        label={t("admin.finance.providerPayable")}
        value={dash ? fmtUsd(dash.balances.providerUnsettledUsd, 2) : "…"}
        sub={t("admin.finance.providerPayableSub")}
        tone="warning"
      />
      <StatCard
        label={t("admin.finance.prepaidLiability")}
        value={dash ? fmtUsd(dash.balances.consumerTotalUsd, 2) : "…"}
        sub={t("admin.finance.prepaidLiabilitySub", { n: prepaid.length })}
      />
      <StatCard
        label={t("admin.finance.unusedCodes")}
        value={codes ? fmtUsd(sum(unusedCodes.map((c) => c.valueUsd)), 2) : "…"}
        sub={t("admin.finance.unusedCodesSub", { n: unusedCodes.length })}
      />
      <StatCard
        label={t("admin.finance.creditAvailable")}
        value={users ? fmtUsd(sum(creditCustomers.map((u) => Math.max(0, u.creditLimitUsd - u.creditUsedUsd))), 2) : "…"}
        sub={t("admin.finance.creditAvailableSub")}
      />
      <StatCard
        label={t("admin.finance.spend30d")}
        value={users ? fmtUsd(sum(customers.map((u) => u.cost30d)), 2) : "…"}
        sub={t("admin.finance.spend30dSub", { n: customers.filter((u) => u.cost30d > 0).length })}
      />
      <StatCard
        label={t("admin.finance.cacheRefunds")}
        value={dash ? fmtUsd(dash.cacheRefunds.monthUsd, 2) : "…"}
        sub={t("admin.finance.cacheRefundsSub", {
          rows: fmtNum(dash?.cacheRefunds.monthRows ?? 0),
          pending: fmtUsd(dash?.cacheRefunds.pendingUsd ?? 0, 2),
          users: dash?.cacheRefunds.pendingUsers ?? 0,
        })}
      />
    </div>
  );
}

// ---------- revenue over the selected range ----------

type TrendMetric = "revenue" | "requests" | "cumulative";

function RevenuePanel({ stats, prev, days }: { stats: UsageStats; prev: UsageStats | null; days: number }) {
  const { t } = useCT();
  const [metric, setMetric] = useState<TrendMetric>("revenue");
  const tot = stats.totals;
  const activeDays = days || stats.daily.length || 1;
  const perReq = tot.requests > 0 ? tot.costUsd / tot.requests : 0;
  const tokens = tot.inputTokens + tot.outputTokens + tot.cacheTokens;
  const perMTok = tokens > 0 ? (tot.costUsd / tokens) * 1e6 : 0;
  const best = stats.daily.reduce<UsageStats["daily"][number] | null>((b, d) => (!b || d.costUsd > b.costUsd ? d : b), null);

  let run = 0;
  const series = stats.daily.map((d) => {
    run += d.costUsd;
    return { label: d.day, value: metric === "revenue" ? d.costUsd : metric === "requests" ? d.requests : run };
  });

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-x-6 gap-y-4 lg:grid-cols-5">
        <Figure label={t("admin.finance.periodRevenue")} value={fmtUsd(tot.costUsd, 2)} sub={<Delta now={tot.costUsd} prev={prev?.totals.costUsd} />} big />
        <Figure label={t("admin.finance.dailyAvg")} value={fmtUsd(tot.costUsd / activeDays, 2)} sub={best ? t("admin.finance.bestDay", { d: best.day, v: fmtUsd(best.costUsd, 2) }) : null} />
        <Figure label={t("admin.finance.requests")} value={fmtNum(tot.requests)} sub={prev ? t("admin.finance.prevReq", { n: fmtNum(prev.totals.requests) }) : null} />
        <Figure label={t("admin.finance.perRequest")} value={fmtUsd(perReq, 4)} sub={t("admin.finance.perMTok", { v: fmtUsd(perMTok, 2) })} />
        <Figure label={t("admin.finance.tokens")} value={fmtTokens(tokens)} sub={t("admin.finance.tokensSub", { i: fmtTokens(tot.inputTokens), o: fmtTokens(tot.outputTokens) })} />
      </div>
      <div>
        <div className="mb-2 flex justify-end">
          <Segmented<TrendMetric>
            value={metric}
            onChange={setMetric}
            options={[
              { value: "revenue", label: t("admin.finance.trendRevenue") },
              { value: "cumulative", label: t("admin.finance.trendCumulative") },
              { value: "requests", label: t("admin.finance.trendRequests") },
            ]}
          />
        </div>
        {series.length ? (
          <BarChart data={series} height={200} format={metric === "requests" ? fmtNum : (v) => fmtUsd(v, 2)} color={metric === "requests" ? "var(--info)" : "var(--primary)"} />
        ) : (
          <p className="py-8 text-center text-sm text-on-surface-faint">{t("admin.usage.noData")}</p>
        )}
      </div>
    </div>
  );
}

function Figure({ label, value, sub, big }: { label: string; value: string; sub?: ReactNode; big?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[12px] font-medium uppercase tracking-[0.06em] text-on-surface-faint">{label}</div>
      <div className={`mt-1 font-display font-bold tabular-nums tracking-[-0.02em] text-on-surface ${big ? "text-[28px]" : "text-[20px]"}`}>{value}</div>
      {sub && <div className="mt-0.5 text-[12.5px] text-on-surface-faint">{sub}</div>}
    </div>
  );
}

// ---------- revenue mix ----------

function BreakdownPanel({ stats }: { stats: UsageStats }) {
  const { t } = useCT();
  const total = stats.totals.costUsd;
  const share = (v: number) => (total > 0 ? fmtPct(v / total, 1) : "—");
  const accounts = stats.byAccount ?? [];
  const accTotal = accounts.reduce((a, r) => a + r.costUsd, 0);
  const tok = stats.totals;
  const unsplitWrite = Math.max(0, tok.cacheWriteTokens - (tok.cacheWrite5mTokens ?? 0) - (tok.cacheWrite1hTokens ?? 0));
  const tokRows: Array<[string, number]> = [
    [t("admin.finance.tok.input"), tok.inputTokens],
    [t("admin.finance.tok.output"), tok.outputTokens],
    [t("admin.finance.tok.cacheRead"), tok.cacheReadTokens],
    // cache writes by TTL tier (X-51)
    [t("admin.finance.tok.cacheWrite5m"), tok.cacheWrite5mTokens ?? 0],
    [t("admin.finance.tok.cacheWrite1h"), tok.cacheWrite1hTokens ?? 0],
  ];
  // recorded before the split: one single-price bucket, shown only while the period still contains such rows
  if (unsplitWrite > 0) tokRows.push([t("admin.finance.tok.cacheWrite"), unsplitWrite]);
  const tokSum = tokRows.reduce((a, [, v]) => a + v, 0);

  const accCols: Column<NonNullable<UsageStats["byAccount"]>[number]>[] = [
    { key: "name", header: t("admin.finance.colAccount"), render: (r) => <span className="font-mono text-[12.5px]">{r.name ?? r.accountId.slice(0, 10)}</span> },
    { key: "req", header: t("admin.finance.requests"), align: "right", render: (r) => fmtNum(r.requests) },
    { key: "rev", header: t("admin.finance.colRevenue"), align: "right", render: (r) => <span className="font-semibold">{fmtUsd(r.costUsd, 2)}</span> },
    { key: "share", header: t("admin.finance.colShare"), align: "right", render: (r) => share(r.costUsd) },
  ];

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
      <Card title={t("admin.finance.byModel")} desc={t("admin.finance.byModelDesc")}>
        {stats.byModel.length ? (
          <ShareBars
            items={stats.byModel.slice(0, 12).map((m) => ({ label: m.model, value: m.costUsd, sub: `${share(m.costUsd)} · ${fmtNum(m.requests)} req` }))}
            format={(v) => fmtUsd(v, 2)}
          />
        ) : (
          <p className="py-6 text-center text-sm text-on-surface-faint">{t("common.empty")}</p>
        )}
        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {tokRows.map(([label, v]) => (
            <div key={label} className="rounded-md p-3" style={{ border: "1px solid var(--outline-variant)" }}>
              <div className="text-[12px] text-on-surface-faint">{label}</div>
              <div className="mt-1 font-mono text-[15px] font-semibold tabular-nums">{fmtTokens(v)}</div>
              <div className="text-[11.5px] text-on-surface-faint">{tokSum > 0 ? fmtPct(v / tokSum, 1) : "—"}</div>
            </div>
          ))}
        </div>
      </Card>
      <Card
        title={t("admin.finance.byAccount")}
        desc={t("admin.finance.byAccountDesc", {
          n: accounts.length,
          avg: fmtUsd(accounts.length ? accTotal / accounts.length : 0, 2),
        })}
        bodyClassName="max-h-[520px] overflow-y-auto"
      >
        <DataTable columns={accCols} rows={accounts} rowKey={(r) => r.accountId} minWidth={420} dense />
      </Card>
    </div>
  );
}

// ---------- customers ----------

type CustSort = "spend" | "receivable" | "balance" | "runway";

function CustomersPanel({ users }: { users: AdminUser[] }) {
  const { t } = useCT();
  const rel = useRelTime();
  const [sort, setSort] = useState<CustSort>("spend");
  const [showIdle, setShowIdle] = useState(false);
  const rows = useMemo(() => {
    const list = users
      .filter((u) => u.role !== "provider")
      .map(toCustomer)
      .filter((u) => showIdle || u.cost30d > 0 || u.creditUsedUsd > 0 || u.creditLimitUsd > 0);
    const key: Record<CustSort, (u: CustomerRow) => number> = {
      spend: (u) => -u.cost30d,
      receivable: (u) => -u.creditUsedUsd,
      balance: (u) => -u.balanceUsd,
      runway: (u) => u.runwayDays ?? Infinity,
    };
    return list.sort((a, b) => key[sort](a) - key[sort](b));
  }, [users, sort, showIdle]);

  const runway = (d: number | null) => {
    if (d == null) return <span className="text-on-surface-faint">—</span>;
    if (d > 999) return <span className="text-on-surface-faint">&gt;999 {t("admin.finance.days")}</span>;
    const tone = d < 3 ? "error" : d < 7 ? "warning" : "neutral";
    return tone === "neutral" ? `${d.toFixed(1)} ${t("admin.finance.days")}` : <Badge tone={tone}>{d.toFixed(1)} {t("admin.finance.days")}</Badge>;
  };

  const cols: Column<CustomerRow>[] = [
    {
      key: "name",
      header: t("admin.finance.colCustomer"),
      render: (u) => (
        <div className="min-w-0">
          <Link to={`/console/admin/users?open=${encodeURIComponent(u.id)}`} className="font-medium text-on-surface hover:text-primary hover:underline">
            {u.name}
          </Link>
          <div className="text-[11.5px] text-on-surface-faint">
            {u.role === "admin" ? t("admin.finance.roleAdmin") : u.mode === "credit" ? t("admin.finance.modeCredit") : t("admin.finance.modePrepaid")}
            {u.status === "disabled" && ` · ${t("admin.finance.disabled")}`}
            {u.lastRequestAt && (
              <span title={fmtDateTime(u.lastRequestAt)}> · {t("admin.finance.lastRequest", { t: rel(u.lastRequestAt) })}</span>
            )}
          </div>
        </div>
      ),
    },
    { key: "spend", header: t("admin.finance.colSpend30d"), align: "right", render: (u) => <span className="font-semibold">{fmtUsd(u.cost30d, 2)}</span> },
    { key: "avg", header: t("admin.finance.colDailyAvg"), align: "right", render: (u) => fmtUsd(u.dailyAvg, 2) },
    { key: "limit", header: t("admin.finance.colCreditLimit"), align: "right", render: (u) => (u.creditLimitUsd > 0 ? fmtUsd(u.creditLimitUsd, 2) : "—") },
    {
      key: "used",
      header: t("admin.finance.colReceivable"),
      align: "right",
      render: (u) =>
        u.creditUsedUsd > 0 ? (
          <span style={{ color: u.creditLimitUsd > 0 && u.creditUsedUsd / u.creditLimitUsd >= 0.8 ? "var(--error)" : undefined }} className="font-semibold">
            {fmtUsd(u.creditUsedUsd, 2)}
            {u.creditLimitUsd > 0 && <span className="ml-1 text-[11.5px] font-normal text-on-surface-faint">{fmtPct(u.creditUsedUsd / u.creditLimitUsd)}</span>}
          </span>
        ) : (
          "—"
        ),
    },
    { key: "bal", header: t("admin.finance.colBalance"), align: "right", render: (u) => fmtUsd(u.balanceUsd, 2) },
    { key: "avail", header: t("admin.finance.colAvailable"), align: "right", render: (u) => fmtUsd(u.availableUsd, 2) },
    { key: "runway", header: t("admin.finance.colRunway"), align: "right", render: (u) => runway(u.runwayDays) },
    { key: "settled", header: t("admin.finance.colSettled"), align: "right", render: (u) => (u.mode === "credit" ? fmtDate(u.creditSettledAt) : "—") },
  ];

  const exportCsv = () =>
    downloadCsv(
      `1dayapi-customers-${utcDay(0)}.csv`,
      ["id", "name", "role", "mode", "status", "spend_30d_usd", "daily_avg_usd", "credit_limit_usd", "credit_used_usd", "balance_usd", "available_usd", "runway_days", "credit_settled_at"],
      rows.map((u) => [
        u.id,
        u.name,
        u.role,
        u.mode,
        u.status,
        u.cost30d.toFixed(4),
        u.dailyAvg.toFixed(4),
        u.creditLimitUsd,
        u.creditUsedUsd.toFixed(4),
        u.balanceUsd.toFixed(4),
        u.availableUsd.toFixed(4),
        u.runwayDays == null ? "" : u.runwayDays.toFixed(1),
        u.creditSettledAt ?? "",
      ]),
    );

  return (
    <Card
      title={t("admin.finance.customers")}
      desc={t("admin.finance.customersDesc")}
      bodyClassName=""
      actions={
        <>
          <label className="flex items-center gap-1.5 text-[13px] text-on-surface-variant">
            <input type="checkbox" checked={showIdle} onChange={(e) => setShowIdle(e.target.checked)} />
            {t("admin.finance.showIdle")}
          </label>
          <Segmented<CustSort>
            value={sort}
            onChange={setSort}
            options={(["spend", "receivable", "balance", "runway"] as const).map((v) => ({ value: v, label: t(`admin.finance.sort.${v}`) }))}
          />
          <Button size="sm" onClick={exportCsv}>
            {t("admin.finance.exportCsv")}
          </Button>
        </>
      }
    >
      <DataTable columns={cols} rows={rows} rowKey={(u) => u.id} minWidth={980} />
    </Card>
  );
}

// ---------- money movements (ledger + credit events, on demand) ----------

interface FlowRow {
  id: string;
  at: string;
  user: string;
  kind: string;
  amountUsd: number;
  note: string | null;
}

interface UserDetail {
  recentLedger: LedgerRow[];
  recentCreditEvents: CreditEvent[];
}

function FundsFlowPanel({ users }: { users: AdminUser[] | null }) {
  const { t } = useCT();
  const [rows, setRows] = useState<FlowRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    if (!users) return;
    setBusy(true);
    setError(null);
    try {
      const out: FlowRow[] = [];
      // Sequential on purpose: a handful of light calls, no burst against the console.
      for (const u of users) {
        const d = await api.get<UserDetail>(`/api/admin/users/${u.id}`);
        for (const l of d.recentLedger) out.push({ id: `l-${l.id}`, at: l.createdAt, user: u.name, kind: `ledger.${l.kind}`, amountUsd: l.amountUsd, note: l.note });
        for (const c of d.recentCreditEvents) out.push({ id: `c-${c.id}`, at: c.createdAt, user: u.name, kind: `credit.${c.kind}`, amountUsd: c.amountUsd, note: c.note });
      }
      setRows(out.sort((a, b) => b.at.localeCompare(a.at)));
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const kindLabel = (k: string) => {
    const s = t(`admin.finance.kind.${k}`);
    return s === `admin.finance.kind.${k}` ? k : s;
  };
  const byKind = new Map<string, { n: number; sum: number }>();
  for (const r of rows ?? []) {
    const e = byKind.get(r.kind) ?? { n: 0, sum: 0 };
    e.n++;
    e.sum += r.amountUsd;
    byKind.set(r.kind, e);
  }

  const cols: Column<FlowRow>[] = [
    { key: "at", header: t("admin.finance.colTime"), render: (r) => <span className="font-mono text-[12.5px]">{fmtDateTime(r.at)}</span> },
    { key: "user", header: t("admin.finance.colCustomer"), render: (r) => r.user },
    { key: "kind", header: t("admin.finance.colKind"), render: (r) => <Badge tone={r.kind.startsWith("credit") ? "info" : "neutral"}>{kindLabel(r.kind)}</Badge> },
    {
      key: "amt",
      header: t("admin.finance.colAmount"),
      align: "right",
      render: (r) => <span style={{ color: r.amountUsd < 0 ? "var(--error)" : undefined }} className="font-semibold">{fmtUsd(r.amountUsd, 2)}</span>,
    },
    { key: "note", header: t("admin.finance.colNote"), render: (r) => <span className="text-on-surface-variant">{r.note ?? "—"}</span> },
  ];

  return (
    <Card
      title={t("admin.finance.flows")}
      desc={t("admin.finance.flowsDesc")}
      bodyClassName={rows ? "" : "p-5"}
      actions={
        <Button size="sm" onClick={() => void load()} loading={busy} disabled={!users}>
          {rows ? t("admin.finance.reloadFlows") : t("admin.finance.loadFlows")}
        </Button>
      }
    >
      {error && <p className="px-5 py-3 text-sm text-error">{error}</p>}
      {!rows ? (
        <p className="text-sm text-on-surface-faint">{t("admin.finance.flowsHint")}</p>
      ) : (
        <>
          <div className="flex flex-wrap gap-3 px-5 py-4">
            {[...byKind.entries()].map(([k, v]) => (
              <div key={k} className="rounded-md px-3 py-2" style={{ border: "1px solid var(--outline-variant)" }}>
                <div className="text-[12px] text-on-surface-faint">
                  {kindLabel(k)} · {v.n}
                </div>
                <div className="font-mono text-[15px] font-semibold tabular-nums">{fmtUsd(v.sum, 2)}</div>
              </div>
            ))}
          </div>
          <DataTable columns={cols} rows={rows} rowKey={(r) => r.id} minWidth={760} />
        </>
      )}
    </Card>
  );
}

// ---------- redeem codes ----------

function RedeemPanel({ codes }: { codes: RedeemCode[] }) {
  const { t } = useCT();
  const now = new Date().toISOString();
  const groups = new Map<string, { batch: string; total: number; issued: number; used: number; usedUsd: number; unused: number; unusedUsd: number; other: number }>();
  for (const c of codes) {
    const b = c.batch ?? t("admin.finance.noBatch");
    const g = groups.get(b) ?? { batch: b, total: 0, issued: 0, used: 0, usedUsd: 0, unused: 0, unusedUsd: 0, other: 0 };
    g.total++;
    g.issued += c.valueUsd;
    const expired = c.status === "unused" && !!c.expiresAt && c.expiresAt < now;
    if (c.status === "used") {
      g.used++;
      g.usedUsd += c.valueUsd;
    } else if (c.status === "unused" && !expired) {
      g.unused++;
      g.unusedUsd += c.valueUsd;
    } else g.other++;
    groups.set(b, g);
  }
  const rows = [...groups.values()].sort((a, b) => b.issued - a.issued);
  const cols: Column<(typeof rows)[number]>[] = [
    { key: "batch", header: t("admin.finance.colBatch"), render: (r) => <span className="font-mono text-[12.5px]">{r.batch}</span> },
    { key: "n", header: t("admin.finance.colCodes"), align: "right", render: (r) => fmtNum(r.total) },
    { key: "issued", header: t("admin.finance.colIssued"), align: "right", render: (r) => fmtUsd(r.issued, 2) },
    { key: "used", header: t("admin.finance.colRedeemed"), align: "right", render: (r) => `${fmtUsd(r.usedUsd, 2)} (${r.used})` },
    { key: "unused", header: t("admin.finance.colOutstanding"), align: "right", render: (r) => <span className="font-semibold">{`${fmtUsd(r.unusedUsd, 2)} (${r.unused})`}</span> },
    { key: "other", header: t("admin.finance.colVoid"), align: "right", render: (r) => fmtNum(r.other) },
  ];
  return (
    <Card
      title={t("admin.finance.redeem")}
      desc={t("admin.finance.redeemDesc")}
      bodyClassName=""
      actions={
        <Link to="/console/admin/redeem" className="text-[13px] font-medium text-primary hover:underline">
          {t("admin.dashboard.viewAll")}
        </Link>
      }
    >
      <DataTable columns={cols} rows={rows} rowKey={(r) => r.batch} minWidth={640} />
    </Card>
  );
}
