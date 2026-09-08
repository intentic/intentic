import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import { afterEach, expect, test } from "vitest";
import { changedFiles, changesAgainstBase, changesBetweenRefs, dirtyPathsAcross } from "./changes.js";
import {
    checkoutRef,
    cherryPick,
    commitChanges,
    commitLog,
    createBranchAt,
    createTagAt,
    dropCommit,
    resetTo,
    revertCommit,
} from "./changes-commits.js";
import { commitFileDiff, conflictedFileDiff, refFileDiff, stagedFileDiff, unstagedFileDiff, workingFileDiff } from "./changes-diff.js";
import { commitIndex, discardPaths, stageAll, stagePaths, unstagePaths } from "./changes-index.js";

const exec = promisify(execFile);
const sh = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();
const author = { name: "intentic", email: "agent@intentic.dev" };

// For assertions that only care whether the tree is dirty; which list it landed in is covered above.
const bothSides = async (dir: string): Promise<unknown[]> => {
    const { conflicted, staged, unstaged } = await changedFiles(dir);
    return [...conflicted, ...staged, ...unstaged];
};

// Repo stopped mid-merge on one conflicted file, `a.txt` ('ours' = main, 'theirs' = side).
const conflictedRepo = async (): Promise<string> => {
    const dir = await tempRepo();
    const trunk = await sh(dir, "branch", "--show-current");
    await sh(dir, "checkout", "-q", "-b", "side");
    await writeFile(join(dir, "a.txt"), "theirs\n");
    await sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "theirs");
    await sh(dir, "checkout", "-q", trunk);
    await writeFile(join(dir, "a.txt"), "ours\n");
    await sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "ours");
    // `git merge` validates identity before it can conflict; no identity fails silently into a non-conflicted repo.
    await sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "merge", "side").catch(() => undefined);
    return dir;
};

const tempDirs: string[] = [];
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

// Real repo with one commit (a.txt tracked, .gitignore ignoring .env*); the shared fixture for these tests.
const tempRepo = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "intentic-changes-"));
    tempDirs.push(dir);
    await sh(dir, "init", "-q");
    await writeFile(join(dir, ".gitignore"), ".env*\n");
    await writeFile(join(dir, "a.txt"), "one\n");
    await sh(dir, "add", "-A");
    await sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
    return dir;
};

test("changedFiles maps porcelain states, expands untracked dirs, and skips ignored files", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "old.txt"), "x\n");
    await sh(dir, "add", "-A");
    await sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "more");

    await writeFile(join(dir, "a.txt"), "two\n"); // modified
    await rm(join(dir, "old.txt")); // deleted
    await mkdir(join(dir, "new"), { recursive: true });
    await writeFile(join(dir, "new", "b.txt"), "b\n"); // untracked, inside an untracked dir
    await writeFile(join(dir, ".env"), "SECRET=x\n"); // ignored

    const { branch, staged, unstaged } = await changedFiles(dir);
    expect(branch).not.toBe("");
    expect(staged).toEqual([]);
    // Untracked files have no numstat entry; their count comes from the file itself (the whole thing is an addition).
    expect(unstaged).toContainEqual({ path: "a.txt", status: "modified", additions: 1, deletions: 1 });
    expect(unstaged).toContainEqual({ path: "old.txt", status: "deleted", additions: 0, deletions: 1 });
    expect(unstaged).toContainEqual({ path: "new/b.txt", status: "added", additions: 1, deletions: 0 });
    expect(unstaged.some((change) => change.path.includes(".env"))).toBe(false);
});

// Absent on an unborn HEAD, never a fabricated empty-tree sha a caller could wrongly attribute against.
test("changedFiles reports HEAD's sha alongside the branch, and nothing on an unborn repo", async () => {
    const dir = await tempRepo();
    expect(await sh(dir, "rev-parse", "HEAD")).toBe((await changedFiles(dir)).head);

    const unborn = await mkdtemp(join(tmpdir(), "intentic-changes-unborn-"));
    tempDirs.push(unborn);
    await sh(unborn, "init", "-q", "-b", "main");
    const fresh = await changedFiles(unborn);
    expect(fresh.head).toBeUndefined();
    expect(fresh.branch).toBe("main");
});

test("changedFiles reports a partially staged file on BOTH sides, with each side's own line counts", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "a.txt"), "two\n");
    await sh(dir, "add", "a.txt"); // index now holds "two"
    await writeFile(join(dir, "a.txt"), "three\n"); // worktree moved on again (the classic MM case)

    const { staged, unstaged } = await changedFiles(dir);
    expect(staged).toEqual([{ path: "a.txt", status: "modified", additions: 1, deletions: 1 }]);
    expect(unstaged).toEqual([{ path: "a.txt", status: "modified", additions: 1, deletions: 1 }]);
});

test("changedFiles puts an added-then-staged file on the staged side only", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "fresh.txt"), "hello\n");
    await sh(dir, "add", "fresh.txt");

    const { staged, unstaged } = await changedFiles(dir);
    expect(staged).toEqual([{ path: "fresh.txt", status: "added", additions: 1, deletions: 0 }]);
    expect(unstaged).toEqual([]);
});

test("an unmerged path is its own third list, in NEITHER of the two sides", async () => {
    const dir = await conflictedRepo();

    const { conflicted, staged, unstaged } = await changedFiles(dir);
    // Reporting it as staged would claim it's ready to commit, which git refuses while a path is unmerged.
    expect(conflicted).toEqual([{ path: "a.txt", status: "conflicted" }]);
    expect(staged).toEqual([]);
    expect(unstaged).toEqual([]);
});

