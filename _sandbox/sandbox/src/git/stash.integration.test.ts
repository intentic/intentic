import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { stashApply, stashChanges, stashDrop, stashList, stashPush } from "./stash.js";

/* Against real repositories, because the whole module is a reading of git's own stash bookkeeping: how it
 * numbers entries, what it writes into a reflog subject, and which of its verbs keep the entry. */

const run = promisify(execFile);
const dirs: string[] = [];

afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const git = (dir: string, args: string[]): Promise<{ stdout: string; stderr: string }> => run("git", args, { cwd: dir });

const repo = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "gitstash-"));
    dirs.push(dir);
    await git(dir, ["init", "-b", "main"]);
    await git(dir, ["config", "user.email", "t@example.com"]);
    await git(dir, ["config", "user.name", "T"]);
    await writeFile(join(dir, "a.txt"), "base\n");
    await git(dir, ["add", "."]);
    await git(dir, ["commit", "-m", "base"]);
    return dir;
};

const clean = async (dir: string): Promise<boolean> => (await git(dir, ["status", "--porcelain"])).stdout.trim() === "";

test("a repo with no stashes lists none", async () => {
    expect(await stashList(await repo())).toEqual([]);
});

test("stashing sets the tree aside, and the entry carries the message and the branch", async () => {
    const dir = await repo();
    await writeFile(join(dir, "a.txt"), "work in progress\n");

    expect(await stashPush(dir, { message: "my wip" })).toEqual({ ok: true });
    expect(await clean(dir)).toBe(true);

    const [entry, ...rest] = await stashList(dir);
    expect(rest).toEqual([]);
    // git writes "On main: my wip" for a named stash, the scaffolding is stripped, the message is not.
    expect(entry).toMatchObject({ ref: "stash@{0}", subject: "my wip", branch: "main" });
    expect(entry?.sha).toMatch(/^[0-9a-f]{40}$/);
    // A stash commit's first parent is the commit it was taken on, which is the edge the graph draws back into
    // the history.
    expect(entry?.parents.length).toBeGreaterThanOrEqual(2);
});

test("an unnamed stash keeps git's own WIP subject, minus the scaffolding", async () => {
    const dir = await repo();
    await writeFile(join(dir, "a.txt"), "wip\n");
    await stashPush(dir, {});

    const [entry] = await stashList(dir);
    // "WIP on main: <sha> base" → the branch is lifted out and the rest is what a reader would recognise.
    expect(entry?.branch).toBe("main");
    expect(entry?.subject).toContain("base");
});

test("stashing a clean tree reports nothing to stash rather than failing", async () => {
    const dir = await repo();
    expect(await stashPush(dir, {})).toEqual({ ok: false, reason: "nothing to stash" });
    expect(await stashList(dir)).toEqual([]);
});

// Untracked files are the usual reason a stash "did not stash everything": git leaves them behind by default.
test("includeUntracked sweeps up files git has never seen", async () => {
    const dir = await repo();
    await writeFile(join(dir, "new.txt"), "brand new\n");

    expect(await stashPush(dir, { includeUntracked: true })).toEqual({ ok: true });
    expect(await clean(dir)).toBe(true);
    expect((await stashChanges(dir, "stash@{0}")).map((change) => change.path)).toContain("new.txt");
});

test("a stash's files read like a commit's, with statuses and line counts", async () => {
    const dir = await repo();
    await writeFile(join(dir, "a.txt"), "one\ntwo\n");
    await stashPush(dir, { message: "two lines" });

    const [change, ...rest] = await stashChanges(dir, "stash@{0}");
    expect(rest).toEqual([]);
    expect(change).toMatchObject({ path: "a.txt", status: "modified" });
    expect(change?.additions).toBeGreaterThan(0);
});

test("apply keeps the entry and pop drops it: git's own distinction, both offered", async () => {
    const dir = await repo();
    await writeFile(join(dir, "a.txt"), "wip\n");
    await stashPush(dir, { message: "wip" });

    expect(await stashApply(dir, "stash@{0}", false)).toEqual({ ok: true });
    expect(await clean(dir)).toBe(false);
    // Applied, not consumed.
    expect(await stashList(dir)).toHaveLength(1);

    // Reset the tree so the pop applies cleanly, then pop: same content back, entry gone.
    await git(dir, ["checkout", "--", "a.txt"]);
    expect(await stashApply(dir, "stash@{0}", true)).toEqual({ ok: true });
    expect(await clean(dir)).toBe(false);
    expect(await stashList(dir)).toEqual([]);
});

/* A CONFLICTING APPLY IS NOT A LOST STASH. Git leaves markers in the tree and keeps the entry, which is the
 * right behaviour: the work is still recoverable, so this reports a value rather than throwing. */
test("an apply that conflicts reports it and leaves the entry in place", async () => {
    const dir = await repo();
    await writeFile(join(dir, "a.txt"), "stashed line\n");
    await stashPush(dir, { message: "wip" });

    // Move the same line on the branch, so putting the stash back cannot apply cleanly.
    await writeFile(join(dir, "a.txt"), "committed line\n");
    await git(dir, ["commit", "-am", "conflicting"]);

    expect(await stashApply(dir, "stash@{0}", true)).toEqual({ ok: false, reason: "conflict" });
    // The entry survives a failed pop, which is what makes the failure recoverable.
    expect(await stashList(dir)).toHaveLength(1);
});

test("dropping removes one entry and renumbers the rest", async () => {
    const dir = await repo();
    for (const text of ["first", "second"]) {
        await writeFile(join(dir, "a.txt"), `${text}\n`);
        await stashPush(dir, { message: text });
    }
    // Newest first, so stash@{0} is "second".
    expect((await stashList(dir)).map((entry) => entry.subject)).toEqual(["second", "first"]);

    await stashDrop(dir, "stash@{0}");
    const remaining = await stashList(dir);
    // The survivor is renumbered to stash@{0}, which is why a caller must re-read rather than hold an index.
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ ref: "stash@{0}", subject: "first" });
});
