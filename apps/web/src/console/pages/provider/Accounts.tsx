import { useState } from "react";
import { Link } from "react-router-dom";
import { PlugIcon, RocketIcon } from "../../../components/Icon";
import { PLATFORMS, api, platformLabel, type ProviderAccount } from "../../api";
import { useCT } from "../../i18n";
import { useProxyHosts } from "../shared/proxyHosts";
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
  Segmented,
  Select,
  StatusBadge,
  Textarea,
  Toggle,
  fmtNum,
  fmtPct,
  fmtUsd,
  useAsync,
  useRelTime,
  useToast,
  type Column,
} from "../../ui";

/** Anthropic subscription accounts carry usage windows (docs/ccr-supply.md §7). */
const hasWindow = (a: ProviderAccount) => a.type === "oauth" && a.platform === "anthropic";
const isFuture = (iso: string | null | undefined) => !!iso && new Date(iso).getTime() > Date.now();

interface Form {
  name: string;
  platform: string;
  type: "apikey" | "upstream";
  protocol: "anthropic" | "openai";
  baseUrl: string;
  apiKey: string;
  models: string;
  route: "direct" | "node";
  active: boolean;
}

const emptyForm: Form = {
  name: "",
  platform: "openai",
  type: "upstream",
  protocol: "openai",
  baseUrl: "",
  apiKey: "",
  models: "",
  route: "direct",
  active: true,
};

