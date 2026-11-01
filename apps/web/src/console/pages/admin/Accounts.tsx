import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { ChevronDownIcon, PlugIcon, RefreshIcon, VendorGlyph } from "../../../components/Icon";
import { useAuth } from "../../../lib/auth";
import {
  PLATFORMS,
  adminAccountReauth,
  adminAccountWindow,
  adminAccounts,
  api,
  onboardJob,
  onboardCancel,
  platformLabel,
  type AccountKind,
  type AdminAccount,
  type AdminAccountList,
  type AdminAccountQuery,
  type AdminUser,
  type Group,
  type NodeRow,
  type OnboardJob,
  type Paged,
} from "../../api";
import { useCT } from "../../i18n";
import { useProxyHosts } from "../shared/proxyHosts";
import {
  Async,
  Badge,
  Button,
  Card,
  ChipSelect,
  CopyButton,
  DataTable,
  EmptyState,
  Field,
  Input,
  KV,
  Modal,
  PageHeader,
  PageTabs,
  Pagination,
  Segmented,
  Select,
  Spinner,
  Textarea,
  Toggle,
  Toolbar,
  errMessage,
  fmtDateTime,
  fmtNum,
  fmtPct,
  fmtTokens,
  fmtUsd,
  useAsync,
  useNow,
  useRelTime,
  useToast,
  type Column, fmtDuration,
} from "../../ui";
import { AccountFormModal } from "./_p2AccountForm";

// Admin "upstream accounts": two tabs (API accounts = apikey/upstream relays,
// subscription accounts = OAuth), server-side paging/filtering/sorting, and a
// dense per-row view of quota windows, cost, request volume, egress and times.

interface Refs {
  nodes: NodeRow[];
  groups: Group[];
  providers: AdminUser[];
}

/** ops (账号管理员) cannot list users: the owner filter is simply empty for them. */
async function loadRefs(isOps: boolean): Promise<Refs> {
  const [groups, providers, nodes] = await Promise.all([
    api.get<Group[]>("/api/admin/groups"),
    isOps ? Promise.resolve({ items: [] as AdminUser[] }) : api.get<Paged<AdminUser>>("/api/admin/users", { role: "provider", pageSize: 100 }),
    api.get<NodeRow[]>("/api/admin/nodes"),
  ]);
  return { groups, providers: providers.items, nodes };
}

/** Anthropic subscription accounts that are not active can be re-authorized in place (docs/onboarding.md §11). */
const canReauth = (a: AdminAccount) => a.type === "oauth" && a.platform === "anthropic" && a.status !== "active";

const isFuture = (iso: string | null | undefined) => !!iso && new Date(iso).getTime() > Date.now();
/** Anthropic subscription accounts carry 5h / 7d usage windows (sampled from responses, probed on demand). */
const hasWindow = (a: AdminAccount) => a.type === "oauth" && a.platform === "anthropic";
const PAGE_SIZES = [20, 50, 100];

/** "10-15 19:16" (local), full timestamp in the title. */
function fmtShort(iso: string | null | undefined): string {
  const s = fmtDateTime(iso);
  return s === "—" ? s : s.slice(5);
}

/** Compact time-until: "3h", "2d", "45m"; "—" when unknown or past. */
function fmtCountdown(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  if (ms >= 86_400_000) return `${Math.ceil(ms / 86_400_000)}d`;
  if (ms >= 3_600_000) return `${Math.ceil(ms / 3_600_000)}h`;
  return `${Math.max(1, Math.ceil(ms / 60_000))}m`;
}

