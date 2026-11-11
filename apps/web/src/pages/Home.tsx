import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRightIcon,
  CheckIcon,
  CubeIcon,
  GlobeIcon,
  KeyIcon,
  LockIcon,
  PlugIcon,
  RefreshIcon,
  RocketIcon,
  ScaleIcon,
  ShieldIcon,
  SparkleIcon,
  SwapIcon,
  TerminalIcon,
  VerifiedIcon,
  WalletIcon,
} from "../components/Icon";
import { useT } from "../i18n";
import { apiFetch, unwrap } from "../lib/api";

export function Home() {
  return (
    <div>
      <Hero />
      <Trust />
      <PricingPreview />
      <Steps />
      <Cheaper />
      <ProviderBanner />
      <CtaBanner />
    </div>
  );
}

/* ---------------- Live account pool (summary) ---------------- */

interface PoolSummary {
  ts: string;
  totals: { accounts: number; online: number; cooling: number; error: number; offline: number; requests24h: number };
}

function PoolWidget() {
  const { t } = useT();
  const [pool, setPool] = useState<PoolSummary | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () =>
      apiFetch<unknown>("/api/pool")
        .then((b) => {
          if (!alive) return;
          setPool(unwrap<PoolSummary>(b));
          setFailed(false);
        })
        .catch(() => alive && setFailed(true));
    void load();
    const timer = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  return (
    <div
      className="relative overflow-hidden rounded-[20px] bg-surface-container-lowest p-5 shadow-md transition-shadow duration-200 hover:shadow-lg sm:p-6"
      style={{ border: "1px solid var(--outline-variant)" }}
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 h-1 bg-primary" aria-hidden />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="kicker">
          <CubeIcon width={14} height={14} className="leading-none text-primary" />
          {t("home.pool.label")}
        </div>
        <span className="inline-flex items-center gap-1.5 font-mono text-[10.5px] text-on-surface-faint">
          <span
            className="h-[6px] w-[6px] rounded-full"
            style={{ background: failed ? "var(--error)" : "var(--success)" }}
          />
          {t("home.pool.badge")}
        </span>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-2 text-center">
        {[
          { v: pool ? String(pool.totals.accounts) : "—", k: t("home.pool.accounts"), color: "var(--on-surface)" },
          { v: pool ? String(pool.totals.online) : "—", k: t("home.pool.online"), color: "var(--success)" },
          { v: pool ? String(pool.totals.cooling) : "—", k: t("home.pool.cooling"), color: "var(--warning)" },
          { v: pool ? String(pool.totals.requests24h) : "—", k: t("home.pool.req24h"), color: "var(--on-surface)" },
        ].map((s) => (
          <div key={s.k} className="rounded-lg py-3" style={{ background: "var(--surface-variant)" }}>
            <div className="font-display text-[26px] font-bold tabular-nums" style={{ color: s.color }}>
              {s.v}
            </div>
            <div className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.08em] text-on-surface-faint">{s.k}</div>
          </div>
        ))}
      </div>

      <Link
        to="/pool"
        className="mt-5 inline-flex items-center gap-1.5 text-[13.5px] font-semibold text-primary hover:underline"
      >
        {t("home.pool.more")}
        <ArrowRightIcon width={15} height={15} />
      </Link>
      <p className="mt-3 font-mono text-[10.5px] leading-relaxed tracking-[0.03em] text-on-surface-faint">
        {pool ? pool.ts.replace("T", " ").replace("Z", " UTC") : "…"}
      </p>
    </div>
  );
}

/* ---------------- Hero ---------------- */

