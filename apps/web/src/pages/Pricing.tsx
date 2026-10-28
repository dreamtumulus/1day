import { useEffect, useMemo, useState } from "react";
import { ChevronDownIcon, ScaleIcon, SearchIcon } from "../components/Icon";
import { useT } from "../i18n";
import { apiFetch, listData, type PricingEntry } from "../lib/api";

function fmtPrice(usd: string | undefined): string {
  if (usd == null) return "—";
  const n = Number(usd);
  if (Number.isNaN(n)) return "—";
  return `$${n.toFixed(4).replace(/\.?0+$/, "")}`;
}

export function Pricing() {
  const { t } = useT();
  const [entries, setEntries] = useState<PricingEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const body = await apiFetch<unknown>("/api/models/pricing");
      setEntries(listData<PricingEntry>(body));
    } catch {
      setError(t("common.consoleDown"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    // Claude-only for now: hide other platforms' pricing (registry untouched).
    return entries.filter(
      (e) =>
        e.owned_by === "anthropic" &&
        (!q || e.id.toLowerCase().includes(q) || e.name.toLowerCase().includes(q)),
    );
  }, [entries, query]);

  return (
    <div className="container-x py-12 sm:py-16">
      <div className="kicker">
        <ScaleIcon width={14} height={14} className="leading-none text-primary" />
        {t("pricing.kicker")}
      </div>
      <h1 className="mt-4 font-display text-[34px] font-bold leading-[1.05] tracking-[-0.03em] text-on-surface sm:text-[52px]">
        {t("pricing.titleA")} <span className="text-primary">{t("pricing.titleB")}</span>
      </h1>
      <p className="mt-4 max-w-[560px] text-base leading-relaxed text-on-surface-variant sm:text-[17px]">
        {t("pricing.sub")}
      </p>

      <div className="relative mt-7 max-w-sm">
        <SearchIcon
          width={15}
          height={15}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-faint"
        />
        <input
          className="input pl-9"
          placeholder={t("pricing.searchPlaceholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <p className="mt-2 text-xs text-on-surface-faint">{t("pricing.expand")}</p>

      {loading ? (
        <p className="py-16 text-center text-on-surface-faint">{t("common.loading")}</p>
      ) : error ? (
        <div className="card mt-6 py-16 text-center">
          <p className="text-on-surface-variant">{error}</p>
          <button type="button" onClick={() => void load()} className="wk-btn wk-btn-sm wk-btn-ghost mt-4">
            {t("common.retry")}
          </button>
        </div>
      ) : (
        <div className="mt-6 space-y-2.5">
          {filtered.map((e) => {
            const open = openId === e.id;
            const inSku = e.pricing_skus.find((s) => s.meter === "input_tokens");
            const outSku = e.pricing_skus.find((s) => s.meter === "output_tokens");
            return (
              <div
                key={e.id}
                className="overflow-hidden rounded-lg bg-surface-container-lowest"
                style={{ border: "1px solid var(--outline-variant)" }}
              >
                <button
                  type="button"
                  onClick={() => setOpenId(open ? null : e.id)}
                  className="flex w-full items-center justify-between gap-4 px-4 py-3.5 text-left transition-colors hover:bg-surface-variant"
                >
                  <div className="min-w-0">
                    <span className="text-[15px] font-bold tracking-[-0.01em] text-on-surface">
                      {e.name}
                    </span>
                    <span className="ml-2 font-mono text-[11px] text-on-surface-faint">
                      {e.id}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <span className="hidden font-mono text-xs text-on-surface-variant sm:inline">
                      {inSku ? `${fmtPrice(inSku.price_usd)} / ${fmtPrice(outSku?.price_usd)}` : ""}
                    </span>
                    <span className="badge-hot">{e.owned_by}</span>
                    {e.pricing_mode === "dynamic_discount" && (
                      <span className="pill-save hidden md:inline-flex">{t("pricing.dynamic")}</span>
                    )}
                    <ChevronDownIcon
                      width={16}
                      height={16}
                      className={`text-on-surface-faint transition ${open ? "rotate-180" : ""}`}
                    />
                  </div>
                </button>
                {open && (
                  <div style={{ borderTop: "1px solid var(--outline-variant)" }}>
                    <div className="overflow-x-auto">
                      <table className="wk-table">
                        <thead>
                          <tr>
                            <th className="ta-l">{t("pricing.colMeter")}</th>
                            <th className="ta-l">{t("pricing.colPrice")}</th>
                            <th className="ta-l">{t("pricing.colReference")}</th>
                            <th className="ta-r">{t("pricing.colSavings")}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {e.pricing_skus.map((s) => (
                            <tr key={s.sku_id}>
                              <td className="ta-l font-mono text-xs">{s.meter}</td>
                              <td className="ta-l">
                                <span className="font-display text-[15px] font-bold tabular-nums text-tertiary">
                                  {fmtPrice(s.price_usd)}
                                </span>
                                <span className="ml-1 text-[11px] text-on-surface-faint">
                                  {t("models.perMillion")}
                                </span>
                              </td>
                              <td className="ta-l text-on-surface-faint">
                                {s.reference_price_usd ? (
                                  <span className="line-through">{fmtPrice(s.reference_price_usd)}</span>
                                ) : (
                                  "—"
                                )}
                              </td>
                              <td className="ta-r">
                                {s.savings_pct ? (
                                  <span className="pill-save">
                                    {t("models.save")}
                                    {s.savings_pct}%
                                  </span>
                                ) : (
                                  "—"
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