function parseModels(s: string): string[] {
  return s
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

export function ProviderAccounts() {
  const { t } = useCT();
  const toast = useToast();
  const rel = useRelTime();
  const accounts = useAsync(() => api.get<ProviderAccount[]>("/api/provider/accounts"), []);
  const proxyHosts = useProxyHosts("provider", accounts.data ?? []);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ProviderAccount | null>(null);
  const [form, setForm] = useState<Form>(emptyForm);
  const [busy, setBusy] = useState(false);

  const platform = PLATFORMS.find((p) => p.id === form.platform);
  const needsBase = form.type === "upstream" || !platform?.baseUrl;

  function openCreate() {
    setForm(emptyForm);
    setCreating(true);
  }

  function openEdit(a: ProviderAccount) {
    setForm({
      ...emptyForm,
      name: a.name,
      platform: a.platform,
      type: a.type === "apikey" ? "apikey" : "upstream",
      protocol: a.protocol,
      baseUrl: a.baseUrl ?? "",
      models: a.models.join("\n"),
      route: a.route,
      active: a.status !== "disabled",
    });
    setEditing(a);
  }

  async function submitCreate() {
    setBusy(true);
    try {
      await api.post("/api/provider/accounts", {
        name: form.name.trim(),
        platform: form.platform,
        type: form.type,
        protocol: form.protocol,
        baseUrl: form.baseUrl.trim() || undefined,
        apiKey: form.apiKey.trim(),
        models: parseModels(form.models),
        route: form.route,
      });
      setCreating(false);
      toast.success(t("provider.accounts.submitted"));
      accounts.reload();
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
      const isOauth = editing.type === "oauth";
      const body: Record<string, unknown> = { name: form.name.trim() };
      if (!isOauth) {
        body.models = parseModels(form.models);
        if (form.apiKey.trim()) body.apiKey = form.apiKey.trim();
        if ((form.baseUrl.trim() || null) !== (editing.baseUrl ?? null)) body.baseUrl = form.baseUrl.trim() || null;
      }
      const wantStatus = form.active ? "active" : "disabled";
      if ((editing.status === "disabled") !== !form.active && editing.status !== "error") body.status = wantStatus;
      if (editing.status === "error" && !form.active) body.status = "disabled";
      const res = await api.patch<ProviderAccount>(`/api/provider/accounts/${editing.id}`, body);
      setEditing(null);
      toast.success(res.reviewStatus === "pending" && editing.reviewStatus !== "pending" ? t("provider.accounts.backToReview") : t("common.saved"));
      accounts.reload();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  const columns: Column<ProviderAccount>[] = [
    {
      key: "name",
      header: t("common.name"),
      render: (a) => (
        <div className="min-w-[160px]">
          <div className="font-medium">{a.name}</div>
          <div className="text-[12px] text-on-surface-faint">
            {platformLabel(a.platform)} · {t(`type.${a.type}`)}
            {a.accountEmail && a.accountEmail !== a.name ? ` · ${a.accountEmail}` : ""}
          </div>
          <div className="mt-1 flex flex-wrap gap-1">
            <Badge tone={a.executor === "direct" ? "neutral" : "info"}>{t(`executor.${a.executor ?? "direct"}`)}</Badge>
          </div>
        </div>
      ),
    },
    { key: "route", header: t("provider.accounts.route"), render: (a) => <Badge tone={a.route === "node" ? "info" : "neutral"}>{t(`route.${a.route}`)}</Badge> },
    {
      key: "limits",
      header: t("provider.accounts.limits"),
      align: "right",
      render: (a) => (
        <div className="font-mono text-[12.5px] tabular-nums">
          <div>{t("provider.accounts.limitsValue", { c: a.concurrency || "∞", rpm: a.rpmLimit || "∞" })}</div>
          {a.boundProxyId && (
            <div className="max-w-[160px] truncate text-[12px] text-on-surface-faint" title={a.boundProxyId}>
              {proxyHosts.get(a.boundProxyId) ?? `${a.boundProxyId.slice(0, 10)}…`}
            </div>
          )}
        </div>
      ),
    },
    {
      key: "review",
      header: t("provider.accounts.review"),
      render: (a) => (
        <div className="max-w-[220px] whitespace-normal">
          <StatusBadge status={a.reviewStatus} />
          {a.reviewNote && <div className="mt-1 text-[12px] text-on-surface-faint">{a.reviewNote}</div>}
        </div>
      ),
    },
    {
      key: "status",
      header: t("common.status"),
      render: (a) => (
        <div className="max-w-[220px] whitespace-normal">
          <div className="flex flex-wrap gap-1">
            <StatusBadge status={a.status} title={a.errorMessage ?? undefined} />
            {a.coolingUntil && <StatusBadge status="cooling" title={a.coolingUntil} />}
            {isFuture(a.windowExhaustedUntil) && (
              <Badge tone="warning" title={rel(a.windowExhaustedUntil)}>
                {t("provider.accounts.windowExhausted")}
              </Badge>
            )}
          </div>
          {a.status === "error" && a.errorMessage && <div className="mt-1 text-[12px] text-error">{a.errorMessage}</div>}
          {a.coolingUntil && <div className="mt-1 text-[12px] text-on-surface-faint">{t("provider.accounts.until", { at: rel(a.coolingUntil) })}</div>}
          {hasWindow(a) && (
            <div className="mt-1 w-[160px] text-[12px] text-on-surface-faint">
              {a.windowUsed == null ? (
                t("provider.accounts.windowUnknown")
              ) : (
                <>
                  <ProgressBar value={a.windowUsed} max={1} />
                  <div className="mt-0.5 truncate">
                    {t("provider.accounts.windowUsage", {
                      pct: fmtPct(a.windowUsed),
                      reset: a.windowResetAt ? rel(a.windowResetAt) : "—",
                    })}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      ),
    },
    { key: "payout", header: t("provider.accounts.payout"), align: "right", render: (a) => <span className="font-mono tabular-nums">{a.reviewStatus === "approved" ? fmtPct(a.payoutRate) : "—"}</span> },
    {
      key: "30d",
      header: t("provider.accounts.last30d"),
      align: "right",
      render: (a) => (
        <div className="font-mono text-[12.5px] tabular-nums">
          <div>{fmtUsd(a.earning30d)}</div>
          <div className="text-on-surface-faint">{fmtNum(a.requests30d)} req</div>
        </div>
      ),
    },
    { key: "last", header: t("common.lastUsed"), render: (a) => <span className="text-on-surface-variant">{a.lastUsedAt ? rel(a.lastUsedAt) : t("common.never")}</span> },
    {
      key: "actions",
      header: t("common.actions"),
      align: "right",
      render: (a) => (
        <div className="flex justify-end gap-2">
          <Button onClick={() => openEdit(a)}>{t("common.edit")}</Button>
          <ConfirmButton
            variant="danger"
            title={t("provider.accounts.deleteTitle", { name: a.name })}
            message={t("provider.accounts.deleteMsg")}
            confirmLabel={t("common.delete")}
            onConfirm={async () => {
              await api.del(`/api/provider/accounts/${a.id}`);
              toast.success(t("provider.accounts.deleted"));
              accounts.reload();
            }}
          >
            {t("common.delete")}
          </ConfirmButton>
        </div>
      ),
    },
  ];

  const isOauthEdit = editing?.type === "oauth";

  return (
    <>
      <PageHeader
        title={t("nav.accounts")}
        desc={t("provider.accounts.desc")}
        actions={
          <>
            <Link to="/console/provider/onboard" className="wk-btn wk-btn-sm wk-btn-soft">
              <RocketIcon width={15} height={15} />
              {t("nav.onboard")}
            </Link>
            <Button variant="primary" onClick={openCreate}>
              <PlugIcon width={15} height={15} />
              {t("provider.accounts.submit")}
            </Button>
          </>
        }
      />
      <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="card p-4">
            <div className="kicker">
              <span className="kicker-dot" />
              {t(`provider.accounts.flow${i}Title`)}
            </div>
            <p className="mt-2 text-[13px] leading-relaxed text-on-surface-variant">{t(`provider.accounts.flow${i}`)}</p>
          </div>
        ))}
      </div>
      <Card bodyClassName="">
        <Async state={accounts} rows={5}>
          {(list) => (
            <DataTable
              columns={columns}
              rows={list}
              rowKey={(a) => a.id}
              minWidth={1280}
              empty={
                <EmptyState
                  title={t("provider.accounts.emptyTitle")}
                  desc={t("provider.accounts.emptyDesc")}
                  action={
                    <Button variant="primary" onClick={openCreate}>
                      {t("provider.accounts.submit")}
                    </Button>
                  }
                />
              }
            />
          )}
        </Async>
      </Card>

      <Modal
        open={creating}
        size="lg"
        title={t("provider.accounts.submit")}
        onClose={() => !busy && setCreating(false)}
        footer={
          <>
            <Button onClick={() => setCreating(false)} disabled={busy}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={!form.name.trim() || !form.apiKey.trim() || (needsBase && !form.baseUrl.trim())}
              onClick={() => void submitCreate()}
            >
              {t("provider.accounts.submitForReview")}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <p className="rounded-md px-3 py-2 text-[13px] text-on-surface-variant" style={{ background: "var(--surface-variant)" }}>
            {t("provider.accounts.reviewNotice")}
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label={t("common.name")}>
              <Input value={form.name} maxLength={80} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="my-openai-relay" />
            </Field>
            <Field label={t("common.platform")}>
              <Select
                value={form.platform}
                onChange={(e) => {
                  const p = PLATFORMS.find((x) => x.id === e.target.value);
                  setForm({ ...form, platform: e.target.value, protocol: p?.protocol ?? "openai" });
                }}
                options={PLATFORMS.map((p) => ({ value: p.id, label: p.label }))}
              />
            </Field>
          </div>
          <Field label={t("common.type")}>
            <Segmented<Form["type"]>
              value={form.type}
              onChange={(v) => setForm({ ...form, type: v })}
              options={[
                { value: "apikey", label: t("type.apikey") },
                { value: "upstream", label: t("type.upstream") },
              ]}
            />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_2fr]">
            <Field label={t("provider.accounts.protocol")} hint={t("provider.accounts.protocolHint")}>
              <Select
                value={form.protocol}
                onChange={(e) => setForm({ ...form, protocol: e.target.value as Form["protocol"] })}
                options={[
                  { value: "openai", label: "OpenAI" },
                  { value: "anthropic", label: "Anthropic" },
                ]}
              />
            </Field>
            <Field
              label={`Base URL${needsBase ? "" : ` (${t("common.optional")})`}`}
              hint={form.protocol === "openai" ? t("provider.accounts.baseOpenai") : t("provider.accounts.baseAnthropic")}
            >
              <Input value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder={platform?.baseUrl ?? "https://example.com/v1"} />
            </Field>
          </div>
          <Field label="API Key">
            <Input type="password" autoComplete="off" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} placeholder="sk-..." />
          </Field>
          <Field label={`${t("provider.accounts.models")} (${t("common.optional")})`} hint={t("provider.accounts.modelsHint")}>
            <Textarea value={form.models} onChange={(e) => setForm({ ...form, models: e.target.value })} placeholder={"gpt-5.5\nclaude-*"} />
          </Field>
          <Field label={t("provider.accounts.route")} hint={t("provider.accounts.routeHint")}>
            <Segmented<Form["route"]>
              value={form.route}
              onChange={(v) => setForm({ ...form, route: v })}
              options={[
                { value: "direct", label: t("route.direct") },
                { value: "node", label: t("route.node") },
              ]}
            />
          </Field>
        </div>
      </Modal>

      <Modal
        open={!!editing}
        title={t("provider.accounts.editTitle", { name: editing?.name ?? "" })}
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
        {editing && (
          <div className="space-y-4">
            {isOauthEdit ? (
              <p className="rounded-md px-3 py-2 text-[13px] text-on-surface-variant" style={{ background: "var(--surface-variant)" }}>
                {t("provider.accounts.oauthNote")}
              </p>
            ) : (
              <p className="rounded-md px-3 py-2 text-[13px]" style={{ background: "var(--warning-container)", color: "var(--warning)" }}>
                {t("provider.accounts.editWarning")}
              </p>
            )}
            <Field label={t("common.name")}>
              <Input value={form.name} maxLength={80} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            {!isOauthEdit && (
              <>
                <Field label="Base URL" hint={<Mono>{platformLabel(editing.platform)} · {editing.protocol}</Mono>}>
                  <Input value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder={PLATFORMS.find((p) => p.id === editing.platform)?.baseUrl ?? ""} />
                </Field>
                <Field label={t("provider.accounts.newKey")} hint={t("provider.accounts.newKeyHint")}>
                  <Input type="password" autoComplete="off" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} />
                </Field>
                <Field label={t("provider.accounts.models")} hint={t("provider.accounts.modelsHint")}>
                  <Textarea value={form.models} onChange={(e) => setForm({ ...form, models: e.target.value })} />
                </Field>
              </>
            )}
            {editing.status === "error" ? (
              <p className="text-[13px] text-error">{t("provider.accounts.errorNote")}</p>
            ) : (
              <Toggle checked={form.active} onChange={(v) => setForm({ ...form, active: v })} label={t("provider.accounts.enabled")} />
            )}
          </div>
        )}
      </Modal>
    </>
  );
}