function Hero() {
  const { t } = useT();
  return (
    <header className="relative overflow-clip">
      <div className="wk-grid-bg pointer-events-none absolute inset-0 opacity-50" />
      <div className="container-x relative pb-14 pt-14 sm:pb-20 lg:pb-[104px] lg:pt-[88px]">
        <div className="grid items-center gap-10 sm:gap-12 lg:grid-cols-[1.05fr_1fr] lg:gap-16">
          <div>
            <div className="kicker">
              <span className="kicker-dot" />
              {t("home.hero.badge")}
            </div>
            <h1 className="mt-[22px] font-display text-[38px] font-bold leading-[1.04] tracking-[-0.03em] text-on-surface sm:text-[56px]">
              <span className="inline-block">{t("home.hero.titleA")}</span>{" "}
              <span className="inline-block text-primary">{t("home.hero.titleB")}</span>
            </h1>
            <p className="mt-5 font-display text-lg font-semibold leading-relaxed text-on-surface sm:mt-6 sm:text-2xl">
              {t("home.hero.subLead")}{" "}
              <span className="text-tertiary">{t("home.hero.subEm")}</span>{" "}
              {t("home.hero.subTail")}
            </p>
            <div className="mt-[18px] font-mono text-xs uppercase tracking-[0.1em] text-on-surface-faint">
              REAL ACCOUNTS · OFFICIAL UPSTREAM · LIVE POOL
            </div>
            <p className="mt-5 max-w-[540px] text-base leading-relaxed text-on-surface-variant sm:text-[18px]">
              {t("home.hero.desc")}
            </p>
            <div className="mt-7 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
              <Link to="/login" className="wk-btn wk-btn-lg wk-btn-primary w-full sm:w-auto">
                {t("home.hero.ctaPrimary")}
                <ArrowRightIcon width={18} height={18} />
              </Link>
              <Link to="/models" className="wk-btn wk-btn-lg wk-btn-ghost w-full sm:w-auto">
                <SwapIcon width={18} height={18} />
                {t("home.hero.ctaSecondary")}
              </Link>
            </div>
            <div className="mt-7 flex flex-col items-start gap-2.5 text-[13px] text-on-surface-faint sm:mt-[30px] sm:flex-row sm:flex-wrap sm:items-center sm:gap-5">
              {[t("home.hero.check1"), t("home.hero.check2"), t("home.hero.check3")].map(
                (c) => (
                  <span key={c} className="inline-flex items-center gap-1.5">
                    <CheckIcon width={15} height={15} className="text-primary" />
                    {c}
                  </span>
                ),
              )}
            </div>
          </div>

          <PoolWidget />
        </div>
      </div>
    </header>
  );
}

/* ---------------- Don't trust us — verify it ---------------- */