test("`git diff` reports an unmerged path twice: the second record must not overwrite the conflict", async () => {
    const dir = await conflictedRepo();
    // The worktree pass emits both `U a.txt` and `M a.txt`; a last-record-wins parse would downgrade the conflict.
    const raw = await sh(dir, "diff", "--name-status");
    expect(raw.split("\n").length).toBe(2);

    expect((await changedFiles(dir)).conflicted).toEqual([{ path: "a.txt", status: "conflicted" }]);
});

test("staging an unmerged path resolves it: it moves out of `conflicted` and into `staged`", async () => {
    const dir = await conflictedRepo();
    await writeFile(join(dir, "a.txt"), "resolved\n");
    // `git add` on an unmerged path is the resolve gesture; the panel's "Mark resolved" is this request.
    await stagePaths(dir, ["a.txt"]);

    const { conflicted, staged } = await changedFiles(dir);
    expect(conflicted).toEqual([]);
    expect(staged).toEqual([{ path: "a.txt", status: "modified", additions: 1, deletions: 1 }]);
    expect(await commitIndex(dir, "resolve the merge", author)).toBe(true);
});

test("a staged rename that was then edited lands on both sides: renamed on one, modified on the other", async () => {
    const dir = await tempRepo();
    await sh(dir, "mv", "a.txt", "b.txt");
    await writeFile(join(dir, "b.txt"), "one\nmore\n"); // the rename is staged; this edit is not

    const { staged, unstaged } = await changedFiles(dir);
    // The origin path belongs to the side the rename is on: the index renamed it, the worktree only modified it.
    expect(staged).toEqual([{ path: "b.txt", status: "renamed", from: "a.txt", additions: 0, deletions: 0 }]);
    expect(unstaged).toEqual([{ path: "b.txt", status: "modified", additions: 1, deletions: 0 }]);
});

test("changedFiles costs one status read plus a numstat per non-empty side", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "a.txt"), "two\n"); // unstaged only, staged stays empty
    const spawns: string[][] = [];
    const counting: GitRunner = async (cwd, args) => {
        spawns.push([...args]);
        return defaultGit(cwd, args);
    };

    await changedFiles(dir, counting);
    expect(spawns).toHaveLength(2);
    expect(spawns[0]).toContain("--porcelain=v2");
    // A poller must not take index.lock for a read-only refresh; agents race it for that lock.
    expect(spawns[0]).toContain("--no-optional-locks");
    expect(spawns[1]).toContain("--numstat");
});

test("conflictedFileDiff shows HEAD vs the worktree, because an unmerged path has no stage 0", async () => {
    const dir = await conflictedRepo();

    // `:0:a.txt` doesn't exist mid-conflict (stages 1/2/3); reads as a deletion: HEAD's content, then nothing.
    expect(await stagedFileDiff(dir, "a.txt")).toEqual({ before: "ours\n" });

    const diff = await conflictedFileDiff(dir, "a.txt");
    expect(diff.before).toBe("ours\n");
    // The worktree side carries git's conflict markers, what the user has to resolve.
    expect(diff.after).toContain("<<<<<<<");
    expect(diff.after).toContain("theirs");
});

test("commitLog returns commits newest-first with parents, refs, and the HEAD flag", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "a.txt"), "two\n");
    await sh(dir, "add", "-A");
    await sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "second\n\nwith a body");

    const { branch, commits } = await commitLog(dir, 50);
    expect(commits).toHaveLength(2);
    expect(commits[0]?.subject).toBe("second");
    expect(commits[0]?.body).toBe("with a body");
    expect(commits[1]?.subject).toBe("init");
    expect(commits[0]?.parents).toEqual([commits[1]!.sha]);
    expect(commits[1]?.parents).toEqual([]);
    expect(commits[0]?.head).toBe(true);
    expect(commits[1]?.head).toBe(false);
    expect(branch).not.toBe(undefined);
    expect(commits[0]?.refs).toContain(branch);
    expect(commits[0]?.refs).not.toContain("HEAD");
});

// Without `hasMore`, the graph can't tell 'exactly N commits' from 'thousands, showing the newest N'.
test("commitLog pages through a history and says whether more is behind it", async () => {
    const dir = await tempRepo();
    for (const text of ["two", "three", "four"]) {
        await writeFile(join(dir, "a.txt"), `${text}\n`);
        await sh(dir, "add", "-A");
        await sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", text);
    }

    const first = await commitLog(dir, 2);
    expect(first.commits.map((commit) => commit.subject)).toEqual(["four", "three"]);
    expect(first.commits).toHaveLength(2);
    expect(first.hasMore).toBe(true);

    const second = await commitLog(dir, 2, 2);
    expect(second.commits.map((commit) => commit.subject)).toEqual(["two", "init"]);
    expect(second.hasMore).toBe(false);

    expect((await commitLog(dir, 4)).hasMore).toBe(false);
});

test("commitLog degrades to an empty list on a repo with no commits", async () => {
    const dir = await mkdtemp(join(tmpdir(), "intentic-changes-"));
    tempDirs.push(dir);
    await sh(dir, "init", "-q");
    const { commits } = await commitLog(dir, 50);
    expect(commits).toEqual([]);
});

