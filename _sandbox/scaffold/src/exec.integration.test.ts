import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { defaultGit, gitSpawnStats, politeGit } from "./exec.js";

// defaultGit is the runner every git call in the daemon goes through, so the two things it adds on top of
// `execFile` (a buffer big enough for real git output, and a retry for index.lock contention) are worth
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
    // 2 MiB of output: over execFile's 1 MiB default, far under our cap. In production the overflow comes from
    // `ls-files`/`status` over a large untracked tree (an un-gitignored node_modules, a build dir), which the old
    // runner turned into ERR_CHILD_PROCESS_STDIO_MAXBUFFER and the Changes scan reported as "this repo cannot be
    // read". A single large blob reproduces that overflow deterministically, without the tens of thousands of
    // file writes that make listing-based repros slow enough to time out on a loaded CI runner.
    await writeFile(join(dir, "big.txt"), "x".repeat(2 * 1024 * 1024));
    await defaultGit(dir, ["add", "big.txt"]);
    const { stdout } = await defaultGit(dir, ["cat-file", "-p", ":big.txt"]);
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

    // A real failure is NOT retried: it surfaces on the first attempt, because waiting only delays the news.
    await expect(defaultGit(dir, ["rev-parse", "--verify", "refs/heads/nope"])).rejects.toThrow();
});

test("defaultGit never gives up forever: a lock that is never released still rejects", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "a.txt"), "x\n");
    await writeFile(join(dir, ".git", "index.lock"), "");
    // Six attempts with quadratic backoff, then git's own error: an abandoned lock file is a real condition
    // (a killed process) and the user needs to be told, not left with a spinner.
    await expect(defaultGit(dir, ["add", "a.txt"])).rejects.toThrow(/index\.lock/);
});

/* THE BULK CAP, and the shape of it that the measurement chose. Capping ALL git was tried and is a
 * regression: 512 reads against a real workspace take 581ms through the forker unbounded and 1,443ms behind a
 * 14-slot queue, because the kernel schedules processes better than a promise chain does and the queue adds an
 * event-loop round trip per wave. So only `politeGit`, the agent-side bulk work whose concurrent memory can
 * push the daemon into swap, is bounded. The two tests are the two halves of that: bulk is held to its
 * ceiling, and interactive is not held at all. */

test("agent-side git is held to the bulk ceiling, without changing what it answers", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "a.txt"), "x\n");
    await defaultGit(dir, ["add", "a.txt"]);
    await defaultGit(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "one"]);
    const head = (await defaultGit(dir, ["rev-parse", "HEAD"])).stdout.trim();

    const { bulkSlots } = gitSpawnStats();
    // Four times the ceiling, so the queue is genuinely deep rather than incidentally so on a big machine.
    const reads = Array.from({ length: bulkSlots * 4 }, async () => (await politeGit(dir, ["rev-parse", "HEAD"])).stdout.trim());

    /* Read SYNCHRONOUSLY, before a single call has had a chance to resolve, which makes this exact rather than
     * a sampling race: a slot is claimed (or a waiter parked) in the same tick as the call, so the whole
     * stampede's split across running and queued is settled by the time the loop above returns. */
    expect(gitSpawnStats()).toMatchObject({ activeBulk: bulkSlots, queuedBulk: bulkSlots * 3 });

    // The cap is a scheduling change and must never be a correctness one.
    expect(await Promise.all(reads)).toEqual(Array.from({ length: bulkSlots * 4 }, () => head));
    // And it hands every slot back: a leak here would stop the daemon's agent-side git permanently, with no
    // timeout underneath to recover it, so "the queue drained to nothing" is the assertion that matters most.
    expect(gitSpawnStats()).toMatchObject({ activeBulk: 0, queuedBulk: 0 });
});

test("the reads a person is waiting on are never queued, however many agents are starting", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "a.txt"), "x\n");
    await defaultGit(dir, ["add", "a.txt"]);
    await defaultGit(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "one"]);

    /* The production shape: several conversations start turns at once and each checks out the workspace
     * through `politeGit`, while the owner has the Changes panel open. */
    const { bulkSlots } = gitSpawnStats();
    const stampede = Array.from({ length: bulkSlots * 8 }, () => politeGit(dir, ["rev-parse", "HEAD"]));
    // Issued AFTER the whole stampede is already in flight, which is the worst case for them.
    const panel = Array.from({ length: 8 }, () => defaultGit(dir, ["rev-parse", "HEAD"]));

    // The bulk queue holds the fleet and nothing else: not one of the panel's reads is parked behind it, and
    // the count of running bulk work is exactly the ceiling no matter how many agents piled in.
    expect(gitSpawnStats()).toMatchObject({ activeBulk: bulkSlots, queuedBulk: bulkSlots * 8 - bulkSlots });

    await Promise.all([...stampede, ...panel]);
    expect(gitSpawnStats()).toMatchObject({ activeBulk: 0, queuedBulk: 0 });
});

/* THE RESIDENT FORKER'S OWN PATH, which none of the tests above can reach. Vitest resolves this package
 * through its `@intentic/src` export condition, so `defaultGit` there finds no compiled `git-forker.js` beside
 * it and execs git directly: the fallback. The daemon always runs from dist, so the branch that actually
 * ships is the other one, and the only honest way to exercise it is to drive the BUILT module.
 *
 * Skipped when the package has not been built: turbo's `test` depends on `^build`, which builds this package's
 * DEPENDENCIES, not this package. Every developer machine and the release pipeline have a dist; a clean
 * checkout that runs only this suite does not.
 *
 * That the child process exits at all is half the assertion: a forker left referenced would hold the loop open
 * and hang this call rather than fail it. */
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
    // Forked, and carrying a real duration from the child rather than a zero the daemon would then charge to
    // its own event loop. `ms` is the caller's clock and can only be the larger of the two.
    expect(result.observed.forked).toBe(true);
    expect(result.observed.execMs).toBeGreaterThan(0);
    expect(result.observed.ms).toBeGreaterThanOrEqual(result.observed.execMs);
    expect(result.failedExecMs).toBeGreaterThan(0);
    // The rejection has to arrive shaped like execFile's, because that is what the daemon reads: `stderr` for
    // the user-facing reason (gitFailureReason) and `code` for politeGit's ENOENT fallback to plain git.
    expect(result.failure.code).toBe(128);
    expect(result.failure.stderr).toMatch(/fatal/);
    expect(result.failure.message).toBe("string");
});
