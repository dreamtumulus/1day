import { useEffect, useState, type ReactNode } from "react";
import { PLATFORMS, api, type AccountExecutor, type AccountType, type AdminAccount, type AdminUser, type Group, type NodeRow } from "../../api";
import { useCT } from "../../i18n";
import { Button, ChipSelect, Field, Input, Modal, Select, Textarea, errMessage, useToast } from "../../ui";

// Create / edit modal for upstream accounts (docs/v3-design.md §5, §8.4).

interface FormState {
  name: string;
  platform: string;
  type: AccountType;
  executor: AccountExecutor;
  protocol: "anthropic" | "openai";
  baseUrl: string;
  apiKey: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: string; // datetime-local
  accountId: string;
  orgUuid: string;
  teamName: string;
  environmentId: string;
  modelsText: string;
  mappingText: string;
  groupIds: string[];
  priority: string;
  concurrency: string;
  rpmLimit: string;
  rawPassthrough: boolean;
  route: "direct" | "node";
  ownerId: string;
  nodeId: string;
  payoutRate: string;
}

/** Pre-filled routing when the form is opened from a node row (Nodes page). */
export interface AccountFormPreset {
  nodeId?: string;
  ownerId?: string;
}

function blank(defaultGroupIds: string[], preset?: AccountFormPreset): FormState {
  return {
    name: "",
    platform: "anthropic",
    type: "apikey",
    executor: "direct",
    protocol: "anthropic",
    baseUrl: "",
    apiKey: "",
    accessToken: "",
    refreshToken: "",
    expiresAt: "",
    accountId: "",
    orgUuid: "",
    teamName: "",
    environmentId: "",
    modelsText: "",
    mappingText: "",
    groupIds: defaultGroupIds,
    priority: "50",
    concurrency: "0",
    rpmLimit: "0",
    rawPassthrough: false,
    route: preset?.nodeId || preset?.ownerId ? "node" : "direct",
    ownerId: preset?.ownerId ?? "",
    nodeId: preset?.nodeId ?? "",
    payoutRate: "0.6",
  };
}

function fromAccount(a: AdminAccount): FormState {
  return {
    name: a.name,
    platform: a.platform,
    type: a.type,
    executor: a.executor ?? "direct",
    protocol: a.protocol,
    baseUrl: a.baseUrl ?? "",
    apiKey: "",
    accessToken: "",
    refreshToken: "",
    expiresAt: "",
    accountId: "",
    orgUuid: a.teamId ?? "",
    teamName: a.teamName ?? "",
    environmentId: "",
    modelsText: a.models.join("\n"),
    mappingText: Object.entries(a.modelMapping)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
    groupIds: a.groups.map((g) => g.groupId),
    priority: String(a.priority),
    concurrency: String(a.concurrency),
    rpmLimit: String(a.rpmLimit ?? 0),
    rawPassthrough: a.rawPassthrough === true,
    route: a.route,
    ownerId: a.ownerId ?? "",
    nodeId: a.nodeId ?? "",
    payoutRate: String(a.payoutRate),
  };
}

function Section({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <fieldset className="space-y-4">
      <legend className="kicker mb-1">
        <span className="kicker-dot" />
        {title}
      </legend>
      {children}
    </fieldset>
  );
}

