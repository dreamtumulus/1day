import type { FastifyRequest } from "fastify";
import { run, tx } from "@1dayapi/core";
import { HttpError } from "../http.js";
import { NodeRemovalBlocked, releaseNodeResources, type NodeRemovalForce, type NodeRemovalImpact } from "./proxies.js";

// Node removal with an explicit confirmation (review fix 2026-11-10). Removing a node used to disable every account
// bound to one of its proxies — including accounts carried by OTHER nodes through a share — without asking and without
// a trace. Now the removal answers 409 with the list of what depends on the node unless the caller confirmed:
//   - administrator + force            → everything goes; accounts of other nodes only lose the shared proxy (frozen, event);
//   - provider / node itself + force   → the node's own accounts go; anything of another node still refuses;
//   - no force                         → refused while any account or share depends on the node.

/** `force` from a DELETE: `?force=1|true` or a JSON body `{ "force": true }`. */
export function forceRequested(req: FastifyRequest): boolean {
  const q = (req.query ?? {}) as Record<string, unknown>;
  const b = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  return q.force === "1" || q.force === "true" || b.force === true;
}

/** releaseNodeResources, with a refusal turned into a 409 that carries the impact. Caller wraps in tx(). */
export function releaseNodeOrConflict(nodeId: string, reason: string, opts: { force: NodeRemovalForce; actorId?: string | null; cascade?: { ownerId: string; nodeIds: string[] } }): NodeRemovalImpact {
  try {
    return releaseNodeResources(nodeId, reason, opts);
  } catch (err) {
    if (err instanceof NodeRemovalBlocked) {
      throw new HttpError(409, err.code, err.message, {
        nodeId: err.nodeId,
        accounts: err.impact.accounts,
        otherNodeAccounts: err.impact.foreignAccounts,
        sharedWith: err.impact.sharedOut,
        /** "force": repeat with force. "admin_force": only an administrator's force removes it (other nodes are affected). */
        forceable: err.code === "node_has_dependents" ? "force" : "admin_force",
      });
    }
    throw err;
  }
}

/** Release + delete the nodes row in one transaction. */
export function removeNode(nodeId: string, reason: string, opts: { force: NodeRemovalForce; actorId?: string | null }): NodeRemovalImpact {
  return tx(() => {
    const impact = releaseNodeOrConflict(nodeId, reason, opts);
    run("DELETE FROM nodes WHERE node_id = ?", nodeId);
    return impact;
  });
}
