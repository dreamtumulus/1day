import { useState } from "react";
import { ShieldIcon } from "../components/Icon";
import { useT } from "../i18n";

interface TeeProof {
  upstream_host?: string;
  body_sha256?: string;
  signature?: string;
  algo?: string;
  [k: string]: unknown;
}

type ParseResult =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "ok"; proof: TeeProof };

function parseProof(input: string): ParseResult {
  const trimmed = input.trim();
  if (!trimmed) return { kind: "none" };

  // SSE: find `event: tee.proof` and take the following `data:` line(s).
  const lines = trimmed.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (/^event:\s*tee\.proof/.test(lines[i])) {
      let data = "";
      for (let j = i + 1; j < lines.length; j++) {
        if (/^data:\s*/.test(lines[j])) {
          data += lines[j].replace(/^data:\s*/, "");
        } else if (lines[j].trim() === "") {
          if (data) break;
        } else {
          break;
        }
      }
      try {
        return { kind: "ok", proof: JSON.parse(data) as TeeProof };
      } catch {
        return { kind: "invalid" };
      }
    }
  }

  // Raw JSON paste of the proof object itself.
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    const proof =
      obj && typeof obj === "object" && obj.tee_proof
        ? (obj.tee_proof as TeeProof)
        : (obj as TeeProof);
    if (proof && (proof.body_sha256 || proof.signature || proof.upstream_host)) {
      return { kind: "ok", proof };
    }
  } catch {
    /* fall through */
  }
  return { kind: "none" };
}

async function hmacSha256Hex(keyBytes: Uint8Array<ArrayBuffer>, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function keyToBytes(raw: string): Uint8Array<ArrayBuffer> {
  const hex = raw.trim();
  if (/^[0-9a-fA-F]+$/.test(hex) && hex.length % 2 === 0) {
    const out = new Uint8Array(new ArrayBuffer(hex.length / 2));
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  return new TextEncoder().encode(raw);
}

export function Verify() {
  const { t } = useT();
  const [input, setInput] = useState("");
  const [result, setResult] = useState<ParseResult | null>(null);
  const [hmacKey, setHmacKey] = useState("");
  const [hmacResult, setHmacResult] = useState<"match" | "mismatch" | null>(null);
  const [hmacError, setHmacError] = useState<string | null>(null);

  function parse() {
    setResult(parseProof(input));
    setHmacResult(null);
    setHmacError(null);
  }

  async function verifyHmac(proof: TeeProof) {
    setHmacError(null);
    setHmacResult(null);
    if (!hmacKey.trim()) {
      setHmacError(t("verify.keyRequired"));
      return;
    }
    if (!proof.upstream_host || !proof.body_sha256 || !proof.signature) return;
    try {
      const computed = await hmacSha256Hex(keyToBytes(hmacKey), `${proof.upstream_host}:${proof.body_sha256}`);
      setHmacResult(
        computed.toLowerCase() === proof.signature.toLowerCase() ? "match" : "mismatch",
      );
    } catch {
      setHmacError(t("common.error"));
    }
  }

  return (
    <div className="container-x max-w-3xl py-12 sm:py-16">
      <div className="kicker">
        <ShieldIcon width={14} height={14} className="leading-none text-primary" />
        {t("nav.verify")}
      </div>
      <h1 className="mt-4 font-display text-[34px] font-bold leading-[1.05] tracking-[-0.03em] text-on-surface sm:text-[52px]">
        {t("verify.title")}
      </h1>
      <p className="mt-4 max-w-[560px] text-base leading-relaxed text-on-surface-variant sm:text-[17px]">
        {t("verify.sub")}
      </p>

      <div
        className="mt-6 flex gap-3 rounded-lg p-4"
        style={{ background: "var(--warning-container)", border: "1px solid var(--warning)" }}
      >
        <ShieldIcon className="mt-0.5 shrink-0" style={{ color: "var(--warning)" }} />
        <div>
          <p className="text-sm font-semibold" style={{ color: "var(--warning)" }}>
            {t("verify.stubTitle")}
          </p>
          <p className="mt-1 text-sm text-on-surface-variant">{t("verify.stubBody")}</p>
        </div>
      </div>

      <label className="label mt-8">{t("verify.inputLabel")}</label>
      <textarea
        className="input h-48 font-mono text-xs"
        placeholder={t("verify.inputPlaceholder")}
        value={input}
        onChange={(e) => setInput(e.target.value)}
      />
      <div className="mt-3 flex gap-2">
        <button type="button" className="wk-btn wk-btn-md wk-btn-primary" onClick={parse}>
          {t("verify.parse")}
        </button>
        <button
          type="button"
          className="wk-btn wk-btn-md wk-btn-ghost"
          onClick={() => {
            setInput("");
            setResult(null);
            setHmacResult(null);
            setHmacError(null);
          }}
        >
          {t("verify.clear")}
        </button>
      </div>

      {result && (
        <div className="mt-6">
          {result.kind === "none" && (
            <p className="text-sm text-on-surface-variant">{t("verify.notFound")}</p>
          )}
          {result.kind === "invalid" && (
            <p className="text-sm" style={{ color: "var(--warning)" }}>
              {t("verify.invalid")}
            </p>
          )}
          {result.kind === "ok" && (
            <div className="card p-5 sm:p-6">
              <span className="pill-save">{t("verify.found")}</span>
              <dl className="mt-4 space-y-3">
                <ProofRow label={t("verify.fieldHost")} value={result.proof.upstream_host} />
                <ProofRow label={t("verify.fieldSha")} value={result.proof.body_sha256} mono />
                <ProofRow label={t("verify.fieldSig")} value={result.proof.signature} mono />
                <ProofRow label={t("verify.fieldAlgo")} value={result.proof.algo} />
              </dl>

              <div
                className="mt-6 pt-4"
                style={{ borderTop: "1px solid var(--outline-variant)" }}
              >
                <h3 className="text-sm font-semibold text-on-surface">{t("verify.advTitle")}</h3>
                <p className="mt-1 text-xs text-on-surface-variant">{t("verify.advBody")}</p>
                <label className="label mt-3">{t("verify.keyLabel")}</label>
                <input
                  className="input font-mono text-xs"
                  value={hmacKey}
                  onChange={(e) => setHmacKey(e.target.value)}
                />
                <button
                  type="button"
                  className="wk-btn wk-btn-sm wk-btn-ghost mt-3"
                  onClick={() => void verifyHmac(result.proof)}
                >
                  {t("verify.verify")}
                </button>
                {hmacError && (
                  <p className="mt-2 text-sm" style={{ color: "var(--warning)" }}>
                    {hmacError}
                  </p>
                )}
                {hmacResult === "match" && (
                  <p className="mt-2 text-sm font-semibold" style={{ color: "var(--success)" }}>
                    {t("verify.match")}
                  </p>
                )}
                {hmacResult === "mismatch" && (
                  <p className="mt-2 text-sm font-semibold" style={{ color: "var(--error)" }}>
                    {t("verify.mismatch")}
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ProofRow({ label, value, mono }: { label: string; value?: string; mono?: boolean }) {
  return (
    <div>
      <dt className="font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-on-surface-faint">
        {label}
      </dt>
      <dd
        className={`mt-0.5 break-all text-sm text-on-surface ${mono ? "font-mono text-xs" : ""}`}
      >
        {value ?? "—"}
      </dd>
    </div>
  );
}
