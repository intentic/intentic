import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
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

// For assertions that only care whether the tree is dirty at all, which list a change landed in is the
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
    // so it carries the same `-c user.*` the commits do: without it, a machine with no global git identity gets
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
    // from the file itself: the whole thing is an addition.
    expect(unstaged).toContainEqual({ path: "a.txt", status: "modified", additions: 1, deletions: 1 });
    expect(unstaged).toContainEqual({ path: "old.txt", status: "deleted", additions: 0, deletions: 1 });
    expect(unstaged).toContainEqual({ path: "new/b.txt", status: "added", additions: 1, deletions: 0 });
    expect(unstaged.some((change) => change.path.includes(".env"))).toBe(false);
});

/* The status pass already parses HEAD's sha, and the Changes scan hands it to attribution rather than letting
 * it spawn a `rev-parse` for the answer this read just had. Reported for an unborn repo as absent, not as a
 * fabricated empty-tree sha: a caller that reads it as one would attribute against a tree that never was. */
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
    // It is no longer untracked, and the worktree matches the index: nothing left unstaged.
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

test("`git diff` reports an unmerged path twice: the second record must not overwrite the conflict", async () => {
    const dir = await conflictedRepo();
    // Not a synthetic worry: the worktree pass emits `U a.txt` AND `M a.txt` for the same path, so a plain
    // last-record-wins parse downgrades every conflict to a modification.
    const raw = await sh(dir, "diff", "--name-status");
    expect(raw.split("\n").length).toBe(2);

    expect((await changedFiles(dir)).conflicted).toEqual([{ path: "a.txt", status: "conflicted" }]);
});

test("staging an unmerged path resolves it: it moves out of `conflicted` and into `staged`", async () => {
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

test("a staged rename that was then edited lands on both sides: renamed on one, modified on the other", async () => {
    const dir = await tempRepo(); // a.txt = "one"
    await sh(dir, "mv", "a.txt", "b.txt");
    await writeFile(join(dir, "b.txt"), "one\nmore\n"); // the rename is staged; this edit is not

    const { staged, unstaged } = await changedFiles(dir);
    // The origin path rides its own field in the status record, and it belongs to the side the rename is on:
    // the index renamed a.txt→b.txt, the worktree merely modified b.txt.
    expect(staged).toEqual([{ path: "b.txt", status: "renamed", from: "a.txt", additions: 0, deletions: 0 }]);
    expect(unstaged).toEqual([{ path: "b.txt", status: "modified", additions: 1, deletions: 0 }]);
});

// The scan runs for every repo several times a second while an agent writes, so its spawn count is a property
// worth pinning: one status read, plus one numstat per side that HAS rows. Assembling the same answer from
// branch + rev-parse + two name-status passes + ls-files cost seven, and that was the daemon's hottest path.
test("changedFiles costs one status read plus a numstat per non-empty side", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "a.txt"), "two\n"); // unstaged only — the staged side stays empty
    const spawns: string[][] = [];
    const counting: GitRunner = async (cwd, args) => {
        spawns.push([...args]);
        return defaultGit(cwd, args);
    };

    await changedFiles(dir, counting);
    expect(spawns).toHaveLength(2);
    expect(spawns[0]).toContain("--porcelain=v2");
    // A poller must not take index.lock for a refresh it only wants to read: agents race it for that lock.
    expect(spawns[0]).toContain("--no-optional-locks");
    expect(spawns[1]).toContain("--numstat");
});

