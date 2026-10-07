import { join } from "node:path";
import { watch, type FSWatcher } from "chokidar";
import type { Logger } from "pino";
import { Coalescer } from "@intentic/base/async";
import { commonDirOf, gitDirOf } from "../git-dir.js";

// A third change feed (beside the file watcher and repo-set differ): the git dir is often relocated off /work and the
// file watcher ignores `.git`, so nothing else can say a commit landed. Watches only where a ref or operation marker is
// written, not `objects/` (rewritten by every fetch/gc):
// - commondir: refs/**, packed-refs
// - gitdir: HEAD, logs/HEAD, MERGE_HEAD/CHERRY_PICK_HEAD/REVERT_HEAD, rebase-merge/rebase-apply/sequencer
// Both dirs are resolved and watched separately, since a linked worktree splits them (refs are common, HEAD is
// per-worktree).

// Time after the first move before a batch fires, coalescing a burst; matches the file watcher's debounce.
export const BATCH_MS = 250;

// Coalesces names into one sorted, deduped batch per window, factored out so tests use owned timers, not real inotify
// timing. A Coalescer: the window opens on the first move; later ones join it, not reset it.
export const createRepoBatcher = (emit: (repos: string[]) => void): Coalescer<string> =>
    new Coalescer<string>(BATCH_MS, (batch) => emit([...new Set(batch)].toSorted()));

export interface RefWatch {
    subscribe(listener: (repos: string[]) => void): () => void;
}

// A repo's git dir and common dir, absolute; read off the filesystem (git/git-dir.ts) rather than guessed, so a
// relocated dir, a linked worktree and a plain `.git` all work, and a repo-set frame spawns no git per repo.
const gitDirsOf = async (dir: string): Promise<{ gitDir: string; commonDir: string } | undefined> => {
    // Not a repo yet, mid-removal, or a clone still being written: undefined, and the next repo-set frame retries.
    const gitDir = await gitDirOf(dir);
    return gitDir === undefined ? undefined : { gitDir, commonDir: await commonDirOf(gitDir) };
};

const watchPaths = ({ gitDir, commonDir }: { gitDir: string; commonDir: string }): string[] => [
    join(commonDir, "refs"),
    join(commonDir, "packed-refs"),
    join(gitDir, "HEAD"),
    join(gitDir, "logs", "HEAD"),
    join(gitDir, "MERGE_HEAD"),
    join(gitDir, "CHERRY_PICK_HEAD"),
    join(gitDir, "REVERT_HEAD"),
    join(gitDir, "rebase-merge"),
    join(gitDir, "rebase-apply"),
    join(gitDir, "sequencer"),
];

export const createRefWatch = (
    root: string,
    repos: (listener: (repos: string[]) => void) => () => void,
    logger?: Logger,
): RefWatch & { close: () => void } => {
    const listeners = new Set<(repos: string[]) => void>();
    const watchers = new Map<string, FSWatcher>();
    const batcher = createRepoBatcher((batch) => {
        for (const listener of listeners) {
            listener(batch);
        }
    });

    const watchRepo = async (repo: string): Promise<void> => {
        if (watchers.has(repo)) {
            return;
        }
        const dirs = await gitDirsOf(repo === "root" ? root : join(root, repo));
        if (dirs === undefined) {
            return;
        }
        // A second call may have won the race while this one read the git dirs; drop this one or the map leaks a watcher.
        if (watchers.has(repo)) {
            return;
        }
        // `ignoreInitial`: chokidar otherwise reports every existing ref as an `add` at boot. No depth limit: a branch
        // name may hold any number of slashes (`refs/remotes/origin/agent/<name>`, `dependabot/npm_and_yarn/…`), and a
        // refs tree is small.
        const watcher = watch(watchPaths(dirs), { ignoreInitial: true });
        watcher.on("all", () => batcher.add(repo));
        watcher.on("error", (error) => logger?.warn({ err: error, repo }, "ref watch error"));
        watchers.set(repo, watcher);
    };

    // Reconciled against each repo-set frame, since repos come and go. `root` is always included: discovery omits it
    // (the container the others are found inside), but every landed branch lands there.
    const reconcile = (discovered: readonly string[]): void => {
        const wanted = new Set(["root", ...discovered]);
        for (const [repo, watcher] of watchers) {
            if (!wanted.has(repo)) {
                watchers.delete(repo);
                void watcher.close();
            }
        }
        for (const repo of wanted) {
            void watchRepo(repo).catch((error: unknown) => logger?.warn({ err: error, repo }, "ref watch setup failed"));
        }
    };

    reconcile([]);
    const unsubscribe = repos(reconcile);

    return {
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        close: () => {
            unsubscribe();
            batcher.dispose();
            for (const watcher of watchers.values()) {
                void watcher.close();
            }
            watchers.clear();
        },
    };
};

// Boot-time singleton the /events handler subscribes to, as repo-watch's is: subscribers register into a set that
// outlives the start, so one taken while boot is still under way hears every ref move once the watch is up.
const subscribers = new Set<(repos: string[]) => void>();
let instance: (RefWatch & { close: () => void }) | undefined;
// Returns the stop, for the daemon's shutdown.
export const startRefWatch = (root: string, repos: (listener: (repos: string[]) => void) => () => void, logger: Logger): (() => void) => {
    if (instance === undefined) {
        const refWatch = createRefWatch(root, repos, logger);
        refWatch.subscribe((moved) => {
            for (const listener of subscribers) {
                listener(moved);
            }
        });
        instance = refWatch;
    }
    return () => {
        instance?.close();
        instance = undefined;
    };
};
export const subscribeRefChanges = (listener: (repos: string[]) => void): (() => void) => {
    subscribers.add(listener);
    return () => subscribers.delete(listener);
};
