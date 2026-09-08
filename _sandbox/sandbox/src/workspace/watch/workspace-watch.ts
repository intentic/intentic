import { Worker } from "node:worker_threads";
import { realpathSync } from "node:fs";
import { Coalescer } from "@intentic/base/async";
import { STATE_DIR } from "@intentic/constants";
import { type AsyncSubscription, subscribe } from "@parcel/watcher";
import type { Logger } from "pino";
import { IGNORED_DIRS, isAgentWorktreePath, isBrowserProfilePath, isReferencePath, REFERENCE_DIR, toRelPath } from "@intentic/workspace-ignore";
import { stateRelPath } from "../layout/state-paths.js";

// Live file-change push: the agent edits /work out-of-band, so nothing else tells the browser its view is stale. One
// watcher on the workspace root batches changed paths and forwards them over /events, debounced into one frame per
// burst.

// The daemon's own machine state under .intentic/; watching it is a feedback loop, not a change feed.
// - cache/ (SQLite WALs) rewrites continuously during a rebuild's re-parse or re-embed
// - sessions, provider homes, connector runtime, agent scratch and the pnpm store are all machine-written roots
// Manifests (capabilities, automations, settings, environment, approvals, drafts) stay watched, since that's how
// another member's write reaches this browser; spelled via stateRelPath so a renamed store breaks this list at compile
// time.
const DAEMON_STATE_PATHS = [
    stateRelPath(".intentic/local/cache/"),
    stateRelPath(".intentic/secrets/auth/"),
    stateRelPath(".intentic/records/sessions/claude/"),
    stateRelPath(".intentic/local/runtime/"),
    stateRelPath(".intentic/local/tmp/"),
    stateRelPath(".intentic/local/.pnpm-store/"),
];
const isDaemonStatePath = (relPath: string): boolean => {
    const segments = relPath.split(/[\\/]/);
    const index = segments.indexOf(STATE_DIR);
    const path = segments.slice(index).join("/");
    return index !== -1 && DAEMON_STATE_PATHS.some((root) => path === root || path.startsWith(`${root}/`));
};

// One rule declares both a glob (prunes descent) and a predicate (the real authority; a wrong glob only costs descent,
// never a wrong answer), so they can't drift. Depth is part of each rule: the reference shelf is root-only, everything
// else matches any depth.
interface WatchIgnoreRule {
    readonly globs: readonly string[];
    readonly matches: (relPath: string) => boolean;
}

const WATCH_IGNORE_RULES: readonly WatchIgnoreRule[] = [
    // Same dirs the tree grays and lazy-loads, read off the shared list rather than restated.
    {
        globs: [...IGNORED_DIRS].map((dir) => `**/${dir}`),
        matches: (relPath) => relPath.split(/[\\/]/).some((segment) => IGNORED_DIRS.has(segment)),
    },
    // A connected browser's profile churns constantly (Chromium rewrites Cookies etc.).
    { globs: [`**/${stateRelPath(".intentic/local/browser/")}`], matches: isBrowserProfilePath },
    // Agent worktrees are whole checkouts edited at full speed; sibling .claude config still pushes.
    { globs: ["**/.claude/worktrees"], matches: isAgentWorktreePath },
    // A reference clone into the shelf writes thousands of files in one burst.
    { globs: [REFERENCE_DIR], matches: isReferencePath },
    { globs: DAEMON_STATE_PATHS.map((path) => `**/${path}`), matches: isDaemonStatePath },
];

// Root-relative form, for the watcher callback that already paid for the conversion.
const isWatchIgnoredRel = (relPath: string): boolean => WATCH_IGNORE_RULES.some((rule) => rule.matches(relPath));

export const isWatchIgnored = (root: string, abs: string): boolean => isWatchIgnoredRel(toRelPath(root, abs));

// Every rule's globs, each covering both the directory itself and everything beneath it.
export const watchIgnoreGlobs = (): string[] => WATCH_IGNORE_RULES.flatMap((rule) => rule.globs.flatMap((glob) => [glob, `${glob}/**`]));

// Fires 250ms after the window's first change, not reset per event, bounding latency under continuous edits.
export const DEBOUNCE_MS = 250;
// Past this many files, an empty batch ("just refetch the tree") replaces a giant, not-worth-it path list.
export const MAX_PATHS = 200;

export type PathBatcher = Coalescer<string>;

