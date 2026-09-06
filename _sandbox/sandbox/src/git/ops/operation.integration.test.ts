import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { abortOperation, operationInProgress } from "./operation.js";

/* Against real halted repositories, because the whole module is a reading of git's own on-disk bookkeeping:
 * which marker file each verb writes, and which of them lie. A fixture built from what this code expects would
 * only ever confirm itself. */

const run = promisify(execFile);
const dirs: string[] = [];

afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const git = (dir: string, args: string[]): Promise<{ stdout: string; stderr: string }> => run("git", args, { cwd: dir });

// A repo with two branches that changed the SAME line, so merging or picking across them conflicts.
const conflicting = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "gitop-"));
    dirs.push(dir);
    await git(dir, ["init", "-b", "main"]);
    await git(dir, ["config", "user.email", "t@example.com"]);
    await git(dir, ["config", "user.name", "T"]);
    await writeFile(join(dir, "a.txt"), "base\n");
    await git(dir, ["add", "."]);
    await git(dir, ["commit", "-m", "base"]);

    await git(dir, ["checkout", "-b", "other"]);
    await writeFile(join(dir, "a.txt"), "theirs\n");
    await git(dir, ["commit", "-am", "theirs"]);

    await git(dir, ["checkout", "main"]);
    await writeFile(join(dir, "a.txt"), "ours\n");
    await git(dir, ["commit", "-am", "ours"]);
    return dir;
};

test("a clean repo is not mid-anything", async () => {
    const dir = await conflicting();
    expect(await operationInProgress(dir)).toBeUndefined();
});

test("a conflicted merge is reported, and aborting clears it", async () => {
    const dir = await conflicting();
    await git(dir, ["merge", "other"]).catch(() => undefined);

    expect(await operationInProgress(dir)).toBe("merge");
    await abortOperation(dir, "merge");
    expect(await operationInProgress(dir)).toBeUndefined();
});

test("a conflicted cherry-pick is reported, and aborting clears it", async () => {
    const dir = await conflicting();
    await git(dir, ["cherry-pick", "other"]).catch(() => undefined);

    expect(await operationInProgress(dir)).toBe("cherry-pick");
    await abortOperation(dir, "cherry-pick");
    expect(await operationInProgress(dir)).toBeUndefined();
});

test("a conflicted revert is reported", async () => {
    const dir = await conflicting();
    // Reverting the commit that produced the current content conflicts against the change made after it.
    await git(dir, ["revert", "--no-edit", "HEAD~1"]).catch(() => undefined);
    expect(await operationInProgress(dir)).toBe("revert");
});

/* A REBASE THAT STOPS ON A CONFLICT WRITES MERGE_HEAD TOO. Reading the merge marker first would answer "merge"
 * here and offer `git merge --abort`, which is not what ends a rebase, so the check order is load-bearing and
 * this is the test that holds it in place. */
test("a conflicted rebase reports rebase, not the merge marker it also writes", async () => {
    const dir = await conflicting();
    await git(dir, ["rebase", "other"]).catch(() => undefined);

    expect(await operationInProgress(dir)).toBe("rebase");
    await abortOperation(dir, "rebase");
    expect(await operationInProgress(dir)).toBeUndefined();
});

/* `git am` SHARES the rebase-apply directory with the patch-backend rebase, and `git rebase --abort` cannot end
 * one. Offering an abort here would hand the user a button that fails, so an `am` reports nothing at all. */
test("a halted git am is not reported as a rebase", async () => {
    const dir = await conflicting();
    const { stdout: patch } = await git(dir, ["format-patch", "-1", "other", "--stdout"]);
    const patchFile = join(dir, "conflict.patch");
    await writeFile(patchFile, patch);
    await git(dir, ["am", patchFile]).catch(() => undefined);

    expect(await operationInProgress(dir)).toBeUndefined();
});

/* COMMITTING A RESOLVED PICK BY HAND clears CHERRY_PICK_HEAD but leaves the rest of the sequence queued, and
 * git goes on reporting a cherry-pick in progress. A check that stopped at the marker files would call this
 * worktree clean and offer no way out of it. */
test("a sequence with picks still queued is reported after the marker is cleared", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gitop-seq-"));
    dirs.push(dir);
    // Hand-built sequencer state: the real path to it needs a multi-commit pick that conflicts on the FIRST
    // commit and is then committed manually, which is several minutes of fixture for one boolean.
    await mkdir(join(dir, ".git", "sequencer"), { recursive: true });
    await git(dir, ["init", "-b", "main"]);
    await writeFile(join(dir, ".git", "sequencer", "todo"), "# comment\n\npick abc1234 something queued\n");

    expect(await operationInProgress(dir)).toBe("cherry-pick");
});

/* AN AGENT'S LINKED WORKTREE, which is where most halted operations in this product actually happen. Its
 * `.git` is a POINTER FILE, not a directory, and the markers live in the per-worktree admin dir it names:
 * so a reading that stopped at `<dir>/.git/MERGE_HEAD` would report the worktree clean while git refuses
 * every verb in it. Read off the pointer rather than asked of `rev-parse --git-dir`, which is one spawn per
 * repo per scan for an answer the filesystem holds. */
test("a linked worktree reports its OWN halted state, through its pointer file", async () => {
    const dir = await conflicting();
    const linked = join(dir, "..", `wt-${dirs.length}`);
    dirs.push(linked);
    await git(dir, ["worktree", "add", "-q", linked, "other"]);

    // The main checkout is untouched throughout: the whole point of per-worktree markers.
    await git(linked, ["merge", "main"]).catch(() => undefined);
    expect(await operationInProgress(linked)).toBe("merge");
    expect(await operationInProgress(dir)).toBeUndefined();

    await abortOperation(linked, "merge");
    expect(await operationInProgress(linked)).toBeUndefined();
});

test("a directory that is not a repo at all reports nothing rather than throwing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gitop-bare-"));
    dirs.push(dir);
    expect(await operationInProgress(dir)).toBeUndefined();
});

test("a queued revert sequence is reported as a revert, the todo being shared", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gitop-seq2-"));
    dirs.push(dir);
    await git(dir, ["init", "-b", "main"]);
    await mkdir(join(dir, ".git", "sequencer"), { recursive: true });
    await writeFile(join(dir, ".git", "sequencer", "todo"), "revert abc1234 something queued\n");

    expect(await operationInProgress(dir)).toBe("revert");
});
