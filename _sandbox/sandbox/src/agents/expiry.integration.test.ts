import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import { afterEach, expect, test } from "vitest";
import { createExpiryTracker } from "./expiry.js";

/* The tracker's one promise: the incremental answer equals the exact one — for a landing that rides the
 * increments from its first sight, every path `git diff landedHead..HEAD` would name is in the set — at ONE
 * shared diff per head move instead of one full diff per landing. Real repos, because the promise is about
 * what git reports. */

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
    // Two landings at different heads, both first seen while HEAD sat at heads[2]…
    expect([...(await tracker.committedSince(dir, "root", heads[0]!, heads[2]!))].toSorted()).toEqual(["b.ts", "c.ts"]);
    expect([...(await tracker.committedSince(dir, "root", heads[1]!, heads[2]!))].toSorted()).toEqual(["c.ts"]);
    // …then HEAD moves. Each landing's set grows by the same shared increment, and both now match the full span.
    expect([...(await tracker.committedSince(dir, "root", heads[0]!, heads[3]!))].toSorted()).toEqual(["b.ts", "c.ts", "d.ts"]);
    expect([...(await tracker.committedSince(dir, "root", heads[1]!, heads[3]!))].toSorted()).toEqual(["c.ts", "d.ts"]);
});

test("a head move costs ONE diff for the whole repo, not one per landing", async () => {
    const { dir, heads } = await repoWithCommits();
    const calls: string[][] = [];
    const tracker = createExpiryTracker(countingGit(calls));
    // First sight of each landing is its own full diff — the exact fallback, paid once per landing ever.
    await tracker.committedSince(dir, "root", heads[0]!, heads[2]!);
    await tracker.committedSince(dir, "root", heads[1]!, heads[2]!);
    expect(calls).toHaveLength(2);

    // A scan at an unmoved head answers every landing from memory.
    calls.length = 0;
    await tracker.committedSince(dir, "root", heads[0]!, heads[2]!);
    await tracker.committedSince(dir, "root", heads[1]!, heads[2]!);
    expect(calls).toEqual([]);

    // The head moves — the commit case. The first ask pays the one shared increment; the rest ride it. This is
    // the line that used to read "one full diff per landing, per commit, forever" on the commit response path.
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

/* The one-way door, stated as a test: a path committed and then REVERTED stays expired. The union keeps it,
 * a fresh full diff would not — and the union is right by the same reasoning the registry's absorbed mark
 * rests on: the commit put the lines in a reachable commit, and both consumers already treat that as terminal
 * at the landing granularity. */
test("a commit-then-revert keeps the path expired — the door does not swing back", async () => {
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
    // git diff heads[3]..reverted is empty — but the tracker remembers the door was walked through.
    expect([...(await tracker.committedSince(dir, "root", heads[3]!, reverted))]).toEqual(["a.ts"]);
});
