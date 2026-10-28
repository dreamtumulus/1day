import { useEffect, useState } from "react";
import { api, type ApiKey, type Group, type Paged } from "../../api";
import { useCT } from "../../i18n";
import {
  Async,
  Button,
  Card,
  DataTable,
  Field,
  Input,
  Modal,
  Mono,
  PageHeader,
  Pagination,
  ProgressBar,
  Select,
  StatusBadge,
  Toolbar,
  fmtDate,
  fmtDateTime,
  fmtUsd,
  useAsync,
  useRelTime,
  useToast,
} from "../../ui";

export function AdminKeys() {
  const { t } = useCT();
  const rel = useRelTime();
  const [groupId, setGroupId] = useState("");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<ApiKey | null>(null);
  const groups = useAsync(() => api.get<Group[]>("/api/admin/groups"), []);
  const list = useAsync(
    () => api.get<Paged<ApiKey>>("/api/admin/keys", { groupId, q: query, page, pageSize: 20 }),
    [groupId, query, page],
  );
  useEffect(() => setPage(1), [groupId, query]);

  return (
    <>
      <PageHeader title={t("admin.keys.title")} desc={t("admin.keys.desc")} />
      <Card bodyClassName="">
        <Toolbar>
          <Field label={t("common.group")} className="w-48">
            <Select
              value={groupId}
              onChange={(e) => setGroupId(e.target.value)}
              options={[
                { value: "", label: t("admin.keys.allGroups") },
                ...(groups.data ?? []).map((g) => ({ value: g.id, label: g.name })),
              ]}
            />
          </Field>
          <form
            className="flex min-w-[220px] flex-1 items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              setQuery(q.trim());
            }}
          >
            <Field label={t("common.search")} className="flex-1">
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("admin.keys.searchPh")} />
            </Field>
            <Button type="submit" size="md">
              {t("common.search")}
            </Button>
          </form>
        </Toolbar>
        <Async state={list} rows={6}>
          {(d) => (
            <>
              <DataTable<ApiKey>
                minWidth={1040}
                loading={list.loading}
                rows={d.items}
                rowKey={(k) => k.id}
                columns={[
                  { key: "name", header: t("common.name"), render: (k) => <span className="font-semibold">{k.name}</span> },
                  { key: "preview", header: t("admin.keys.preview"), render: (k) => <Mono>{k.keyPreview}</Mono> },
                  { key: "user", header: t("common.user"), render: (k) => k.userName ?? <Mono>{k.userId.slice(0, 8)}</Mono> },
                  { key: "group", header: t("common.group"), render: (k) => k.groupName ?? k.groupId },
                  { key: "status", header: t("common.status"), render: (k) => <StatusBadge status={k.effectiveStatus} /> },
                  {
                    key: "quota",
                    header: t("admin.keys.quota"),
                    render: (k) =>
                      k.quotaUsd > 0 ? (
                        <div className="w-32">
                          <div className="mb-1 font-mono text-[12px] text-on-surface-variant">
                            {fmtUsd(k.usedUsd)} / {fmtUsd(k.quotaUsd, 2)}
                          </div>
                          <ProgressBar value={k.usedUsd} max={k.quotaUsd} />
                        </div>
                      ) : (
                        <span className="text-on-surface-faint">{t("common.unlimited")}</span>
                      ),
                  },
                  { key: "used", header: t("admin.keys.used"), align: "right", render: (k) => <span className="font-mono">{fmtUsd(k.usedUsd)}</span> },
                  { key: "exp", header: t("admin.keys.expires"), render: (k) => (k.expiresAt ? fmtDate(k.expiresAt) : t("admin.keys.noExpiry")) },
                  { key: "last", header: t("common.lastUsed"), render: (k) => <span title={fmtDateTime(k.lastUsedAt)}>{k.lastUsedAt ? rel(k.lastUsedAt) : t("common.never")}</span> },
                  {
                    key: "act",
                    header: t("common.actions"),
                    align: "right",
                    render: (k) => (
                      <Button size="sm" onClick={() => setEditing(k)}>
                        {t("common.edit")}
                      </Button>
                    ),
                  },
                ]}
              />
              <Pagination page={d.page} pageSize={d.pageSize} total={d.total} onPage={setPage} />
            </>
          )}
        </Async>
      </Card>
      {editing && (
        <EditKeyModal
          apiKey={editing}
          groups={groups.data ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            list.reload();
          }}
        />
      )}
    </>
  );
}

function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function EditKeyModal({
  apiKey,
  groups,
  onClose,
  onSaved,
}: {
  apiKey: ApiKey;
  groups: Group[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useCT();
  const toast = useToast();
  const [name, setName] = useState(apiKey.name);
  const [groupId, setGroupId] = useState(apiKey.groupId);
  const [quota, setQuota] = useState(String(apiKey.quotaUsd));
  const [expires, setExpires] = useState(toLocalInput(apiKey.expiresAt));
  const [status, setStatus] = useState(apiKey.status);
  const [busy, setBusy] = useState(false);

  return (
    <Modal
      open
      title={t("admin.keys.editTitle", { name: apiKey.name })}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!name.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                await api.patch(`/api/admin/keys/${apiKey.id}`, {
                  name: name.trim(),
                  groupId,
                  quotaUsd: Number(quota) || 0,
                  expiresAt: expires ? new Date(expires).toISOString() : null,
                  status,
                });
                toast.success(t("admin.keys.updated"));
                onSaved();
              } catch (err) {
                toast.error(err);
              } finally {
                setBusy(false);
              }
            }}
          >
            {t("common.save")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2 text-[13px] text-on-surface-variant">
          <Mono>{apiKey.keyPreview}</Mono>
          <span>·</span>
          <span>{apiKey.userName ?? apiKey.userId}</span>
        </div>
        <Field label={t("common.name")}>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} />
        </Field>
        <Field label={t("common.group")}>
          <Select
            value={groupId}
            onChange={(e) => setGroupId(e.target.value)}
            options={groups.map((g) => ({
              value: g.id,
              label: `${g.name} · ×${g.rateMultiplier}${g.status !== "active" ? ` (${t("status.disabled")})` : ""}`,
            }))}
          />
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={`${t("admin.keys.quota")} (USD)`} hint={t("admin.keys.quotaHint")}>
            <Input type="number" min={0} step="0.01" value={quota} onChange={(e) => setQuota(e.target.value)} />
          </Field>
          <Field label={t("admin.keys.expires")} hint={t("admin.keys.expiresHint")}>
            <Input type="datetime-local" value={expires} onChange={(e) => setExpires(e.target.value)} />
          </Field>
        </div>
        <Field label={t("common.status")}>
          <Select
            value={status}
            onChange={(e) => setStatus(e.target.value as ApiKey["status"])}
            options={[
              { value: "active", label: t("status.active") },
              { value: "disabled", label: t("status.disabled") },
            ]}
          />
        </Field>
      </div>
    </Modal>
  );
}
