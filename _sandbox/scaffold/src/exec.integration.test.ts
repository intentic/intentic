import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
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
    // 2 MiB of output — over execFile's 1 MiB default, far under our cap. In production the overflow comes from
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

/* THE RESIDENT FORKER'S OWN PATH, which none of the tests above can reach. Vitest resolves this package
 * through its `@intentic/src` export condition, so `defaultGit` there finds no compiled `git-forker.js` beside
 * it and execs git directly — the fallback. The daemon always runs from dist, so the branch that actually
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
        const { defaultGit } = await import(${JSON.stringify(built.href)});
        const dir = ${JSON.stringify(dir)};
        const head = (await defaultGit(dir, ["rev-parse", "HEAD"])).stdout.trim();
        // GIT_INDEX_FILE is the env a checkpoint snapshot stages with — it has no command-line spelling, so a
        // forker that dropped \`env\` would silently stage into the user's own index instead.
        const gitDir = (await defaultGit(dir, ["rev-parse", "--git-dir"], { GIT_INDEX_FILE: "/tmp/forker-probe-index" })).stdout.trim();
        let failure;
        try {
            await defaultGit(dir, ["rev-parse", "--verify", "refs/heads/nope"]);
        } catch (error) {
            failure = { code: error.code, stderr: String(error.stderr), message: typeof error.message };
        }
        process.stdout.write(JSON.stringify({ head, gitDir, failure }));
    `;
    const { stdout } = await exec(process.execPath, ["--input-type=module", "-e", probe]);
    const result = JSON.parse(stdout) as { head: string; gitDir: string; failure: { code: number; stderr: string; message: string } };

    expect(result.head).toMatch(/^[0-9a-f]{40}$/);
    expect(result.gitDir).not.toBe("");
    // The rejection has to arrive shaped like execFile's, because that is what the daemon reads: `stderr` for
    // the user-facing reason (gitFailureReason) and `code` for politeGit's ENOENT fallback to plain git.
    expect(result.failure.code).toBe(128);
    expect(result.failure.stderr).toMatch(/fatal/);
    expect(result.failure.message).toBe("string");
});
