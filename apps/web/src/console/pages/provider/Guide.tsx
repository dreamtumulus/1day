import { Link } from "react-router-dom";
import { useCT } from "../../i18n";
import { Card, CodeBlock, KV, PageHeader } from "../../ui";

export function ProviderGuide() {
  const { t } = useCT();
  const steps = [1, 2, 3, 4, 5];
  return (
    <>
      <PageHeader title={t("nav.guide")} desc={t("provider.guide.desc")} />
      <div className="space-y-6">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-5">
          {steps.map((i) => (
            <div key={i} className="card p-5">
              <div className="kicker">
                <span className="kicker-dot" />
                {t("provider.guide.stepN", { n: i })}
              </div>
              <div className="mt-3 font-display text-[15px] font-semibold">{t(`provider.guide.s${i}Title`)}</div>
              <p className="mt-1.5 text-[13px] leading-relaxed text-on-surface-variant">{t(`provider.guide.s${i}`)}</p>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <Card title={t("provider.guide.nodeTitle")} desc={t("provider.guide.nodeDesc")}>
            <div className="space-y-4">
              <div>
                <div className="label">{t("provider.nodes.step1")}</div>
                <CodeBlock code="curl -fsSL https://releases.1dayapi.com/provider-node/install.sh | bash" />
              </div>
              <div>
                <div className="label">{t("provider.guide.bindCmd")}</div>
                <CodeBlock code={"1dayapi-node bind --value bind_xxxxxxxx\n1dayapi-node install-service && 1dayapi-node restart"} />
              </div>
              <div>
                <div className="label">{t("provider.guide.uploadCmd")}</div>
                <CodeBlock code={"# local console (only on the node machine)\nhttp://127.0.0.1:16889\n\n# or import local Claude / Codex CLI credentials\n1dayapi-node import"} />
              </div>
              <p className="text-[13px] text-on-surface-variant">
                {t("provider.guide.bindHint")}{" "}
                <Link to="/console/nodes" className="font-medium text-primary hover:underline">
                  {t("nav.nodes")}
                </Link>
              </p>
            </div>
          </Card>
          <Card title={t("provider.guide.rulesTitle")}>
            <KV
              items={[
                [t("provider.guide.r.review"), t("provider.guide.r.reviewV")],
                [t("provider.guide.r.earning"), t("provider.guide.r.earningV")],
                [t("provider.guide.r.failures"), t("provider.guide.r.failuresV")],
                [t("provider.guide.r.settle"), t("provider.guide.r.settleV")],
                [t("provider.guide.r.security"), t("provider.guide.r.securityV")],
              ]}
            />
            <div className="mt-5 flex flex-wrap gap-2">
              <Link to="/console/accounts" className="wk-btn wk-btn-sm wk-btn-primary">
                {t("provider.overview.addAccount")}
              </Link>
              <Link to="/console/settlements" className="wk-btn wk-btn-sm wk-btn-ghost">
                {t("nav.settlements")}
              </Link>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
