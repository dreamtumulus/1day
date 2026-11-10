// How a finished (or broken) stream is settled (review 2026-11-09 E). One explicit table instead of the nested
// conditions that used to sit at the end of deliverStream:
//
//  - an upstream-signalled error never settles as a success, whether or not the client is still there;
//  - what the client or the gateway itself broke (the client not reading for 30 s, a tee proof over 8 MiB, an SSE
//    event over 2 MiB) is not an upstream failure: what was produced is settled and the account is not cooled;
//  - a stream that ended without its terminal event because the client left is billed for what was forwarded.

/** A failure whose cause is on this side of the upstream: the client's connection, or one of the gateway's own limits. */
export type LocalStreamFault = "client" | "gateway";

export class LocalStreamError extends Error {
  constructor(public readonly fault: LocalStreamFault, message: string) {
    super(message);
    this.name = "LocalStreamError";
  }
}

export interface StreamFacts {
  /** The upstream reached its normal terminator (message_stop / [DONE] / response.completed). */
  completed: boolean;
  /** The client's connection is gone. */
  clientGone: boolean;
  /** The upstream signalled an error inside the stream while the client was still there. */
  upstreamError: boolean;
  /** Reading the upstream body failed (reset, idle timeout, no body, a converter throwing). */
  readError: boolean;
  /** The stream was stopped by the client's behaviour or by a gateway limit. */
  localFault: LocalStreamFault | null;
  /** The request's scheduling lease was lost while the client was still there. */
  leaseLost: boolean;
  /** At least one byte of the response body reached the client. */
  firstByteSent: boolean;
}

export type StreamOutcome =
  /** Terminated normally: bill the reported usage. */
  | "success"
  /** Cut short by the client or a gateway limit after output was forwarded: bill what was produced, flagged estimated. */
  | "partial"
  /** The client left before anything reached it: 499 row, no charge. */
  | "client_unserved"
  /** A gateway limit stopped the stream before anything reached the client: failure row, no charge. */
  | "gateway_unserved"
  /** The scheduling lease was lost: 503 row, no charge. */
  | "lease_lost"
  /** The upstream failed: failure row, no charge, the account cools. */
  | "upstream_failure";

export interface StreamDecision {
  outcome: StreamOutcome;
  charge: "full" | "partial" | "none";
  /** Hand the failure to the account's cooldown / disposal logic. Only ever true for an upstream failure. */
  coolAccount: boolean;
}

const D = (outcome: StreamOutcome, charge: StreamDecision["charge"], coolAccount = false): StreamDecision => ({ outcome, charge, coolAccount });

/**
 * Precedence, first match wins:
 *   1. lease lost                      → lease_lost        (no charge, no cooldown)
 *   2. upstream error                  → upstream_failure  (no charge, cooldown) — even when the client has gone since
 *   3. client gone / client fault      → client_unserved before the first byte; else success when completed, partial otherwise
 *   4. gateway fault                   → gateway_unserved before the first byte; else partial
 *   5. read error or no terminator     → upstream_failure
 *   6. completed                       → success
 */
export function decideStreamSettlement(f: StreamFacts): StreamDecision {
  if (f.leaseLost) return D("lease_lost", "none");
  if (f.upstreamError) return D("upstream_failure", "none", true);
  if (f.clientGone || f.localFault === "client") {
    if (!f.firstByteSent) return D("client_unserved", "none");
    return f.completed ? D("success", "full") : D("partial", "partial");
  }
  if (f.localFault === "gateway") return f.firstByteSent ? D("partial", "partial") : D("gateway_unserved", "none");
  if (f.readError || !f.completed) return D("upstream_failure", "none", true);
  return D("success", "full");
}
