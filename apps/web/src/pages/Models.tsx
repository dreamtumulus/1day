import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowRightIcon, BookIcon, GridIcon, SearchIcon, VendorGlyph } from "../components/Icon";
import { useT } from "../i18n";
import {
  apiFetch,
  listData,
  type CatalogModel,
  type PricingEntry,
} from "../lib/api";

const vendorOrder = [
  "anthropic",
  "openai",
  "moonshot",
  "zhipu",
  "xai",
  "volcengine",
  "minimax",
  "opencode",
];

const vendorLabels: Record<string, string> = {
  anthropic: "Claude",
  openai: "ChatGPT",
  moonshot: "Kimi",
  zhipu: "Zhipu",
  xai: "Grok",
  volcengine: "Volcengine Ark",
  minimax: "MiniMax",
  opencode: "OpenCode",
};

function fmtPrice(usd: string | undefined): string {
  if (usd == null) return "—";
  const n = Number(usd);
  if (Number.isNaN(n)) return "—";
  return `$${n.toFixed(4).replace(/\.?0+$/, "")}`;
}

function sku(entry: PricingEntry | undefined, meter: string) {
  return entry?.pricing_skus.find((s) => s.meter === meter);
}

function savingsPct(price?: string, ref?: string, declared?: string): number | null {
  if (declared) return Number(declared);
  const p = Number(price);
  const r = Number(ref);
  if (!p || !r || Number.isNaN(p) || Number.isNaN(r) || r <= 0) return null;
  return Math.round((1 - p / r) * 100);
}

