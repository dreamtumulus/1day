import type { UsageCostBreakdown, UsageCostMeter, UsageRow } from "./api";
import { useCT } from "./i18n";
import { fmtNum, fmtUsd } from "./ui";

const METER_LABEL: Record<UsageCostMeter, string> = {
  input: "common.cost.input",
  output: "common.cost.output",
  cache_read: "common.cost.cacheRead",
  cache_write_5m: "common.cost.cacheWrite5m",
  cache_write_1h: "common.cost.cacheWrite1h",
  cache_write: "common.cost.cacheWriteUnsplit",
};

/** "1,200 (5m 1,000 · 1h 200)" — the cache-write total with its split by TTL; rows from before the split show the total only. */
export function cacheWriteText(r: Pick<UsageRow, "cacheWriteTokens" | "cacheWrite5mTokens" | "cacheWrite1hTokens">): string {
  const m5 = r.cacheWrite5mTokens ?? 0;
  const h1 = r.cacheWrite1hTokens ?? 0;
  if (!r.cacheWriteTokens || (!m5 && !h1)) return fmtNum(r.cacheWriteTokens);
  const parts = [m5 ? `5m ${fmtNum(m5)}` : "", h1 ? `1h ${fmtNum(h1)}` : ""].filter(Boolean).join(" · ");
  return `${fmtNum(r.cacheWriteTokens)} (${parts})`;
}

/** Itemised cost of one request, laid out like the official bill: one line per meter with its unit price. */
export function CostBreakdown({ breakdown, rateMultiplier }: { breakdown: UsageCostBreakdown; rateMultiplier: number }) {
  const { t } = useCT();
  if (breakdown.lines.length === 0) return <span>—</span>;
  const total = breakdown.lines.reduce((s, l) => s + l.costUsd, 0);
  return (
    <div className="max-w-[560px] overflow-x-auto">
      <table className="w-full font-mono text-[12.5px] tabular-nums">
        <thead>
          <tr className="text-left text-[11px] text-on-surface-faint">
            <th className="py-0.5 pr-4 font-medium">{t("common.cost.meter")}</th>
            <th className="py-0.5 pr-4 text-right font-medium">{t("common.cost.tokens")}</th>
            <th className="py-0.5 pr-4 text-right font-medium">{t("common.cost.unitPrice")}</th>
            <th className="py-0.5 text-right font-medium">{t("common.cost.amount")}</th>
          </tr>
        </thead>
        <tbody>
          {breakdown.lines.map((l) => (
            <tr key={l.meter}>
              <td className="py-0.5 pr-4 font-sans">{t(METER_LABEL[l.meter])}</td>
              <td className="py-0.5 pr-4 text-right">{fmtNum(l.tokens)}</td>
              <td className="py-0.5 pr-4 text-right">{fmtUsd(l.pricePerM, 4)}</td>
              <td className="py-0.5 text-right">{fmtUsd(l.costUsd, 6)}</td>
            </tr>
          ))}
          <tr className="font-semibold" style={{ borderTop: "1px solid var(--outline-variant)" }}>
            <td className="py-0.5 pr-4 font-sans">{t("common.cost.total")}</td>
            <td />
            <td className="py-0.5 pr-4 text-right font-normal text-on-surface-faint">{rateMultiplier !== 1 ? `×${rateMultiplier}` : ""}</td>
            <td className="py-0.5 text-right">{fmtUsd(total, 6)}</td>
          </tr>
        </tbody>
      </table>
      <div className="mt-1 font-sans text-[11.5px] text-on-surface-faint">
        {t(breakdown.priceSource === "settlement" ? "common.cost.noteSettlement" : "common.cost.noteCurrent")}
      </div>
    </div>
  );
}