test("commitChanges and commitFileDiff describe one commit's file delta", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "a.txt"), "two\n"); // modified
    await writeFile(join(dir, "new.txt"), "n\n"); // added
    await sh(dir, "add", "-A");
    await sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "edit");
    const head = await sh(dir, "rev-parse", "HEAD");

    const files = await commitChanges(dir, head);
    expect(files).toContainEqual({ path: "a.txt", status: "modified", additions: 1, deletions: 1 });
    expect(files).toContainEqual({ path: "new.txt", status: "added", additions: 1, deletions: 0 });

    const modified = await commitFileDiff(dir, head, "a.txt");
    expect(modified.before).toBe("one\n");
    expect(modified.after).toBe("two\n");
    const added = await commitFileDiff(dir, head, "new.txt");
    expect(added.before).toBe(undefined);
    expect(added.after).toBe("n\n");
});

test("commitChanges reads a root commit's files as additions (vs the empty tree)", async () => {
    const dir = await tempRepo(); // "init" IS the root commit
    const root = await sh(dir, "rev-parse", "HEAD");
    const files = await commitChanges(dir, root);
    expect(files).toContainEqual({ path: "a.txt", status: "added", additions: 1, deletions: 0 });
});

test("createBranchAt points a new branch at a commit without moving HEAD or the worktree", async () => {
    const dir = await tempRepo();
    const root = await sh(dir, "rev-parse", "HEAD");
    const headBefore = await sh(dir, "rev-parse", "HEAD");
    await createBranchAt(dir, "feature/x", root);
    expect(await sh(dir, "rev-parse", "feature/x")).toBe(root);
    expect(await sh(dir, "rev-parse", "HEAD")).toBe(headBefore); // HEAD unmoved
    expect(await bothSides(dir)).toEqual([]); // worktree clean
    // A duplicate name is git's own error; the route lets it propagate rather than catching it.
    await expect(createBranchAt(dir, "feature/x", root)).rejects.toThrow();
});

test("revertCommit adds an inverse commit that undoes the change", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "a.txt"), "two\n");
    await sh(dir, "add", "-A");
    await sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "change a");
    const target = await sh(dir, "rev-parse", "HEAD");

    const result = await revertCommit(dir, target, author);
    expect(result).toEqual({ ok: true });
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("one\n");
    expect(await sh(dir, "rev-list", "--count", "HEAD")).toBe("3");
    expect(await sh(dir, "rev-parse", "HEAD^")).toBe(target);
});

test("revertCommit reports a conflict cleanly instead of leaving the worktree mid-revert", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "a.txt"), "two\n");
    await sh(dir, "add", "-A");
    await sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "two");
    const target = await sh(dir, "rev-parse", "HEAD");
    // A later edit to the same line is what makes reverting `target` conflict.
    await writeFile(join(dir, "a.txt"), "three\n");
    await sh(dir, "add", "-A");
    await sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "three");

    const result = await revertCommit(dir, target, author);
    expect(result).toEqual({ ok: false, reason: "conflict" });
    expect(existsSync(join(dir, ".git", "REVERT_HEAD"))).toBe(false);
    expect(await bothSides(dir)).toEqual([]);
});

test("createTagAt tags a commit", async () => {
    const dir = await tempRepo();
    const root = await sh(dir, "rev-parse", "HEAD");
    await createTagAt(dir, "v1", root);
    expect(await sh(dir, "rev-parse", "v1^{commit}")).toBe(root);
});

test("checkoutRef detaches HEAD at a commit", async () => {
    const dir = await tempRepo();
    const root = await sh(dir, "rev-parse", "HEAD");
    await checkoutRef(dir, root);
    expect(await sh(dir, "rev-parse", "HEAD")).toBe(root);
    expect(await sh(dir, "branch", "--show-current")).toBe(""); // detached
});

test("cherryPick copies a commit's change onto the current branch", async () => {
    const dir = await tempRepo();
    const main = await sh(dir, "rev-parse", "--abbrev-ref", "HEAD");
    await sh(dir, "checkout", "-q", "-b", "side");
    await writeFile(join(dir, "s.txt"), "s\n");
    await sh(dir, "add", "-A");
    await sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "add s");
    const pick = await sh(dir, "rev-parse", "HEAD");
    await sh(dir, "checkout", "-q", main);

    const result = await cherryPick(dir, pick, author);
    expect(result).toEqual({ ok: true });
    expect(existsSync(join(dir, "s.txt"))).toBe(true);
});

test("resetTo --hard moves the branch and discards the worktree change", async () => {
    const dir = await tempRepo();
    const base = await sh(dir, "rev-parse", "HEAD");
    await writeFile(join(dir, "a.txt"), "two\n");
    await sh(dir, "add", "-A");
    await sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "two");

    await resetTo(dir, base, "hard");
    expect(await sh(dir, "rev-parse", "HEAD")).toBe(base);
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("one\n");
});

test("dropCommit removes a commit, replaying later ones onto its parent", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "b.txt"), "b\n");
    await sh(dir, "add", "-A");
    await sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "add b");
    const drop = await sh(dir, "rev-parse", "HEAD");
    await writeFile(join(dir, "c.txt"), "c\n");
    await sh(dir, "add", "-A");
    await sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "add c");

    const branch = await sh(dir, "branch", "--show-current");
    const result = await dropCommit(dir, drop, author);
    expect(result).toEqual({ ok: true });
    expect(existsSync(join(dir, "b.txt"))).toBe(false);
    expect(existsSync(join(dir, "c.txt"))).toBe(true);
    expect(await sh(dir, "rev-list", "--count", "HEAD")).toBe("2");
    // On the branch, not just the worktree: `HEAD` as the rebase's branch checks out a commit, detaching it instead.
    expect(await sh(dir, "branch", "--show-current")).toBe(branch);
    expect(await sh(dir, "rev-list", "--count", branch)).toBe("2");
});

