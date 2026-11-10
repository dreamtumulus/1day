import { useEffect, useMemo, useState } from "react";
import { PLATFORMS, api, platformLabel, type AdminModel, type ModelPrices } from "../../api";
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
  PageHeader,
  Select,
  Toggle,
  Toolbar,
  errMessage,
  useAsync,
  useToast,
  type Column,
} from "../../ui";

// cacheWritePerM is the 1-hour cache write price (what the platform billed every cache write with before X-51);
// cacheWrite5mPerM is the 5-minute one and may be left blank on an override: 0.625 x the 1-hour price then.
const PRICE_KEYS: Array<keyof ModelPrices> = ["inputPerM", "outputPerM", "cacheReadPerM", "cacheWrite5mPerM", "cacheWritePerM"];
const PRICE_LABEL: Record<keyof ModelPrices, string> = {
  inputPerM: "admin.models.colInput",
  outputPerM: "admin.models.colOutput",
  cacheReadPerM: "admin.models.colCacheRead",
  cacheWrite5mPerM: "admin.models.colCacheWrite5m",
  cacheWritePerM: "admin.models.colCacheWrite1h",
};
const CACHE_WRITE_5M_FALLBACK_RATIO = 0.625;
/** The override row has no 5-minute price of its own: the shown one is derived from the 1-hour price. */
const derived5m = (m: AdminModel | null | undefined): boolean => !!m && m.overridden && m.cacheWrite5mExplicit === false;

function price(n: number): string {
  if (!n) return "$0";
  return `$${n < 0.01 ? n.toFixed(4) : n < 10 ? n.toFixed(3).replace(/0+$/, "").replace(/\.$/, "") : n.toFixed(2)}`;
}

function PriceCell({ m, k }: { m: AdminModel; k: keyof ModelPrices }) {
  const { t } = useCT();
  const cur = m.prices[k];
  const cat = m.catalogPrices?.[k];
  const changed = m.overridden && cat !== undefined && Math.abs(cat - cur) > 1e-9;
  return (
    <div className="font-mono tabular-nums">
      <div className={changed ? "font-semibold text-primary" : ""} title={k === "cacheWrite5mPerM" && derived5m(m) ? t("admin.models.cacheWrite5mDerived") : undefined}>
        {price(cur)}
        {k === "cacheWrite5mPerM" && derived5m(m) && <span className="ml-0.5 text-on-surface-faint">*</span>}
      </div>
      {changed && (
        <div className="text-[11.5px] text-on-surface-faint line-through" title={t("admin.models.catalogWas", { price: price(cat!) })}>
          {price(cat!)}
        </div>
      )}
    </div>
  );
}

