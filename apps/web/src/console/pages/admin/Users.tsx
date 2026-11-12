import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ApiError } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { api, type AdminUser, type ApiKey, type CacheRefundRow, type CacheRefundSummary, type CreditEvent, type Group, type LedgerRow, type Paged } from "../../api";
import { useCT } from "../../i18n";
import {
  Async,
  Badge,
  Button,
  Card,
  ChipSelect,
  ConfirmButton,
  DataTable,
  EmptyState,
  Field,
  Input,
  KV,
  Modal,
  Mono,
  PageHeader,
  Pagination,
  SecretBox,
  Segmented,
  Select,
  StatusBadge,
  Toolbar,
  fmtDate,
  fmtDateTime,
  fmtNum,
  fmtUsd,
  useAsync,
  useRelTime,
  useToast,
  type Tone,
} from "../../ui";
import { ConsumptionPanel, type ConsumptionRange } from "./_consumption";

const roleTone: Record<string, Tone> = { admin: "error", consumer: "success", provider: "info", ops: "warning" };
/** consumer / admin accounts carry a wallet + API keys; providers earn, ops (账号管理员) have neither. */
const hasWallet = (role: string) => role === "consumer" || role === "admin";

function RoleBadge({ role }: { role: string }) {
  const { t } = useCT();
  return <Badge tone={roleTone[role] ?? "neutral"}>{t(`role.${role}`)}</Badge>;
}

function useGroups() {
  return useAsync(() => api.get<Group[]>("/api/admin/groups"), []);
}

