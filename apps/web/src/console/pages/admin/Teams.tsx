// Organizations (upstream teams) as an operations object — 2026-11-01, docs/team-isolation.md "多小组织".
// One row per Claude organization: accounts by state, live load, exit IPs (bound / claimed / releasable),
// 24 h usage; actions: accounts filter, rename, enable / disable, release unused exit claims, wipe from nodes.
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { RefreshIcon } from "../../../components/Icon";
import { adminTeamClaims, adminTeamCleanupNodes, adminTeamPatch, adminTeamReleaseClaims, adminTeamsOverview, type TeamClaim, type TeamOverviewRow } from "../../api";
import { useCT } from "../../i18n";
import { Async, Badge, Button, DataTable, EmptyState, Field, Input, Modal, PageHeader, fmtNum, fmtPct, fmtUsd, useAsync, useRelTime, useToast, type Column } from "../../ui";

export function AdminTeams() {
  const { t } = useCT();
  const rel = useRelTime();
  const toast = useToast();
  const navigate = useNavigate();
  const list = useAsync(() => adminTeamsOverview(), []);
  const [claimsOf, setClaimsOf] = useState<TeamOverviewRow | null>(null);
  const [renaming, setRenaming] = useState<{ row: TeamOverviewRow; name: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function act(id: string, fn: () => Promise<unknown>, okMsg?: string) {
    setBusy(id);
    try {
      await fn();
      if (okMsg) toast.success(okMsg);
      list.reload();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  }

  const name = (r: TeamOverviewRow) => r.name || r.id.slice(0, 8);
  const columns: Column<TeamOverviewRow>[] = [
    {
      key: "org",
      header: t("admin.teams.org"),
      render: (r) => (
        <div className="min-w-[180px]">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-semibold text-on-surface">{name(r)}</span>
            <Badge tone={r.status === "active" ? "success" : "neutral"}>{t(`status.${r.status === "active" ? "active" : "disabled"}`)}</Badge>
          </div>
          <div className="mt-0.5 font-mono text-[11px] text-on-surface-variant" title={r.id}>{r.id}</div>
        </div>
      ),
    },
    {
      key: "accounts",
      header: t("admin.teams.accounts"),
      render: (r) => (
        <div className="min-w-[200px] text-[12px]">
          <div className="text-[13px] font-semibold text-on-surface">{r.accounts.total}</div>
          <div className="text-on-surface-variant">{t("admin.teams.accountsCell", r.accounts)}</div>
        </div>
      ),
    },
    {
      key: "load",
      header: t("admin.teams.load"),
      render: (r) => (
        <span className="text-[12px] text-on-surface-variant">
          {t("admin.teams.loadCell", { inFlight: r.inFlight ?? "—", concurrency: r.accounts.concurrency || "∞", window: r.windowUsedAvg === null ? "—" : fmtPct(r.windowUsedAvg * 100, 0) })}
        </span>
      ),
    },
    {
      key: "exits",
      header: t("admin.teams.exits"),
      render: (r) => (
        <button type="button" className="text-left text-[12px] text-primary hover:underline" onClick={() => setClaimsOf(r)}>
          {t("admin.teams.exitsCell", r.exits)}
        </button>
      ),
    },
    {
      key: "usage",
      header: t("admin.teams.usage24h"),
      render: (r) => <span className="text-[12px] text-on-surface-variant">{t("admin.teams.usageCell", { requests: fmtNum(r.usage24h.requests), failed: fmtNum(r.usage24h.failed), cost: fmtUsd(r.usage24h.costUsd) })}</span>,
    },
    { key: "last", header: t("common.lastUsed"), render: (r) => <span className="text-[12px] text-on-surface-variant">{rel(r.lastUsedAt)}</span> },
    {
      key: "actions",
      header: t("common.actions"),
      align: "right",
      render: (r) => (
        <div className="flex flex-wrap justify-end gap-1.5">
          <Button size="sm" onClick={() => navigate(`/console/admin/accounts?teamId=${encodeURIComponent(r.id)}`)}>{t("admin.teams.viewAccounts")}</Button>
          <Button size="sm" onClick={() => setRenaming({ row: r, name: r.name ?? "" })}>{t("admin.teams.rename")}</Button>
          <Button
            size="sm"
            loading={busy === r.id}
            onClick={() => void act(r.id, () => adminTeamPatch(r.id, { status: r.status === "active" ? "disabled" : "active" }), t(r.status === "active" ? "admin.teams.disabledToast" : "admin.teams.enabledToast"))}
          >
            {t(r.status === "active" ? "admin.teams.disable" : "admin.teams.enable")}
          </Button>
          {r.status !== "active" && r.accounts.total === 0 && (
            <Button size="sm" variant="danger" loading={busy === r.id} title={t("admin.teams.cleanupHint")} onClick={() => void act(r.id, async () => { const x = await adminTeamCleanupNodes(r.id); toast.success(t("admin.teams.cleanupToast", { n: x.nodes.length })); })}>
              {t("admin.teams.cleanup")}
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title={t("admin.teams.title")}
        desc={t("admin.teams.desc")}
        actions={
          <Button onClick={list.reload}>
            <RefreshIcon width={14} height={14} />
            {t("common.refresh")}
          </Button>
        }
      />
      <Async state={list} rows={6}>
        {(d) => (d.data.length ? <DataTable<TeamOverviewRow> columns={columns} rows={d.data} rowKey={(r) => r.id} minWidth={1000} /> : <EmptyState title={t("admin.teams.none")} />)}
      </Async>

      {claimsOf && <ClaimsModal row={claimsOf} onClose={() => { setClaimsOf(null); list.reload(); }} />}

      <Modal
        open={!!renaming}
        title={t("admin.teams.rename")}
        onClose={() => setRenaming(null)}
        footer={
          <>
            <Button onClick={() => setRenaming(null)}>{t("common.cancel")}</Button>
            <Button variant="primary" onClick={() => renaming && void act(renaming.row.id, () => adminTeamPatch(renaming.row.id, { name: renaming.name }), t("admin.teams.renamed")).then(() => setRenaming(null))}>
              {t("common.save")}
            </Button>
          </>
        }
      >
        {renaming && (
          <Field label={t("admin.teams.org")}>
            <Input value={renaming.name} onChange={(e) => setRenaming({ ...renaming, name: e.target.value })} maxLength={200} />
          </Field>
        )}
      </Modal>
    </div>
  );
}

function ClaimsModal({ row, onClose }: { row: TeamOverviewRow; onClose: () => void }) {
  const { t } = useCT();
  const rel = useRelTime();
  const toast = useToast();
  const claims = useAsync(() => adminTeamClaims(row.id), [row.id]);
  const [busy, setBusy] = useState(false);

  async function release(keys?: string[], force = false) {
    setBusy(true);
    try {
      const r = await adminTeamReleaseClaims(row.id, { ...(keys ? { resourceKeys: keys } : {}), force });
      toast.success(t("admin.teams.released", { n: r.released.length, skipped: r.skipped.length }));
      claims.reload();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  }

  const columns: Column<TeamClaim>[] = [
    { key: "exit", header: t("admin.teams.exits"), render: (c) => <span className="font-mono text-[12px]">{c.exitIp ?? c.resourceKey}</span> },
    { key: "proxies", header: t("admin.nodes.proxies"), render: (c) => <span className="text-[12px] text-on-surface-variant">{c.proxies.map((p) => `${p.id} (${p.status})`).join(", ") || "—"}</span> },
    { key: "use", header: t("admin.teams.accounts"), render: (c) => <span className="text-[12px]">{c.boundAccounts} · {c.reserved}</span> },
    { key: "last", header: t("common.lastUsed"), render: (c) => <span className="text-[12px] text-on-surface-variant">{rel(c.lastActivityAt)}</span> },
    {
      key: "state",
      header: t("common.status"),
      render: (c) => (c.releasable ? <Badge tone="success">{t("admin.teams.releaseOne")}</Badge> : <Badge tone="neutral">{t(`admin.teams.blocker.${c.blocker ?? "bound_accounts"}`)}</Badge>),
    },
    {
      key: "actions",
      header: t("common.actions"),
      align: "right",
      render: (c) => (
        <div className="flex justify-end gap-1.5">
          {c.releasable && <Button size="sm" loading={busy} onClick={() => void release([c.resourceKey])}>{t("admin.teams.releaseOne")}</Button>}
          {!c.releasable && c.blocker === "too_recent" && <Button size="sm" variant="danger" loading={busy} onClick={() => void release([c.resourceKey], true)}>{t("admin.teams.releaseForce")}</Button>}
        </div>
      ),
    },
  ];

  return (
    <Modal
      open
      size="lg"
      title={t("admin.teams.exitsOf", { name: row.name || row.id.slice(0, 8) })}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t("common.close")}</Button>
          <Button variant="primary" loading={busy} disabled={!claims.data || !claims.data.data.some((c) => c.releasable)} onClick={() => void release()}>
            {t("admin.teams.releaseAll")}
          </Button>
        </>
      }
    >
      <Async state={claims} rows={4}>
        {(d) => (
          <div className="space-y-3">
            <p className="text-[12.5px] text-on-surface-variant">{t("admin.teams.claimsDesc", { days: d.minReleaseDays })}</p>
            <DataTable<TeamClaim> columns={columns} rows={d.data} rowKey={(c) => c.resourceKey} minWidth={720} dense />
          </div>
        )}
      </Async>
    </Modal>
  );
}