test("changedFiles reports a staged rename with its original path", async () => {
    const dir = await tempRepo();
    await sh(dir, "mv", "a.txt", "b.txt");
    const { staged, unstaged } = await changedFiles(dir);
    // `git mv` stages the rename (index-side; git detects against HEAD). A pure rename moves no lines (0/0).
    expect(staged).toEqual([{ path: "b.txt", status: "renamed", from: "a.txt", additions: 0, deletions: 0 }]);
    expect(unstaged).toEqual([]);
});

test("changedFiles leaves a binary file's counts undefined", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "blob.bin"), Buffer.from([0, 1, 2, 0, 4]));
    await sh(dir, "add", "-A");
    const { staged } = await changedFiles(dir);
    // Git's numstat prints `-\t-` for binary; both counts stay undefined.
    expect(staged).toEqual([{ path: "blob.bin", status: "added" }]);
});

test("changedFiles treats everything as added on an unborn HEAD", async () => {
    const dir = await mkdtemp(join(tmpdir(), "intentic-changes-"));
    tempDirs.push(dir);
    await sh(dir, "init", "-q");
    await writeFile(join(dir, "a.txt"), "one\n");
    expect((await changedFiles(dir)).unstaged).toEqual([{ path: "a.txt", status: "added", additions: 1, deletions: 0 }]);

    // Staged on an unborn HEAD still reports: the index diffs against the empty tree, not a HEAD that doesn't exist.
    await sh(dir, "add", "a.txt");
    const afterStage = await changedFiles(dir);
    expect(afterStage.staged).toEqual([{ path: "a.txt", status: "added", additions: 1, deletions: 0 }]);
    expect(afterStage.unstaged).toEqual([]);
});

test("commitIndex commits what is staged and leaves unstaged work untouched", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "ready.txt"), "ready\n");
    await writeFile(join(dir, "later.txt"), "later\n");
    await sh(dir, "add", "ready.txt");

    expect(await commitIndex(dir, "staged only", author)).toBe(true);
    expect(await sh(dir, "ls-tree", "--name-only", "HEAD")).toContain("ready.txt");
    const { staged, unstaged } = await changedFiles(dir);
    expect(staged).toEqual([]);
    expect(unstaged).toEqual([{ path: "later.txt", status: "added", additions: 1, deletions: 0 }]);
});

test("stagePaths then commitIndex records only the named paths, leaving the rest of the worktree uncommitted", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "filtered.txt"), "the filtered agent's work\n");
    await writeFile(join(dir, "other.txt"), "somebody else's work\n");

    await stagePaths(dir, ["filtered.txt"]);
    expect(await commitIndex(dir, "feat: the filtered work", author)).toBe(true);

    expect(await sh(dir, "ls-tree", "--name-only", "HEAD")).not.toContain("other.txt");
    const { staged, unstaged } = await changedFiles(dir);
    expect(staged).toEqual([]);
    expect(unstaged.map((change) => change.path)).toEqual(["other.txt"]);
});

test("commitIndex is a no-op false when nothing is staged, even with a dirty worktree", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "loose.txt"), "loose\n");
    expect(await commitIndex(dir, "nothing staged", author)).toBe(false);
    expect(await sh(dir, "log", "--format=%s")).toBe("init");
});

test("stagePaths and unstagePaths move a path between the two sides without touching the worktree", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "a.txt"), "two\n");

    await stagePaths(dir, ["a.txt"]);
    const afterStage = await changedFiles(dir);
    expect(afterStage.staged.map((change) => change.path)).toEqual(["a.txt"]);
    expect(afterStage.unstaged).toEqual([]);

    await unstagePaths(dir, ["a.txt"]);
    const afterUnstage = await changedFiles(dir);
    expect(afterUnstage.staged).toEqual([]);
    expect(afterUnstage.unstaged.map((change) => change.path)).toEqual(["a.txt"]);
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("two\n");
});

test("stagePaths covers a list too long for one command line", async () => {
    const dir = await tempRepo();
    // 600 paths of ~250 bytes is ~150 KB, more than one invocation may carry.
    const paths = Array.from({ length: 600 }, (_, index) => `${String(index).padStart(4, "0")}-${"n".repeat(240)}.txt`);
    await Promise.all(paths.map((path) => writeFile(join(dir, path), "x\n")));

    await stagePaths(dir, paths);
    const { staged, unstaged } = await changedFiles(dir);
    expect(staged.map((change) => change.path).toSorted()).toEqual(paths.toSorted());
    expect(unstaged).toEqual([]);

    // `git reset` has the same argv ceiling as `git add`, so unstaging needs the same splitting.
    await unstagePaths(dir, paths);
    expect((await changedFiles(dir)).staged).toEqual([]);
});

test("stageAll stages every pending change, untracked files included, ignoring ignored ones", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "a.txt"), "two\n");
    await writeFile(join(dir, "fresh.txt"), "new\n");
    await writeFile(join(dir, ".env"), "secret\n");

    await stageAll(dir);
    const { staged, unstaged } = await changedFiles(dir);
    expect(staged.map((change) => change.path).toSorted()).toEqual(["a.txt", "fresh.txt"]);
    expect(unstaged).toEqual([]);
});

