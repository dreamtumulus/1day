import { useState } from "react";
import { useT } from "../i18n";
import { CheckIcon, CopyIcon } from "./Icon";

export function CodeBlock({
  code,
  title,
  className = "",
}: {
  code: string;
  title?: string;
  className?: string;
}) {
  const { t } = useT();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = code;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div
      className={`overflow-hidden rounded-lg ${className}`}
      style={{ background: "var(--code-bg)", border: "1px solid var(--outline-variant)" }}
    >
      {title && (
        <div
          className="flex items-center justify-between px-4 py-2"
          style={{ borderBottom: "1px solid color-mix(in oklab, var(--code-fg) 12%, transparent)" }}
        >
          <span className="font-mono text-xs text-code-fg opacity-60">{title}</span>
          <button
            type="button"
            onClick={copy}
            className="inline-flex items-center gap-1 font-mono text-xs text-code-fg opacity-60 transition-opacity hover:opacity-100"
          >
            {copied ? <CheckIcon width={14} height={14} /> : <CopyIcon width={14} height={14} />}
            {copied ? t("common.copied") : t("common.copy")}
          </button>
        </div>
      )}
      <pre className="overflow-x-auto p-4 text-[13px] leading-relaxed text-code-fg">
        <code className="font-mono">{code}</code>
      </pre>
    </div>
  );
}
