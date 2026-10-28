import { useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { AuthShell } from "../components/AuthShell";
import { KeyIcon } from "../components/Icon";
import { useT } from "../i18n";
import { ApiError, apiFetch } from "../lib/api";
import { roleFromKey, useAuth, type Role } from "../lib/auth";

const roleBadgeStyle: Record<Role, { background: string; color: string }> = {
  admin: { background: "var(--error-container)", color: "var(--error)" },
  consumer: { background: "var(--success-container)", color: "var(--success)" },
  provider: { background: "var(--info-container)", color: "var(--info)" },
  ops: { background: "var(--warning-container)", color: "var(--warning)" },
};

export function RoleBadge({ role }: { role: Role | string }) {
  const { t } = useT();
  const style = roleBadgeStyle[role as Role] ?? {
    background: "var(--surface-variant)",
    color: "var(--on-surface-variant)",
  };
  return (
    <span
      className="inline-flex items-center rounded-pill px-2.5 py-0.5 font-mono text-[11px] font-bold"
      style={style}
    >
      {t(`role.${role}`) !== `role.${role}` ? t(`role.${role}`) : role}
    </span>
  );
}

export function Login() {
  const { t } = useT();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { refresh } = useAuth();
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const detected = roleFromKey(key.trim());
  const next = params.get("next") || "/console";

  async function loginWith(k: string) {
    setError(null);
    setBusy(true);
    try {
      await apiFetch("/auth/login", {
        method: "POST",
        body: JSON.stringify({ key: k }),
      });
      await refresh();
      navigate(next);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("common.consoleDown"));
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    void loginWith(key.trim());
  }

  return (
    <AuthShell title={t("auth.loginTitle")}>
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label className="label">{t("auth.keyLabel")}</label>
          <div className="relative">
            <KeyIcon
              width={16}
              height={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-faint"
            />
            <input
              className="input pl-9 font-mono text-[13px]"
              required
              autoFocus
              autoComplete="off"
              spellCheck={false}
              placeholder={t("auth.keyPlaceholder")}
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
          </div>
          {key.trim() && (
            <div className="mt-2">
              {key.trim().startsWith("sk-1d-") ? (
                <span className="text-[13px]" style={{ color: "var(--warning)" }}>{t("auth.apiKeyNotLogin")}</span>
              ) : detected ? (
                <RoleBadge role={detected} />
              ) : (
                <span
                  className="inline-flex items-center rounded-pill px-2.5 py-0.5 font-mono text-[11px] font-bold"
                  style={{ background: "var(--warning-container)", color: "var(--warning)" }}
                >
                  {t("auth.invalidPrefix")}
                </span>
              )}
            </div>
          )}
        </div>
        {error && <p className="text-sm" style={{ color: "var(--error)" }}>{error}</p>}
        <button type="submit" className="wk-btn wk-btn-md wk-btn-primary w-full" disabled={busy}>
          {busy ? t("common.loading") : t("auth.loginButton")}
        </button>
      </form>

      <div
        className="mt-6 pt-5"
        style={{ borderTop: "1px solid var(--outline-variant)" }}
      >
        <p className="text-sm font-semibold text-on-surface">{t("auth.noKeyTitle")}</p>
        <p className="mt-1 text-sm text-on-surface-variant">{t("auth.noKeyDesc")}</p>

      </div>
    </AuthShell>
  );
}
