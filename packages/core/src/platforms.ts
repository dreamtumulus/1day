// Upstream platform defaults (docs/v3-design.md §5.1).
//
// URL convention: protocol=openai base URLs include the version prefix and
// the gateway appends /chat/completions or /responses; protocol=anthropic
// base URLs are the site root and the gateway appends /v1/messages.

export type Protocol = "anthropic" | "openai";
export type AccountType = "apikey" | "upstream" | "oauth";
export type Route = "direct" | "node";

export interface PlatformInfo {
  id: string;
  label: string;
  protocol: Protocol;
  baseUrl: string | null;
}

export const PLATFORMS: PlatformInfo[] = [
  { id: "anthropic", label: "Anthropic", protocol: "anthropic", baseUrl: "https://api.anthropic.com" },
  { id: "openai", label: "OpenAI", protocol: "openai", baseUrl: "https://api.openai.com/v1" },
  {
    id: "google",
    label: "Google Gemini",
    protocol: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
  },
  { id: "moonshot", label: "Moonshot (Kimi)", protocol: "openai", baseUrl: "https://api.moonshot.cn/v1" },
  { id: "zhipu", label: "Zhipu GLM", protocol: "openai", baseUrl: "https://open.bigmodel.cn/api/paas/v4" },
  { id: "xai", label: "xAI Grok", protocol: "openai", baseUrl: "https://api.x.ai/v1" },
  {
    id: "volcengine",
    label: "Volcengine Ark",
    protocol: "openai",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
  },
  { id: "minimax", label: "MiniMax", protocol: "openai", baseUrl: "https://api.minimax.chat/v1" },
  {
    id: "qwen",
    label: "Qwen (DashScope)",
    protocol: "openai",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  },
  { id: "deepseek", label: "DeepSeek", protocol: "openai", baseUrl: "https://api.deepseek.com/v1" },
  { id: "xiaomi", label: "Xiaomi MiMo", protocol: "openai", baseUrl: null },
  { id: "opencode", label: "OpenCode", protocol: "openai", baseUrl: null },
  { id: "custom", label: "Custom", protocol: "openai", baseUrl: null },
];

export function getPlatform(id: string): PlatformInfo | undefined {
  return PLATFORMS.find((p) => p.id === id);
}

export function defaultProtocol(platform: string): Protocol {
  return getPlatform(platform)?.protocol ?? "openai";
}

/** OAuth exits are fixed per platform regardless of base_url. */
export const OAUTH_ENDPOINTS = {
  anthropic: {
    baseUrl: "https://api.anthropic.com",
    tokenUrl: "https://platform.claude.com/v1/oauth/token",
    clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    // CC 刷新时回带的默认 scope 集（bundle Iyt()：user:profile/inference/sessions:claude_code/
    // mcp_servers/file_upload + plugins 已注册项），与 authorize 保持一致（去掉 console 专属的 org:create_api_key）。
    refreshScopes: "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload user:plugins",
  },
  openai: {
    baseUrl: "https://chatgpt.com/backend-api/codex",
    tokenUrl: "https://auth.openai.com/oauth/token",
    clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  },
} as const;

/**
 * Cloud session supply (CCR, docs/ccr-supply.md §3–§5, §7). Paths are relative
 * to the account's effective base URL (api.anthropic.com unless overridden
 * for a mock). usagePath / validatePath are the free health & window probes.
 */
export const CCR = {
  beta: "ccr-byoc-2025-07-29",
  anthropicVersion: "2023-06-01",
  clientFeature: "ccr",
  environmentCreatePath: "/v1/environment_providers/cloud/create",
  sessionsPath: "/v1/code/sessions",
  usagePath: "/api/oauth/usage",
  profilePath: "/api/oauth/profile",
  validatePath: "/api/oauth/validate",
  /**
   * Onboarding OAuth authorize step (docs/onboarding.md §2, method=auth_url).
   * The platform holds the PKCE verifier/state; the account owner opens the
   * URL in their own logged-in browser and pastes back the callback URL.
   * Placeholders: {client_id} {redirect_uri} {scope} {code_challenge} {state}
   * (URL-encoded by the caller).
   */
  authorize: {
    urlTemplate:
      "https://claude.com/cai/oauth/authorize?code=true&client_id={client_id}&response_type=code" +
      "&redirect_uri={redirect_uri}&scope={scope}&code_challenge={code_challenge}&code_challenge_method=S256&state={state}",
    clientId: OAUTH_ENDPOINTS.anthropic.clientId,
    redirectUri: "https://platform.claude.com/oauth/code/callback",
    // ccr-supply.md §2 scope 五件套 (org:create_api_key is console-org only).
    scopes: "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload user:plugins",
  },
  /**
   * sessionKey authorize without a browser (docs/onboarding.md §2.1): the SK
   * is the Bearer on the authorize + token calls, PKCE as usual. Same client
   * as the refresh path; org:create_api_key is rejected (400) on this
   * server-side path, so it is left out. The exchange leaves through the node
   * proxy the account is about to be bound to.
   */
  direct: {
    organizationsUrl: "https://claude.ai/api/organizations",
    /** {org} = organization uuid. */
    authorizeUrlTemplate: "https://api.anthropic.com/v1/oauth/{org}/authorize",
    tokenUrl: "https://api.anthropic.com/v1/oauth/token",
    clientId: OAUTH_ENDPOINTS.anthropic.clientId,
    redirectUri: "https://console.anthropic.com/oauth/code/callback",
    scopes: "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
  },
} as const;

export type Executor = "direct" | "ccr" | "ccr_worker";
export const EXECUTORS: Executor[] = ["direct", "ccr", "ccr_worker"];

/**
 * Subscription-backed CCR executors (cloud session / on-node real Claude Code
 * worker, docs/ccr-supply.md §5.1/§8.1). Both require an anthropic OAuth account.
 */
export function isCcrExecutor(e: string): boolean {
  return e === "ccr" || e === "ccr_worker";
}

export function isValidHttpUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/** Effective base URL for an account (no trailing slash), or null when unresolvable. */
export function effectiveBaseUrl(a: {
  platform: string;
  type: string;
  base_url: string | null;
}): string | null {
  if (a.type === "oauth" && (a.platform === "anthropic" || a.platform === "openai")) {
    return a.base_url?.replace(/\/+$/, "") || OAUTH_ENDPOINTS[a.platform].baseUrl;
  }
  const raw = a.base_url || getPlatform(a.platform)?.baseUrl || null;
  return raw ? raw.replace(/\/+$/, "") : null;
}
