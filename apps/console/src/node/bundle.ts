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

/** All build inputs including dependencies, compiler/runtime and flags. */
export function sourceSignature(): string {
  const h = createHash("sha256");
  for (const name of ["package.json", "pnpm-lock.yaml", "tsconfig.base.json", "apps/provider-node/package.json", "apps/provider-node/tsconfig.json"])
    h.update(name).update("\0").update(readFileSync(join(repoRoot, name))).update("\0");
  const bun = findBun();
  h.update(bun ? spawnSync(bun, ["--version"], { encoding: "utf8" }).stdout.trim() : "missing-bun");
  h.update("tsc; bun build --target=bun; format=esm; v2");
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else h.update(p.slice(PROVIDER_NODE_DIR.length)).update("\0").update(readFileSync(p)).update("\0");
    }
  };
  walk(join(PROVIDER_NODE_DIR, "src"));
  return h.digest("hex");
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
 * content and toolchain signature; builds are single-flight.
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
      "bun not found on this server; install it first: curl -fsSL https://bun.sh/install | bash -s bun-v1.4.4",
    );
  }
  mkdirSync(CACHE_DIR, { recursive: true });
  const signature = sourceSignature();
  const out = join(CACHE_DIR, `node-bundle-${signature}.js`);
  const sigFile = join(CACHE_DIR, `node-bundle-${signature}.sig`);
  if (existsSync(out) && existsSync(sigFile) && readFileSync(sigFile, "utf8").trim() === signature) {
    const st = statSync(out);
    return { path: out, bytes: st.size, sha256: sha256File(out), signature };
  }
  // Keep dist/ in sync with src/ before bundling. The repo's own tsc, not pnpm: under the console's service user
  // corepack's pnpm shim was broken (2026-11-08: "Cannot find module .../corepack/v1/pnpm/12.18.0/bin/pnpm.cjs").
  const tsc = [join(PROVIDER_NODE_DIR, "node_modules", ".bin", "tsc"), join(repoRoot, "node_modules", ".bin", "tsc")].find((p) => existsSync(p));
  if (!tsc) throw new Error("tsc not found (apps/provider-node/node_modules/.bin/tsc): run pnpm install in the repo");
  await run(process.execPath, [tsc, "-p", join(PROVIDER_NODE_DIR, "tsconfig.json")], 180_000);
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
