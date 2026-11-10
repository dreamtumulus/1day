import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Files the node writes for a process that runs under another uid (X-49, 2026-11-10).
//
// The node is root; Claude Code runs as a per-team (or `ccworker`) uid and owns its account dir. Two things follow:
//   1. whatever the node writes there must end up readable by that uid — a root-owned 0600 `.claude.json` reads as a
//      first run and Claude Code mints a new device id;
//   2. the dir is writable by a less privileged process, so the node must never write, chmod or chown *through* a
//      name that process controls (a symlink planted at the destination), and never leave a half-written file.
// Every such write goes through `writeFileAtomic`; directories through `ensureDir`; ownership of a tree through
// `chownTree`. Nothing here follows a symlink at the final path component.

export interface Owner {
  uid: number;
  gid: number;
}

export interface WriteOptions {
  /** Permission bits of the file (default 0600). */
  mode?: number;
  /**
   * uid/gid the file must end up with — the identity the reading process runs as. Omitted/null: a replaced file keeps
   * the owner it had, a new file belongs to the writer.
   */
  owner?: Owner | null;
}

const errno = (err: unknown): string | undefined => (err as NodeJS.ErrnoException | null)?.code;

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch (err) {
    if (errno(err) === "ENOENT") return null;
    throw err;
  }
}

/** True when anything (a dangling symlink included) sits at `p`. */
export function lexists(p: string): boolean {
  return lstatOrNull(p) !== null;
}

/**
 * Contents of a regular file, never through a symlink (O_NOFOLLOW) and never a fifo/device. Throws with `code`
 * ENOENT when absent, ELOOP for a symlink, ENOTREG for anything else that is not a regular file, EFBIG above `maxBytes`.
 */
