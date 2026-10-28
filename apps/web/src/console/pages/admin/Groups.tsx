import { useState } from "react";
import { api, type Group } from "../../api";
import { useCT } from "../../i18n";
import {
  Async,
  Badge,
  Button,
  Card,
  ConfirmButton,
  DataTable,
  Field,
  Input,
  Modal,
  PageHeader,
  StatusBadge,
  Textarea,
  Toggle,
  fmtNum,
  useAsync,
  useToast,
} from "../../ui";

export function AdminGroups() {
  const { t } = useCT();
  const toast = useToast();
  const list = useAsync(() => api.get<Group[]>("/api/admin/groups"), []);
  const [editing, setEditing] = useState<Group | "new" | null>(null);

  return (
    <>
      <PageHeader
        title={t("admin.groups.title")}
        desc={t("admin.groups.desc")}
        actions={
          <Button variant="primary" onClick={() => setEditing("new")}>
            {t("admin.groups.create")}
          </Button>
        }
      />
      <Card bodyClassName="">
        <Async state={list} rows={5}>
          {(groups) => (
            <DataTable<Group>
              minWidth={960}
              rows={groups}
              rowKey={(g) => g.id}
              columns={[
                {
                  key: "name",
                  header: t("common.name"),
                  render: (g) => (
                    <div>
                      <div className="flex items-center gap-2 font-semibold">
                        {g.name}
                        {g.id === "default" && <Badge tone="primary">{t("admin.groups.default")}</Badge>}
                      </div>
                      {g.description && <div className="max-w-[260px] truncate text-[12.5px] text-on-surface-faint">{g.description}</div>}
                    </div>
                  ),
                },
                { key: "rate", header: t("admin.groups.rate"), align: "right", render: (g) => <span className="font-mono font-semibold">×{g.rateMultiplier}</span> },
                {
                  key: "allow",
                  header: t("admin.groups.allowlist"),
                  render: (g) =>
                    g.modelAllowlist?.enabled ? (
                      <span className="font-mono text-[12.5px]" title={g.modelAllowlist.models.join("\n")}>
                        {g.modelAllowlist.models.slice(0, 2).join(", ")}
                        {g.modelAllowlist.models.length > 2 && ` +${g.modelAllowlist.models.length - 2}`}
                      </span>
                    ) : (
                      <span className="text-on-surface-faint">{t("admin.groups.allModels")}</span>
                    ),
                },
                { key: "excl", header: t("admin.groups.exclusive"), render: (g) => (g.isExclusive ? <Badge tone="warning">{t("admin.groups.exclusive")}</Badge> : "—") },
                { key: "status", header: t("common.status"), render: (g) => <StatusBadge status={g.status} /> },
                { key: "keys", header: t("admin.groups.keys"), align: "right", render: (g) => fmtNum(g.keyCount ?? 0) },
                { key: "accounts", header: t("admin.groups.accounts"), align: "right", render: (g) => fmtNum(g.accountCount ?? 0) },
                { key: "sort", header: t("admin.groups.sort"), align: "right", render: (g) => <span className="font-mono">{g.sortOrder}</span> },
                {
                  key: "act",
                  header: t("common.actions"),
                  align: "right",
                  render: (g) => (
                    <div className="flex justify-end gap-2">
                      <Button size="sm" onClick={() => setEditing(g)}>
                        {t("common.edit")}
                      </Button>
                      {g.id !== "default" && (
                        <ConfirmButton
                          variant="danger"
                          message={t("admin.groups.deleteMsg")}
                          onConfirm={async () => {
                            await api.del(`/api/admin/groups/${g.id}`);
                            toast.success(t("admin.groups.deleted"));
                            list.reload();
                          }}
                        >
                          {t("common.delete")}
                        </ConfirmButton>
                      )}
                    </div>
                  ),
                },
              ]}
            />
          )}
        </Async>
      </Card>
      {editing && (
        <GroupModal
          group={editing === "new" ? null : editing}
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

function GroupModal({ group, onClose, onSaved }: { group: Group | null; onClose: () => void; onSaved: () => void }) {
  const { t } = useCT();
  const toast = useToast();
  const [name, setName] = useState(group?.name ?? "");
  const [description, setDescription] = useState(group?.description ?? "");
  const [rate, setRate] = useState(String(group?.rateMultiplier ?? 1));
  const [restrict, setRestrict] = useState(group?.modelAllowlist?.enabled ?? false);
  const [patterns, setPatterns] = useState((group?.modelAllowlist?.models ?? []).join("\n"));
  const [exclusive, setExclusive] = useState(group?.isExclusive ?? false);
  const [active, setActive] = useState((group?.status ?? "active") === "active");
  const [sort, setSort] = useState(String(group?.sortOrder ?? 0));
  const [busy, setBusy] = useState(false);
  const isDefault = group?.id === "default";

  const models = patterns
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const invalid = restrict && models.length === 0;

  return (
    <Modal
      open
      title={group ? t("admin.groups.editTitle", { name: group.name }) : t("admin.groups.createTitle")}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!name.trim() || invalid || !(Number(rate) >= 0)}
            onClick={async () => {
              setBusy(true);
              const body = {
                name: name.trim(),
                description: description.trim(),
                rateMultiplier: Number(rate),
                modelAllowlist: restrict ? { enabled: true, models } : null,
                isExclusive: exclusive,
                status: active ? "active" : "disabled",
                sortOrder: Number(sort) || 0,
              };
              try {
                if (group) await api.patch(`/api/admin/groups/${group.id}`, body);
                else await api.post("/api/admin/groups", body);
                toast.success(t("admin.groups.saved"));
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
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t("common.name")}>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} />
          </Field>
          <Field label={t("admin.groups.rate")} hint={t("admin.groups.rateHint")}>
            <Input type="number" min={0} step="0.01" value={rate} onChange={(e) => setRate(e.target.value)} />
          </Field>
        </div>
        <Field label={`${t("admin.groups.description")} (${t("common.optional")})`}>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
        </Field>
        <div className="space-y-3 rounded-md p-4" style={{ border: "1px solid var(--outline-variant)" }}>
          <Toggle checked={restrict} onChange={setRestrict} label={t("admin.groups.allowlistToggle")} />
          {restrict && (
            <Field
              label={t("admin.groups.patterns")}
              hint={t("admin.groups.patternsHint")}
              error={invalid ? t("admin.groups.needPattern") : undefined}
            >
              <Textarea rows={5} value={patterns} onChange={(e) => setPatterns(e.target.value)} placeholder={"claude-*\ngpt-5*"} />
            </Field>
          )}
        </div>
        <div className="flex flex-col gap-3">
          <Toggle checked={exclusive} onChange={setExclusive} label={t("admin.groups.exclusiveToggle")} />
          <Toggle checked={active} onChange={setActive} label={t("admin.groups.statusToggle")} disabled={isDefault} />
        </div>
        <Field label={t("admin.groups.sort")} hint={t("admin.groups.sortHint")} className="max-w-[200px]">
          <Input type="number" step="1" value={sort} onChange={(e) => setSort(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
