import { Link } from "react-router-dom";
import { CodeBlock } from "../components/CodeBlock";
import { ArrowRightIcon, CubeIcon } from "../components/Icon";
import { useT } from "../i18n";

export function Provider() {
  const { t } = useT();

  return (
    <div className="container-x max-w-3xl py-12 sm:py-16">
      <h1 className="font-display text-[34px] font-bold leading-[1.05] tracking-[-0.03em] text-on-surface sm:text-[52px]">
        {t("providerPage.title")}
      </h1>
      <p className="mt-4 max-w-[560px] text-base leading-relaxed text-on-surface-variant sm:text-[17px]">
        {t("providerPage.sub")}
      </p>

      <div
        className="mt-6 flex gap-3 rounded-lg p-4"
        style={{ background: "var(--primary-soft)", border: "1px solid var(--accent-line)" }}
      >
        <CubeIcon className="mt-0.5 shrink-0 text-primary" />
        <div>
          <p className="text-sm font-semibold text-on-surface">{t("providerPage.noteTitle")}</p>
          <p className="mt-1 text-sm text-on-surface-variant">{t("providerPage.noteBody")}</p>
        </div>
      </div>

      <section className="mt-10">
        <h2 className="font-display text-[24px] font-bold tracking-[-0.02em] text-on-surface">
          {t("providerPage.howTitle")}
        </h2>
        <ol className="mt-4 space-y-3">
          {[t("providerPage.h1"), t("providerPage.h2"), t("providerPage.h3")].map((s, i) => (
            <li key={i} className="flex gap-3">
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-primary font-mono text-xs font-bold text-on-primary">
                {i + 1}
              </span>
              <span className="text-[14.5px] leading-relaxed text-on-surface-variant">{s}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="mt-10">
        <h2 className="font-display text-[24px] font-bold tracking-[-0.02em] text-on-surface">
          {t("providerPage.cliTitle")}
        </h2>
        <CodeBlock
          className="mt-4"
          title="shell"
          code={`1dayapi-node add       # authorize a subscription (OAuth / API key)
1dayapi-node bind      # bind node to your account (bind_…)
1dayapi-node list      # list authorized accounts
1dayapi-node status    # node health and earnings
1dayapi-node restart   # restart the node
1dayapi-node logs      # tail logs
1dayapi-node update    # self-update
1dayapi-node uninstall # remove the node`}
        />
      </section>
      <section className="mt-10">
        <h2 className="font-display text-[24px] font-bold tracking-[-0.02em] text-on-surface">
          {t("providerPage.stepsTitle")}
        </h2>
        <div
          className="mt-5 grid overflow-hidden rounded-lg bg-surface-container-lowest md:grid-cols-3"
          style={{ border: "1px solid var(--outline-variant)" }}
        >
          {(["st1", "st2", "st3"] as const).map((k, i) => (
            <div
              key={k}
              className={`p-6 sm:p-8 ${
                i < 2 ? "border-b border-outline-variant md:border-b-0 md:border-r" : ""
              }`}
            >
              <span className="font-display text-[30px] font-bold text-outline">
                0{i + 1}
              </span>
              <h3 className="mt-3 font-display text-[18px] font-bold text-on-surface">
                {t(`providerPage.${k}.title`)}
              </h3>
              <p className="mt-2 text-[14px] leading-relaxed text-on-surface-variant">
                {t(`providerPage.${k}.desc`)}
              </p>
            </div>
          ))}
        </div>
        <div className="mt-6">
          <Link to="/console" className="wk-btn wk-btn-md wk-btn-primary">
            {t("providerPage.ctaDashboard")}
            <ArrowRightIcon width={16} height={16} />
          </Link>
        </div>
      </section>
    </div>
  );
}
