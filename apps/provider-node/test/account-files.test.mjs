// Files the node (root) writes for a process running under another uid (X-49, 2026-11-10): one atomic,
// owner-setting, symlink-refusing write path. Pure checks run as any user (ownership through spies on the fs chown
// calls); the blocks under `if (root)` check real kernel ownership with numeric uids (no system user needed).
//   bun apps/provider-node/test/account-files.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { anchorDir, chownContents, chownTree, enforceFile, ensureDir, lexists, readRegularFile, withDirChain, writeFileAtomic } from "../dist/account-files.js";

const root = process.getuid?.() === 0;
const U = { uid: 54321, gid: 54322 };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "account-files-"));
const mode = (p) => fs.lstatSync(p).mode & 0o7777;
const leftovers = (d) => fs.readdirSync(d).filter((n) => n.includes(".tmp-"));

/** Record chown calls instead of making them (unprivileged runs); paths are resolved at call time. */
function spyChown(fn) {
  const calls = [];
  const real = { f: fs.fchownSync, l: fs.lchownSync, c: fs.chownSync, r: fs.renameSync };
  fs.fchownSync = (fd, uid, gid) => void calls.push({ op: "fchown", path: fs.readlinkSync(`/proc/self/fd/${fd}`), uid, gid });
  fs.lchownSync = (p, uid, gid) => void calls.push({ op: "lchown", path: path.join(fs.realpathSync(path.dirname(p)), path.basename(p)), uid, gid });
  fs.chownSync = (p) => assert.fail(`chown (follows symlinks) must never be used: ${p}`);
  fs.renameSync = (a, b) => (calls.push({ op: "rename", path: path.join(fs.realpathSync(path.dirname(b)), path.basename(b)) }), real.r(a, b));
  try {
    fn(calls);
  } finally {
    fs.fchownSync = real.f;
    fs.lchownSync = real.l;
    fs.chownSync = real.c;
    fs.renameSync = real.r;
  }
  return calls;
}

