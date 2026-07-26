import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { defaultGit } from "./exec.js";

// defaultGit is the runner every git call in the daemon goes through, so the two things it adds on top of
// `execFile` — a buffer big enough for real git output, and a retry for index.lock contention — are worth
// pinning against a real repo. Both were failure modes in production, not hypotheticals.

const exec = promisify(execFile);

const tempDirs: string[] = [];
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

const tempRepo = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "intentic-exec-"));
    tempDirs.push(dir);
    await exec("git", ["-C", dir, "init", "-q"]);
    return dir;
};

test("defaultGit reads git output past execFile's 1 MiB default instead of rejecting", async () => {
    const dir = await tempRepo();
    // ~1.4 MB of paths — over the default, far under our cap. A workspace with an un-gitignored node_modules or
    // a build dir clears this trivially, and the old runner turned that into ERR_CHILD_PROCESS_STDIO_MAXBUFFER,
    // which the Changes scan reported as "this repo cannot be read".
    await Promise.all(Array.from({ length: 30000 }, (_unused, index) => writeFile(join(dir, `file_with_a_reasonably_long_name_${index}.txt`), "x")));
    const { stdout } = await defaultGit(dir, ["ls-files", "--others", "--exclude-standard", "-z"]);
    expect(stdout.length).toBeGreaterThan(1024 * 1024);
});

test("defaultGit retries a write blocked by index.lock, and gives up on anything else", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "a.txt"), "x\n");
    // Exactly the race this product creates: the agent holds the index for its own `git add` while the owner
    // clicks Stage. Held here for 250ms, which is longer than the first two backoff steps.
    const lock = join(dir, ".git", "index.lock");
    await writeFile(lock, "");
    setTimeout(() => void rm(lock, { force: true }), 250);

    await defaultGit(dir, ["add", "a.txt"]);
    expect((await defaultGit(dir, ["diff", "--cached", "--name-only"])).stdout.trim()).toBe("a.txt");

    // A real failure is NOT retried — it surfaces on the first attempt, because waiting only delays the news.
    await expect(defaultGit(dir, ["rev-parse", "--verify", "refs/heads/nope"])).rejects.toThrow();
});

test("defaultGit never gives up forever: a lock that is never released still rejects", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "a.txt"), "x\n");
    await writeFile(join(dir, ".git", "index.lock"), "");
    // Six attempts with quadratic backoff, then git's own error — an abandoned lock file is a real condition
    // (a killed process) and the user needs to be told, not left with a spinner.
    await expect(defaultGit(dir, ["add", "a.txt"])).rejects.toThrow(/index\.lock/);
});
