import { ACTIVE_PROFILE } from "./profile.js";
import type { Egress } from "./egress.js";
import type { StateStore } from "./state.js";
import type { AccountCredential, RuntimeAccount } from "./types.js";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const SCOPES = "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload user:plugins";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";

export class OAuthManager {
  private readonly refreshing = new Map<string, Promise<RuntimeAccount>>();

  constructor(private readonly state: StateStore, private readonly egress: Egress) {}

  fresh(account: RuntimeAccount, force = false): Promise<RuntimeAccount> {
    if (!account.accessToken || !account.refreshToken) return Promise.resolve(account);
    const expired = account.expiresAt ? Date.parse(account.expiresAt) - Date.now() < 300_000 : false;
    if (!force && !expired) return Promise.resolve(account);
    const existing = this.refreshing.get(account.id);
    if (existing) return existing;
    const pending = this.refresh(account).finally(() => this.refreshing.delete(account.id));
    this.refreshing.set(account.id, pending);
    return pending;
  }

  private async refresh(account: RuntimeAccount): Promise<RuntimeAccount> {
    const url = process.env.DIRECT_GATEWAY_OAUTH_TOKEN_URL ?? TOKEN_URL;
    const response = await this.egress.request(account, url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/plain, */*",
        "user-agent": `claude-code/${ACTIVE_PROFILE.claudeCodeVersion}`,
      },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: account.refreshToken, client_id: CLIENT_ID, scope: SCOPES }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`OAuth refresh failed with HTTP ${response.status}`);
    const json = await response.json() as Record<string, unknown>;
    if (typeof json.access_token !== "string") throw new Error("OAuth refresh returned no access token");
    const credential: AccountCredential = {
      accessToken: json.access_token,
      refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : account.refreshToken,
      expiresAt: new Date(Date.now() + Number(json.expires_in ?? 3600) * 1000).toISOString(),
    };
    this.state.updateCredential(account.id, credential);
    return { ...account, ...credential };
  }
}
