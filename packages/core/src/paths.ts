import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// This file lives at packages/core/src (dev) or packages/core/dist (build);
// three levels up is the repo root either way.
export const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

/** Runtime data directory (DB, key files, logs). DATA_DIR overrides. */
export const dataDir = process.env.DATA_DIR ?? join(repoRoot, "data");
mkdirSync(dataDir, { recursive: true });

export const dbPath = process.env.DB_PATH ?? join(dataDir, "1dayapi.db");
