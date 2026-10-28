// Also protects tests that statically import a seemingly pure helper which
// transitively imports core's database. Each Node test worker gets its own DB.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "1dayapi-gateway-test-"));
process.env.DATA_DIR = dir;
delete process.env.DB_PATH;
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
