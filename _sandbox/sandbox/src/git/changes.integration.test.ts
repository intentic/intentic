import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import {
    changedFiles,
    changesAgainstBase,
    changesBetweenRefs,
    checkoutRef,
    cherryPick,
    commitChanges,
    commitFileDiff,
    commitIndex,
    commitLog,
    conflictedFileDiff,
    createBranchAt,
    createTagAt,
    discardPaths,
    dropCommit,
    refFileDiff,
    resetTo,
    revertCommit,
    stagePaths,
    stagedFileDiff,
    unstagePaths,
    unstagedFileDiff,
    workingFileDiff,
} from "./changes.js";

const exec = promisify(execFile);
const sh = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();
const author = { name: "intentic", email: "agent@intentic.dev" };

// For assertions that only care whether the tree is dirty at all — which list a change landed in is the
// subject of the dedicated tests above, not of every discard/branch case.
const bothSides = async (dir: string): Promise<unknown[]> => {
    const { conflicted, staged, unstaged } = await changedFiles(dir);
    return [...conflicted, ...staged, ...unstaged];
};

// A repo stopped mid-merge on one conflicted file, `a.txt`, with "ours" = main and "theirs" = side.
const conflictedRepo = async (): Promise<string> => {
    const dir = await tempRepo(); // a.txt = "one"
    const trunk = await sh(dir, "branch", "--show-current");
    await sh(dir, "checkout", "-q", "-b", "side");
    await writeFile(join(dir, "a.txt"), "theirs\n");
    await sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "theirs");
    await sh(dir, "checkout", "-q", trunk);
    await writeFile(join(dir, "a.txt"), "ours\n");
    await sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "ours");
    // `git merge` needs a committer identity even when it stops at a conflict (it validates identity up front),
    // so it carries the same `-c user.*` the commits do — without it, a machine with no global git identity gets
    // "Committer identity unknown", the merge is a no-op, and `.catch` swallows it into a NON-conflicted repo.
    await sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "merge", "side").catch(() => undefined);
    return dir;
};

const tempDirs: string[] = [];
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

// A real repo with one commit (a.txt tracked, .gitignore ignoring .env*), the shared fixture for the verbs.
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
    // Nothing was `git add`ed, so every change is on the worktree side and the index side is empty.
    expect(staged).toEqual([]);
    // Tracked changes carry numstat line counts; an untracked file is in no numstat at all, so its count comes
    // from the file itself — the whole thing is an addition.
    expect(unstaged).toContainEqual({ path: "a.txt", status: "modified", additions: 1, deletions: 1 });
    expect(unstaged).toContainEqual({ path: "old.txt", status: "deleted", additions: 0, deletions: 1 });
    expect(unstaged).toContainEqual({ path: "new/b.txt", status: "added", additions: 1, deletions: 0 });
    expect(unstaged.some((change) => change.path.includes(".env"))).toBe(false);
});

test("changedFiles reports a partially staged file on BOTH sides, with each side's own line counts", async () => {
    const dir = await tempRepo(); // a.txt = "one"
    await writeFile(join(dir, "a.txt"), "two\n");
    await sh(dir, "add", "a.txt"); // index now holds "two"
    await writeFile(join(dir, "a.txt"), "three\n"); // worktree has moved on again — the classic `MM`

    const { staged, unstaged } = await changedFiles(dir);
    // The whole point of the split: one path, two different diffs, each with counts describing ITS diff.
    // The old single-list shape had to pick one and reported a stat that matched neither.
    expect(staged).toEqual([{ path: "a.txt", status: "modified", additions: 1, deletions: 1 }]);
    expect(unstaged).toEqual([{ path: "a.txt", status: "modified", additions: 1, deletions: 1 }]);
});

test("changedFiles puts an added-then-staged file on the staged side only", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "fresh.txt"), "hello\n");
    await sh(dir, "add", "fresh.txt");

    const { staged, unstaged } = await changedFiles(dir);
    expect(staged).toEqual([{ path: "fresh.txt", status: "added", additions: 1, deletions: 0 }]);
    // It is no longer untracked, and the worktree matches the index — nothing left unstaged.
    expect(unstaged).toEqual([]);
});

test("an unmerged path is its own third list, in NEITHER of the two sides", async () => {
    const dir = await conflictedRepo();

    const { conflicted, staged, unstaged } = await changedFiles(dir);
    // The whole point: it is not a staged change and not an unstaged one. Reported as staged (which the `U`
    // letter falling through to "modified" used to do) it claimed to be ready to commit, which git flatly
    // refuses while a path is unmerged.
    expect(conflicted).toEqual([{ path: "a.txt", status: "conflicted" }]);
    expect(staged).toEqual([]);
    expect(unstaged).toEqual([]);
});

