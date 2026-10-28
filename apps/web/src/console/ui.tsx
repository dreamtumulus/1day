import {
  Fragment,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { NavLink } from "react-router-dom";
import { CheckIcon, ChevronDownIcon, CloseIcon, CopyIcon } from "../components/Icon";
import { ApiError } from "../lib/api";
import { useCT } from "./i18n";

// Console UI kit. Built on the site's design tokens (index.css): card,
// wk-btn, wk-table, input, label, kicker. Keep pages free of ad-hoc styling.

// =====================================================================
// formatting
// =====================================================================

export function fmtUsd(n: number | null | undefined, digits?: number): string {
  if (n == null || Number.isNaN(n)) return "—";
  const abs = Math.abs(n);
  const auto = abs === 0 ? 2 : abs < 0.01 ? 6 : abs < 1 ? 4 : 2;
  // A fixed precision that would round a non-zero amount to 0 falls back to auto.
  const d = digits !== undefined && !(abs > 0 && abs < 0.5 * 10 ** -digits) ? digits : auto;
  const s = abs.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  return `${n < 0 ? "-" : ""}$${s}`;
}

export function fmtNum(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  return n.toLocaleString("en-US");
}

export function fmtTokens(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
  return n.toLocaleString("en-US");
}

export function fmtPct(n: number | null | undefined, digits = 0): string {
  if (n == null || Number.isNaN(n)) return "—";
  return `${(n * 100).toFixed(digits)}%`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Local date-time "YYYY-MM-DD HH:mm". */
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtDate(iso: string | null | undefined): string {
  return iso ? fmtDateTime(iso).slice(0, 10) : "—";
}

/** "3m ago" / "in 5m" style relative time. */
export function useRelTime() {
  const { lang } = useCT();
  return useCallback(
    (iso: string | null | undefined): string => {
      if (!iso) return "—";
      const diff = new Date(iso).getTime() - Date.now();
      const abs = Math.abs(diff);
      const units: Array<[number, Intl.RelativeTimeFormatUnit]> = [
        [86_400_000, "day"],
        [3_600_000, "hour"],
        [60_000, "minute"],
        [1000, "second"],
      ];
      const rtf = new Intl.RelativeTimeFormat(lang === "zh" ? "zh-CN" : "en", { numeric: "auto" });
      for (const [ms, unit] of units) {
        if (abs >= ms || unit === "second") return rtf.format(Math.round(diff / ms), unit);
      }
      return iso;
    },
    [lang],
  );
}

/** Today's date (local) as YYYY-MM-DD, optionally offset by days. */
export function localDay(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function errMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

// =====================================================================
// data loading
// =====================================================================

export interface AsyncState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/** Load data on mount and whenever `deps` change; `reload()` refetches. */
export function useAsync<T>(loader: () => Promise<T>, deps: unknown[] = []): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    loaderRef
      .current()
      .then((d) => {
        if (!alive) return;
        setData(d);
        setError(null);
      })
      .catch((e) => alive && setError(errMessage(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((x) => x + 1), []);
  return { data, error, loading, reload };
}

// =====================================================================
// toast
// =====================================================================

interface Toast {
  id: number;
  tone: "success" | "error" | "info";
  text: string;
}

const ToastContext = createContext<(tone: Toast["tone"], text: string) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((tone: Toast["tone"], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((ts) => [...ts, { id, tone, text }]);
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 4200);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex max-w-[calc(100vw-2rem)] flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="card pointer-events-auto flex items-start gap-2.5 px-4 py-3 text-sm shadow-md"
            style={{
              borderColor:
                t.tone === "error" ? "var(--error)" : t.tone === "success" ? "var(--success)" : "var(--outline-variant)",
            }}
          >
            <span
              className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
              style={{ background: t.tone === "error" ? "var(--error)" : t.tone === "success" ? "var(--success)" : "var(--info)" }}
            />
            <span className="break-words">{t.text}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** toast.success("…") / toast.error(err) */
export function useToast() {
  const push = useContext(ToastContext);
  return {
    success: (text: string) => push("success", text),
    info: (text: string) => push("info", text),
    error: (err: unknown) => push("error", errMessage(err)),
  };
}

// =====================================================================
// layout primitives
// =====================================================================

export function PageHeader({ title, desc, actions }: { title: ReactNode; desc?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="font-display text-[26px] font-bold leading-tight tracking-[-0.03em] text-on-surface sm:text-[30px]">
          {title}
        </h1>
        {desc && <p className="mt-1.5 max-w-3xl text-sm leading-relaxed text-on-surface-variant">{desc}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/**
 * Sibling-page switcher rendered under a PageHeader: a row of route links for
 * pages that belong together (account pool / onboarding / onboarders, nodes /
 * monitor) so the sidebar only needs one entry per family.
 */
export function PageTabs({ tabs }: { tabs: Array<{ to: string; label: ReactNode; end?: boolean }> }) {
  return (
    <div className="mb-5 flex flex-wrap gap-1 border-b border-outline-variant">
      {tabs.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          end={tab.end ?? true}
          className={({ isActive }) =>
            `-mb-px border-b-2 px-3 py-2 text-[13.5px] font-medium transition-colors ${
              isActive ? "border-primary text-primary" : "border-transparent text-on-surface-variant hover:text-on-surface"
            }`
          }
        >
          {tab.label}
        </NavLink>
      ))}
    </div>
  );
}

/** Re-renders every `everyMs` so countdowns stay fresh; returns Date.now(). */
export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

export function Card({
  title,
  desc,
  actions,
  children,
  className = "",
  bodyClassName = "p-5",
}: {
  title?: ReactNode;
  desc?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={`card overflow-hidden ${className}`}>
      {(title || actions) && (
        <header
          className="flex flex-wrap items-center justify-between gap-3 px-5 py-4"
          style={{ borderBottom: "1px solid var(--outline-variant)" }}
        >
          <div className="min-w-0">
            {title && <h2 className="font-display text-[16px] font-semibold tracking-[-0.01em]">{title}</h2>}
            {desc && <p className="mt-0.5 text-[13px] text-on-surface-faint">{desc}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

export type Tone = "neutral" | "primary" | "success" | "warning" | "error" | "info";

const toneStyle: Record<Tone, { background: string; color: string }> = {
  neutral: { background: "var(--surface-variant)", color: "var(--on-surface-variant)" },
  primary: { background: "var(--primary-soft)", color: "var(--primary)" },
  success: { background: "var(--success-container)", color: "var(--success)" },
  warning: { background: "var(--warning-container)", color: "var(--warning)" },
  error: { background: "var(--error-container)", color: "var(--error)" },
  info: { background: "var(--info-container)", color: "var(--info)" },
};

export function StatCard({
  label,
  value,
  sub,
  tone = "neutral",
  icon,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  tone?: Tone;
  icon?: ReactNode;
}) {
  return (
    <div className="card relative overflow-hidden p-5">
      <div className="flex items-center justify-between gap-2">
        <span className="kicker">
          <span className="kicker-dot" style={tone !== "neutral" ? { background: toneStyle[tone].color } : undefined} />
          {label}
        </span>
        {icon && (
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-md" style={toneStyle[tone]}>
            {icon}
          </span>
        )}
      </div>
      <div className="mt-3 font-display text-[26px] font-bold tabular-nums tracking-[-0.02em] text-on-surface">{value}</div>
      {sub && <div className="mt-1 text-[13px] text-on-surface-faint">{sub}</div>}
    </div>
  );
}

export function Badge({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className="inline-flex items-center gap-1 whitespace-nowrap rounded-pill px-2.5 py-0.5 text-[12px] font-semibold"
      style={toneStyle[tone]}
    >
      {children}
    </span>
  );
}

const statusTone: Record<string, Tone> = {
  active: "success",
  approved: "success",
  online: "success",
  ok: "success",
  live: "success",
  dead: "error",
  unused: "info",
  used: "neutral",
  disabled: "neutral",
  offline: "neutral",
  expired: "warning",
  exhausted: "warning",
  pending: "warning",
  cooling: "warning",
  error: "error",
  rejected: "error",
  failed: "error",
};

export function StatusBadge({ status, title }: { status: string; title?: string }) {
  const { t } = useCT();
  return (
    <Badge tone={statusTone[status] ?? "neutral"} title={title}>
      {t(`status.${status}`)}
    </Badge>
  );
}

// =====================================================================
// buttons & form controls
// =====================================================================

type BtnVariant = "primary" | "ghost" | "soft" | "danger";

export function Button({
  variant = "ghost",
  size = "sm",
  loading = false,
  className = "",
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: "sm" | "md"; loading?: boolean }) {
  const v =
    variant === "danger"
      ? "wk-btn-ghost text-error hover:!border-error"
      : variant === "primary"
        ? "wk-btn-primary"
        : variant === "soft"
          ? "wk-btn-soft"
          : "wk-btn-ghost";
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || loading}
      className={`wk-btn wk-btn-${size} ${v} disabled:pointer-events-none disabled:opacity-50 ${className}`}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className="animate-spin" aria-hidden>
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  className = "",
}: {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`block ${className}`}>
      {label && <span className="label">{label}</span>}
      {children}
      {hint && !error && <span className="mt-1.5 block text-[12.5px] leading-relaxed text-on-surface-faint">{hint}</span>}
      {error && <span className="mt-1.5 block text-[12.5px] text-error">{error}</span>}
    </label>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`input ${props.className ?? ""}`} />;
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea rows={3} {...props} className={`input font-mono text-[13px] ${props.className ?? ""}`} />;
}

export function Select({
  options,
  className = "",
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { options: Array<{ value: string; label: string }> }) {
  return (
    <select {...rest} className={`input cursor-pointer pr-8 ${className}`}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className={`inline-flex cursor-pointer items-center gap-2.5 ${disabled ? "opacity-50" : ""}`}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className="relative inline-flex h-[22px] w-10 shrink-0 items-center rounded-pill transition-colors"
        style={{ background: checked ? "var(--primary)" : "var(--outline)" }}
      >
        <span
          className="inline-block h-[18px] w-[18px] rounded-full bg-white shadow-sm transition-transform"
          style={{ transform: `translateX(${checked ? 20 : 2}px)` }}
        />
      </button>
      {label && <span className="text-sm text-on-surface">{label}</span>}
    </label>
  );
}

/** Multi-select rendered as toggleable chips. */
export function ChipSelect({
  options,
  value,
  onChange,
}: {
  options: Array<{ value: string; label: string; hint?: string }>;
  value: string[];
  onChange: (v: string[]) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => {
        const on = value.includes(o.value);
        return (
          <button
            key={o.value}
            type="button"
            title={o.hint}
            onClick={() => onChange(on ? value.filter((x) => x !== o.value) : [...value, o.value])}
            className="inline-flex items-center gap-1.5 rounded-pill px-3 py-1 text-[13px] font-medium transition-colors"
            style={{
              border: `1px solid ${on ? "var(--primary)" : "var(--outline)"}`,
              background: on ? "var(--primary-soft)" : "transparent",
              color: on ? "var(--primary)" : "var(--on-surface-variant)",
            }}
          >
            {on && <CheckIcon width={12} height={12} />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// =====================================================================
// copy / secrets
// =====================================================================

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

export function CopyButton({
  text,
  label,
  size = "sm",
  variant = "ghost",
}: {
  text: string;
  label?: ReactNode;
  size?: "sm" | "md";
  variant?: BtnVariant;
}) {
  const { t } = useCT();
  const [done, setDone] = useState(false);
  return (
    <Button
      size={size}
      variant={variant}
      onClick={() => {
        void copyText(text).then((ok) => {
          if (!ok) return;
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? <CheckIcon width={14} height={14} /> : <CopyIcon width={14} height={14} />}
      {label ?? (done ? t("common.copied") : t("common.copy"))}
    </Button>
  );
}

/** Small inline icon-only copy affordance for table cells. */
export function CopyIconButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="inline-flex h-6 w-6 items-center justify-center rounded-xs text-on-surface-faint transition-colors hover:text-primary"
      onClick={() => {
        void copyText(text).then((ok) => {
          if (!ok) return;
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
    >
      {done ? <CheckIcon width={13} height={13} /> : <CopyIcon width={13} height={13} />}
    </button>
  );
}

/** Highlighted one-time secret (new API key, login key, codes). */
export function SecretBox({ value, note }: { value: string; note?: ReactNode }) {
  const { t } = useCT();
  return (
    <div>
      <div
        className="flex items-start gap-2 rounded-md p-3"
        style={{ background: "var(--code-bg)", color: "var(--code-fg)", border: "1px solid var(--outline-variant)" }}
      >
        <code className="min-w-0 flex-1 break-all font-mono text-[13px] leading-relaxed">{value}</code>
        <CopyButton text={value} variant="primary" />
      </div>
      <p className="mt-2 text-[12.5px] font-medium text-warning">{note ?? t("common.showOnce")}</p>
    </div>
  );
}

export function CodeBlock({ code }: { code: string }) {
  return (
    <div className="relative">
      <pre
        className="overflow-x-auto rounded-md p-4 pr-24 font-mono text-[12.5px] leading-relaxed"
        style={{ background: "var(--code-bg)", color: "var(--code-fg)" }}
      >
        {code}
      </pre>
      <div className="absolute right-2 top-2">
        <CopyButton text={code} variant="primary" />
      </div>
    </div>
  );
}

// =====================================================================
// states
// =====================================================================

export function Loading({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-3 p-1" aria-busy>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-4 animate-pulse rounded-xs bg-surface-variant" style={{ width: `${90 - i * 12}%` }} />
      ))}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const { t } = useCT();
  return (
    <div className="flex flex-col items-start gap-3 rounded-md p-4" style={toneStyle.error}>
      <div className="text-sm font-medium">
        {t("common.error")}: {message}
      </div>
      {onRetry && (
        <Button size="sm" onClick={onRetry}>
          {t("common.retry")}
        </Button>
      )}
    </div>
  );
}

export function EmptyState({ title, desc, action }: { title?: ReactNode; desc?: ReactNode; action?: ReactNode }) {
  const { t } = useCT();
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <div className="font-display text-[15px] font-semibold text-on-surface">{title ?? t("common.empty")}</div>
      {desc && <div className="max-w-md text-[13px] text-on-surface-faint">{desc}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** Renders loading / error / content for an AsyncState. */
export function Async<T>({ state, children, rows }: { state: AsyncState<T>; children: (d: T) => ReactNode; rows?: number }) {
  if (state.error && !state.data) return <ErrorState message={state.error} onRetry={state.reload} />;
  if (!state.data) return <Loading rows={rows} />;
  return <>{children(state.data)}</>;
}

// =====================================================================
// table
// =====================================================================

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  align?: "left" | "right" | "center";
  className?: string;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  empty,
  minWidth = 720,
  loading,
  detail,
  dense,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  empty?: ReactNode;
  minWidth?: number;
  loading?: boolean;
  /** When given, every row gets a chevron and expands in place to show this panel. */
  detail?: (row: T) => ReactNode;
  /** Tighter padding + wrapping cells, for wide logs that must fit without a horizontal scrollbar. */
  dense?: boolean;
}) {
  const alignClass = (a?: string) => (a === "right" ? "ta-r" : a === "center" ? "" : "ta-l");
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const toggle = (k: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  const denseCell = dense ? "!px-3 !py-2.5 !text-[12.5px] !whitespace-normal align-top" : "";
  const span = columns.length + (detail ? 1 : 0);
  return (
    <div className={`overflow-x-auto ${loading ? "opacity-60" : ""}`}>
      <table className={`wk-table console-table ${detail ? "console-table-expandable" : ""}`} style={{ minWidth }}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} className={`${alignClass(c.align)} ${denseCell} ${c.className ?? ""}`}>
                {c.header}
              </th>
            ))}
            {detail && <th className={`w-[36px] ${denseCell}`} aria-label="details" />}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={span} className="!p-0">
                {empty ?? <EmptyState />}
              </td>
            </tr>
          ) : (
            rows.map((r) => {
              const k = rowKey(r);
              const expanded = !!detail && open.has(k);
              return (
                <Fragment key={k}>
                  <tr
                    className={detail ? `cursor-pointer ${expanded ? "is-expanded" : ""}` : undefined}
                    onClick={detail ? () => toggle(k) : undefined}
                  >
                    {columns.map((c) => (
                      <td key={c.key} className={`${alignClass(c.align)} ${denseCell} ${c.className ?? ""}`}>
                        {c.render(r)}
                      </td>
                    ))}
                    {detail && (
                      <td className={`${denseCell} !pl-1 !pr-3`}>
                        <ChevronDownIcon className={`h-4 w-4 text-on-surface-faint transition-transform ${expanded ? "rotate-180" : ""}`} />
                      </td>
                    )}
                  </tr>
                  {expanded && (
                    <tr className="console-table-detail">
                      <td colSpan={span} className="!whitespace-normal !px-4 !py-4 !text-left">
                        {detail!(r)}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

/** Compact label/value grid for expanded table rows. Values wrap; long ones break anywhere. */
export function DetailGrid({ items }: { items: Array<{ label: ReactNode; value: ReactNode; wide?: boolean } | null | false> }) {
  const list = items.filter((x): x is { label: ReactNode; value: ReactNode; wide?: boolean } => !!x);
  return (
    <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {list.map((it, i) => (
        <div key={i} className={`min-w-0 ${it.wide ? "sm:col-span-2 lg:col-span-3 xl:col-span-4" : ""}`}>
          <dt className="text-[11px] font-medium uppercase tracking-[0.08em] text-on-surface-faint">{it.label}</dt>
          <dd className="mt-0.5 break-words text-[13px] text-on-surface">{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Pagination({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (p: number) => void;
}) {
  const { t } = useCT();
  if (total <= pageSize && page === 1) return null;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-[13px] text-on-surface-faint"
      style={{ borderTop: "1px solid var(--outline-variant)" }}
    >
      <span>{t("common.pageInfo", { from, to, total })}</span>
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          {t("common.prev")}
        </Button>
        <span className="font-mono tabular-nums">
          {page} / {pages}
        </span>
        <Button size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          {t("common.next")}
        </Button>
      </div>
    </div>
  );
}

/** Filter bar row above tables. */
export function Toolbar({ children }: { children: ReactNode }) {
  return (
    <div
      className="flex flex-wrap items-end gap-3 px-5 py-4"
      style={{ borderBottom: "1px solid var(--outline-variant)" }}
    >
      {children}
    </div>
  );
}

// =====================================================================
// modal / confirm
// =====================================================================

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  size = "md",
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);
  if (!open) return null;
  const width = size === "sm" ? "max-w-md" : size === "lg" ? "max-w-3xl" : "max-w-xl";
  return (
    <div className="fixed inset-0 z-[90] flex items-end justify-center sm:items-center sm:p-6">
      <div
        className="absolute inset-0"
        style={{ background: "color-mix(in oklab, var(--inverse-surface) 45%, transparent)" }}
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal
        className={`card relative flex max-h-[92vh] w-full ${width} flex-col shadow-lg sm:max-h-[86vh]`}
      >
        <header
          className="flex items-center justify-between gap-3 px-5 py-4"
          style={{ borderBottom: "1px solid var(--outline-variant)" }}
        >
          <h3 className="font-display text-[17px] font-semibold tracking-[-0.01em]">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-on-surface-faint hover:text-on-surface"
            aria-label="Close"
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">{children}</div>
        {footer && (
          <footer
            className="flex flex-wrap items-center justify-end gap-2 px-5 py-3.5"
            style={{ borderTop: "1px solid var(--outline-variant)" }}
          >
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}

/** Button that asks for confirmation before running an async action. */
export function ConfirmButton({
  children,
  title,
  message,
  onConfirm,
  variant = "ghost",
  confirmLabel,
  size = "sm",
}: {
  children: ReactNode;
  title?: ReactNode;
  message?: ReactNode;
  onConfirm: () => Promise<unknown> | void;
  variant?: BtnVariant;
  confirmLabel?: ReactNode;
  size?: "sm" | "md";
}) {
  const { t } = useCT();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Button variant={variant} size={size} onClick={() => setOpen(true)}>
        {children}
      </Button>
      <Modal
        open={open}
        size="sm"
        title={title ?? t("common.areYouSure")}
        onClose={() => !busy && setOpen(false)}
        footer={
          <>
            <Button onClick={() => setOpen(false)} disabled={busy}>
              {t("common.cancel")}
            </Button>
            <Button
              variant={variant === "danger" ? "danger" : "primary"}
              loading={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await onConfirm();
                  setOpen(false);
                } catch (err) {
                  toast.error(err);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {confirmLabel ?? t("common.confirm")}
            </Button>
          </>
        }
      >
        <p className="text-sm leading-relaxed text-on-surface-variant">{message ?? t("common.irreversible")}</p>
      </Modal>
    </>
  );
}

// =====================================================================
// tabs / segmented / misc
// =====================================================================

export function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: ReactNode }>;
}) {
  return (
    <div className="inline-flex max-w-full flex-wrap rounded-md p-0.5" style={{ background: "var(--surface-variant)" }}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`whitespace-nowrap rounded-sm px-3 py-1.5 text-[13px] font-medium transition-colors ${
            value === o.value ? "bg-surface-container-lowest text-on-surface shadow-sm" : "text-on-surface-variant hover:text-on-surface"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Label/value rows for detail panels. */
export function KV({ items }: { items: Array<[ReactNode, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[minmax(110px,auto)_1fr] gap-x-4 gap-y-2.5 text-sm">
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-on-surface-faint">{k}</dt>
          <dd className="min-w-0 break-words text-on-surface">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Mono text, truncated with full value on hover. */
export function Mono({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span className="font-mono text-[12.5px] text-on-surface-variant" title={title}>
      {children}
    </span>
  );
}

/** Thin usage bar (e.g. quota). */
export function ProgressBar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const color = pct >= 100 ? "var(--error)" : pct >= 80 ? "var(--warning)" : "var(--primary)";
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-pill" style={{ background: "var(--surface-variant)" }}>
      <div className="h-full rounded-pill transition-all" style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}
