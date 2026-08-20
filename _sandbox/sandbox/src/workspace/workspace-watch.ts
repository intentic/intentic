import { Worker } from "node:worker_threads";
import { realpathSync } from "node:fs";
import { Coalescer } from "@intentic/base/async";
import { STATE_DIR } from "@intentic/constants";
import { type AsyncSubscription, subscribe } from "@parcel/watcher";
import type { Logger } from "pino";
import { IGNORED_DIRS, isAgentWorktreePath, isBrowserProfilePath, isReferencePath, REFERENCE_DIR, toRelPath } from "@intentic/workspace-ignore";
import { stateRelPath } from "./state-paths.js";

// Live file-change push. The agent edits /work out-of-band (its own Write/Edit/Bash tools, never the daemon's
// HTTP routes), so nothing else can tell the browser its view went stale. A single filesystem watcher on the
// workspace root fills that gap: it batches the paths that changed and hands them to whoever is holding the
// /events SSE stream open, which forwards them so the browser refreshes the tree + any open file with no manual
// Refresh. The batch is debounced so a burst of agent edits is one frame, not hundreds.

// The daemon's OWN machine state under .intentic/, watching it is a feedback loop, not a change feed:
// - cache/ holds SQLite dbs whose WALs rewrite continuously for MINUTES whenever a rebuilt daemon re-parses
//   (PARSER_VERSION) or re-embeds (MODEL_ID) the workspace, plus the 466 MB whisper model streaming down in
//   chunks. Every iq write used to come back as a change batch, which re-marked the engine dirty (main.ts),
//   a full /work sweep every couple of seconds, and cost every connected browser a tree refetch plus a
//   manifest invalidation, four times a second, for as long as the rebuild took. The engine already excludes
//   its own dir from search views (isIqDenied); excluding cache/ WHOLE is what also covers the vector
//   sidecar's WAL, which sat outside the old cache/iq spelling and pinged the watcher on every embed.
// - agent sessions, provider homes, connector runtime, agent scratch (tmp, a build an agent runs there logs
//   at write speed) and pnpm's store are all machine-written and can rewrite at token or request cadence, so
//   they are classified as roots rather than enumerated one store at a time.
// None of it is source and nothing derives from watching it. The .intentic/ MANIFESTS (capabilities,
// automations, settings, the environment Dockerfiles, approvals, drafts) stay watched, those changes are
// exactly how another member's write reaches this browser. Spelled through stateRelPath so each exclusion is
// a path the state table declares, and a renamed store breaks this list at compile time.
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

/* WHAT THE WATCHER SKIPS. ONE RULE, TWO CONSUMERS, so the two can never disagree.
 *
 * Skipping happens twice, for different reasons. `globs` prune the watcher's DESCENT: the native backend never
 * walks into a dir a glob covers, which is what keeps node_modules / .git / browser-profile churn from costing
 * handles at all. `matches` then vets every path that DOES arrive. Both halves of a rule sit on one line here
 * because the alternative, a glob list kept by hand next to a predicate, rots the first time someone adds a
 * junk dir to one and not the other, and the symptom (the watcher quietly walking node_modules again) is
 * invisible until a machine runs out of handles.
 *
 * The predicate is the AUTHORITY and the globs are an optimisation: a glob that is wrong or missing costs
 * descent, never a wrong answer, because nothing reaches a browser without passing `matches`. The junk-dir and
 * daemon-state rules generate their globs straight off the shared constant lists, so those cannot drift at all.
 *
 * Root-anchored vs any-depth is part of each rule. The reference shelf is the ROOT-level refs/ only, a repo's
 * own refs/ is ordinary source, while junk dirs, browser profiles, agent worktrees and the daemon's state
 * match at any depth. Paths given to `matches` are root-relative, the same space the globs match in.
 *
 * ponytail: descent-ignore only (junk dirs incl. .git + browser profiles); a .gitignore'd file outside those
 *           still emits and just triggers a harmless tree refetch. A change inside a lazy-loaded ignored dir
 *           won't push live, re-expanding that dir re-fetches it. Upgrade only if that ever matters. */
interface WatchIgnoreRule {
    readonly globs: readonly string[];
    readonly matches: (relPath: string) => boolean;
}

const WATCH_IGNORE_RULES: readonly WatchIgnoreRule[] = [
    // The same dirs the tree grays + lazy-loads, read off the shared list rather than restated.
    {
        globs: [...IGNORED_DIRS].map((dir) => `**/${dir}`),
        matches: (relPath) => relPath.split(/[\\/]/).some((segment) => IGNORED_DIRS.has(segment)),
    },
    // A connected browser's profile churns constantly (Chromium rewrites Cookies etc.).
    { globs: [`**/${stateRelPath(".intentic/local/browser/")}`], matches: isBrowserProfilePath },
    // Agent worktrees are whole checkouts an agent edits at full speed; sibling .claude config still pushes.
    { globs: ["**/.claude/worktrees"], matches: isAgentWorktreePath },
    // A reference clone into the shelf writes thousands of files in one burst.
    { globs: [REFERENCE_DIR], matches: isReferencePath },
    { globs: DAEMON_STATE_PATHS.map((path) => `**/${path}`), matches: isDaemonStatePath },
];

// Root-relative form, for the watcher callback that has already paid for the conversion.
const isWatchIgnoredRel = (relPath: string): boolean => WATCH_IGNORE_RULES.some((rule) => rule.matches(relPath));

