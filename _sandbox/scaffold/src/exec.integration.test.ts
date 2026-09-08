import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { defaultGit, gitSpawnStats, politeGit } from "./exec.js";

// Pins defaultGit's two additions over execFile against a real repo: a larger output buffer and a retry on index.lock
// contention.

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
    // 2 MiB, over execFile's default 1 MiB cap, reproduces the overflow without thousands of file writes.
    await writeFile(join(dir, "big.txt"), "x".repeat(2 * 1024 * 1024));
    await defaultGit(dir, ["add", "big.txt"]);
    const { stdout } = await defaultGit(dir, ["cat-file", "-p", ":big.txt"]);
    expect(stdout.length).toBeGreaterThan(1024 * 1024);
});

test("defaultGit retries a write blocked by index.lock, and gives up on anything else", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "a.txt"), "x\n");
    // Lock held 250ms, longer than the first two backoff steps, so the retry must succeed on a later one.
    const lock = join(dir, ".git", "index.lock");
    await writeFile(lock, "");
    setTimeout(() => void rm(lock, { force: true }), 250);

    await defaultGit(dir, ["add", "a.txt"]);
    expect((await defaultGit(dir, ["diff", "--cached", "--name-only"])).stdout.trim()).toBe("a.txt");

    await expect(defaultGit(dir, ["rev-parse", "--verify", "refs/heads/nope"])).rejects.toThrow();
});

test("defaultGit never gives up forever: a lock that is never released still rejects", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "a.txt"), "x\n");
    await writeFile(join(dir, ".git", "index.lock"), "");
    // Six attempts with quadratic backoff before this surfaces git's own error.
    await expect(defaultGit(dir, ["add", "a.txt"])).rejects.toThrow(/index\.lock/);
});

// Only politeGit (agent-side bulk work) is queued to a ceiling; interactive git is never held back. Bounding all git
// regressed latency: the kernel schedules processes better than a promise queue can.

test("agent-side git is held to the bulk ceiling, without changing what it answers", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "a.txt"), "x\n");
    await defaultGit(dir, ["add", "a.txt"]);
    await defaultGit(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "one"]);
    const head = (await defaultGit(dir, ["rev-parse", "HEAD"])).stdout.trim();

    const { bulkSlots } = gitSpawnStats();
    // Four times the ceiling, so the queue is deep regardless of machine size.
    const reads = Array.from({ length: bulkSlots * 4 }, async () => (await politeGit(dir, ["rev-parse", "HEAD"])).stdout.trim());

    // Read synchronously before any call resolves, so a slot's claim or wait is settled, not sampled mid-race.
    expect(gitSpawnStats()).toMatchObject({ activeBulk: bulkSlots, queuedBulk: bulkSlots * 3 });

    expect(await Promise.all(reads)).toEqual(Array.from({ length: bulkSlots * 4 }, () => head));
    expect(gitSpawnStats()).toMatchObject({ activeBulk: 0, queuedBulk: 0 });
});

test("the reads a person is waiting on are never queued, however many agents are starting", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "a.txt"), "x\n");
    await defaultGit(dir, ["add", "a.txt"]);
    await defaultGit(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "one"]);

    // Models several agents starting turns via politeGit while the owner's Changes panel does interactive reads.
    const { bulkSlots } = gitSpawnStats();
    const stampede = Array.from({ length: bulkSlots * 8 }, () => politeGit(dir, ["rev-parse", "HEAD"]));
    // Issued after the stampede is already in flight: the worst case for the panel's reads.
    const panel = Array.from({ length: 8 }, () => defaultGit(dir, ["rev-parse", "HEAD"]));

    expect(gitSpawnStats()).toMatchObject({ activeBulk: bulkSlots, queuedBulk: bulkSlots * 8 - bulkSlots });

    await Promise.all([...stampede, ...panel]);
    expect(gitSpawnStats()).toMatchObject({ activeBulk: 0, queuedBulk: 0 });
});

// Exercises the built dist/exec.js fallback path, the daemon's actual runtime; skipped when this package has no dist
// yet.
const built = new URL("../dist/exec.js", import.meta.url);
test.skipIf(!existsSync(built))("the forker passes git's output, env and failures through unchanged", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "a.txt"), "x\n");
    await defaultGit(dir, ["add", "a.txt"]);
    await defaultGit(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "one"]);

    const probe = `
        const { defaultGit, observeGitCommands } = await import(${JSON.stringify(built.href)});
        const dir = ${JSON.stringify(dir)};
        // The forked path is the only one where git's own clock and the caller's are separate numbers, so it
        // is the only one that can prove the split arrives at all: a forker that dropped execMs would report
        // every call as pure event-loop wait, which is the exact misreading the field exists to prevent.
        const seen = [];
        observeGitCommands((observation) => seen.push(observation));
        const head = (await defaultGit(dir, ["rev-parse", "HEAD"])).stdout.trim();
        // GIT_INDEX_FILE is the env a checkpoint snapshot stages with: it has no command-line spelling, so a
        // forker that dropped \`env\` would silently stage into the user's own index instead.
        const gitDir = (await defaultGit(dir, ["rev-parse", "--git-dir"], { GIT_INDEX_FILE: "/tmp/forker-probe-index" })).stdout.trim();
        let failure;
        try {
            await defaultGit(dir, ["rev-parse", "--verify", "refs/heads/nope"]);
        } catch (error) {
            failure = { code: error.code, stderr: String(error.stderr), message: typeof error.message };
        }
        const first = seen[0];
        process.stdout.write(JSON.stringify({
            head,
            gitDir,
            failure,
            observed: { forked: first.forked, execMs: first.execMs, ms: first.ms },
            // A failed call reports the far side's clock too, so an incident log can tell eight seconds of git
            // from eight seconds of stalled loop on the path where that matters most.
            failedExecMs: seen.at(-1).execMs,
        }));
    `;
    const { stdout } = await exec(process.execPath, ["--input-type=module", "-e", probe]);
    const result = JSON.parse(stdout) as {
        head: string;
        gitDir: string;
        failure: { code: number; stderr: string; message: string };
        observed: { forked: boolean; execMs: number; ms: number };
        failedExecMs: number;
    };

    expect(result.head).toMatch(/^[0-9a-f]{40}$/);
    expect(result.gitDir).not.toBe("");
    // Forked, with a real execMs from the child, not zero; ms (the caller's clock) is never less than execMs.
    expect(result.observed.forked).toBe(true);
    expect(result.observed.execMs).toBeGreaterThan(0);
    expect(result.observed.ms).toBeGreaterThanOrEqual(result.observed.execMs);
    expect(result.failedExecMs).toBeGreaterThan(0);
    // Rejection matches execFile's shape: `stderr` feeds gitFailureReason, `code` feeds the ENOENT fallback.
    expect(result.failure.code).toBe(128);
    expect(result.failure.stderr).toMatch(/fatal/);
    expect(result.failure.message).toBe("string");
});
