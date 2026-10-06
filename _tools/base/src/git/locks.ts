import { lstat, readdir, readFile, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

// STALE GIT LOCKS (2026-10-05). A git killed mid-write leaves its `<file>.lock` behind, and every later git that needs
// that file fails on it (or, for `maintenance run --quiet`, does nothing and says nothing) until someone removes it.
// A lock is taken for stale only on two pieces of evidence together: it is older than any write here holds one, and no
// git process is running at all, so nothing can be holding it. A /proc that cannot be read is no evidence.

export const STALE_LOCK_MS = 10 * 60_000;

// `git`, or one of its own programs (`git-remote-https`, `git-upload-pack`): comm is truncated to 15 characters, so a
// prefix is what survives.
const isGitName = (name: string): boolean => name === "git" || name.startsWith("git-");

// A process that exited between the listing and the read is gone, not unknown.
const vanished = (error: unknown): boolean => ["ENOENT", "ESRCH"].includes(String((error as NodeJS.ErrnoException).code));

const readProcFile = (path: string): Promise<string> =>
    readFile(path, "utf8").catch((error: unknown) => {
        if (vanished(error)) {
            return "";
        }
        throw error;
    });

// One process: is it git, by its comm or by its argv[0]'s basename.
const processIsGit = async (pidDir: string): Promise<boolean> => {
    const comm = (await readProcFile(join(pidDir, "comm"))).trim();
    if (isGitName(comm)) {
        return true;
    }
    const argv0 = (await readProcFile(join(pidDir, "cmdline"))).split("\0")[0] ?? "";
    return argv0 !== "" && isGitName(basename(argv0));
};

/**
 * Whether any git process is running in this PID namespace: true, false, or undefined when /proc cannot say (not
 * Linux, or a process that could not be read for any reason but having exited).
 */
export const gitProcessRunning = async (procRoot = "/proc"): Promise<boolean | undefined> => {
    try {
        const pids = (await readdir(procRoot)).filter((name) => /^\d+$/.test(name));
        // This process is one, so a listing with none is not a /proc.
        if (pids.length === 0) {
            return undefined;
        }
        for (const pid of pids) {
            if (await processIsGit(join(procRoot, pid))) {
                return true;
            }
        }
        return false;
    } catch {
        // allow(silent-catch): a /proc that cannot be read is the "cannot tell" this answers, which keeps every lock.
        return undefined;
    }
};

// The lock a git refused on, from its own words: "Unable to create '<path>.lock': File exists.", resolved against the
// directory git ran in.
export const contendedLockOf = (dir: string, stderr: string): string | undefined => {
    const named = /Unable to create '([^']+\.lock)': File exists/.exec(stderr)?.[1];
    return named === undefined ? undefined : resolve(dir, named);
};

export interface StaleLockCleared {
    readonly path: string;
    readonly ageMs: number;
}

// Told of every lock this process removed; a callback rather than a logger since the package is shared with the CLI.
// Unset, it goes to the console, so a removal is never silent.
let staleLockObserver: (cleared: StaleLockCleared) => void = ({ path, ageMs }) =>
    console.warn(`git: removed a stale lock ${path} (${Math.round(ageMs / 60_000)} min old, no git process running)`);

export const observeStaleLocks = (observer: (cleared: StaleLockCleared) => void): void => {
    staleLockObserver = observer;
};

export interface StaleLockProbe {
    readonly now?: number;
    readonly gitRunning?: () => Promise<boolean | undefined>;
}

/**
 * Removes the lock a failed git names when it is stale by both tests above; answers what it removed, or undefined
 * when it removed nothing (no lock named, already gone, too young, or a git that may be holding it). Throws only what
 * reading or removing the lock threw.
 */
export const clearStaleLock = async (dir: string, stderr: string, probe: StaleLockProbe = {}): Promise<StaleLockCleared | undefined> => {
    const path = contendedLockOf(dir, stderr);
    if (path === undefined) {
        return undefined;
    }
    const stats = await lstat(path).catch((error: unknown) => {
        if (vanished(error)) {
            return undefined;
        }
        throw error;
    });
    if (stats === undefined || !stats.isFile()) {
        return undefined;
    }
    const ageMs = (probe.now ?? Date.now()) - stats.mtimeMs;
    if (ageMs <= STALE_LOCK_MS) {
        return undefined;
    }
    if ((await (probe.gitRunning ?? gitProcessRunning)()) !== false) {
        return undefined;
    }
    await rm(path, { force: true });
    const cleared = { path, ageMs };
    staleLockObserver(cleared);
    return cleared;
};
