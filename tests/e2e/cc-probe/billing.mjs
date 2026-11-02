// Billing-suffix probe (`x-anthropic-billing-header: cc_version=<ver>.<3hex>`).
// Algorithm taken verbatim from the shipped client code (read-only):
//   CC 2.1.316 payload module: `var eF="59cf53e54c78"; function $f(e,n){let s=[4,7,20].map(i=>e[i]||"0").join(""),h=`${eF}${s}${n}`; sha256(h).slice(0,3)}`
//   CC 2.1.312 payload module: identical
//   CC 2.1.301 binary:        embedded JS `var XB="59cf53e54c78" … .VERSION)}` — identical salt/positions/version input
// Same constants as packages/core/src/fingerprint.ts#ccBuildSuffix (probe-side re-implementation; production code untouched).
// Structure only: suffix, 3 chars, first-user-text length + digest — never the prompt text.
import { createHash } from "node:crypto";

export const BILLING_SALT = "59cf53e54c78";
export const BILLING_POSITIONS = [4, 7, 20];

const blockText = (b) => (typeof b === "string" ? b : b?.type === "text" ? String(b.text ?? "") : "");

/** First non-meta user message's first non-reminder text block — exactly what the client hashes.
 *  CC computes the header from `messagesPreNormalize`, i.e. *before* injected `<system-reminder>` attachments
 *  are merged into the first user message; fingerprint.ts skips those blocks for the same reason. */
export function firstUserText(messages) {
  if (!Array.isArray(messages)) return "";
  const m = messages.find((x) => x && typeof x === "object" && (x.role === "user" || x.type === "user") && x.isMeta !== true);
  if (!m) return "";
  const c = m.content ?? m.message?.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  const t = c.find((b) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string" && !b.text.trimStart().startsWith("<system-reminder>"));
  return t?.text ?? "";
}

export function ccBuildSuffix(messages, version) {
  const text = firstUserText(messages);
  const chars = BILLING_POSITIONS.map((i) => text[i] ?? "0").join("");
  return createHash("sha256").update(`${BILLING_SALT}${chars}${version}`).digest("hex").slice(0, 3);
}

/** Compare the observed system[0] billing suffix with the recomputed one for `version`. */
export function billingProbe(body, version) {
  const sys = Array.isArray(body?.system) ? body.system : body?.system !== undefined ? [body.system] : [];
  const line = blockText(sys[0]);
  const m = line.match(/cc_version=(\d+\.\d+\.\d+)\.([0-9a-z]+)/);
  const text = firstUserText(body?.messages);
  const chars = BILLING_POSITIONS.map((i) => text[i] ?? "0").join("");
  const computed = createHash("sha256").update(`${BILLING_SALT}${chars}${version}`).digest("hex").slice(0, 3);
  return {
    system0IsBillingHeader: line.startsWith("x-anthropic-billing-header"),
    headerVersion: m?.[1] ?? null,
    observedSuffix: m?.[2] ?? null,
    computedSuffix: computed,
    match: m ? m[2] === computed : null,
    algorithmMatchesVersion: m ? m[1] === version : null,
    firstUserTextLen: text.length,
    firstUserTextDigest: createHash("sha256").update(text).digest("hex").slice(0, 16),
    chars,
  };
}

/** Fold per-request billing probes into one summary line per profile. */
export function summarizeBilling(probes, version) {
  const hits = probes.filter((p) => p?.system0IsBillingHeader);
  const matched = hits.filter((p) => p.match === true).length;
  const mismatched = hits.filter((p) => p.match === false);
  return {
    checked: hits.length,
    matched,
    mismatched: mismatched.length,
    matchRate: hits.length ? `${matched}/${hits.length}` : null,
    headerVersionOk: hits.every((p) => p.algorithmMatchesVersion === true),
    observedSuffixes: [...new Set(hits.map((p) => p.observedSuffix).filter(Boolean))],
    computedSuffixes: [...new Set(hits.map((p) => p.computedSuffix).filter(Boolean))],
    mismatches: mismatched.slice(0, 4).map((p) => ({ observed: p.observedSuffix, computed: p.computedSuffix, chars: p.chars })),
    algorithm: `sha256("${BILLING_SALT}" + firstUserText[${BILLING_POSITIONS.join(",")}] + "${version}").slice(0,3)`,
    source: `CC ${version} client code (salt/positions present in the shipped JS/binary); same as packages/core/src/fingerprint.ts#ccBuildSuffix`,
  };
}
