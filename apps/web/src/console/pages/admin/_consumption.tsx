import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ApiError } from "../../../lib/api";
import { api, type UsageBreakdown, type UsageBreakdownCell, type UsageBreakdownSeries, type BreakdownBucket } from "../../api";
import { BarChart } from "../../charts";
import { useCT } from "../../i18n";
import { Button, Card, DataTable, ErrorState, Loading, Segmented, fmtDateTime, fmtNum, fmtTokens, fmtUsd, useAsync, useRelTime, type Column } from "../../ui";

// Consumption breakdown: spend per hour / day for every customer (finance panel)
// or every key (user detail), from GET …/usage/breakdown. One heat strip per
// series over a shared bucket axis, totals chart on top, per-series detail
// table on demand. Hours are re-labelled in the viewer's local time; days stay
// UTC like the rest of the finance panel.

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** The hour view never spans more than this many UTC days (168 columns). */
export const HOUR_VIEW_DAYS = 7;
const MAX_AXIS = 2000;

export interface ConsumptionRange {
  /** UTC days (YYYY-MM-DD); "" = open-ended. */
  from: string;
  to: string;
}

type Metric = "cost" | "requests";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function isoBucket(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19) + "Z";
}

/** Short axis / chart label: local "MM-DD HH:00" for hours, UTC "YYYY-MM-DD" for days. */
export function bucketLabel(t: string, bucket: BreakdownBucket): string {
  if (bucket === "day") return t.slice(0, 10);
  const d = new Date(t);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:00`;
}

function bucketLong(t: string, bucket: BreakdownBucket): string {
  if (bucket === "day") return `${t.slice(0, 10)} (UTC)`;
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:00`;
}

/** The hour view is clamped to the last HOUR_VIEW_DAYS days of the requested range. */
export function effectiveRange(r: ConsumptionRange, bucket: BreakdownBucket): ConsumptionRange & { capped: boolean } {
  if (bucket === "day") return { ...r, capped: false };
  const to = r.to || utcDay(Date.now());
  const floor = utcDay(Date.parse(`${to}T00:00:00Z`) - (HOUR_VIEW_DAYS - 1) * DAY_MS);
  const from = r.from && r.from > floor ? r.from : floor;
  return { from, to, capped: from !== r.from || to !== r.to };
}

/** Every bucket start in the range (ISO like the server's `t`), never past the current bucket. */
function buildAxis(from: string, to: string, bucket: BreakdownBucket, cells: UsageBreakdownCell[]): string[] {
  const step = bucket === "hour" ? HOUR_MS : DAY_MS;
  const now = Date.now();
  const first = cells.length ? Math.min(...cells.map((c) => Date.parse(c.t))) : now;
  const start = from ? Date.parse(`${from}T00:00:00Z`) : Math.floor(first / step) * step;
  const endReq = to ? Date.parse(`${to}T00:00:00Z`) + DAY_MS : now + step;
  const end = Math.min(endReq, Math.floor(now / step) * step + step);
  const out: string[] = [];
  for (let ms = start; ms < end && out.length < MAX_AXIS; ms += step) out.push(isoBucket(ms));
  return out;
}

interface Tick {
  start: number;
  end: number;
  label: string;
}