export function readRegularFile(file: string, maxBytes = 64 * 1024 * 1024): Buffer {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw Object.assign(new Error(`not a regular file: ${file}`), { code: "ENOTREG" });
    if (st.size > maxBytes) throw Object.assign(new Error(`file too large (${st.size} bytes): ${file}`), { code: "EFBIG" });
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Set mode / owner on an open file when they differ. Returns what was changed. */
function enforceFd(fd: number, st: fs.Stats, mode: number | undefined, owner: Owner | null | undefined): { chmod: boolean; chown: boolean } {
  const out = { chmod: false, chown: false };
  // Owner first: chown clears setuid/setgid bits, the mode set afterwards is the one that sticks.
  if (owner && (st.uid !== owner.uid || st.gid !== owner.gid)) {
    fs.fchownSync(fd, owner.uid, owner.gid);
    out.chown = true;
  }
  if (mode !== undefined && (st.mode & 0o7777) !== mode) {
    fs.fchmodSync(fd, mode);
    out.chmod = true;
  }
  return out;
}

/**
 * Write `content` to `file` so that a reader sees either the old file or the complete new one:
 * temp file in the same directory → mode → owner → rename. Never truncates in place.
 *
 *  - destination is a symlink, or exists and is not a regular file → throws, nothing is written;
 *  - content unchanged → no rewrite (mode / owner are still brought in line); returns false;
 *  - owner: `opts.owner`, else the owner of the file being replaced, else the writer.
 */
export function writeFileAtomic(file: string, content: string | Buffer, opts: WriteOptions = {}): boolean {
  const mode = opts.mode ?? 0o600;
  const data = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  const prior = lstatOrNull(file);
  if (prior?.isSymbolicLink()) throw Object.assign(new Error(`refusing to write through a symlink: ${file}`), { code: "ELOOP" });
  if (prior && !prior.isFile()) throw Object.assign(new Error(`refusing to replace a non-regular file: ${file}`), { code: "ENOTREG" });
  const owner = opts.owner ?? (prior ? { uid: prior.uid, gid: prior.gid } : null);

  // Unchanged: leave the inode alone. A file with other hard links is always replaced (rename breaks the link) so
  // mode/owner are never changed on an inode that also lives under another name.
  if (prior && prior.nlink === 1 && prior.size === data.length) {
    let fd: number | null = null;
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const st = fs.fstatSync(fd);
      if (st.isFile() && st.nlink === 1 && fs.readFileSync(fd).equals(data)) {
        enforceFd(fd, st, mode, owner);
        return false;
      }
    } catch (err) {
      // Vanished or swapped between lstat and open: fall through to the replace (which re-checks nothing it does not
      // need: rename never follows a symlink at the destination).
      if (!["ENOENT", "ELOOP", "EACCES"].includes(errno(err) ?? "")) throw err;
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  }

  const tmp = path.join(path.dirname(file), `${path.basename(file)}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
  let fd: number | null = null;
  try {
    // O_EXCL: a name someone else created (or a symlink planted at it) is an error, never a file we write into.
    fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(fd, data);
    enforceFd(fd, fs.fstatSync(fd), mode, owner);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already failing */
      }
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* never created, or already renamed */
    }
    throw err;
  }
  return true;
}

/**
 * Bring an existing regular file's mode / owner in line without touching its content. Symlink → throws; absent → null.
 * Returns what was changed.
 */
export function enforceFile(file: string, opts: WriteOptions): { chmod: boolean; chown: boolean; was: Owner & { mode: number } } | null {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (err) {
    if (errno(err) === "ENOENT") return null;
    if (errno(err) === "ELOOP") throw Object.assign(new Error(`refusing to change a symlink: ${file}`), { code: "ELOOP" });
    throw err;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw Object.assign(new Error(`not a regular file: ${file}`), { code: "ENOTREG" });
    return { ...enforceFd(fd, st, opts.mode, opts.owner), was: { uid: st.uid, gid: st.gid, mode: st.mode & 0o7777 } };
  } finally {
    fs.closeSync(fd);
  }
}

export interface DirOptions {
  /** Mode for a directory this call creates (default 0700). */
  mode?: number;
  /** Also set the mode on a directory that already exists. */
  enforceMode?: boolean;
  /** uid/gid the directory must end up with (created or already there). Omitted/null: left as it is. */
  owner?: Owner | null;
}

/**
 * Make sure `dir` is a real directory (created when absent; the parent must exist) owned by `opts.owner`.
 * A symlink or a non-directory at that name → throws: the node never creates, chmods or chowns through a link.
 * Returns true when the directory was created by this call.
 */
export function ensureDir(dir: string, opts: DirOptions = {}): boolean {
  const mode = opts.mode ?? 0o700;
  let created = false;
  if (!lexists(dir)) {
    try {
      fs.mkdirSync(dir, { mode });
      created = true;
    } catch (err) {
      if (errno(err) !== "EEXIST") throw err;
    }
  }
  let fd: number;
  try {
    fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  } catch (err) {
    if (errno(err) === "ELOOP" || errno(err) === "ENOTDIR") throw Object.assign(new Error(`refusing to use ${dir}: not a real directory (symlink or file)`), { code: errno(err) });
    throw err;
  }
  try {
    const st = fs.fstatSync(fd);
    // mkdir's mode is masked by the umask: a directory we just made gets its exact mode too.
    enforceFd(fd, st, created || opts.enforceMode ? mode : undefined, opts.owner);
  } finally {
    fs.closeSync(fd);
  }
  return created;
}

const PROC_FD: string | null = (() => {
  try {
    return fs.statSync("/proc/self/fd").isDirectory() ? "/proc/self/fd" : null;
  } catch {
    return null;
  }
})();

/**
 * `target` must be `root` plus plain path components: no component below `root` may be a symlink (a process that
 * owns one of the directories could otherwise point the node's writes somewhere else). `root` itself may be reached
 * through links (operator's choice). Throws when the resolved path differs.
 */
export function assertConfined(root: string, target: string, actual = fs.realpathSync(target)): void {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`path escapes ${root}: ${target}`);
  const expected = path.join(fs.realpathSync(root), rel);
  if (actual !== expected) throw new Error(`refusing to use ${target}: resolves to ${actual} (symlink below ${root})`);
}

export interface AnchorOptions {
  /** The directory must be this root plus plain components (no symlink below the root). */
  within?: string;
  /** The last component of `dir` must not be a symlink. */
  nofollow?: boolean;
}

/**
 * Pin a directory for a series of operations: `fn` gets a path (`/proc/self/fd/<n>`) that keeps naming the directory
 * that was opened, whatever happens to the names leading to it meanwhile. A check on the directory and a write into it
 * then concern the same directory — a process owning one of the parents cannot swap a symlink in between. The path is
 * only valid inside `fn`. Without /proc (non-Linux development) the plain path is used after the same checks.
 */
export function anchorDir<T>(dir: string, opts: AnchorOptions, fn: (anchored: string) => T): T {
  if (!PROC_FD) {
    if (opts.nofollow && fs.lstatSync(dir).isSymbolicLink()) throw Object.assign(new Error(`refusing to use ${dir}: symlink`), { code: "ELOOP" });
    if (opts.within) assertConfined(opts.within, dir);
    return fn(dir);
  }
  let fd: number;
  try {
    fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | (opts.nofollow ? fs.constants.O_NOFOLLOW : 0));
  } catch (err) {
    if (errno(err) === "ELOOP" || errno(err) === "ENOTDIR") throw Object.assign(new Error(`refusing to use ${dir}: not a real directory (symlink or file)`), { code: errno(err) });
    throw err;
  }
  try {
    const anchored = `${PROC_FD}/${fd}`;
    if (opts.within) assertConfined(opts.within, dir, fs.readlinkSync(anchored));
    return fn(anchored);
  } finally {
    fs.closeSync(fd);
  }
}

export type DirStep = { name: string } & DirOptions;

/**
 * Walk down from `base` (an operator-controlled directory) through `steps`, making sure each one is a real directory
 * with the given mode / owner (`ensureDir`), each pinned before the next is looked at; `fn` runs with the last one
 * pinned. A step name is one plain path component.
 */
export function withDirChain<T>(base: string, steps: DirStep[], fn: (anchored: string) => T): T {
  const descend = (dir: string, i: number): T => {
    if (i === steps.length) return fn(dir);
    const { name, ...opts } = steps[i]!;
    if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\0")) throw new Error(`invalid directory name: ${JSON.stringify(name)}`);
    const next = path.join(dir, name);
    ensureDir(next, opts);
    return anchorDir(next, { nofollow: true }, (d) => descend(d, i + 1));
  };
  return anchorDir(base, {}, (d) => descend(d, 0));
}

/**
 * chown a tree to `owner` with lchown semantics: a symlink is re-owned itself and never followed, neither for the
 * chown nor for the walk (each directory is pinned by descriptor before its entries are touched, so a directory
 * swapped for a symlink mid-walk cannot redirect the chown). A regular file with more than one hard link that is not
 * already the owner's is left alone (the node only ever creates single-link files; a link to someone else's file must
 * not be handed over). Entries that vanish while walking are skipped — the tree is live while other sessions of the
 * same account run (canary 2026-11-02: Claude Code creates and removes `.claude.json.lock` between readdir and
 * lchown; that ENOENT took whole turns down). Returns the number of entries whose owner was changed.
 */
export function chownTree(p: string, owner: Owner | null | undefined): number {
  if (!owner) return 0;
  const abs = path.resolve(p);
  try {
    return anchorDir(path.dirname(abs), {}, (parent) => chownEntry(parent, path.basename(abs), owner));
  } catch (err) {
    if (errno(err) === "ENOENT") return 0;
    throw err;
  }
}

/** Same, for everything inside a directory the caller has pinned (`anchorDir`); the directory itself is not touched. */
export function chownContents(dir: string, owner: Owner | null | undefined): number {
  if (!owner) return 0;
  let changed = 0;
  let children: string[];
  try {
    children = fs.readdirSync(dir);
  } catch (err) {
    if (errno(err) === "ENOENT" || errno(err) === "ENOTDIR") return 0;
    throw err;
  }
  for (const c of children) changed += chownEntry(dir, c, owner);
  return changed;
}

function chownEntry(parent: string, name: string, owner: Owner): number {
  const f = path.join(parent, name);
  const gone = (err: unknown) => errno(err) === "ENOENT";
  let changed = 0;
  let st: fs.Stats;
  try {
    st = fs.lstatSync(f);
  } catch (err) {
    if (gone(err)) return 0;
    throw err;
  }
  if (st.uid !== owner.uid || st.gid !== owner.gid) {
    if (st.isFile() && st.nlink > 1) return 0;
    try {
      fs.lchownSync(f, owner.uid, owner.gid);
      changed++;
    } catch (err) {
      if (gone(err)) return 0;
      throw err;
    }
  }
  if (!st.isDirectory()) return changed;
  try {
    return changed + anchorDir(f, { nofollow: true }, (d) => chownContents(d, owner));
  } catch (err) {
    // Removed, or replaced by a symlink / file since the lstat: nothing below it is ours to touch.
    if (gone(err) || errno(err) === "ELOOP" || errno(err) === "ENOTDIR") return changed;
    throw err;
  }
}
