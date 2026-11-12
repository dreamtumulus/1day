export type Json = Record<string, any>;

export interface AccountConfig {
  id: string;
  baseUrl?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string | null;
  apiKey?: string;
  accountUuid?: string;
  deviceId?: string;
  proxy: string;
  models?: string[];
  enabled?: boolean;
}

export interface CompanionConfig {
  enabled: boolean;
  claudeBin?: string;
  restartDelayMs?: number;
  startupStaggerMs?: number;
}

export interface GatewayConfig {
  nodeName: string;
  listen: { host: string; port: number };
  clientApiKeys: string[];
  accounts: AccountConfig[];
  companion?: CompanionConfig;
}

export interface AccountCredential {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string | null;
  apiKey?: string;
}

export interface AccountState extends AccountCredential {
  deviceId: string;
  accountUuid?: string;
}

export interface GatewayState {
  accounts: Record<string, AccountState>;
}

export type RuntimeAccount = Omit<AccountConfig, "deviceId" | "accountUuid"> & AccountState & {
  baseUrl: string;
};

export interface SessionContext {
  id: string;
  account: RuntimeAccount;
  native: boolean;
}
