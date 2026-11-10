import type { CreditAmount, ProviderAccount, UsageCreditsInfo } from "../../api";
import { useCT } from "../../i18n";
import { Badge, type Tone } from "../../ui";

// Usage credits of a subscription account (docs/usage-credits.md): what the last usage poll said about the owner's
// pay-as-you-go credits, the Fable weekly share, and whether the scheduler is serving the account on credits right now.

type T = (key: string, vars?: Record<string, string | number>) => string;
type CreditsAccount = Pick<ProviderAccount, "usageCredits" | "onCredits" | "onCreditsScopes" | "creditsRejectedAt">;

/** "$25.50" for USD, "25.50 EUR" otherwise. */
export function fmtCredit(a: CreditAmount): string {
  const n = (a.amountMinor / 10 ** a.exponent).toFixed(a.exponent);
  return a.currency === "USD" ? `$${n}` : `${n} ${a.currency}`;
}

/** One-line state: 未开通 / 已开通·余额 $X / 已达上限 / 自动充值 … */
export function creditsState(c: UsageCreditsInfo | null | undefined, t: T): { text: string; tone: Tone; hint: string } | null {
  if (!c || !c.known) return null;
  const facts: string[] = [];
  if (c.used) facts.push(t("credits.factUsed", { v: fmtCredit(c.used) }));
  if (c.monthlyCap) facts.push(t("credits.factCap", { v: fmtCredit(c.monthlyCap) }));
  if (c.balance) facts.push(t("credits.factBalance", { v: fmtCredit(c.balance) }));
  if (c.promo) facts.push(t("credits.factPromo", { v: fmtCredit(c.promo) }));
  if (c.autoReload != null) facts.push(t(c.autoReload ? "credits.factAutoReloadOn" : "credits.factAutoReloadOff"));
  if (c.disabledReason) facts.push(t("credits.factDisabledReason", { v: c.disabledReason }));
  const hint = facts.join(" · ");
  if (!c.enabled) return { text: t(c.everEnabled ? "credits.disabledWasOn" : "credits.disabled"), tone: "neutral", hint };
  if (c.spendLimitReached) return { text: t("credits.capReached"), tone: "error", hint };
  const balance = c.balance ? fmtCredit(c.balance) : null;
  if (c.autoReload) return { text: balance ? t("credits.autoReloadBalance", { v: balance }) : t("credits.autoReload"), tone: "success", hint };
  if (c.balance && c.balance.amountMinor <= 0) return { text: t("credits.balanceEmpty"), tone: "error", hint };
  return { text: balance ? t("credits.enabledBalance", { v: balance }) : t("credits.enabled"), tone: "success", hint };
}

const toneText: Record<Tone, string> = {
  neutral: "var(--on-surface-faint)",
  primary: "var(--primary)",
  success: "var(--success)",
  warning: "var(--warning)",
  error: "var(--error)",
  info: "var(--on-surface-variant)",
};

/** Badge shown while requests beyond the plan quota are being scheduled onto the account and paid from its credits. */
export function OnCreditsBadge({ a }: { a: CreditsAccount }) {
  const { t } = useCT();
  if (!a.onCredits) return null;
  const scopes = (a.onCreditsScopes ?? []).map((s) => t(s === "fable" ? "credits.scopeFable" : "credits.scopeWindow")).join(" + ");
  return (
    <Badge tone="warning" title={t("credits.onCreditsHint", { scopes: scopes || "—" })}>
      {t("credits.onCredits")}
    </Badge>
  );
}

/** Compact indicator for account lists: state line, optional Fable weekly share bar, on-credits badge. */
export function UsageCreditsIndicator({ a, showFableBar = true }: { a: CreditsAccount; showFableBar?: boolean }) {
  const { t } = useCT();
  const c = a.usageCredits;
  const state = creditsState(c, t);
  const share = c?.fableShare ?? null;
  if (!state && !share && !a.onCredits) return null;
  const pct = share?.usedPercent ?? null;
  const barColor = pct == null ? "var(--surface-variant)" : pct >= 100 ? "var(--error)" : pct >= 80 ? "var(--warning)" : "var(--primary)";
  return (
    <div className="space-y-1 text-[11px] leading-[14px]">
      {showFableBar && share && (
        <div title={t("credits.fableShareHint", { allowance: share.allowancePercentOfWeekly ?? "—", reset: share.resetsAt ?? "—" })}>
          <div className="flex items-baseline justify-between">
            <span className="font-semibold text-on-surface-variant">{t("credits.fableShare")}</span>
            <span className="font-mono font-semibold tabular-nums" style={{ color: pct == null ? "var(--on-surface-faint)" : barColor }}>
              {pct == null ? "—" : `${Math.round(pct)}%`}
            </span>
          </div>
          <div className="mt-0.5 h-1 w-full overflow-hidden rounded-pill" style={{ background: "var(--surface-variant)" }}>
            <div className="h-full rounded-pill transition-all" style={{ width: `${Math.min(100, Math.max(0, pct ?? 0))}%`, background: barColor }} />
          </div>
        </div>
      )}
      {state && (
        <div className="truncate" title={state.hint || undefined}>
          <span className="text-on-surface-faint">{t("credits.label")} </span>
          <span className="font-semibold" style={{ color: toneText[state.tone] }}>
            {state.text}
          </span>
        </div>
      )}
      {a.onCredits && <OnCreditsBadge a={a} />}
      {a.creditsRejectedAt && c?.enabled && (
        <div className="truncate text-warning" title={t("credits.rejectedHint", { at: a.creditsRejectedAt })}>
          {t("credits.rejected")}
        </div>
      )}
    </div>
  );
}