test("stagePaths stages a deletion, which a bare `git add` would skip", async () => {
    const dir = await tempRepo();
    await rm(join(dir, "a.txt"));
    await stagePaths(dir, ["a.txt"]);
    expect((await changedFiles(dir)).staged).toEqual([{ path: "a.txt", status: "deleted", additions: 0, deletions: 1 }]);
});

test("unstagePaths on an unborn HEAD returns the file to untracked instead of failing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "intentic-changes-"));
    tempDirs.push(dir);
    await sh(dir, "init", "-q");
    await writeFile(join(dir, "a.txt"), "one\n");
    await stagePaths(dir, ["a.txt"]);

    // No HEAD to `reset` against; the index entry is dropped instead.
    await unstagePaths(dir, ["a.txt"]);
    const { staged, unstaged } = await changedFiles(dir);
    expect(staged).toEqual([]);
    expect(unstaged).toEqual([{ path: "a.txt", status: "added", additions: 1, deletions: 0 }]);
    expect(existsSync(join(dir, "a.txt"))).toBe(true);
});

test("discardPaths restores a tracked file, deletes an untracked one, and leaves the rest alone", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "a.txt"), "two\n");
    await writeFile(join(dir, "junk.txt"), "junk\n");
    await writeFile(join(dir, "kept.txt"), "kept\n");

    await discardPaths(dir, ["a.txt", "junk.txt"]);
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("one\n");
    expect(existsSync(join(dir, "junk.txt"))).toBe(false);
    expect(await bothSides(dir)).toEqual([{ path: "kept.txt", status: "added", additions: 1, deletions: 0 }]);
});

// Git reads a bare path after `--` as a pathspec: without `--literal-pathspecs`, brackets match untargeted siblings.
// Pinned across stage/unstage/discard together: one flag covers all three, a regression breaks all three at once.
test("a path with glob characters acts on that file only, never on the sibling its brackets match", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "report[1].txt"), "bracket\n");
    await writeFile(join(dir, "report1.txt"), "sibling\n");
    await sh(dir, "add", "-A");
    await sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "reports");

    await writeFile(join(dir, "report[1].txt"), "bracket edited\n");
    await writeFile(join(dir, "report1.txt"), "sibling edited\n");
    await stagePaths(dir, ["report[1].txt"]);
    const afterStage = await changedFiles(dir);
    expect(afterStage.staged.map((change) => change.path)).toEqual(["report[1].txt"]);
    expect(afterStage.unstaged.map((change) => change.path)).toEqual(["report1.txt"]);

    await unstagePaths(dir, ["report[1].txt"]);
    expect((await changedFiles(dir)).staged).toEqual([]);

    // Discard: the untracked sibling must keep existing, the case where the bug destroyed work outright.
    await writeFile(join(dir, "fresh[1].txt"), "new bracket\n");
    await writeFile(join(dir, "fresh1.txt"), "new sibling\n");
    await discardPaths(dir, ["report[1].txt", "fresh[1].txt"]);

    expect(await readFile(join(dir, "report[1].txt"), "utf8")).toBe("bracket\n");
    expect(await readFile(join(dir, "report1.txt"), "utf8")).toBe("sibling edited\n");
    expect(existsSync(join(dir, "fresh[1].txt"))).toBe(false);
    expect(existsSync(join(dir, "fresh1.txt"))).toBe(true);
});

test("discardPaths undoes both legs of a staged rename from either path", async () => {
    const dir = await tempRepo();
    await sh(dir, "mv", "a.txt", "b.txt");
    await discardPaths(dir, ["b.txt"]);
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("one\n");
    expect(existsSync(join(dir, "b.txt"))).toBe(false);
    expect(await bothSides(dir)).toEqual([]);
});

test("discardPaths without paths discards everything but ignored files survive", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "a.txt"), "two\n");
    await writeFile(join(dir, "junk.txt"), "junk\n");
    await writeFile(join(dir, ".env"), "SECRET=x\n");
    await sh(dir, "add", "junk.txt"); // staged state must not shield it

    await discardPaths(dir, undefined);
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("one\n");
    expect(existsSync(join(dir, "junk.txt"))).toBe(false);
    expect(await readFile(join(dir, ".env"), "utf8")).toBe("SECRET=x\n");
    expect(await bothSides(dir)).toEqual([]);
});

test("workingFileDiff ships both sides, one side for added/deleted, and flags binary", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "a.txt"), "two\n");
    expect(await workingFileDiff(dir, "a.txt", "HEAD")).toEqual({ before: "one\n", after: "two\n" });

    await writeFile(join(dir, "new.txt"), "new\n");
    expect(await workingFileDiff(dir, "new.txt", "HEAD")).toEqual({ after: "new\n" });

    await rm(join(dir, "a.txt"));
    expect(await workingFileDiff(dir, "a.txt", "HEAD")).toEqual({ before: "one\n" });

    await writeFile(join(dir, "blob.bin"), Buffer.from([0, 1, 2]));
    expect(await workingFileDiff(dir, "blob.bin", "HEAD")).toEqual({ binary: true });
});

