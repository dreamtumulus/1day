import { useState } from "react";
import { Link } from "react-router-dom";
import { KeyIcon } from "../../../components/Icon";
import { api, type ApiKey, type Group } from "../../api";
import { useCT } from "../../i18n";
import {
  Async,
  Badge,
  Button,
  Card,
  ConfirmButton,
  DataTable,
  EmptyState,
  Field,
  Input,
  Modal,
  Mono,
  PageHeader,
  ProgressBar,
  SecretBox,
  Select,
  StatusBadge,
  Toggle,
  fmtDate,
  fmtUsd,
  useAsync,
  useRelTime,
  useToast,
  type Column,
} from "../../ui";
import { KeyUsage } from "./KeyUsage";
import { dateInputToIso, isoToDateInput } from "./shared";

interface FormState {
  name: string;
  groupId: string;
  quota: string;
  expires: string;
  active: boolean;
}

function KeyForm({
  form,
  setForm,
  groups,
  showStatus,
}: {
  form: FormState;
  setForm: (f: FormState) => void;
  groups: Group[];
  showStatus: boolean;
}) {
  const { t } = useCT();
  const selected = groups.find((g) => g.id === form.groupId);
  return (
    <div className="space-y-4">
      <Field label={t("common.name")}>
        <Input value={form.name} maxLength={64} placeholder="my-app" onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </Field>
      <Field
        label={t("common.group")}
        hint={
          selected
            ? `${t("user.keys.rate", { rate: selected.rateMultiplier })}${selected.description ? ` · ${selected.description}` : ""}${
                selected.modelAllowlist?.enabled ? ` · ${t("user.keys.restricted", { models: selected.modelAllowlist.models.join(", ") })}` : ""
              }`
            : undefined
        }
      >
        <Select
          value={form.groupId}
          onChange={(e) => setForm({ ...form, groupId: e.target.value })}
          options={groups.map((g) => ({
            value: g.id,
            label: `${g.name} · ×${g.rateMultiplier}${g.isDefault ? ` (${t("user.keys.default")})` : ""}`,
          }))}
        />
      </Field>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label={t("user.keys.quota")} hint={t("user.keys.quotaHint")}>
          <Input type="number" min={0} step="0.01" value={form.quota} placeholder="0" onChange={(e) => setForm({ ...form, quota: e.target.value })} />
        </Field>
        <Field label={t("user.keys.expires")} hint={t("user.keys.expiresHint")}>
          <Input type="date" value={form.expires} onChange={(e) => setForm({ ...form, expires: e.target.value })} />
        </Field>
      </div>
      {showStatus && <Toggle checked={form.active} onChange={(v) => setForm({ ...form, active: v })} label={t("user.keys.enabled")} />}
    </div>
  );
}

