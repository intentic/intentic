import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultGit } from "@intentic/scaffold";
import { expect, test } from "bun:test";
import { headSha, mainLineBaseOf, turnPathsAcross } from "./changes.js";

// A sync at the Stop commits a turn's edits onto its branch, so what a turn changed must be read from the main line it
// left, not from what is still dirty; the Stop's conditions and the tests check both read this.

const commit = async (dir: string, message: string): Promise<void> => {
    await defaultGit(dir, ["add", "-A"]);
    await defaultGit(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message]);
};

test("a turn's paths are its branch's commits since the main line plus what it has not committed, and nothing main did", async () => {
    const root = await mkdtemp(join(tmpdir(), "turn-paths-"));
    const main = join(root, "main");
    const worktree = join(root, "turn");
    await defaultGit(root, ["init", "-q", "-b", "main", main]);
    await writeFile(join(main, "a.txt"), "a\n");
    await commit(main, "base");
    const base = await headSha(main);
    await defaultGit(main, ["worktree", "add", "-q", "-b", "agent/x", worktree]);
    await writeFile(join(worktree, "a.txt"), "a, edited\n");
    await commit(worktree, "Agent: x");
    await writeFile(join(worktree, "b.txt"), "new\n");
    await writeFile(join(main, "c.txt"), "main moved on\n");
    await commit(main, "someone else's land");

    expect(await mainLineBaseOf(worktree)).toBe(base);
    expect(await mainLineBaseOf(main)).toBe(await headSha(main));
    expect((await turnPathsAcross(worktree, [])).toSorted()).toEqual(["a.txt", "b.txt"]);
});
