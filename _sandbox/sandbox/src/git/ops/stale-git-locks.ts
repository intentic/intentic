import { lstat, readdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import { gitProcessRunning, STALE_LOCK_MS } from "@intentic/scaffold";
import type { Logger } from "pino";
import type { Chore } from "../../system/chore-clock.js";

// WHAT A DEAD GIT LEAVES ON THE HISTORY VOLUME (2026-10-05). A git killed mid-write (a container stop, an OOM kill)
// leaves its `<file>.lock`, which fails every later git that needs that file, and a half-written `tmp_pack_*` or
// `tmp_idx_*` that nothing will finish. A 0-byte objects/maintenance.lock beside a 55 MB tmp_pack kept this sandbox's
// hourly maintenance a silent no-op for days. Cleared only while no git process runs at all (@intentic/scaffold
// git-locks.ts, where a /proc that cannot be read counts as a git that may be running): a lock older than ten minutes,
// a temporary pack older than a day.

// The clock's units, spelled here: a value import from system/ would close a cycle (system/ imports git/).
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

export const STALE_TMP_PACK_MS = DAY_MS;

export type GitDebrisKind = "lock" | "tmp-pack";

// What a file in a git dir is by its name alone: a lock, a temporary pack or its index, or neither (`locked`, a
// worktree's keep-me marker, is neither).
export const gitDebrisKind = (name: string): GitDebrisKind | undefined => {
    if (name.endsWith(".lock")) {
        return "lock";
    }
    return name.startsWith("tmp_pack_") || name.startsWith("tmp_idx_") ? "tmp-pack" : undefined;
};

// Whether that file is old enough to be a dead git's rather than a live one's; a time in the future is never stale.
export const staleGitEntry = (name: string, mtimeMs: number, now: number): GitDebrisKind | undefined => {
    const kind = gitDebrisKind(name);
    if (kind === undefined) {
        return undefined;
    }
    return now - mtimeMs > (kind === "lock" ? STALE_LOCK_MS : STALE_TMP_PACK_MS) ? kind : undefined;
};

export interface StaleGitEntry {
    readonly path: string;
    readonly kind: GitDebrisKind;
    readonly ageMs: number;
}

// A place that is not there holds nothing; one that cannot be read fails the sweep, which says so.
const entriesOf = async (dir: string) => (await readdir(dir, { withFileTypes: true }).catch(undefinedIfMissing)) ?? [];

const subdirsOf = async (dir: string): Promise<string[]> =>
    (await entriesOf(dir)).filter((entry) => entry.isDirectory()).map((entry) => join(dir, entry.name));

// The git dirs the daemon keeps on the history volume: each repo's (`gits/<encoded id>`, git-layout.ts `repoGitDir`)
// and each history scope's (`scopes/<id>.git`). A conversation's checkouts keep their admin dirs inside a repo's, as
// `worktrees/<name>/`.
export const historyGitDirs = async (historyRoot: string): Promise<string[]> => [
    ...(await subdirsOf(join(historyRoot, "gits"))),
    ...(await subdirsOf(join(historyRoot, "scopes"))).filter((dir) => dir.endsWith(".git")),
];

// Where git takes locks and writes temporary packs in one git dir, and whether to walk below: refs nest, and objects/
// needs only its info/ and pack/, not the 256 loose-object dirs.
const placesIn = async (gitDir: string): Promise<{ readonly dir: string; readonly deep: boolean }[]> => {
    const admin = (dir: string) => [
        { dir, deep: false },
        { dir: join(dir, "refs"), deep: true },
    ];
    return [
        ...admin(gitDir),
        { dir: join(gitDir, "objects"), deep: false },
        { dir: join(gitDir, "objects", "info"), deep: true },
        { dir: join(gitDir, "objects", "pack"), deep: false },
        ...(await subdirsOf(join(gitDir, "worktrees"))).flatMap(admin),
    ];
};

const staleIn = async (dir: string, deep: boolean, now: number, found: StaleGitEntry[]): Promise<void> => {
    for (const entry of await entriesOf(dir)) {
        const path = join(dir, entry.name);
        if (entry.isDirectory() && deep) {
            await staleIn(path, deep, now, found);
            continue;
        }
        if (!entry.isFile() || gitDebrisKind(entry.name) === undefined) {
            continue;
        }
        const stats = await lstat(path).catch(undefinedIfMissing);
        const kind = stats === undefined ? undefined : staleGitEntry(entry.name, stats.mtimeMs, now);
        if (stats !== undefined && kind !== undefined) {
            found.push({ path, kind, ageMs: now - stats.mtimeMs });
        }
    }
};

// Every stale lock and temporary pack in these git dirs, read-only.
export const findStaleGitEntries = async (gitDirs: readonly string[], now: number): Promise<StaleGitEntry[]> => {
    const found: StaleGitEntry[] = [];
    for (const gitDir of gitDirs) {
        for (const { dir, deep } of await placesIn(gitDir)) {
            await staleIn(dir, deep, now, found);
        }
    }
    return found;
};

export interface GitQuietProbe {
    readonly now?: () => number;
    // Whether a git process is running: true, false, or undefined for cannot tell.
    readonly gitRunning?: () => Promise<boolean | undefined>;
}

// Looks up to `polls` times, `pollMs` apart, for a moment with no git running; answers the last look. The daemon's own
// status polls are short, so a busy sandbox still has such moments.
export const waitForNoGit = async (probe: GitQuietProbe, polls: number, pollMs: number): Promise<boolean | undefined> => {
    let running: boolean | undefined;
    for (let look = 1; look <= polls; look += 1) {
        running = await (probe.gitRunning ?? gitProcessRunning)();
        if (running === false || look === polls) {
            break;
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return running;
};

export interface StaleGitSweepOptions extends GitQuietProbe {
    readonly polls?: number;
    readonly pollMs?: number;
}

export interface StaleGitSweep {
    readonly removed: readonly StaleGitEntry[];
    // Why stale entries were found and left: a git was running, or /proc could not say.
    readonly held?: "git-running" | "unknown";
}

/**
 * Removes the stale locks and temporary packs in every history git dir and its worktrees' admin dirs, when no git
 * process is running; logs each removal with its age. Never throws: a sweep that fails costs only itself.
 */
export const clearStaleGitLocks = async (
    historyRoot: string,
    logger: Pick<Logger, "info" | "warn">,
    options: StaleGitSweepOptions = {},
): Promise<StaleGitSweep> => {
    const now = options.now ?? Date.now;
    const removed: StaleGitEntry[] = [];
    try {
        const found = await findStaleGitEntries(await historyGitDirs(historyRoot), now());
        if (found.length === 0) {
            return { removed };
        }
        // Looked for after the walk, right before removing: a git that started meanwhile may hold one of these now.
        const running = await waitForNoGit(options, options.polls ?? 3, options.pollMs ?? 1000);
        if (running !== false) {
            const held = running === true ? "git-running" : "unknown";
            logger.warn({ held, paths: found.map((entry) => entry.path) }, "git: stale locks found and left, a git process may be holding them");
            return { removed, held };
        }
        for (const entry of found) {
            // Read again: what the walk saw may have been replaced by a live git's fresh one since.
            const stats = await lstat(entry.path).catch(undefinedIfMissing);
            if (stats === undefined || staleGitEntry(basename(entry.path), stats.mtimeMs, now()) === undefined) {
                continue;
            }
            try {
                await rm(entry.path, { force: true });
                removed.push(entry);
                logger.warn(
                    { path: entry.path, kind: entry.kind, ageMinutes: Math.round(entry.ageMs / 60_000) },
                    "git: removed what a dead git left behind",
                );
            } catch (error) {
                logger.warn({ err: error, path: entry.path }, "git: could not remove a stale lock");
            }
        }
    } catch (error) {
        logger.warn({ err: error }, "git: the stale lock sweep failed");
    }
    return { removed };
};

export interface StaleGitLocksChoreDeps {
    readonly historyRoot: string;
    readonly logger: Pick<Logger, "info" | "warn">;
    readonly conversations: { readonly liveSessionIds: () => readonly string[] };
}

// The same sweep hourly while no turn is live, for a sandbox that runs for weeks between boots.
export const staleGitLocksChore = (deps: StaleGitLocksChoreDeps): Chore => ({
    name: "stale-git-locks",
    everyMs: HOUR_MS,
    when: () => deps.conversations.liveSessionIds().length === 0,
    run: async () => {
        await clearStaleGitLocks(deps.historyRoot, deps.logger);
    },
});