export function UserKeys() {
  const { t } = useCT();
  const toast = useToast();
  const rel = useRelTime();
  const keys = useAsync(() => api.get<ApiKey[]>("/api/user/keys"), []);
  const groups = useAsync(() => api.get<Group[]>("/api/user/groups"), []);

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<ApiKey | null>(null);
  const [form, setForm] = useState<FormState>({ name: "", groupId: "", quota: "", expires: "", active: true });
  const [busy, setBusy] = useState(false);
  const [newKey, setNewKey] = useState<{ key: string; groupId: string } | null>(null);
  const [revealed, setRevealed] = useState<{ name: string; key: string; groupId: string } | null>(null);
  const [usageFor, setUsageFor] = useState<{ name: string; key: string | null; groupId: string } | null>(null);

  const groupList = groups.data ?? [];
  const defaultGroupId = groupList.find((g) => g.isDefault)?.id ?? groupList[0]?.id ?? "";

  function openCreate(groupId?: string) {
    setForm({ name: "", groupId: groupId ?? defaultGroupId, quota: "", expires: "", active: true });
    setCreateOpen(true);
  }

  function openEdit(k: ApiKey) {
    setForm({
      name: k.name,
      groupId: k.groupId,
      quota: k.quotaUsd > 0 ? String(k.quotaUsd) : "",
      expires: isoToDateInput(k.expiresAt),
      active: k.status === "active",
    });
    setEditing(k);
  }

  function payload() {
    const quota = Number(form.quota || 0);
    if (!Number.isFinite(quota) || quota < 0) throw new Error("配额必须是非负的有效金额；留空或填 0 表示无限额。");
    return {
      name: form.name.trim() || "default",
      groupId: form.groupId || undefined,
      quotaUsd: quota,
      expiresAt: dateInputToIso(form.expires),
    };
  }

  async function submitCreate() {
    setBusy(true);
    try {
      const res = await api.post<ApiKey & { key: string }>("/api/user/keys", payload());
      setCreateOpen(false);
      setNewKey({ key: res.key, groupId: res.groupId });
      keys.reload();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  async function submitEdit() {
    if (!editing) return;
    setBusy(true);
    try {
      await api.patch(`/api/user/keys/${editing.id}`, { ...payload(), status: form.active ? "active" : "disabled" });
      setEditing(null);
      toast.success(t("common.saved"));
      keys.reload();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  async function reveal(k: ApiKey) {
    try {
      const res = await api.post<{ key: string }>(`/api/user/keys/${k.id}/reveal`);
      setRevealed({ name: k.name, key: res.key, groupId: k.groupId });
    } catch (err) {
      toast.error(err);
    }
  }

  async function showUsage(k: ApiKey) {
    let key: string | null = null;
    if (k.revealable) {
      try {
        key = (await api.post<{ key: string }>(`/api/user/keys/${k.id}/reveal`)).key;
      } catch (err) {
        toast.error(err);
      }
    }
    setUsageFor({ name: k.name, key, groupId: k.groupId });
  }

  const groupOf = (id: string | undefined) => groupList.find((g) => g.id === id) ?? null;

  const columns: Column<ApiKey>[] = [
    {
      key: "name",
      header: t("common.name"),
      render: (k) => (
        <div className="min-w-[140px]">
          <div className="font-medium text-on-surface">{k.name}</div>
          <div className="mt-0.5 flex items-center gap-1.5">
            <Mono>{k.keyPreview}</Mono>
            {k.revealable && (
              <button type="button" className="text-[12px] font-medium text-primary hover:underline" onClick={() => void reveal(k)}>
                {t("user.keys.reveal")}
              </button>
            )}
          </div>
        </div>
      ),
    },
    {
      key: "group",
      header: t("common.group"),
      render: (k) => {
        const g = groupList.find((x) => x.id === k.groupId);
        return (
          <div className="flex items-center gap-1.5">
            <span>{k.groupName ?? k.groupId}</span>
            {g && <Badge tone="primary">×{g.rateMultiplier}</Badge>}
          </div>
        );
      },
    },
    {
      key: "quota",
      header: t("user.keys.usedQuota"),
      render: (k) => (
        <div className="min-w-[150px]">
          <div className="font-mono text-[12.5px] tabular-nums">
            {fmtUsd(k.usedUsd)} / {k.quotaUsd > 0 ? fmtUsd(k.quotaUsd, 2) : t("common.unlimited")}
          </div>
          {k.quotaUsd > 0 && (
            <div className="mt-1.5">
              <ProgressBar value={k.usedUsd} max={k.quotaUsd} />
            </div>
          )}
        </div>
      ),
    },
    { key: "expires", header: t("user.keys.expires"), render: (k) => (k.expiresAt ? fmtDate(k.expiresAt) : t("user.keys.never")) },
    { key: "status", header: t("common.status"), render: (k) => <StatusBadge status={k.effectiveStatus} /> },
    {
      key: "last",
      header: t("common.lastUsed"),
      render: (k) => <span className="text-on-surface-variant">{k.lastUsedAt ? rel(k.lastUsedAt) : t("common.never")}</span>,
    },
    {
      key: "actions",
      header: t("common.actions"),
      align: "right",
      render: (k) => (
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="soft" onClick={() => void showUsage(k)}>
            {t("user.usage.howToCall")}
          </Button>
          <Button size="sm" onClick={() => openEdit(k)}>
            {t("common.edit")}
          </Button>
          <ConfirmButton
            variant="danger"
            title={t("user.keys.deleteTitle", { name: k.name })}
            message={t("user.keys.deleteMsg")}
            confirmLabel={t("common.delete")}
            onConfirm={async () => {
              await api.del(`/api/user/keys/${k.id}`);
              toast.success(t("user.keys.deleted"));
              keys.reload();
            }}
          >
            {t("common.delete")}
          </ConfirmButton>
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title={t("nav.keys")}
        desc={t("user.keys.desc")}
        actions={
          <Button variant="primary" onClick={() => openCreate()} disabled={!groups.data || groupList.length === 0}>
            <KeyIcon width={15} height={15} />
            {t("user.keys.create")}
          </Button>
        }
      />
      {groups.data && groupList.length === 0 && (
        <div className="mb-4 rounded-lg px-4 py-3 text-sm" style={{ background: "var(--warning-container)", color: "var(--warning)" }}>
          {t("user.keys.noGroups")}
        </div>
      )}
      {groupList.length > 0 && (
        <Card className="mb-6" title={t("user.groups.title")} desc={t("user.groups.desc")} bodyClassName="p-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {groupList.map((g) => (
              <div key={g.id} className="flex flex-col rounded-md p-4" style={{ border: "1px solid var(--outline-variant)" }}>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-display text-[15px] font-semibold">{g.name}</span>
                    {g.isDefault && <Badge tone="info">{t("user.keys.default")}</Badge>}
                    {g.isExclusive && <Badge tone="warning">{t("user.groups.exclusive")}</Badge>}
                  </div>
                  <Badge tone="primary">×{g.rateMultiplier}</Badge>
                </div>
                {g.description && <p className="mt-1.5 text-[13px] text-on-surface-variant">{g.description}</p>}
                <p className="mt-2 text-[12.5px] text-on-surface-faint">
                  {g.modelAllowlist?.enabled
                    ? t("user.groups.models", { models: g.modelAllowlist.models.join(", ") })
                    : t("user.groups.allModels")}
                </p>
                <div className="mt-3 flex flex-1 items-end justify-between gap-2">
                  <span className="text-[12px] text-on-surface-faint">{t("user.groups.priceNote", { rate: g.rateMultiplier })}</span>
                  <Button size="sm" variant="soft" onClick={() => openCreate(g.id)}>
                    {t("user.groups.createWith")}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card bodyClassName="" title={t("user.keys.listTitle")}>
        <Async state={keys} rows={5}>
          {(list) => (
            <DataTable
              columns={columns}
              rows={list}
              rowKey={(k) => k.id}
              minWidth={920}
              empty={
                <EmptyState
                  title={t("user.keys.emptyTitle")}
                  desc={t("user.keys.emptyDesc")}
                  action={
                    <Button variant="primary" onClick={() => openCreate()} disabled={groupList.length === 0}>
                      {t("user.keys.create")}
                    </Button>
                  }
                />
              }
            />
          )}
        </Async>
      </Card>

      <Modal
        open={createOpen}
        title={t("user.keys.create")}
        onClose={() => !busy && setCreateOpen(false)}
        footer={
          <>
            <Button onClick={() => setCreateOpen(false)} disabled={busy}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" loading={busy} onClick={() => void submitCreate()}>
              {t("common.create")}
            </Button>
          </>
        }
      >
        <KeyForm form={form} setForm={setForm} groups={groupList} showStatus={false} />
      </Modal>

      <Modal
        open={!!editing}
        title={t("user.keys.editTitle", { name: editing?.name ?? "" })}
        onClose={() => !busy && setEditing(null)}
        footer={
          <>
            <Button onClick={() => setEditing(null)} disabled={busy}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" loading={busy} onClick={() => void submitEdit()}>
              {t("common.save")}
            </Button>
          </>
        }
      >
        <KeyForm
          form={form}
          setForm={setForm}
          groups={
            editing && !groupList.some((g) => g.id === editing.groupId)
              ? [
                  ...groupList,
                  {
                    id: editing.groupId,
                    name: editing.groupName ?? editing.groupId,
                    rateMultiplier: 1,
                    description: null,
                    modelAllowlist: null,
                    isExclusive: true,
                    status: "active",
                    sortOrder: 0,
                    createdAt: "",
                  },
                ]
              : groupList
          }
          showStatus
        />
      </Modal>

      <Modal
        open={!!newKey}
        size="lg"
        title={t("user.keys.createdTitle")}
        onClose={() => setNewKey(null)}
        footer={
          <>
            <Link to="/console/guide" className="wk-btn wk-btn-sm wk-btn-ghost">
              {t("nav.guide")}
            </Link>
            <Button variant="primary" onClick={() => setNewKey(null)}>
              {t("common.close")}
            </Button>
          </>
        }
      >
        {newKey && (
          <div className="space-y-6">
            <SecretBox value={newKey.key} note={t("user.keys.createdNote")} />
            <KeyUsage apiKey={newKey.key} group={groupOf(newKey.groupId)} />
          </div>
        )}
      </Modal>

      <Modal
        open={!!revealed}
        size="lg"
        title={t("user.keys.revealTitle", { name: revealed?.name ?? "" })}
        onClose={() => setRevealed(null)}
        footer={
          <Button variant="primary" onClick={() => setRevealed(null)}>
            {t("common.close")}
          </Button>
        }
      >
        {revealed && (
          <div className="space-y-6">
            <SecretBox value={revealed.key} note={t("user.keys.revealNote")} />
            <KeyUsage apiKey={revealed.key} group={groupOf(revealed.groupId)} />
          </div>
        )}
      </Modal>

      <Modal
        open={!!usageFor}
        size="lg"
        title={t("user.usage.title", { name: usageFor?.name ?? "" })}
        onClose={() => setUsageFor(null)}
        footer={
          <Button variant="primary" onClick={() => setUsageFor(null)}>
            {t("common.close")}
          </Button>
        }
      >
        {usageFor && (
          <div className="space-y-4">
            {!usageFor.key && (
              <p className="rounded-md px-3 py-2 text-[13px]" style={{ background: "var(--warning-container)", color: "var(--warning)" }}>
                {t("user.usage.legacyKey")}
              </p>
            )}
            <KeyUsage apiKey={usageFor.key} group={groupOf(usageFor.groupId)} />
          </div>
        )}
      </Modal>
    </>
  );
}
