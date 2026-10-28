import { useState } from "react";
import { SparkleIcon } from "../../../components/Icon";
import { api, type Paged, type RedeemCode } from "../../api";
import { useCT } from "../../i18n";
import {
  Async,
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
  Pagination,
  Select,
  StatusBadge,
  Toolbar,
  errMessage,
  fmtDateTime,
  fmtUsd,
  useAsync,
  useToast,
  type Column,
} from "../../ui";

type RedeemPage = Paged<RedeemCode> & { batches: string[] };

interface Generated {
  codes: string[];
  valueUsd: number;
  count: number;
  batch: string | null;
}

export function AdminRedeem() {
  const { t } = useCT();
  const toast = useToast();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const [batch, setBatch] = useState("");
  const [q, setQ] = useState("");
  const [qApplied, setQApplied] = useState("");
  const [genOpen, setGenOpen] = useState(false);
  const [generated, setGenerated] = useState<Generated | null>(null);

  const state = useAsync(
    () => api.get<RedeemPage>("/api/admin/redeem-codes", { page, pageSize: 20, status, batch, q: qApplied }),
    [page, status, batch, qApplied],
  );

  const filter = (fn: () => void) => {
    fn();
    setPage(1);
  };

  async function setCodeStatus(code: string, next: "disabled" | "unused") {
    await api.patch(`/api/admin/redeem-codes/${code}`, { status: next });
    toast.success(t(next === "disabled" ? "admin.redeem.disabledToast" : "admin.redeem.enabledToast"));
    state.reload();
  }

  const columns: Column<RedeemCode>[] = [
    {
      key: "code",
      header: t("admin.redeem.colCode"),
      render: (r) => (
        <span className="inline-flex items-center gap-1">
          <code className="font-mono text-[12.5px] tracking-wide">{r.code}</code>
          <CopyIconButton text={r.code} />
        </span>
      ),
    },
    { key: "value", header: t("admin.redeem.colValue"), align: "right", render: (r) => <span className="font-mono tabular-nums">{fmtUsd(r.valueUsd, 2)}</span> },
    { key: "status", header: t("common.status"), render: (r) => <StatusBadge status={r.status} /> },
    { key: "batch", header: t("admin.redeem.colBatch"), render: (r) => <span className="text-[13px]">{r.batch ?? "—"}</span> },
    { key: "usedBy", header: t("admin.redeem.colUsedBy"), render: (r) => <span className="text-[13px]">{r.usedByName ?? (r.usedBy ? r.usedBy.slice(0, 8) : "—")}</span> },
    { key: "usedAt", header: t("admin.redeem.colUsedAt"), render: (r) => <span className="text-[13px] text-on-surface-variant">{fmtDateTime(r.usedAt)}</span> },
    { key: "expires", header: t("admin.redeem.colExpires"), render: (r) => <span className="text-[13px] text-on-surface-variant">{r.expiresAt ? fmtDateTime(r.expiresAt) : t("common.never")}</span> },
    { key: "created", header: t("common.createdAt"), render: (r) => <span className="text-[13px] text-on-surface-variant">{fmtDateTime(r.createdAt)}</span> },
    {
      key: "actions",
      header: t("common.actions"),
      align: "right",
      render: (r) =>
        r.status === "used" ? (
          <span className="text-on-surface-faint">—</span>
        ) : (
          <div className="flex justify-end gap-1.5">
            {r.status === "unused" ? (
              <Button size="sm" onClick={() => void setCodeStatus(r.code, "disabled").catch(toast.error)}>
                {t("common.disable")}
              </Button>
            ) : (
              <Button size="sm" onClick={() => void setCodeStatus(r.code, "unused").catch(toast.error)}>
                {t("admin.redeem.reEnable")}
              </Button>
            )}
            <ConfirmButton
              variant="danger"
              message={t("admin.redeem.deleteConfirm", { code: r.code })}
              confirmLabel={t("common.delete")}
              onConfirm={async () => {
                await api.del(`/api/admin/redeem-codes/${r.code}`);
                toast.success(t("admin.redeem.deleted"));
                state.reload();
              }}
            >
              {t("common.delete")}
            </ConfirmButton>
          </div>
        ),
    },
  ];

  return (
    <div>
      <PageHeader
        title={t("admin.redeem.title")}
        desc={t("admin.redeem.desc")}
        actions={
          <Button variant="primary" onClick={() => setGenOpen(true)}>
            <SparkleIcon width={15} height={15} />
            {t("admin.redeem.generate")}
          </Button>
        }
      />
      <Card bodyClassName="p-0">
        <Toolbar>
          <form
            className="flex w-full flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              filter(() => setQApplied(q.trim()));
            }}
          >
            <Field label={t("common.search")} className="w-full sm:w-60">
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("admin.redeem.searchPh")} />
            </Field>
            <Field label={t("common.status")} className="w-[calc(50%-6px)] sm:w-36">
              <Select
                value={status}
                onChange={(e) => filter(() => setStatus(e.target.value))}
                options={[
                  { value: "", label: t("common.all") },
                  ...["unused", "used", "disabled"].map((s) => ({ value: s, label: t(`status.${s}`) })),
                ]}
              />
            </Field>
            <Field label={t("admin.redeem.colBatch")} className="w-[calc(50%-6px)] sm:w-48">
              <Select
                value={batch}
                onChange={(e) => filter(() => setBatch(e.target.value))}
                options={[{ value: "", label: t("admin.redeem.allBatches") }, ...(state.data?.batches ?? []).map((b) => ({ value: b, label: b }))]}
              />
            </Field>
            <Button type="submit">{t("common.search")}</Button>
          </form>
        </Toolbar>
        <Async state={state} rows={6}>
          {(d) => (
            <>
              <DataTable
                columns={columns}
                rows={d.items}
                rowKey={(r) => r.code}
                minWidth={1080}
                loading={state.loading}
                empty={
                  <EmptyState
                    title={t("admin.redeem.empty")}
                    action={
                      <Button variant="primary" onClick={() => setGenOpen(true)}>
                        {t("admin.redeem.generate")}
                      </Button>
                    }
                  />
                }
              />
              <Pagination page={d.page} pageSize={d.pageSize} total={d.total} onPage={setPage} />
            </>
          )}
        </Async>
      </Card>

      <GenerateModal
        open={genOpen}
        onClose={() => setGenOpen(false)}
        onDone={(g) => {
          setGenerated(g);
          setPage(1);
          state.reload();
        }}
      />

      <Modal
        open={!!generated}
        size="md"
        title={generated ? t("admin.redeem.resultTitle", { n: generated.count, value: fmtUsd(generated.valueUsd, 2) }) : ""}
        onClose={() => setGenerated(null)}
        footer={
          <>
            {generated && <CopyButton size="md" text={generated.codes.join("\n")} label={t("admin.redeem.copyAll")} />}
            <Button size="md" variant="primary" onClick={() => setGenerated(null)}>
              {t("common.close")}
            </Button>
          </>
        }
      >
        {generated && (
          <div>
            <p className="mb-3 text-[13px] text-on-surface-variant">{t("admin.redeem.resultNote")}</p>
            <ul
              className="max-h-[50vh] overflow-y-auto rounded-md p-2"
              style={{ background: "var(--code-bg)", color: "var(--code-fg)" }}
            >
              {generated.codes.map((c) => (
                <li key={c} className="flex items-center justify-between gap-2 px-2 py-1">
                  <code className="font-mono text-[13px] tracking-wide">{c}</code>
                  <CopyIconButton text={c} />
                </li>
              ))}
            </ul>
          </div>
        )}
      </Modal>
    </div>
  );
}

function GenerateModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (g: Generated) => void }) {
  const { t } = useCT();
  const [value, setValue] = useState("10");
  const [count, setCount] = useState("10");
  const [batch, setBatch] = useState("");
  const [expires, setExpires] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    const v = Number(value);
    const c = Number(count);
    if (!Number.isFinite(v) || v < 0.01) return setErr(t("admin.redeem.errValue"));
    if (!Number.isInteger(c) || c < 1 || c > 500) return setErr(t("admin.redeem.errCount"));
    setErr(null);
    setBusy(true);
    try {
      const g = await api.post<Generated>("/api/admin/redeem-codes", {
        valueUsd: v,
        count: c,
        batch: batch.trim() || undefined,
        // end of the chosen local day
        expiresAt: expires ? new Date(`${expires}T23:59:59`).toISOString() : undefined,
      });
      onDone(g);
      onClose();
      setBatch("");
      setExpires("");
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      size="sm"
      title={t("admin.redeem.generate")}
      onClose={() => !busy && onClose()}
      footer={
        <>
          {err && <span className="mr-auto text-[13px] text-error">{err}</span>}
          <Button onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            {t("admin.redeem.generate")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("admin.redeem.value")}>
            <Input type="number" min={0.01} step="0.01" value={value} onChange={(e) => setValue(e.target.value)} />
          </Field>
          <Field label={t("admin.redeem.count")} hint={t("admin.redeem.countHint")}>
            <Input type="number" min={1} max={500} value={count} onChange={(e) => setCount(e.target.value)} />
          </Field>
        </div>
        <Field label={`${t("admin.redeem.batch")} (${t("common.optional")})`} hint={t("admin.redeem.batchHint")}>
          <Input value={batch} onChange={(e) => setBatch(e.target.value)} maxLength={64} />
        </Field>
        <Field label={`${t("admin.redeem.expires")} (${t("common.optional")})`} hint={t("admin.redeem.expiresHint")}>
          <Input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
