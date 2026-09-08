import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { defaultBranchOf, publishFile } from "./publish-file.js";

// Against real git: what's pinned is what a creator would experience as the button lying (a swept-up staged file, an
// unreadable push, a failing second press).

const exec = promisify(execFile);
const sh = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();

const tempDirs: string[] = [];
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

const temp = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "intentic-publish-"));
    tempDirs.push(dir);
    return dir;
};

// A clone with a real (local, bare) origin: enough to exercise the actual push path without a network.
const cloned = async (): Promise<{ clone: string; origin: string }> => {
    const source = await temp();
    await sh(source, "init", "-q", "-b", "main");
    await writeFile(join(source, "a.txt"), "one\n");
    await sh(source, "add", "-A");
    await sh(source, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "one");

    const origin = await temp();
    await exec("git", ["clone", "-q", "--bare", source, origin]);

    const clone = await temp();
    await exec("git", ["clone", "-q", origin, clone]);
    await sh(clone, "config", "user.name", "t");
    await sh(clone, "config", "user.email", "t@t");
    return { clone, origin };
};

// The router supplies this; here it is the plain write it always is.
const writerFor =
    (dir: string, path: string) =>
    async (content: string): Promise<void> => {
        await writeFile(join(dir, path), content);
    };

const publish = (dir: string, path = ".intentic-claim", content = "intentic-claim-abc\n") =>
    publishFile(dir, { path, content, message: "Claim the acme publisher name" }, writerFor(dir, path));

test("writes, commits and pushes the file to the default branch", async () => {
    const { clone, origin } = await cloned();

    const result = await publish(clone);

    expect(result).toMatchObject({ ok: true, wrote: true, committed: true, pushed: true, branch: "main", defaultBranch: "main" });
    expect(await sh(origin, "show", "main:.intentic-claim")).toBe("intentic-claim-abc");
});

// Runs beside a creator's own work; `commit --only` is what keeps the commit to this one path.
test("commits that file alone, leaving staged and unstaged work exactly where it was", async () => {
    const { clone } = await cloned();
    await writeFile(join(clone, "staged.txt"), "mine\n");
    await sh(clone, "add", "staged.txt");
    await writeFile(join(clone, "a.txt"), "edited\n");

    expect(await publish(clone)).toMatchObject({ ok: true });

    expect(await sh(clone, "diff", "--cached", "--name-only")).toBe("staged.txt");
    expect(await sh(clone, "diff", "--name-only")).toBe("a.txt");
    expect(await sh(clone, "show", "--name-only", "--format=", "HEAD")).toBe(".intentic-claim");
});

// Refused before anything is written (hence `wrote: false`): a push from a side branch would leave an unverifiable
// commit.
test("refuses to publish from a branch that is not the default one, without touching the worktree", async () => {
    const { clone } = await cloned();
    await sh(clone, "checkout", "-q", "-b", "fix/thing");

    const result = await publish(clone);

    expect(result).toMatchObject({ ok: false, wrote: false, committed: false, pushed: false, branch: "fix/thing", defaultBranch: "main" });
    expect(result.reason).toContain("fix/thing");
    expect(result.reason).toContain("main");
    expect(await sh(clone, "status", "--porcelain")).toBe("");
});

test("a second run is a no-op that still reports success", async () => {
    const { clone } = await cloned();
    await publish(clone);
    const before = await sh(clone, "rev-parse", "HEAD");

    const again = await publish(clone);

    expect(again).toMatchObject({ ok: true, committed: false, pushed: true });
    expect(await sh(clone, "rev-parse", "HEAD")).toBe(before);
});

test("replaces a claim file that carries different content", async () => {
    const { clone, origin } = await cloned();
    await publish(clone, ".intentic-claim", "someone-elses-line\n");

    expect(await publish(clone, ".intentic-claim", "intentic-claim-mine\n")).toMatchObject({ ok: true, committed: true });

    expect(await sh(origin, "show", "main:.intentic-claim")).toBe("intentic-claim-mine");
    expect(await readFile(join(clone, ".intentic-claim"), "utf8")).toBe("intentic-claim-mine\n");
});

test("a repo with no remote is refused rather than half-published", async () => {
    const dir = await temp();
    await sh(dir, "init", "-q", "-b", "main");
    await writeFile(join(dir, "a.txt"), "one\n");
    await sh(dir, "add", "-A");
    await sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "one");

    const result = await publish(dir);

    expect(result).toMatchObject({ ok: false, wrote: false, committed: false });
    expect(result.reason).toContain("no remote");
    expect(await sh(dir, "status", "--porcelain")).toBe("");
});

// Checked before staging: git only rejects a partial commit mid-merge after staging, which would cost a moved index for
// nothing.
test("refuses while the repo is part-way through a merge", async () => {
    const { clone } = await cloned();
    await sh(clone, "checkout", "-q", "-b", "side");
    await writeFile(join(clone, "a.txt"), "side\n");
    await sh(clone, "commit", "-q", "-a", "-m", "side");
    await sh(clone, "checkout", "-q", "main");
    await writeFile(join(clone, "a.txt"), "main\n");
    await sh(clone, "commit", "-q", "-a", "-m", "main");
    await exec("git", ["-C", clone, "merge", "side"]).catch(() => undefined);

    const result = await publish(clone);

    expect(result).toMatchObject({ ok: false, wrote: false });
    expect(result.reason).toContain("merge");
});

test("reads the default branch from the clone, and from the remote when the clone has no origin/HEAD", async () => {
    const { clone } = await cloned();
    expect(await defaultBranchOf(clone, "origin")).toBe("main");

    // A repo pushed rather than cloned has no `origin/HEAD` ref; the remote is asked instead.
    await sh(clone, "remote", "set-head", "origin", "--delete");
    expect(await defaultBranchOf(clone, "origin")).toBe("main");
});
