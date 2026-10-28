import { useEffect, useState } from "react";
import { CubeIcon } from "../components/Icon";
import { useT } from "../i18n";
import { apiFetch, unwrap } from "../lib/api";

interface PoolAccount {
  label: string;
  side: "platform" | "provider";
  state: "online" | "cooling" | "error" | "offline" | "unmanaged" | "unavailable" | "busy";
  window5h: number | null;
  window7d: number | null;
  lastUsedAt: string | null;
  requests30d: number;
  cost30d: number;
}

interface PoolAccountsData {
  ts: string;
  total: number;
  page: number;
  pageSize: number;
  items: PoolAccount[];
}

const PAGE_SIZE = 50;

const STATE_STYLE: Record<PoolAccount["state"], { color: string; bg: string }> = {
  online: { color: "var(--success)", bg: "var(--success-container)" },
  cooling: { color: "var(--warning)", bg: "var(--warning-container)" },
  error: { color: "var(--error)", bg: "var(--error-container, var(--surface-variant))" },
  offline: { color: "var(--on-surface-faint)", bg: "var(--surface-variant)" },
  unmanaged: { color: "var(--on-surface-faint)", bg: "var(--surface-variant)" },
  unavailable: { color: "var(--on-surface-faint)", bg: "var(--surface-variant)" },
  busy: { color: "var(--warning)", bg: "var(--warning-container)" },
};

function pct(v: number | null): string {
  return v === null ? "—" : `${Math.round(v * 100)}%`;
}

export function Pool() {
  const { t } = useT();
  const [side, setSide] = useState<"all" | "platform" | "provider">("all");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<PoolAccountsData | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () => {
      const qs = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (side !== "all") qs.set("side", side);
      apiFetch<unknown>(`/api/pool/accounts?${qs}`)
        .then((b) => {
          if (!alive) return;
          setData(unwrap<PoolAccountsData>(b));
          setFailed(false);
        })
        .catch(() => alive && setFailed(true));
    };
    void load();
    const timer = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [side, page]);

  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  const ago = (iso: string | null): string => {
    if (!iso) return t("home.poolPage.never");
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 90) return t("home.poolPage.justNow");
    if (s < 3600) return t("home.poolPage.minAgo", { n: Math.floor(s / 60) });
    if (s < 86400) return t("home.poolPage.hourAgo", { n: Math.floor(s / 3600) });
    return t("home.poolPage.dayAgo", { n: Math.floor(s / 86400) });
  };

  const stateLabel = (s: PoolAccount["state"]) =>
    t(`poolPage.state${s[0].toUpperCase()}${s.slice(1)}`);

  return (
    <div className="container-x py-12 sm:py-16">
      <div className="kicker">
        <CubeIcon width={14} height={14} className="leading-none text-primary" />
        {t("home.poolPage.kicker")}
      </div>
      <h1 className="mt-4 font-display text-[34px] font-bold leading-[1.05] tracking-[-0.03em] text-on-surface sm:text-[52px]">
        {t("home.poolPage.titleA")} <span className="text-primary">{t("home.poolPage.titleB")}</span>
      </h1>
      <p className="mt-4 max-w-[560px] text-base leading-relaxed text-on-surface-variant sm:text-[17px]">
        {t("home.poolPage.sub")}
      </p>

      <div className="card mt-8 p-3 sm:p-4">
        <div className="flex flex-wrap items-center gap-1.5">
          {(["all", "platform", "provider"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => {
                setSide(s);
                setPage(1);
              }}
              className={`inline-flex items-center gap-1.5 rounded-md px-3.5 py-2 text-[14px] font-medium transition-colors ${
                side === s
                  ? "bg-surface-container-lowest font-semibold text-on-surface shadow-sm"
                  : "text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
              }`}
              style={{ border: `1px solid ${side === s ? "var(--primary)" : "transparent"}` }}
            >
              {s === "all" ? t("home.poolPage.all") : s === "platform" ? t("home.poolPage.direct") : t("home.poolPage.provider")}
            </button>
          ))}
          <span className="ml-auto inline-flex items-center gap-1.5 font-mono text-[11px] text-on-surface-faint">
            <span
              className="h-[6px] w-[6px] rounded-full"
              style={{ background: failed ? "var(--error)" : "var(--success)" }}
            />
            {data ? data.ts.replace("T", " ").replace("Z", " UTC") : "…"}
          </span>
        </div>
      </div>

      <div
        className="mt-3 overflow-hidden rounded-lg bg-surface-container-lowest shadow-sm"
        style={{ border: "1px solid var(--outline-variant)" }}
      >
        <div className="overflow-x-auto">
          <table className="wk-table">
            <thead>
              <tr>
                <th className="ta-l">{t("home.poolPage.colAccount")}</th>
                <th className="ta-l">{t("home.poolPage.colSide")}</th>
                <th className="ta-l">{t("home.poolPage.colState")}</th>
                <th className="ta-r">{t("home.poolPage.col5h")}</th>
                <th className="ta-r">{t("home.poolPage.col7d")}</th>
                <th className="ta-r">{t("home.poolPage.col30dReq")}</th>
                <th className="ta-r">{t("home.poolPage.col30dCost")}</th>
                <th className="ta-r">{t("home.poolPage.colLastUsed")}</th>
              </tr>
            </thead>
            <tbody>
              {(data?.items ?? []).map((a, i) => (
                <tr key={i}>
                  <td className="ta-l font-mono text-[13px]">{a.label}</td>
                  <td className="ta-l text-on-surface-variant">
                    {a.side === "platform" ? t("home.poolPage.direct") : t("home.poolPage.provider")}
                  </td>
                  <td className="ta-l">
                    <span
                      className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-mono text-[11px] font-bold leading-none"
                      style={{ color: STATE_STYLE[a.state].color, background: STATE_STYLE[a.state].bg }}
                    >
                      <span className="h-[6px] w-[6px] rounded-full" style={{ background: STATE_STYLE[a.state].color }} />
                      {stateLabel(a.state)}
                    </span>
                  </td>
                  <td className="ta-r font-mono tabular-nums">{pct(a.window5h)}</td>
                  <td className="ta-r font-mono tabular-nums">{pct(a.window7d)}</td>
                  <td className="ta-r font-mono tabular-nums">{a.requests30d}</td>
                  <td className="ta-r font-mono tabular-nums">${a.cost30d.toFixed(4).replace(/\.?0+$/, "")}</td>
                  <td className="ta-r text-on-surface-faint">{ago(a.lastUsedAt)}</td>
                </tr>
              ))}
              {data && data.items.length === 0 && (
                <tr>
                  <td colSpan={8} className="py-16 text-center text-on-surface-faint">
                    {t("home.poolPage.empty")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between">
        <p className="font-mono text-[11px] tracking-[0.04em] text-on-surface-faint">{t("home.poolPage.masked")}</p>
        <div className="flex items-center gap-3">
          <span className="font-mono text-[12px] text-on-surface-variant">
            {t("home.poolPage.pageInfo", { page, pages, total: data?.total ?? 0 })}
          </span>
          <button
            type="button"
            className="wk-btn wk-btn-sm wk-btn-ghost"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            {t("home.poolPage.prev")}
          </button>
          <button
            type="button"
            className="wk-btn wk-btn-sm wk-btn-ghost"
            disabled={page >= pages}
            onClick={() => setPage((p) => p + 1)}
          >
            {t("home.poolPage.next")}
          </button>
        </div>
      </div>
    </div>
  );
}