test("`git diff` reports an unmerged path twice — the second record must not overwrite the conflict", async () => {
    const dir = await conflictedRepo();
    // Not a synthetic worry: the worktree pass emits `U a.txt` AND `M a.txt` for the same path, so a plain
    // last-record-wins parse downgrades every conflict to a modification.
    const raw = await sh(dir, "diff", "--name-status");
    expect(raw.split("\n").length).toBe(2);

    expect((await changedFiles(dir)).conflicted).toEqual([{ path: "a.txt", status: "conflicted" }]);
});

test("staging an unmerged path resolves it — it moves out of `conflicted` and into `staged`", async () => {
    const dir = await conflictedRepo();
    await writeFile(join(dir, "a.txt"), "resolved\n");
    // `git add` on an unmerged path IS the resolve gesture; the panel's "Mark resolved" is this request.
    await stagePaths(dir, ["a.txt"]);

    const { conflicted, staged } = await changedFiles(dir);
    expect(conflicted).toEqual([]);
    expect(staged).toEqual([{ path: "a.txt", status: "modified", additions: 1, deletions: 1 }]);
    // …and only now will git commit it.
    expect(await commitIndex(dir, "resolve the merge", author)).toBe(true);
});

test("conflictedFileDiff shows HEAD vs the worktree, because an unmerged path has no stage 0", async () => {
    const dir = await conflictedRepo();

    // `:0:a.txt` does not exist mid-conflict — the index holds stages 1/2/3 — so the index side comes back
    // absent and the diff reads as a DELETION: before HEAD's content, after nothing. That is what the panel
    // used to render for a conflict, and it is worse than showing nothing, because it looks like an answer.
    expect(await stagedFileDiff(dir, "a.txt")).toEqual({ before: "ours\n" });

    const diff = await conflictedFileDiff(dir, "a.txt");
    expect(diff.before).toBe("ours\n");
    // The worktree side carries git's conflict markers, which is the thing the user has to act on.
    expect(diff.after).toContain("<<<<<<<");
    expect(diff.after).toContain("theirs");
});

test("commitLog returns commits newest-first with parents, refs, and the HEAD flag", async () => {
    const dir = await tempRepo(); // one commit "init"
    await writeFile(join(dir, "a.txt"), "two\n");
    await sh(dir, "add", "-A");
    await sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "second\n\nwith a body");

    const { branch, commits } = await commitLog(dir, 50);
    expect(commits).toHaveLength(2);
    expect(commits[0]?.subject).toBe("second");
    expect(commits[0]?.body).toBe("with a body");
    expect(commits[1]?.subject).toBe("init");
    // The newest commit's parent is the older one; the root commit has none.
    expect(commits[0]?.parents).toEqual([commits[1]!.sha]);
    expect(commits[1]?.parents).toEqual([]);
    // HEAD sits on the newest commit, decorated with the current branch (lifted out of `refs` into `head`).
    expect(commits[0]?.head).toBe(true);
    expect(commits[1]?.head).toBe(false);
    expect(branch).not.toBe(undefined);
    expect(commits[0]?.refs).toContain(branch);
    expect(commits[0]?.refs).not.toContain("HEAD");
});

/* PAGING, and the `hasMore` that makes it honest. Without it the graph cannot tell "this repo has exactly N
 * commits" from "there are thousands and you are looking at the newest N" — and it read the second as the first,
 * drawing the oldest row of the page as a root commit because its parent was outside the window. */
test("commitLog pages through a history and says whether more is behind it", async () => {
    const dir = await tempRepo(); // one commit "init"
    for (const text of ["two", "three", "four"]) {
        await writeFile(join(dir, "a.txt"), `${text}\n`);
        await sh(dir, "add", "-A");
        await sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", text);
    }

    const first = await commitLog(dir, 2);
    expect(first.commits.map((commit) => commit.subject)).toEqual(["four", "three"]);
    // Exactly the page asked for — the probe row git also returned is never shipped.
    expect(first.commits).toHaveLength(2);
    expect(first.hasMore).toBe(true);

    const second = await commitLog(dir, 2, 2);
    expect(second.commits.map((commit) => commit.subject)).toEqual(["two", "init"]);
    // The last page ends the history, and says so.
    expect(second.hasMore).toBe(false);

    // A page larger than the history is not "more" — the boundary the probe row exists to get right.
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
    // Status (name-status) merged with per-file +/- counts (numstat): a.txt changed one line, new.txt is one add.
    expect(files).toContainEqual({ path: "a.txt", status: "modified", additions: 1, deletions: 1 });
    expect(files).toContainEqual({ path: "new.txt", status: "added", additions: 1, deletions: 0 });

    // A modified file has both sides at the commit; a file absent at the parent has no before side.
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
    // A duplicate name is git's error, surfaced by rejection (the route lets it propagate).
    await expect(createBranchAt(dir, "feature/x", root)).rejects.toThrow();
});

