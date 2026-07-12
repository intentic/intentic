import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { changedFiles, commitPaths, discardPaths, workingFileDiff } from "./changes.js";

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
    expect(changes).toContainEqual({ path: "a.txt", status: "modified" });
    expect(changes).toContainEqual({ path: "old.txt", status: "deleted" });
    expect(changes).toContainEqual({ path: "new/b.txt", status: "added" });
    expect(changes.some((change) => change.path.includes(".env"))).toBe(false);
});

test("changedFiles reports a staged rename with its original path", async () => {
    const dir = await tempRepo();
    await sh(dir, "mv", "a.txt", "b.txt");
    const { changes } = await changedFiles(dir);
    expect(changes).toEqual([{ path: "b.txt", status: "renamed", from: "a.txt" }]);
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
    expect(await workingFileDiff(dir, "a.txt")).toEqual({ before: "one\n", after: "two\n" });

    await writeFile(join(dir, "new.txt"), "new\n");
    expect(await workingFileDiff(dir, "new.txt")).toEqual({ after: "new\n" });

    await rm(join(dir, "a.txt"));
    expect(await workingFileDiff(dir, "a.txt")).toEqual({ before: "one\n" });

    await writeFile(join(dir, "blob.bin"), Buffer.from([0, 1, 2]));
    expect(await workingFileDiff(dir, "blob.bin")).toEqual({ binary: true });
});
