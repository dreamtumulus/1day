import { useEffect, useMemo, useState } from "react";
import { ChevronDownIcon, ScaleIcon, VendorGlyph } from "../components/Icon";
import { useT } from "../i18n";
import { apiFetch, listData, type PricingEntry } from "../lib/api";

/** "500K" → 500_000, "2M" → 2_000_000, plain numbers pass through. */
function parseTokens(raw: string): number {
  const m = raw.trim().match(/^([\d.]+)\s*([kKmM])?$/);
  if (!m) return 0;
  const n = Number(m[1]);
  if (Number.isNaN(n)) return 0;
  const mult = m[2]?.toLowerCase() === "m" ? 1_000_000 : m[2]?.toLowerCase() === "k" ? 1_000 : 1;
  return n * mult;
}

function fmtUsd(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

interface Line {
  meter: string;
  tokens: number;
  ours: number;
  official: number | null;
}

export function CostCalculator() {
  const { t } = useT();
  const [entries, setEntries] = useState<PricingEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [modelId, setModelId] = useState("claude-opus-5-5");
  const [inputRaw, setInputRaw] = useState("1M");
  const [outputRaw, setOutputRaw] = useState("1M");
  const [cacheRaw, setCacheRaw] = useState("0");

  useEffect(() => {
    apiFetch<unknown>("/api/models/pricing")
      .then((body) => setEntries(listData<PricingEntry>(body)))
      .catch(() => setError(t("calc.consoleDown")))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Claude-only for now: hide other platforms' models (registry untouched).
  const visible = useMemo(() => entries.filter((e) => e.owned_by === "anthropic"), [entries]);

  const groups = useMemo(() => {
    const g = new Map<string, PricingEntry[]>();
    for (const e of visible) {
      const list = g.get(e.owned_by) ?? [];
      list.push(e);
      g.set(e.owned_by, list);
    }
    return [...g.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [visible]);

  const entry = useMemo(
    () => visible.find((e) => e.id === modelId) ?? visible[0],
    [visible, modelId],
  );

  const { lines, ours, official } = useMemo(() => {
    const lines: Line[] = [];
    let ours = 0;
    let official = 0;
    if (!entry) return { lines, ours, official };
    const volumes: Record<string, number> = {
      input_tokens: parseTokens(inputRaw),
      output_tokens: parseTokens(outputRaw),
      cache_read_tokens: parseTokens(cacheRaw),
    };
    for (const s of entry.pricing_skus) {
      const tokens = volumes[s.meter];
      if (!tokens) continue;
      const o = (tokens / s.quantity) * Number(s.price_usd);
      const r = s.reference_price_usd
        ? (tokens / s.quantity) * Number(s.reference_price_usd)
        : null;
      lines.push({ meter: s.meter, tokens, ours: o, official: r });
      ours += o;
      if (r != null) official += r;
    }
    return { lines, ours, official };
  }, [entry, inputRaw, outputRaw, cacheRaw]);

  const savings = official > 0 ? official - ours : 0;
  const savingsPct = official > 0 ? Math.round((savings / official) * 100) : 0;
  const maxBar = Math.max(ours, official, 1e-9);

  return (
    <div className="container-x py-12 sm:py-16">
      <div className="kicker">
        <ScaleIcon width={14} height={14} className="leading-none text-primary" />
        {t("calc.kicker")}
      </div>
      <h1 className="mt-4 font-display text-[34px] font-bold leading-[1.05] tracking-[-0.03em] text-on-surface sm:text-[52px]">
        {t("calc.titleA")} <span className="text-primary">{t("calc.titleB")}</span>
      </h1>
      <p className="mt-4 max-w-[560px] text-base leading-relaxed text-on-surface-variant sm:text-[17px]">
        {t("calc.sub")}
      </p>

      {loading ? (
        <p className="py-16 text-center text-on-surface-faint">{t("common.loading")}</p>
      ) : error ? (
        <div className="card mt-8 py-16 text-center">
          <p className="text-on-surface-variant">{error}</p>
        </div>
      ) : (
        <div className="mt-10 grid gap-6 lg:grid-cols-[1fr_1.1fr] lg:gap-10">
          {/* Inputs */}
          <div className="card h-fit p-6">
            <label className="label">{t("calc.model")}</label>
            <div className="relative">
              <div className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2">
                {entry && <VendorGlyph vendor={entry.owned_by} />}
              </div>
              <select
                className="input appearance-none pl-9 pr-9"
                value={entry?.id ?? ""}
                onChange={(e) => setModelId(e.target.value)}
              >
                {groups.map(([vendor, list]) => (
                  <optgroup key={vendor} label={vendor}>
                    {list.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.name} ({e.id})
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <ChevronDownIcon
                width={16}
                height={16}
                className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-on-surface-faint"
              />
            </div>

            {[
              { label: t("calc.inputTokens"), v: inputRaw, set: setInputRaw },
              { label: t("calc.outputTokens"), v: outputRaw, set: setOutputRaw },
              { label: t("calc.cacheTokens"), v: cacheRaw, set: setCacheRaw },
            ].map((f) => (
              <div key={f.label} className="mt-4">
                <label className="label">{f.label}</label>
                <input
                  className="input font-mono"
                  value={f.v}
                  onChange={(e) => f.set(e.target.value)}
                  inputMode="decimal"
                />
              </div>
            ))}
            <p className="mt-3 font-mono text-[11px] text-on-surface-faint">{t("calc.unitHint")}</p>
          </div>

          {/* Results */}
          <div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="card p-6">
                <p className="text-sm text-on-surface-variant">{t("calc.ours")}</p>
                <p className="mt-2 font-display text-[34px] font-bold tabular-nums text-tertiary">
                  {fmtUsd(ours)}
                </p>
                <p className="mt-1 text-xs text-on-surface-faint">{t("calc.perRequest")}</p>
              </div>
              <div className="card p-6">
                <p className="text-sm text-on-surface-variant">{t("calc.official")}</p>
                <p className="mt-2 font-display text-[34px] font-bold tabular-nums text-on-surface">
                  {official > 0 ? fmtUsd(official) : "—"}
                </p>
                {official > 0 && (
                  <p className="mt-1">
                    <span className="pill-save">
                      {t("calc.save")} {fmtUsd(savings)} · {savingsPct}%
                    </span>
                  </p>
                )}
              </div>
            </div>

            {/* Comparison bars */}
            <div className="card mt-4 p-6">
              <div className="space-y-4">
                <div>
                  <div className="mb-1.5 flex items-baseline justify-between text-[13px]">
                    <span className="font-medium text-on-surface">{t("calc.ours")}</span>
                    <span className="font-mono font-bold text-tertiary">{fmtUsd(ours)}</span>
                  </div>
                  <div
                    className="h-3 rounded-full"
                    style={{
                      width: `${Math.max(2, (ours / maxBar) * 100)}%`,
                      background:
                        "linear-gradient(90deg, color-mix(in oklab, var(--tertiary) 84%, white), var(--tertiary))",
                    }}
                  />
                </div>
                <div>
                  <div className="mb-1.5 flex items-baseline justify-between text-[13px]">
                    <span className="font-medium text-on-surface">{t("calc.official")}</span>
                    <span className="font-mono text-on-surface-variant">{fmtUsd(official)}</span>
                  </div>
                  <div
                    className="h-3 rounded-full"
                    style={{
                      width: `${Math.max(2, (official / maxBar) * 100)}%`,
                      background:
                        "repeating-linear-gradient(135deg, color-mix(in oklab, var(--on-surface) 14%, transparent) 0 3px, transparent 3px 8px), var(--surface-container-high)",
                    }}
                  />
                </div>
              </div>
            </div>

            {/* Breakdown */}
            {lines.length > 0 && (
              <div
                className="mt-4 overflow-hidden rounded-lg bg-surface-container-lowest shadow-sm"
                style={{ border: "1px solid var(--outline-variant)" }}
              >
                <div className="overflow-x-auto">
                  <table className="wk-table">
                    <thead>
                      <tr>
                        <th className="ta-l">{t("calc.meter")}</th>
                        <th className="ta-r">tokens</th>
                        <th className="ta-r">{t("calc.ours")}</th>
                        <th className="ta-r">{t("calc.official")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lines.map((l) => (
                        <tr key={l.meter}>
                          <td className="ta-l font-mono text-xs">{l.meter}</td>
                          <td className="ta-r font-mono text-xs">{l.tokens.toLocaleString()}</td>
                          <td className="ta-r font-mono text-xs font-bold text-tertiary">
                            {fmtUsd(l.ours)}
                          </td>
                          <td className="ta-r font-mono text-xs text-on-surface-faint">
                            {l.official != null ? (
                              <span className="line-through">{fmtUsd(l.official)}</span>
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
        </div>
      )}
    </div>
  );
}