test("revertCommit adds an inverse commit that undoes the change", async () => {
    const dir = await tempRepo(); // a.txt = "one"
    await writeFile(join(dir, "a.txt"), "two\n");
    await sh(dir, "add", "-A");
    await sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "change a");
    const target = await sh(dir, "rev-parse", "HEAD");

    const result = await revertCommit(dir, target, author);
    expect(result).toEqual({ ok: true });
    // A NEW commit (history grew) restored the file, nothing rewritten.
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("one\n");
    expect(await sh(dir, "rev-list", "--count", "HEAD")).toBe("3");
    expect(await sh(dir, "rev-parse", "HEAD^")).toBe(target); // the target is still HEAD's parent
});

test("revertCommit reports a conflict cleanly instead of leaving the worktree mid-revert", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "a.txt"), "two\n");
    await sh(dir, "add", "-A");
    await sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "two");
    const target = await sh(dir, "rev-parse", "HEAD");
    // A later edit to the same line makes reverting `target` conflict.
    await writeFile(join(dir, "a.txt"), "three\n");
    await sh(dir, "add", "-A");
    await sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "three");

    const result = await revertCommit(dir, target, author);
    expect(result).toEqual({ ok: false, reason: "conflict" });
    // Aborted: no revert left in progress, worktree clean at "three".
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
    const dir = await tempRepo(); // "init", a.txt = "one"
    const base = await sh(dir, "rev-parse", "HEAD");
    await writeFile(join(dir, "a.txt"), "two\n");
    await sh(dir, "add", "-A");
    await sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "two");

    await resetTo(dir, base, "hard");
    expect(await sh(dir, "rev-parse", "HEAD")).toBe(base);
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("one\n");
});

test("dropCommit removes a commit, replaying later ones onto its parent", async () => {
    const dir = await tempRepo(); // C1 "init" (a.txt)
    await writeFile(join(dir, "b.txt"), "b\n");
    await sh(dir, "add", "-A");
    await sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "add b"); // C2
    const drop = await sh(dir, "rev-parse", "HEAD");
    await writeFile(join(dir, "c.txt"), "c\n");
    await sh(dir, "add", "-A");
    await sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "add c"); // C3

    const result = await dropCommit(dir, drop, author);
    expect(result).toEqual({ ok: true });
    expect(existsSync(join(dir, "b.txt"))).toBe(false); // the dropped commit's file is gone
    expect(existsSync(join(dir, "c.txt"))).toBe(true); // the later commit survived
    expect(await sh(dir, "rev-list", "--count", "HEAD")).toBe("2");
});

test("changedFiles reports a staged rename with its original path", async () => {
    const dir = await tempRepo();
    await sh(dir, "mv", "a.txt", "b.txt");
    const { staged, unstaged } = await changedFiles(dir);
    // `git mv` stages the rename, so it is an INDEX-side change — git only detects renames against HEAD.
    // A pure rename moves no lines: numstat reports 0/0 (rename detection on).
    expect(staged).toEqual([{ path: "b.txt", status: "renamed", from: "a.txt", additions: 0, deletions: 0 }]);
    expect(unstaged).toEqual([]);
});

test("changedFiles leaves a binary file's counts undefined", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "blob.bin"), Buffer.from([0, 1, 2, 0, 4]));
    await sh(dir, "add", "-A");
    const { staged } = await changedFiles(dir);
    // Git's numstat prints "-\t-" for a binary file; both counts stay undefined (the UI shows no stat).
    expect(staged).toEqual([{ path: "blob.bin", status: "added" }]);
});