/** Axis labels: one per local day (hour view) or every few days (day view), spanning their columns. */
function buildTicks(axis: string[], bucket: BreakdownBucket): Tick[] {
  const ticks: Tick[] = [];
  if (!axis.length) return ticks;
  if (bucket === "hour") {
    let cur: Tick | null = null;
    axis.forEach((t, i) => {
      const d = new Date(t);
      const label = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      if (!cur || cur.label !== label) {
        cur = { start: i, end: i + 1, label };
        ticks.push(cur);
      } else cur.end = i + 1;
    });
    return ticks;
  }
  const step = Math.max(1, Math.ceil(axis.length / 8));
  for (let i = 0; i < axis.length; i += step) ticks.push({ start: i, end: Math.min(axis.length, i + step), label: axis[i].slice(5, 10) });
  return ticks;
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

type Loaded = { kind: "ok"; data: UsageBreakdown } | { kind: "unavailable" };

export function ConsumptionPanel({
  path,
  params = {},
  by,
  range,
  linkFor,
  title,
  desc,
  embedded = false,
  defaultBucket,
}: {
  /** `/api/admin/usage/breakdown` or `/api/user/usage/breakdown`. */
  path: string;
  /** Extra filters (userId, keyId, by…). */
  params?: Record<string, string | undefined>;
  /** What each series is: a customer or a key (labels + link target). */
  by: "user" | "key";
  range: ConsumptionRange;
  linkFor?: (key: string) => string;
  title?: ReactNode;
  desc?: ReactNode;
  /** Inside a modal: no card chrome. */
  embedded?: boolean;
  defaultBucket?: BreakdownBucket;
}) {
  const { t } = useCT();
  const rel = useRelTime();
  const spanDays = range.from && range.to ? Math.round((Date.parse(`${range.to}T00:00:00Z`) - Date.parse(`${range.from}T00:00:00Z`)) / DAY_MS) + 1 : 0;
  const [bucket, setBucket] = useState<BreakdownBucket>(defaultBucket ?? (spanDays > 0 && spanDays <= HOUR_VIEW_DAYS ? "hour" : "day"));
  const [metric, setMetric] = useState<Metric>("cost");
  const [open, setOpen] = useState<string | null>(null);
  const eff = effectiveRange(range, bucket);
  const paramKey = JSON.stringify(params);

  const state = useAsync<Loaded>(
    () =>
      api
        .get<UsageBreakdown>(path, { ...params, bucket, from: eff.from, to: eff.to })
        .then((data): Loaded => ({ kind: "ok", data }))
        .catch((err: unknown) => {
          // Web is served statically; a 404 here means the console behind it predates the endpoint.
          if (err instanceof ApiError && err.status === 404) return { kind: "unavailable" } as Loaded;
          throw err;
        }),
    [path, paramKey, bucket, eff.from, eff.to],
  );

  const view = useMemo(() => {
    if (!state.data || state.data.kind !== "ok") return null;
    const { cells, series } = state.data.data;
    const axis = buildAxis(eff.from, eff.to, bucket, cells);
    const totals = new Map<string, { costUsd: number; requests: number }>();
    for (const c of cells) {
      const e = totals.get(c.t) ?? { costUsd: 0, requests: 0 };
      e.costUsd += c.costUsd;
      e.requests += c.requests;
      totals.set(c.t, e);
    }
    const chart = axis.map((x) => {
      const e = totals.get(x);
      return { label: bucketLabel(x, bucket), value: metric === "cost" ? (e?.costUsd ?? 0) : (e?.requests ?? 0) };
    });
    let peak: { t: string; v: number } | null = null;
    for (const [x, e] of totals) if (!peak || e.costUsd > peak.v) peak = { t: x, v: e.costUsd };
    const bySeries = new Map<string, UsageBreakdownCell[]>();
    for (const c of cells) {
      const list = bySeries.get(c.key) ?? [];
      list.push(c);
      bySeries.set(c.key, list);
    }
    const sum = series.reduce((a, s) => ({ costUsd: a.costUsd + s.costUsd, requests: a.requests + s.requests, errors: a.errors + s.errors, tokens: a.tokens + s.tokens }), {
      costUsd: 0,
      requests: 0,
      errors: 0,
      tokens: 0,
    });
    return { cells, series, axis, ticks: buildTicks(axis, bucket), chart, peak, bySeries, sum };
  }, [state.data, eff.from, eff.to, bucket, metric]);

  const exportCsv = () => {
    if (!view) return;
    const names = new Map(view.series.map((s) => [s.key, s.name ?? s.key]));
    downloadCsv(
      `1dayapi-consumption-${by}-${bucket}-${eff.from || "all"}-${eff.to || utcDay(Date.now())}.csv`,
      ["bucket_utc", "bucket_local", by === "user" ? "user" : "key", "id", "requests", "errors", "cost_usd", "tokens", "last_request_at"],
      view.cells.map((c) => [c.t, bucketLong(c.t, bucket), names.get(c.key) ?? "", c.key, c.requests, c.errors, c.costUsd.toFixed(6), c.tokens, c.lastAt]),
    );
  };

  const controls = (
    <>
      <Segmented<BreakdownBucket>
        value={bucket}
        onChange={(b) => {
          setBucket(b);
          setOpen(null);
        }}
        options={[
          { value: "hour", label: t("breakdown.bucket.hour") },
          { value: "day", label: t("breakdown.bucket.day") },
        ]}
      />
      <Segmented<Metric>
        value={metric}
        onChange={setMetric}
        options={[
          { value: "cost", label: t("breakdown.metric.cost") },
          { value: "requests", label: t("breakdown.metric.requests") },
        ]}
      />
      <Button size="sm" onClick={exportCsv} disabled={!view || view.cells.length === 0}>
        {t("breakdown.export")}
      </Button>
    </>
  );

  let body: ReactNode;
  if (state.error && !state.data) body = <ErrorState message={state.error} onRetry={state.reload} />;
  else if (!state.data) body = <Loading rows={4} />;
  else if (state.data.kind === "unavailable") body = <p className="py-6 text-center text-sm text-on-surface-faint">{t("breakdown.unavailable")}</p>;
  else if (!view || view.cells.length === 0) body = <p className="py-8 text-center text-sm text-on-surface-faint">{t("breakdown.empty")}</p>;
  else {
    const v = view;
    const seriesLabel = t(`breakdown.series.${by}`);
    const cols = `repeat(${v.axis.length}, minmax(0, 1fr))`;
    const detailCols: Column<UsageBreakdownCell>[] = [
      { key: "t", header: t("breakdown.colTime"), render: (c) => <span className="font-mono text-[12.5px]">{bucketLong(c.t, bucket)}</span> },
      {
        key: "req",
        header: t("breakdown.colRequests"),
        align: "right",
        render: (c) => (
          <span className="font-mono tabular-nums">
            {fmtNum(c.requests)}
            {c.errors > 0 && <span className="ml-1.5 text-[11.5px] text-error">· {t("breakdown.errors", { n: fmtNum(c.errors) })}</span>}
          </span>
        ),
      },
      { key: "cost", header: t("breakdown.colCost"), align: "right", render: (c) => <span className="font-mono font-semibold tabular-nums">{fmtUsd(c.costUsd)}</span> },
      { key: "tok", header: t("breakdown.colTokens"), align: "right", render: (c) => <span className="font-mono tabular-nums">{fmtTokens(c.tokens)}</span> },
      { key: "last", header: t("breakdown.colLast"), render: (c) => <span className="font-mono text-[12.5px] text-on-surface-variant">{fmtDateTime(c.lastAt)}</span> },
    ];
    body = (
      <div className="space-y-5">
        {eff.capped && <p className="text-[12.5px] text-on-surface-faint">{t("breakdown.hourCap", { n: HOUR_VIEW_DAYS, from: eff.from, to: eff.to })}</p>}
        <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
          <Figure label={t("breakdown.total")} value={fmtUsd(v.sum.costUsd, 2)} />
          <Figure
            label={t("breakdown.colRequests")}
            value={fmtNum(v.sum.requests)}
            sub={v.sum.errors > 0 ? <span className="text-error">{t("breakdown.errors", { n: fmtNum(v.sum.errors) })}</span> : undefined}
          />
          <Figure label={t(`breakdown.series.${by}`)} value={fmtNum(v.series.length)} sub={t(`breakdown.active.${by}`, { n: v.series.length })} />
          <Figure label={t("breakdown.peakLabel")} value={v.peak ? fmtUsd(v.peak.v, 2) : "—"} sub={v.peak ? bucketLong(v.peak.t, bucket) : undefined} />
        </div>
        <BarChart data={v.chart} height={150} format={metric === "requests" ? fmtNum : (x) => fmtUsd(x, 2)} color={metric === "requests" ? "var(--info)" : "var(--primary)"} />

        <div className="-mx-5 overflow-hidden border-t border-outline-variant">
          {/* header: series label + figure captions, then the shared time axis */}
          <div className="flex items-end justify-between gap-4 px-5 pb-1 pt-3 text-[11px] font-medium uppercase tracking-[0.06em] text-on-surface-faint">
            <div>{seriesLabel}</div>
            <div className="hidden gap-4 sm:flex">
              <span className="w-20 text-right">{t("breakdown.colCost")}</span>
              <span className="w-24 text-right">{t("breakdown.colRequests")}</span>
              <span className="w-16 text-right">{t("breakdown.colTokens")}</span>
              <span className="w-14" />
            </div>
          </div>
          <div className="grid px-5 pb-1 font-mono text-[10.5px] text-on-surface-faint" style={{ gridTemplateColumns: cols }}>
            {v.ticks.map((k) => (
              <div key={k.start} className="truncate border-l border-outline-variant pl-1" style={{ gridColumn: `${k.start + 1} / ${k.end + 1}` }}>
                {k.label}
              </div>
            ))}
          </div>
          {v.series.map((s) => (
            <SeriesRow
              key={s.key}
              s={s}
              cells={v.bySeries.get(s.key) ?? []}
              axis={v.axis}
              cols={cols}
              bucket={bucket}
              metric={metric}
              open={open === s.key}
              onToggle={() => setOpen(open === s.key ? null : s.key)}
              link={linkFor?.(s.key)}
              rel={rel}
              detailCols={detailCols}
            />
          ))}
          <div className="px-5 pt-3 text-[11.5px] text-on-surface-faint">
            {t("breakdown.legend", { bucket: t(`breakdown.legend.${bucket}`) })} {t("breakdown.timeNote")}
          </div>
        </div>
      </div>
    );
  }

  if (embedded) {
    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">{controls}</div>
        <div className="px-5">{body}</div>
      </div>
    );
  }
  return (
    <Card title={title ?? t("breakdown.title")} desc={desc ?? t(`breakdown.desc.${by}`)} actions={controls}>
      {body}
    </Card>
  );
}