export function AccountFormModal({
  open,
  account,
  groups,
  providers,
  nodes = [],
  preset,
  onClose,
  onSaved,
}: {
  open: boolean;
  account: AdminAccount | null; // null = create
  groups: Group[];
  providers: AdminUser[];
  /** Known nodes: lets the admin pick the egress node instead of typing its id. */
  nodes?: NodeRow[];
  preset?: AccountFormPreset;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useCT();
  const toast = useToast();
  const defaultGroups = groups.filter((g) => g.id === "default").map((g) => g.id);
  const [f, setF] = useState<FormState>(() => (account ? fromAccount(account) : blank(defaultGroups, preset)));
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setF(account ? fromAccount(account) : blank(groups.filter((g) => g.id === "default").map((g) => g.id), preset));
      setErr(null);
    }
  }, [open, account, groups, preset]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((s) => ({ ...s, [k]: v }));

  // Node ⇄ owner coupling: a pinned node fixes the owner to its provider; changing the
  // owner drops a pinned node of another provider.
  // Egress is one choice: direct, any online node of the owning provider, or one
  // specific node. Platform nodes (deployed by an admin) carry platform-owned
  // accounts; a provider's nodes carry that provider's accounts, so picking a
  // node also fixes the owner.
  const nodeLabel = (n: NodeRow) =>
    `${t("admin.accounts.egressNode")} · ${n.deployMeta?.name ?? n.nodeId.slice(0, 20)} · ${
      n.platformNode ? t("admin.nodes.platformNode") : (n.providerName ?? n.providerId.slice(0, 8))
    } · ${n.online ? t("admin.accounts.nodeOnline") : t("admin.accounts.nodeOffline")} · ${n.accountCount}/${n.capacity}`;
  const egressValue = f.route === "direct" ? "direct" : f.nodeId ? `node:${f.nodeId}` : "any";
  const egressOptions = [
    { value: "direct", label: t("route.direct") },
    ...(f.ownerId ? [{ value: "any", label: t("admin.accounts.nodeAny") }] : []),
    ...nodes
      .filter((n) => (f.ownerId ? !n.platformNode && n.providerId === f.ownerId : true))
      .map((n) => ({ value: `node:${n.nodeId}`, label: nodeLabel(n) })),
  ];
  if (f.route === "node" && f.nodeId && !egressOptions.some((o) => o.value === egressValue)) {
    egressOptions.push({ value: egressValue, label: `${t("admin.accounts.egressNode")} · ${f.nodeId}` });
  }
  function onEgress(v: string) {
    if (v === "direct") return setF((s) => ({ ...s, route: "direct", nodeId: "" }));
    if (v === "any") return setF((s) => ({ ...s, route: "node", nodeId: "" }));
    const nodeId = v.slice("node:".length);
    const n = nodes.find((x) => x.nodeId === nodeId);
    setF((s) => ({ ...s, route: "node", nodeId, ownerId: n ? (n.platformNode ? "" : n.providerId) : s.ownerId }));
  }
  function onOwner(ownerId: string) {
    setF((s) => {
      const n = nodes.find((x) => x.nodeId === s.nodeId);
      const keep = n && (ownerId ? !n.platformNode && n.providerId === ownerId : n.platformNode);
      return { ...s, ownerId, nodeId: keep ? s.nodeId : "", route: keep || ownerId ? s.route : s.route === "node" ? "direct" : s.route };
    });
  }
  const isEdit = !!account;
  const platformInfo = PLATFORMS.find((p) => p.id === f.platform);
  const isOauth = f.type === "oauth";
  // Cloud sessions (CCR) are only possible for anthropic subscription accounts.
  const ccrAllowed = isOauth && f.platform === "anthropic";

  function onPlatform(id: string) {
    const p = PLATFORMS.find((x) => x.id === id);
    setF((s) => ({
      ...s,
      platform: id,
      protocol: p?.protocol ?? "openai",
      type: s.type === "oauth" && id !== "anthropic" && id !== "openai" ? "apikey" : s.type,
    }));
  }

  function buildPayload(): Record<string, unknown> | string {
    if (!f.name.trim()) return t("admin.accounts.errName");
    const mapping: Record<string, string> = {};
    for (const raw of f.mappingText.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      const i = line.indexOf("=");
      if (i <= 0 || i === line.length - 1) return t("admin.accounts.errMapping", { line });
      mapping[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    if (f.route === "node" && !f.ownerId && !f.nodeId) return t("admin.accounts.errNodeOwner");
    const payout = Number(f.payoutRate);
    if (f.ownerId && (!Number.isFinite(payout) || payout < 0 || payout > 1)) return t("admin.accounts.errPayout");
    const body: Record<string, unknown> = {
      name: f.name.trim(),
      platform: f.platform,
      type: f.type,
      protocol: f.protocol,
      baseUrl: f.baseUrl.trim() || null,
      models: f.modelsText
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
      modelMapping: mapping,
      groupIds: f.groupIds,
      priority: Number(f.priority) || 0,
      concurrency: Number(f.concurrency) || 0,
      rpmLimit: Number(f.rpmLimit) || 0,
      rawPassthrough: f.rawPassthrough,
      route: f.route,
      nodeId: f.nodeId.trim() || null,
      executor: ccrAllowed ? f.executor : "direct",
    };
    if (f.ownerId) body.payoutRate = payout;
    if (!isEdit && f.ownerId) body.ownerId = f.ownerId;
    if (isOauth) {
      if (f.accessToken.trim()) body.accessToken = f.accessToken.trim();
      if (f.refreshToken.trim()) body.refreshToken = f.refreshToken.trim();
      if (f.expiresAt) body.expiresAt = new Date(f.expiresAt).toISOString();
      if (f.accountId.trim()) body.accountId = f.accountId.trim();
      if (f.orgUuid.trim()) body.orgUuid = f.orgUuid.trim();
      if (f.teamName.trim()) body.teamName = f.teamName.trim();
      if (f.environmentId.trim()) body.environmentId = f.environmentId.trim();
      if (!isEdit && !body.accessToken) return t("admin.accounts.errCredential");
    } else {
      if (f.apiKey.trim()) body.apiKey = f.apiKey.trim();
      if (!isEdit && !body.apiKey) return t("admin.accounts.errCredential");
    }
    return body;
  }

  async function submit() {
    const payload = buildPayload();
    if (typeof payload === "string") {
      setErr(payload);
      return;
    }
    setErr(null);
    setBusy(true);
    try {
      if (isEdit) await api.patch(`/api/admin/accounts/${account!.id}`, payload);
      else await api.post("/api/admin/accounts", payload);
      toast.success(t(isEdit ? "admin.accounts.updated" : "admin.accounts.created"));
      onSaved();
      onClose();
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const keepHint = isEdit ? t("admin.accounts.keepCredential") : undefined;

  return (
    <Modal
      open={open}
      size="lg"
      title={isEdit ? t("admin.accounts.edit") : t("admin.accounts.add")}
      onClose={() => !busy && onClose()}
      footer={
        <>
          {err && <span className="mr-auto max-w-[60%] text-[13px] text-error">{err}</span>}
          <Button onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            {isEdit ? t("common.save") : t("common.create")}
          </Button>
        </>
      }
    >
      <div className="space-y-7">
        <Section title={t("admin.accounts.secBasics")}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("common.name")}>
              <Input value={f.name} onChange={(e) => set("name", e.target.value)} maxLength={80} />
            </Field>
            <Field label={t("common.platform")}>
              <Select
                value={f.platform}
                onChange={(e) => onPlatform(e.target.value)}
                options={PLATFORMS.map((p) => ({ value: p.id, label: p.label }))}
              />
            </Field>
            <Field label={t("common.type")}>
              <Select
                value={f.type}
                onChange={(e) => set("type", e.target.value as AccountType)}
                options={(["apikey", "upstream", "oauth"] as const)
                  .filter((x) => x !== "oauth" || f.platform === "anthropic" || f.platform === "openai")
                  .map((x) => ({ value: x, label: t(`type.${x}`) }))}
              />
            </Field>
            <Field label={t("admin.accounts.protocol")} hint={t("admin.accounts.protocolHint")}>
              <Select
                value={f.protocol}
                onChange={(e) => set("protocol", e.target.value as "anthropic" | "openai")}
                options={[
                  { value: "openai", label: "OpenAI (Chat / Responses)" },
                  { value: "anthropic", label: "Anthropic (Messages)" },
                ]}
              />
            </Field>
          </div>
        </Section>

        <Section title={t("admin.accounts.secConnection")}>
          <Field
            label={t("admin.accounts.baseUrl")}
            hint={
              <>
                {t("admin.accounts.baseUrlHint")}
                {(f.type === "upstream" || !platformInfo?.baseUrl) && !isOauth && (
                  <span className="mt-1 block font-medium text-warning">{t("admin.accounts.baseUrlRequired")}</span>
                )}
              </>
            }
          >
            <Input
              value={f.baseUrl}
              onChange={(e) => set("baseUrl", e.target.value)}
              placeholder={platformInfo?.baseUrl ?? "https://relay.example.com/v1"}
              className="font-mono"
            />
          </Field>
          {isOauth ? (
            <>
              <p className="text-[12.5px] leading-relaxed text-on-surface-faint">{t("admin.accounts.oauthHint")}</p>
              <Field label={t("admin.accounts.accessToken")} hint={keepHint}>
                <Textarea value={f.accessToken} onChange={(e) => set("accessToken", e.target.value)} rows={2} autoComplete="off" />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={`${t("admin.accounts.refreshToken")} (${t("common.optional")})`} hint={keepHint}>
                  <Input value={f.refreshToken} onChange={(e) => set("refreshToken", e.target.value)} className="font-mono" autoComplete="off" />
                </Field>
                <Field label={`${t("admin.accounts.expiresAt")} (${t("common.optional")})`}>
                  <Input type="datetime-local" value={f.expiresAt} onChange={(e) => set("expiresAt", e.target.value)} />
                </Field>
              </div>
              {f.platform === "openai" && (
                <Field label={`${t("admin.accounts.accountId")} (${t("common.optional")})`} hint={t("admin.accounts.accountIdHint")}>
                  <Input value={f.accountId} onChange={(e) => set("accountId", e.target.value)} className="font-mono" />
                </Field>
              )}
              {f.platform === "anthropic" && <Field label={`${t("team.name")} (${t("common.optional")})`} hint={t("team.verifiedHint")}>
                <Input value={f.teamName} maxLength={120} onChange={(e) => set("teamName", e.target.value)} />
              </Field>}
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={`${t("admin.accounts.orgUuid")}${f.platform === "anthropic" ? "" : ` (${t("common.optional")})`}`} hint={t("team.verifiedHint")}>
                  <Input value={f.orgUuid} onChange={(e) => set("orgUuid", e.target.value)} className="font-mono" autoComplete="off" readOnly={isEdit && !!account?.teamId} required={f.platform === "anthropic"} />
                </Field>
                <Field label={`${t("admin.accounts.environmentId")} (${t("common.optional")})`} hint={keepHint ?? t("admin.accounts.environmentIdHint")}>
                  <Input value={f.environmentId} onChange={(e) => set("environmentId", e.target.value)} className="font-mono" autoComplete="off" />
                </Field>
              </div>
              {ccrAllowed && (
                <Field label={t("admin.accounts.executor")} hint={t("admin.accounts.executorHint")}>
                  <Select
                    value={f.executor}
                    onChange={(e) => set("executor", e.target.value as AccountExecutor)}
                    options={[
                      { value: "direct", label: t("executor.direct") },
                      { value: "ccr", label: t("executor.ccr") },
                      { value: "ccr_worker", label: t("executor.ccr_worker") },
                    ]}
                  />
                </Field>
              )}
            </>
          ) : (
            <Field label={t("admin.accounts.apiKey")} hint={keepHint}>
              <Input
                type="password"
                value={f.apiKey}
                onChange={(e) => set("apiKey", e.target.value)}
                className="font-mono"
                autoComplete="new-password"
                placeholder={isEdit ? "••••••••" : "sk-…"}
              />
            </Field>
          )}
        </Section>

        <Section title={t("admin.accounts.secRouting")}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("admin.accounts.models")} hint={t("admin.accounts.modelsHint")}>
              <Textarea value={f.modelsText} onChange={(e) => set("modelsText", e.target.value)} rows={4} placeholder="claude-*" />
            </Field>
            <Field label={t("admin.accounts.mapping")} hint={t("admin.accounts.mappingHint")}>
              <Textarea value={f.mappingText} onChange={(e) => set("mappingText", e.target.value)} rows={4} placeholder="from-model=to-model" />
            </Field>
          </div>
          <Field label={t("admin.accounts.groups")} hint={t("admin.accounts.groupsHint")}>
            <ChipSelect
              value={f.groupIds}
              onChange={(v) => set("groupIds", v)}
              options={groups.map((g) => ({ value: g.id, label: `${g.name} ×${g.rateMultiplier}` }))}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("admin.accounts.priority")} hint={t("admin.accounts.priorityHint")}>
              <Input type="number" min={0} value={f.priority} onChange={(e) => set("priority", e.target.value)} />
            </Field>
            <Field label={t("admin.accounts.concurrency")} hint={t("admin.accounts.concurrencyHint")}>
              <Input type="number" min={0} value={f.concurrency} onChange={(e) => set("concurrency", e.target.value)} />
            </Field>
            <Field label={t("admin.accounts.rpmLimit")} hint={t("admin.accounts.rpmLimitHint")}>
              <Input type="number" min={0} value={f.rpmLimit} onChange={(e) => set("rpmLimit", e.target.value)} />
            </Field>
            {f.type !== "oauth" && (
              <Field label={t("admin.accounts.rawPassthrough")} hint={t("admin.accounts.rawPassthroughHint")}>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={f.rawPassthrough} onChange={(e) => set("rawPassthrough", e.target.checked)} />
                  <span>{t("admin.accounts.rawPassthroughLabel")}</span>
                </label>
              </Field>
            )}
            <Field
              label={t("admin.accounts.owner")}
              hint={isEdit ? t("admin.accounts.ownerFixed") : t("admin.accounts.ownerHint")}
            >
              <Select
                value={f.ownerId}
                disabled={isEdit}
                onChange={(e) => onOwner(e.target.value)}
                options={[
                  { value: "", label: t("admin.accounts.ownerNone") },
                  ...providers.map((p) => ({ value: p.id, label: p.name })),
                ]}
              />
            </Field>
            <Field label={t("admin.accounts.route")} hint={t("admin.accounts.routeHint")}>
              <Select value={egressValue} onChange={(e) => onEgress(e.target.value)} options={egressOptions} />
            </Field>
            {f.ownerId && (
              <Field label={t("admin.accounts.payoutRate")} hint={t("admin.accounts.payoutRateHint")}>
                <Input type="number" min={0} max={1} step={0.05} value={f.payoutRate} onChange={(e) => set("payoutRate", e.target.value)} />
              </Field>
            )}
          </div>
        </Section>
      </div>
    </Modal>
  );
}
