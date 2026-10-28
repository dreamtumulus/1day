/**
 * Official-exit target whitelist (docs/provider-protocol.md).
 * `*.` prefix matches the bare domain and any subdomain; otherwise exact match.
 * PROVIDER_OFFICIAL_EXIT_ALLOWED_HOSTS may append extra entries (comma separated);
 * the platform can never widen this list remotely.
 */
const DEFAULT_ALLOWED_HOSTS = [
  "*.openai.com",
  "*.chatgpt.com",
  "*.anthropic.com",
  "*.claude.com",
  "*.claude.ai",
  "*.aliyuncs.com",
  "*.bigmodel.cn",
  "*.z.ai",
  "*.kimi.com",
  "*.moonshot.ai",
  "*.moonshot.cn",
  "*.minimax.io",
  "*.minimaxi.com",
  "*.deepseek.com",
  "generativelanguage.googleapis.com",
  "*.x.ai",
  "*.grok.com",
  "ark.cn-beijing.volces.com",
];

export function allowedHostPatterns(env: NodeJS.ProcessEnv = process.env): string[] {
  const extra = (env.PROVIDER_OFFICIAL_EXIT_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return [...DEFAULT_ALLOWED_HOSTS, ...extra];
}

export function isHostAllowed(
  host: string,
  patterns: string[] = allowedHostPatterns(),
): boolean {
  const normalized = host.trim().toLowerCase().replace(/\.$/, "");
  if (!normalized) return false;
  for (const pattern of patterns) {
    const p = pattern.trim().toLowerCase();
    if (p.startsWith("*.")) {
      const suffix = p.slice(2);
      if (normalized === suffix || normalized.endsWith("." + suffix)) return true;
    } else if (normalized === p) {
      return true;
    }
  }
  return false;
}
