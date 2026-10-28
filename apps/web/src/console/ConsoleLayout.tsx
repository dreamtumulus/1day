import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, Navigate, Outlet, useLocation, useNavigate } from "react-router-dom";
import {
  BellIcon,
  BookIcon,
  ChartIcon,
  CloseIcon,
  CubeIcon,
  GlobeIcon,
  GridIcon,
  KeyIcon,
  LockIcon,
  LogoMark,
  MenuIcon,
  MoonIcon,
  PlugIcon,
  RocketIcon,
  ScaleIcon,
  ShieldIcon,
  SparkleIcon,
  SunIcon,
  SwapIcon,
  TerminalIcon,
  WalletIcon,
} from "../components/Icon";
import { useT } from "../i18n";
import { apiFetch, unwrap, type Role } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useTheme } from "../theme";
import { useCT } from "./i18n";
import { ToastProvider } from "./ui";

interface NavItem {
  to: string;
  label: string;
  icon: (p: { className?: string }) => ReactNode;
  end?: boolean;
}

interface NavSection {
  title?: string;
  items: NavItem[];
}

export function menuFor(role: Role): NavSection[] {
  const userItems: NavItem[] = [
    { to: "/console/keys", label: "nav.keys", icon: KeyIcon },
    { to: "/console/usage", label: "nav.usage", icon: ChartIcon },
  ];
  if (role === "admin") {
    return [
      {
        title: "nav.section.manage",
        items: [
          { to: "/console", label: "nav.dashboard", icon: GridIcon, end: true },
          { to: "/console/admin/finance", label: "nav.finance", icon: WalletIcon },
          { to: "/console/admin/users", label: "nav.users", icon: ShieldIcon },
          { to: "/console/admin/keys", label: "nav.allKeys", icon: LockIcon },
          { to: "/console/admin/groups", label: "nav.groups", icon: CubeIcon },
          { to: "/console/admin/accounts", label: "nav.accounts", icon: PlugIcon },
          { to: "/console/admin/onboard", label: "nav.onboard", icon: RocketIcon },
          { to: "/console/admin/models", label: "nav.pricing", icon: ScaleIcon },
          { to: "/console/admin/redeem", label: "nav.redeem", icon: SparkleIcon },
          { to: "/console/admin/usage", label: "nav.allUsage", icon: ChartIcon },
          { to: "/console/admin/errors", label: "nav.errors", icon: BellIcon },
          { to: "/console/admin/nodes", label: "nav.nodes", icon: TerminalIcon },
        ],
      },
      { title: "nav.section.mine", items: userItems },
      { title: "nav.section.system", items: [{ to: "/console/admin/settings", label: "nav.settings", icon: SwapIcon }] },
    ];
  }
  if (role === "ops") {
    // 账号管理员: watch the subscription pool, re-authorize revoked accounts, onboard. Nothing else.
    return [
      {
        title: "nav.section.ops",
        items: [
          { to: "/console/admin/accounts", label: "nav.accounts", icon: PlugIcon },
          { to: "/console/admin/onboard", label: "nav.onboard", icon: RocketIcon },
        ],
      },
    ];
  }
  if (role === "provider") {
    return [
      {
        items: [
          { to: "/console", label: "nav.overview", icon: GridIcon, end: true },
          { to: "/console/nodes", label: "nav.nodes", icon: TerminalIcon },
          { to: "/console/accounts", label: "nav.accounts", icon: PlugIcon },
          { to: "/console/provider/onboard", label: "nav.onboard", icon: KeyIcon },
          { to: "/console/earnings", label: "nav.earnings", icon: ChartIcon },
          { to: "/console/settlements", label: "nav.settlements", icon: WalletIcon },
          { to: "/console/guide", label: "nav.guide", icon: RocketIcon },
        ],
      },
    ];
  }
  return [
    {
      items: [
        { to: "/console", label: "nav.overview", icon: GridIcon, end: true },
        ...userItems,
        { to: "/console/wallet", label: "nav.wallet", icon: WalletIcon },
        { to: "/console/models", label: "nav.models", icon: CubeIcon },
        { to: "/console/guide", label: "nav.guide", icon: RocketIcon },
      ],
    },
  ];
}