test("the two side diffs of a partially staged file are genuinely different, and neither is HEAD↔worktree", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "a.txt"), "two\n");
    await sh(dir, "add", "a.txt"); // index holds "two"
    await writeFile(join(dir, "a.txt"), "three\n"); // worktree moves on again (the classic MM case)

    // HEAD → index: what a bare commit would record.
    expect(await stagedFileDiff(dir, "a.txt")).toEqual({ before: "one\n", after: "two\n" });
    // Index → worktree: what's still loose.
    expect(await unstagedFileDiff(dir, "a.txt")).toEqual({ before: "two\n", after: "three\n" });
    // The old single diff, HEAD → worktree, matches neither of the two above.
    expect(await workingFileDiff(dir, "a.txt", "HEAD")).toEqual({ before: "one\n", after: "three\n" });
});

test("side diffs report the leg an added or deleted file doesn't have", async () => {
    const dir = await tempRepo();
    // Untracked: no index entry, so the unstaged diff has no before side and the staged diff is empty.
    await writeFile(join(dir, "fresh.txt"), "fresh\n");
    expect(await unstagedFileDiff(dir, "fresh.txt")).toEqual({ after: "fresh\n" });
    expect(await stagedFileDiff(dir, "fresh.txt")).toEqual({});

    // Staged as new: the staged side now has an after and no before.
    await sh(dir, "add", "fresh.txt");
    expect(await stagedFileDiff(dir, "fresh.txt")).toEqual({ after: "fresh\n" });
    // Index and worktree agree, so the unstaged diff is a no-change pair rather than an absence.
    expect(await unstagedFileDiff(dir, "fresh.txt")).toEqual({ before: "fresh\n", after: "fresh\n" });

    // Staged deletion: a before side and no after.
    await rm(join(dir, "a.txt"));
    await stagePaths(dir, ["a.txt"]);
    expect(await stagedFileDiff(dir, "a.txt")).toEqual({ before: "one\n" });
});

test("either side being binary flags the whole diff", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "blob.bin"), Buffer.from([0, 1, 2]));
    await sh(dir, "add", "blob.bin");
    expect(await stagedFileDiff(dir, "blob.bin")).toEqual({ binary: true });
    expect(await unstagedFileDiff(dir, "blob.bin")).toEqual({ binary: true });
});

test("workingFileDiff against a fixed base sees committed work as changed", async () => {
    const dir = await tempRepo();
    const base = await sh(dir, "rev-parse", "HEAD");
    await writeFile(join(dir, "a.txt"), "committed\n");
    await sh(dir, "add", "-A");
    await sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "agent work");
    expect(await workingFileDiff(dir, "a.txt", "HEAD")).toEqual({ before: "committed\n", after: "committed\n" });
    expect(await workingFileDiff(dir, "a.txt", base)).toEqual({ before: "one\n", after: "committed\n" });
});

test("changesAgainstBase folds committed + staged + unstaged + untracked into one delta", async () => {
    const dir = await tempRepo();
    const base = await sh(dir, "rev-parse", "HEAD");
    // Committed since base:
    await writeFile(join(dir, "a.txt"), "committed\n");
    await sh(dir, "add", "-A");
    await sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "agent work");
    // Staged:
    await writeFile(join(dir, "staged.txt"), "staged\n");
    await sh(dir, "add", "staged.txt");
    // Unstaged edit on top of the commit:
    await writeFile(join(dir, "a.txt"), "unstaged on top\n");
    // Untracked:
    await writeFile(join(dir, "fresh.txt"), "fresh\n");
    // Ignored: must not appear:
    await writeFile(join(dir, ".env"), "SECRET=x\n");

    const changes = await changesAgainstBase(dir, base);
    // Tracked deltas carry numstat counts; the untracked file is counted from disk, weighing the same either way.
    expect(changes).toContainEqual({ path: "a.txt", status: "modified", additions: 1, deletions: 1 });
    expect(changes).toContainEqual({ path: "staged.txt", status: "added", additions: 1, deletions: 0 });
    expect(changes).toContainEqual({ path: "fresh.txt", status: "added", additions: 1, deletions: 0 });
    expect(changes.some((change) => change.path.includes(".env"))).toBe(false);
    expect(changes).toHaveLength(3);
});

// Review header and fleet card sum these counts; committing must move a file between lists, not change its weight.
test("an untracked file weighs the same as the identical file one commit later", async () => {
    const dir = await tempRepo();
    const base = await sh(dir, "rev-parse", "HEAD");
    await writeFile(join(dir, "fresh.txt"), "one\ntwo\nthree\n");

    const untracked = await changesAgainstBase(dir, base);
    await sh(dir, "add", "-A");
    await sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "commit it");
    const committed = await changesAgainstBase(dir, base);

    expect(untracked).toEqual([{ path: "fresh.txt", status: "added", additions: 3, deletions: 0 }]);
    expect(committed).toEqual(untracked);
});

// A trailing partial line still counts, so it isn't simply newline count.
// Binary has no count at all; empty is a real zero, not missing.
test("untracked line counts follow git's own rules for partial lines, empty and binary files", async () => {
    const dir = await tempRepo();
    const base = await sh(dir, "rev-parse", "HEAD");
    await writeFile(join(dir, "partial.txt"), "one\ntwo"); // no trailing newline
    await writeFile(join(dir, "empty.txt"), "");
    await writeFile(join(dir, "blob.bin"), Buffer.from([0x61, 0x00, 0x62]));

    const byPath = new Map((await changesAgainstBase(dir, base)).map((change) => [change.path, change]));
    expect(byPath.get("partial.txt")).toEqual({ path: "partial.txt", status: "added", additions: 2, deletions: 0 });
    expect(byPath.get("empty.txt")).toEqual({ path: "empty.txt", status: "added", additions: 0, deletions: 0 });
    expect(byPath.get("blob.bin")).toEqual({ path: "blob.bin", status: "added" });
});