test("conflictedFileDiff shows HEAD vs the worktree, because an unmerged path has no stage 0", async () => {
    const dir = await conflictedRepo();

    // `:0:a.txt` does not exist mid-conflict: the index holds stages 1/2/3, so the index side comes back
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
 * commits" from "there are thousands and you are looking at the newest N", and it read the second as the first,
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
    // Exactly the page asked for: the probe row git also returned is never shipped.
    expect(first.commits).toHaveLength(2);
    expect(first.hasMore).toBe(true);

    const second = await commitLog(dir, 2, 2);
    expect(second.commits.map((commit) => commit.subject)).toEqual(["two", "init"]);
    // The last page ends the history, and says so.
    expect(second.hasMore).toBe(false);

    // A page larger than the history is not "more": the boundary the probe row exists to get right.
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
    // `git mv` stages the rename, so it is an INDEX-side change: git only detects renames against HEAD.
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
    // Untracked, so it is unstaged: there is no index entry yet.
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
// whole index. What it must NOT do is reach the rest of the worktree: the other agent's work sitting one row
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
    // The edit itself survived both moves: staging is an index operation, never a worktree one.
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

    // There is no HEAD to `reset` against: the index entry is dropped instead.
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

test("the two side diffs of a partially staged file are genuinely different, and neither is HEAD↔worktree", async () => {
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
    // Ignored: must not appear:
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
    // Back on the base, as the main repo would be: the branch is all that is left of the agent.
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

/* ---- files too big to ship whole -------------------------------------------------------------------------
 *
 * Over MAX_FILE_DIFF_BYTES neither side travels, and what goes instead is a patch of the changed regions
 * (diff-partial.ts). What these pin is the PAIRING: every source has to ask git for the same comparison its
 * row is listed under, and a wrong rev-spec here shows a reviewer a diff of something they never opened. The
 * clipping and the degraded cases are diff-partial.test.ts's; this is about which two things got compared. */

// A file comfortably over the 512 KiB cap, with a known line to edit in the middle of it.
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
    // Neither whole side: that is the whole point of the cap.
    expect(diff.before).toBeUndefined();
    expect(diff.after).toBeUndefined();
    expect(diff.partial?.beforeBytes).toBeGreaterThan(512 * 1024);
    expect(diff.partial?.afterBytes).toBeGreaterThan(512 * 1024);
    // One region, at line 20,001 of the file, holding the one line that moved.
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
    // Edited again after staging: the two sides of the row are now two different diffs, and the staged one
    // must not mention the worktree's edit at all.
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

/* A file with no counterpart is the case a patch cannot shrink: the whole thing IS the change. It still gets
 * clipped to the budget rather than refused, which makes the pane the head of the file, the peek a reader
 * opening a 6 MB new file is actually after. And an oversized file in a repo's FIRST commit has no `<sha>^`
 * to name at all, which is the one pairing that has to be decided rather than spelled out. */
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
    // Cut at the budget: what is on screen is the start of the file, and `more` is what stops that reading as
    // the whole of it.
    expect(diff.partial?.more).toBe(true);
    expect(diff.partial?.patch).not.toContain(`line ${BIG_LINES - 1} `);
});

/* An UNTRACKED file is the one git diff cannot answer for at all: it compares the index against the tree, and
 * a path in neither is invisible to it. Common here, a dropped dataset, a bundle an agent has just generated,
 * and until the daemon wrote the patch itself it was the case that still ended on an empty pane. */
test("an oversized untracked file arrives as the head of itself, which git could not have produced", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "dropped.txt"), bigFile("untracked"));

    // The row it is listed under. Nothing in git's index or tree holds this path.
    expect(await sh(dir, "diff", "--", "dropped.txt")).toBe("");

    const diff = await unstagedFileDiff(dir, "dropped.txt");
    expect(diff.partial?.beforeBytes).toBeUndefined();
    expect(diff.partial?.afterBytes).toBeGreaterThan(512 * 1024);
    expect(diff.partial?.patch?.startsWith("@@ -0,0 +1,")).toBe(true);
    expect(diff.partial?.patch).toContain("+line 0 xxxxxxxxxx");
    expect(diff.partial?.more).toBe(true);
    // The head, not the whole file: the budget is what the reader is peeking through.
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

// An oversized untracked file is SIZED and never read, so the head written for it is the only look anyone gets
// at its bytes, and so the only chance to notice they are not text at all. Without that check, an archive with
// an extension nothing recognises arrives as a page of replacement characters "added" to the workspace.
test("an oversized untracked file that is not text says so instead of shipping decoded rubbish", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "dump.unknownext"), Buffer.concat([Buffer.from("PK"), Buffer.alloc(700 * 1024)]));

    const diff = await unstagedFileDiff(dir, "dump.unknownext");
    expect(diff.binary).toBe(true);
    expect(diff.partial?.patch).toBeUndefined();
    expect(diff.partial?.afterBytes).toBeGreaterThan(512 * 1024);
});
