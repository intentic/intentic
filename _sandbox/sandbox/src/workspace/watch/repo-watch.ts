import type { Logger } from "pino";
import { discoverRepos } from "../layout/repo-discovery.js";
import { subscribeWorkspaceChanges } from "./workspace-watch.js";

// The workspace's one repo-set cache: one memo shared by every caller, expired by any write, so an idle workspace never
// walks and a busy one walks once per debounce batch. The generation bumps before a reader is answered, so nobody ever
// sees a set from before a write it could have observed; a changed set also pushes as a reposChanged frame.

// Filesystem walk, capped to one scan per window even under continuous writes.
const RESCAN_THROTTLE_MS = 2_000;

export interface RepoWatch {
    subscribe(listener: (repos: string[]) => void): () => void;
    // Memo if nothing changed since, else a fresh walk shared by every concurrent caller.
    currentRepos(): Promise<string[]>;
}

const createRepoWatch = (
    root: string,
    changes: (listener: (paths: string[]) => void) => () => void,
    logger?: Logger,
): RepoWatch & { close: () => void } => {
    const listeners = new Set<(repos: string[]) => void>();
    // The memo and its write generation; `announced` differs; it moves only when the set itself changes.
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
        // Generation read before the walk starts, not after, or a write landing mid-walk would be missed as stale.
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

    // Leading when idle, trailing while busy: a quiet spell rescans at once, a burst coalesces to one scan.
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

    // Baseline scan, so the first change compares against reality, not undefined.
    void rescan().catch((error: unknown) => logger?.warn({ err: error }, "repo scan failed"));
    // Memo expiry is untethered from the throttle: a reader must never wait out the window for a fresh set.
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
// Root the singleton watches; a different root gets a real walk, not this one's memo (only tests differ here).
let watchedRoot: string | undefined;
export const startRepoWatch = (root: string, logger: Logger): void => {
    if (instance === undefined) {
        instance = createRepoWatch(root, subscribeWorkspaceChanges, logger);
        watchedRoot = root;
    }
};
export const subscribeRepoChanges = (listener: (repos: string[]) => void): (() => void) => instance?.subscribe(listener) ?? (() => undefined);

// The repo set for anything that needs one: the watch's memo when it's running, a plain walk otherwise (a `local`
// profile, a router built with no watcher in tests).
export const currentRepos = async (root: string): Promise<string[]> =>
    instance !== undefined && watchedRoot === root ? instance.currentRepos() : discoverRepos(root);
