import { bad } from "../http.js";

/** Only operators can grant this through service configuration, never a node heartbeat. */
export function isTrustedExecutionNode(nodeId: string): boolean {
  const trusted = (process.env.TRUSTED_EXECUTION_NODE_IDS ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  return trusted.includes(nodeId) || process.env.ALLOW_UNTRUSTED_EXECUTION === "1";
}

export function requireTrustedExecutionNode(nodeId: string): void {
  if (!isTrustedExecutionNode(nodeId)) bad("trusted_node_required", "This node has not been approved as a platform-controlled execution node", 403);
}
