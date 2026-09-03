import type { Logger } from "pino";
import { discoverRepos } from "./repo-discovery.js";
import { subscribeWorkspaceChanges } from "./workspace-watch.js";

/* Repo-set change push. The file watcher descent-ignores .git (workspace-watch.ts), so the browser can never
 * see a .git path, and with repos allowed anywhere under /work, no path pattern can tell "a repo appeared"
 * from an ordinary dir write. The daemon detects it instead: every workspace-change batch schedules a
 * throttled re-discovery, and a changed repo set is pushed to the /events stream as a reposChanged frame.
 *
 * THIS MODULE IS ALSO THE WORKSPACE'S ONE REPO-SET CACHE, and that is a second job rather than a convenience.
 * The walk is a readdir per directory plus an `access` per candidate, four levels deep, and the Changes review
 * ran its OWN copy of it inside every scan — several times a second while an agent writes, from every
 * connected browser, on top of the one this module was already doing on its own throttle. Nothing about the
 * answer was ever per-caller: a repo set can only change when something is written, which is precisely the
 * event this module already subscribes to.
 *
 * So there is one memo, and a write is what expires it. An idle workspace walks NOTHING no matter how many
 * readers ask; a busy one walks once per debounce batch no matter how many readers ask. `currentRepos` is that
 * memo, and it is what git.routes.ts reads in place of its own walk.
 *
 * WHAT THE MEMO DOES NOT WEAKEN is freshness, and the ordering is what buys that. The generation is bumped by
 * the change subscription BEFORE any reader can be answered from a memo taken before it, so a walk that raced
 * a write is published under the generation it started at and the next reader re-walks. The guarantee is
 * therefore the same one a per-caller walk gave: no reader sees a repo set from before a write it could have
 * observed. What is gone is only the repetition. */

// Discovery is a filesystem walk, cap it to one scan per window even while the agent writes continuously.
const RESCAN_THROTTLE_MS = 2_000;

export interface RepoWatch {
    subscribe(listener: (repos: string[]) => void): () => void;
    /* The repo set as of the last write: the memo when nothing has landed since it was taken, a fresh walk
     * otherwise. Concurrent callers arriving during a walk SHARE it rather than each starting one, which is
     * the case that matters — a change batch wakes every open browser's review at once. */
    currentRepos(): Promise<string[]>;
}

const createRepoWatch = (
    root: string,
    changes: (listener: (paths: string[]) => void) => () => void,
    logger?: Logger,
): RepoWatch & { close: () => void } => {
    const listeners = new Set<(repos: string[]) => void>();
    // The memo and the write it is current as of. `announced` is a different fact: what listeners last heard,
    // which only moves when the SET does, while the memo is refreshed by any write at all.
    let known: string[] | undefined;
    let knownGeneration = -1;
    let announced: string[] | undefined;
    let generation = 0;
    let walking: Promise<string[]> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastScan = 0;

    const currentRepos = (): Promise<string[]> => {
        if (known !== undefined && knownGeneration === generation) {
            return Promise.resolve(known);
        }
        if (walking !== undefined) {
            return walking;
        }
        // Read the generation BEFORE the walk, never after: a write that lands while readdir is in flight must
        // leave this answer stale, and stamping it on completion would mark it current as of a moment it never
        // saw. That is the one line standing between a shared memo and a repo set that is quietly one write old.
        const startedAt = generation;
        walking = discoverRepos(root).then(
            (repos) => {
                known = repos;
                knownGeneration = startedAt;
                walking = undefined;
                return repos;
            },
            (error: unknown) => {
                walking = undefined;
                throw error;
            },
        );
        return walking;
    };

    const rescan = async (): Promise<void> => {
        const repos = await currentRepos();
        if (announced !== undefined && repos.length === announced.length && repos.every((repo, index) => repo === announced?.[index])) {
            return;
        }
        announced = repos;
        for (const listener of listeners) {
            listener(repos);
        }
    };

    // Leading when idle, trailing while busy: the first change after a quiet spell rescans immediately, a
    // burst coalesces into one scan at the window's edge.
    const schedule = (): void => {
        if (timer !== undefined) {
            return;
        }
        timer = setTimeout(
            () => {
                timer = undefined;
                lastScan = Date.now();
                void rescan().catch((error: unknown) => logger?.warn({ err: error }, "repo rescan failed"));
            },
            Math.max(0, RESCAN_THROTTLE_MS - (Date.now() - lastScan)),
        );
        timer.unref();
    };

    // Baseline scan so the first change compares against reality, not undefined (which would always notify).
    void rescan().catch((error: unknown) => logger?.warn({ err: error }, "repo scan failed"));
    /* Expiring the memo is UNTHROTTLED where the rescan is throttled, and the two must not be confused. The
     * throttle is about how often listeners are told, which is a push nobody is waiting on; the memo is about
     * what a reader is handed right now, and holding a stale set for up to the throttle window would be a
     * Changes review that misses a repo the agent just cloned. Bumping a counter costs nothing. */
    const unsubscribe = changes(() => {
        generation += 1;
        schedule();
    });

    return {
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        currentRepos,
        close: () => {
            unsubscribe();
            if (timer !== undefined) {
                clearTimeout(timer);
                timer = undefined;
            }
        },
    };
};

// Boot-time singleton the /events handler subscribes to, mirroring workspace-watch's pattern.
let instance: RepoWatch | undefined;
// The root the singleton was started for, so a caller asking about a different one gets a real walk rather
// than another workspace's memo. One daemon serves one workspace, so this only ever separates tests.
let watchedRoot: string | undefined;
export const startRepoWatch = (root: string, logger: Logger): void => {
    if (instance === undefined) {
        instance = createRepoWatch(root, subscribeWorkspaceChanges, logger);
        watchedRoot = root;
    }
};
export const subscribeRepoChanges = (listener: (repos: string[]) => void): (() => void) => instance?.subscribe(listener) ?? (() => undefined);

/* THE REPO SET, for everything that needs one. Backed by the watch's memo when the watch is running, and by a
 * plain walk when it is not — a `local` profile that starts no watcher, and every test that builds a router
 * without one, must still get a correct answer rather than an empty list. */
export const currentRepos = async (root: string): Promise<string[]> =>
    instance !== undefined && watchedRoot === root ? instance.currentRepos() : discoverRepos(root);