// Both of changesAgainstBase's passes must ask for renames, or the name-status list and numstat map disagree.
test("changesAgainstBase detects a rename even where the repo has diff.renames off", async () => {
    const dir = await tempRepo();
    await sh(dir, "config", "diff.renames", "false");
    const base = await sh(dir, "rev-parse", "HEAD");
    await sh(dir, "mv", "a.txt", "b.txt");
    await sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "rename");
    expect(await changesAgainstBase(dir, base)).toEqual([{ path: "b.txt", status: "renamed", from: "a.txt", additions: 0, deletions: 0 }]);
});

test("changesAgainstBase reports a committed rename with its original path", async () => {
    const dir = await tempRepo();
    const base = await sh(dir, "rev-parse", "HEAD");
    await sh(dir, "mv", "a.txt", "b.txt");
    await sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "rename");
    expect(await changesAgainstBase(dir, base)).toEqual([{ path: "b.txt", status: "renamed", from: "a.txt", additions: 0, deletions: 0 }]);
});

// An archived agent's review runs on refs alone, since the worktree is gone; must answer the same as the checkout pair.
test("changesBetweenRefs reads the same delta from a branch that changesAgainstBase read from a checkout", async () => {
    const dir = await tempRepo();
    const base = await sh(dir, "rev-parse", "HEAD");
    await sh(dir, "checkout", "-q", "-b", "agent/c1");
    await writeFile(join(dir, "a.txt"), "agent edit\n");
    await writeFile(join(dir, "fresh.txt"), "fresh\n");
    await sh(dir, "add", "-A");
    await sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "Agent: work");
    const fromCheckout = await changesAgainstBase(dir, base);
    // Back on the base, as the main repo would be; the branch alone is left of the agent.
    await sh(dir, "checkout", "-q", "-");

    const fromRefs = await changesBetweenRefs(dir, base, "agent/c1");
    expect(fromRefs).toEqual(fromCheckout);
    expect(fromRefs).toContainEqual({ path: "a.txt", status: "modified", additions: 1, deletions: 1 });
    expect(fromRefs).toContainEqual({ path: "fresh.txt", status: "added", additions: 1, deletions: 0 });
});

test("refFileDiff pairs the base blob with the branch blob, and handles a one-sided file", async () => {
    const dir = await tempRepo();
    const base = await sh(dir, "rev-parse", "HEAD");
    await sh(dir, "checkout", "-q", "-b", "agent/c1");
    await writeFile(join(dir, "a.txt"), "agent edit\n");
    await writeFile(join(dir, "added.txt"), "new\n");
    await sh(dir, "add", "-A");
    await sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "Agent: work");
    await sh(dir, "checkout", "-q", "-");

    expect(await refFileDiff(dir, "a.txt", base, "agent/c1")).toEqual({ before: "one\n", after: "agent edit\n" });
    // Added by the agent: no before side, matching the working-tree pair's report.
    expect(await refFileDiff(dir, "added.txt", base, "agent/c1")).toEqual({ after: "new\n" });
});

// Files too big to ship whole: past MAX_FILE_DIFF_BYTES neither side travels; a patch of changed regions goes instead.
// These pin the pairing (which two things get compared); clipping and degraded cases are diff-partial.test.ts's.

// A file comfortably over the 512 KiB cap, with a known line to edit partway through.
const BIG_LINES = 40_000;
const bigFile = (marker: string): string =>
    Array.from({ length: BIG_LINES }, (_, index) => (index === 20_000 ? marker : `line ${index} ${"x".repeat(10)}`)).join("\n");

test("an oversized unstaged file sends the changed region, at the file's own line numbers", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "big.txt"), bigFile("before"));
    await sh(dir, "add", "-A");
    await sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "big");
    await writeFile(join(dir, "big.txt"), bigFile("after"));

    const diff = await unstagedFileDiff(dir, "big.txt");
    expect(diff.before).toBeUndefined();
    expect(diff.after).toBeUndefined();
    expect(diff.partial?.beforeBytes).toBeGreaterThan(512 * 1024);
    expect(diff.partial?.afterBytes).toBeGreaterThan(512 * 1024);
    // The one changed region, at line 20,001, holding the line that moved.
    expect(diff.partial?.patch).toContain("@@ -19998,7 +19998,7 @@");
    expect(diff.partial?.patch).toContain("-before");
    expect(diff.partial?.patch).toContain("+after");
    expect(diff.partial?.more).toBeUndefined();
});

test("an oversized staged file is HEAD↔index, not HEAD↔worktree", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "big.txt"), bigFile("committed"));
    await sh(dir, "add", "-A");
    await sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "big");
    await writeFile(join(dir, "big.txt"), bigFile("staged"));
    await sh(dir, "add", "-A");
    // Edited again after staging: staged and unstaged are different diffs; staged must not mention the worktree edit.
    await writeFile(join(dir, "big.txt"), bigFile("worktree"));

    const staged = await stagedFileDiff(dir, "big.txt");
    expect(staged.partial?.patch).toContain("-committed");
    expect(staged.partial?.patch).toContain("+staged");
    expect(staged.partial?.patch).not.toContain("worktree");

    const unstaged = await unstagedFileDiff(dir, "big.txt");
    expect(unstaged.partial?.patch).toContain("-staged");
    expect(unstaged.partial?.patch).toContain("+worktree");
});