function SideNav({ role, onNavigate }: { role: Role; onNavigate?: () => void }) {
  const { t } = useCT();
  return (
    <nav className="flex flex-col gap-5">
      {menuFor(role).map((sec, i) => (
        <div key={i}>
          {sec.title && (
            <div className="mb-2 px-3 font-mono text-[10.5px] font-semibold uppercase tracking-[0.14em] text-on-surface-faint">
              {t(sec.title)}
            </div>
          )}
          <ul className="flex flex-col gap-0.5">
            {sec.items.map((it) => (
              <li key={it.to}>
                <NavLink
                  to={it.to}
                  end={it.end}
                  onClick={onNavigate}
                  className={({ isActive }) =>
                    `flex items-center gap-2.5 rounded-md px-3 py-2 text-[14px] transition-colors ${
                      isActive
                        ? "bg-primary-soft font-semibold text-primary"
                        : "font-medium text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    }`
                  }
                >
                  <it.icon className="h-[18px] w-[18px] shrink-0" />
                  {t(it.label)}
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function Announcement() {
  const [text, setText] = useState<string>("");
  const [hidden, setHidden] = useState(false);
  const { t } = useCT();
  useEffect(() => {
    apiFetch<unknown>("/api/site")
      .then((b) => setText(unwrap<{ announcement: string }>(b).announcement ?? ""))
      .catch(() => {});
  }, []);
  if (!text || hidden) return null;
  return (
    <div
      className="mb-6 flex items-start gap-3 rounded-lg px-4 py-3 text-sm"
      style={{ background: "var(--primary-soft)", border: "1px solid var(--accent-line)" }}
    >
      <BellIcon className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
      <div className="min-w-0 flex-1 whitespace-pre-wrap leading-relaxed text-on-surface">
        <span className="mr-2 font-semibold text-primary">{t("shell.announcement")}</span>
        {text}
      </div>
      <button type="button" onClick={() => setHidden(true)} className="text-on-surface-faint hover:text-on-surface" aria-label="close">
        <CloseIcon className="h-4 w-4" />
      </button>
    </div>
  );
}

export function ConsoleLayout() {
  const { me, loading, logout } = useAuth();
  const { t } = useCT();
  const { lang, setLang } = useT();
  const { theme, toggle } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();
  const [drawer, setDrawer] = useState(false);

  useEffect(() => setDrawer(false), [location.pathname]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-on-surface-faint">
        <LogoMark size={36} />
      </div>
    );
  }
  if (!me) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />;

  const brand = (
    <Link to="/console" className="flex items-center gap-2 leading-none">
      <LogoMark size={26} />
      <span className="font-display text-[1.15rem] font-semibold tracking-[-0.045em]">1DayAPI</span>
      <span className="ml-1 hidden whitespace-nowrap rounded-xs px-1.5 py-0.5 font-mono text-[10px] sm:inline font-semibold uppercase tracking-wider text-on-surface-faint" style={{ border: "1px solid var(--outline-variant)" }}>
        {t("shell.console")}
      </span>
    </Link>
  );

  const sidebar = (onNavigate?: () => void) => (
    <div className="flex h-full flex-col gap-6 px-3 pb-4 pt-5">
      <div className="px-2">{brand}</div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1">
        <SideNav role={me.role} onNavigate={onNavigate} />
      </div>
      <div className="flex flex-col gap-0.5 px-1">
        <Link to="/" className="flex items-center gap-2.5 rounded-md px-3 py-2 text-[13.5px] font-medium text-on-surface-variant hover:bg-surface-variant hover:text-on-surface">
          <BookIcon className="h-[17px] w-[17px]" />
          {t("shell.backToSite")}
        </Link>
      </div>
    </div>
  );

  return (
    <ToastProvider>
      <div className="min-h-screen bg-background text-on-surface">
        {/* desktop sidebar */}
        <aside
          className="fixed inset-y-0 left-0 z-40 hidden w-[248px] lg:block"
          style={{ background: "var(--surface-container-lowest)", borderRight: "1px solid var(--outline-variant)" }}
        >
          {sidebar()}
        </aside>

        {/* mobile drawer */}
        {drawer && (
          <div className="fixed inset-0 z-50 lg:hidden">
            <div className="absolute inset-0" style={{ background: "color-mix(in oklab, var(--inverse-surface) 45%, transparent)" }} onClick={() => setDrawer(false)} />
            <aside className="absolute inset-y-0 left-0 w-[264px] shadow-lg" style={{ background: "var(--surface-container-lowest)" }}>
              {sidebar(() => setDrawer(false))}
            </aside>
          </div>
        )}

        <div className="lg:pl-[248px]">
          <header
            className="sticky top-0 z-30 flex h-14 items-center gap-2 px-4 backdrop-blur-xl sm:px-6 lg:px-8"
            style={{ background: "color-mix(in oklab, var(--background) 82%, transparent)", borderBottom: "1px solid var(--outline-variant)" }}
          >
            <button
              type="button"
              className="inline-flex h-9 w-9 items-center justify-center rounded-md text-on-surface-variant hover:text-primary lg:hidden"
              onClick={() => setDrawer(true)}
              aria-label="Menu"
            >
              <MenuIcon className="h-6 w-6" />
            </button>
            <div className="lg:hidden">{brand}</div>
            <div className="flex-1" />
            <button
              type="button"
              className="inline-flex h-9 w-9 items-center justify-center rounded-md text-on-surface-variant hover:text-primary"
              onClick={() => setLang(lang === "en" ? "zh" : "en")}
              title={lang === "en" ? "中文" : "English"}
            >
              <GlobeIcon className="h-[18px] w-[18px]" />
            </button>
            <button
              type="button"
              className="inline-flex h-9 w-9 items-center justify-center rounded-md text-on-surface-variant hover:text-primary"
              onClick={toggle}
              aria-label="theme"
            >
              {theme === "dark" ? <SunIcon className="h-5 w-5" /> : <MoonIcon className="h-5 w-5" />}
            </button>
            <span className="mx-1 h-5 w-px bg-outline" />
            <button
              type="button"
              className="whitespace-nowrap rounded-md px-2.5 py-1.5 text-[14px] font-medium text-on-surface-variant hover:text-on-surface"
              onClick={() => void logout().then(() => navigate("/login"))}
            >
              {t("shell.logout")}
            </button>
          </header>
          <main className="mx-auto w-full max-w-[1320px] px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
            <Announcement />
            <Outlet />
          </main>
        </div>
      </div>
    </ToastProvider>
  );
}

/** Route guard inside the console: render children only for allowed roles. */
export function RoleGate({ roles, children }: { roles: Role[]; children: ReactNode }) {
  const { me } = useAuth();
  if (!me || !roles.includes(me.role)) return <Navigate to="/console" replace />;
  return <>{children}</>;
}
