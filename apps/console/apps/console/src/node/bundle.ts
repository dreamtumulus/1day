import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { dataDir, repoRoot } from "@1dayapi/core";

// Node bundle builder (protocol v2): packs apps/provider-node into a single
// Bun-targeted file that the deploy flow ships to node machines. The node
// must run under Bun (TLS fingerprint parity with the official client), so
// the bundle is built with `bun build --target=bun`.

export interface BundleInfo {
  path: string;
  bytes: number;
  sha256: string;
  signature: string;
}

const PROVIDER_NODE_DIR = join(repoRoot, "apps", "provider-node");
const CACHE_DIR = join(dataDir, "bundle-cache");

/** Locate a Bun binary: BUN_PATH, PATH, then the default ~/.bun install. */
export function findBun(): string | null {
  if (process.env.BUN_PATH && existsSync(process.env.BUN_PATH)) return process.env.BUN_PATH;
  const onPath = spawnSync("which", ["bun"], { encoding: "utf8" });
  if (onPath.status === 0 && onPath.stdout.trim()) return onPath.stdout.trim().split("\n")[0];
  const home = join(homedir(), ".bun", "bin", "bun");
  return existsSync(home) ? home : null;
}

/** Cache signature: provider-node version + newest source/package mtime. */
function sourceSignature(): string {
  const h = createHash("sha256");
  const pkg = JSON.parse(readFileSync(join(PROVIDER_NODE_DIR, "package.json"), "utf8")) as {
    version?: string;
  };
  h.update(pkg.version ?? "0");
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else h.update(name).update(String(Math.floor(st.mtimeMs))).update(String(st.size));
    }
  };
  walk(join(PROVIDER_NODE_DIR, "src"));
  return h.digest("hex").slice(0, 16);
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd: repoRoot });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (out += d.toString()));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise(out);
      else reject(new Error(`${cmd} exited ${code}: ${out.slice(-800)}`));
    });
  });
}

let inFlight: Promise<BundleInfo> | null = null;

/**
 * Build (or reuse a cached) single-file node bundle. Cache key is the
 * provider-node version + source mtimes; builds are single-flight.
 */
export function ensureBundle(): Promise<BundleInfo> {
  if (inFlight) return inFlight;
  inFlight = buildBundle().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function buildBundle(): Promise<BundleInfo> {
  const bun = findBun();
  if (!bun) {
    throw new Error(
      "bun not found on this server; install it first: curl -fsSL https://bun.sh/install | bash -s bun-v1.4.3",
    );
  }
  mkdirSync(CACHE_DIR, { recursive: true });
  const signature = sourceSignature();
  const out = join(CACHE_DIR, "node-bundle.js");
  const sigFile = join(CACHE_DIR, "node-bundle.sig");
  if (existsSync(out) && existsSync(sigFile) && readFileSync(sigFile, "utf8").trim() === signature) {
    const st = statSync(out);
    return { path: out, bytes: st.size, sha256: sha256File(out), signature };
  }
  // Keep dist/ in sync with src/ before bundling.
  await run("pnpm", ["--filter", "@1dayapi/provider-node", "build"], 180_000);
  await run(
    bun,
    [
      "build",
      join(PROVIDER_NODE_DIR, "dist", "index.js"),
      "--target=bun",
      `--outfile=${out}`,
    ],
    180_000,
  );
  writeFileSync(sigFile, signature + "\n", { mode: 0o600 });
  const st = statSync(out);
  return { path: out, bytes: st.size, sha256: sha256File(out), signature };
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
