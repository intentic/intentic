import { join } from "node:path";
import { watch, type FSWatcher } from "chokidar";
import type { Logger } from "pino";
import { Coalescer } from "@intentic/base/async";
import { defaultGit, type GitRunner } from "@intentic/scaffold";

/* REF-MOVE PUSH, the third change feed, beside the file watcher and the repo-set differ.
 *
 * The other two cannot carry this, and not by omission. A repo's git dir is RELOCATED OFF /work entirely (onto
 * /history, so an isolated turn's worktree can stand in for the workspace root, repo-git-dirs.ts explains why),
 * and the workspace watcher descent-ignores `.git` on top of that. So no path the browser ever sees can say "a
 * commit landed". Without this feed the commit graph is exactly as fresh as the last thing the user clicked,
 * and in this product most commits are not the user's at all: the agent commits, rebases and lands out-of-band.
 *
 * WHAT IS WATCHED, and why these and not the git dir wholesale: `objects/` is rewritten continuously by fetch,
 * gc and every commit, and watching it would turn one `git fetch` into thousands of wake-ups for information
 * already carried by the ref that moved. So this watches the places a REF or an operation marker is written:
 *
 *   commondir  refs/**            branch/tag/remote-tracking updates, and creation + deletion
 *              packed-refs        the same after a gc or a clone packs them away
 *   gitdir     HEAD               a checkout, and which branch a commit lands on
 *              logs/HEAD          the reflog, a commit that moves HEAD without touching a loose ref
 *              MERGE_HEAD …       a merge, cherry-pick or revert starting, finishing or being aborted
 *              rebase-merge/ …    the same for either rebase backend, and for a queued sequencer run
 *
 * The two dirs are resolved SEPARATELY and both are watched, because in a linked worktree they differ: refs and
 * packed-refs are shared in the common dir, while HEAD and the in-progress markers are per worktree. Every agent
 * session in this product runs in a linked worktree, so a watcher that assumed one dir would miss half of what
 * it exists to catch. In the main checkout they resolve to the same path and the duplicate watch collapses. */

// One batch fires this long after the FIRST move in a window, so a rebase replaying forty commits is one frame
// rather than forty. Matches the file watcher's own debounce.
export const BATCH_MS = 250;

/* The coalescing rule itself, apart from the watcher that feeds it: repo names accumulate while the window is
 * open and go out as one sorted, deduplicated batch when it closes, so a commit that writes both a ref and the
 * reflog names its repo once.
 *
 * It is a separate factory for the same reason createPathBatcher is one in workspace-watch.ts: it is the only
 * part of this file a test can pin down. Counting batches behind a real watcher measures how fast a loaded
 * machine ran three git subprocesses and delivered their inotify events, not what this code does, the "green on
 * a box, red on a busy runner" trap _tools/testing/src/vitest.ts is written against. Reached without a watcher
 * in front of it, the rule answers to timers the test owns.
 *
 * A Coalescer, not a Delayer: the window opens on the FIRST move and later ones join it rather than pushing the
 * deadline out, so a rebase that never goes quiet still reports within a window instead of only once it ends. */
export const createRepoBatcher = (emit: (repos: string[]) => void): Coalescer<string> =>
    new Coalescer<string>(BATCH_MS, (batch) => emit([...new Set(batch)].toSorted()));

export interface RefWatch {
    subscribe(listener: (repos: string[]) => void): () => void;
}

// A repo's git dir and its common dir, absolute. Asking git rather than guessing is what makes this work for a
// relocated git dir, a linked worktree, and a plain in-tree `.git` alike.
const gitDirsOf = async (dir: string, git: GitRunner): Promise<{ gitDir: string; commonDir: string } | undefined> => {
    try {
        const { stdout } = await git(dir, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"]);
        const [gitDir, commonDir] = stdout.trim().split("\n");
        return gitDir === undefined || commonDir === undefined ? undefined : { gitDir, commonDir: commonDir === "" ? gitDir : commonDir };
    } catch {
        // Not a repo (yet), a directory the discovery listed a moment before it was removed, or a clone still
        // being written. The next repo-set frame re-runs this.
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
        // A second call may have won while this one awaited git, keep the first and drop this one, or the map
        // loses a watcher it can never close.
        if (watchers.has(repo)) {
            return;
        }
        /* `ignoreInitial` because chokidar otherwise reports every existing ref as an `add` at startup, which
         * would announce a move for every repo the moment the daemon boots. `depth: 2` bounds the refs walk:
         * `refs/heads/<name>` and `refs/remotes/<remote>/<name>` are the deep cases, and a ref hierarchy nested
         * further than that is not one any surface here renders. */
        const watcher = watch(watchPaths(dirs), { ignoreInitial: true, depth: 2 });
        watcher.on("all", () => batcher.add(repo));
        watcher.on("error", (error) => logger?.warn({ err: error, repo }, "ref watch error"));
        watchers.set(repo, watcher);
    };

    // Repos come and go (a clone, a scaffold, a delete), so the watcher set is reconciled against each repo-set
    // frame rather than built once. "root" is always in it: the /work repo is where every landed agent branch
    // lands, and discovery legitimately omits it (it is the container the others are discovered inside).
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