test("changedFiles treats everything as added on an unborn HEAD", async () => {
    const dir = await mkdtemp(join(tmpdir(), "intentic-changes-"));
    tempDirs.push(dir);
    await sh(dir, "init", "-q");
    await writeFile(join(dir, "a.txt"), "one\n");
    // Untracked, so it is unstaged — there is no index entry yet.
    expect((await changedFiles(dir)).unstaged).toEqual([{ path: "a.txt", status: "added", additions: 1, deletions: 0 }]);

    // Staging it on an unborn HEAD must still report it: the index is diffed against the EMPTY TREE, not
    // against a HEAD that does not exist, so a repo composing its very first commit is not reported as clean.
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

// The pair the commit route runs for a path-scoped commit, in the order and inside the lock it runs them: the
// Changes panel's origin filter narrows the list, so Commit stages exactly those paths and then records the
// whole index. What it must NOT do is reach the rest of the worktree — the other agent's work sitting one row
// away is precisely what the filter was drawn around.
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
    // The edit itself survived both moves — staging is an index operation, never a worktree one.
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("two\n");
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

    // There is no HEAD to `reset` against — the index entry is dropped instead.
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

test("the two side diffs of a partially staged file are genuinely different — and neither is HEAD↔worktree", async () => {
    const dir = await tempRepo(); // a.txt = "one"
    await writeFile(join(dir, "a.txt"), "two\n");
    await sh(dir, "add", "a.txt"); // index holds "two"
    await writeFile(join(dir, "a.txt"), "three\n"); // worktree moved on again

    // What a bare commit would record: HEAD → index.
    expect(await stagedFileDiff(dir, "a.txt")).toEqual({ before: "one\n", after: "two\n" });
    // What is still loose: index → worktree.
    expect(await unstagedFileDiff(dir, "a.txt")).toEqual({ before: "two\n", after: "three\n" });
    // The old single diff, which the panel used to open from BOTH rows: it matches neither list.
    expect(await workingFileDiff(dir, "a.txt", "HEAD")).toEqual({ before: "one\n", after: "three\n" });
});

test("side diffs report the leg an added or deleted file doesn't have", async () => {
    const dir = await tempRepo();
    // Untracked: no index entry, so the unstaged diff has no before side and the staged diff has nothing at all.
    await writeFile(join(dir, "fresh.txt"), "fresh\n");
    expect(await unstagedFileDiff(dir, "fresh.txt")).toEqual({ after: "fresh\n" });
    expect(await stagedFileDiff(dir, "fresh.txt")).toEqual({});

    // Staged as new: now it is the staged side that has an after and no before.
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
    // vs HEAD the file is clean; vs the base it shows the full cumulative change.
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
    // Ignored — must not appear:
    await writeFile(join(dir, ".env"), "SECRET=x\n");

    const changes = await changesAgainstBase(dir, base);
    // Tracked deltas vs base carry counts (one numstat pass); the untracked file, which no numstat names, is
    // counted from disk so it weighs the same as the identical file one commit later.
    expect(changes).toContainEqual({ path: "a.txt", status: "modified", additions: 1, deletions: 1 });
    expect(changes).toContainEqual({ path: "staged.txt", status: "added", additions: 1, deletions: 0 });
    expect(changes).toContainEqual({ path: "fresh.txt", status: "added", additions: 1, deletions: 0 });
    expect(changes.some((change) => change.path.includes(".env"))).toBe(false);
    expect(changes).toHaveLength(3);
});

/* The property the review header and the fleet card actually depend on: those surfaces SUM these counts, so an
 * untracked file counting as zero made the same work read one total before the agent committed and a bigger one
 * after. Committing must move a file between lists, never change what it weighs. */
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

// git counts a trailing partial line, so the count is not simply "how many newlines". A binary file has no
// count at all (git's own numstat says `-\t-`), and an empty one is a real zero rather than a missing number.
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

// Both of changesAgainstBase's passes ask for rename detection, so the name-status list and the numstat map
// describe the same diff. Without the flag on the first, a repo that turns diff.renames off splits the rename
// into a delete + an add and only the add can be given counts.
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

// An ARCHIVED agent's review runs on these two: the worktree is gone, so both sides come from refs. They must
// answer what the worktree pair answered, because the panel is the same panel.
test("changesBetweenRefs reads the same delta from a branch that changesAgainstBase read from a checkout", async () => {
    const dir = await tempRepo();
    const base = await sh(dir, "rev-parse", "HEAD");
    await sh(dir, "checkout", "-q", "-b", "agent/c1");
    await writeFile(join(dir, "a.txt"), "agent edit\n");
    await writeFile(join(dir, "fresh.txt"), "fresh\n");
    await sh(dir, "add", "-A");
    await sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "Agent: work");
    const fromCheckout = await changesAgainstBase(dir, base);
    // Back on the base, as the main repo would be — the branch is all that is left of the agent.
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
    // Added by the agent: no before side, exactly as the working-tree pair reports it.
    expect(await refFileDiff(dir, "added.txt", base, "agent/c1")).toEqual({ after: "new\n" });
});
