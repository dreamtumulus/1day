import { useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch, unwrap } from "../../../lib/api";
import { useCT } from "../../i18n";
import { Card, CodeBlock, CopyButton, DataTable, Mono, PageHeader, Segmented, useAsync, type Column } from "../../ui";

type Sample = "curl-openai" | "curl-anthropic" | "python" | "claude-code" | "codex";

function samples(base: string): Record<Sample, string> {
  const v1 = `${base}/v1`;
  return {
    "curl-openai": `curl ${v1}/chat/completions \\
  -H "Authorization: Bearer $ONEDAY_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "claude-sonnet-5",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'`,
    "curl-anthropic": `curl ${v1}/messages \\
  -H "x-api-key: $ONEDAY_API_KEY" \\
  -H "anthropic-version: 2023-06-01" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "claude-sonnet-5",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'`,
    python: `from openai import OpenAI

client = OpenAI(
    base_url="${v1}",
    api_key="sk-1d-...",  # your 1DayAPI key
)

resp = client.chat.completions.create(
    model="gpt-5.5",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(resp.choices[0].message.content)`,
    "claude-code": `export ANTHROPIC_BASE_URL="${base}"
export ANTHROPIC_AUTH_TOKEN="sk-1d-..."
claude`,
    codex: `# ~/.codex/config.toml
model = "gpt-5.5"
model_provider = "oneday"

[model_providers.oneday]
name = "1DayAPI"
base_url = "${v1}"
env_key = "ONEDAY_API_KEY"
wire_api = "responses"`,
  };
}

interface EndpointRow {
  method: string;
  path: string;
  desc: string;
}

interface ErrRow {
  status: number;
  code: string;
  desc: string;
}

export function UserGuide() {
  const { t } = useCT();
  const site = useAsync(async () => unwrap<{ apiBaseUrl: string }>(await apiFetch<unknown>("/api/site")), []);
  const base = (site.data?.apiBaseUrl || "https://api.1dayapi.com").replace(/\/+$/, "");
  const [tab, setTab] = useState<Sample>("curl-openai");
  const code = samples(base);

  const endpoints: EndpointRow[] = [
    { method: "POST", path: "/v1/chat/completions", desc: t("user.guide.ep.chat") },
    { method: "POST", path: "/v1/messages", desc: t("user.guide.ep.messages") },
    { method: "POST", path: "/v1/responses", desc: t("user.guide.ep.responses") },
    { method: "GET", path: "/v1/models", desc: t("user.guide.ep.models") },
  ];
  const errors: ErrRow[] = [
    { status: 401, code: "invalid_api_key", desc: t("user.guide.err.invalid") },
    { status: 401, code: "key_disabled / key_expired", desc: t("user.guide.err.keyState") },
    { status: 402, code: "insufficient_balance", desc: t("user.guide.err.balance") },
    { status: 403, code: "model_not_allowed", desc: t("user.guide.err.notAllowed") },
    { status: 404, code: "model_not_found", desc: t("user.guide.err.notFound") },
    { status: 429, code: "quota_exhausted", desc: t("user.guide.err.quota") },
    { status: 429, code: "upstream_rate_limited", desc: t("user.guide.err.rateLimited") },
    { status: 503, code: "no_available_account", desc: t("user.guide.err.noAccount") },
  ];

  const epCols: Column<EndpointRow>[] = [
    { key: "m", header: "Method", render: (r) => <Mono>{r.method}</Mono> },
    { key: "p", header: "Path", render: (r) => <span className="font-mono text-[13px]">{r.path}</span> },
    { key: "d", header: t("common.details"), render: (r) => <span className="whitespace-normal text-on-surface-variant">{r.desc}</span> },
  ];
  const errCols: Column<ErrRow>[] = [
    { key: "s", header: "HTTP", render: (r) => <Mono>{r.status}</Mono> },
    { key: "c", header: "code", render: (r) => <span className="font-mono text-[13px]">{r.code}</span> },
    { key: "d", header: t("common.details"), render: (r) => <span className="whitespace-normal text-on-surface-variant">{r.desc}</span> },
  ];

  const steps = [t("user.guide.step1"), t("user.guide.step2"), t("user.guide.step3")];

  return (
    <>
      <PageHeader title={t("nav.guide")} desc={t("user.guide.desc")} />
      <div className="space-y-6">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {steps.map((s, i) => (
            <div key={i} className="card p-5">
              <div className="kicker">
                <span className="kicker-dot" />
                {t("user.guide.stepN", { n: i + 1 })}
              </div>
              <p className="mt-3 text-sm leading-relaxed text-on-surface">{s}</p>
            </div>
          ))}
        </div>

        <Card title={t("user.guide.baseUrl")} desc={t("user.guide.baseUrlDesc")}>
          <div className="space-y-3">
            {[
              [t("user.guide.openaiBase"), `${base}/v1`],
              [t("user.guide.anthropicBase"), base],
            ].map(([label, url]) => (
              <div key={label} className="flex flex-wrap items-center justify-between gap-3 rounded-md px-4 py-3" style={{ background: "var(--surface-variant)" }}>
                <div className="min-w-0">
                  <div className="text-[12.5px] text-on-surface-faint">{label}</div>
                  <code className="break-all font-mono text-[14px] text-on-surface">{url}</code>
                </div>
                <CopyButton text={url} />
              </div>
            ))}
            <p className="text-[13px] text-on-surface-variant">
              {t("user.guide.keyHint")}{" "}
              <Link to="/console/keys" className="font-medium text-primary hover:underline">
                {t("nav.keys")}
              </Link>
            </p>
          </div>
        </Card>

        <Card
          title={t("user.guide.examples")}
          actions={
            <Segmented<Sample>
              value={tab}
              onChange={setTab}
              options={[
                { value: "curl-openai", label: "OpenAI" },
                { value: "curl-anthropic", label: "Anthropic" },
                { value: "python", label: "Python" },
                { value: "claude-code", label: "Claude Code" },
                { value: "codex", label: "Codex" },
              ]}
            />
          }
        >
          <CodeBlock code={code[tab]} />
          <p className="mt-3 text-[13px] text-on-surface-variant">{t(`user.guide.note.${tab}`)}</p>
        </Card>

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <Card title={t("user.guide.endpoints")} bodyClassName="">
            <DataTable columns={epCols} rows={endpoints} rowKey={(r) => r.path} minWidth={520} />
          </Card>
          <Card title={t("user.guide.errors")} bodyClassName="">
            <DataTable columns={errCols} rows={errors} rowKey={(r) => `${r.status}-${r.code}`} minWidth={520} />
          </Card>
        </div>
      </div>
    </>
  );
}
