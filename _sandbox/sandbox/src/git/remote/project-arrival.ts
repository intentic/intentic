import { join } from "node:path";
import { defaultGit, type GitRunner } from "@intentic/base/git";
import type { Logger } from "pino";
import { headSha } from "../changes/changes.js";
import { initialSubject } from "./project-repo.js";
import { commitWorktreeRemainder } from "./root-repo.js";

// THE FOLDER'S FIRST COPY, COMMITTED AS IT LANDS. A project folder's repo is born at the first boot (project-repo.ts),
// usually before file sync has copied a single file, so its first commit is empty and everything the copy then
// delivers reads in the Changes review as hundreds of uncommitted adds: the owner opens a fresh sandbox on "99+
// changes" they never made. The turn boundary commits them (version-landed.ts), but only once a turn runs. Until then,
// each time the folder's files go quiet, whatever arrived is committed under the same subject the first commit took, so
// the review opens clean on the folder as received and lists only what changes after it.
//
// Only while the repo stands at its arrival: every commit on HEAD is one of these, and the first is less than
// ARRIVAL_WINDOW_MS old. The first commit a turn or a land makes closes it for good, and so does the clock, so an edit
// the owner makes in their folder later is never filed as part of what the sandbox received. Only the project folder's
// own repo, which is the daemon's bookkeeping (nothing here reaches the owner's `.git`); the root repo has its baseline,
// and every other repo's commits are its owner's.

// How long the folder's files must stay still before what arrived is committed: long enough that a copy still running
// is not cut into many commits, short enough that the owner opening the review meanwhile sees it settle.
const ARRIVAL_QUIET_MS = 10_000;
// How long after the first commit a quiet folder is still read as arriving.
export const ARRIVAL_WINDOW_MS = 60 * 60_000;
// More arrival commits than this is not an arrival any more, and keeps the log read short.
const ARRIVAL_COMMITS_MAX = 50;

// THE FOLDERS STILL LANDING (2026-10-25). The quiet commit leaves a window as long as the copy itself in which every
// file delivered so far is an uncommitted add, so the review still opened on "99+" and dropped to nothing once the copy
// went quiet: a flicker the owner reads as changes they never made. A folder is landing from the batch that reached it
// until the quiet commit that files it has run, and the review leaves its rows out meanwhile (git.routes.ts), since
// they are about to be committed as the folder received. Keyed by the folder's name, which is its repo's.
const landing = new Set<string>();

/** Whether the project folder `name` is mid-copy: files reached it and the commit that files them is still to run. */
export const arrivalLanding = (name: string): boolean => landing.has(name);

// Whether the repo at `dir` still stands at its arrival. An unborn repo is not: there is nothing to tell. One git cannot
// read throws, for the caller to log.
export const arrivalOpen = async (dir: string, name: string, now: number, git: GitRunner = defaultGit): Promise<boolean> => {
    if ((await headSha(dir, git)) === undefined) {
        return false;
    }
    const listing = await git(dir, ["log", "-n", String(ARRIVAL_COMMITS_MAX + 1), "--format=%ct%x09%s", "HEAD"]);
    const commits = listing.stdout.split("\n").filter((line) => line !== "");
    const subject = initialSubject(name);
    if (commits.length === 0 || commits.length > ARRIVAL_COMMITS_MAX || commits.some((line) => line.slice(line.indexOf("\t") + 1) !== subject)) {
        return false;
    }
    const first = commits.at(-1) ?? "";
    const bornAt = Number(first.slice(0, first.indexOf("\t"))) * 1000;
    return Number.isFinite(bornAt) && now - bornAt < ARRIVAL_WINDOW_MS;
};

// Commits whatever has arrived in the folder since its last arrival commit, if it still stands at its arrival. True
// when it committed.
export const commitArrival = async (workspaceRoot: string, name: string, now: number, git: GitRunner = defaultGit): Promise<boolean> => {
    const dir = join(workspaceRoot, name);
    if (!(await arrivalOpen(dir, name, now, git))) {
        return false;
    }
    return commitWorktreeRemainder(name, dir, initialSubject(name), workspaceRoot, git);
};

export interface ProjectArrivalDeps {
    readonly workspaceRoot: string;
    // The project folder's name in /work, which is its repo's name.
    readonly name: string;
    // The repo's op chain, so the commit queues behind a land or a discard rather than racing it.
    readonly withRepoLock: <T>(repo: string, task: () => Promise<T>) => Promise<T>;
    // The workspace watcher's batches, root-relative; an empty batch is "something moved, too much to name".
    readonly subscribe: (listener: (paths: string[]) => void) => () => void;
    readonly logger: Pick<Logger, "info" | "warn">;
    // Told when the folder stops landing, so a review that left its rows out reads it again.
    readonly landed?: () => void;
    readonly quietMs?: number;
    readonly now?: () => number;
    readonly git?: GitRunner;
}

// Follows the folder while it arrives; the returned stop ends it. A repo already past its arrival is left at once. One
// quiet commit is armed at the start too, for files that landed before this boot's watcher did.
export const followProjectArrival = (deps: ProjectArrivalDeps): (() => void) => {
    const { workspaceRoot, name, logger } = deps;
    const quietMs = deps.quietMs ?? ARRIVAL_QUIET_MS;
    const now = deps.now ?? Date.now;
    const git = deps.git ?? defaultGit;
    const prefix = `${name}/`;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;
    // Bumped by every arm, so a settle knows whether a batch came in while it ran (the folder is still landing).
    let armed = 0;
    const landed = (): void => {
        if (landing.delete(name)) {
            deps.landed?.();
        }
    };
    const stop = (): void => {
        stopped = true;
        clearTimeout(timer);
        unsubscribe?.();
        unsubscribe = undefined;
        landed();
    };
    const settle = async (generation: number): Promise<void> => {
        if (stopped) {
            return;
        }
        try {
            if (await deps.withRepoLock(name, () => commitArrival(workspaceRoot, name, now(), git))) {
                logger.info({ repo: name }, "project folder: what file sync delivered is committed as the folder this sandbox received");
            }
            if (!(await arrivalOpen(join(workspaceRoot, name), name, now(), git))) {
                stop();
            }
        } catch (error) {
            // Left for the next quiet, or the next turn's boundary, which commits the folder whatever stands.
            logger.warn({ err: error, repo: name }, "project folder: what file sync delivered could not be committed yet");
        } finally {
            // Ended here only when no later batch armed the next quiet; a failed commit ends it too, since what is left
            // uncommitted is then for the review to show.
            if (generation === armed) {
                landed();
            }
        }
    };
    const arm = (): void => {
        armed += 1;
        const generation = armed;
        landing.add(name);
        clearTimeout(timer);
        timer = setTimeout(() => void settle(generation), quietMs);
        timer.unref?.();
    };
    void arrivalOpen(join(workspaceRoot, name), name, now(), git)
        .then((open) => {
            if (!open || stopped) {
                return;
            }
            unsubscribe = deps.subscribe((paths) => {
                if (paths.length === 0 || paths.some((path) => path === name || path.startsWith(prefix))) {
                    arm();
                }
            });
            arm();
        })
        // Not followed this boot: the next turn's boundary commits the folder whatever stands.
        .catch((error: Error) => logger.warn({ err: error, repo: name }, "project folder: could not tell whether it is still arriving"));
    return stop;
};
