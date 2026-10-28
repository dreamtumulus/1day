// Provider-only response shapes (docs/v3-design.md §8.3).

export interface ProviderOverviewData {
  balanceUsd: number;
  lifetimeEarningUsd: number;
  paidOutUsd: number;
  today: { requests: number; earningUsd: number };
  month: { requests: number; earningUsd: number };
  daily: Array<{ day: string; requests: number; earningUsd: number }>;
  accounts: { total: number; active: number; pending: number; error: number };
  nodes: { total: number; online: number };
}

export interface EarningRow {
  id: string;
  createdAt: string;
  accountId: string | null;
  accountName: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  totalCost: number;
  providerEarning: number;
  statusCode: number;
}
