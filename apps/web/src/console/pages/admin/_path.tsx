import { Badge } from "../../ui";
import type { UsageRow } from "../../api";

/**
 * Which channel served a usage row. `mode` is the gateway protocol mode; a CCR
 * mode is a worker (real Claude Code on the node) or a cloud session depending on
 * the account's executor, which the pages pass in from the accounts list.
 */
export type PathKind = "direct" | "directConvert" | "worker" | "cloud" | "none";

export function pathKind(mode: string | null | undefined, executor?: string | null): PathKind {
  if (!mode) return "none";
  if (mode.startsWith("worker-")) return "worker";
  if (mode.startsWith("ccr-")) return executor === "ccr" ? "cloud" : "worker";
  if (mode === "chat-via-anthropic" || mode === "anthropic-via-chat") return "directConvert";
  if (mode.startsWith("passthrough")) return "direct";
  return "direct";
}

export const PATH_TONE: Record<PathKind, "primary" | "info" | "warning" | "neutral" | "success"> = {
  direct: "primary",
  directConvert: "primary",
  worker: "success",
  cloud: "info",
  none: "neutral",
};

export function PathBadge({ row, executor, t }: { row: Pick<UsageRow, "mode" | "endpoint">; executor?: string | null; t: (k: string) => string }) {
  const kind = pathKind(row.mode, executor);
  return (
    <Badge tone={PATH_TONE[kind]} title={row.mode ?? ""}>
      {t(`path.${kind}`)}
    </Badge>
  );
}
