import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { undoableAction, undoLastAction } from "./undo.js";

/* Against real repositories, because every claim here is about what GIT writes into a reflog: the subject
 * wording per verb, and which ref gets an entry at all. A fixture would only ever restate this module's own
 * assumptions back to it. */

const run = promisify(execFile);
const dirs: string[] = [];

afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const git = (dir: string, args: string[]): Promise<{ stdout: string; stderr: string }> => run("git", args, { cwd: dir });

const commit = async (dir: string, text: string): Promise<void> => {
    await writeFile(join(dir, "a.txt"), `${text}\n`);
    await git(dir, ["add", "."]);
    await git(dir, ["commit", "-m", text]);
};

const repo = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "gitundo-"));
    dirs.push(dir);
    await git(dir, ["init", "-b", "main"]);
    await git(dir, ["config", "user.email", "t@example.com"]);
    await git(dir, ["config", "user.name", "T"]);
    await commit(dir, "one");
    return dir;
};

const sha = async (dir: string, rev = "HEAD"): Promise<string> => (await git(dir, ["rev-parse", rev])).stdout.trim();

test("a branch with only its first commit has nothing to undo", async () => {
    const dir = await repo();
    expect(await undoableAction(dir)).toBeUndefined();
});

test("the last commit is undoable, and undoing it moves the branch back without touching the files", async () => {
    const dir = await repo();
    const before = await sha(dir);
    await commit(dir, "two");

    const action = await undoableAction(dir);
    expect(action).toMatchObject({ kind: "commit", branch: "main", previousSha: before });
    // A commit only moved the ref: its content is already in the tree, so undoing it does not need a hard reset.
    expect(action?.changesWorkingTree).toBe(false);
    // The reflog subject is git's own, so the button names what it will undo in git's words.
    expect(action?.description).toContain("two");

    const result = await undoLastAction(dir, action!.previousSha, false);
    expect(result.ok).toBe(true);
    expect(await sha(dir)).toBe(before);
    // Soft: the undone commit's content is still on disk, staged, exactly as it was before the commit.
    expect((await git(dir, ["status", "--porcelain"])).stdout).toContain("a.txt");
});

test("an amend is named as an amend rather than as the commit it rewrites", async () => {
    const dir = await repo();
    await commit(dir, "two");
    await git(dir, ["commit", "--amend", "-m", "two amended"]);
    expect(await undoableAction(dir)).toMatchObject({ kind: "amend" });
});

test("a reset is undoable and reported as rewriting the worktree", async () => {
    const dir = await repo();
    await commit(dir, "two");
    const afterTwo = await sha(dir);
    await git(dir, ["reset", "--hard", "HEAD~1"]);

    const action = await undoableAction(dir);
    expect(action).toMatchObject({ kind: "reset", previousSha: afterTwo, changesWorkingTree: true });
    // Undoing a reset with a hard reset puts the tree back where it was too.
    expect((await undoLastAction(dir, action!.previousSha, true)).ok).toBe(true);
    expect(await sha(dir)).toBe(afterTwo);
});

/* THE TRAP THIS MODULE EXISTS TO AVOID. HEAD's reflog records CHECKOUTS, so after switching branches its
 * previous entry belongs to a different branch entirely: resetting to it would move the branch you are on to a
 * position it has never held, silently. Reading the BRANCH's own reflog is what makes this case answer
 * correctly, and this test is what holds that choice in place. */
test("after a checkout, the undo targets this branch's own history and not HEAD's previous position", async () => {
    const dir = await repo();
    await git(dir, ["checkout", "-b", "feature"]);
    await commit(dir, "feature work");
    const featureTip = await sha(dir);

    // Back to main, whose own reflog has not moved since its first commit, so main has nothing to undo, even
    // though HEAD's previous entry (the feature tip) is sitting right there.
    await git(dir, ["checkout", "main"]);
    expect(await undoableAction(dir)).toBeUndefined();

    // And a commit on main undoes to MAIN's previous position, never to the feature branch's tip.
    const mainBase = await sha(dir);
    await commit(dir, "main work");
    const action = await undoableAction(dir);
    expect(action?.previousSha).toBe(mainBase);
    expect(action?.previousSha).not.toBe(featureTip);
});

test("a detached HEAD has no branch reflog and so offers no undo", async () => {
    const dir = await repo();
    await commit(dir, "two");
    await git(dir, ["checkout", "--detach"]);
    expect(await undoableAction(dir)).toBeUndefined();
});

/* A halted operation ENDS BY BEING ABORTED, not by moving the branch. Offering both would be offering two
 * different recoveries for one state, and the undo is the wrong one: the branch has not moved yet. */
test("a repo halted mid-rebase offers no undo, because aborting is what ends that state", async () => {
    const dir = await repo();
    await git(dir, ["checkout", "-b", "other"]);
    await commit(dir, "theirs");
    await git(dir, ["checkout", "main"]);
    await commit(dir, "ours");
    await git(dir, ["rebase", "other"]).catch(() => undefined);

    expect(await undoableAction(dir)).toBeUndefined();
});

/* THE STALE-UNDO REFUSAL. Two browsers, or a browser and an agent, can both be looking at this repo; an undo
 * prepared against a view that has since moved must not land somewhere the user never looked at. */
test("an undo prepared against a stale position is refused rather than landing somewhere else", async () => {
    const dir = await repo();
    await commit(dir, "two");
    const stale = await undoableAction(dir);

    // The repository moves on: another writer commits.
    await commit(dir, "three");

    const result = await undoLastAction(dir, stale!.previousSha, false);
    expect(result.ok).toBe(false);
    if (result.ok === false) {
        expect(result.reason).toContain("moved");
    }
    // And nothing moved: the refusal is a refusal, not a partial application.
    expect((await git(dir, ["log", "--oneline"])).stdout).toContain("three");
});