/** "2h 05m" / "45m" / "3d 4h" until `iso`, computed against `now`; null when past or unknown. */
function fmtLeft(iso: string | null | undefined, now: number): string | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const d = Math.floor(ms / 86_400_000);
  const h = Math.floor((ms % 86_400_000) / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${Math.max(1, m)}m`;
}

/** "16:30" (local) for a reset timestamp mentioned inside a window reason. */
function fmtClock(iso: string | null | undefined): string {
  const s = fmtDateTime(iso);
  return s === "—" ? s : s.slice(11, 16);
}

/** Account pool · Add account · Onboarders share one sidebar entry; this strip links the three. */
export function AccountTabs() {
  const { t } = useCT();
  const { me } = useAuth();
  return (
    <PageTabs
      tabs={[
        { to: "/console/admin/accounts", label: t("nav.accounts") },
        { to: "/console/admin/onboard", label: t("nav.onboard") },
        ...(me?.role === "admin" ? [{ to: "/console/admin/onboarders", label: t("nav.onboarders") }] : []),
      ]}
    />
  );
}

// ---------- small visual parts ----------

function meterColor(v: number | null): string {
  if (v == null) return "var(--outline)";
  if (v >= 1) return "var(--error)";
  if (v >= 0.8) return "var(--warning)";
  return "var(--success)";
}

/** Ring showing utilisation (0..1) with the reset countdown inside (sub2api style). */
function ResetRing({ value, resetAt, title }: { value: number | null; resetAt: string | null; title?: string }) {
  const r = 10;
  const c = 2 * Math.PI * r;
  const v = value == null ? 0 : Math.min(1, Math.max(0, value));
  return (
    <span className="relative inline-flex h-[26px] w-[26px] shrink-0 items-center justify-center" title={title}>
      <svg width={26} height={26} viewBox="0 0 26 26" className="absolute inset-0 -rotate-90">
        <circle cx="13" cy="13" r={r} fill="none" stroke="var(--surface-variant)" strokeWidth="2.5" />
        <circle
          cx="13"
          cy="13"
          r={r}
          fill="none"
          stroke={meterColor(value)}
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - v)}
        />
      </svg>
      <span className="relative text-[8.5px] font-semibold leading-none" style={{ color: value == null ? "var(--on-surface-faint)" : meterColor(value) }}>
        {fmtCountdown(resetAt)}
      </span>
    </span>
  );
}

/** One "label ▬▬▬ 12%" row of the quota column. */
function MeterRow({
  label,
  value,
  text,
  ring,
  title,
}: {
  label: string;
  value: number | null;
  text: string;
  ring?: ReactNode;
  title?: string;
}) {
  const pct = value == null ? 0 : Math.min(100, Math.max(0, value * 100));
  return (
    <div className="flex items-center gap-2" title={title}>
      <div className="w-[112px]">
        <div className="flex items-baseline justify-between text-[11px] leading-[14px]">
          <span className="font-semibold text-on-surface-variant">{label}</span>
          <span className="font-mono font-semibold tabular-nums" style={{ color: value == null ? "var(--on-surface-faint)" : meterColor(value) }}>
            {text}
          </span>
        </div>
        <div className="mt-0.5 h-1 w-full overflow-hidden rounded-pill" style={{ background: "var(--surface-variant)" }}>
          <div className="h-full rounded-pill transition-all" style={{ width: `${pct}%`, background: meterColor(value) }} />
        </div>
      </div>
      {ring}
    </div>
  );
}

type StatTone = "muted" | "plain" | "primary" | "info" | "success" | "warning";
const statToneClass: Record<StatTone, string> = {
  muted: "text-on-surface-faint",
  plain: "text-on-surface-variant",
  primary: "font-semibold text-primary",
  info: "text-info",
  success: "text-success",
  warning: "font-semibold text-warning",
};
// ---------- row action menu ----------

interface MenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
  primary?: boolean;
  disabled?: boolean;
}

/** "Actions ▾" button opening a fixed-position menu (not clipped by the table's horizontal scroller). */
function ActionMenu({ label, items, iconOnly }: { label: string; items: MenuItem[]; iconOnly?: boolean }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number }>({ top: 0, right: 0 });
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    document.addEventListener("scroll", close, true);
    document.addEventListener("mousedown", close);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
      document.removeEventListener("scroll", close, true);
      document.removeEventListener("mousedown", close);
    };
  }, [open]);
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`wk-btn wk-btn-sm wk-btn-ghost gap-1 !text-[12px] ${iconOnly ? "!px-2" : ""}`}
        title={iconOnly ? label : undefined}
        aria-label={label}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={() => {
          const r = btn.current?.getBoundingClientRect();
          if (r) setPos({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) });
          setOpen((o) => !o);
        }}
      >
        {iconOnly ? <span className="font-semibold leading-none">···</span> : label}
        {!iconOnly && <ChevronDownIcon width={12} height={12} />}
      </button>
      {open && (
        <div
          role="menu"
          className="card fixed z-[80] min-w-[140px] py-1 shadow-lg"
          style={{ top: pos.top, right: pos.right }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              disabled={it.disabled}
              className={`block w-full px-3.5 py-2 text-left text-[12.5px] transition-colors hover:bg-surface-variant disabled:opacity-50 ${
                it.danger ? "text-error" : it.primary ? "font-semibold text-primary" : "text-on-surface"
              }`}
              onClick={() => {
                setOpen(false);
                it.onClick();
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

function Dot({ color, title }: { color: string; title?: string }) {
  return <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color }} title={title} />;
}

// ---------- page ----------

export function AdminAccounts() {
  const { t } = useCT();
  const rel = useRelTime();
  const now = useNow(30_000);
  const toast = useToast();
  const { me } = useAuth();
  // ops (账号管理员): watch + enable/disable + probes + re-authorize; no add / edit / delete / review.
  const isOps = me?.role === "ops";
  const [params, setParams] = useSearchParams();
  const refs = useAsync(() => loadRefs(isOps), [isOps]);

  // All list state lives in the URL so tabs / filters / pages survive reloads and are linkable.
  const kind = (params.get("kind") === "api" ? "api" : "subscription") as AccountKind;
  const pageNo = Math.max(1, Number(params.get("page") ?? 1) || 1);
  const pageSize = PAGE_SIZES.includes(Number(params.get("pageSize"))) ? Number(params.get("pageSize")) : 20;
  const sort = (params.get("sort") as AdminAccountQuery["sort"]) ?? undefined;
  const order = (params.get("order") as AdminAccountQuery["order"]) ?? undefined;
  const platform = params.get("platform") ?? "";
  const status = params.get("status") ?? "";
  const review = params.get("reviewStatus") ?? "";
  const owner = params.get("owner") ?? "";
  const nodeId = params.get("nodeId") ?? "";
  const teamId = params.get("teamId") ?? "";
  const q = params.get("q") ?? "";

  const setParam = (patch: Record<string, string | undefined>, resetPage = true) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    if (resetPage) next.delete("page");
    setParams(next, { replace: true });
  };

  // Search box: local echo, debounced into the URL.
  const [search, setSearch] = useState(q);
  useEffect(() => setSearch(q), [q]);
  useEffect(() => {
    if (search === q) return;
    const h = setTimeout(() => setParam({ q: search.trim() || undefined }), 300);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const query: AdminAccountQuery = { kind, page: pageNo, pageSize, sort, order, q, platform, status, reviewStatus: review, ownerId: owner, nodeId, teamId };
  const queryKey = JSON.stringify(query);
  const list = useAsync(() => adminAccounts(query), [queryKey]);

  const [editing, setEditing] = useState<AdminAccount | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [testing, setTesting] = useState<AdminAccount | null>(null);
  const [reviewing, setReviewing] = useState<AdminAccount | null>(null);
  const [deleting, setDeleting] = useState<AdminAccount | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [reauthing, setReauthing] = useState<AdminAccount | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  // Rows refreshed in place by a window probe, until the next full reload.
  const [overrides, setOverrides] = useState<Map<string, AdminAccount>>(() => new Map());
  const [probing, setProbing] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  useEffect(() => {
    setOverrides(new Map());
    setSelected(new Set());
  }, [list.data]);

  const rows = useMemo(() => (list.data?.items ?? []).map((a) => overrides.get(a.id) ?? a), [list.data, overrides]);
  const nodeNames = useMemo(
    () => new Map((refs.data?.nodes ?? []).map((n) => [n.nodeId, n.deployMeta?.name ?? n.nodeId.slice(0, 14)])),
    [refs.data],
  );
  const proxyHosts = useProxyHosts("admin", rows);

  async function probeWindow(a: AdminAccount) {
    setProbing(a.id);
    try {
      const next = await adminAccountWindow(a.id);
      setOverrides((m) => new Map(m).set(a.id, { ...a, ...next, usage: a.usage, inFlight: a.inFlight }));
      toast.success(t("admin.accounts.windowRefreshed"));
    } catch (e) {
      toast.error(e);
    } finally {
      setProbing(null);
    }
  }

  async function setEnabled(a: AdminAccount, on: boolean) {
    setToggling(a.id);
    try {
      await api.patch(`/api/admin/accounts/${a.id}`, { status: on ? "active" : "disabled" });
      toast.success(t(on ? "admin.accounts.enabledToast" : "admin.accounts.disabledToast"));
      list.reload();
    } catch (e) {
      toast.error(e);
    } finally {
      setToggling(null);
    }
  }

  async function bulk(action: "enable" | "disable" | "delete") {
    if (list.loading || list.error || !list.data) return;
    const ids = [...selected];
    if (!ids.length) return;
    setBulkBusy(true);
    let ok = 0;
    let fail = 0;
    for (const id of ids) {
      try {
        if (action === "delete") await api.del(`/api/admin/accounts/${id}`);
        else await api.patch(`/api/admin/accounts/${id}`, { status: action === "enable" ? "active" : "disabled" });
        ok++;
      } catch {
        fail++;
      }
    }
    setBulkBusy(false);
    (fail ? toast.error : toast.success)(t("admin.accounts.bulkDone", { ok, fail }));
    list.reload();
  }

  const toggleSort = (field: NonNullable<AdminAccountQuery["sort"]>) => {
    if (sort !== field) setParam({ sort: field, order: "desc" });
    else if (order !== "asc") setParam({ sort: field, order: "asc" });
    else setParam({ sort: undefined, order: undefined });
  };
  const SortHeader = ({ field, label }: { field: NonNullable<AdminAccountQuery["sort"]>; label: string }) => (
    <button type="button" className="inline-flex items-center gap-1 hover:text-on-surface" onClick={() => toggleSort(field)}>
      {label}
      <span className="text-[10px]">{sort === field ? (order === "asc" ? "▲" : "▼") : "⇅"}</span>
    </button>
  );

  const allSelected = rows.length > 0 && rows.every((a) => selected.has(a.id));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(rows.map((a) => a.id)));
  const toggleOne = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  // ---------- cells ----------

  function healthDot(a: AdminAccount) {
    if (a.status === "disabled") return <Dot color="var(--outline)" title={t("status.disabled")} />;
    if (a.status === "proxy_down") return <Dot color="var(--warning)" title={proxyDownTitle(a)} />;
    if (a.status === "error") return <Dot color="var(--error)" title={a.errorMessage ?? t("status.error")} />;
    if (a.reviewStatus !== "approved") return <Dot color="var(--warning)" title={t(`status.${a.reviewStatus}`)} />;
    if (a.coolingUntil || isFuture(a.windowExhaustedUntil) || isFuture(a.rateLimitedUntil))
      return <Dot color="var(--warning)" title={`${t("status.cooling")} · ${rel(a.coolingUntil ?? a.windowExhaustedUntil ?? a.rateLimitedUntil)}`} />;
    return <Dot color="var(--success)" title={t("status.active")} />;
  }

  function accountCell(a: AdminAccount) {
    const ownerTag = a.ownerId ? (a.ownerName ?? a.ownerId.slice(0, 8)) : t("admin.accounts.ownerPlatform");
    return (
      <div className="min-w-[170px] max-w-[218px]">
        <div className="flex items-center gap-1.5">
          <span className="inline-flex h-[16px] w-[16px] items-center justify-center text-on-surface-variant" title={platformLabel(a.platform)}>
            <VendorGlyph vendor={a.platform} size={14} />
          </span>
          <span className="truncate text-[12.5px] font-semibold text-on-surface" title={a.name}>
            {a.name}
          </span>
        </div>
        <div className="mt-0.5 truncate pl-[22px] font-mono text-[11px] text-info" title={a.accountEmail ?? a.baseUrl ?? ""}>
          {a.accountEmail ?? a.baseUrl ?? platformLabel(a.platform)}
        </div>
        {me?.role === "admin" && a.type === "oauth" && (
          <div className="mt-1 pl-[22px] text-[11px] text-on-surface-variant">
            <div className="truncate" title={[a.orgName, a.teamName].filter(Boolean).join(" / ") || undefined}>
              {t("team.name")}: {a.orgName ?? a.teamName ?? (a.teamId ? t("team.unnamed") : t("team.unassigned"))}
              {a.orgName && a.teamName && a.teamName !== a.orgName ? <span className="text-on-surface-faint"> ({a.teamName})</span> : null}
            </div>
            {a.teamId && <div className="truncate font-mono text-on-surface-faint" title={a.teamId}>{a.teamId}</div>}
          </div>
        )}
        <div className="mt-1 flex flex-wrap gap-1 pl-[22px] [&_span]:!px-2 [&_span]:!text-[10.5px]">
          {a.type === "oauth" ? (
            <Badge tone={a.subscriptionType ? "primary" : "neutral"}>{a.subscriptionType ?? t("admin.accounts.planUnknown")}</Badge>
          ) : (
            <Badge tone={a.type === "apikey" ? "primary" : "info"}>{t(`type.${a.type}`)}</Badge>
          )}
          {a.executor !== "direct" && (
            <Badge tone="info" title={t("admin.accounts.executorHint")}>
              {t(`executor.${a.executor}`)}
            </Badge>
          )}
          <Badge tone="neutral">{ownerTag}</Badge>
          {a.groups.slice(0, 2).map((g) => (
            <Badge key={g.groupId} tone="neutral">
              {g.name}
            </Badge>
          ))}
          {a.groups.length > 2 && <Badge tone="neutral">+{a.groups.length - 2}</Badge>}
          {!a.groups.length && <Badge tone="warning">{t("admin.accounts.noGroups")}</Badge>}
        </div>
        <div className="mt-1 truncate pl-[22px] text-[11px] text-on-surface-faint" title={`${t("admin.accounts.timeUsed")} ${fmtDateTime(a.lastUsedAt)} · ${t("admin.accounts.timeAdded")} ${fmtDateTime(a.createdAt)}`}>
          {t("admin.accounts.timeUsed")}{" "}
          <span className={a.lastUsedAt ? "font-medium text-on-surface-variant" : ""}>{a.lastUsedAt ? rel(a.lastUsedAt) : t("common.never")}</span>
          {" · "}
          {t("admin.accounts.timeAdded")} {fmtShort(a.createdAt).slice(0, 5)}
        </div>
      </div>
    );
  }

  function proxyDownTitle(a: AdminAccount): string {
    const since = a.proxyDownSince ?? "";
    return t("admin.accounts.proxyDownTitle", { since: since.replace("T", " ").replace("Z", "Z"), dur: since ? fmtDuration(now - Date.parse(since)) : "?", proxy: a.proxyDownProxyId ?? a.boundProxyId ?? "?", reason: a.proxyDownReason ?? "" });
  }

  async function releaseFreeze(a: AdminAccount) {
    setToggling(a.id);
    try {
      await api.post(`/api/admin/accounts/${a.id}/proxy-release`, {});
      toast.success(t("admin.accounts.proxyReleasedToast"));
      list.reload();
    } catch (e) {
      toast.error(e);
    } finally {
      setToggling(null);
    }
  }

  async function rebindProxy(a: AdminAccount) {
    setToggling(a.id);
    try {
      const r = await api.post<{ data: { newProxyId: string; exitIp: string | null } }>(`/api/admin/accounts/${a.id}/proxy-rebind`, {});
      toast.success(t("admin.accounts.proxyRebindToast", { proxy: r.data.newProxyId, ip: r.data.exitIp ?? "?" }));
      list.reload();
    } catch (e) {
      toast.error(e);
    } finally {
      setToggling(null);
    }
  }

  function statusCell(a: AdminAccount) {
    // Cooldowns have their own column now; this note only carries error / review / proxy-freeze state.
    const frozen = a.status === "proxy_down";
    const note = frozen
      ? t("admin.accounts.proxyDownNote", { since: (a.proxyDownSince ?? "").slice(5, 16).replace("T", " "), dur: a.proxyDownSince ? fmtDuration(now - Date.parse(a.proxyDownSince)) : "?" })
      : a.status === "error" ? a.errorMessage : a.reviewStatus !== "approved" ? t(`status.${a.reviewStatus}`) : null;
    return (
      <div className="flex flex-col items-start gap-1.5">
        <div className="flex items-center gap-2.5">
          {/* A frozen account is not re-enabled by the switch (the server refuses); release / rebind live in the actions menu. */}
          <Toggle checked={a.status === "active"} disabled={toggling === a.id || frozen} onChange={(on) => void setEnabled(a, on)} />
          {healthDot(a)}
        </div>
        {frozen && (
          <Badge tone="warning" title={proxyDownTitle(a)}>
            {t("status.proxy_down")}
          </Badge>
        )}
        {note && (
          <span
            className={`max-w-[118px] truncate text-[11px] ${a.status === "error" ? "font-medium text-error" : "text-warning"}`}
            title={note}
          >
            {note}
          </span>
        )}
        {a.usage.errors24h > 0 && a.status !== "error" && (
          <span className="text-[11px] text-warning">{t("admin.accounts.errors24h", { n: a.usage.errors24h })}</span>
        )}
      </div>
    );
  }

  /**
   * Every reason the scheduler may currently skip this account, each with its own
   * countdown: error cooldowns (429 / 529 / auth pause), the subscription window
   * cooldown (reset time + rest period) and per-model-family cooldowns (Fable).
   */
  function cooldownCell(a: AdminAccount) {
    type Item = { tone: "warning" | "error" | "info"; label: string; until: string; sub?: string | null };
    const items: Item[] = [];
    if (isFuture(a.rateLimitedUntil)) items.push({ tone: "warning", label: t("admin.accounts.coolRateLimited"), until: a.rateLimitedUntil!, sub: a.windowReason });
    if (isFuture(a.overloadUntil)) items.push({ tone: "warning", label: t("admin.accounts.coolOverload"), until: a.overloadUntil! });
    if (isFuture(a.tempUnschedulableUntil)) {
      // onboard_cooldown: the deliberate new-account pause (docs/onboarding.md §1 原则 7), not a failure.
      const onboard = (a.errorMessage ?? "").startsWith("onboard_cooldown");
      items.push({ tone: onboard ? "info" : "error", label: t(onboard ? "admin.accounts.coolOnboard" : "admin.accounts.coolPaused"), until: a.tempUnschedulableUntil!, sub: onboard ? null : a.errorMessage });
    }
    if (isFuture(a.windowExhaustedUntil)) {
      const resetAt = a.window5hResetAt && a.window5hResetAt <= a.windowExhaustedUntil! ? a.window5hResetAt : a.windowResetAt;
      items.push({
        tone: "warning",
        label: t("admin.accounts.coolWindow"),
        until: a.windowExhaustedUntil!,
        sub: resetAt && resetAt < a.windowExhaustedUntil! ? t("admin.accounts.coolRest", { reset: fmtClock(resetAt) }) : a.windowReason,
      });
    }
    for (const [scope, c] of Object.entries(a.modelCooldowns ?? {})) {
      if (isFuture(c.until)) items.push({ tone: "info", label: t("admin.accounts.coolModel", { scope: scope.replace(/^model:/, "") }), until: c.until!, sub: c.reason });
    }
    if (items.length === 0) {
      // No cooldown, yet the scheduler may still skip it: say which gate (dead proxy, quarantine,
      // node offline, legacy row …) instead of "no cooldown" (2026-10-28).
      if (a.poolState && a.poolState !== "online" && a.poolReason && a.status === "active" && a.reviewStatus === "approved") {
        return (
          <span className="font-mono text-[11px] text-error" title={a.poolState}>
            {a.poolState} · {a.poolReason}
          </span>
        );
      }
      return (
        <span className="text-[11.5px] text-on-surface-faint" title={a.windowReason ?? undefined}>
          {a.status === "active" && a.reviewStatus === "approved" ? t("admin.accounts.coolNone") : "—"}
        </span>
      );
    }
    return (
      <div className="min-w-[120px] max-w-[150px] space-y-1.5">
        {items.map((it, i) => (
          <div key={i} className="leading-[15px]" title={`${it.label} · ${t("admin.accounts.coolUntil", { at: fmtDateTime(it.until) })}${it.sub ? `\n${it.sub}` : ""}`}>
            <div className="flex items-center gap-1.5">
              <Badge tone={it.tone}>{it.label}</Badge>
              <span className="font-mono text-[11.5px] font-semibold tabular-nums text-on-surface">{fmtLeft(it.until, now) ?? "—"}</span>
            </div>
            <div className="truncate text-[11px] text-on-surface-faint">
              {t("admin.accounts.coolUntil", { at: fmtShort(it.until) })}
              {it.sub ? ` · ${it.sub}` : ""}
            </div>
          </div>
        ))}
      </div>
    );
  }

  function quotaCell(a: AdminAccount) {
    const conc = a.concurrency > 0 ? a.concurrency : null;
    const live = a.inFlight;
    const concRow = (
      <MeterRow
        label={t("admin.accounts.meterConc")}
        value={live == null ? null : conc ? live / conc : live > 0 ? 0.05 : 0}
        text={live == null ? "—" : `${live} / ${conc ?? "∞"}`}
        title={live == null ? t("admin.accounts.inFlightUnknown") : undefined}
      />
    );
    if (hasWindow(a)) {
      const probed = a.windowCheckedAt ? t("admin.accounts.windowChecked", { when: rel(a.windowCheckedAt) }) : t("admin.accounts.windowNotProbed");
      return (
        <div className="space-y-1.5">
          <MeterRow
            label="5H"
            value={a.window5hUsed}
            text={fmtPct(a.window5hUsed)}
            ring={<ResetRing value={a.window5hUsed} resetAt={a.window5hResetAt} title={a.window5hResetAt ? rel(a.window5hResetAt) : undefined} />}
            title={probed}
          />
          <MeterRow
            label="7D"
            value={a.window7dUsed}
            text={fmtPct(a.window7dUsed)}
            ring={<ResetRing value={a.window7dUsed} resetAt={a.window7dResetAt} title={a.window7dResetAt ? rel(a.window7dResetAt) : undefined} />}
            title={probed}
          />
          {concRow}
        </div>
      );
    }
    const rpmCap = a.rpmLimit > 0 ? a.rpmLimit : null;
    return (
      <div className="space-y-1.5">
        {concRow}
        <MeterRow
          label="RPM"
          value={rpmCap ? a.usage.rpm / rpmCap : a.usage.rpm > 0 ? 0.05 : 0}
          text={`${a.usage.rpm} / ${rpmCap ?? "∞"}`}
        />
      </div>
    );
  }

  function usageCell(a: AdminAccount) {
    const u = a.usage;
    const v = (n: number) => (n > 0 ? fmtUsd(n) : "—");
    const Row = ({ label, cost, extra, extraTone }: { label: string; cost: number; extra?: ReactNode; extraTone?: StatTone }) => (
      <div className="flex items-baseline gap-2 text-[11px] leading-[16px]">
        <span className="w-[26px] shrink-0 text-on-surface-faint">{label}</span>
        <span className={`w-[52px] shrink-0 text-right font-mono tabular-nums ${statToneClass[cost > 0 ? "success" : "muted"]}`}>{v(cost)}</span>
        {extra != null && <span className={`font-mono tabular-nums ${statToneClass[extraTone ?? "muted"]}`}>{extra}</span>}
      </div>
    );
    return (
      <div className="min-w-[138px]">
        <Row label="5H" cost={u.h5.costUsd} />
        <Row label="7D" cost={u.d7.costUsd} />
        <Row label="30D" cost={u.d30.costUsd} extra={`${fmtNum(u.d30.requests)} req`} extraTone={u.d30.requests > 0 ? "plain" : "muted"} />
        <Row label={t("admin.accounts.costAll")} cost={u.all.costUsd} extra={`${fmtTokens(u.all.tokens)} tok`} extraTone={u.all.tokens > 0 ? "info" : "muted"} />
        <div className="flex items-baseline gap-2 text-[11px] leading-[16px]">
          <span className="w-[26px] shrink-0 text-on-surface-faint">RPM</span>
          <span className={`font-mono tabular-nums ${statToneClass[u.rpm > 0 ? "warning" : "muted"]}`}>{u.rpm}</span>
        </div>
      </div>
    );
  }

  function egressCell(a: AdminAccount) {
    if (a.route !== "node") return <span className="text-[12px] text-on-surface-faint">{t("admin.accounts.egressDirect")}</span>;
    const node = a.nodeId ? (nodeNames.get(a.nodeId) ?? a.nodeId.slice(0, 14)) : t("admin.accounts.nodeAnyShort");
    const proxyHost = a.boundProxyId ? (proxyHosts.get(a.boundProxyId) ?? `${a.boundProxyId.slice(0, 10)}…`) : t("admin.accounts.proxyAuto");
    const proxy = a.boundProxyId && a.boundProxyCountry ? `${a.boundProxyCountry} · ${proxyHost}` : proxyHost;
    return (
      <div className="max-w-[160px] text-[12px]">
        <div className="truncate font-medium text-info" title={a.nodeId ?? ""}>
          {node}
        </div>
        {a.boundProxyId && (
          <div className="truncate text-[11px] text-on-surface-variant" title={a.boundProxyGroup ?? t("admin.accounts.groupNone")}>
            {t("admin.accounts.colGroup")}: {a.boundProxyGroup ?? t("admin.accounts.groupNone")}
          </div>
        )}
        <div className={`truncate font-mono text-[11px] ${a.boundProxyId ? "text-on-surface-variant" : "text-on-surface-faint"}`} title={[a.boundProxyId, a.boundProxyExitIp].filter(Boolean).join(" · ")}>
          {proxy}{a.boundProxyExitIp ? ` · ${a.boundProxyExitIp}` : ""}
        </div>
      </div>
    );
  }

  function actionsCell(a: AdminAccount) {
    const items: MenuItem[] = [];
    if (a.reviewStatus === "pending" && !isOps) items.push({ label: t("admin.accounts.review"), primary: true, onClick: () => setReviewing(a) });
    if (canReauth(a)) items.push({ label: t("admin.accounts.reauth"), primary: a.status === "error", onClick: () => setReauthing(a) });
    if (hasWindow(a)) items.push({ label: t("admin.accounts.windowRefresh"), disabled: probing === a.id, onClick: () => void probeWindow(a) });
    items.push({ label: t("admin.accounts.test"), onClick: () => setTesting(a) });
    if (!isOps) {
      items.push({
        label: t("common.edit"),
        onClick: () => {
          setEditing(a);
          setFormOpen(true);
        },
      });
    }
    if (a.status === "proxy_down") {
      // Operator rule 2026-11-01: the only two ways out of a proxy freeze.
      items.push({ label: t("admin.accounts.proxyRelease"), primary: true, disabled: toggling === a.id, onClick: () => void releaseFreeze(a) });
      items.push({ label: t("admin.accounts.proxyRebind"), primary: true, disabled: toggling === a.id, onClick: () => void rebindProxy(a) });
      items.push({ label: t("common.disable"), onClick: () => void setEnabled(a, false) });
    } else items.push({ label: a.status === "active" ? t("common.disable") : t("common.enable"), onClick: () => void setEnabled(a, a.status !== "active") });
    if (!isOps) items.push({ label: t("common.delete"), danger: true, onClick: () => setDeleting(a) });
    return (
      <div className="flex justify-end">
        <ActionMenu label={t("common.actions")} items={items} iconOnly />
      </div>
    );
  }

  // Dense rows: tighter padding and a smaller header than the default table.
  const cell = "!px-3 !py-3 !text-[12px] !whitespace-normal align-top";
  const columns: Column<AdminAccount>[] = [
    {
      key: "sel",
      header: <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="select all" />,
      className: `${cell} w-[34px] !px-3`,
      render: (a) => <input type="checkbox" checked={selected.has(a.id)} onChange={() => toggleOne(a.id)} aria-label={a.name} />,
    },
    {
      key: "account",
      header: (
        <span className="inline-flex items-center gap-2">
          <SortHeader field="name" label={t("admin.accounts.colAccount")} />
          <span className="text-on-surface-faint">/</span>
          <SortHeader field="lastUsedAt" label={t("admin.accounts.timeUsed")} />
        </span>
      ),
      className: cell,
      render: accountCell,
    },
    { key: "status", header: t("common.status"), className: cell, render: statusCell },
    { key: "cooldown", header: t("admin.accounts.colCooldown"), className: cell, render: cooldownCell },
    { key: "quota", header: t("admin.accounts.colQuota"), className: cell, render: quotaCell },
    { key: "usage", header: t("admin.accounts.colUsage"), className: cell, render: usageCell },
    { key: "egress", header: t("admin.accounts.colEgress"), className: cell, render: egressCell },
    { key: "actions", header: t("common.actions"), align: "right", className: cell, render: actionsCell },
  ];

  const counts = list.data?.counts;
  const filtersActive = !!(q || platform || status || review || owner || nodeId || teamId);

  return (
    <div>
      <PageHeader
        title={t("admin.accounts.title")}
        actions={
          <>
            <Button onClick={list.reload}>
              <RefreshIcon width={14} height={14} />
              {t("common.refresh")}
            </Button>
            {!isOps && (
              <Button
                variant="primary"
                disabled={!refs.data}
                onClick={() => {
                  setEditing(null);
                  setFormOpen(true);
                }}
              >
                <PlugIcon width={15} height={15} />
                {t("admin.accounts.add")}
              </Button>
            )}
          </>
        }
      />
      <AccountTabs />

      {(counts?.count ?? 0) > 0 && (
        <div
          className="mb-4 flex flex-wrap items-center gap-3 rounded-lg px-4 py-3"
          style={{ background: "var(--warning-container)", border: "1px solid color-mix(in oklab, var(--warning) 30%, transparent)" }}
        >
          <div className="min-w-0 flex-1 text-sm font-semibold text-on-surface">
            {t("admin.accounts.proxyDownBanner", {
              n: counts!.count!,
              since: (counts!.oldestSince ?? "").slice(5, 16).replace("T", " "),
              dur: counts!.oldestSince ? fmtDuration(now - Date.parse(counts!.oldestSince)) : "?",
            })}
          </div>
          {status !== "proxy_down" && (
            <Button size="sm" variant="primary" onClick={() => setParam({ status: "proxy_down", kind })}>
              {t("admin.accounts.proxyDownBannerFilter")}
            </Button>
          )}
        </div>
      )}

      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Segmented<AccountKind>
            value={kind}
            onChange={(k) => setParam({ kind: k, reviewStatus: undefined, status: undefined })}
            options={[
              { value: "subscription", label: `${t("admin.accounts.tabSubscription")}${counts ? ` · ${counts.subscription}` : ""}` },
              { value: "api", label: `${t("admin.accounts.tabApi")}${counts ? ` · ${counts.api}` : ""}` },
            ]}
          />
          {counts && counts.pending > 0 && review !== "pending" && (
            <button
              type="button"
              className="rounded-md px-3 py-1.5 text-[13px] font-medium"
              style={{ background: "var(--warning-container)", color: "var(--warning)" }}
              onClick={() => setParam({ reviewStatus: "pending" })}
            >
              {t("admin.accounts.pendingBanner", { n: counts.pending })}
            </button>
          )}
        </div>

        <Card bodyClassName="p-0">
          <Toolbar>
            <Field label={t("common.search")} className="w-full sm:w-56">
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("admin.accounts.searchPh")} />
            </Field>
            <Field label={t("common.platform")} className="w-[calc(50%-6px)] sm:w-36">
              <Select
                value={platform}
                onChange={(e) => setParam({ platform: e.target.value })}
                options={[{ value: "", label: t("common.all") }, ...PLATFORMS.map((p) => ({ value: p.id, label: p.label }))]}
              />
            </Field>
            <Field label={t("common.status")} className="w-[calc(50%-6px)] sm:w-32">
              <Select
                value={status}
                onChange={(e) => setParam({ status: e.target.value })}
                options={[{ value: "", label: t("common.all") }, ...["active", "disabled", "error", "proxy_down"].map((s) => ({ value: s, label: t(`status.${s}`) }))]}
              />
            </Field>
            <Field label={t("admin.accounts.filterReview")} className="w-[calc(50%-6px)] sm:w-32">
              <Select
                value={review}
                onChange={(e) => setParam({ reviewStatus: e.target.value })}
                options={[{ value: "", label: t("common.all") }, ...["pending", "approved", "rejected"].map((s) => ({ value: s, label: t(`status.${s}`) }))]}
              />
            </Field>
            <Field label={t("admin.accounts.filterOwner")} className="w-[calc(50%-6px)] sm:w-40">
              <Select
                value={owner}
                onChange={(e) => setParam({ owner: e.target.value })}
                options={[
                  { value: "", label: t("admin.accounts.allProviders") },
                  { value: "platform", label: t("admin.accounts.ownerPlatform") },
                  ...(refs.data?.providers ?? []).map((p) => ({ value: p.id, label: p.name })),
                ]}
              />
            </Field>
            <Field label={t("admin.accounts.filterNode")} className="w-[calc(50%-6px)] sm:w-44">
              <Select
                value={nodeId}
                onChange={(e) => setParam({ nodeId: e.target.value })}
                options={[
                  { value: "", label: t("admin.accounts.allNodes") },
                  ...(refs.data?.nodes ?? []).map((n) => ({ value: n.nodeId, label: `${n.deployMeta?.name ?? n.nodeId.slice(0, 14)}${n.online ? "" : ` (${t("status.offline")})`}` })),
                ]}
              />
            </Field>
            <Field label={t("admin.accounts.pageSizeLabel")} className="w-[calc(50%-6px)] sm:w-24">
              <Select
                value={String(pageSize)}
                onChange={(e) => setParam({ pageSize: e.target.value })}
                options={PAGE_SIZES.map((n) => ({ value: String(n), label: String(n) }))}
              />
            </Field>
            {filtersActive && (
              <Button onClick={() => setParams(new URLSearchParams({ kind }), { replace: true })}>{t("common.reset")}</Button>
            )}
          </Toolbar>

          {selected.size > 0 && (
            <div
              className="flex flex-wrap items-center gap-2 px-5 py-2.5 text-[13px]"
              style={{ background: "var(--primary-soft)", borderTop: "1px solid var(--outline-variant)" }}
            >
              <span className="font-medium text-primary">{t("admin.accounts.selected", { n: selected.size })}</span>
              <Button size="sm" disabled={list.loading || !!list.error || !list.data} loading={bulkBusy} onClick={() => void bulk("enable")}>
                {t("common.enable")}
              </Button>
              <Button size="sm" disabled={list.loading || !!list.error || !list.data} loading={bulkBusy} onClick={() => void bulk("disable")}>
                {t("common.disable")}
              </Button>
              {!isOps && (
                <Button size="sm" disabled={list.loading || !!list.error || !list.data} variant="danger" loading={bulkBusy} onClick={() => setBulkDeleteOpen(true)}>
                  {t("common.delete")}
                </Button>
              )}
              <Button size="sm" onClick={() => setSelected(new Set())}>
                {t("common.cancel")}
              </Button>
            </div>
          )}

          <Async state={list} rows={6}>
            {(d: AdminAccountList) => (
              <>
                <DataTable
                  columns={columns}
                  rows={rows}
                  rowKey={(a) => a.id}
                  minWidth={0}
                  loading={list.loading}
                  empty={
                    <EmptyState
                      title={filtersActive || d.total ? t("admin.accounts.empty") : t("admin.accounts.emptyAll")}
                      action={
                        filtersActive || d.total || isOps ? undefined : (
                          <Button
                            variant="primary"
                            onClick={() => {
                              setEditing(null);
                              setFormOpen(true);
                            }}
                          >
                            {t("admin.accounts.add")}
                          </Button>
                        )
                      }
                    />
                  }
                />
                <Pagination page={d.page} pageSize={d.pageSize} total={d.total} onPage={(p) => setParam({ page: String(p) }, false)} />
              </>
            )}
          </Async>
        </Card>
      </div>

      {refs.data && (
        <>
          <AccountFormModal
            open={formOpen}
            account={editing}
            groups={refs.data.groups}
            providers={refs.data.providers}
            nodes={refs.data.nodes}
            onClose={() => setFormOpen(false)}
            onSaved={list.reload}
          />
          <ReviewModal account={reviewing} groups={refs.data.groups} onClose={() => setReviewing(null)} onDone={list.reload} />
        </>
      )}
      <TestModal account={testing} nodeNames={nodeNames} onClose={() => setTesting(null)} />
      <ReauthModal
        account={reauthing}
        onClose={() => setReauthing(null)}
        onDone={() => {
          setReauthing(null);
          list.reload();
        }}
      />

      <Modal
        open={!!deleting}
        size="sm"
        title={t("common.areYouSure")}
        onClose={() => !deleteBusy && setDeleting(null)}
        footer={
          <>
            <Button onClick={() => setDeleting(null)} disabled={deleteBusy}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="danger"
              loading={deleteBusy}
              onClick={async () => {
                if (!deleting) return;
                setDeleteBusy(true);
                try {
                  await api.del(`/api/admin/accounts/${deleting.id}`);
                  toast.success(t("admin.accounts.deleted"));
                  setDeleting(null);
                  list.reload();
                } catch (e) {
                  toast.error(e);
                } finally {
                  setDeleteBusy(false);
                }
              }}
            >
              {t("common.delete")}
            </Button>
          </>
        }
      >
        <p className="text-sm leading-relaxed text-on-surface-variant">{t("admin.accounts.deleteConfirm", { name: deleting?.name ?? "" })}</p>
      </Modal>

      <Modal
        open={bulkDeleteOpen}
        size="sm"
        title={t("common.areYouSure")}
        onClose={() => !bulkBusy && setBulkDeleteOpen(false)}
        footer={
          <>
            <Button onClick={() => setBulkDeleteOpen(false)} disabled={bulkBusy}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="danger"
              loading={bulkBusy}
              onClick={async () => {
                await bulk("delete");
                setBulkDeleteOpen(false);
              }}
            >
              {t("common.delete")}
            </Button>
          </>
        }
      >
        <p className="text-sm leading-relaxed text-on-surface-variant">{t("admin.accounts.bulkDeleteConfirm", { n: selected.size })}</p>
      </Modal>
    </div>
  );
}

// ---------- re-authorize in place (docs/onboarding.md §11) ----------

type ReauthMethod = "session_key" | "auth_url";
const REAUTH_POLL_MS = 1500;

/**
 * Same two methods as onboarding (sessionKey, or authorize link + pasted
 * callback), but the job is pinned to this account and replaces its credential
 * in place. The ops role (账号管理员) uses this to bring revoked accounts back.
 */
function ReauthModal({ account, onClose, onDone }: { account: AdminAccount | null; onClose: () => void; onDone: () => void }) {
  const { t } = useCT();
  const { me } = useAuth();
  const toast = useToast();
  const [method, setMethod] = useState<ReauthMethod>("session_key");
  const [sessionKey, setSessionKey] = useState("");
  const [orgUuid, setOrgUuid] = useState("");
  const [callbackUrl, setCallbackUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<OnboardJob | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Fresh form per account.
  useEffect(() => {
    setMethod("session_key");
    setSessionKey("");
    setOrgUuid("");
    setCallbackUrl("");
    setJob(null);
    setErr(null);
  }, [account?.id]);

  // Poll while the server is working; pending_callback waits for the user, done/failed stop.
  useEffect(() => {
    if (!job || job.status !== "working") return;
    const timer = setInterval(() => {
      onboardJob("admin", job.jobId)
        .then((j) => setJob(j))
        .catch(() => {});
    }, REAUTH_POLL_MS);
    return () => clearInterval(timer);
  }, [job?.jobId, job?.status]);

  if (!account) return null;

  async function submit() {
    if (!account) return;
    setErr(null);
    setBusy(true);
    try {
      if (method === "session_key") {
        setJob(
          await adminAccountReauth(account.id, {
            method,
            sessionKey: sessionKey.trim(),
            ...(me?.role === "admin" && orgUuid.trim() ? { orgUuid: orgUuid.trim() } : {}),
          }),
        );
      } else {
        const j = await adminAccountReauth(account.id, { method });
        setJob(j);
        if (j.authorizeUrl) toast.success(t("onboard.linkReady"));
      }
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function submitCallback() {
    if (!account || !job || !callbackUrl.trim()) return;
    setErr(null);
    setBusy(true);
    try {
      setJob(await adminAccountReauth(account.id, { method: "auth_url", jobId: job.jobId, callbackUrl: callbackUrl.trim() }));
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function closeModal() {
    if (busy) return;
    if (!job || job.status === "done" || job.status === "failed") { onClose(); return; }
    setBusy(true);
    try {
      const result = await onboardCancel("admin", job.jobId);
      if (result.status === "done") onDone();
      else onClose();
    } catch (e) { setErr(errMessage(e)); }
    finally { setBusy(false); }
  }

  const terminal = job?.status === "done" || job?.status === "failed";
  const footer =
    job?.status === "done" ? (
      <Button variant="primary" onClick={onDone}>
        {t("common.close")}
      </Button>
    ) : job?.status === "failed" ? (
      <>
        <Button onClick={() => void closeModal()}>{t("common.close")}</Button>
        <Button variant="primary" onClick={() => setJob(null)}>
          <RefreshIcon width={14} height={14} />
          {t("common.retry")}
        </Button>
      </>
    ) : job?.status === "pending_callback" ? (
      <>
        <Button onClick={() => void closeModal()} disabled={busy}>
          {t("common.cancel")}
        </Button>
        <Button variant="primary" loading={busy} disabled={!callbackUrl.trim()} onClick={() => void submitCallback()}>
          {t("onboard.submitCallback")}
        </Button>
      </>
    ) : job?.status === "working" ? (
      <Button onClick={() => void closeModal()}>{t("common.close")}</Button>
    ) : (
      <>
        <Button onClick={() => void closeModal()} disabled={busy}>
          {t("common.cancel")}
        </Button>
        <Button variant="primary" loading={busy} disabled={method === "session_key" && !sessionKey.trim()} onClick={() => void submit()}>
          <PlugIcon width={15} height={15} />
          {method === "session_key" ? t("admin.accounts.reauthSubmit") : t("onboard.generateLink")}
        </Button>
      </>
    );

  return (
    <Modal open={!!account} title={t("admin.accounts.reauthTitle", { name: account.accountEmail ?? account.name })} onClose={() => void closeModal()} footer={footer}>
      <div className="space-y-4">
        {!job && (
          <>
            <p className="text-[13px] leading-relaxed text-on-surface-variant">{t("admin.accounts.reauthIntro")}</p>
            {account.status === "error" && account.errorMessage && (
              <p className="break-all rounded-md p-3 font-mono text-[12px]" style={{ background: "var(--error-container)", color: "var(--error)" }}>
                {account.errorMessage}
              </p>
            )}
            <Segmented<ReauthMethod>
              value={method}
              onChange={setMethod}
              options={[
                { value: "session_key", label: t("onboard.methodSessionKey") },
                { value: "auth_url", label: t("onboard.methodAuthUrl") },
              ]}
            />
            {method === "session_key" ? (
              <>
                <Field label="sessionKey" hint={t("onboard.sessionKeyHint")}>
                  <Textarea value={sessionKey} onChange={(e) => setSessionKey(e.target.value)} rows={3} autoComplete="off" placeholder="sk-ant-sid01-…" />
                </Field>
                {me?.role === "admin" && <Field label={`${t("onboard.orgUuid")} (${t("common.optional")})`} hint={t("onboard.orgUuidHint")}>
                  <Input value={orgUuid} maxLength={64} autoComplete="off" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" onChange={(e) => setOrgUuid(e.target.value)} />
                </Field>}
              </>
            ) : (
              <p className="text-[13px] leading-relaxed text-on-surface-variant">{t("onboard.authUrlIntro")}</p>
            )}
          </>
        )}

        {job?.status === "pending_callback" && job.authorizeUrl && (
          <>
            <p className="rounded-md p-3 text-[13px] font-medium leading-relaxed" style={{ background: "var(--warning-container)", color: "var(--warning)" }}>
              {t("onboard.authorizeHint")}
            </p>
            <div className="flex items-start gap-2 rounded-md p-3" style={{ background: "var(--code-bg)", color: "var(--code-fg)", border: "1px solid var(--outline-variant)" }}>
              <code className="min-w-0 flex-1 break-all font-mono text-[12.5px] leading-relaxed">{job.authorizeUrl}</code>
              <div className="flex shrink-0 flex-col gap-1.5">
                <CopyButton text={job.authorizeUrl} variant="primary" />
                <a className="wk-btn wk-btn-sm wk-btn-ghost" href={job.authorizeUrl} target="_blank" rel="noreferrer">
                  {t("onboard.openLink")}
                </a>
              </div>
            </div>
            <Field label={t("onboard.callbackUrl")} hint={t("onboard.callbackHint")}>
              <Textarea value={callbackUrl} onChange={(e) => setCallbackUrl(e.target.value)} rows={3} placeholder="https://platform.claude.com/oauth/code/callback?code=…&state=…" />
            </Field>
          </>
        )}

        {job?.status === "working" && (
          <div className="flex items-center gap-3">
            <Spinner size={20} />
            <div>
              <div className="font-semibold">{t("admin.accounts.reauthWorking")}</div>
              <p className="mt-0.5 text-[13px] text-on-surface-faint">{t("onboard.workingHint")}</p>
            </div>
          </div>
        )}

        {terminal && job?.status === "done" && (
          <div className="rounded-md p-3 text-[13px] font-medium" style={{ background: "var(--success-container)", color: "var(--success)" }}>
            {t("admin.accounts.reauthDone")}
            {job.accountEmail && <span className="ml-1 font-mono text-[12px]">{job.accountEmail}</span>}
          </div>
        )}
        {terminal && job?.status === "failed" && (
          <div>
            <div className="font-semibold text-error">{t("admin.accounts.reauthFailed")}</div>
            <p className="mt-1 break-all font-mono text-[12.5px] text-error">{job.error || "—"}</p>
          </div>
        )}
        {err && <p className="text-[13px] text-error">{err}</p>}
      </div>
    </Modal>
  );
}

// ---------- test ----------

interface TestResult {
  ok: boolean;
  statusCode: number;
  latencyMs: number;
  model?: string;
  message: string;
  nodeId?: string | null;
  validation?: "profile" | "inference";
}

function TestModal({ account, nodeNames, onClose }: { account: AdminAccount | null; nodeNames: Map<string, string>; onClose: () => void }) {
  const { t } = useCT();
  const [model, setModel] = useState("");
  const [mode, setMode] = useState<"profile" | "inference">("profile");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const subscription = account?.type === "oauth" && account.platform === "anthropic";

  const close = () => {
    if (busy) return;
    setResult(null);
    setError(null);
    setModel("");
    setMode("profile");
    onClose();
  };

  async function run() {
    if (!account) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api.post<TestResult>(`/api/admin/accounts/${account.id}/test`, { mode: subscription ? mode : "inference", ...(mode === "inference" && model.trim() ? { model: model.trim() } : {}) }));
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={!!account}
      size="md"
      title={t("admin.accounts.testTitle", { name: account?.name ?? "" })}
      onClose={close}
      footer={
        <>
          <Button onClick={close} disabled={busy}>
            {t("common.close")}
          </Button>
          <Button variant="primary" loading={busy} disabled={account?.type === "oauth" && account.platform === "openai"} onClick={() => void run()}>
            {t("admin.accounts.testRun")}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {(account?.route === "node" || (account?.type === "oauth" && account.platform === "openai")) && (
          <p className="rounded-md p-3 text-[13px]" style={{ background: "var(--warning-container)", color: "var(--warning)" }}>
            {t("admin.accounts.testNodeHint")}
          </p>
        )}
        {subscription && (
          <Field label={t("admin.accounts.testMode")}>
            <Select value={mode} onChange={(e) => setMode(e.target.value as "profile" | "inference")} options={[{ value: "profile", label: t("admin.accounts.testModeProfile") }, { value: "inference", label: t("admin.accounts.testModeInference") }]} />
          </Field>
        )}
        {(!subscription || mode === "inference") && (
          <Field label={`${t("admin.accounts.testModel")} (${t("common.optional")})`} hint={t("admin.accounts.testModelHint")}>
            <Input value={model} onChange={(e) => setModel(e.target.value)} className="font-mono" placeholder={account?.models.find((m) => !m.includes("*")) ?? ""} />
          </Field>
        )}
        {error && <p className="text-[13px] text-error">{error}</p>}
        {result && (
          <div
            className="rounded-md p-4"
            style={{ border: `1px solid ${result.ok ? "var(--success)" : "var(--error)"}`, background: result.ok ? "var(--success-container)" : "var(--error-container)" }}
          >
            <div className={`mb-3 font-semibold ${result.ok ? "text-success" : "text-error"}`}>
              {result.ok ? t("admin.accounts.testOk") : t("admin.accounts.testFail")}
            </div>
            <KV
              items={[
                [t("admin.accounts.testStatus"), <span className="font-mono">{result.statusCode || "—"}</span>],
                [t("admin.accounts.testLatency"), <span className="font-mono">{result.latencyMs} ms</span>],
                ...(result.nodeId ? ([[t("admin.accounts.egressNode"), <span className="font-mono">{nodeNames.get(result.nodeId) ?? result.nodeId}</span>]] as Array<[string, JSX.Element]>) : []),
                ...(result.model ? ([[t("common.model"), <span className="font-mono">{result.model}</span>]] as Array<[string, JSX.Element]>) : []),
                [t("admin.accounts.testMessage"), <span className="whitespace-pre-wrap break-all font-mono text-[12.5px]">{result.message}</span>],
              ]}
            />
          </div>
        )}
      </div>
    </Modal>
  );
}

// ---------- review ----------

function ReviewModal({
  account,
  groups,
  onClose,
  onDone,
}: {
  account: AdminAccount | null;
  groups: Group[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useCT();
  const toast = useToast();
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [priority, setPriority] = useState("50");
  const [payout, setPayout] = useState("0.6");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [lastId, setLastId] = useState<string | null>(null);

  if (account && account.id !== lastId) {
    setLastId(account.id);
    setGroupIds(account.groups.length ? account.groups.map((g) => g.groupId) : groups.filter((g) => g.id === "default").map((g) => g.id));
    setPriority(String(account.priority));
    setPayout(String(account.payoutRate > 0 ? account.payoutRate : 0.6));
    setNote("");
  }

  async function act(action: "approve" | "reject") {
    if (!account) return;
    const rate = Number(payout);
    if (action === "approve" && (!Number.isFinite(rate) || rate < 0 || rate > 1)) {
      toast.error(t("admin.accounts.errPayout"));
      return;
    }
    setBusy(action);
    try {
      await api.post(
        `/api/admin/accounts/${account.id}/review`,
        action === "approve"
          ? { action, groupIds, priority: Number(priority) || 0, payoutRate: rate, note: note.trim() || undefined }
          : { action, note: note.trim() || undefined },
      );
      toast.success(t(action === "approve" ? "admin.accounts.approved" : "admin.accounts.rejected"));
      onDone();
      onClose();
      setLastId(null);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal
      open={!!account}
      title={t("admin.accounts.reviewTitle", { name: account?.name ?? "" })}
      onClose={() => {
        if (busy) return;
        setLastId(null);
        onClose();
      }}
      footer={
        <>
          <Button variant="danger" loading={busy === "reject"} disabled={!!busy} onClick={() => void act("reject")}>
            {t("admin.accounts.reject")}
          </Button>
          <Button variant="primary" loading={busy === "approve"} disabled={!!busy} onClick={() => void act("approve")}>
            {t("admin.accounts.approve")}
          </Button>
        </>
      }
    >
      {account && (
        <div className="space-y-5">
          <KV
            items={[
              [t("common.platform"), platformLabel(account.platform)],
              [t("common.type"), t(`type.${account.type}`)],
              [t("admin.accounts.executor"), t(`executor.${account.executor}`)],
              [t("admin.accounts.route"), t(`route.${account.route}`)],
              [t("admin.accounts.colOwner"), account.ownerName ?? "—"],
              ...(account.baseUrl ? ([[t("admin.accounts.baseUrl"), <span className="break-all font-mono text-[12.5px]">{account.baseUrl}</span>]] as Array<[string, JSX.Element]>) : []),
              ...(account.accountEmail ? ([[t("admin.accounts.email"), account.accountEmail]] as Array<[string, string]>) : []),
              [t("admin.accounts.models"), account.models.length ? <span className="font-mono text-[12.5px]">{account.models.join(", ")}</span> : t("common.all")],
            ]}
          />
          <Field label={t("admin.accounts.groups")} hint={t("admin.accounts.groupsHint")}>
            <ChipSelect value={groupIds} onChange={setGroupIds} options={groups.map((g) => ({ value: g.id, label: `${g.name} ×${g.rateMultiplier}` }))} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("admin.accounts.priority")} hint={t("admin.accounts.priorityHint")}>
              <Input type="number" min={0} value={priority} onChange={(e) => setPriority(e.target.value)} />
            </Field>
            <Field label={t("admin.accounts.payoutRate")} hint={t("admin.accounts.payoutRateHint")}>
              <Input type="number" min={0} max={1} step={0.05} value={payout} onChange={(e) => setPayout(e.target.value)} />
            </Field>
          </div>
          <Field label={`${t("admin.accounts.reviewNote")} (${t("common.optional")})`} hint={t("admin.accounts.reviewNoteHint")}>
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} className="font-sans" />
          </Field>
        </div>
      )}
    </Modal>
  );
}
