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
    checkoutRef,
    cherryPick,
    commitChanges,
    commitFileDiff,
    commitLog,
    commitPaths,
    createBranchAt,
    createTagAt,
    discardPaths,
    dropCommit,
    resetTo,
    revertCommit,
    workingFileDiff,
} from "./changes.js";

const exec = promisify(execFile);
const sh = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();
const author = { name: "intentic", email: "agent@intentic.dev" };

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

    const { branch, changes } = await changedFiles(dir);
    expect(branch).not.toBe("");
    // Tracked changes carry numstat line counts (one diff vs HEAD); the untracked file has none (no HEAD blob).
    expect(changes).toContainEqual({ path: "a.txt", status: "modified", additions: 1, deletions: 1 });
    expect(changes).toContainEqual({ path: "old.txt", status: "deleted", additions: 0, deletions: 1 });
    expect(changes).toContainEqual({ path: "new/b.txt", status: "added" });
    expect(changes.some((change) => change.path.includes(".env"))).toBe(false);
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
    expect((await changedFiles(dir)).changes).toEqual([]); // worktree clean
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
    expect((await changedFiles(dir)).changes).toEqual([]);
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
    const { changes } = await changedFiles(dir);
    // A pure rename moves no lines — numstat reports 0/0 (rename detection on).
    expect(changes).toEqual([{ path: "b.txt", status: "renamed", from: "a.txt", additions: 0, deletions: 0 }]);
});

test("changedFiles leaves a binary file's counts undefined", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "blob.bin"), Buffer.from([0, 1, 2, 0, 4]));
    await sh(dir, "add", "-A");
    const { changes } = await changedFiles(dir);
    // Git's numstat prints "-\t-" for a binary file; both counts stay undefined (the UI shows no stat).
    expect(changes).toEqual([{ path: "blob.bin", status: "added" }]);
});

test("changedFiles treats everything as added on an unborn HEAD", async () => {
    const dir = await mkdtemp(join(tmpdir(), "intentic-changes-"));
    tempDirs.push(dir);
    await sh(dir, "init", "-q");
    await writeFile(join(dir, "a.txt"), "one\n");
    expect((await changedFiles(dir)).changes).toEqual([{ path: "a.txt", status: "added" }]);
});

test("commitPaths commits exactly the requested paths — deletions included — and resets stale staged state", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "picked.txt"), "picked\n");
    await writeFile(join(dir, "left.txt"), "left\n");
    await rm(join(dir, "a.txt"));
    // An agent-staged leftover must not ride along with the picked paths.
    await sh(dir, "add", "left.txt");

    expect(await commitPaths(dir, "pick two", ["picked.txt", "a.txt"], author)).toBe(true);
    expect(await sh(dir, "log", "-1", "--format=%s %an")).toBe("pick two intentic");
    expect(await sh(dir, "ls-tree", "--name-only", "HEAD")).not.toContain("a.txt");
    const { changes } = await changedFiles(dir);
    // commitPaths reset the index, so the stale staged left.txt is untracked again — no numstat vs HEAD.
    expect(changes).toEqual([{ path: "left.txt", status: "added" }]);
});

test("commitPaths is a no-op false when the paths hold nothing to commit", async () => {
    const dir = await tempRepo();
    expect(await commitPaths(dir, "nothing", ["a.txt"], author)).toBe(false);
    expect(await sh(dir, "log", "--format=%s")).toBe("init");
});

test("discardPaths restores a tracked file, deletes an untracked one, and leaves the rest alone", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "a.txt"), "two\n");
    await writeFile(join(dir, "junk.txt"), "junk\n");
    await writeFile(join(dir, "kept.txt"), "kept\n");

    await discardPaths(dir, ["a.txt", "junk.txt"]);
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("one\n");
    expect(existsSync(join(dir, "junk.txt"))).toBe(false);
    expect((await changedFiles(dir)).changes).toEqual([{ path: "kept.txt", status: "added" }]);
});

test("discardPaths undoes both legs of a staged rename from either path", async () => {
    const dir = await tempRepo();
    await sh(dir, "mv", "a.txt", "b.txt");
    await discardPaths(dir, ["b.txt"]);
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("one\n");
    expect(existsSync(join(dir, "b.txt"))).toBe(false);
    expect((await changedFiles(dir)).changes).toEqual([]);
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
    expect((await changedFiles(dir)).changes).toEqual([]);
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
    // Tracked deltas vs base carry counts (one numstat pass); the untracked file has none.
    expect(changes).toContainEqual({ path: "a.txt", status: "modified", additions: 1, deletions: 1 });
    expect(changes).toContainEqual({ path: "staged.txt", status: "added", additions: 1, deletions: 0 });
    expect(changes).toContainEqual({ path: "fresh.txt", status: "added" });
    expect(changes.some((change) => change.path.includes(".env"))).toBe(false);
    expect(changes).toHaveLength(3);
});

test("changesAgainstBase reports a committed rename with its original path", async () => {
    const dir = await tempRepo();
    const base = await sh(dir, "rev-parse", "HEAD");
    await sh(dir, "mv", "a.txt", "b.txt");
    await sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "rename");
    expect(await changesAgainstBase(dir, base)).toEqual([{ path: "b.txt", status: "renamed", from: "a.txt", additions: 0, deletions: 0 }]);
});