export function AdminUsers() {
  const { t } = useCT();
  const rel = useRelTime();
  const [role, setRole] = useState("");
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  // `?open=<id>` deep-links a user's detail (finance panel → customer).
  const [searchParams, setSearchParams] = useSearchParams();
  const [openId, setOpenIdState] = useState<string | null>(searchParams.get("open"));
  const setOpenId = (id: string | null) => {
    setOpenIdState(id);
    if (!id && searchParams.has("open")) {
      const next = new URLSearchParams(searchParams);
      next.delete("open");
      setSearchParams(next, { replace: true });
    }
  };
  const groups = useGroups();

  const list = useAsync(
    () => api.get<Paged<AdminUser>>("/api/admin/users", { role, status, q: query, page, pageSize: 20 }),
    [role, status, query, page],
  );

  useEffect(() => setPage(1), [role, status, query]);

  return (
    <>
      <PageHeader
        title={t("admin.users.title")}
        desc={t("admin.users.desc")}
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            {t("admin.users.create")}
          </Button>
        }
      />
      <Card bodyClassName="">
        <Toolbar>
          <Field label={t("admin.users.role")} className="w-36">
            <Select
              value={role}
              onChange={(e) => setRole(e.target.value)}
              options={[
                { value: "", label: t("common.all") },
                { value: "consumer", label: t("role.consumer") },
                { value: "provider", label: t("role.provider") },
                { value: "admin", label: t("role.admin") },
                { value: "ops", label: t("role.ops") },
              ]}
            />
          </Field>
          <Field label={t("common.status")} className="w-36">
            <Select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              options={[
                { value: "", label: t("common.all") },
                { value: "active", label: t("status.active") },
                { value: "disabled", label: t("status.disabled") },
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
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("admin.users.searchPh")} />
            </Field>
            <Button type="submit" size="md">
              {t("common.search")}
            </Button>
          </form>
        </Toolbar>
        <Async state={list} rows={6}>
          {(d) => (
            <>
              {/* Two-line cells keep every figure visible without a horizontal scrollbar (user rule 2026-10-23). */}
              <DataTable<AdminUser>
                minWidth={0}
                dense
                loading={list.loading}
                rows={d.items}
                rowKey={(u) => u.id}
                columns={[
                  {
                    key: "user",
                    header: t("admin.users.colUser"),
                    render: (u) => (
                      <button type="button" className="min-w-0 max-w-[280px] text-left" onClick={() => setOpenId(u.id)}>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-[13.5px] font-semibold text-on-surface hover:text-primary">{u.name}</span>
                          <RoleBadge role={u.role} />
                          {u.status !== "active" && <StatusBadge status={u.status} />}
                        </div>
                        <div className="mt-0.5 truncate text-[11.5px] text-on-surface-faint" title={u.note ?? undefined}>
                          <Mono>{u.loginKeyPreview}…</Mono>
                          {u.note && <span> · {u.note}</span>}
                        </div>
                      </button>
                    ),
                  },
                  {
                    key: "funds",
                    header: t("admin.users.available"),
                    align: "right",
                    render: (u) =>
                      hasWallet(u.role) ? (
                        <div className="font-mono tabular-nums">
                          <div className={`font-semibold ${u.availableUsd <= 0 ? "text-error" : "text-on-surface"}`}>{fmtUsd(u.availableUsd)}</div>
                          <div className="text-[11.5px] text-on-surface-faint">
                            {u.creditLimitUsd > 0
                              ? t("admin.users.creditSub", { limit: fmtUsd(u.creditLimitUsd, 2), used: fmtUsd(u.creditUsedUsd) })
                              : t("admin.users.prepaidSub", { v: fmtUsd(u.balanceUsd) })}
                          </div>
                        </div>
                      ) : u.role === "provider" ? (
                        <div className="font-mono tabular-nums">
                          <div className="font-semibold text-on-surface">{fmtUsd(u.balanceUsd)}</div>
                          <div className="text-[11.5px] text-on-surface-faint">{t("admin.users.unsettled")}</div>
                        </div>
                      ) : (
                        <span className="text-on-surface-faint">—</span>
                      ),
                  },
                  {
                    key: "d30",
                    header: t("admin.users.col30d"),
                    align: "right",
                    className: "hidden sm:table-cell",
                    render: (u) => (
                      <div className="font-mono tabular-nums">
                        <div className="font-semibold text-on-surface">{fmtUsd(u.cost30d)}</div>
                        <div className="text-[11.5px] text-on-surface-faint">
                          {fmtNum(u.requests30d)} req
                          {hasWallet(u.role) && ` · ${t("admin.users.keysSub", { n: u.keyCount })}`}
                          {u.ccSuspect30d > 0 && (
                            <span className="ml-1 font-semibold text-error" title={t("admin.users.ccSuspect30Hint")}>
                              {t("admin.users.suspectBadge", { n: fmtNum(u.ccSuspect30d) })}
                            </span>
                          )}
                        </div>
                      </div>
                    ),
                  },
                  {
                    key: "last",
                    header: t("admin.users.lastRequest"),
                    className: "hidden md:table-cell",
                    render: (u) => (
                      <div className="whitespace-nowrap">
                        <div className={u.lastRequestAt ? "text-on-surface" : "text-on-surface-faint"} title={u.lastRequestAt ? fmtDateTime(u.lastRequestAt) : undefined}>
                          {/* undefined = console build predates the field (static web deployed first) */}
                          {u.lastRequestAt ? rel(u.lastRequestAt) : u.lastRequestAt === null ? t("admin.users.noRequests") : "—"}
                        </div>
                        <div className="text-[11.5px] text-on-surface-faint" title={u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : undefined}>
                          {t("admin.users.loginSub", { t: u.lastLoginAt ? rel(u.lastLoginAt) : t("common.never") })}
                        </div>
                      </div>
                    ),
                  },
                  { key: "created", header: t("common.createdAt"), className: "hidden xl:table-cell", render: (u) => <span className="whitespace-nowrap text-on-surface-variant">{fmtDate(u.createdAt)}</span> },
                  {
                    key: "act",
                    header: t("common.actions"),
                    align: "right",
                    render: (u) => (
                      <Button size="sm" onClick={() => setOpenId(u.id)}>
                        {t("common.details")}
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

      <CreateUserModal
        open={creating}
        groups={groups.data ?? []}
        onClose={() => setCreating(false)}
        onCreated={() => list.reload()}
      />
      {openId && (
        <UserDetailModal
          id={openId}
          groups={groups.data ?? []}
          onClose={() => setOpenId(null)}
          onChanged={() => list.reload()}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------

function CreateUserModal({
  open,
  groups,
  onClose,
  onCreated,
}: {
  open: boolean;
  groups: Group[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const { t } = useCT();
  const toast = useToast();
  const [role, setRole] = useState("consumer");
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [initial, setInitial] = useState("");
  const [allowed, setAllowed] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ name: string; key: string } | null>(null);

  const reset = () => {
    setRole("consumer");
    setName("");
    setNote("");
    setInitial("");
    setAllowed([]);
    setCreated(null);
  };
  const close = () => {
    reset();
    onClose();
  };

  const exclusive = groups.filter((g) => g.isExclusive);

  return (
    <Modal
      open={open}
      title={created ? t("admin.users.loginKeyTitle", { name: created.name }) : t("admin.users.createTitle")}
      onClose={close}
      footer={
        created ? (
          <Button variant="primary" onClick={close}>
            {t("common.close")}
          </Button>
        ) : (
          <>
            <Button onClick={close}>{t("common.cancel")}</Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={!name.trim()}
              onClick={async () => {
                setBusy(true);
                try {
                  const r = await api.post<AdminUser & { loginKey: string }>("/api/admin/users", {
                    role,
                    name: name.trim(),
                    note: note.trim() || undefined,
                    initialBalanceUsd: initial ? Number(initial) : undefined,
                    allowedGroupIds: hasWallet(role) ? allowed : [],
                  });
                  setCreated({ name: r.name, key: r.loginKey });
                  toast.success(t("admin.users.created"));
                  onCreated();
                } catch (err) {
                  toast.error(err);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t("common.create")}
            </Button>
          </>
        )
      }
    >
      {created ? (
        <SecretBox value={created.key} note={t("admin.users.loginKeyNote")} />
      ) : (
        <div className="space-y-4">
          <Field label={t("admin.users.role")}>
            <Segmented
              value={role}
              onChange={setRole}
              options={[
                { value: "consumer", label: t("role.consumer") },
                { value: "provider", label: t("role.provider") },
                { value: "admin", label: t("role.admin") },
                { value: "ops", label: t("role.ops") },
              ]}
            />
          </Field>
          <Field label={t("admin.users.name")}>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} autoFocus />
          </Field>
          <Field label={`${t("admin.users.note")} (${t("common.optional")})`}>
            <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
          </Field>
          {hasWallet(role) && (
            <>
              <Field label={`${t("admin.users.initialBalance")} (${t("common.optional")})`}>
                <Input type="number" min={0} step="0.01" value={initial} onChange={(e) => setInitial(e.target.value)} placeholder="0" />
              </Field>
              <Field label={t("admin.users.allowedGroups")} hint={t("admin.users.allowedGroupsHint")}>
                {exclusive.length ? (
                  <ChipSelect options={exclusive.map((g) => ({ value: g.id, label: g.name }))} value={allowed} onChange={setAllowed} />
                ) : (
                  <span className="text-[13px] text-on-surface-faint">{t("admin.users.noExclusive")}</span>
                )}
              </Field>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------

type UserDetail = AdminUser & { keys: ApiKey[]; recentLedger: LedgerRow[]; recentCreditEvents: CreditEvent[]; recentCacheRefunds: CacheRefundRow[]; cacheRefund: CacheRefundSummary };
type Tab = "profile" | "balance" | "usage" | "keys" | "ledger" | "credit";

function UserDetailModal({
  id,
  groups,
  onClose,
  onChanged,
}: {
  id: string;
  groups: Group[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t } = useCT();
  const { me } = useAuth();
  const detail = useAsync(() => api.get<UserDetail>(`/api/admin/users/${id}`), [id]);
  const [tab, setTab] = useState<Tab>("profile");
  const [newKey, setNewKey] = useState<string | null>(null);

  const changed = () => {
    detail.reload();
    onChanged();
  };

  return (
    <Modal open size="lg" title={t("admin.users.detail", { name: detail.data?.name ?? "…" })} onClose={onClose}>
      <Async state={detail} rows={6}>
        {(u) => (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-2">
              <RoleBadge role={u.role} />
              <StatusBadge status={u.status} />
              {u.id === me?.id && <Badge tone="primary">{t("admin.users.selfNote")}</Badge>}
              <span className="ml-auto font-mono text-[13px] text-on-surface-variant">
                {u.role === "provider"
                  ? t("admin.users.currentUnsettled", { v: fmtUsd(u.balanceUsd) })
                  : hasWallet(u.role)
                    ? t("admin.users.creditSummary", { avail: fmtUsd(u.availableUsd), limit: fmtUsd(u.creditLimitUsd, 2), used: fmtUsd(u.creditUsedUsd), prepaid: fmtUsd(u.balanceUsd) })
                    : null}
              </span>
            </div>
            <Segmented<Tab>
              value={tab}
              onChange={setTab}
              options={[
                { value: "profile", label: t("admin.users.tabProfile") },
                { value: "balance", label: t("admin.users.tabBalance") },
                ...(hasWallet(u.role) ? [{ value: "usage" as Tab, label: t("admin.users.tabUsage") }] : []),
                ...(hasWallet(u.role) ? [{ value: "keys" as Tab, label: `${t("admin.users.tabKeys")} (${u.keys.length})` }] : []),
                { value: "ledger", label: t("admin.users.tabLedger") },
                ...(hasWallet(u.role) ? [{ value: "credit" as Tab, label: t("admin.users.tabCredit") }] : []),
              ]}
            />

            {tab === "profile" && (
              <ProfileTab user={u} groups={groups} onChanged={changed} onKey={setNewKey} onDeleted={() => { onChanged(); onClose(); }} />
            )}
            {tab === "balance" && <BalanceTab user={u} onChanged={changed} />}
            {tab === "usage" && <UsageTab userId={u.id} />}
            {tab === "keys" && <KeysTab keys={u.keys} />}
            {tab === "ledger" && <LedgerTab rows={u.recentLedger} />}
            {tab === "credit" && <CreditEventsTab rows={u.recentCreditEvents ?? []} />}

            {newKey && (
              <div className="rounded-md p-4" style={{ border: "1px solid var(--accent-line)" }}>
                <div className="mb-2 text-sm font-semibold">{t("admin.users.loginKeyTitle", { name: u.name })}</div>
                <SecretBox value={newKey} note={t("admin.users.loginKeyNote")} />
              </div>
            )}
          </div>
        )}
      </Async>
      {detail.error && detail.data && <p className="mt-3 text-sm text-error">{detail.error}</p>}
    </Modal>
  );
}

function ProfileTab({
  user,
  groups,
  onChanged,
  onKey,
  onDeleted,
}: {
  user: UserDetail;
  groups: Group[];
  onChanged: () => void;
  onKey: (k: string) => void;
  onDeleted: () => void;
}) {
  const { t } = useCT();
  const toast = useToast();
  const { me } = useAuth();
  const [name, setName] = useState(user.name);
  const [note, setNote] = useState(user.note ?? "");
  const [allowed, setAllowed] = useState<string[]>(user.allowedGroupIds);
  const [onboardGroup, setOnboardGroup] = useState<string>(user.onboardGroupId ?? "");
  const [busy, setBusy] = useState(false);
  const exclusive = groups.filter((g) => g.isExclusive);
  const isSelf = user.id === me?.id;
  const isProvider = user.role === "provider";

  const patch = async (body: Record<string, unknown>, msg = t("admin.users.updated")) => {
    await api.patch(`/api/admin/users/${user.id}`, body);
    toast.success(msg);
    onChanged();
  };

  return (
    <div className="space-y-5">
      <KV
        items={[
          [t("admin.users.id"), <Mono key="id">{user.id}</Mono>],
          [t("admin.users.loginKey"), <Mono key="k">{user.loginKeyPreview}…</Mono>],
          [t("admin.users.lastLogin"), fmtDateTime(user.lastLoginAt)],
          [t("common.createdAt"), fmtDateTime(user.createdAt)],
          [t("admin.users.req30"), `${fmtNum(user.requests30d)} · ${fmtUsd(user.cost30d)}`],
        ]}
      />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label={t("admin.users.name")}>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} />
        </Field>
        <Field label={t("admin.users.note")}>
          <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
        </Field>
      </div>
      {hasWallet(user.role) && (
        <Field label={t("admin.users.allowedGroups")} hint={t("admin.users.allowedGroupsHint")}>
          {exclusive.length ? (
            <ChipSelect options={exclusive.map((g) => ({ value: g.id, label: g.name }))} value={allowed} onChange={setAllowed} />
          ) : (
            <span className="text-[13px] text-on-surface-faint">{t("admin.users.noExclusive")}</span>
          )}
        </Field>
      )}
      {isProvider && (
        <Field label={t("admin.users.onboardGroup")} hint={t("admin.users.onboardGroupHint")}>
          <Select
            value={onboardGroup}
            onChange={(e) => setOnboardGroup(e.target.value)}
            options={[{ value: "", label: t("admin.users.onboardGroupDefault") }, ...groups.filter((g) => g.status === "active").map((g) => ({ value: g.id, label: g.name }))]}
          />
        </Field>
      )}
      <div className="flex justify-end">
        <Button
          variant="primary"
          loading={busy}
          disabled={!name.trim()}
          onClick={async () => {
            setBusy(true);
            try {
              await patch({
                name: name.trim(),
                note: note.trim(),
                ...(hasWallet(user.role) ? { allowedGroupIds: allowed } : {}),
                ...(isProvider ? { onboardGroupId: onboardGroup || null } : {}),
              });
            } catch (err) {
              toast.error(err);
            } finally {
              setBusy(false);
            }
          }}
        >
          {t("common.save")}
        </Button>
      </div>

      <div className="flex flex-wrap gap-2 pt-4" style={{ borderTop: "1px solid var(--outline-variant)" }}>
        <ConfirmButton
          title={t("admin.users.resetKey")}
          message={t("admin.users.resetKeyMsg")}
          onConfirm={async () => {
            const r = await api.post<{ loginKey: string }>(`/api/admin/users/${user.id}/reset-login-key`);
            onKey(r.loginKey);
            onChanged();
          }}
        >
          {t("admin.users.resetKey")}
        </ConfirmButton>
        {!isSelf &&
          (user.status === "active" ? (
            <ConfirmButton
              variant="danger"
              title={t("admin.users.disable")}
              message={t("admin.users.disableMsg")}
              onConfirm={() => patch({ status: "disabled" })}
            >
              {t("admin.users.disable")}
            </ConfirmButton>
          ) : (
            <Button onClick={() => patch({ status: "active" }).catch((e) => toast.error(e))}>{t("admin.users.enable")}</Button>
          ))}
        {!isSelf && (
          <ConfirmButton
            variant="danger"
            title={t("admin.users.delete")}
            message={t("admin.users.deleteMsg")}
            onConfirm={async () => {
              try {
                await api.del(`/api/admin/users/${user.id}`);
              } catch (err) {
                if (err instanceof ApiError && err.code === "user_has_usage") throw new Error(t("admin.users.hasUsage"));
                throw err;
              }
              toast.success(t("admin.users.deleted"));
              onDeleted();
            }}
          >
            {t("admin.users.delete")}
          </ConfirmButton>
        )}
      </div>
    </div>
  );
}

function BalanceTab({ user, onChanged }: { user: UserDetail; onChanged: () => void }) {
  const { t } = useCT();
  const toast = useToast();
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [pAmount, setPAmount] = useState("");
  const [pRef, setPRef] = useState("");
  const [pNote, setPNote] = useState("");
  const [pBusy, setPBusy] = useState(false);
  const [limit, setLimit] = useState(String(user.creditLimitUsd ?? 0));
  const [limitNote, setLimitNote] = useState("");
  const [limitBusy, setLimitBusy] = useState(false);
  const outstanding = Math.max(0, user.creditUsedUsd ?? 0);
  const [sAmount, setSAmount] = useState(outstanding > 0 ? outstanding.toFixed(4) : "");
  const [sNote, setSNote] = useState("");
  const [sBusy, setSBusy] = useState(false);
  const [crBusy, setCrBusy] = useState(false);
  const isConsumer = hasWallet(user.role);
  const cr = user.cacheRefund;

  return (
    <div className="space-y-6">
      {isConsumer && (
        <section className="space-y-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <KV items={[[t("admin.users.available"), <span key="a" className={`font-mono font-semibold ${user.availableUsd <= 0 ? "text-error" : ""}`}>{fmtUsd(user.availableUsd)}</span>]]} />
            <KV items={[[t("admin.users.creditLimit"), <span key="l" className="font-mono">{fmtUsd(user.creditLimitUsd, 2)}</span>]]} />
            <KV items={[[t("admin.users.outstanding"), <span key="u" className={`font-mono ${user.creditUsedUsd > 0 ? "text-warning" : ""}`}>{fmtUsd(user.creditUsedUsd)}</span>]]} />
            <KV items={[[t("admin.users.prepaid"), <span key="p" className={`font-mono ${user.balanceUsd < 0 ? "text-error" : ""}`}>{fmtUsd(user.balanceUsd)}</span>]]} />
          </div>
          <p className="text-[12.5px] text-on-surface-faint">
            {t("admin.users.creditFormula")}
            {user.creditSettledAt ? ` · ${t("admin.users.lastSettled", { t: fmtDateTime(user.creditSettledAt) })}` : ""}
          </p>
        </section>
      )}

      {isConsumer && (
        <section className="space-y-3 pt-5" style={{ borderTop: "1px solid var(--outline-variant)" }}>
          <h4 className="font-display text-[15px] font-semibold">{t("admin.users.setCredit")}</h4>
          <p className="text-[13px] text-on-surface-faint">{t("admin.users.setCreditHint")}</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[160px_1fr_auto] sm:items-end">
            <Field label={`${t("admin.users.creditLimit")} (USD)`}>
              <Input type="number" min={0} step="0.01" value={limit} onChange={(e) => setLimit(e.target.value)} />
            </Field>
            <Field label={t("common.note")}>
              <Input value={limitNote} onChange={(e) => setLimitNote(e.target.value)} maxLength={500} />
            </Field>
            <Button
              variant="primary"
              size="md"
              loading={limitBusy}
              disabled={limit === "" || Number.isNaN(Number(limit)) || Number(limit) < 0 || Number(limit) === (user.creditLimitUsd ?? 0)}
              onClick={async () => {
                setLimitBusy(true);
                try {
                  await api.post(`/api/admin/users/${user.id}/credit-limit`, { limitUsd: Number(limit), note: limitNote.trim() || undefined });
                  toast.success(t("admin.users.creditSet"));
                  setLimitNote("");
                  onChanged();
                } catch (err) {
                  toast.error(err);
                } finally {
                  setLimitBusy(false);
                }
              }}
            >
              {t("common.save")}
            </Button>
          </div>
        </section>
      )}

      {isConsumer && (
        <section className="space-y-3 pt-5" style={{ borderTop: "1px solid var(--outline-variant)" }}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h4 className="font-display text-[15px] font-semibold">{t("admin.users.settle")}</h4>
            <span className="font-mono text-[13px] text-on-surface-variant">{t("admin.users.currentOutstanding", { v: fmtUsd(outstanding) })}</span>
          </div>
          <p className="text-[13px] text-on-surface-faint">{t("admin.users.settleHint")}</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[220px_1fr_auto] sm:items-end">
            <Field label={`${t("common.amount")} (USD)`}>
              <div className="flex gap-2">
                <Input type="number" min={0} step="0.01" value={sAmount} onChange={(e) => setSAmount(e.target.value)} disabled={outstanding <= 0} />
                <Button size="md" disabled={outstanding <= 0} onClick={() => setSAmount(outstanding.toFixed(4))}>
                  Max
                </Button>
              </div>
            </Field>
            <Field label={t("common.note")}>
              <Input value={sNote} onChange={(e) => setSNote(e.target.value)} maxLength={500} disabled={outstanding <= 0} />
            </Field>
            {outstanding <= 0 || !(Number(sAmount) > 0) || Number(sAmount) > outstanding + 1e-9 || sBusy ? (
              <Button variant="primary" size="md" disabled loading={sBusy}>
                {t("admin.users.settle")}
              </Button>
            ) : (
            <ConfirmButton
              variant="primary"
              size="md"
              title={t("admin.users.settle")}
              message={t("admin.users.settleMsg", { v: fmtUsd(Number(sAmount) || 0), name: user.name })}
              onConfirm={async () => {
                setSBusy(true);
                try {
                  const full = Math.abs(Number(sAmount) - outstanding) < 1e-9;
                  const r = await api.post<{ settledUsd: number; availableUsd: number }>(`/api/admin/users/${user.id}/settle`, {
                    ...(full ? {} : { amountUsd: Number(sAmount) }),
                    note: sNote.trim() || undefined,
                  });
                  toast.success(t("admin.users.settled", { v: fmtUsd(r.settledUsd), avail: fmtUsd(r.availableUsd) }));
                  setSNote("");
                  onChanged();
                } catch (err) {
                  toast.error(err);
                } finally {
                  setSBusy(false);
                }
              }}
            >
              {t("admin.users.settle")}
            </ConfirmButton>
            )}
          </div>
        </section>
      )}

      {isConsumer && cr && (
        <section className="space-y-3 pt-5" style={{ borderTop: "1px solid var(--outline-variant)" }}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h4 className="font-display text-[15px] font-semibold">{t("admin.users.cacheRefund")}</h4>
            <span className="font-mono text-[13px] text-on-surface-variant">{t("admin.users.cacheRefundTotal", { v: fmtUsd(cr.totals.refundUsd), runs: cr.totals.runs })}</span>
          </div>
          <p className="text-[13px] text-on-surface-faint">{t("admin.users.cacheRefundHint", { percent: cr.percent, hours: Math.max(1, Math.round(cr.intervalSec / 3600)) })}</p>
          <div className="flex flex-wrap items-center gap-3">
            <span className={`text-[13px] ${cr.pending.rows > 0 ? "font-medium" : "text-on-surface-faint"}`}>
              {cr.pending.rows > 0
                ? t("admin.users.cacheRefundPending", { n: cr.pending.rows, excess: fmtUsd(cr.pending.excessUsd), refund: fmtUsd(cr.pending.refundUsd) })
                : t("admin.users.cacheRefundNothing")}
            </span>
            <span className="text-[12.5px] text-on-surface-faint">{t("admin.users.cacheRefundNext", { t: fmtDateTime(cr.nextScheduledRunAt) })}</span>
            <span className="ml-auto">
              {cr.pending.rows === 0 || crBusy ? (
                <Button variant="primary" size="md" disabled loading={crBusy}>
                  {t("admin.users.cacheRefundNow")}
                </Button>
              ) : (
                <ConfirmButton
                  variant="primary"
                  size="md"
                  title={t("admin.users.cacheRefundNow")}
                  message={t("admin.users.cacheRefundMsg", { v: fmtUsd(cr.pending.refundUsd), name: user.name, n: cr.pending.rows })}
                  onConfirm={async () => {
                    setCrBusy(true);
                    try {
                      const r = await api.post<{ refund: CacheRefundRow }>(`/api/admin/users/${user.id}/cache-refund`, {});
                      toast.success(t("admin.users.cacheRefunded", { v: fmtUsd(r.refund.refundUsd), credit: fmtUsd(r.refund.toCreditUsd), balance: fmtUsd(r.refund.toBalanceUsd) }));
                      onChanged();
                    } catch (err) {
                      toast.error(err);
                    } finally {
                      setCrBusy(false);
                    }
                  }}
                >
                  {t("admin.users.cacheRefundNow")}
                </ConfirmButton>
              )}
            </span>
          </div>
        </section>
      )}

      <section className={`space-y-3${isConsumer ? " pt-5" : ""}`} style={isConsumer ? { borderTop: "1px solid var(--outline-variant)" } : undefined}>
        <h4 className="font-display text-[15px] font-semibold">{t("admin.users.adjust")}</h4>
        <p className="text-[13px] text-on-surface-faint">{t("admin.users.adjustHint")}</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[160px_1fr_auto] sm:items-end">
          <Field label={`${t("common.amount")} (USD)`}>
            <Input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="+10 / -5" />
          </Field>
          <Field label={t("common.note")}>
            <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
          </Field>
          <Button
            variant="primary"
            size="md"
            loading={busy}
            disabled={!amount || Number(amount) === 0 || Number.isNaN(Number(amount))}
            onClick={async () => {
              setBusy(true);
              try {
                await api.post(`/api/admin/users/${user.id}/adjust-balance`, { amountUsd: Number(amount), note: note.trim() || undefined });
                toast.success(t("admin.users.adjusted"));
                setAmount("");
                setNote("");
                onChanged();
              } catch (err) {
                toast.error(err);
              } finally {
                setBusy(false);
              }
            }}
          >
            {t("common.confirm")}
          </Button>
        </div>
      </section>

      {user.role === "provider" && (
        <section className="space-y-3 pt-5" style={{ borderTop: "1px solid var(--outline-variant)" }}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h4 className="font-display text-[15px] font-semibold">{t("admin.users.payout")}</h4>
            <span className="font-mono text-[13px] text-on-surface-variant">{t("admin.users.currentUnsettled", { v: fmtUsd(user.balanceUsd) })}</span>
          </div>
          <p className="text-[13px] text-on-surface-faint">{t("admin.users.payoutHint")}</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label={`${t("common.amount")} (USD)`}>
              <div className="flex gap-2">
                <Input type="number" min={0} step="0.01" value={pAmount} onChange={(e) => setPAmount(e.target.value)} />
                <Button size="md" onClick={() => setPAmount(String(Math.max(0, user.balanceUsd)))}>
                  Max
                </Button>
              </div>
            </Field>
            <Field label={t("admin.users.payoutRef")}>
              <Input value={pRef} onChange={(e) => setPRef(e.target.value)} maxLength={200} />
            </Field>
            <Field label={t("common.note")}>
              <Input value={pNote} onChange={(e) => setPNote(e.target.value)} maxLength={500} />
            </Field>
          </div>
          <div className="flex justify-end">
            <Button
              variant="primary"
              loading={pBusy}
              disabled={!pAmount || !(Number(pAmount) > 0)}
              onClick={async () => {
                setPBusy(true);
                try {
                  await api.post(`/api/admin/users/${user.id}/payout`, {
                    amountUsd: Number(pAmount),
                    ref: pRef.trim() || undefined,
                    note: pNote.trim() || undefined,
                  });
                  toast.success(t("admin.users.paid"));
                  setPAmount("");
                  setPRef("");
                  setPNote("");
                  onChanged();
                } catch (err) {
                  toast.error(err);
                } finally {
                  setPBusy(false);
                }
              }}
            >
              {t("admin.users.payout")}
            </Button>
          </div>
        </section>
      )}
      <InflightLimits user={user} onChanged={onChanged} />
    </div>
  );
}

/** Per-user admission overrides (docs/gateway.md §2b): concurrent requests and reserved spending; empty = gateway defaults. */
function InflightLimits({ user, onChanged }: { user: UserDetail; onChanged: () => void }) {
  const { t } = useCT();
  const toast = useToast();
  const [n, setN] = useState(user.maxInflight ? String(user.maxInflight) : "");
  const [usd, setUsd] = useState(user.maxInflightUsd ? String(user.maxInflightUsd) : "");
  const [rpm, setRpm] = useState(user.maxRpm ? String(user.maxRpm) : "");
  const [busy, setBusy] = useState(false);
  return (
    <section className="space-y-3 pt-5" style={{ borderTop: "1px solid var(--outline-variant)" }}>
      <h4 className="font-display text-[15px] font-semibold">{t("admin.users.inflightTitle")}</h4>
      <p className="text-[13px] text-on-surface-faint">{t("admin.users.inflightHint")}</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[160px_160px_160px_auto] sm:items-end">
        <Field label={t("admin.users.maxInflight")}>
          <Input type="number" min={0} step="1" value={n} placeholder="1000" onChange={(e) => setN(e.target.value)} />
        </Field>
        <Field label={`${t("admin.users.maxInflightUsd")} (USD)`}>
          <Input type="number" min={0} step="0.01" value={usd} placeholder={t("admin.users.inflightNoCap")} onChange={(e) => setUsd(e.target.value)} />
        </Field>
        <Field label={t("admin.users.maxRpm")}>
          <Input type="number" min={0} step="1" value={rpm} placeholder={t("admin.users.inflightNoCap")} onChange={(e) => setRpm(e.target.value)} />
        </Field>
        <Button
          variant="primary"
          size="md"
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api.patch(`/api/admin/users/${user.id}`, { maxInflight: n === "" ? null : Number(n), maxInflightUsd: usd === "" ? null : Number(usd), maxRpm: rpm === "" ? null : Number(rpm) });
              toast.success(t("admin.users.inflightSaved"));
              onChanged();
            } catch (err) {
              toast.error(err);
            } finally {
              setBusy(false);
            }
          }}
        >
          {t("common.save")}
        </Button>
      </div>
    </section>
  );
}

type UsagePreset = "today" | "yesterday" | "d7" | "d30";

function utcDay(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

function usageRange(p: UsagePreset): ConsumptionRange {
  switch (p) {
    case "today":
      return { from: utcDay(0), to: utcDay(0) };
    case "yesterday":
      return { from: utcDay(-1), to: utcDay(-1) };
    case "d7":
      return { from: utcDay(-6), to: utcDay(0) };
    default:
      return { from: utcDay(-29), to: utcDay(0) };
  }
}

/** Per-key spend by hour / day for one user (same panel as the finance page). */
function UsageTab({ userId }: { userId: string }) {
  const { t } = useCT();
  const [preset, setPreset] = useState<UsagePreset>("d7");
  return (
    <div className="space-y-4">
      <Segmented<UsagePreset>
        value={preset}
        onChange={setPreset}
        options={(["today", "yesterday", "d7", "d30"] as const).map((p) => ({ value: p, label: t(`breakdown.range.${p}`) }))}
      />
      <ConsumptionPanel embedded path="/api/admin/usage/breakdown" by="key" params={{ userId, by: "key" }} range={usageRange(preset)} />
    </div>
  );
}

function KeysTab({ keys }: { keys: ApiKey[] }) {
  const { t } = useCT();
  const rel = useRelTime();
  if (!keys.length) return <EmptyState title={t("admin.users.noKeys")} />;
  return (
    <div className="card overflow-hidden">
      <DataTable<ApiKey>
        minWidth={640}
        rows={keys}
        rowKey={(k) => k.id}
        columns={[
          { key: "name", header: t("common.name"), render: (k) => <span className="font-medium">{k.name}</span> },
          { key: "preview", header: t("admin.keys.preview"), render: (k) => <Mono>{k.keyPreview}</Mono> },
          { key: "group", header: t("common.group"), render: (k) => k.groupName ?? k.groupId },
          { key: "status", header: t("common.status"), render: (k) => <StatusBadge status={k.effectiveStatus} /> },
          {
            key: "used",
            header: t("admin.keys.used"),
            align: "right",
            render: (k) => (
              <span className="font-mono">
                {fmtUsd(k.usedUsd)}
                {k.quotaUsd > 0 && <span className="text-on-surface-faint"> / {fmtUsd(k.quotaUsd, 2)}</span>}
              </span>
            ),
          },
          { key: "last", header: t("common.lastUsed"), render: (k) => (k.lastUsedAt ? rel(k.lastUsedAt) : t("common.never")) },
        ]}
      />
    </div>
  );
}

function CreditEventsTab({ rows }: { rows: CreditEvent[] }) {
  const { t } = useCT();
  if (!rows.length) return <EmptyState title={t("admin.users.noCreditEvents")} />;
  return (
    <div className="card overflow-hidden">
      <DataTable<CreditEvent>
        minWidth={720}
        rows={rows}
        rowKey={(e) => e.id}
        columns={[
          { key: "time", header: t("common.time"), render: (e) => fmtDateTime(e.createdAt) },
          { key: "kind", header: t("common.type"), render: (e) => <Badge tone={e.kind === "settlement" ? "success" : "info"}>{t(`credit.${e.kind}`)}</Badge> },
          {
            key: "amount",
            header: t("common.amount"),
            align: "right",
            render: (e) => (
              <span className="font-mono">
                {e.kind === "limit_set" && e.amountUsd > 0 ? "+" : ""}
                {fmtUsd(e.amountUsd)}
              </span>
            ),
          },
          {
            key: "used",
            header: t("credit.usedChange"),
            align: "right",
            render: (e) => (
              <span className="font-mono text-on-surface-variant">
                {fmtUsd(e.usedBefore)} → {fmtUsd(e.usedAfter)}
              </span>
            ),
          },
          { key: "limit", header: t("credit.limitAfter"), align: "right", render: (e) => <span className="font-mono">{fmtUsd(e.limitAfter, 2)}</span> },
          { key: "note", header: t("common.note"), render: (e) => <span className="text-on-surface-variant">{e.note || "—"}</span> },
        ]}
      />
    </div>
  );
}

function LedgerTab({ rows }: { rows: LedgerRow[] }) {
  const { t } = useCT();
  if (!rows.length) return <EmptyState title={t("admin.users.noLedger")} />;
  return (
    <div className="card overflow-hidden">
      <DataTable<LedgerRow>
        minWidth={640}
        rows={rows}
        rowKey={(l) => l.id}
        columns={[
          { key: "time", header: t("common.time"), render: (l) => fmtDateTime(l.createdAt) },
          { key: "kind", header: t("common.type"), render: (l) => t(`ledger.${l.kind}`) },
          {
            key: "amount",
            header: t("common.amount"),
            align: "right",
            render: (l) => (
              <span className={`font-mono ${l.amountUsd < 0 ? "text-error" : "text-success"}`}>
                {l.amountUsd > 0 ? "+" : ""}
                {fmtUsd(l.amountUsd)}
              </span>
            ),
          },
          { key: "after", header: t("ledger.balanceAfter"), align: "right", render: (l) => <span className="font-mono">{fmtUsd(l.balanceAfter)}</span> },
          {
            key: "note",
            header: t("common.note"),
            render: (l) => (
              <span className="text-on-surface-variant">
                {[l.ref, l.note].filter(Boolean).join(" · ") || "—"}
              </span>
            ),
          },
        ]}
      />
    </div>
  );
}
