import { useEffect, useMemo, useState } from "react";
import { api, nodeProxyGroups, onboardOrgCreate, onboardOrgDelete, onboardOrgUpdate, onboardOrgs, type NodeRow, type OnboardOrg, type ProxyGroupSummary } from "../../api";
import { useCT } from "../../i18n";
import { AccountTabs } from "./Accounts";
import {
  Badge,
  Button,
  Card,
  ConfirmButton,
  CopyButton,
  CopyIconButton,
  DataTable,
  EmptyState,
  Field,
  Input,
  Modal,
  PageHeader,
  Select,
  StatusBadge,
  Textarea,
  errMessage,
  useAsync,
  useToast,
  fmtDateTime,
  type Column,
} from "../../ui";

// Onboarder management (docs/onboarding.md §10 / §10.1):
//  1. organization profiles — what an operator may pick: organization (UUID hidden from them),
//     the email domains its accounts use, the node · IP-group routes it may be onboarded through;
//  2. onboarder tokens — bound to a node (or any) and to some (or all) organization profiles.

interface OnboardToken {
  id: string;
  label: string;
  preview: string;
  nodeId: string;
  nodeOnline: boolean;
  orgIds: string[] | null;
  orgNames: string[] | null;
  status: string;
  lastUsedAt: string | null;
  createdAt: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RouteDraft {
  nodeId: string;
  group: string;
}

export function AdminOnboarders() {
  const { t } = useCT();
  const toast = useToast();
  const orgs = useAsync(() => onboardOrgs(), []);
  const tokens = useAsync(() => api.get<OnboardToken[]>("/api/admin/onboard-tokens"), []);
  const nodes = useAsync(() => api.get<NodeRow[]>("/api/admin/nodes"), []);

  // ---- organization profile modal
  const [orgForm, setOrgForm] = useState<{ id?: string; name: string; orgUuid: string; note: string; domains: string; routes: RouteDraft[] } | null>(null);
  const [orgErr, setOrgErr] = useState<string | null>(null);
  const [orgBusy, setOrgBusy] = useState(false);
  const [groupsByNode, setGroupsByNode] = useState<Record<string, ProxyGroupSummary[]>>({});
  const nodeName = (id: string) => (nodes.data ?? []).find((n) => n.nodeId === id)?.deployMeta?.name ?? id.slice(0, 16);

  useEffect(() => {
    if (!orgForm) return;
    for (const r of orgForm.routes) {
      if (r.nodeId && !(r.nodeId in groupsByNode)) {
        setGroupsByNode((m) => ({ ...m, [r.nodeId]: [] }));
        nodeProxyGroups("admin", r.nodeId).then((gs) => setGroupsByNode((m) => ({ ...m, [r.nodeId]: gs }))).catch(() => {});
      }
    }
  }, [orgForm, groupsByNode]);

  function openOrg(o?: OnboardOrg) {
    setOrgErr(null);
    setOrgForm(
      o
        ? { id: o.id, name: o.name, orgUuid: o.orgUuid, note: o.note ?? "", domains: o.domains.join("\n"), routes: o.routes.map((r) => ({ nodeId: r.nodeId, group: r.group ?? "" })) }
        : { name: "", orgUuid: "", note: "", domains: "", routes: [] },
    );
  }
  const orgUuidBad = !!orgForm && !!orgForm.orgUuid.trim() && !UUID_RE.test(orgForm.orgUuid.trim());
  async function saveOrg() {
    if (!orgForm) return;
    setOrgBusy(true);
    setOrgErr(null);
    try {
      const body = {
        name: orgForm.name.trim(),
        orgUuid: orgForm.orgUuid.trim(),
        note: orgForm.note.trim() || null,
        domains: orgForm.domains.split(/[\s,;]+/).map((d) => d.trim()).filter(Boolean),
        routes: orgForm.routes.filter((r) => r.nodeId).map((r) => ({ nodeId: r.nodeId, group: r.group || null })),
      };
      if (orgForm.id) await onboardOrgUpdate(orgForm.id, body);
      else await onboardOrgCreate(body);
      toast.success(t("admin.onb.orgSaved"));
      setOrgForm(null);
      await orgs.reload();
      await tokens.reload();
    } catch (e) {
      setOrgErr(errMessage(e));
    } finally {
      setOrgBusy(false);
    }
  }

  // ---- token modals
  const [issueOpen, setIssueOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [nodeId, setNodeId] = useState("");
  const [allOrgs, setAllOrgs] = useState(true);
  const [pickedOrgs, setPickedOrgs] = useState<string[]>([]);
  const [issued, setIssued] = useState<string | null>(null);
  const [editToken, setEditToken] = useState<OnboardToken | null>(null);
  const [tokenBusy, setTokenBusy] = useState(false);

  async function create() {
    setTokenBusy(true);
    try {
      const r = await api.post<OnboardToken & { token: string }>("/api/admin/onboard-tokens", { label, nodeId, orgIds: allOrgs ? null : pickedOrgs });
      setIssued(r.token);
      toast.success(t("admin.onb.created"));
      tokens.reload();
    } catch (e) {
      toast.error(e);
    } finally {
      setTokenBusy(false);
    }
  }
  async function setStatus(id: string, status: "active" | "revoked") {
    await api.patch(`/api/admin/onboard-tokens/${id}`, { status });
    tokens.reload();
  }
  async function saveTokenOrgs() {
    if (!editToken) return;
    setTokenBusy(true);
    try {
      await api.patch(`/api/admin/onboard-tokens/${editToken.id}`, { orgIds: allOrgs ? null : pickedOrgs });
      toast.success(t("admin.onb.orgsSaved"));
      setEditToken(null);
      tokens.reload();
    } catch (e) {
      toast.error(e);
    } finally {
      setTokenBusy(false);
    }
  }
  function toggleOrg(id: string) {
    setPickedOrgs((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  }

  const orgPicker = (
    <Field label={t("admin.onb.formOrgs")} hint={t("admin.onb.formOrgsHint")}>
      <div className="space-y-1.5 rounded-md p-3" style={{ border: "1px solid var(--outline-variant)" }}>
        <label className="flex items-center gap-2 text-[13px]">
          <input type="radio" checked={allOrgs} onChange={() => setAllOrgs(true)} /> {t("admin.onb.allOrgs")}
        </label>
        <label className="flex items-center gap-2 text-[13px]">
          <input type="radio" checked={!allOrgs} onChange={() => setAllOrgs(false)} /> {t("admin.onb.colOrgs")}:
        </label>
        {!allOrgs && (
          <div className="ml-6 grid gap-1 sm:grid-cols-2">
            {(orgs.data ?? []).map((o) => (
              <label key={o.id} className="flex items-center gap-2 text-[13px]">
                <input type="checkbox" checked={pickedOrgs.includes(o.id)} onChange={() => toggleOrg(o.id)} />
                <span className={o.status === "disabled" ? "line-through text-on-surface-faint" : ""}>{o.name}</span>
              </label>
            ))}
            {(orgs.data ?? []).length === 0 && <span className="text-[12.5px] text-on-surface-faint">{t("admin.onb.orgEmpty")}</span>}
          </div>
        )}
      </div>
    </Field>
  );

  const orgColumns: Column<OnboardOrg>[] = [
    {
      key: "name",
      header: t("admin.onb.colOrg"),
      render: (o) => (
        <div className="min-w-0">
          <div className="flex items-center gap-2 font-medium">
            {o.name}
            {o.status === "disabled" && <Badge tone="warning">{t("admin.onb.orgDisable")}</Badge>}
          </div>
          <div className="flex items-center gap-1 font-mono text-[11px] text-on-surface-faint">
            <span>{o.orgUuid.slice(0, 8)}…{o.orgUuid.slice(-4)}</span>
            <CopyButton text={o.orgUuid} />
          </div>
        </div>
      ),
    },
    {
      key: "domains",
      header: t("admin.onb.colDomains"),
      render: (o) =>
        o.domains.length ? (
          <div className="flex max-w-[260px] flex-wrap gap-1">
            {o.domains.map((d) => (
              <span key={d} className="rounded px-1.5 py-0.5 font-mono text-[11.5px]" style={{ background: "var(--surface-variant)" }}>@{d}</span>
            ))}
          </div>
        ) : (
          <span className="text-[12.5px] text-on-surface-faint">{t("admin.onb.orgNoDomains")}</span>
        ),
    },
    {
      key: "routes",
      header: t("admin.onb.colRoutes"),
      render: (o) =>
        o.routes.length ? (
          <ul className="space-y-0.5 text-[12.5px]">
            {o.routes.map((r, i) => (
              <li key={i} className="flex items-center gap-1.5">
                <span className="h-[7px] w-[7px] rounded-full" style={{ background: r.nodeOnline ? "var(--success)" : "var(--error)" }} />
                <span>{r.nodeName ?? r.nodeId.slice(0, 14)}</span>
                <span className="text-on-surface-faint">·</span>
                <span className={r.groupExists ? "" : "text-error"}>{r.group ?? t("admin.onb.orgRouteAnyGroup")}</span>
                <span className={`text-[11.5px] ${r.assignable ? "text-on-surface-faint" : "text-error"}`}>({t("admin.onb.routeAssignable", { n: r.assignable })})</span>
              </li>
            ))}
          </ul>
        ) : (
          <span className="text-[12.5px] text-on-surface-faint">{t("admin.onb.orgNoRoutes")}</span>
        ),
    },
    { key: "accounts", header: t("admin.onb.colAccounts"), align: "right", render: (o) => o.accounts },
    {
      key: "actions",
      header: t("common.actions"),
      align: "right",
      render: (o) => (
        <span className="inline-flex items-center gap-1">
          <Button onClick={() => openOrg(o)}>{t("common.edit")}</Button>
          <Button onClick={async () => { await onboardOrgUpdate(o.id, { status: o.status === "disabled" ? "active" : "disabled" }); orgs.reload(); }}>
            {o.status === "disabled" ? t("admin.onb.orgEnable") : t("admin.onb.orgDisable")}
          </Button>
          <ConfirmButton variant="danger" message={t("admin.onb.orgDeleteConfirm", { name: o.name })} onConfirm={async () => { await onboardOrgDelete(o.id); orgs.reload(); tokens.reload(); }}>
            {t("common.delete")}
          </ConfirmButton>
        </span>
      ),
    },
  ];

  const tokenColumns: Column<OnboardToken>[] = [
    { key: "label", header: t("admin.onb.colLabel"), render: (r) => <span className="font-medium">{r.label}</span> },
    { key: "preview", header: t("admin.onb.colToken"), render: (r) => <code className="font-mono text-[12.5px]">{r.preview}</code> },
    {
      key: "node",
      header: t("admin.onb.colNode"),
      render: (r) => (
        <span className="inline-flex items-center gap-1.5 text-[12.5px]">
          <span className="h-[7px] w-[7px] rounded-full" style={{ background: r.nodeOnline ? "var(--success)" : "var(--error)" }} />
          {r.nodeId === "*" ? t("admin.onb.anyNode") : nodeName(r.nodeId)}
        </span>
      ),
    },
    {
      key: "orgs",
      header: t("admin.onb.colOrgs"),
      render: (r) => (
        <button type="button" className="text-left text-[12.5px] hover:underline" onClick={() => { setEditToken(r); setAllOrgs(r.orgIds === null); setPickedOrgs(r.orgIds ?? []); }}>
          {r.orgIds === null ? t("admin.onb.allOrgs") : r.orgNames?.length ? r.orgNames.join(", ") : "—"}
        </button>
      ),
    },
    { key: "status", header: t("common.status"), render: (r) => <StatusBadge status={r.status} /> },
    { key: "lastUsed", header: t("admin.onb.colLastUsed"), render: (r) => <span className="text-[13px]">{r.lastUsedAt ? fmtDateTime(r.lastUsedAt) : "—"}</span> },
    {
      key: "actions",
      header: t("common.actions"),
      align: "right",
      render: (r) => (
        <span className="inline-flex items-center gap-1">
          <Button onClick={() => { setEditToken(r); setAllOrgs(r.orgIds === null); setPickedOrgs(r.orgIds ?? []); }}>{t("admin.onb.editOrgs")}</Button>
          {r.status === "active" ? (
            <Button onClick={() => setStatus(r.id, "revoked")}>{t("admin.onb.revoke")}</Button>
          ) : (
            <Button onClick={() => setStatus(r.id, "active")}>{t("admin.onb.enable")}</Button>
          )}
        </span>
      ),
    },
  ];

  const nodeOptions = useMemo(
    () => (nodes.data ?? []).map((n) => ({ value: n.nodeId, label: `${n.deployMeta?.name ?? n.nodeId.slice(0, 20)} · ${n.online ? t("admin.accounts.nodeOnline") : t("admin.accounts.nodeOffline")}` })),
    [nodes.data, t],
  );

  return (
    <div>
      <PageHeader
        title={t("admin.onb.title")}
        desc={t("admin.onb.desc")}
        actions={
          <div className="flex gap-2">
            <Button onClick={() => openOrg()}>{t("admin.onb.orgAdd")}</Button>
            <Button variant="primary" onClick={() => { setIssued(null); setLabel(""); setNodeId(""); setAllOrgs(true); setPickedOrgs([]); setIssueOpen(true); }}>
              {t("admin.onb.issue")}
            </Button>
          </div>
        }
      />
      <AccountTabs />
      <div className="space-y-6">
        <Card title={t("admin.onb.orgsTitle")} desc={t("admin.onb.orgsDesc")} bodyClassName="p-0">
          <DataTable columns={orgColumns} rows={orgs.data ?? []} rowKey={(o) => o.id} loading={orgs.loading} minWidth={820} empty={<EmptyState title={t("admin.onb.orgEmpty")} />} />
        </Card>
        <Card title={t("admin.onb.tokensTitle")} bodyClassName="p-0">
          <DataTable columns={tokenColumns} rows={tokens.data ?? []} rowKey={(r) => r.id} loading={tokens.loading} minWidth={820} empty={<EmptyState title={t("admin.onb.empty")} />} />
        </Card>
      </div>

      {/* organization profile editor */}
      <Modal
        open={!!orgForm}
        onClose={() => !orgBusy && setOrgForm(null)}
        title={orgForm?.id ? t("admin.onb.orgEdit") : t("admin.onb.orgAdd")}
        size="lg"
        footer={
          <div className="flex justify-end gap-2">
            <Button onClick={() => setOrgForm(null)}>{t("common.cancel")}</Button>
            <Button variant="primary" loading={orgBusy} disabled={!orgForm?.name.trim() || !orgForm?.orgUuid.trim() || orgUuidBad} onClick={() => void saveOrg()}>
              {t("common.save")}
            </Button>
          </div>
        }
      >
        {orgForm && (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("admin.onb.orgName")}>
                <Input value={orgForm.name} maxLength={120} autoFocus onChange={(e) => setOrgForm({ ...orgForm, name: e.target.value })} />
              </Field>
              <Field label={t("admin.onb.orgUuid")} error={orgUuidBad ? t("onboard.errOrgUuidFormat") : undefined}>
                <Input value={orgForm.orgUuid} maxLength={64} autoComplete="off" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" onChange={(e) => setOrgForm({ ...orgForm, orgUuid: e.target.value })} />
              </Field>
            </div>
            <Field label={t("admin.onb.orgDomains")} hint={t("admin.onb.orgDomainsHint")}>
              <Textarea rows={3} value={orgForm.domains} placeholder={"evenld.org\nexample.com"} spellCheck={false} onChange={(e) => setOrgForm({ ...orgForm, domains: e.target.value })} />
            </Field>
            <div>
              <span className="label">{t("admin.onb.orgRoutes")}</span>
              <div className="space-y-2">
                {orgForm.routes.map((r, i) => {
                  const groups = groupsByNode[r.nodeId] ?? [];
                  return (
                    <div key={i} className="flex flex-wrap items-center gap-2">
                      <Select
                        className="min-w-[220px] flex-1"
                        value={r.nodeId}
                        onChange={(e) => setOrgForm({ ...orgForm, routes: orgForm.routes.map((x, j) => (j === i ? { nodeId: e.target.value, group: "" } : x)) })}
                        options={[{ value: "", label: t("admin.onb.pickNode") }, ...nodeOptions]}
                      />
                      <Select
                        className="min-w-[200px] flex-1"
                        value={r.group}
                        disabled={!r.nodeId}
                        onChange={(e) => setOrgForm({ ...orgForm, routes: orgForm.routes.map((x, j) => (j === i ? { ...x, group: e.target.value } : x)) })}
                        options={[
                          { value: "", label: t("admin.onb.orgRouteAnyGroup") },
                          ...groups.filter((g) => g.group).map((g) => ({ value: g.group!, label: `${g.group} · ${t("admin.onb.routeAssignable", { n: g.assignable })}` })),
                        ]}
                      />
                      <Button variant="danger" onClick={() => setOrgForm({ ...orgForm, routes: orgForm.routes.filter((_, j) => j !== i) })}>{t("common.delete")}</Button>
                    </div>
                  );
                })}
                <Button onClick={() => setOrgForm({ ...orgForm, routes: [...orgForm.routes, { nodeId: nodeOptions[0]?.value ?? "", group: "" }] })}>{t("admin.onb.orgRouteAdd")}</Button>
              </div>
              <p className="mt-1.5 text-[12.5px] text-on-surface-faint">{t("admin.onb.orgRoutesHint")}</p>
            </div>
            <Field label={`${t("onboard.note")} (${t("common.optional")})`}>
              <Input value={orgForm.note} maxLength={500} onChange={(e) => setOrgForm({ ...orgForm, note: e.target.value })} />
            </Field>
            {orgErr && <p className="text-[13px] text-error">{orgErr}</p>}
          </div>
        )}
      </Modal>

      {/* issue token */}
      <Modal
        open={issueOpen}
        onClose={() => setIssueOpen(false)}
        title={t("admin.onb.issueTitle")}
        footer={
          issued ? (
            <Button variant="primary" onClick={() => setIssueOpen(false)}>{t("common.done")}</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => setIssueOpen(false)}>{t("common.cancel")}</Button>
              <Button variant="primary" loading={tokenBusy} disabled={!label.trim() || !nodeId || (!allOrgs && pickedOrgs.length === 0)} onClick={() => void create()}>
                {t("admin.onb.issueSubmit")}
              </Button>
            </>
          )
        }
      >
        {issued ? (
          <div className="flex flex-col gap-3">
            <p className="text-[13.5px] font-semibold" style={{ color: "var(--success)" }}>{t("admin.onb.createdOnce")}</p>
            <div className="flex items-center gap-2 rounded-md px-3 py-2.5" style={{ background: "var(--surface-variant)" }}>
              <code className="min-w-0 flex-1 break-all font-mono text-[12.5px]">{issued}</code>
              <CopyIconButton text={issued} />
            </div>
            <p className="text-[12.5px] text-on-surface-variant">{t("admin.onb.sendHint")}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <Field label={t("admin.onb.formLabel")}>
              <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t("admin.onb.formLabelHint")} />
            </Field>
            <Field label={t("admin.onb.formNode")} hint={t("admin.onb.formNodeHint")}>
              <Select value={nodeId} onChange={(e) => setNodeId(e.target.value)} options={[{ value: "", label: t("admin.onb.pickNode") }, { value: "*", label: t("admin.onb.anyNode") }, ...nodeOptions]} />
            </Field>
            {orgPicker}
          </div>
        )}
      </Modal>

      {/* edit a token's organizations */}
      <Modal
        open={!!editToken}
        onClose={() => setEditToken(null)}
        title={`${t("admin.onb.editOrgs")} ${editToken?.label ?? ""}`}
        footer={
          <div className="flex justify-end gap-2">
            <Button onClick={() => setEditToken(null)}>{t("common.cancel")}</Button>
            <Button variant="primary" loading={tokenBusy} disabled={!allOrgs && pickedOrgs.length === 0} onClick={() => void saveTokenOrgs()}>{t("common.save")}</Button>
          </div>
        }
      >
        {orgPicker}
      </Modal>
    </div>
  );
}
