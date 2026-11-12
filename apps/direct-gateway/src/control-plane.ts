import type { AccountCredential, ControlPlaneConfig, Json, TokenUsage } from "./types.js";

export class ControlPlaneError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export interface AdmissionResult {
  requestId: string;
  accountIds: string[];
  coolingAccountIds: string[];
}

export class ControlPlaneClient {
  constructor(private readonly config: ControlPlaneConfig) {}

  admission(input: { requestId: string; clientKey: string; model: string; endpoint: string; stream: boolean }): Promise<AdmissionResult> {
    return this.call("/admission", input, 2);
  }

  settle(input: Json): Promise<Json> {
    return this.call("/settle", input, 5);
  }

  accountEvent(input: Json): Promise<Json> {
    return this.call("/account-event", input, 3);
  }

  rotate(input: { accountId: string; expectedRefreshToken: string; credential: AccountCredential }): Promise<{ rotated: boolean; conflict: boolean; credential: AccountCredential }> {
    return this.call("/credential-rotation", input, 3);
  }

  private async call(path: string, body: Json, attempts: number): Promise<any> {
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const response = await fetch(`${this.config.baseUrl}/internal/worker0${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-worker0-token": this.config.token },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.config.timeoutMs ?? 10_000),
        });
        const json = await response.json().catch(() => ({})) as Json;
        if (response.ok) return json.data ?? json;
        const error = json.error ?? {};
        lastError = new ControlPlaneError(response.status, String(error.code ?? `http_${response.status}`), String(error.message ?? `Control plane HTTP ${response.status}`));
        if (response.status < 500) break;
      } catch (error) {
        lastError = error;
      }
      if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
    if (lastError instanceof ControlPlaneError) throw lastError;
    throw new ControlPlaneError(503, "control_plane_unavailable", (lastError as Error)?.message ?? "Control plane unavailable");
  }
}
