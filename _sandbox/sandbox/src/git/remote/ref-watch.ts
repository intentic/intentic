import { join } from "node:path";
import { watch, type FSWatcher } from "chokidar";
import type { Logger } from "pino";
import { Coalescer } from "@intentic/base/async";
import { defaultGit, type GitRunner } from "@intentic/scaffold";

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

// A repo's git dir and common dir, absolute; asked of git rather than guessed, so a relocated dir, a linked worktree
// and a plain `.git` all work.
const gitDirsOf = async (dir: string, git: GitRunner): Promise<{ gitDir: string; commonDir: string } | undefined> => {
    try {
        const { stdout } = await git(dir, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"]);
        const [gitDir, commonDir] = stdout.trim().split("\n");
        return gitDir === undefined || commonDir === undefined ? undefined : { gitDir, commonDir: commonDir === "" ? gitDir : commonDir };
    } catch {
        // Not a repo yet, mid-removal, or a clone still being written; the next repo-set frame retries.
        return undefined;
    }
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
    git: GitRunner = defaultGit,
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
        const dirs = await gitDirsOf(repo === "root" ? root : join(root, repo), git);
        if (dirs === undefined) {
            return;
        }
        // A second call may have won the race while this one awaited git; drop this one or the map leaks a watcher.
        if (watchers.has(repo)) {
            return;
        }
        // `ignoreInitial`: chokidar otherwise reports every existing ref as an `add` at boot. `depth: 2` covers
        // `refs/heads/<name>` and `refs/remotes/<remote>/<name>`, the deepest cases any surface renders.
        const watcher = watch(watchPaths(dirs), { ignoreInitial: true, depth: 2 });
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

// Boot-time singleton the /events handler subscribes to, mirroring repo-watch's pattern.
let instance: (RefWatch & { close: () => void }) | undefined;
export const startRefWatch = (root: string, repos: (listener: (repos: string[]) => void) => () => void, logger: Logger): void => {
    instance ??= createRefWatch(root, repos, logger);
};
export const subscribeRefChanges = (listener: (repos: string[]) => void): (() => void) => instance?.subscribe(listener) ?? (() => undefined);
