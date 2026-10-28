import { all } from "@1dayapi/core";

// SQLite leases include every live and draining gateway, so console monitoring
// follows blue/green releases without a process-specific GATEWAY_URL.
export async function gatewayInFlight(): Promise<Record<string, number> | null> {
  try {
    return Object.fromEntries(all<{account_id:string;n:number}>(
      "SELECT account_id, COUNT(*) n FROM gateway_account_leases WHERE expires_at > ? GROUP BY account_id", Date.now(),
    ).map((row) => [row.account_id, row.n]));
  } catch {
    return null;
  }
}