try {
  // ---- writeFileAtomic: create, mode, no write when unchanged, atomic replace, no temp left behind ----
  {
    const d = fs.mkdtempSync(path.join(tmp, "w-"));
    const f = path.join(d, ".claude.json");
    assert.equal(writeFileAtomic(f, '{"a":1}'), true, "new file written");
    assert.equal(fs.readFileSync(f, "utf8"), '{"a":1}');
    assert.equal(mode(f), 0o600, "default mode 0600");
    const before = fs.statSync(f);
    assert.equal(writeFileAtomic(f, '{"a":1}'), false, "unchanged content: no write");
    const same = fs.statSync(f);
    assert.equal(same.ino, before.ino, "unchanged: same inode");
    assert.equal(same.mtimeMs, before.mtimeMs, "unchanged: mtime untouched");
    fs.chmodSync(f, 0o644);
    assert.equal(writeFileAtomic(f, '{"a":1}'), false);
    assert.equal(mode(f), 0o600, "unchanged content still gets its mode back");
    assert.equal(fs.statSync(f).ino, before.ino);
    assert.equal(writeFileAtomic(f, '{"a":2}'), true);
    assert.notEqual(fs.statSync(f).ino, before.ino, "changed: replaced by rename, never truncated in place");
    assert.equal(fs.readFileSync(f, "utf8"), '{"a":2}');
    assert.equal(writeFileAtomic(path.join(d, "pub"), Buffer.from("x"), { mode: 0o644 }), true);
    assert.equal(mode(path.join(d, "pub")), 0o644);
    assert.deepEqual(leftovers(d), [], "no temp files left");
    // a reader holding the old file keeps a complete old file
    const fd = fs.openSync(f, "r");
    writeFileAtomic(f, '{"a":3,"long":"' + "x".repeat(5000) + '"}');
    assert.equal(fs.readFileSync(fd, "utf8"), '{"a":2}', "open reader still sees the whole previous content");
    fs.closeSync(fd);
  }

  // ---- writeFileAtomic refuses a symlink (live or dangling) and a non-file at the destination ----
  {
    const d = fs.mkdtempSync(path.join(tmp, "s-"));
    const victim = path.join(d, "victim");
    fs.writeFileSync(victim, "root-only secret", { mode: 0o600 });
    const link = path.join(d, ".credentials.json");
    fs.symlinkSync(victim, link);
    assert.throws(() => writeFileAtomic(link, "overwritten"), /symlink/);
    assert.equal(fs.readFileSync(victim, "utf8"), "root-only secret", "target of the planted link untouched");
    assert.ok(fs.lstatSync(link).isSymbolicLink(), "the link itself is left for the operator to see");
    const dangling = path.join(d, "settings.json");
    fs.symlinkSync(path.join(d, "created-through-link"), dangling);
    assert.equal(lexists(dangling), true);
    assert.throws(() => writeFileAtomic(dangling, "x"), /symlink/);
    assert.equal(fs.existsSync(path.join(d, "created-through-link")), false, "nothing created through a dangling link");
    fs.mkdirSync(path.join(d, "adir"));
    assert.throws(() => writeFileAtomic(path.join(d, "adir"), "x"), /non-regular/);
    assert.deepEqual(leftovers(d), []);
    assert.throws(() => readRegularFile(link), (e) => e.code === "ELOOP", "reads do not follow a symlink either");
    assert.throws(() => enforceFile(link, { mode: 0o600 }), /symlink/);
    assert.equal(mode(victim), 0o600);
    assert.equal(enforceFile(path.join(d, "absent"), { mode: 0o600 }), null);
  }

  // ---- a hard-linked destination is replaced, the other name keeps its content, mode and owner ----
  {
    const d = fs.mkdtempSync(path.join(tmp, "h-"));
    const other = path.join(d, "other");
    fs.writeFileSync(other, "same", { mode: 0o644 });
    fs.linkSync(other, path.join(d, "dest"));
    assert.equal(writeFileAtomic(path.join(d, "dest"), "same", { mode: 0o600 }), true, "same content but shared inode: replaced, not chmod-ed in place");
    assert.equal(mode(other), 0o644);
    assert.equal(fs.statSync(other).nlink, 1);
  }

  // ---- owner: set on the temp file before the rename; a replaced file keeps its owner when none is given ----
  if (!root) {
    const d = fs.mkdtempSync(path.join(tmp, "o-"));
    const f = path.join(d, ".claude.json");
    const calls = spyChown(() => writeFileAtomic(f, "1", { owner: U }));
    const chown = calls.findIndex((c) => c.op === "fchown"), rename = calls.findIndex((c) => c.op === "rename");
    assert.ok(chown >= 0 && rename > chown, "owner set before the file appears under its name");
    assert.deepEqual([calls[chown].uid, calls[chown].gid], [U.uid, U.gid]);
    assert.match(calls[chown].path, /\.claude\.json\.tmp-/, "chown through the descriptor of the temp file");
    assert.equal(calls[rename].path, f);
    // no owner given, existing file owned by someone else (lstat faked): the replacement goes back to that owner
    const realLstat = fs.lstatSync;
    fs.lstatSync = (p, ...a) => {
      const st = realLstat(p, ...a);
      if (p === f) { st.uid = 4242; st.gid = 4243; }
      return st;
    };
    let kept;
    try {
      kept = spyChown(() => writeFileAtomic(f, "2"));
    } finally {
      fs.lstatSync = realLstat;
    }
    assert.deepEqual(kept.filter((c) => c.op === "fchown").map((c) => [c.uid, c.gid]), [[4242, 4243]], "existing owner kept");
    // unchanged content, wrong owner: fixed in place through the descriptor, no rewrite
    const fix = spyChown(() => assert.equal(writeFileAtomic(f, "2", { owner: U }), false));
    assert.deepEqual(fix.map((c) => c.op), ["fchown"]);
    assert.equal(fix[0].path, f);
    // same owner as the writer: no chown at all
    assert.deepEqual(spyChown(() => writeFileAtomic(f, "3", { owner: { uid: process.getuid(), gid: process.getgid() } })).filter((c) => c.op !== "rename"), []);
  }
  if (root) {
    const d = fs.mkdtempSync(path.join(tmp, "o-"));
    const f = path.join(d, ".claude.json");
    writeFileAtomic(f, "1", { owner: U });
    let st = fs.statSync(f);
    assert.deepEqual([st.uid, st.gid, st.mode & 0o777], [U.uid, U.gid, 0o600], "explicit owner set");
    writeFileAtomic(f, "2");
    st = fs.statSync(f);
    assert.deepEqual([st.uid, st.gid], [U.uid, U.gid], "replacing without an owner keeps the existing one (X-49)");
    fs.chownSync(f, 0, 0);
    assert.equal(writeFileAtomic(f, "2", { owner: U }), false, "unchanged content");
    assert.equal(fs.statSync(f).uid, U.uid, "…but a root-owned file is handed back to the run-as uid");
    writeFileAtomic(path.join(d, "new"), "x");
    assert.equal(fs.statSync(path.join(d, "new")).uid, 0, "new file, no owner: the writer's");
    // a symlink planted by the dir's owner never gets root to write or chown elsewhere
    const victim = path.join(tmp, "root-victim");
    fs.writeFileSync(victim, "root", { mode: 0o600 });
    fs.symlinkSync(victim, path.join(d, "settings.json"));
    assert.throws(() => writeFileAtomic(path.join(d, "settings.json"), "x", { owner: U }), /symlink/);
    assert.deepEqual([fs.statSync(victim).uid, fs.readFileSync(victim, "utf8")], [0, "root"]);
  }

  // ---- ensureDir: exact mode on creation, real directories only ----
  {
    const d = fs.mkdtempSync(path.join(tmp, "d-"));
    const old = process.umask(0o077);
    try {
      assert.equal(ensureDir(path.join(d, "a"), { mode: 0o711 }), true);
    } finally {
      process.umask(old);
    }
    assert.equal(mode(path.join(d, "a")), 0o711, "mode is exact, whatever the umask");
    fs.chmodSync(path.join(d, "a"), 0o755);
    assert.equal(ensureDir(path.join(d, "a"), { mode: 0o711 }), false);
    assert.equal(mode(path.join(d, "a")), 0o755, "existing directory: mode left alone unless asked");
    ensureDir(path.join(d, "a"), { mode: 0o700, enforceMode: true });
    assert.equal(mode(path.join(d, "a")), 0o700);
    fs.mkdirSync(path.join(d, "elsewhere"), { mode: 0o755 });
    fs.symlinkSync(path.join(d, "elsewhere"), path.join(d, "projects"));
    assert.throws(() => ensureDir(path.join(d, "projects"), { mode: 0o700, enforceMode: true, owner: U }), /not a real directory/);
    assert.equal(mode(path.join(d, "elsewhere")), 0o755, "nothing chmod-ed through the link");
    fs.writeFileSync(path.join(d, "file"), "");
    assert.throws(() => ensureDir(path.join(d, "file")), /not a real directory/);
    if (!root) {
      const calls = spyChown(() => ensureDir(path.join(d, "owned"), { owner: U }));
      assert.deepEqual(calls.map((c) => [c.op, c.path, c.uid, c.gid]), [["fchown", path.join(d, "owned"), U.uid, U.gid]]);
    } else {
      ensureDir(path.join(d, "owned"), { owner: U });
      assert.equal(fs.statSync(path.join(d, "owned")).uid, U.uid);
      fs.mkdirSync(path.join(d, "rootmade"), { mode: 0o700 });
      ensureDir(path.join(d, "rootmade"), { owner: U });
      assert.equal(fs.statSync(path.join(d, "rootmade")).uid, U.uid, "an existing root-owned directory is handed over too");
    }
  }

  // ---- withDirChain / anchorDir: plain names only, no symlinked level, writes land in the pinned directory ----
  {
    const d = fs.mkdtempSync(path.join(tmp, "c-"));
    const out = withDirChain(d, [{ name: "projects", mode: 0o700 }, { name: "-work-cwd", mode: 0o700 }], (p) => {
      writeFileAtomic(path.join(p, "t.jsonl"), "{}\n");
      return fs.realpathSync(p);
    });
    assert.equal(out, path.join(d, "projects", "-work-cwd"));
    assert.equal(fs.readFileSync(path.join(d, "projects", "-work-cwd", "t.jsonl"), "utf8"), "{}\n");
    for (const bad of ["..", ".", "a/b", ""]) assert.throws(() => withDirChain(d, [{ name: bad }], () => 1), /invalid directory name/);
    assert.equal(fs.existsSync(path.join(d, "a")), false);
    // an intermediate level swapped for a symlink
    const outside = fs.mkdtempSync(path.join(tmp, "outside-"));
    fs.rmSync(path.join(d, "projects"), { recursive: true });
    fs.symlinkSync(outside, path.join(d, "projects"));
    assert.throws(() => withDirChain(d, [{ name: "projects" }, { name: "x" }], () => assert.fail("must not run")), /not a real directory/);
    assert.deepEqual(fs.readdirSync(outside), [], "nothing created behind the link");
    // within: a symlink anywhere below the root is refused, the root itself may be a link
    fs.mkdirSync(path.join(d, "real", "acct"), { recursive: true });
    fs.symlinkSync(path.join(d, "real"), path.join(d, "alias"));
    assert.throws(() => anchorDir(path.join(d, "alias", "acct"), { within: d }, () => 1), /symlink below/);
    assert.equal(anchorDir(path.join(d, "real", "acct"), { within: d }, () => "ok"), "ok");
    assert.equal(anchorDir(path.join(d, "alias", "acct"), { within: path.join(d, "alias") }, () => "ok"), "ok", "operator's root may be reached through a link");
    assert.throws(() => anchorDir(path.join(d, "alias"), { nofollow: true }, () => 1), /not a real directory/);
    // the pinned path keeps naming the directory that was opened even when its name is re-pointed meanwhile
    anchorDir(path.join(d, "real", "acct"), {}, (p) => {
      fs.renameSync(path.join(d, "real", "acct"), path.join(d, "real", "moved"));
      fs.symlinkSync(outside, path.join(d, "real", "acct"));
      writeFileAtomic(path.join(p, "f"), "pinned");
    });
    assert.equal(fs.readFileSync(path.join(d, "real", "moved", "f"), "utf8"), "pinned");
    assert.deepEqual(fs.readdirSync(outside), [], "a link swapped in after the check does not redirect the write");
  }

  // ---- chownTree: lchown semantics — links re-owned themselves, never followed; hard links to foreign files skipped ----
  {
    const d = fs.mkdtempSync(path.join(tmp, "t-"));
    const tree = path.join(d, "acct");
    const outside = path.join(d, "outside");
    fs.mkdirSync(path.join(tree, "projects", "p1"), { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "shadow"), "root");
    fs.writeFileSync(path.join(outside, "hl"), "root");
    fs.writeFileSync(path.join(tree, "projects", "p1", "t.jsonl"), "");
    fs.writeFileSync(path.join(tree, ".claude.json"), "{}");
    fs.symlinkSync(outside, path.join(tree, "dirlink"));
    fs.symlinkSync(path.join(outside, "shadow"), path.join(tree, "filelink"));
    fs.symlinkSync(path.join(d, "nowhere"), path.join(tree, "dangling"));
    fs.linkSync(path.join(outside, "hl"), path.join(tree, "hardlink"));
    const inTree = ["", ".claude.json", "projects", "projects/p1", "projects/p1/t.jsonl", "dirlink", "filelink", "dangling"].map((r) => path.join(tree, r)).sort();
    assert.equal(chownTree(path.join(d, "absent"), U), 0, "a tree that is gone is not an error");
    assert.equal(chownTree(tree, null), 0, "no identity: nothing to do");
    if (!root) {
      const calls = spyChown(() => assert.equal(chownTree(tree, U), inTree.length));
      assert.ok(calls.every((c) => c.op === "lchown" && c.uid === U.uid && c.gid === U.gid));
      assert.deepEqual(calls.map((c) => c.path).sort(), inTree, "every entry of the tree, the links themselves, nothing behind a link, no shared inode");
      // already owned: no syscall at all
      assert.deepEqual(spyChown(() => chownTree(tree, { uid: process.getuid(), gid: process.getgid() })), []);
      assert.deepEqual(spyChown(() => chownContents(tree, U)).map((c) => c.path).sort(), inTree.slice(1), "chownContents leaves the directory itself");
    } else {
      chownTree(tree, U);
      for (const p of inTree) assert.equal(fs.lstatSync(p).uid, U.uid, p);
      for (const p of [outside, path.join(outside, "shadow"), path.join(outside, "hl")]) assert.equal(fs.lstatSync(p).uid, 0, `${p} stays root's`);
    }
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`account-files: ALL PASSED${root ? "" : " (real-ownership blocks skipped: not root)"}`);
