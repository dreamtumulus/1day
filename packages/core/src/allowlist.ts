// Keep this matcher pure: importing it must never open the runtime database.
function canonicalModelId(id: string): string {
  const normalized = id.startsWith("claude-") ? id.replace(/(\d)\.(?=\d)/g, "$1-") : id;
  return normalized.replace(/-\d{8}$/, "");
}
// Model allowlist / pattern matching (docs/v3-design.md §6), sub2api style:
// only `*` wildcards (any position), anchored, case-insensitive; candidate
// names are {model, model without "models/" prefix}.

export interface ModelAllowlist {
  enabled: boolean;
  models: string[];
}

export function parseAllowlist(raw: unknown): ModelAllowlist {
  let v: unknown = raw;
  if (typeof raw === "string") {
    try {
      v = JSON.parse(raw);
    } catch {
      return { enabled: false, models: [] };
    }
  }
  if (!v || typeof v !== "object") return { enabled: false, models: [] };
  const a = v as { enabled?: unknown; models?: unknown };
  return {
    enabled: a.enabled === true,
    models: Array.isArray(a.models)
      ? a.models.filter((m): m is string => typeof m === "string" && m.trim() !== "").map((m) => m.trim())
      : [],
  };
}

/** Validate client input; returns an error message or the normalized value (null = no allowlist). */
export function validateAllowlistInput(raw: unknown): { value: ModelAllowlist | null; error?: string } {
  if (raw === undefined || raw === null) return { value: null };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { value: null, error: "modelAllowlist must be an object {enabled, models[]}" };
  }
  const al = parseAllowlist(raw);
  if (al.enabled && al.models.length === 0) {
    return { value: null, error: "modelAllowlist: enabled with an empty models list is not allowed" };
  }
  return { value: al };
}

export function wildcardMatch(pattern: string, value: string): boolean {
  const p = pattern.toLowerCase();
  const v = value.toLowerCase();
  if (!p.includes("*")) return p === v;
  const segs = p.split("*");
  const first = segs[0];
  const last = segs[segs.length - 1];
  if (!v.startsWith(first)) return false;
  if (!v.endsWith(last)) return false;
  if (first.length + last.length > v.length) return false;
  let pos = first.length;
  const end = v.length - last.length;
  for (let i = 1; i < segs.length - 1; i++) {
    const seg = segs[i];
    if (!seg) continue;
    const idx = v.indexOf(seg, pos);
    if (idx === -1 || idx + seg.length > end) return false;
    pos = idx + seg.length;
  }
  return true;
}

export function matchesAny(patterns: string[], model: string): boolean {
  const candidates = [model, model.replace(/^models\//, "")];
  return candidates.some((c) => patterns.some((p) => wildcardMatch(p, c)));
}

export function isModelAllowed(allowlist: ModelAllowlist, model: string): boolean {
  if (!allowlist.enabled) return true;
  if (allowlist.models.length === 0) return false;
  return matchesAny(allowlist.models, model) || matchesAny(allowlist.models.map((p) => p.includes("*") ? p : canonicalModelId(p)), canonicalModelId(model));
}
