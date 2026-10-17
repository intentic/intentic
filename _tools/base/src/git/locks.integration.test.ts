import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { stderrOf } from "../errors.js";
import { untranslatedEnv } from "../node/untranslated-env.js";
import { clearStaleLock, contendedLockOf, gitProcessRunning, observeStaleLocks, STALE_LOCK_MS, type StaleLockCleared } from "./locks.js";

// A stale lock is removed only on both pieces of evidence: its age, and no git running. Pinned against a fake /proc and
// a lock file in a temp dir, never the machine's own.

const exec = promisify(execFile);

const tempDirs: string[] = [];
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

const temp = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "intentic-git-locks-"));
    tempDirs.push(dir);
    return dir;
};

// A /proc holding these processes, each as [comm, argv].
const fakeProc = async (processes: readonly (readonly [string, readonly string[]])[]): Promise<string> => {
    const root = await temp();
    for (const [index, [comm, argv]] of processes.entries()) {
        const dir = join(root, String(100 + index));
        await mkdir(dir);
        await writeFile(join(dir, "comm"), `${comm}\n`);
        await writeFile(join(dir, "cmdline"), argv.length === 0 ? "" : `${argv.join("\0")}\0`);
    }
    // Not a process: never read as one.
    await mkdir(join(root, "self"));
    return root;
};

test("a git is found by its comm, by its argv[0], or as one of git's own programs", async () => {
    const node: readonly [string, readonly string[]] = ["node", ["/usr/bin/node", "main.js", "git"]];
    expect(await gitProcessRunning(await fakeProc([node, ["kthreadd", []]]))).toBe(false);
    expect(await gitProcessRunning(await fakeProc([node, ["git", ["git", "status"]]]))).toBe(true);
    expect(await gitProcessRunning(await fakeProc([node, ["nice", ["/usr/bin/git", "gc"]]]))).toBe(true);
    expect(await gitProcessRunning(await fakeProc([["git-remote-http", ["git-remote-https", "origin"]]]))).toBe(true);
});

test("a /proc that cannot be read says nothing, rather than that no git runs", async () => {
    expect(await gitProcessRunning(join(await temp(), "missing"))).toBeUndefined();
    // An empty listing is not a /proc: this process would be in one.
    expect(await gitProcessRunning(await temp())).toBeUndefined();
});

test("the lock a git refused on is read off its own message", () => {
    const stderr = "fatal: Unable to create '/repo/.git/index.lock': File exists.\n\nAnother git process seems to be running";
    expect(contendedLockOf("/repo", stderr)).toBe("/repo/.git/index.lock");
    expect(contendedLockOf("/repo", "cannot lock ref 'refs/heads/x': Unable to create 'refs/heads/x.lock': File exists.")).toBe(
        "/repo/refs/heads/x.lock",
    );
    expect(contendedLockOf("/repo", "fatal: not a git repository")).toBeUndefined();
});

// The parser above against git's own refusal, so a git that rewords it fails here rather than leaving every stale lock
// in place. The runner runs git untranslated (untranslatedEnv), and so does this.
test("git's own refusal on a held lock names the lock contendedLockOf reads", async () => {
    const dir = await temp();
    const env = untranslatedEnv(process.env);
    await exec("git", ["-C", dir, "init", "-q"], { env });
    await exec("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "one"], { env });
    const refusal = async (args: readonly string[]): Promise<string> => {
        try {
            await exec("git", ["-C", dir, ...args], { env });
        } catch (error) {
            return stderrOf(error) ?? "";
        }
        throw new Error(`git ${args.join(" ")} succeeded over a held lock`);
    };
    const indexLock = join(dir, ".git", "index.lock");
    await writeFile(indexLock, "");
    expect(contendedLockOf(dir, await refusal(["add", "--all"]))).toBe(indexLock);
    await rm(indexLock);
    const refLock = join(dir, ".git", "refs", "heads", "side.lock");
    await writeFile(refLock, "");
    expect(contendedLockOf(dir, await refusal(["update-ref", "refs/heads/side", "HEAD"]))).toBe(refLock);
});

describe("clearStaleLock", () => {
    const NOW = Date.parse("2026-10-05T12:00:00Z");
    const lockAged = async (ageMs: number): Promise<{ dir: string; stderr: string; path: string }> => {
        const dir = await temp();
        const path = join(dir, "index.lock");
        await writeFile(path, "");
        const at = new Date(NOW - ageMs);
        await utimes(path, at, at);
        return { dir, path, stderr: `fatal: Unable to create '${path}': File exists.` };
    };
    const seen: StaleLockCleared[] = [];
    beforeEach(() => {
        seen.length = 0;
        observeStaleLocks((cleared) => seen.push(cleared));
    });

    test("removes a lock older than the threshold when no git runs, and says so", async () => {
        const { dir, path, stderr } = await lockAged(STALE_LOCK_MS + 60_000);
        const cleared = await clearStaleLock(dir, stderr, { now: NOW, gitRunning: async () => false });
        expect(cleared).toEqual({ path, ageMs: STALE_LOCK_MS + 60_000 });
        expect(seen).toEqual([{ path, ageMs: STALE_LOCK_MS + 60_000 }]);
        expect(await Bun.file(path).exists()).toBe(false);
    });

    test("keeps a young lock, and an old one a running or unknowable git may hold", async () => {
        for (const [ageMs, running] of [
            [STALE_LOCK_MS - 60_000, false],
            [STALE_LOCK_MS + 60_000, true],
            [STALE_LOCK_MS + 60_000, undefined],
        ] as const) {
            const { dir, path, stderr } = await lockAged(ageMs);
            expect(await clearStaleLock(dir, stderr, { now: NOW, gitRunning: async () => running })).toBeUndefined();
            expect(await Bun.file(path).exists()).toBe(true);
        }
        expect(seen).toEqual([]);
    });

    test("a failure naming no lock, or one already gone, removes nothing", async () => {
        const dir = await temp();
        const probe = { now: NOW, gitRunning: async () => false };
        expect(await clearStaleLock(dir, "fatal: not a git repository", probe)).toBeUndefined();
        expect(await clearStaleLock(dir, `fatal: Unable to create '${join(dir, "index.lock")}': File exists.`, probe)).toBeUndefined();
    });
});