function Trust() {
  const { t } = useT();
  const cards = [
    { icon: <CubeIcon width={22} height={22} />, k: "swap" },
    { icon: <ShieldIcon width={22} height={22} />, k: "tamper" },
    { icon: <LockIcon width={22} height={22} />, k: "hardware" },
  ] as const;
  const widgetRows = [
    { title: t("home.trust.widget.r1"), sub: t("home.trust.widget.r1sub") },
    { title: t("home.trust.widget.r2"), sub: t("home.trust.widget.r2sub") },
    { title: t("home.trust.widget.r3"), sub: t("home.trust.widget.r3sub") },
  ];
  const nodes = [
    { label: t("home.trust.widget.you"), tag: null, tone: "plain", icon: <SparkleIcon width={22} height={22} /> },
    { label: t("home.trust.widget.relay"), tag: t("home.trust.widget.relayTag"), tone: "warn", icon: <GlobeIcon width={22} height={22} /> },
    { label: "TEE", tag: t("home.trust.widget.teeTag"), tone: "ok", icon: <ShieldIcon width={22} height={22} /> },
    { label: t("home.trust.widget.api"), tag: null, tone: "plain", icon: <SparkleIcon width={22} height={22} /> },
  ];

  return (
    <section className="relative overflow-clip">
      <div className="container-x py-14 sm:py-20 lg:py-[96px]">
        <div className="grid items-center gap-10 sm:gap-12 lg:grid-cols-[1.05fr_1fr] lg:gap-16">
          <div>
            <div className="kicker">
              <span className="kicker-dot" />
              {t("home.trust.kicker")}
            </div>
            <h2 className="mt-[18px] font-display text-[32px] font-bold leading-[1.05] tracking-[-0.03em] text-on-surface sm:text-[52px]">
              {t("home.trust.titleA")}
              <span className="text-primary">{t("home.trust.titleB")}</span>
              {t("home.trust.titleC")}
            </h2>
            <p className="mt-5 max-w-[540px] text-base leading-relaxed text-on-surface-variant sm:text-[18px]">
              {t("home.trust.desc")}
            </p>
            <div className="mt-9 flex flex-col gap-6">
              {cards.map((c) => (
                <div key={c.k} className="flex items-start gap-4">
                  <div className="grid h-11 w-11 flex-shrink-0 place-items-center rounded-lg bg-primary-soft text-primary">
                    {c.icon}
                  </div>
                  <div>
                    <div className="text-[15px] font-semibold text-on-surface">
                      {t(`home.trust.cards.${c.k}.title`)}
                    </div>
                    <div className="mt-1 text-[13.5px] leading-relaxed text-on-surface-variant">
                      {t(`home.trust.cards.${c.k}.desc`)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-9 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
              <Link to="/tools/verify" className="wk-btn wk-btn-md wk-btn-primary w-full sm:w-auto">
                {t("home.trust.ctaVerifier")}
                <ArrowRightIcon width={18} height={18} />
              </Link>
              <Link to="/docs" className="wk-btn wk-btn-md wk-btn-ghost w-full sm:w-auto">
                {t("home.trust.ctaHow")}
              </Link>
              <Link to="/docs/endpoints" className="wk-btn wk-btn-md wk-btn-ghost w-full sm:w-auto">
                <TerminalIcon width={18} height={18} />
                {t("home.trust.ctaSource")}
              </Link>
            </div>
            <div className="mt-7 flex flex-wrap items-center gap-5 text-[13px] text-on-surface-faint">
              {[t("home.trust.check1"), t("home.trust.check2"), t("home.trust.check3")].map(
                (c) => (
                  <span key={c} className="inline-flex items-center gap-1.5">
                    <CheckIcon width={15} height={15} style={{ color: "var(--success)" }} />
                    {c}
                  </span>
                ),
              )}
            </div>
          </div>

          {/* Local verification widget */}
          <div>
            <div
              className="rounded-lg bg-surface-container-lowest p-4 shadow-md sm:p-6"
              style={{ border: "1px solid var(--outline-variant)" }}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="inline-flex items-center gap-2">
                  <VerifiedIcon width={20} height={20} className="text-primary" />
                  <span className="text-[15px] font-semibold text-on-surface">
                    {t("home.trust.widget.title")}
                  </span>
                </div>
                <span className="inline-flex items-center gap-1.5 font-mono text-[10.5px] text-on-surface-faint">
                  <span
                    className="h-[6px] w-[6px] rounded-full"
                    style={{ background: "var(--success)" }}
                  />
                  {t("home.trust.widget.badge")}
                </span>
              </div>

              <div className="relative mt-7">
                <div
                  className="absolute left-[12.5%] right-[12.5%] top-[26px] h-px"
                  style={{ background: "var(--outline-variant)" }}
                />
                <div className="relative grid grid-cols-4 gap-1.5">
                  {nodes.map((n) => (
                    <div key={n.label} className="flex flex-col items-center gap-2 text-center">
                      <div
                        className="grid h-[52px] w-[52px] place-items-center rounded-lg"
                        style={{
                          background:
                            n.tone === "warn"
                              ? "var(--warning-container)"
                              : n.tone === "ok"
                                ? "var(--success-container)"
                                : "var(--surface-variant)",
                          border: `1px solid ${
                            n.tone === "warn"
                              ? "var(--warning)"
                              : n.tone === "ok"
                                ? "var(--success)"
                                : "var(--outline-variant)"
                          }`,
                          color:
                            n.tone === "warn"
                              ? "var(--warning)"
                              : n.tone === "ok"
                                ? "var(--success)"
                                : "var(--on-surface-variant)",
                        }}
                      >
                        {n.icon}
                      </div>
                      <div className="text-[12.5px] font-medium text-on-surface">{n.label}</div>
                      {n.tag && (
                        <div
                          className="font-mono text-[10px] leading-none"
                          style={{
                            color: n.tone === "warn" ? "var(--warning)" : "var(--success)",
                          }}
                        >
                          {n.tag}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              <div className="mt-7 flex flex-col gap-2.5">
                {widgetRows.map((r) => (
                  <div
                    key={r.title}
                    className="flex items-center gap-3 rounded-lg px-3 py-3 sm:px-4"
                    style={{ border: "1px solid var(--outline-variant)" }}
                  >
                    <span
                      className="grid h-6 w-6 flex-shrink-0 place-items-center rounded-full"
                      style={{ background: "var(--success-container)", color: "var(--success)" }}
                    >
                      <CheckIcon width={15} height={15} />
                    </span>
                    <span className="min-w-0 flex-1 text-[13.5px]">
                      <span className="font-semibold text-on-surface">{r.title}</span>
                      <span className="ml-2 break-all font-mono text-[12px] text-on-surface-faint">
                        {r.sub}
                      </span>
                    </span>
                    <CheckIcon width={16} height={16} style={{ color: "var(--success)" }} />
                  </div>
                ))}
              </div>

              <div
                className="mt-3 flex items-center gap-2.5 rounded-lg px-4 py-3"
                style={{ background: "var(--success-container)" }}
              >
                <span
                  className="grid h-6 w-6 flex-shrink-0 place-items-center rounded-full"
                  style={{ background: "var(--success)", color: "var(--surface-container-lowest)" }}
                >
                  <CheckIcon width={15} height={15} />
                </span>
                <span className="text-[13.5px] font-semibold" style={{ color: "var(--success)" }}>
                  {t("home.trust.widget.banner")}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ---------------- Pricing preview ---------------- */

const previewRows = [
  { id: "claude-fable-5-1", name: "Claude Fable 5.1", in: "$10.00", out: "$50.00", hot: false },
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", in: "$4.00", out: "$20.00", hot: false },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", in: "$2.00", out: "$10.00", hot: true },
];

function PricingPreview() {
  const { t } = useT();
  return (
    <section
      className="py-14 sm:py-20 lg:py-[108px]"
      style={{ borderTop: "1px solid color-mix(in oklab, var(--outline-variant) 60%, transparent)" }}
    >
      <div className="container-x">
        <div className="mb-8 flex flex-wrap items-end justify-between gap-5">
          <div>
            <div className="kicker">
              <ScaleIcon width={14} height={14} className="leading-none text-primary" />
              {t("home.pricing.kicker")}
            </div>
            <h2 className="mt-3.5 section-title">{t("home.pricing.title")}</h2>
            <p className="mt-3.5 text-base text-on-surface-variant">{t("home.pricing.sub")}</p>
          </div>
          <Link to="/models" className="wk-btn wk-btn-md wk-btn-ghost w-full sm:w-auto">
            {t("home.pricing.viewAll")}
            <ArrowRightIcon width={16} height={16} />
          </Link>
        </div>

        <div
          className="overflow-hidden rounded-lg bg-surface-container-lowest shadow-md transition-shadow duration-200 hover:shadow-lg"
          style={{ border: "1px solid var(--outline-variant)" }}
        >
          <div className="overflow-x-auto" role="region" aria-label={t("home.pricing.title")} tabIndex={0}>
            <table className="wk-table">
              <thead>
                <tr>
                  <th className="ta-l">{t("home.pricing.colModel")}</th>
                  <th className="ta-l">{t("home.pricing.colInput")}</th>
                  <th className="ta-l">{t("home.pricing.colOutput")}</th>
                  <th className="ta-r">{t("home.pricing.colBilling")}</th>
                </tr>
              </thead>
              <tbody>
                {previewRows.map((r) => (
                  <tr key={r.id}>
                    <td className="ta-l">
                      <Link className="inline-flex items-center gap-3" to="/models">
                        <span className="text-base font-bold tracking-[-0.01em] text-on-surface">
                          {r.name}
                        </span>
                        {r.hot && <span className="badge-hot">HOT</span>}
                      </Link>
                    </td>
                    <td className="ta-l">{r.in}</td>
                    <td className="ta-l">{r.out}</td>
                    <td className="ta-r">
                      <span className="font-mono text-[12px] text-on-surface-variant">{t("home.pricing.billing")}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <p className="mt-[18px] text-center font-mono text-[11px] tracking-[0.04em] text-on-surface-faint">
          {t("home.pricing.note")}
        </p>
      </div>
    </section>
  );
}

/* ---------------- Three steps ---------------- */

function Steps() {
  const { t } = useT();
  const steps = [
    { icon: <KeyIcon width={22} height={22} />, num: "01", k: "s1" },
    { icon: <SwapIcon width={22} height={22} />, num: "02", k: "s2" },
    { icon: <VerifiedIcon width={22} height={22} />, num: "03", k: "s3" },
  ] as const;
  return (
    <section
      className="pb-14 pt-14 sm:pb-20 sm:pt-20 lg:pb-[104px] lg:pt-[104px]"
      style={{ borderTop: "1px solid color-mix(in oklab, var(--outline-variant) 60%, transparent)" }}
    >
      <div className="container-x">
        <div className="mb-11">
          <div className="kicker">
            <RocketIcon width={14} height={14} className="leading-none text-primary" />
            {t("home.steps.kicker")}
          </div>
          <h2 className="mt-3.5 section-title">
            {t("home.steps.titleA")}
            <span className="text-primary">{t("home.steps.titleB")}</span>
          </h2>
        </div>
        <div className="relative grid gap-y-10 md:grid-cols-3 md:gap-y-0">
          {steps.map((s, i) => (
            <div
              key={s.k}
              className={`relative px-0 md:px-9 ${i > 0 ? "md:border-l md:border-outline-variant" : ""}`}
            >
              <div className="mb-5 flex items-center gap-3.5">
                <div className="grid h-12 w-12 place-items-center rounded-[13px] bg-primary-soft text-primary">
                  {s.icon}
                </div>
                <span className="font-display text-[30px] font-bold text-outline">{s.num}</span>
              </div>
              <h3 className="font-display text-[21px] font-bold text-on-surface">
                {t(`home.steps.${s.k}.title`)}
              </h3>
              <p className="mt-3 text-[14.5px] leading-relaxed text-on-surface-variant">
                {t(`home.steps.${s.k}.desc`)}
              </p>
              {i < 2 && (
                <ArrowRightIcon
                  className="absolute -right-3 top-2.5 hidden bg-background text-primary md:block"
                  width={22}
                  height={22}
                />
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ---------------- Native pool, not a relay ---------------- */

function Cheaper() {
  const { t } = useT();
  const cards = [
    { icon: <VerifiedIcon width={23} height={23} />, k: "c1" },
    { icon: <PlugIcon width={23} height={23} />, k: "c2" },
    { icon: <RefreshIcon width={23} height={23} />, k: "c3" },
  ] as const;
  return (
    <section className="pb-14 sm:pb-20 lg:pb-[108px]">
      <div className="container-x">
        <div className="mb-9">
          <h2 className="section-title">{t("home.cheaper.title")}</h2>
        </div>
        <div
          className="grid overflow-hidden rounded-lg bg-surface-container-lowest md:grid-cols-3"
          style={{ border: "1px solid var(--outline-variant)" }}
        >
          {cards.map((c, i) => (
            <div
              key={c.k}
              className={`p-6 transition-colors duration-200 hover:bg-surface-container-low sm:p-9 ${
                i < 2 ? "border-b border-outline-variant md:border-b-0 md:border-r" : ""
              }`}
            >
              <div className="mb-[22px] grid h-[46px] w-[46px] place-items-center rounded-xl bg-primary-soft text-primary">
                {c.icon}
              </div>
              <h3 className="font-display text-[21px] font-bold text-on-surface">
                {t(`home.cheaper.${c.k}.title`)}
              </h3>
              <p className="mt-3 text-[14.5px] leading-relaxed text-on-surface-variant">
                {t(`home.cheaper.${c.k}.desc`)}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ---------------- Provider banner ---------------- */

function ProviderBanner() {
  const { t } = useT();
  return (
    <section className="pb-14 sm:pb-20 lg:pb-[108px]">
      <div className="container-x">
        <div
          className="flex flex-col gap-6 rounded-lg bg-surface-container-lowest p-5 sm:p-8 md:flex-row md:items-center md:justify-between"
          style={{ border: "1px solid var(--outline-variant)" }}
        >
          <div className="max-w-[640px]">
            <div className="kicker">
              <WalletIcon width={14} height={14} className="leading-none text-primary" />
              {t("home.provider.kicker")}
            </div>
            <h2 className="mt-3 font-display text-[24px] font-bold tracking-[-0.02em] text-on-surface">
              {t("home.provider.title")}
            </h2>
            <p className="mt-2 text-[14.5px] leading-relaxed text-on-surface-variant">
              {t("home.provider.sub")}
            </p>
          </div>
          <Link to="/provider" className="wk-btn wk-btn-md wk-btn-soft w-full shrink-0 sm:w-auto">
            {t("home.provider.cta")}
            <ArrowRightIcon width={16} height={16} />
          </Link>
        </div>
      </div>
    </section>
  );
}

/* ---------------- Dark CTA banner ---------------- */

function CtaBanner() {
  const { t } = useT();
  return (
    <section className="pb-14 sm:pb-20 lg:pb-[108px]">
      <div className="container-x">
        <div
          className="relative overflow-hidden rounded-2xl px-4 py-10 text-center sm:px-8 sm:py-14 lg:py-[72px]"
          style={{ background: "var(--code-bg)" }}
        >
          <div className="wk-grid-bg pointer-events-none absolute inset-0 opacity-40" />
          <div className="relative">
            <h2
              className="font-display text-[30px] font-bold tracking-[-0.03em] sm:text-[44px]"
              style={{ color: "oklch(0.97 0.01 280)" }}
            >
              {t("home.cta.title")}
            </h2>
            <p className="mx-auto mt-4 max-w-[460px] text-[17px]" style={{ color: "oklch(0.72 0.02 280)" }}>
              {t("home.cta.sub")}
            </p>
            <div className="mt-7 flex flex-col justify-center gap-3 sm:mt-8 sm:flex-row sm:flex-wrap">
              <Link to="/login" className="wk-btn wk-btn-lg wk-btn-primary w-full sm:w-auto">
                {t("home.cta.primary")}
                <ArrowRightIcon width={18} height={18} />
              </Link>
              <Link
                to="/models"
                className="wk-btn wk-btn-lg w-full sm:w-auto"
                style={{ background: "oklch(1 0 0 / 0.1)", color: "oklch(0.97 0.01 280)" }}
              >
                <ScaleIcon width={16} height={16} />
                {t("home.cta.secondary")}
              </Link>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
