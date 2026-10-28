import { useState } from "react";
import { api } from "../../api";
import { useCT } from "../../i18n";
import { AccountTabs } from "./Accounts";
import {
  Button,
  Card,
  CopyIconButton,
  DataTable,
  EmptyState,
  Field,
  Input,
  Modal,
  PageHeader,
  Select,
  StatusBadge,
  useAsync,
  useToast,
  fmtDateTime,
  type Column,
} from "../../ui";

interface OnboardToken {
  id: string;
  label: string;
  preview: string;
  nodeId: string;
  nodeOnline: boolean;
  status: string;
  lastUsedAt: string | null;
  createdAt: string;
}

interface NodeItem {
  nodeId: string;
  online: boolean;
}

export function AdminOnboarders() {
  const { t } = useCT();
  const toast = useToast();
  const [createOpen, setCreateOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [nodeId, setNodeId] = useState("");
  const [issued, setIssued] = useState<string | null>(null);

  const state = useAsync(() => api.get<OnboardToken[]>("/api/admin/onboard-tokens"), []);
  const nodes = useAsync(() => api.get<NodeItem[]>("/api/admin/nodes"), []);

  async function create() {
    const r = await api.post<OnboardToken & { token: string }>("/api/admin/onboard-tokens", { label, nodeId });
    setIssued(r.token);
    toast.success(t("admin.onb.created"));
    state.reload();
  }

  async function setStatus(id: string, status: "active" | "revoked") {
    await api.patch(`/api/admin/onboard-tokens/${id}`, { status });
    state.reload();
  }

  const columns: Column<OnboardToken>[] = [
    { key: "label", header: t("admin.onb.colLabel"), render: (r) => <span className="font-medium">{r.label}</span> },
    {
      key: "preview",
      header: t("admin.onb.colToken"),
      render: (r) => <code className="font-mono text-[12.5px]">{r.preview}</code>,
    },
    {
      key: "node",
      header: t("admin.onb.colNode"),
      render: (r) => (
        <span className="inline-flex items-center gap-1.5 font-mono text-[12px]">
          <span
            className="h-[7px] w-[7px] rounded-full"
            style={{ background: r.nodeOnline ? "var(--success)" : "var(--error)" }}
          />
          {r.nodeId === "*" ? t("admin.onb.anyNode") : `${r.nodeId.slice(0, 16)}…`}
        </span>
      ),
    },
    { key: "status", header: t("common.status"), render: (r) => <StatusBadge status={r.status} /> },
    {
      key: "lastUsed",
      header: t("admin.onb.colLastUsed"),
      render: (r) => <span className="text-[13px]">{r.lastUsedAt ? fmtDateTime(r.lastUsedAt) : "—"}</span>,
    },
    { key: "created", header: t("common.createdAt"), render: (r) => <span className="text-[13px]">{fmtDateTime(r.createdAt)}</span> },
    {
      key: "actions",
      header: t("common.actions"),
      align: "right",
      render: (r) =>
        r.status === "active" ? (
          <Button size="sm" variant="ghost" onClick={() => setStatus(r.id, "revoked")}>
            {t("admin.onb.revoke")}
          </Button>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setStatus(r.id, "active")}>
            {t("admin.onb.enable")}
          </Button>
        ),
    },
  ];

  return (
    <div>
      <PageHeader
        title={t("admin.onb.title")}
        desc={t("admin.onb.desc")}
        actions={
          <Button variant="primary" onClick={() => { setIssued(null); setCreateOpen(true); }}>
            {t("admin.onb.issue")}
          </Button>
        }
      />
      <AccountTabs />
      <Card>
        <DataTable
          columns={columns}
          rows={state.data ?? []}
          rowKey={(r) => r.id}
          loading={state.loading}
          empty={<EmptyState title={t("admin.onb.empty")} />}
        />
      </Card>

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title={t("admin.onb.issueTitle")}
        footer={
          issued ? (
            <Button variant="primary" onClick={() => setCreateOpen(false)}>{t("common.done")}</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => setCreateOpen(false)}>{t("common.cancel")}</Button>
              <Button variant="primary" disabled={!label.trim() || !nodeId} onClick={create}>
                {t("admin.onb.issueSubmit")}
              </Button>
            </>
          )
        }
      >
        {issued ? (
          <div className="flex flex-col gap-3">
            <p className="text-[13.5px] font-semibold" style={{ color: "var(--success)" }}>
              {t("admin.onb.createdOnce")}
            </p>
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
              <Select
                value={nodeId}
                onChange={(e) => setNodeId(e.target.value)}
                options={[
                  { value: "", label: t("admin.onb.pickNode") },
                  { value: "*", label: t("admin.onb.anyNode") },
                  ...(nodes.data ?? []).map((n) => ({
                    value: n.nodeId,
                    label: `${n.nodeId.slice(0, 20)}… ${n.online ? "online" : "offline"}`,
                  })),
                ]}
              />
            </Field>
          </div>
        )}
      </Modal>
    </div>
  );
}