export function AdminModels() {
  const { t } = useCT();
  const toast = useToast();
  const state = useAsync(() => api.get<AdminModel[]>("/api/admin/models"));
  const [q, setQ] = useState("");
  const [platform, setPlatform] = useState("");
  const [source, setSource] = useState("");
  const [editing, setEditing] = useState<AdminModel | null>(null);
  const [adding, setAdding] = useState(false);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (state.data ?? []).filter(
      (m) =>
        (!platform || m.platform === platform) &&
        (!source || (source === "overridden" ? m.overridden : m.source === source)) &&
        (!needle || m.modelId.toLowerCase().includes(needle) || m.displayName.toLowerCase().includes(needle)),
    );
  }, [state.data, q, platform, source]);

  const platformsPresent = useMemo(() => {
    const set = new Set((state.data ?? []).map((m) => m.platform));
    return PLATFORMS.filter((p) => set.has(p.id));
  }, [state.data]);

  async function toggle(m: AdminModel, enabled: boolean) {
    try {
      await api.put(`/api/admin/models/${encodeURIComponent(m.modelId)}`, {
        displayName: m.displayName,
        platform: m.platform,
        ...m.prices,
        // keep a derived 5-minute price derived (null), do not freeze today's computed value into the row
        cacheWrite5mPerM: derived5m(m) ? null : m.prices.cacheWrite5mPerM,
        enabled,
      });
      toast.success(t("admin.models.toggled"));
      state.reload();
    } catch (e) {
      toast.error(e);
    }
  }

  const columns: Column<AdminModel>[] = [
    {
      key: "model",
      header: t("admin.models.colModel"),
      render: (m) => (
        <div className="min-w-[200px]">
          <div className="font-mono text-[13px] text-on-surface">{m.modelId}</div>
          <div className="text-[12.5px] text-on-surface-faint">{m.displayName}</div>
        </div>
      ),
    },
    { key: "platform", header: t("common.platform"), render: (m) => <span className="text-[13.5px]">{platformLabel(m.platform)}</span> },
    {
      key: "source",
      header: t("admin.models.colSource"),
      render: (m) => (
        <div className="flex flex-wrap gap-1">
          <Badge tone={m.source === "custom" ? "info" : "neutral"}>
            {t(m.source === "custom" ? "admin.models.sourceCustom" : "admin.models.sourceCatalog")}
          </Badge>
          {m.source === "catalog" && m.overridden && <Badge tone="primary">{t("admin.models.overridden")}</Badge>}
        </div>
      ),
    },
    ...PRICE_KEYS.map(
      (k): Column<AdminModel> => ({
        key: k,
        header: t(PRICE_LABEL[k]),
        align: "right",
        render: (m) => <PriceCell m={m} k={k} />,
      }),
    ),
    {
      key: "enabled",
      header: t("common.status"),
      render: (m) => <Toggle checked={m.enabled} onChange={(v) => void toggle(m, v)} />,
    },
    {
      key: "actions",
      header: t("common.actions"),
      align: "right",
      render: (m) => (
        <div className="flex justify-end gap-1.5">
          <Button size="sm" onClick={() => setEditing(m)}>
            {t("common.edit")}
          </Button>
          {m.overridden && (
            <ConfirmButton
              variant={m.source === "custom" ? "danger" : "ghost"}
              message={t(m.source === "custom" ? "admin.models.deleteConfirm" : "admin.models.restoreConfirm", { id: m.modelId })}
              onConfirm={async () => {
                await api.del(`/api/admin/models/${encodeURIComponent(m.modelId)}`);
                toast.success(t(m.source === "custom" ? "admin.models.deleted" : "admin.models.restored"));
                state.reload();
              }}
            >
              {t(m.source === "custom" ? "common.delete" : "admin.models.restore")}
            </ConfirmButton>
          )}
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title={t("admin.models.title")}
        desc={t("admin.models.desc")}
        actions={
          <Button variant="primary" onClick={() => setAdding(true)}>
            {t("admin.models.add")}
          </Button>
        }
      />
      <Card bodyClassName="p-0">
        <Toolbar>
          <Field label={t("common.search")} className="w-full sm:w-64">
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("admin.models.searchPh")} />
          </Field>
          <Field label={t("common.platform")} className="w-[calc(50%-6px)] sm:w-44">
            <Select
              value={platform}
              onChange={(e) => setPlatform(e.target.value)}
              options={[{ value: "", label: t("common.all") }, ...platformsPresent.map((p) => ({ value: p.id, label: p.label }))]}
            />
          </Field>
          <Field label={t("admin.models.colSource")} className="w-[calc(50%-6px)] sm:w-40">
            <Select
              value={source}
              onChange={(e) => setSource(e.target.value)}
              options={[
                { value: "", label: t("common.all") },
                { value: "catalog", label: t("admin.models.sourceCatalog") },
                { value: "custom", label: t("admin.models.sourceCustom") },
                { value: "overridden", label: t("admin.models.overridden") },
              ]}
            />
          </Field>
          <div className="ml-auto self-center text-[12.5px] text-on-surface-faint">
            {state.data && t("admin.models.count", { shown: rows.length, total: state.data.length })} · {t("admin.models.perM")}
          </div>
        </Toolbar>
        <Async state={state} rows={8}>
          {() => (
            <DataTable
              columns={columns}
              rows={rows}
              rowKey={(m) => m.modelId}
              minWidth={1180}
              loading={state.loading}
              empty={<EmptyState title={t("admin.models.empty")} />}
            />
          )}
        </Async>
      </Card>
      <ModelModal
        open={adding || !!editing}
        model={editing}
        onClose={() => {
          setAdding(false);
          setEditing(null);
        }}
        onSaved={state.reload}
      />
    </div>
  );
}

