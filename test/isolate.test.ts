import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLEAN_WORKTREE_NOTE,
  createIsolationWorktree,
  removeIfUnchanged,
  sanitizeSlug,
  settleWorktree,
  type Isolation,
} from "../src/isolate.ts";

// isolate.ts deletes user work (worktrees + branches), so its behaviour is
// exercised against a real git repository rather than mocked. Every temp path
// lives under the OS temp dir and is torn down after each test — nothing here
// touches the real ~/.worktrees.

function git(cwd: string, args: string[]): string {
  // stderr ignored so git's chatter (CRLF hints, "Preparing worktree") stays
  // out of the test output; the command's stdout is what these helpers use.
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function rmrf(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort: a locked pack file on Windows must not fail the assertion
  }
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pify-wf-iso-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@pify.dev"]);
  git(dir, ["config", "user.name", "Pify Test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, "README.md"), "seed\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "seed"]);
  return dir;
}

/**
 * A worktree created directly under a temp base — deliberately bypassing
 * createIsolationWorktree's ~/.worktrees placement so these tests never write
 * to the real home directory.
 */
function makeWorktree(repo: string, base: string, slug: string): Isolation {
  const branch = `agent/${slug}`;
  const path = join(base, slug);
  git(repo, ["worktree", "add", "-b", branch, path, "HEAD"]);
  return { path, branch };
}

function branchExists(repo: string, branch: string): boolean {
  try {
    git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

test("sanitizeSlug is filesystem/branch safe and never empty", () => {
  assert.equal(sanitizeSlug("My Feature!"), "my-feature");
  assert.equal(sanitizeSlug("  spaces  "), "spaces");
  assert.equal(sanitizeSlug("../../etc/passwd"), "etc-passwd");
  assert.equal(sanitizeSlug("!!!"), "run");
  assert.equal(sanitizeSlug(""), "run");
  assert.equal(sanitizeSlug("a".repeat(200)).length, 60);
});

test("removeIfUnchanged deletes an untouched worktree, keeps one with uncommitted work", () => {
  const repo = makeRepo();
  const base = mkdtempSync(join(tmpdir(), "pify-wf-wt-"));
  try {
    const clean = makeWorktree(repo, base, "review");
    assert.equal(removeIfUnchanged(repo, clean), true, "a read-only step's worktree is removed");
    assert.ok(!existsSync(clean.path), "removed from disk");
    assert.equal(branchExists(repo, clean.branch), false, "and its branch is deleted");

    const dirty = makeWorktree(repo, base, "edit");
    writeFileSync(join(dirty.path, "new.txt"), "work in progress\n");
    assert.equal(removeIfUnchanged(repo, dirty), false, "uncommitted work is kept");
    assert.ok(existsSync(dirty.path), "still on disk");
    assert.equal(branchExists(repo, dirty.branch), true, "branch survives");
  } finally {
    rmrf(base);
    rmrf(repo);
  }
});

test("removeIfUnchanged keeps a worktree that committed, even with a clean status", () => {
  const repo = makeRepo();
  const base = mkdtempSync(join(tmpdir(), "pify-wf-wt-"));
  try {
    const iso = makeWorktree(repo, base, "committed");
    writeFileSync(join(iso.path, "feature.txt"), "shipped\n");
    git(iso.path, ["add", "-A"]);
    git(iso.path, ["commit", "-q", "-m", "did the work"]);
    // Status is clean now, but HEAD has moved off the base commit — this is
    // someone's committed work and must not be deleted.
    assert.equal(git(iso.path, ["status", "--porcelain"]), "");
    assert.equal(removeIfUnchanged(repo, iso), false);
    assert.ok(existsSync(iso.path));
    assert.equal(branchExists(repo, iso.branch), true);
  } finally {
    rmrf(base);
    rmrf(repo);
  }
});

test("removeIfUnchanged never throws on a worktree it cannot inspect", () => {
  const repo = makeRepo();
  try {
    const bogus: Isolation = { path: join(tmpdir(), `pify-wf-missing-${Date.now()}`), branch: "agent/gone" };
    assert.equal(removeIfUnchanged(repo, bogus), false);
  } finally {
    rmrf(repo);
  }
});

test("the isolation epilogue removes a clean worktree and leaves the call record untouched", () => {
  const repo = makeRepo();
  const base = mkdtempSync(join(tmpdir(), "pify-wf-wt-"));
  try {
    const iso = makeWorktree(repo, base, "review");
    const call: { worktree?: string; branch?: string } = {};
    const outcome = settleWorktree(repo, iso, call);
    assert.equal(outcome.removed, true);
    assert.equal(outcome.note, CLEAN_WORKTREE_NOTE);
    assert.ok(!existsSync(iso.path), "clean worktree is gone");
    // Nothing to point at, so no pointer is stamped.
    assert.equal(call.worktree, undefined);
    assert.equal(call.branch, undefined);
  } finally {
    rmrf(base);
    rmrf(repo);
  }
});

test("the isolation epilogue stamps {worktree, branch} on the call for a NON-PROSE outcome", () => {
  // Regression for the leak: a schema / gate-failure / abort / error result
  // returned before the worktree was ever closed out, so a mutating isolated
  // step both leaked its worktree AND lost the pointer to the edits. The
  // epilogue must run on those paths and record the location on the call —
  // the only channel a non-prose value (an object, a null) has to surface it.
  const repo = makeRepo();
  const base = mkdtempSync(join(tmpdir(), "pify-wf-wt-"));
  try {
    const iso = makeWorktree(repo, base, "fix-api");
    writeFileSync(join(iso.path, "patch.txt"), "the child changed files\n");

    const call: { worktree?: string; branch?: string } = {};
    const outcome = settleWorktree(repo, iso, call);

    assert.equal(outcome.removed, false, "a worktree with work is kept");
    assert.equal(call.worktree, iso.path, "the edit location is recorded on the call");
    assert.equal(call.branch, iso.branch);
    assert.ok(existsSync(iso.path), "kept worktree is still on disk");
    assert.match(outcome.note, /worktree_merge/);
  } finally {
    rmrf(base);
    rmrf(repo);
  }
});

test("createIsolationWorktree makes a worktree + branch and avoids collisions", () => {
  const repo = makeRepo();
  const home = mkdtempSync(join(tmpdir(), "pify-wf-home-"));
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  // os.homedir() reads HOME (POSIX) / USERPROFILE (Windows) per call, so this
  // keeps the created worktrees inside a temp dir instead of the real home.
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const a = createIsolationWorktree(repo, "My Feature!");
    assert.equal(a.branch, "agent/my-feature");
    assert.ok(existsSync(a.path), "worktree created on disk");
    assert.ok(a.path.startsWith(home), "placed under the (temp) home, never the real one");

    // A second request for the same slug must not collide with the first.
    const b = createIsolationWorktree(repo, "My Feature!");
    assert.equal(b.branch, "agent/my-feature-2");
    assert.notEqual(a.path, b.path);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevProfile;
    rmrf(home);
    rmrf(repo);
  }
});

test("createIsolationWorktree refuses a non-git directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "pify-wf-nogit-"));
  try {
    assert.throws(() => createIsolationWorktree(dir, "x"), /git repository/);
  } finally {
    rmrf(dir);
  }
});