function Figure({ label, value, sub }: { label: string; value: string; sub?: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[12px] font-medium uppercase tracking-[0.06em] text-on-surface-faint">{label}</div>
      <div className="mt-1 font-display text-[20px] font-bold tabular-nums tracking-[-0.02em] text-on-surface">{value}</div>
      {sub && <div className="mt-0.5 text-[12.5px] text-on-surface-faint">{sub}</div>}
    </div>
  );
}

function SeriesRow({
  s,
  cells,
  axis,
  cols,
  bucket,
  metric,
  open,
  onToggle,
  link,
  rel,
  detailCols,
}: {
  s: UsageBreakdownSeries;
  cells: UsageBreakdownCell[];
  axis: string[];
  cols: string;
  bucket: BreakdownBucket;
  metric: Metric;
  open: boolean;
  onToggle: () => void;
  link?: string;
  rel: (iso: string | null | undefined) => string;
  detailCols: Column<UsageBreakdownCell>[];
}) {
  const { t } = useCT();
  const byT = useMemo(() => new Map(cells.map((c) => [c.t, c])), [cells]);
  const pick = (c: UsageBreakdownCell) => (metric === "cost" ? c.costUsd : c.requests);
  const max = Math.max(0, ...cells.map(pick));
  const name = s.name ?? t("breakdown.deleted");
  const nameEl = link ? (
    <Link to={link} className="truncate font-medium text-on-surface hover:text-primary hover:underline" onClick={(e) => e.stopPropagation()}>
      {name}
    </Link>
  ) : (
    <span className="truncate font-medium text-on-surface">{name}</span>
  );
  return (
    <div className="border-t border-outline-variant" style={open ? { background: "color-mix(in oklab, var(--primary-soft) 60%, transparent)" } : undefined}>
      <div className="cursor-pointer px-5 py-2.5 hover:bg-surface-variant" onClick={onToggle}>
        <div className="mb-1.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <div className="min-w-0 truncate text-[13.5px]">{nameEl}</div>
            <div className="text-[11.5px] text-on-surface-faint" title={s.lastAt ? fmtDateTime(s.lastAt) : undefined}>
              {t("breakdown.colLast")} · {s.lastAt ? rel(s.lastAt) : "—"}
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2 font-mono text-[12.5px] tabular-nums sm:gap-4">
            <span className="w-20 text-right font-semibold text-on-surface">{fmtUsd(s.costUsd, 2)}</span>
            <span className="w-24 text-right text-on-surface-variant">
              {fmtNum(s.requests)}
              {s.errors > 0 && <span className="ml-1 text-[11px] text-error">+{fmtNum(s.errors)}</span>}
            </span>
            <span className="w-16 text-right text-on-surface-variant">{fmtTokens(s.tokens)}</span>
            <Button
              size="sm"
              className="w-14 justify-center"
              onClick={(e) => {
                e.stopPropagation();
                onToggle();
              }}
            >
              {open ? t("breakdown.hide") : t("breakdown.details")}
            </Button>
          </div>
        </div>
        <div className="grid h-[20px] gap-px" style={{ gridTemplateColumns: cols }} aria-hidden>
          {axis.map((x) => {
            const c = byT.get(x);
            const val = c ? pick(c) : 0;
            const share = val > 0 && max > 0 ? Math.sqrt(val / max) : 0;
            return (
              <div
                key={x}
                className="rounded-[2px]"
                title={c ? `${bucketLong(x, bucket)} · ${fmtUsd(c.costUsd)} · ${fmtNum(c.requests)} req${c.errors ? ` · ${t("breakdown.errors", { n: c.errors })}` : ""}` : bucketLong(x, bucket)}
                style={{ background: share > 0 ? `color-mix(in oklab, var(--primary) ${Math.round(18 + 82 * share)}%, var(--surface-variant))` : "var(--surface-variant)" }}
              />
            );
          })}
        </div>
      </div>
      {open && (
        <div className="border-t border-outline-variant" style={{ background: "color-mix(in oklab, var(--surface-container-low) 55%, transparent)" }}>
          <DataTable columns={detailCols} rows={[...cells].sort((a, b) => b.t.localeCompare(a.t))} rowKey={(c) => c.t} minWidth={520} dense />
        </div>
      )}
    </div>
  );
}
