import { useState } from "react";
import { api, type AdminUser, type Paged, type UsageRow, type UsageStats } from "../../api";
import { PathBadge } from "./_path";
import { ShareBars } from "../../charts";
import { useCT } from "../../i18n";
import {
  Async,
  Badge,
  Button,
  Card,
  CopyIconButton,
  DataTable,
  DetailGrid,
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
  fmtTokens,
  fmtUsd,
  localDay,
  useAsync,
  type Column,
} from "../../ui";

interface Filters {
  from: string;
  to: string;
  userId: string;
  model: string;
  status: string;
}

function ms(n: number | null): string {
  if (n == null) return "—";
  return n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${n}ms`;
}

/** Cache hit rate: reads / (reads + uncached input). null when no input at all. */
function cacheHit(read: number, input: number): number | null {
  const total = read + input;
  return total > 0 ? read / total : null;
}

function hitText(read: number, input: number): string {
  const h = cacheHit(read, input);
  return h == null ? "—" : `${(h * 100).toFixed(1)}%`;
}

export function AdminUsage() {
  const { t } = useCT();
  const initial: Filters = { from: localDay(-6), to: localDay(0), userId: "", model: "", status: "" };
  const [draft, setDraft] = useState<Filters>(initial);
  const [f, setF] = useState<Filters>(initial);
  const [page, setPage] = useState(1);

  const users = useAsync(() => api.get<Paged<AdminUser>>("/api/admin/users", { pageSize: 100 }));
  // accountId -> executor, so a CCR mode can be shown as worker vs cloud session.
  const accounts = useAsync(() => api.get<Paged<{ id: string; executor: string }>>("/api/admin/accounts", { pageSize: 200 }));
  const executorOf = (id: string | null | undefined) => accounts.data?.items.find((a) => a.id === id)?.executor ?? null;
  const stats = useAsync(
    () => api.get<UsageStats>("/api/admin/usage/stats", { from: f.from, to: f.to, userId: f.userId, model: f.model, status: f.status }),
    [f],
  );
  const list = useAsync(
    () => api.get<Paged<UsageRow>>("/api/admin/usage", { page, pageSize: 20, ...f }),
    [f, page],
  );

  const apply = (next: Filters) => {
    setF(next);
    setPage(1);
  };

  const num = "font-mono text-[12.5px] tabular-nums";
  const faint = "text-on-surface-faint";
  const columns: Column<UsageRow>[] = [
    {
      key: "time",
      header: t("admin.usage.colTime"),
      render: (r) => {
        const s = fmtDateTime(r.createdAt);
        return (
          <div className="whitespace-nowrap font-mono text-[12px] leading-[17px] text-on-surface-variant">
            <div>{s.slice(0, 10)}</div>
            <div className="text-on-surface">{s.slice(11)}</div>
          </div>
        );
      },
    },
    {
      key: "req",
      header: t("admin.usage.colRequest"),
      render: (r) => (
        <div className="min-w-[150px] max-w-[210px]">
          <div className="flex flex-wrap items-center gap-1.5">
            <Mono title={r.requestId}>{r.requestId.slice(0, 8)}</Mono>
            {r.statusCode < 300 ? (
              <Badge tone="success">{r.statusCode}</Badge>
            ) : (
              <Badge tone={r.statusCode >= 500 ? "error" : "warning"} title={r.errorMessage ?? undefined}>
                {r.statusCode}
                {r.errorCode ? ` · ${r.errorCode}` : ""}
              </Badge>
            )}
            {r.ccShape === "suspect" && (
              <Badge tone="error" title={t("admin.usage.ccSuspectTip")}>
                {t("admin.usage.ccSuspect")}
              </Badge>
            )}
          </div>
          <div className={`mt-0.5 truncate text-[12px] ${faint}`} title={`${r.userName ?? r.userId ?? ""}${r.keyName ? ` · ${r.keyName}` : ""}`}>
            {r.userName ?? r.userId?.slice(0, 8) ?? "—"}
            {r.keyName ? ` · ${r.keyName}` : ""}
          </div>
        </div>
      ),
    },
    {
      key: "model",
      header: t("admin.usage.colModel"),
      render: (r) => (
        <div className="max-w-[200px]">
          <div className="truncate font-mono text-[12.5px]" title={r.model}>
            {r.model}
          </div>
          {r.upstreamModel && r.upstreamModel !== r.model && (
            <div className={`truncate font-mono text-[11.5px] ${faint}`} title={r.upstreamModel}>
              {t("admin.usage.upstreamAs", { model: r.upstreamModel })}
            </div>
          )}
          <div className={`mt-0.5 flex gap-1 text-[11.5px] ${faint}`}>
            <span className="font-mono">{r.endpoint.replace("/v1/", "")}</span>
            {r.stream && <span>· {t("common.stream")}</span>}
          </div>
        </div>
      ),
    },
    {
      key: "tokens",
      header: t("admin.usage.colTokensShort"),
      align: "right",
      render: (r) => (
        <div className={num}>
          <div className="whitespace-nowrap">
            {fmtTokens(r.inputTokens)}
            <span className={faint}> / </span>
            {fmtTokens(r.outputTokens)}
            {r.usageEstimated && (
              <span className="ml-1 text-warning" title={t("admin.usage.estimatedTip")}>
                ≈
              </span>
            )}
          </div>
          <div className={`text-[11.5px] ${faint}`} title={t("admin.usage.colCacheRW")}>
            {t("admin.usage.cacheAbbr")} {fmtTokens(r.cacheReadTokens)} / {fmtTokens(r.cacheWriteTokens)}
            {cacheHit(r.cacheReadTokens, r.inputTokens) != null && <span> · {hitText(r.cacheReadTokens, r.inputTokens)}</span>}
          </div>
        </div>
      ),
    },
    {
      key: "cost",
      header: t("admin.usage.colCharged"),
      align: "right",
      render: (r) => (
        <div className={num}>
          <div className="whitespace-nowrap font-semibold">{fmtUsd(r.actualCost)}</div>
          <div className={`text-[11.5px] ${faint}`}>
            {r.rateMultiplier !== 1 ? `${fmtUsd(r.totalCost ?? 0)} ×${r.rateMultiplier}` : r.providerEarning ? `→ ${fmtUsd(r.providerEarning)}` : "\u00a0"}
          </div>
        </div>
      ),
    },
    {
      key: "latency",
      header: t("admin.usage.colLatency"),
      align: "right",
      render: (r) => (
        <div className={num}>
          <div className="whitespace-nowrap">{ms(r.durationMs)}</div>
          <div className={`whitespace-nowrap text-[11.5px] ${faint}`} title={t("admin.usage.ttftTip")}>
            {t("admin.usage.ttftAbbr")} {ms(r.firstTokenMs)}
          </div>
        </div>
      ),
    },
    {
      key: "account",
      header: t("admin.usage.colProviderAccount"),
      render: (r) => (
        <div className="min-w-[150px] max-w-[210px]">
          <div className="flex items-center gap-1.5">
            <PathBadge row={r} executor={executorOf(r.accountId)} t={t} />
            <span className="truncate text-[12.5px]" title={r.accountName ?? ""}>
              {r.accountName ?? "—"}
            </span>
          </div>
          <div className={`mt-0.5 truncate font-mono text-[11.5px] ${faint}`} title={r.nodeId ?? ""}>
            {r.providerName ? `${r.providerName} · ` : ""}
            {r.nodeId ? r.nodeId.slice(0, 13) : t("admin.usage.directBadge")}
            {r.clientIp ? ` · ${r.clientIp}` : ""}
          </div>
          {(r.orgName || r.teamName || r.teamId || r.proxyGroup || r.proxyCountry) && (
            <div className={`mt-0.5 truncate text-[11.5px] ${faint}`} title={[r.orgName ?? r.teamName ?? r.teamId, r.proxyGroup, r.proxyCountry].filter(Boolean).join(" · ")}>
              {r.orgName ?? r.teamName ?? (r.teamId ? r.teamId.slice(0, 8) : "")}
              {r.proxyGroup ? ` · ${r.proxyGroup}` : ""}
              {r.proxyCountry ? ` · ${r.proxyCountry}` : ""}
            </div>
          )}
        </div>
      ),
    },
  ];

  const detail = (r: UsageRow) => (
    <DetailGrid
      items={[
        { label: t("admin.usage.colRequestId"), value: <span className="inline-flex items-center gap-1 font-mono text-[12.5px]">{r.requestId} <CopyIconButton text={r.requestId} /></span>, wide: true },
        { label: t("admin.usage.dEndpoint"), value: <span className="font-mono text-[12.5px]">POST {r.endpoint}{r.stream ? ` · ${t("common.stream")}` : ""}</span> },
        { label: t("admin.usage.dClientIp"), value: <span className="font-mono text-[12.5px]">{r.clientIp ?? "—"}</span> },
        { label: t("admin.usage.dUser"), value: `${r.userName ?? r.userId ?? "—"}${r.keyName ? ` · ${r.keyName}` : ""}` },
        { label: t("admin.usage.dMode"), value: <span className="font-mono text-[12.5px]">{r.mode ?? "—"}</span> },
        { label: t("admin.usage.dUpstreamStatus"), value: r.upstreamStatus ?? "—" },
        { label: t("admin.usage.dUpstreamModel"), value: <span className="font-mono text-[12.5px]">{r.upstreamModel ?? r.model}</span> },
        { label: t("admin.usage.dNode"), value: <span className="font-mono text-[12.5px]">{r.nodeId ?? "—"}</span> },
        { label: t("admin.usage.colProviderAccount"), value: `${r.providerName ?? t("admin.usage.directBadge")}${r.accountName ? ` · ${r.accountName}` : ""}` },
        { label: t("team.name"), value: <span title={r.teamId ?? ""}>{r.orgName ?? r.teamName ?? "—"}{r.teamId ? <span className="ml-1 font-mono text-[11.5px] text-on-surface-faint">{r.teamId}</span> : null}</span>, wide: true },
        { label: t("admin.usage.dProxyGroup"), value: `${r.proxyGroup ?? "—"}${r.proxyCountry ? ` · ${r.proxyCountry}` : ""}${r.proxyId ? ` · ${r.proxyId}` : ""}` },
        { label: t("admin.usage.colInput"), value: fmtNum(r.inputTokens) },
        { label: t("admin.usage.colOutput"), value: fmtNum(r.outputTokens) },
        { label: t("admin.usage.colCacheRW"), value: `${fmtNum(r.cacheReadTokens)} / ${fmtNum(r.cacheWriteTokens)}` },
        { label: t("admin.usage.colCacheHit"), value: hitText(r.cacheReadTokens, r.inputTokens) },
        { label: t("admin.usage.colStandard"), value: fmtUsd(r.totalCost ?? 0) },
        { label: t("admin.usage.colRate"), value: `×${r.rateMultiplier}` },
        { label: t("admin.usage.colCharged"), value: fmtUsd(r.actualCost) },
        { label: t("admin.usage.colEarning"), value: r.providerEarning ? fmtUsd(r.providerEarning) : "—" },
        { label: t("admin.usage.dDuration"), value: ms(r.durationMs) },
        { label: t("admin.usage.dTtft"), value: ms(r.firstTokenMs) },
        { label: t("admin.usage.dCcShape"), value: r.ccShape ?? "—" },
        !!r.usageEstimated && { label: t("common.estimated"), value: t("admin.usage.estimatedTip") },
        !!(r.errorCode || r.errorMessage) && {
          label: t("admin.usage.dError"),
          value: (
            <span className="text-error">
              {r.errorCode ? <span className="font-mono">{r.errorCode}</span> : null}
              {r.errorCode && r.errorMessage ? " — " : ""}
              {r.errorMessage}
            </span>
          ),
          wide: true,
        },
      ]}
    />
  );

  const dailyColumns: Column<UsageStats["daily"][number]>[] = [
    { key: "day", header: t("admin.usage.colDay"), render: (d) => <Mono>{d.day}</Mono> },
    { key: "req", header: t("admin.usage.colRequests"), align: "right", render: (d) => <span className="font-mono tabular-nums">{fmtNum(d.requests)}</span> },
    { key: "in", header: t("admin.usage.colInput"), align: "right", render: (d) => <span className="font-mono tabular-nums">{fmtTokens(d.inputTokens)}</span> },
    { key: "out", header: t("admin.usage.colOutput"), align: "right", render: (d) => <span className="font-mono tabular-nums">{fmtTokens(d.outputTokens)}</span> },
    {
      key: "cache",
      header: t("admin.usage.colCacheRW"),
      align: "right",
      render: (d) => (
        <span className="font-mono tabular-nums">
          {fmtTokens(d.cacheReadTokens)}
          <span className="text-on-surface-faint"> / {fmtTokens(d.cacheWriteTokens)}</span>
        </span>
      ),
    },
    { key: "hit", header: t("admin.usage.colCacheHit"), align: "right", render: (d) => <span className="font-mono tabular-nums">{hitText(d.cacheReadTokens, d.inputTokens)}</span> },
    { key: "cost", header: t("admin.usage.colCharged"), align: "right", render: (d) => <span className="font-mono font-semibold tabular-nums">{fmtUsd(d.costUsd)}</span> },
  ];

  const userOptions = [
    { value: "", label: t("admin.usage.allUsers") },
    ...(users.data?.items ?? []).map((u) => ({ value: u.id, label: `${u.name} (${t(`role.${u.role}`)})` })),
  ];

  return (
    <div>
      <PageHeader title={t("admin.usage.title")} desc={t("admin.usage.desc")} />

      <Card bodyClassName="p-0" className="mb-6">
        <Toolbar>
          <form
            className="flex w-full flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              apply({ ...draft, model: draft.model.trim() });
            }}
          >
            <Field label={t("common.from")} className="w-[calc(50%-6px)] sm:w-40">
              <Input type="date" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
            </Field>
            <Field label={t("common.to")} className="w-[calc(50%-6px)] sm:w-40">
              <Input type="date" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
            </Field>
            <Field label={t("common.user")} className="w-full sm:w-52">
              <Select value={draft.userId} onChange={(e) => setDraft({ ...draft, userId: e.target.value })} options={userOptions} />
            </Field>
            <Field label={t("common.model")} className="w-[calc(50%-6px)] sm:w-48">
              <Input value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} placeholder={t("admin.usage.modelPh")} className="font-mono" />
            </Field>
            <Field label={t("common.status")} className="w-[calc(50%-6px)] sm:w-36">
              <Select
                value={draft.status}
                onChange={(e) => setDraft({ ...draft, status: e.target.value })}
                options={[
                  { value: "", label: t("admin.usage.statusAll") },
                  { value: "ok", label: t("admin.usage.statusOk") },
                  { value: "error", label: t("admin.usage.statusError") },
                ]}
              />
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

      <Async state={stats} rows={4}>
        {(s) => (
          <div className="mb-6 space-y-6">
            <div className="grid gap-4 sm:grid-cols-4">
              <StatCard label={t("admin.usage.statRequests")} value={fmtNum(s.totals.requests)} tone="info" />
              <StatCard label={t("admin.usage.statRevenue")} value={fmtUsd(s.totals.costUsd)} tone="success" />
              <StatCard
                label={t("admin.usage.statTokens")}
                value={fmtTokens(s.totals.inputTokens + s.totals.outputTokens + s.totals.cacheTokens)}
                sub={t("admin.usage.statTokensSub", {
                  input: fmtTokens(s.totals.inputTokens),
                  output: fmtTokens(s.totals.outputTokens),
                  cache: fmtTokens(s.totals.cacheTokens),
                })}
                tone="primary"
              />
              <StatCard label={t("admin.usage.statCacheHit")} value={hitText(s.totals.cacheReadTokens, s.totals.inputTokens)} tone="warning" />
            </div>
            <Card title={t("admin.usage.dailyStats")} bodyClassName="p-0">
              {s.daily.length ? (
                <DataTable minWidth={900} rows={[...s.daily].reverse()} rowKey={(d) => d.day} columns={dailyColumns} />
              ) : (
                <EmptyState title={t("admin.usage.noData")} />
              )}
            </Card>
            <div className="grid gap-6 lg:grid-cols-2">
              <Card title={t("admin.usage.byModel")}>
                {s.byModel.length ? (
                  <ShareBars
                    items={s.byModel.slice(0, 10).map((m) => ({ label: m.model, value: m.costUsd, sub: `${fmtNum(m.requests)} req` }))}
                    format={(v) => fmtUsd(v)}
                  />
                ) : (
                  <EmptyState title={t("admin.usage.noData")} />
                )}
              </Card>
              <Card title={t("admin.usage.byAccount")}>
                {s.byAccount?.length ? (
                  <ShareBars
                    items={s.byAccount.slice(0, 10).map((a) => ({ label: a.name ?? a.accountId.slice(0, 8), value: a.costUsd, sub: `${fmtNum(a.requests)} req` }))}
                    format={(v) => fmtUsd(v)}
                  />
                ) : (
                  <EmptyState title={t("admin.usage.noData")} />
                )}
              </Card>
            </div>
          </div>
        )}
      </Async>

      <Card bodyClassName="p-0">
        <Async state={list} rows={8}>
          {(d) => (
            <>
              <DataTable
                columns={columns}
                rows={d.items}
                rowKey={(r) => r.id}
                minWidth={960}
                dense
                detail={detail}
                loading={list.loading}
                empty={<EmptyState title={t("admin.usage.empty")} />}
              />
              <Pagination page={d.page} pageSize={d.pageSize} total={d.total} onPage={setPage} />
            </>
          )}
        </Async>
      </Card>
    </div>
  );
}