test("an oversized file in an agent's checkout is diffed against the conversation's base", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "big.txt"), bigFile("base"));
    await sh(dir, "add", "-A");
    await sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "big");
    const base = await sh(dir, "rev-parse", "HEAD");
    await writeFile(join(dir, "big.txt"), bigFile("agent edit"));

    const working = await workingFileDiff(dir, "big.txt", base);
    expect(working.partial?.patch).toContain("-base");
    expect(working.partial?.patch).toContain("+agent edit");

    // The archived counterpart: same comparison, both sides read as blobs off the branch.
    await sh(dir, "checkout", "-q", "-b", "agent/c1");
    await sh(dir, "add", "-A");
    await sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "Agent: work");
    const archived = await refFileDiff(dir, "big.txt", base, "agent/c1");
    expect(archived.partial?.patch).toBe(working.partial?.patch);
});

test("an oversized file at a commit is diffed against that commit's first parent", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "big.txt"), bigFile("first"));
    await sh(dir, "add", "-A");
    await sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "big");
    await writeFile(join(dir, "big.txt"), bigFile("second"));
    await sh(dir, "add", "-A");
    await sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "edit");

    const diff = await commitFileDiff(dir, await sh(dir, "rev-parse", "HEAD"), "big.txt");
    expect(diff.partial?.patch).toContain("-first");
    expect(diff.partial?.patch).toContain("+second");
});

// A file with no counterpart can't shrink to a patch; clipped to the budget instead of refused (a head of the file).
// A root commit has no `<sha>^` to diff against, the one pairing that's decided rather than spelled out.
test("an oversized added file arrives as the head of itself, and says there is more", async () => {
    const dir = await mkdtemp(join(tmpdir(), "intentic-changes-"));
    tempDirs.push(dir);
    await sh(dir, "init", "-q");
    await writeFile(join(dir, "big.txt"), bigFile("root"));
    await sh(dir, "add", "-A");
    await sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "root commit");

    const diff = await commitFileDiff(dir, await sh(dir, "rev-parse", "HEAD"), "big.txt");
    expect(diff.partial?.beforeBytes).toBeUndefined();
    expect(diff.partial?.patch?.startsWith("@@ -0,0 +1,")).toBe(true);
    expect(diff.partial?.patch).toContain("+line 0 xxxxxxxxxx");
    expect(diff.partial?.more).toBe(true);
    expect(diff.partial?.patch).not.toContain(`line ${BIG_LINES - 1} `);
});

// git diff can't answer for an untracked file (compares index against tree, sees neither); e.g. a dropped dataset.
test("an oversized untracked file arrives as the head of itself, which git could not have produced", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "dropped.txt"), bigFile("untracked"));

    // Confirms git itself sees nothing here.
    expect(await sh(dir, "diff", "--", "dropped.txt")).toBe("");

    const diff = await unstagedFileDiff(dir, "dropped.txt");
    expect(diff.partial?.beforeBytes).toBeUndefined();
    expect(diff.partial?.afterBytes).toBeGreaterThan(512 * 1024);
    expect(diff.partial?.patch?.startsWith("@@ -0,0 +1,")).toBe(true);
    expect(diff.partial?.patch).toContain("+line 0 xxxxxxxxxx");
    expect(diff.partial?.more).toBe(true);
    expect(diff.partial?.patch).not.toContain(`line ${BIG_LINES - 1} `);
});

test("a file the agent created in its own checkout is diffed the same way, against no base side", async () => {
    const dir = await tempRepo();
    const base = await sh(dir, "rev-parse", "HEAD");
    await writeFile(join(dir, "generated.txt"), bigFile("agent wrote this"));

    const diff = await workingFileDiff(dir, "generated.txt", base);
    expect(diff.partial?.patch?.startsWith("@@ -0,0 +1,")).toBe(true);
    expect(diff.partial?.beforeBytes).toBeUndefined();
});

// An oversized untracked file is sized but never read; its head is the only look at its bytes anyone gets.
test("an oversized untracked file that is not text says so instead of shipping decoded rubbish", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "dump.unknownext"), Buffer.concat([Buffer.from("PK"), Buffer.alloc(700 * 1024)]));

    const diff = await unstagedFileDiff(dir, "dump.unknownext");
    expect(diff.binary).toBe(true);
    expect(diff.partial?.patch).toBeUndefined();
    expect(diff.partial?.afterBytes).toBeGreaterThan(512 * 1024);
});

// The Stop hook reads this beside the edit ledger; paths must be root-relative through the nested repo's own prefix.
test("dirtyPathsAcross names every changed path of the root and its nested repos, root-relative", async () => {
    const root = await tempRepo();
    const nested = join(root, "intentic");
    await mkdir(nested);
    await sh(nested, "init", "-q");
    await writeFile(join(nested, "x.ts"), "export const x = 1;\n");
    await sh(nested, "add", "-A");
    await sh(nested, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
    await writeFile(join(nested, "x.ts"), "export const x = 2;\n"); // tracked, modified, in the nested repo
    await writeFile(join(nested, "new.ts"), "export const y = 1;\n"); // untracked, in the nested repo
    await writeFile(join(root, "a.txt"), "two\n"); // tracked, modified, in the root repo

    const paths = await dirtyPathsAcross(root, ["intentic"]);
    expect(paths.sort()).toEqual(["a.txt", "intentic/new.ts", "intentic/x.ts"]);
});
