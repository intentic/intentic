import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import { afterEach, expect, test } from "vitest";
import { createExpiryTracker } from "./expiry.js";

// Pins that the incremental answer matches a fresh full diff, one shared diff per head move instead of one per landing;
// runs against real git repos since the promise is about what git reports.

const exec = promisify(execFile);
const sh = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();

const tempDirs: string[] = [];
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

const repoWithCommits = async (): Promise<{ dir: string; heads: string[] }> => {
    const dir = await mkdtemp(join(tmpdir(), "intentic-expiry-"));
    tempDirs.push(dir);
    await sh(dir, "init", "-q");
    const heads: string[] = [];
    for (const file of ["a.ts", "b.ts", "c.ts", "d.ts"]) {
        await writeFile(join(dir, file), `${file}\n`);
        await sh(dir, "add", "-A");
        await sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", `add ${file}`);
        heads.push(await sh(dir, "rev-parse", "HEAD"));
    }
    return { dir, heads };
};

const countingGit =
    (calls: string[][]): GitRunner =>
    (dir, args, env) => {
        calls.push([...args]);
        return defaultGit(dir, args, env);
    };

test("riding the increments answers exactly what a fresh full diff would", async () => {
    const { dir, heads } = await repoWithCommits();
    const tracker = createExpiryTracker();
    expect([...(await tracker.committedSince(dir, "root", heads[0]!, heads[2]!))].toSorted()).toEqual(["b.ts", "c.ts"]);
    expect([...(await tracker.committedSince(dir, "root", heads[1]!, heads[2]!))].toSorted()).toEqual(["c.ts"]);
    expect([...(await tracker.committedSince(dir, "root", heads[0]!, heads[3]!))].toSorted()).toEqual(["b.ts", "c.ts", "d.ts"]);
    expect([...(await tracker.committedSince(dir, "root", heads[1]!, heads[3]!))].toSorted()).toEqual(["c.ts", "d.ts"]);
});

test("a head move costs ONE diff for the whole repo, not one per landing", async () => {
    const { dir, heads } = await repoWithCommits();
    const calls: string[][] = [];
    const tracker = createExpiryTracker(countingGit(calls));
    await tracker.committedSince(dir, "root", heads[0]!, heads[2]!);
    await tracker.committedSince(dir, "root", heads[1]!, heads[2]!);
    expect(calls).toHaveLength(2);

    calls.length = 0;
    await tracker.committedSince(dir, "root", heads[0]!, heads[2]!);
    await tracker.committedSince(dir, "root", heads[1]!, heads[2]!);
    expect(calls).toEqual([]);

    calls.length = 0;
    await tracker.committedSince(dir, "root", heads[0]!, heads[3]!);
    await tracker.committedSince(dir, "root", heads[1]!, heads[3]!);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["diff", "--name-only", "--no-renames", "-z", heads[2]!, heads[3]!]);
});

test("drop retires a landing's slot; the next ask re-derives it exactly", async () => {
    const { dir, heads } = await repoWithCommits();
    const tracker = createExpiryTracker();
    await tracker.committedSince(dir, "root", heads[0]!, heads[3]!);
    expect(tracker.metrics()["entries"]).toBe(1);
    tracker.drop("root", heads[0]!);
    expect(tracker.metrics()["entries"]).toBe(0);
    expect([...(await tracker.committedSince(dir, "root", heads[0]!, heads[3]!))].toSorted()).toEqual(["b.ts", "c.ts", "d.ts"]);
});

test("a commit-then-revert keeps the path expired: the door does not swing back", async () => {
    const { dir, heads } = await repoWithCommits();
    const tracker = createExpiryTracker();
    await tracker.committedSince(dir, "root", heads[3]!, heads[3]!);

    await writeFile(join(dir, "a.ts"), "rewritten\n");
    await sh(dir, "add", "-A");
    await sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "rewrite a.ts");
    const rewritten = await sh(dir, "rev-parse", "HEAD");
    expect([...(await tracker.committedSince(dir, "root", heads[3]!, rewritten))]).toEqual(["a.ts"]);

    await sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "revert", "-n", "HEAD");
    await sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "revert the rewrite");
    const reverted = await sh(dir, "rev-parse", "HEAD");
    // The underlying diff is empty; the tracker still remembers the path as touched.
    expect([...(await tracker.committedSince(dir, "root", heads[3]!, reverted))]).toEqual(["a.ts"]);
});
