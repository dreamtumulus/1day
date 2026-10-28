import { one } from "@1dayapi/core";
import { HttpError } from "../http.js";
import { liveReservationSql } from "../onboard/reservations.js";

/** Must be checked in the same write transaction as creating/binding a row or reservation. */
export function nodeOccupancy(nodeId: string, excludeAccountId = "", excludeJobId = ""): number {
  const accounts = one<{n:number}>("SELECT COUNT(*) n FROM accounts WHERE route='node' AND node_id=? AND id<>?", nodeId, excludeAccountId)?.n ?? 0;
  const reserved = one<{n:number}>(`SELECT COUNT(*) n FROM onboarding_jobs j WHERE j.node_id=? AND j.id<>? AND ${liveReservationSql()} AND (j.reservation_account_id IS NULL OR NOT EXISTS(SELECT 1 FROM accounts a WHERE a.id=j.reservation_account_id AND a.route='node' AND a.node_id=j.node_id))`, nodeId, excludeJobId)?.n ?? 0;
  return accounts + reserved;
}
export function assertNodeCapacity(nodeId: string, excludeAccountId = "", excludeJobId = ""): void {
  const node = one<{capacity:number}>("SELECT capacity FROM nodes WHERE node_id=?", nodeId);
  if (!node) throw new HttpError(404, "node_not_found", "Target node does not exist");
  const used = nodeOccupancy(nodeId, excludeAccountId, excludeJobId);
  if (used >= node.capacity) throw new HttpError(400, "node_at_capacity", `Node capacity reached (${used}/${node.capacity})`);
}
