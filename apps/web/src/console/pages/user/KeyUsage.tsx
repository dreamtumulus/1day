import { useMemo, useState } from "react";
import { apiFetch, listData, unwrap, type CatalogModel } from "../../../lib/api";
import type { Group } from "../../api";
import { useCT } from "../../i18n";
import { CodeBlock, CopyIconButton, Mono, Segmented, useAsync } from "../../ui";
import { allowedBy } from "./shared";

// "How to call" panel: base URL, endpoints, auth header formats and runnable
// samples pre-filled with a specific key and a model its group allows.

export function useApiBase(): string {
  const site = useAsync(async () => unwrap<{ apiBaseUrl: string }>(await apiFetch<unknown>("/api/site")), []);
  return (site.data?.apiBaseUrl || "https://api.1dayapi.com").replace(/\/+$/, "");
}

function useSampleModels(group: Group | null | undefined): { openai: string; anthropic: string } {
  const models = useAsync(async () => listData<CatalogModel>(await apiFetch<unknown>("/api/models")), []);
  return useMemo(() => {
    // Claude-only for now: sample models come from the anthropic catalog only.
    const allowed = (models.data ?? []).filter(
      (m) => m.vendor === "anthropic" && allowedBy(group?.modelAllowlist ?? null, m.modelId),
    );
    const first = allowed[0]?.modelId ?? "claude-opus-4-8";
    return { openai: first, anthropic: first };
  }, [models.data, group]);
}

type Sample = "curl-openai" | "curl-anthropic" | "python" | "node" | "claude-code";

export function KeyUsage({ apiKey, group }: { apiKey: string | null; group?: Group | null }) {
  const { t } = useCT();
  const base = useApiBase();
  const model = useSampleModels(group);
  const [sample, setSample] = useState<Sample>("curl-openai");
  const key = apiKey ?? "sk-1d-…";

  const endpoints: Array<[string, string, string]> = [
    ["OpenAI Chat Completions", `POST ${base}/v1/chat/completions`, `Authorization: Bearer ${key}`],
    ["Anthropic Messages", `POST ${base}/v1/messages`, `x-api-key: ${key}\nanthropic-version: 2023-06-01`],
    ["OpenAI Responses", `POST ${base}/v1/responses`, `Authorization: Bearer ${key}`],
    [t("user.usage.modelsList"), `GET ${base}/v1/models`, `Authorization: Bearer ${key}`],
  ];

  const code: Record<Sample, string> = {
    "curl-openai": `curl ${base}/v1/chat/completions \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${model.openai}",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": false
  }'`,
    "curl-anthropic": `curl ${base}/v1/messages \\
  -H "x-api-key: ${key}" \\
  -H "anthropic-version: 2023-06-01" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${model.anthropic}",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello"}]
  }'`,
    python: `# pip install openai
from openai import OpenAI

client = OpenAI(base_url="${base}/v1", api_key="${key}")
resp = client.chat.completions.create(
    model="${model.openai}",
    messages=[{"role": "user", "content": "Hello"}],
)
print(resp.choices[0].message.content)`,
    node: `// npm i openai
import OpenAI from "openai";

const client = new OpenAI({ baseURL: "${base}/v1", apiKey: "${key}" });
const resp = await client.chat.completions.create({
  model: "${model.openai}",
  messages: [{ role: "user", content: "Hello" }],
});
console.log(resp.choices[0].message.content);`,
    "claude-code": `export ANTHROPIC_BASE_URL="${base}"
export ANTHROPIC_AUTH_TOKEN="${key}"
export ANTHROPIC_MODEL="${model.anthropic}"
claude`,
  };

  return (
    <div className="space-y-5">
      <div>
        <div className="label">{t("user.usage.baseUrl")}</div>
        <div className="flex items-center gap-2 rounded-md px-3 py-2" style={{ border: "1px solid var(--outline)" }}>
          <code className="min-w-0 flex-1 break-all font-mono text-[13px]">{base}</code>
          <CopyIconButton text={base} />
        </div>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-on-surface-faint">{t("user.usage.baseUrlHint", { base })}</p>
      </div>

      <div>
        <div className="label">{t("user.usage.endpoints")}</div>
        <div className="overflow-hidden rounded-md" style={{ border: "1px solid var(--outline-variant)" }}>
          {endpoints.map(([name, url, auth], i) => (
            <div
              key={name}
              className="grid gap-1 px-3 py-2.5 sm:grid-cols-[170px_1fr]"
              style={i ? { borderTop: "1px solid var(--outline-variant)" } : undefined}
            >
              <div className="text-[13px] font-medium text-on-surface">{name}</div>
              <div className="min-w-0 space-y-0.5">
                <div className="flex items-center gap-1">
                  <Mono>{url}</Mono>
                  <CopyIconButton text={url.replace(/^(GET|POST) /, "")} />
                </div>
                <div className="whitespace-pre-wrap break-all font-mono text-[12px] text-on-surface-faint">{auth}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <span className="label !mb-0">{t("user.usage.samples")}</span>
          <Segmented<Sample>
            value={sample}
            onChange={setSample}
            options={[
              { value: "curl-openai", label: "curl · OpenAI" },
              { value: "curl-anthropic", label: "curl · Anthropic" },
              { value: "python", label: "Python" },
              { value: "node", label: "Node.js" },
              { value: "claude-code", label: "Claude Code" },
            ]}
          />
        </div>
        <CodeBlock code={code[sample]} />
        {group?.modelAllowlist?.enabled && (
          <p className="mt-2 text-[12.5px] text-on-surface-faint">
            {t("user.usage.groupModels", { group: group.name, models: group.modelAllowlist.models.join(", ") })}
          </p>
        )}
      </div>
    </div>
  );
}