// The coalescing rule apart from the watcher: paths accumulate into a set (deduping repeats) and flush as one batch
// when the window closes. Separate factory so a test can drive it on its own timers, instead of measuring real
// filesystem timing.
export const createPathBatcher = (emit: (paths: string[]) => void): PathBatcher =>
    // A Coalescer, not a Delayer: the window opens on the first path, so continuous edits still flush every ~250ms.
    new Coalescer<string>(DEBOUNCE_MS, (batch) => {
        // A file touched twice inside one window is announced once.
        const paths = new Set(batch);
        emit(paths.size > MAX_PATHS ? [] : [...paths]);
    });

export interface WorkspaceWatch {
    subscribe(listener: (paths: string[]) => void): () => void;
    close(): Promise<void>;
}

interface WorkerMessage {
    readonly kind: "paths" | "error";
    readonly paths?: string[];
    readonly message?: string;
}

// Isolates the watcher in its own thread; the original reason (thousands of per-directory libuv handles) is gone now
// that the native backend holds one handle for the whole tree. Kept anyway so a crash lands here, not on the daemon,
// and so retiring it can be its own deliberate change.
const createIsolatedWorkspaceWatch = (root: string, logger: Logger): WorkspaceWatch => {
    const listeners = new Set<(paths: string[]) => void>();
    const worker = new Worker(new URL("./workspace-watch-worker.js", import.meta.url), { workerData: { root } });
    worker.on("message", (message: WorkerMessage) => {
        if (message.kind === "error") {
            logger.warn({ err: new Error(message.message ?? "workspace watcher failed") }, "workspace watcher error");
            return;
        }
        const paths = message.paths ?? [];
        for (const listener of listeners) {
            listener(paths);
        }
    });
    worker.on("error", (err) => logger.warn({ err }, "workspace watcher worker error"));
    return {
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        close: async () => {
            await worker.terminate();
        },
    };
};

export const createWorkspaceWatch = (root: string, logger?: Logger): WorkspaceWatch => {
    // @parcel/watcher refuses a symlink root; resolved only for the backend, paths stay relative to the given root.
    const watchedRoot = realpathSync(root);
    const listeners = new Set<(paths: string[]) => void>();
    const batcher = createPathBatcher((paths) => {
        for (const listener of listeners) {
            listener(paths);
        }
    });

    // One native handle for the whole tree; close() must await the async subscribe first, or a fast close leaks it.
    let subscription: AsyncSubscription | undefined;
    let closed = false;
    const started = subscribe(
        watchedRoot,
        (err, events) => {
            // Degrades rather than throws on a hiccup; logged, since a dead watcher otherwise fails silently.
            if (err) {
                logger?.warn({ err }, "workspace watcher error");
                return;
            }
            for (const event of events) {
                const relPath = toRelPath(watchedRoot, event.path);
                if (!isWatchIgnoredRel(relPath)) {
                    batcher.add(relPath);
                }
            }
        },
        { ignore: watchIgnoreGlobs() },
    )
        .then(async (sub) => {
            // If close() wins the race while still arming, it tears the subscription down; unsubscribe runs exactly
            // once.
            if (closed) {
                await sub.unsubscribe();
                return;
            }
            subscription = sub;
        })
        .catch((err: unknown) => logger?.warn({ err }, "workspace watcher failed to start"));

    return {
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        close: async () => {
            closed = true;
            await started;
            const sub = subscription;
            subscription = undefined;
            await sub?.unsubscribe();
            // Drops the last window's accumulation; a closed watcher must not announce into an already-gone temp root.
            batcher.dispose();
        },
    };
};

// Boot-time singleton the /events handler subscribes to, kept a plain factory so tests can drive their own. Subscribers
// register into a set that outlives the start, so one taken before the watcher spins up still gets fanned out to.
const subscribers = new Set<(paths: string[]) => void>();
let instance: WorkspaceWatch | undefined;
export const startWorkspaceWatch = (root: string, logger: Logger): void => {
    if (instance === undefined) {
        instance = createIsolatedWorkspaceWatch(root, logger);
        instance.subscribe((paths) => {
            for (const listener of subscribers) {
                listener(paths);
            }
        });
    }
};
export const subscribeWorkspaceChanges = (listener: (paths: string[]) => void): (() => void) => {
    subscribers.add(listener);
    return () => subscribers.delete(listener);
};
