import { Link } from "react-router-dom";
import { CodeBlock } from "../components/CodeBlock";
import { ArrowRightIcon, BookIcon } from "../components/Icon";
import { useT } from "../i18n";

// On the production site point examples at the public gateway; elsewhere
// (local dev) keep the localhost default.
const gatewayBase =
  typeof window !== "undefined" && window.location.hostname.endsWith("1dayapi.com")
    ? "https://api.1dayapi.com"
    : "http://localhost:8400";

// Claude-only for now: samples use a Claude model even on the OpenAI-compatible
// endpoints (the gateway translates); other platforms are hidden site-wide.

const chatCurl = `curl ${gatewayBase}/v1/chat/completions \\
  -H "Authorization: Bearer sk-1d-..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "claude-opus-4-8",
    "messages": [{"role": "user", "content": "hello"}]
  }'`;

const responsesCurl = `curl ${gatewayBase}/v1/responses \\
  -H "Authorization: Bearer sk-1d-..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "claude-opus-4-8",
    "input": "hello"
  }'`;

const messagesCurl = `curl ${gatewayBase}/v1/messages \\
  -H "x-api-key: sk-1d-..." \\
  -H "anthropic-version: 2023-06-01" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "claude-opus-4-8",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "hello"}]
  }'`;

export function Docs() {
  const { t } = useT();

  return (
    <div className="container-x py-12 sm:py-16">
      <div className="kicker">
        <BookIcon width={14} height={14} className="leading-none text-primary" />
        {t("footer.docs")}
      </div>
      <h1 className="mt-4 font-display text-[34px] font-bold leading-[1.05] tracking-[-0.03em] text-on-surface sm:text-[52px]">
        {t("docs.title")}
      </h1>
      <p className="mt-4 max-w-[560px] text-base leading-relaxed text-on-surface-variant sm:text-[17px]">
        {t("docs.sub")}
      </p>

      <section className="mt-12">
        <h2 className="font-display text-[24px] font-bold tracking-[-0.02em] text-on-surface">
          {t("docs.quickstart")}
        </h2>
        <p className="mt-3 max-w-3xl leading-relaxed text-on-surface-variant">
          {t("docs.quickstartBody")}
        </p>
        <CodeBlock
          className="mt-4 max-w-3xl"
          title="base_url"
          code={`base_url = "${gatewayBase}/v1"`}
        />
        <div className="mt-4">
          <Link
            to="/docs/endpoints"
            className="inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline"
          >
            {t("docs.endpointsLink")}
            <ArrowRightIcon width={16} height={16} />
          </Link>
        </div>
      </section>

      <section className="mt-12 grid gap-8">
        <div>
          <h3 className="font-display text-lg font-bold text-on-surface">
            {t("docs.chatTitle")}
          </h3>
          <CodeBlock className="mt-3" title="curl" code={chatCurl} />
        </div>
        <div>
          <h3 className="font-display text-lg font-bold text-on-surface">
            {t("docs.responsesTitle")}
          </h3>
          <CodeBlock className="mt-3" title="curl" code={responsesCurl} />
        </div>
        <div>
          <h3 className="font-display text-lg font-bold text-on-surface">
            {t("docs.messagesTitle")}
          </h3>
          <CodeBlock className="mt-3" title="curl" code={messagesCurl} />
          <p className="mt-2 text-sm text-on-surface-variant">{t("docs.messagesNote")}</p>
        </div>
      </section>

      <section className="mt-12">
        <h2 className="font-display text-[24px] font-bold tracking-[-0.02em] text-on-surface">
          {t("docs.errorsTitle")}
        </h2>
        <p className="mt-3 max-w-3xl leading-relaxed text-on-surface-variant">
          {t("docs.errorsBody")}
        </p>
        <CodeBlock
          className="mt-4 max-w-xl"
          code='{"error":{"code":"insufficient_balance","message":"Wallet balance is zero","type":"billing_error"}}'
        />
      </section>
    </div>
  );
}
