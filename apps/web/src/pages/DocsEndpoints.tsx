import type { ReactNode } from "react";
import { useT } from "../i18n";

const gatewayRows: { method: string; path: string; key: string }[] = [
  { method: "POST", path: "/v1/chat/completions", key: "chat" },
  { method: "POST", path: "/v1/responses", key: "responses" },
  { method: "POST", path: "/v1/messages", key: "messages" },
  { method: "POST", path: "/v1/images/generations", key: "images" },
  { method: "POST", path: "/v1/videos", key: "videos" },
  { method: "GET", path: "/v1/models", key: "models" },
  { method: "GET", path: "/v1/models/pricing", key: "pricing" },
  { method: "GET", path: "/health", key: "health" },
];

const consoleRows = [
  { method: "POST", path: "/auth/login", notes: "{key: 1dk_…} → session cookie" },
  { method: "POST", path: "/auth/logout", notes: "clears session" },
  { method: "GET", path: "/auth/me", notes: "{id, role, name, keyPreview, balanceUsd} or 401" },
  { method: "GET", path: "/api/models", notes: "public catalog" },
  { method: "GET", path: "/api/models/pricing", notes: "public pricing" },
  { method: "GET", path: "/api/site", notes: "announcement + API base URL" },
  { method: "GET", path: "/api/user/keys", notes: "user: list API keys (POST to create, PATCH/DELETE /:id)" },
  { method: "GET", path: "/api/user/usage", notes: "user: paged request log (+ /stats)" },
  { method: "POST", path: "/api/user/redeem", notes: "user: redeem a code into the balance" },
  { method: "GET", path: "/api/provider/accounts", notes: "provider: my upstream accounts (POST to submit)" },
  { method: "GET", path: "/api/provider/earnings", notes: "provider: per-request earnings" },
  { method: "POST", path: "/api/provider/bind-codes", notes: "provider: node binding code" },
  { method: "GET", path: "/api/admin/users", notes: "admin: users (create / adjust balance / payout / reset key)" },
  { method: "GET", path: "/api/admin/accounts", notes: "admin: upstream accounts (create / review / test)" },
  { method: "GET", path: "/api/admin/groups", notes: "admin: groups, rate multipliers, model allowlists" },
  { method: "POST", path: "/api/admin/redeem-codes", notes: "admin: generate redeem codes" },
  { method: "GET", path: "/api/admin/usage", notes: "admin: all request logs (+ /stats)" },
];

export function DocsEndpoints() {
  const { t } = useT();

  return (
    <div className="container-x py-12 sm:py-16">
      <h1 className="font-display text-[34px] font-bold leading-[1.05] tracking-[-0.03em] text-on-surface sm:text-[52px]">
        {t("endpoints.title")}
      </h1>
      <p className="mt-4 max-w-[560px] text-base leading-relaxed text-on-surface-variant sm:text-[17px]">
        {t("endpoints.sub")}
      </p>

      <section className="mt-12">
        <h2 className="font-display text-[24px] font-bold tracking-[-0.02em] text-on-surface">
          {t("endpoints.gateway")}
        </h2>
        <p className="mt-1 font-mono text-xs text-on-surface-faint">
          {t("endpoints.authNote")}
        </p>
        <EndpointTable
          head={[t("endpoints.colEndpoint"), t("endpoints.colNotes")]}
          rows={gatewayRows.map((r) => [
            <span key="p" className="inline-flex items-center gap-2.5">
              <MethodBadge method={r.method} />
              <span className="font-mono text-[13px]">{r.path}</span>
            </span>,
            t(`endpoints.rows.${r.key}`),
          ])}
        />
      </section>

      <section className="mt-12">
        <h2 className="font-display text-[24px] font-bold tracking-[-0.02em] text-on-surface">
          {t("endpoints.console")}
        </h2>
        <EndpointTable
          head={[t("endpoints.colEndpoint"), t("endpoints.colNotes")]}
          rows={consoleRows.map((r) => [
            <span key="p" className="inline-flex items-center gap-2.5">
              <MethodBadge method={r.method} />
              <span className="font-mono text-[13px]">{r.path}</span>
            </span>,
            r.notes,
          ])}
        />
      </section>
    </div>
  );
}

function MethodBadge({ method }: { method: string }) {
  const style =
    method === "GET"
      ? { background: "var(--success-container)", color: "var(--success)" }
      : method === "DELETE"
        ? { background: "var(--error-container)", color: "var(--error)" }
        : { background: "var(--primary-soft)", color: "var(--primary)" };
  return (
    <span
      className="inline-flex items-center rounded-xs px-2 py-0.5 font-mono text-[11px] font-bold"
      style={style}
    >
      {method}
    </span>
  );
}

function EndpointTable({ head, rows }: { head: string[]; rows: [ReactNode, string][] }) {
  return (
    <div
      className="mt-4 overflow-hidden rounded-lg bg-surface-container-lowest shadow-sm"
      style={{ border: "1px solid var(--outline-variant)" }}
    >
      <div className="overflow-x-auto">
        <table className="wk-table">
          <thead>
            <tr>
              {head.map((h) => (
                <th key={h} className="ta-l">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(([a, b], i) => (
              <tr key={i}>
                <td className="ta-l whitespace-nowrap">{a}</td>
                <td className="ta-l whitespace-normal text-[13.5px] text-on-surface-variant">
                  {b}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
