import { useState } from "react";
import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { useT } from "../i18n";
import { useAuth } from "../lib/auth";
import { RoleBadge } from "../pages/Login";
import { useTheme } from "../theme";
import {
  BookIcon,
  CloseIcon,
  GlobeIcon,
  HeadsetIcon,
  LogoMark,
  MenuIcon,
  MoonIcon,
  SunIcon,
  XLogoIcon,
} from "./Icon";

const navItems = [
  { to: "/", key: "nav.home", end: true },
  { to: "/models", key: "nav.models" },
  { to: "/pool", key: "nav.pool" },
  { to: "/docs", key: "nav.api" },
  { to: "/tools/verify", key: "nav.verify" },
  { to: "/pricing", key: "nav.pricing" },
  { to: "/provider", key: "nav.provider" },
] as const;

export function Layout() {
  const { t, lang, setLang } = useT();
  const { theme, toggle } = useTheme();
  const { me, logout } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  return (
    <div className="flex min-h-screen flex-col bg-background text-on-surface">
      <nav
        className="fixed top-0 z-50 w-full backdrop-blur-xl"
        style={{
          background: "color-mix(in oklab, var(--background) 78%, transparent)",
          borderBottom: "1px solid var(--outline-variant)",
        }}
      >
        <div className="container-x flex h-16 items-center gap-3 lg:gap-9">
          <button
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-on-surface-variant transition-colors hover:text-primary lg:hidden"
            aria-label="Menu"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? <CloseIcon className="h-6 w-6" /> : <MenuIcon className="h-6 w-6" />}
          </button>

          <Link to="/" className="inline-flex items-center gap-2 leading-none">
            <LogoMark size={28} />
            <span className="font-display text-[1.28rem] font-semibold tracking-[-0.045em]">
              1DayAPI
            </span>
          </Link>

          <div className="hidden items-center gap-7 lg:flex">
            {navItems.map((i) => (
              <NavLink
                key={i.to}
                to={i.to}
                end={"end" in i && i.end}
                className={({ isActive }) =>
                  `text-[15px] tracking-tight transition-colors duration-200 ${
                    isActive
                      ? "font-semibold text-on-surface"
                      : "font-medium text-on-surface-variant hover:text-on-surface"
                  }`
                }
              >
                {t(i.key)}
              </NavLink>
            ))}
          </div>

          <div className="flex-1" />

          <div className="hidden flex-shrink-0 items-center gap-2 lg:flex">
            <Link
              to="/docs"
              aria-label="Docs"
              title="Docs"
              className="inline-flex h-10 w-10 items-center justify-center rounded-md text-on-surface-variant transition-colors hover:text-primary"
            >
              <BookIcon className="h-6 w-6" />
            </Link>
            <button
              className="inline-flex h-10 w-10 items-center justify-center rounded-md text-on-surface-variant transition-colors hover:text-primary"
              aria-label={t("common.language")}
              title={t("common.language")}
              onClick={() => setLang(lang === "en" ? "zh" : "en")}
            >
              <GlobeIcon className="h-[19px] w-[19px]" />
            </button>
            <button
              className="inline-flex h-10 w-10 items-center justify-center rounded-md text-on-surface-variant transition-colors hover:text-primary"
              aria-label={t("common.theme")}
              title={t("common.theme")}
              onClick={toggle}
            >
              {theme === "dark" ? (
                <SunIcon className="h-6 w-6" />
              ) : (
                <MoonIcon className="h-6 w-6" />
              )}
            </button>
            <span className="mx-1.5 h-5 w-px bg-outline" />
            {me ? (
              <>
                <Link
                  to="/console"
                  className="inline-flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-surface-variant"
                >
                  <RoleBadge role={me.role} />
                  <code className="font-mono text-xs text-on-surface-variant">
                    {me.keyPreview}…
                  </code>
                </Link>
                <button
                  onClick={() => {
                    void logout().then(() => navigate("/"));
                  }}
                  className="text-[15px] font-medium text-on-surface-variant transition-colors hover:text-on-surface"
                >
                  {t("nav.logout")}
                </button>
              </>
            ) : (
              <>
                <Link
                  to="/login"
                  className="text-[15px] font-medium text-on-surface-variant transition-colors hover:text-on-surface"
                >
                  {t("nav.login")}
                </Link>
                <Link
                  to="/login"
                  className="ml-1 inline-flex h-9 items-center rounded-sm bg-primary px-4 text-sm font-semibold text-on-primary transition-colors hover:bg-primary-press"
                >
                  {t("nav.getStarted")}
                </Link>
              </>
            )}
          </div>

          <Link
            to={me ? "/console" : "/login"}
            className="inline-flex h-9 shrink-0 items-center rounded-sm bg-primary px-3 text-sm font-semibold text-on-primary transition-colors hover:bg-primary-press lg:hidden"
          >
            {me ? t("nav.dashboard") : t("nav.getStarted")}
          </Link>
        </div>

        {open && (
          <div
            className="px-4 pb-4 pt-2 lg:hidden"
            style={{ borderTop: "1px solid var(--outline-variant)" }}
          >
            <div className="flex flex-col gap-1">
              {navItems.map((i) => (
                <NavLink
                  key={i.to}
                  to={i.to}
                  end={"end" in i && i.end}
                  onClick={() => setOpen(false)}
                  className={({ isActive }) =>
                    `rounded-md px-2 py-2 text-[15px] ${
                      isActive
                        ? "font-semibold text-on-surface"
                        : "font-medium text-on-surface-variant"
                    }`
                  }
                >
                  {t(i.key)}
                </NavLink>
              ))}
              <div className="mt-2 flex items-center gap-2">
                <button
                  onClick={toggle}
                  className="wk-btn wk-btn-sm wk-btn-ghost flex-1"
                >
                  {theme === "dark" ? <SunIcon width={16} height={16} /> : <MoonIcon width={16} height={16} />}
                </button>
                <button
                  onClick={() => setLang(lang === "en" ? "zh" : "en")}
                  className="wk-btn wk-btn-sm wk-btn-ghost flex-1"
                >
                  {t("common.language")}
                </button>
                <Link
                  to="/login"
                  onClick={() => setOpen(false)}
                  className="wk-btn wk-btn-sm wk-btn-ghost flex-1"
                >
                  {t("nav.login")}
                </Link>
              </div>
            </div>
          </div>
        )}
      </nav>

      <main className="flex-1 pt-16">
        <Outlet />
      </main>

      <footer
        className="w-full bg-surface-variant"
        style={{ borderTop: "1px solid var(--outline-variant)" }}
      >
        <div className="container-x pb-8 pt-12 sm:pb-10 sm:pt-16">
          <div className="grid grid-cols-2 gap-10 md:grid-cols-[1.6fr_repeat(4,1fr)]">
            <div className="col-span-2 md:col-span-1">
              <span className="inline-flex items-center gap-2 leading-none">
                <LogoMark size={28} />
                <span className="font-display text-[1.28rem] font-semibold tracking-[-0.045em]">
                  1DayAPI
                </span>
              </span>
              <p className="mt-[18px] max-w-[280px] text-sm leading-relaxed text-on-surface-variant">
                {t("footer.blurb")}
              </p>
              <div className="mt-5 flex gap-2">
                <a
                  href="https://1DayAPI.com"
                  className="inline-flex h-10 w-10 items-center justify-center rounded-md text-on-surface-variant transition-colors hover:text-primary"
                  style={{ border: "1px solid var(--outline-variant)" }}
                  aria-label="X"
                >
                  <XLogoIcon />
                </a>
              </div>
            </div>
            <FooterCol
              title={t("footer.product")}
              links={[
                { to: "/models", label: t("footer.models") },
                { to: "/pricing", label: t("footer.pricing") },
                { to: "/tools/claude-api-cost-calculator", label: t("footer.calculator") },
                { to: "/provider", label: t("footer.provider") },
              ]}
            />
            <FooterCol
              title={t("footer.developers")}
              links={[
                { to: "/docs", label: t("footer.docs") },
                { to: "/docs/endpoints", label: t("footer.endpoints") },
                { to: "/console", label: t("nav.dashboard") },
              ]}
            />
            <FooterCol
              title={t("footer.earn")}
              links={[
                { to: "/provider", label: t("footer.provider") },
                { to: "/login", label: t("nav.getStarted") },
              ]}
            />
            <FooterCol
              title={t("footer.trust")}
              links={[
                { to: "/tools/verify", label: t("footer.verify") },
                { to: "/docs", label: t("footer.docs") },
              ]}
            />
          </div>
          <div
            className="mt-14 flex flex-wrap items-center justify-between gap-3 pt-7"
            style={{ borderTop: "1px solid var(--outline-variant)" }}
          >
            <span className="text-[13px] text-on-surface-faint">
              {t("footer.copyright")}
            </span>
            <span className="inline-flex items-center gap-2 font-mono text-xs text-on-surface-faint">
              <span
                className="wk-live-dot inline-block h-[7px] w-[7px] rounded-full"
                style={{ background: "var(--success)" }}
              />
              {t("footer.status")}
            </span>
          </div>
        </div>
      </footer>

      <Link
        to="/docs"
        aria-label="Support"
        className="fixed bottom-3 right-3 z-40 flex h-11 w-11 items-center justify-center rounded-full bg-primary text-on-primary shadow-lg transition-colors hover:bg-primary-press active:scale-95 sm:bottom-5 sm:right-5 sm:h-14 sm:w-14"
      >
        <HeadsetIcon className="h-6 w-6" />
      </Link>
    </div>
  );
}

function FooterCol({
  title,
  links,
}: {
  title: string;
  links: { to: string; label: string }[];
}) {
  return (
    <div>
      <div className="mb-4 font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-on-surface-faint">
        {title}
      </div>
      <ul className="grid gap-[11px]">
        {links.map((l) => (
          <li key={l.label}>
            <Link
              to={l.to}
              className="text-[13.5px] text-on-surface-variant transition-colors hover:text-on-surface"
            >
              {l.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
