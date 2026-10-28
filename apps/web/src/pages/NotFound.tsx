import { Link } from "react-router-dom";
import { useT } from "../i18n";

export function NotFound() {
  const { t } = useT();
  return (
    <div className="container-x py-24 text-center">
      <p className="font-display text-7xl font-bold text-primary">{t("notFound.title")}</p>
      <p className="mt-4 text-on-surface-variant">{t("notFound.body")}</p>
      <Link to="/" className="wk-btn wk-btn-md wk-btn-primary mt-8">
        {t("notFound.home")}
      </Link>
    </div>
  );
}