export function Models() {
  const { t } = useT();
  const [models, setModels] = useState<CatalogModel[]>([]);
  const [pricing, setPricing] = useState<Map<string, PricingEntry>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [vendor, setVendor] = useState<string>("all");
  const [query, setQuery] = useState("");

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [m, p] = await Promise.all([
        apiFetch<unknown>("/api/models"),
        apiFetch<unknown>("/api/models/pricing"),
      ]);
      setModels(listData<CatalogModel>(m));
      setPricing(new Map(listData<PricingEntry>(p).map((e) => [e.id, e])));
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

  const vendors = useMemo(() => {
    // Claude-only for now: hide other platforms' models (registry untouched).
    const visible = models.filter((m) => m.vendor === "anthropic");
    const present = new Set(visible.map((m) => m.vendor));
    return [
      ...vendorOrder.filter((v) => present.has(v)),
      ...[...present].filter((v) => !vendorOrder.includes(v)).sort(),
    ];
  }, [models]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    // Claude-only for now: hide other platforms (see note above).
    return models.filter(
      (m) =>
        m.vendor === "anthropic" &&
        (vendor === "all" || m.vendor === vendor) &&
        (!q ||
          m.modelId.toLowerCase().includes(q) ||
          m.displayName.toLowerCase().includes(q)),
    );
  }, [models, vendor, query]);

  return (
    <div className="container-x py-12 sm:py-16">
      <div className="kicker">
        <span className="kicker-dot" />
        {t("models.kicker")}
      </div>
      <h1 className="mt-4 font-display text-[34px] font-bold leading-[1.05] tracking-[-0.03em] text-on-surface sm:text-[52px]">
        {t("models.titleA")}{" "}
        <span className="text-primary">{t("models.titleB")}</span>
      </h1>
      <p className="mt-4 max-w-[560px] text-base leading-relaxed text-on-surface-variant sm:text-[17px]">
        {t("models.sub")}
      </p>

      <div className="mt-7 flex flex-col gap-3 sm:flex-row">
        <Link to="/login" className="wk-btn wk-btn-md wk-btn-primary">
          {t("models.ctaKey")}
          <ArrowRightIcon width={16} height={16} />
        </Link>
        <Link to="/docs" className="wk-btn wk-btn-md wk-btn-ghost">
          <BookIcon width={16} height={16} />
          {t("models.ctaGuides")}
        </Link>
      </div>

      {/* Vendor chips + supply note */}
      <div className="card mt-8 p-3 sm:p-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <VendorChip
            active={vendor === "all"}
            label={t("common.all")}
            glyph={<GridIcon width={16} height={16} className="text-primary" />}
            onClick={() => setVendor("all")}
          />
          {vendors.map((v) => (
            <VendorChip
              key={v}
              active={vendor === v}
              label={vendorLabels[v] ?? v}
              glyph={<VendorGlyph vendor={v} />}
              onClick={() => setVendor(v)}
            />
          ))}
          <div className="relative ml-auto hidden sm:block">
            <SearchIcon
              width={15}
              height={15}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-faint"
            />
            <input
              className="input h-9 w-52 pl-8 text-[13px]"
              placeholder={t("models.searchPlaceholder")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>
        <div
          className="mt-3 px-1 pt-3 text-[13px] leading-relaxed text-on-surface-variant"
          style={{ borderTop: "1px solid var(--outline-variant)" }}
        >
          <strong className="text-on-surface">{t("models.supplyLead")}</strong>{" "}
          {t("models.supply")}
        </div>
      </div>

      <p className="mt-6 font-mono text-[11px] tracking-[0.04em] text-on-surface-faint">
        {t("models.unit")}
      </p>

      {loading ? (
        <p className="py-16 text-center text-on-surface-faint">{t("common.loading")}</p>
      ) : error ? (
        <div className="card mt-3 py-16 text-center">
          <p className="text-on-surface-variant">{error}</p>
          <button type="button" onClick={() => void load()} className="wk-btn wk-btn-sm wk-btn-ghost mt-4">
            {t("common.retry")}
          </button>
        </div>
      ) : (
        <div
          className="mt-3 overflow-hidden rounded-lg bg-surface-container-lowest shadow-sm"
          style={{ border: "1px solid var(--outline-variant)" }}
        >
          <div className="overflow-x-auto">
            <table className="wk-table">
              <thead>
                <tr>
                  <th className="ta-l">{t("models.colModel")}</th>
                  <th className="ta-l">{t("models.colInput")}</th>
                  <th className="ta-l">{t("models.colOutput")}</th>
                  <th className="ta-l">{t("models.colCacheRead")}</th>
                  <th className="ta-l">{t("models.colCacheWrite")}</th>
                  <th className="ta-r">{t("models.colSavings")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => {
                  const p = pricing.get(m.modelId);
                  const inSku = sku(p, "input_tokens");
                  const outSku = sku(p, "output_tokens");
                  const crSku = sku(p, "cache_read_tokens");
                  const cw5 = sku(p, "cache_write_5m_tokens") ?? sku(p, "cache_write_tokens");
                  const cw1h = sku(p, "cache_write_1h_tokens");
                  const save = Math.max(
                    savingsPct(inSku?.price_usd, inSku?.reference_price_usd, inSku?.savings_pct) ?? 0,
                    savingsPct(outSku?.price_usd, outSku?.reference_price_usd, outSku?.savings_pct) ?? 0,
                  );
                  return (
                    <tr key={m.modelId}>
                      <td className="ta-l">
                        <div className="text-[15px] font-bold tracking-[-0.01em] text-on-surface">
                          {m.displayName}
                        </div>
                        <div className="mt-0.5 font-mono text-[11px] text-on-surface-faint">
                          {m.modelId}
                        </div>
                      </td>
                      <PriceCell price={inSku?.price_usd} ref_={inSku?.reference_price_usd} />
                      <PriceCell price={outSku?.price_usd} ref_={outSku?.reference_price_usd} />
                      <PriceCell price={crSku?.price_usd} ref_={crSku?.reference_price_usd} />
                      <td className="ta-l">
                        {!cw5 && !cw1h ? (
                          <span className="text-on-surface-faint">—</span>
                        ) : (
                          <div className="flex flex-col gap-2">
                            {cw5 && (
                              <CacheWriteRow
                                label={t("models.fiveMin")}
                                price={cw5.price_usd}
                                ref_={cw5.reference_price_usd}
                              />
                            )}
                            {cw1h && (
                              <CacheWriteRow
                                label={t("models.oneHour")}
                                price={cw1h.price_usd}
                                ref_={cw1h.reference_price_usd}
                              />
                            )}
                          </div>
                        )}
                      </td>
                      <td className="ta-r">
                        {save > 0 ? (
                          <span className="pill-save">
                            {t("models.save")}
                            {save}%
                          </span>
                        ) : (
                          <span className="text-on-surface-faint">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="py-16 text-center text-on-surface-faint">
                      {t("models.empty")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function VendorChip({
  active,
  label,
  glyph,
  onClick,
}: {
  active: boolean;
  label: string;
  glyph: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-2 rounded-md px-3.5 py-2 text-[14px] font-medium transition-colors ${
        active
          ? "bg-surface-container-lowest font-semibold text-on-surface shadow-sm"
          : "text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
      }`}
      style={active ? { border: "1px solid var(--primary)" } : { border: "1px solid transparent" }}
    >
      {glyph}
      {label}
    </button>
  );
}

function PriceCell({ price, ref_ }: { price?: string; ref_?: string }) {
  const { t } = useT();
  if (!price) return <td className="ta-l text-on-surface-faint">—</td>;
  return (
    <td className="ta-l">
      <div>
        <span className="font-display text-[17px] font-bold tabular-nums text-tertiary">
          {fmtPrice(price)}
        </span>
        <span className="ml-1 text-[12px] text-on-surface-faint">{t("models.perMillion")}</span>
      </div>
      {ref_ && (
        <div className="mt-0.5 text-[12px] text-on-surface-faint">
          {t("models.official")}{" "}
          <span className="line-through">{fmtPrice(ref_)}</span>
        </div>
      )}
    </td>
  );
}

function CacheWriteRow({
  label,
  price,
  ref_,
}: {
  label: string;
  price: string;
  ref_?: string;
}) {
  const { t } = useT();
  return (
    <div>
      <div className="text-[11px] text-on-surface-variant">{label}</div>
      <div>
        <span className="font-display text-[15px] font-bold tabular-nums text-tertiary">
          {fmtPrice(price)}
        </span>
        <span className="ml-1 text-[11px] text-on-surface-faint">{t("models.perMillion")}</span>
      </div>
      {ref_ && (
        <div className="text-[11px] text-on-surface-faint">
          {t("models.official")} <span className="line-through">{fmtPrice(ref_)}</span>
        </div>
      )}
    </div>
  );
}
