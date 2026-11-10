import { useState } from "react";
import { api, type ApiKey, type Paged, type UsageRow, type UsageStats } from "../../api";
import { BarChart, ShareBars } from "../../charts";
import { CostBreakdown, cacheWriteText } from "../../CostBreakdown";
import { useCT } from "../../i18n";
import {
  Async,
  Badge,
  Button,
  Card,
  CopyIconButton,
  DataTable,
  DetailGrid,
  Field,
  Input,
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

/** Status cell shared by usage tables. */
export function StatusCodeCell({ code, error }: { code: number; error: string | null }) {
  const ok = code < 300;
  return (
    <Badge tone={ok ? "success" : code === 429 || code === 402 ? "warning" : "error"} title={error ?? undefined}>
      {code}
      {!ok && error ? ` · ${error}` : ""}
    </Badge>
  );
}

export function fmtMs(ms: number | null): string {
  if (ms == null) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

export function UserUsage() {
  const { t } = useCT();
  const [from, setFrom] = useState(localDay(-13));
  const [to, setTo] = useState(localDay(0));
  const [keyId, setKeyId] = useState("");
  const [model, setModel] = useState("");
  const [applied, setApplied] = useState({ from: localDay(-13), to: localDay(0), keyId: "", model: "" });
  const [page, setPage] = useState(1);

  const keys = useAsync(() => api.get<ApiKey[]>("/api/user/keys"), []);
  const params = { from: applied.from, to: applied.to, keyId: applied.keyId, model: applied.model };
  const stats = useAsync(() => api.get<UsageStats>("/api/user/usage/stats", params), [applied]);
  const rows = useAsync(
    () => api.get<Paged<UsageRow>>("/api/user/usage", { ...params, page, pageSize: 20 }),
    [applied, page],
  );

  function apply() {
    setPage(1);
    setApplied({ from, to, keyId, model: model.trim() });
  }

  function reset() {
    const f = localDay(-13);
    const tt = localDay(0);
    setFrom(f);
    setTo(tt);
    setKeyId("");
    setModel("");
    setPage(1);
    setApplied({ from: f, to: tt, keyId: "", model: "" });
  }

  const faint = "text-on-surface-faint";
  const columns: Column<UsageRow>[] = [
    {
      key: "time",
      header: t("common.time"),
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
      key: "key",
      header: t("common.key"),
      render: (r) => (
        <div className="max-w-[160px]">
          <div className="truncate text-[12.5px]" title={r.keyName ?? ""}>
            {r.keyName ?? "—"}
          </div>
          <div className={`truncate font-mono text-[11.5px] ${faint}`} title={r.requestId}>
            {r.requestId.slice(0, 8)}
          </div>
        </div>
      ),
    },
    {
      key: "model",
      header: t("common.model"),
      render: (r) => (
        <div className="max-w-[200px]">
          <div className="truncate font-mono text-[12.5px]" title={r.model}>
            {r.model}
          </div>
          {r.upstreamModel && r.upstreamModel !== r.model && (
            <div className={`truncate font-mono text-[11.5px] ${faint}`} title={r.upstreamModel}>
              → {r.upstreamModel}
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
      header: `${t("common.input")} / ${t("common.output")}`,
      align: "right",
      render: (r) => (
        <div className="font-mono text-[12.5px] tabular-nums">
          <div className="whitespace-nowrap">
            {fmtNum(r.inputTokens)}
            <span className={faint}> / </span>
            {fmtNum(r.outputTokens)}
            {r.usageEstimated && (
              <span className="ml-1 text-warning" title={t("user.usage.estimatedHint")}>
                ≈
              </span>
            )}
          </div>
          <div className={`text-[11.5px] ${faint}`}>
            {t("common.cache")} {fmtNum(r.cacheReadTokens)} / {fmtNum(r.cacheWriteTokens)}
          </div>
        </div>
      ),
    },
    {
      key: "cost",
      header: t("common.cost"),
      align: "right",
      render: (r) => (
        <div className="font-mono text-[12.5px] tabular-nums">
          <div className="font-semibold">{fmtUsd(r.actualCost)}</div>
          {r.rateMultiplier !== 1 && <div className={`text-[11.5px] ${faint}`}>×{r.rateMultiplier}</div>}
        </div>
      ),
    },
    {
      key: "duration",
      header: t("common.duration"),
      align: "right",
      render: (r) => (
        <div className="font-mono text-[12.5px] tabular-nums">
          <div className="whitespace-nowrap">{fmtMs(r.durationMs)}</div>
          <div className={`whitespace-nowrap text-[11.5px] ${faint}`} title={t("user.usage.ttftTip")}>
            {t("user.usage.ttftAbbr")} {fmtMs(r.firstTokenMs)}
          </div>
        </div>
      ),
    },
    { key: "status", header: t("common.status"), render: (r) => <StatusCodeCell code={r.statusCode} error={r.errorCode} /> },
  ];

  const detail = (r: UsageRow) => (
    <DetailGrid
      items={[
        { label: t("user.usage.dRequestId"), value: <span className="inline-flex items-center gap-1 font-mono text-[12.5px]">{r.requestId} <CopyIconButton text={r.requestId} /></span>, wide: true },
        { label: t("user.usage.dEndpoint"), value: <span className="font-mono text-[12.5px]">POST {r.endpoint}{r.stream ? ` · ${t("common.stream")}` : ""}</span> },
        { label: t("user.usage.dClientIp"), value: <span className="font-mono text-[12.5px]">{r.clientIp ?? "—"}</span> },
        { label: t("common.key"), value: r.keyName ?? "—" },
        { label: t("common.model"), value: <span className="font-mono text-[12.5px]">{r.upstreamModel && r.upstreamModel !== r.model ? `${r.model} → ${r.upstreamModel}` : r.model}</span> },
        { label: t("common.input"), value: fmtNum(r.inputTokens) },
        { label: t("common.output"), value: fmtNum(r.outputTokens) },
        { label: t("common.cost.cacheRead"), value: fmtNum(r.cacheReadTokens) },
        { label: t("common.cost.cacheWrite"), value: cacheWriteText(r) },
        { label: t("common.cost"), value: `${fmtUsd(r.actualCost)}${r.rateMultiplier !== 1 ? ` (×${r.rateMultiplier})` : ""}` },
        { label: t("user.usage.dDuration"), value: fmtMs(r.durationMs) },
        { label: t("user.usage.dTtft"), value: fmtMs(r.firstTokenMs) },
        { label: t("common.status"), value: <StatusCodeCell code={r.statusCode} error={r.errorCode} /> },
        !!r.usageEstimated && { label: t("common.estimated"), value: t("user.usage.estimatedHint") },
        !!r.costBreakdown && r.costBreakdown.lines.length > 0 && { label: t("common.cost.breakdown"), value: <CostBreakdown breakdown={r.costBreakdown} rateMultiplier={r.rateMultiplier} />, wide: true },
        !!r.errorMessage && { label: t("user.usage.dError"), value: <span className="text-error">{r.errorMessage}</span>, wide: true },
      ]}
    />
  );

  return (
    <>
      <PageHeader title={t("nav.usage")} desc={t("user.usage.desc")} />
      <div className="space-y-6">
        <Async state={stats} rows={3}>
          {(s) => (
            <>
              <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
                <StatCard label={t("common.requests")} value={fmtNum(s.totals.requests)} tone="info" />
                <StatCard label={t("common.cost")} value={fmtUsd(s.totals.costUsd)} tone="primary" />
                <StatCard label={t("user.usage.inputTokens")} value={fmtTokens(s.totals.inputTokens)} sub={`${t("common.cache")} ${fmtTokens(s.totals.cacheTokens)}`} />
                <StatCard label={t("user.usage.outputTokens")} value={fmtTokens(s.totals.outputTokens)} />
              </div>
              <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1.6fr_1fr]">
                <Card title={t("user.usage.dailyCost")}>
                  <BarChart data={s.daily.map((d) => ({ label: d.day, value: d.costUsd }))} format={(v) => fmtUsd(v)} />
                </Card>
                <Card title={t("user.usage.byModel")}>
                  {s.byModel.length === 0 ? (
                    <p className="py-8 text-center text-sm text-on-surface-faint">{t("common.empty")}</p>
                  ) : (
                    <ShareBars
                      items={s.byModel.slice(0, 8).map((m) => ({ label: m.model, value: m.costUsd, sub: `${fmtNum(m.requests)} req` }))}
                      format={(v) => fmtUsd(v)}
                    />
                  )}
                </Card>
              </div>
            </>
          )}
        </Async>

        <Card bodyClassName="">
          <Toolbar>
            <Field label={t("common.from")}>
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label={t("common.to")}>
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </Field>
            <Field label={t("common.key")}>
              <Select
                value={keyId}
                onChange={(e) => setKeyId(e.target.value)}
                options={[{ value: "", label: t("common.all") }, ...(keys.data ?? []).map((k) => ({ value: k.id, label: k.name }))]}
              />
            </Field>
            <Field label={t("common.model")}>
              <Input value={model} placeholder="claude-sonnet-5" onChange={(e) => setModel(e.target.value)} onKeyDown={(e) => e.key === "Enter" && apply()} />
            </Field>
            <div className="flex gap-2">
              <Button variant="primary" onClick={apply}>
                {t("common.filter")}
              </Button>
              <Button onClick={reset}>{t("common.reset")}</Button>
            </div>
          </Toolbar>
          <Async state={rows} rows={6}>
            {(p) => (
              <>
                <DataTable columns={columns} rows={p.items} rowKey={(r) => r.id} minWidth={820} dense detail={detail} loading={rows.loading} />
                <Pagination page={p.page} pageSize={p.pageSize} total={p.total} onPage={setPage} />
              </>
            )}
          </Async>
        </Card>
      </div>
    </>
  );
}