function ModelModal({
  open,
  model,
  onClose,
  onSaved,
}: {
  open: boolean;
  model: AdminModel | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useCT();
  const toast = useToast();
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [platform, setPlatform] = useState("openai");
  const [enabled, setEnabled] = useState(true);
  const [prices, setPrices] = useState<Record<keyof ModelPrices, string>>({
    inputPerM: "0",
    outputPerM: "0",
    cacheReadPerM: "0",
    cacheWrite5mPerM: "",
    cacheWritePerM: "0",
  });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setErr(null);
    setId(model?.modelId ?? "");
    setName(model?.displayName ?? "");
    setPlatform(model?.platform ?? "openai");
    setEnabled(model?.enabled ?? true);
    setPrices({
      inputPerM: String(model?.prices.inputPerM ?? 0),
      outputPerM: String(model?.prices.outputPerM ?? 0),
      cacheReadPerM: String(model?.prices.cacheReadPerM ?? 0),
      // blank = no own 5-minute price (0.625 x the 1-hour price)
      cacheWrite5mPerM: !model || derived5m(model) ? "" : String(model.prices.cacheWrite5mPerM ?? 0),
      cacheWritePerM: String(model?.prices.cacheWritePerM ?? 0),
    });
  }, [open, model]);

  async function save() {
    const modelId = id.trim();
    if (!/^[\w.:/@+-]{1,120}$/.test(modelId)) {
      setErr(t("admin.models.errId"));
      return;
    }
    const body: Record<string, unknown> = { displayName: name.trim() || modelId, platform, enabled };
    for (const k of PRICE_KEYS) {
      if (k === "cacheWrite5mPerM" && prices[k].trim() === "") {
        body[k] = null;
        continue;
      }
      const n = Number(prices[k]);
      if (!Number.isFinite(n) || n < 0) {
        setErr(`${t(PRICE_LABEL[k])}: ≥ 0`);
        return;
      }
      body[k] = n;
    }
    setBusy(true);
    setErr(null);
    try {
      await api.put(`/api/admin/models/${encodeURIComponent(modelId)}`, body);
      toast.success(t("admin.models.saved"));
      onSaved();
      onClose();
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      title={model ? t("admin.models.edit", { id: model.modelId }) : t("admin.models.add")}
      onClose={() => !busy && onClose()}
      footer={
        <>
          {err && <span className="mr-auto text-[13px] text-error">{err}</span>}
          <Button onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void save()}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={t("admin.models.modelId")} hint={t("admin.models.modelIdHint")}>
          <Input value={id} onChange={(e) => setId(e.target.value)} disabled={!!model} className="font-mono" placeholder="my-model-v1" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("admin.models.displayName")}>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={t("common.platform")}>
            <Select value={platform} onChange={(e) => setPlatform(e.target.value)} options={PLATFORMS.map((p) => ({ value: p.id, label: p.label }))} />
          </Field>
        </div>
        <div>
          <div className="label">{t("admin.models.perM")}</div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            {PRICE_KEYS.map((k) => (
              <Field
                key={k}
                label={<span className="text-[13px]">{t(PRICE_LABEL[k])}</span>}
                hint={model?.catalogPrices ? t("admin.models.catalogWas", { price: price(model.catalogPrices[k]) }) : undefined}
              >
                <Input
                  type="number"
                  min={0}
                  step="0.0001"
                  value={prices[k]}
                  placeholder={k === "cacheWrite5mPerM" && Number(prices.cacheWritePerM) > 0 ? String(Number((Number(prices.cacheWritePerM) * CACHE_WRITE_5M_FALLBACK_RATIO).toFixed(6))) : undefined}
                  onChange={(e) => setPrices((p) => ({ ...p, [k]: e.target.value }))}
                  className="font-mono"
                />
              </Field>
            ))}
          </div>
          <div className="mt-2 text-[12.5px] text-on-surface-faint">{t("admin.models.cacheWriteHint")}</div>
        </div>
        <Toggle checked={enabled} onChange={setEnabled} label={t("common.enabled")} />
      </div>
    </Modal>
  );
}
