import { sep } from "node:path";
import { Worker } from "node:worker_threads";
import { watch } from "chokidar";
import type { Logger } from "pino";
import { IQ_DIR } from "@intentic/iq-engine";
import { IGNORED_DIRS, isAgentWorktreePath, isBrowserProfilePath, isReferencePath, toRelPath } from "@intentic/workspace-ignore";

// Live file-change push. The agent edits /work out-of-band (its own Write/Edit/Bash tools — never the daemon's
// HTTP routes), so nothing else can tell the browser its view went stale. A single filesystem watcher on the
// workspace root fills that gap: it batches the paths that changed and hands them to whoever is holding the
// /events SSE stream open, which forwards them so the browser refreshes the tree + any open file with no manual
// Refresh. The batch is debounced so a burst of agent edits is one frame, not hundreds.

// Skip the same dirs the tree grays + lazy-loads so we don't drown in node_modules / .git / browser-profile
// churn. This is a DESCENT filter (chokidar never watches inside a dir it ignores) — the reason for chokidar over
// node's recursive fs.watch, which can't skip node_modules for descent and would exhaust inotify on the
// three-repo tree.
// ponytail: descent-ignore only (junk dirs incl. .git + browser profiles); a .gitignore'd file outside those
//           still emits and just triggers a harmless tree refetch. A change inside a lazy-loaded ignored dir
//           won't push live — re-expanding that dir re-fetches it. Upgrade only if that ever matters.
const IGNORE_SEGMENTS = new Set(IGNORED_DIRS);

// The daemon's OWN machine state under .intentic/ — watching it is a feedback loop, not a change feed:
// - the iq index is a SQLite db whose WAL is rewritten continuously for MINUTES whenever a rebuilt daemon
//   re-parses (PARSER_VERSION) or re-embeds (MODEL_ID) the workspace. Every write used to come back as a
//   change batch, which re-marked the engine dirty (main.ts) — a full /work sweep every couple of seconds —
//   and cost every connected browser a tree refetch plus a manifest invalidation, four times a second, for as
//   long as the rebuild took. The engine already excludes the dir from its own views (isIqDenied).
// - agent sessions, provider homes, caches, and connector runtime are all daemon-owned and can rewrite at token
//   or request cadence, so they are classified as roots rather than enumerated one store at a time.
// None of it is source and nothing derives from watching it. The .intentic/ MANIFESTS (capabilities,
// automations, settings, the environment Dockerfiles, approvals, drafts) stay watched — those changes are
// exactly how another member's write reaches this browser.
//
const DAEMON_STATE_PATHS = [IQ_DIR, ".intentic/auth", ".intentic/sessions", ".intentic/runtime"];
const isDaemonStatePath = (abs: string): boolean => {
    const segments = abs.split(sep);
    const index = segments.indexOf(".intentic");
    const path = segments.slice(index).join("/");
    return index !== -1 && DAEMON_STATE_PATHS.some((root) => path === root || path.startsWith(`${root}/`));
};

export const isWatchIgnored = (root: string, abs: string): boolean => {
    const segments = abs.split(sep);
    // A connected browser's profile churns constantly (Chromium rewrites Cookies etc.), agent worktrees are whole
    // checkouts an agent edits at full speed, and a reference clone into the shelf writes thousands of files in
    // one burst — never watch any of them, or every write fires a tree refetch. The shelf is root-level-only,
    // so its predicate needs the root-relative path, not the absolute one.
    return (
        segments.some((segment) => IGNORE_SEGMENTS.has(segment)) ||
        isBrowserProfilePath(abs) ||
        isAgentWorktreePath(abs) ||
        isReferencePath(toRelPath(root, abs)) ||
        isDaemonStatePath(abs)
    );
};

// One batch fires 250ms after the FIRST change of a window (not reset per event), so latency is bounded to
// ~250ms even while the agent edits continuously, and everything inside the window coalesces into one frame.
const DEBOUNCE_MS = 250;
// A change touching more than this many visible files (branch switch, codegen, mass rename) sends an empty batch
// — "just refetch the tree" — instead of a giant path list. The tree refetch covers it; per-file re-read/highlight
// isn't worth the frame size at that scale.
const MAX_PATHS = 200;

export interface WorkspaceWatch {
    subscribe(listener: (paths: string[]) => void): () => void;
    close(): Promise<void>;
}

interface WorkerMessage {
    readonly kind: "paths" | "error";
    readonly paths?: string[];
    readonly message?: string;
}

/* Production isolation for the recursive watcher. Chokidar implements ignored-directory descent correctly,
 * but it represents every watched directory as one libuv FSEvent handle. The live workspace had 3,321 of
 * them on the daemon isolate: its initial walk, burst bookkeeping, and GC all ran beside /events heartbeats.
 * One watcher instance was therefore still thousands of control-plane handles.
 *
 * Keep chokidar's precise descent filter, but own it in another isolate. It also owns debounce + path
 * coalescing (createWorkspaceWatch below), so a checkout/build storm crosses this MessagePort as one bounded
 * batch every 250ms — never as thousands of filesystem callbacks. */
export const createIsolatedWorkspaceWatch = (root: string, logger: Logger): WorkspaceWatch => {
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
    const listeners = new Set<(paths: string[]) => void>();
    const pending = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const flush = (): void => {
        timer = undefined;
        if (pending.size === 0) {
            return;
        }
        const paths = pending.size > MAX_PATHS ? [] : [...pending];
        pending.clear();
        for (const listener of listeners) {
            listener(paths);
        }
    };

    const watcher = watch(root, { ignoreInitial: true, followSymlinks: false, ignored: (path) => isWatchIgnored(root, path) });
    watcher.on("all", (_event, abs) => {
        pending.add(toRelPath(root, abs));
        timer ??= setTimeout(flush, DEBOUNCE_MS);
    });
    // A watch hiccup (inotify limit, transient EACCES) must not take the daemon down — the manual Refresh still
    // works, so degrade rather than crash on an unhandled 'error' event. Logged, not swallowed: a dead watcher
    // means live refresh silently stops, and the log line is the only trace of why.
    watcher.on("error", (err) => logger?.warn({ err }, "workspace watcher error"));

    return {
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        close: () => watcher.close(),
    };
};

// Boot-time singleton the /events handler subscribes to. Started once in main.ts (like the announcer/scheduler),
// so createWorkspaceWatch stays a plain factory the test can drive and close on its own temp root.
//
// Subscribers register into a module-level set that outlives the start: the daemon listens (and /events
// streams open) BEFORE the watcher spins up its /work scan, and a subscription taken in that window used to
// be silently dropped — a whole browser session with no live tree refresh. The watcher, whenever it starts,
// fans out to whatever the set holds by then.
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
