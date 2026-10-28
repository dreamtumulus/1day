import { useMemo, useState } from "react";
import { api, type ErrorSummary, type Paged, type UsageRow } from "../../api";
import { PathBadge } from "./_path";
import { BarChart, ShareBars } from "../../charts";
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
  PageHeader,
  Pagination,
  Select,
  StatCard,
  Toolbar,
  fmtDateTime,
  fmtNum,
  fmtPct,
  localDay,
  useAsync,
  type Column,
} from "../../ui";

type Range = "today" | "7d" | "30d" | "custom";

interface Filters {
  range: Range;
  from: string;
  to: string;
  code: string;
  mode: string;
  accountId: string;
  q: string;
}

function ms(n: number | null): string {
  if (n == null) return "—";
  return n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${n}ms`;
}

function rangeDates(r: Range, from: string, to: string): { from: string; to: string } {
  if (r === "today") return { from: localDay(0), to: localDay(0) };
  if (r === "7d") return { from: localDay(-6), to: localDay(0) };
  if (r === "30d") return { from: localDay(-29), to: localDay(0) };
  return { from, to };
}

const MODE_KEYS = ["passthrough-anthropic", "passthrough-openai", "passthrough-responses", "chat-via-anthropic", "anthropic-via-chat", "ccr-anthropic", "ccr-chat"];

export function AdminErrors() {
  const { t } = useCT();
  const initial: Filters = { range: "7d", from: localDay(-6), to: localDay(0), code: "", mode: "", accountId: "", q: "" };
  const [draft, setDraft] = useState<Filters>(initial);
  const [f, setF] = useState<Filters>(initial);
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<UsageRow | null>(null);

  const accounts = useAsync(() => api.get<Paged<{ id: string; executor: string }>>("/api/admin/accounts", { pageSize: 200 }));
  const executorOf = (id: string | null | undefined) => accounts.data?.items.find((a) => a.id === id)?.executor ?? null;
  const modeLabel = (m: string | null) => (m && MODE_KEYS.includes(m) ? t(`admin.errors.mode.${m}`) : m ?? t("admin.errors.mode.none"));
  const dates = useMemo(() => rangeDates(f.range, f.from, f.to), [f]);
  const params = { ...dates, status: "error", code: f.code, mode: f.mode, accountId: f.accountId, q: f.q };

  const summary = useAsync(() => api.get<ErrorSummary>("/api/admin/errors/summary", { ...dates, code: f.code, mode: f.mode, accountId: f.accountId, q: f.q }), [f]);
  const list = useAsync(() => api.get<Paged<UsageRow>>("/api/admin/usage", { page, pageSize: 25, ...params }), [f, page]);

  const apply = (next: Filters) => {
    setF(next);
    setPage(1);
  };


  const columns: Column<UsageRow>[] = [
    {
      key: "time",
      header: t("admin.errors.colTime"),
      render: (r) => <span className="whitespace-nowrap font-mono text-[12.5px] text-on-surface-variant">{fmtDateTime(r.createdAt)}</span>,
    },
    {
      key: "result",
      header: t("admin.errors.colResult"),
      render: (r) => (
        <div className="flex flex-col items-start gap-1">
          <Badge tone={r.statusCode >= 500 ? "error" : "warning"}>{r.statusCode}</Badge>
          {r.errorCode && <span className="font-mono text-[11.5px] text-error">{r.errorCode}</span>}
        </div>
      ),
    },
    {
      key: "message",
      header: t("admin.errors.colMessage"),
      render: (r) => (
        <button type="button" className="block max-w-[380px] text-left" onClick={() => setOpen(r)} title={r.errorMessage ?? ""}>
          <span className="line-clamp-2 text-[12.5px] leading-snug text-on-surface">{r.errorMessage ?? "—"}</span>
          {r.upstreamStatus != null && <span className="mt-0.5 block font-mono text-[11px] text-on-surface-faint">upstream {r.upstreamStatus}</span>}
        </button>
      ),
    },
    {
      key: "who",
      header: t("admin.errors.colWho"),
      render: (r) => (
        <div className="max-w-[150px]">
          <div className="truncate text-[13px]" title={r.userName ?? r.userId}>{r.userName ?? r.userId?.slice(0, 8) ?? "—"}</div>
          <div className="truncate text-[12px] text-on-surface-faint">{r.keyName ?? "—"}</div>
        </div>
      ),
    },
    {
      key: "model",
      header: t("admin.errors.colModel"),
      render: (r) => (
        <div>
          <div className="font-mono text-[12.5px]">{r.model}</div>
          <div className="font-mono text-[11.5px] text-on-surface-faint">{r.endpoint.replace("/v1/", "")}{r.stream ? " · stream" : ""}</div>
        </div>
      ),
    },
    { key: "mode", header: t("admin.errors.colPath"), render: (r) => <PathBadge row={r} executor={executorOf(r.accountId)} t={t} /> },
    {
      key: "account",
      header: t("admin.errors.colAccount"),
      render: (r) => (
        <div className="max-w-[160px]">
          <div className="truncate text-[13px]" title={r.accountName ?? ""}>{r.accountName ?? "—"}</div>
          {r.nodeId && <div className="truncate font-mono text-[11.5px] text-on-surface-faint" title={r.nodeId}>node …{r.nodeId.slice(-8)}</div>}
        </div>
      ),
    },
    { key: "latency", header: t("admin.errors.colLatency"), align: "right", render: (r) => <span className="font-mono text-[12.5px] tabular-nums">{ms(r.durationMs)}</span> },
    {
      key: "act",
      header: "",
      align: "right",
      render: (r) => (
        <Button size="sm" onClick={() => setOpen(r)}>
          {t("admin.errors.details")}
        </Button>
      ),
    },
  ];

  const codeOptions = [{ value: "", label: t("admin.errors.allCodes") }, ...(summary.data?.byCode ?? []).filter((c) => c.code !== "(none)").map((c) => ({ value: c.code, label: `${c.code} (${c.count})` }))];
  const accountOptions = [
    { value: "", label: t("admin.errors.allAccounts") },
    ...(summary.data?.byAccount ?? []).filter((a) => a.accountId).map((a) => ({ value: a.accountId as string, label: `${a.name ?? a.accountId!.slice(0, 8)} (${a.count})` })),
  ];
  const modeOptions = [{ value: "", label: t("admin.errors.allModes") }, ...MODE_KEYS.map((m) => ({ value: m, label: modeLabel(m) }))];

  const detailRows = (r: UsageRow): Array<[string, React.ReactNode]> => [
    [t("admin.errors.requestId"), <span className="font-mono text-[12px]">{r.requestId}</span>],
    [t("admin.errors.colTime"), fmtDateTime(r.createdAt)],
    [t("admin.errors.colWho"), `${r.userName ?? r.userId ?? "—"} · ${r.keyName ?? "—"}`],
    [t("admin.errors.colModel"), <span className="font-mono text-[12px]">{r.model}{r.upstreamModel && r.upstreamModel !== r.model ? ` → ${r.upstreamModel}` : ""} · {r.endpoint}{r.stream ? " · stream" : ""}</span>],
    [t("admin.errors.colPath"), <span><PathBadge row={r} executor={executorOf(r.accountId)} t={t} /> <span className="ml-2 font-mono text-[11px] text-on-surface-faint">{r.mode ?? ""}</span></span>],
    [t("admin.errors.colAccount"), `${r.accountName ?? "—"}${r.nodeId ? ` · node …${r.nodeId.slice(-8)}` : ""}`],
    [t("admin.errors.colResult"), <span><Badge tone={r.statusCode >= 500 ? "error" : "warning"}>{r.statusCode}</Badge> <span className="ml-2 font-mono text-[12px] text-error">{r.errorCode ?? ""}</span></span>],
    [t("admin.errors.upstream"), r.upstreamStatus != null ? <span className="font-mono text-[12px]">HTTP {r.upstreamStatus}</span> : <span className="text-on-surface-faint">{t("admin.errors.upstreamNone")}</span>],
    [t("admin.errors.colLatency"), `${ms(r.durationMs)}${r.firstTokenMs != null ? ` / ttfb ${ms(r.firstTokenMs)}` : ""}`],
    [t("admin.errors.ccShape"), r.ccShape ?? "—"],
  ];

  return (
    <div>
      <PageHeader title={t("admin.errors.title")} desc={t("admin.errors.desc")} />

      <Card bodyClassName="p-0" className="mb-6">
        <Toolbar>
          <form
            className="flex w-full flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              apply({ ...draft, q: draft.q.trim() });
            }}
          >
            <Field label={t("admin.errors.range")} className="w-[calc(50%-6px)] sm:w-40">
              <Select
                value={draft.range}
                onChange={(e) => setDraft({ ...draft, range: e.target.value as Range })}
                options={[
                  { value: "today", label: t("admin.errors.rangeToday") },
                  { value: "7d", label: t("admin.errors.range7d") },
                  { value: "30d", label: t("admin.errors.range30d") },
                  { value: "custom", label: t("admin.errors.rangeCustom") },
                ]}
              />
            </Field>
            {draft.range === "custom" && (
              <>
                <Field label={t("common.from")} className="w-[calc(50%-6px)] sm:w-40">
                  <Input type="date" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
                </Field>
                <Field label={t("common.to")} className="w-[calc(50%-6px)] sm:w-40">
                  <Input type="date" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
                </Field>
              </>
            )}
            <Field label={t("admin.errors.code")} className="w-full sm:w-56">
              <Select value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value })} options={codeOptions} />
            </Field>
            <Field label={t("admin.errors.mode")} className="w-full sm:w-56">
              <Select value={draft.mode} onChange={(e) => setDraft({ ...draft, mode: e.target.value })} options={modeOptions} />
            </Field>
            <Field label={t("admin.errors.account")} className="w-full sm:w-56">
              <Select value={draft.accountId} onChange={(e) => setDraft({ ...draft, accountId: e.target.value })} options={accountOptions} />
            </Field>
            <Field label={t("admin.errors.search")} className="w-full sm:w-64">
              <Input value={draft.q} onChange={(e) => setDraft({ ...draft, q: e.target.value })} placeholder={t("admin.errors.searchPh")} />
            </Field>
            <Button type="submit" variant="primary">
              {t("common.filter")}
            </Button>
            <Button
              onClick={() => {
                setDraft(initial);
                apply(initial);
              }}
            >
              {t("common.reset")}
            </Button>
          </form>
        </Toolbar>
      </Card>

      <Async state={summary} rows={4}>
        {(s) => {
          const rate = s.totalRequests ? s.totalErrors / s.totalRequests : 0;
          const top = s.byCode[0];
          return (
            <div className="mb-6 space-y-6">
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <StatCard label={t("admin.errors.statTotal")} value={fmtNum(s.totalErrors)} tone={s.totalErrors ? "error" : "neutral"} />
                <StatCard
                  label={t("admin.errors.statRate")}
                  value={fmtPct(rate, 2)}
                  sub={t("admin.errors.statRateSub", { errors: fmtNum(s.totalErrors), total: fmtNum(s.totalRequests) })}
                  tone={rate > 0.05 ? "error" : rate > 0.01 ? "warning" : "success"}
                />
                <StatCard label={t("admin.errors.statTopCode")} value={top ? <span className="font-mono text-[18px]">{top.code}</span> : "—"} sub={top ? `${fmtNum(top.count)} · HTTP ${top.statusCode}` : undefined} tone="warning" />
                <StatCard label={t("admin.errors.statAccounts")} value={fmtNum(s.byAccount.filter((a) => a.accountId).length)} tone="info" />
              </div>
              <Card title={t("admin.errors.hourly")}>
                {s.hourly.length ? (
                  <BarChart data={s.hourly.slice(-48).map((h) => ({ label: h.hour.slice(5, 13).replace("T", " "), value: h.count }))} format={(v) => fmtNum(v)} />
                ) : (
                  <EmptyState title={t("admin.errors.noData")} />
                )}
              </Card>
              <div className="grid gap-6 lg:grid-cols-3">
                <Card title={t("admin.errors.byCode")}>
                  {s.byCode.length ? <ShareBars items={s.byCode.map((c) => ({ label: c.code, value: c.count, sub: `HTTP ${c.statusCode}` }))} format={(v) => fmtNum(v)} /> : <EmptyState title={t("admin.errors.noData")} />}
                </Card>
                <Card title={t("admin.errors.byAccount")}>
                  {s.byAccount.length ? <ShareBars items={s.byAccount.map((a) => ({ label: a.name ?? (a.accountId ? a.accountId.slice(0, 8) : t("admin.errors.mode.none")), value: a.count }))} format={(v) => fmtNum(v)} /> : <EmptyState title={t("admin.errors.noData")} />}
                </Card>
                <Card title={t("admin.errors.byMode")}>
                  {s.byMode.length ? <ShareBars items={s.byMode.map((m) => ({ label: modeLabel(m.mode === "(none)" ? null : m.mode), value: m.count }))} format={(v) => fmtNum(v)} /> : <EmptyState title={t("admin.errors.noData")} />}
                </Card>
              </div>
            </div>
          );
        }}
      </Async>

      <Card bodyClassName="p-0">
        <Async state={list} rows={8}>
          {(d) => (
            <>
              <DataTable columns={columns} rows={d.items} rowKey={(r) => r.id} minWidth={1240} loading={list.loading} empty={<EmptyState title={t("admin.errors.empty")} />} />
              <Pagination page={d.page} pageSize={d.pageSize} total={d.total} onPage={setPage} />
            </>
          )}
        </Async>
      </Card>

      <Modal open={!!open} title={t("admin.errors.detailTitle")} onClose={() => setOpen(null)} size="lg">
        {open && (
          <div className="space-y-4">
            <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-[13px] sm:grid-cols-[160px_1fr]">
              {detailRows(open).map(([k, v]) => (
                <div key={String(k)} className="contents">
                  <dt className="text-on-surface-faint">{k}</dt>
                  <dd className="min-w-0 break-words text-on-surface">{v}</dd>
                </div>
              ))}
            </dl>
            <div>
              <div className="mb-1 text-[12px] font-medium text-on-surface-faint">{t("admin.errors.message")}</div>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-container p-3 font-mono text-[12px] leading-relaxed text-on-surface">{open.errorMessage ?? "—"}</pre>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