export const isWatchIgnored = (root: string, abs: string): boolean => isWatchIgnoredRel(toRelPath(root, abs));

// Every rule's globs, each covering both the directory itself and everything beneath it.
export const watchIgnoreGlobs = (): string[] => WATCH_IGNORE_RULES.flatMap((rule) => rule.globs.flatMap((glob) => [glob, `${glob}/**`]));

// One batch fires 250ms after the FIRST change of a window (not reset per event), so latency is bounded to
// ~250ms even while the agent edits continuously, and everything inside the window coalesces into one frame.
export const DEBOUNCE_MS = 250;
// A change touching more than this many visible files (branch switch, codegen, mass rename) sends an empty batch
//, "just refetch the tree", instead of a giant path list. The tree refetch covers it; per-file re-read/highlight
// isn't worth the frame size at that scale.
export const MAX_PATHS = 200;

export type PathBatcher = Coalescer<string>;

// The coalescing rule itself, apart from the watcher that feeds it: paths accumulate into a set (so a file
// touched twice in a window is announced once) and go out as one batch when the window closes.
//
// It is a separate factory because it is the only part of this file a test can pin down. Asserting the batch
// count against a real filesystem measures how fast a loaded machine delivers inotify events, not what this
// code does, the same "green on a box, red on a busy runner" trap _tools/testing/src/vitest.ts describes.
// Reached without a watcher in front of it, the rule answers to timers the test owns.
export const createPathBatcher = (emit: (paths: string[]) => void): PathBatcher =>
    /* A Coalescer, not a Delayer, and that is the whole design decision: its window opens on the FIRST path of
     * a burst and later ones join it rather than pushing the deadline out. An agent editing continuously never
     * goes quiet, so a trailing debounce here would either never fire or fire only once the agent stopped,
     * which is exactly when the browser no longer needs telling. */
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

/* Production isolation for the recursive watcher, and a thread whose original reason is now GONE.
 *
 * It exists because the previous watcher represented every watched directory as its own libuv FSEvent handle:
 * the live workspace carried 3,321 of them on the daemon isolate, with the initial walk, burst bookkeeping and
 * GC all running beside /events heartbeats. Moving that off the control plane was the only way to contain it.
 *
 * The native backend holds ONE handle for the whole tree and coalesces bursts in its own thread, so the handle
 * pressure this was built to escape no longer exists. What the worker still buys is narrower: debounce and path
 * coalescing (createWorkspaceWatch below) happen off the control plane, and a watcher crash lands here rather
 * than on the daemon.
 *
 * Deliberately kept anyway, retiring it moves the batching timers back onto the daemon's loop, which is a
 * behaviour change worth making on its own rather than smuggling into a watcher swap. Whoever picks that up:
 * this comment is the argument that it is now safe to. */
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
    /* Hosted VM mode keeps the public contract at /work with a symlink onto its one persistent Fly volume
     * (/data/work). @parcel/watcher rejects a symlink as the root it hands to inotify even though ordinary
     * reads and writes through it are valid. Resolve only the backend's watch target: callers and emitted
     * paths stay in the configured root's relative namespace, while inotify receives a real directory. */
    const watchedRoot = realpathSync(root);
    const listeners = new Set<(paths: string[]) => void>();
    const batcher = createPathBatcher((paths) => {
        for (const listener of listeners) {
            listener(paths);
        }
    });

    /* ONE native subscription for the whole tree, rather than one handle per directory. `ignore` keeps the
     * descent filter that made a recursive watcher viable here in the first place (node's recursive fs.watch
     * still cannot skip node_modules), and isWatchIgnoredRel vets whatever does arrive, pre-existing files are
     * never reported, so there is no initial-scan burst to suppress.
     *
     * Subscribing is async while this factory is not, deliberately: every caller wants a handle it can register
     * listeners on immediately, and a change that lands before the backend is armed is the same non-event as one
     * that lands before the daemon boots. `close()` therefore has to settle the in-flight subscribe before it
     * can unsubscribe, or a fast open/close leaks the watcher it never saw. */
    let subscription: AsyncSubscription | undefined;
    let closed = false;
    const started = subscribe(
        watchedRoot,
        (err, events) => {
            // A watch hiccup (inotify limit, transient EACCES) must not take the daemon down, the manual
            // Refresh still works, so degrade rather than throw. Logged, not swallowed: a dead watcher means
            // live refresh silently stops, and the log line is the only trace of why.
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
            // close() can win the race while the backend is still arming. Whoever gets there tears the
            // subscription down and leaves `subscription` unset, so exactly one unsubscribe ever runs, calling
            // it twice is not something the backend promises to tolerate.
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
            // Drop whatever the last window accumulated. A closed watcher announcing a batch 250ms later would
            // reach listeners that have already let go of it, and in a test, after the temp root is gone.
            batcher.dispose();
        },
    };
};

// Boot-time singleton the /events handler subscribes to. Started once in main.ts (like the announcer/scheduler),
// so createWorkspaceWatch stays a plain factory the test can drive and close on its own temp root.
//
// Subscribers register into a module-level set that outlives the start: the daemon listens (and /events
// streams open) BEFORE the watcher spins up its /work scan, and a subscription taken in that window used to
// be silently dropped, a whole browser session with no live tree refresh. The watcher, whenever it starts,
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
