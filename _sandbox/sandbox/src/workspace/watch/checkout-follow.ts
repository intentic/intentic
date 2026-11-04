import { existsSync, type FSWatcher, watch } from "node:fs";
import { join, posix } from "node:path";
import { Coalescer } from "@intentic/base/async";
import type { Logger } from "pino";
import { DEBOUNCE_MS, isWatchIgnored } from "./workspace-watch.js";

// A conversation's own copy watched where someone is looking. The shared tree's watcher (workspace-watch.ts) covers
// /work alone, and a checkout is a whole tree edited at full speed, too dear to watch whole for every conversation; so
// a reader with a file of one open asks for that file's folder (workspace.followCheckout), and the folder is watched,
// one level deep, for as long as someone keeps asking. What changed there goes out as `checkoutChanged` on /events.
//
// - One watch per folder, whoever asks: a second reader of the same folder renews the lease rather than adding a watch.
// - A lease, not a subscription: a reader renews well before it runs out (the answer names it), and a folder nobody
//   renews is let go when it does, so a closed tab, a dropped connection or a crashed browser costs one lease at most.
// - Non-recursive, so a folder is one inotify watch whatever lies beneath it.
// - Bounded: past MAX_FOLLOWED_DIRS a new folder is refused (the reader still gets a lease and sees changes when its
//   turn ends, as before), rather than evicting a folder another reader is looking at.
// - A folder that does not exist yet is not watched: a reader only follows a file it has already opened, and its next
//   renewal finds the folder if it has appeared since.

// How long one ask holds a folder watched. Long enough that a renewal at half of it survives a slow network and a
// throttled background tab; short enough that a reader gone without a word stops costing a watch soon after.
export const FOLLOW_LEASE_MS = 60_000;
// Folders watched at once across every reader. Each is one inotify watch, beside the shared tree's thousands and the
// checkout feed's (git/feed/checkout-feed.ts); a person looks at a handful of files at a time.
const MAX_FOLLOWED_DIRS = 64;

// What a folder's watch reports: a name in it changed, or the watch ended (the folder went, or the watch failed).
export interface DirWatchEvents {
    readonly changed: (name: string | undefined) => void;
    readonly ended: () => void;
}
// Starts watching one folder; returns its stop. Throws when the folder cannot be watched (gone, not a folder).
export type WatchDir = (abs: string, events: DirWatchEvents) => () => void;

// The platform's own non-recursive watch (inotify on Linux). A rename or delete of the folder itself ends it: the
// folder is checked on each rename, the one event that can mean it went.
const watchDirNatively: WatchDir = (abs, events) => {
    const watcher: FSWatcher = watch(abs, { persistent: false }, (eventType, name) => {
        if (eventType === "rename" && !existsSync(abs)) {
            events.ended();
            return;
        }
        events.changed(name ?? undefined);
    });
    watcher.on("error", () => events.ended());
    return () => watcher.close();
};

export type CheckoutChangeListener = (agent: string, paths: string[]) => void;

export interface CheckoutFollowOptions {
    readonly leaseMs?: number;
    readonly maxDirs?: number;
    readonly debounceMs?: number;
    readonly watchDir?: WatchDir;
    readonly logger?: Logger;
}

export interface CheckoutFollow {
    // Holds each folder (checkout-relative, forward-slash, "" for the checkout's root) watched for another lease;
    // answers the lease. `root` is the conversation's checkout.
    readonly follow: (agent: string, root: string, dirs: readonly string[]) => number;
    readonly subscribe: (listener: CheckoutChangeListener) => () => void;
    // Folders watched now, for a test or a diagnostic.
    readonly watched: () => number;
    readonly close: () => void;
}

interface Followed {
    readonly stop: () => void;
    timer: ReturnType<typeof setTimeout>;
}

// Agent and path in one batch entry, split again when the window closes.
const SEP = "\u0000";

// One closed window's entries, each path once, told per conversation.
const announce = (batch: readonly string[], listeners: ReadonlySet<CheckoutChangeListener>): void => {
    const byAgent = new Map<string, Set<string>>();
    for (const entry of batch) {
        const at = entry.indexOf(SEP);
        const agent = entry.slice(0, at);
        const paths = byAgent.get(agent) ?? new Set<string>();
        paths.add(entry.slice(at + 1));
        byAgent.set(agent, paths);
    }
    for (const [agent, paths] of byAgent) {
        for (const listener of listeners) {
            listener(agent, [...paths]);
        }
    }
};

export const createCheckoutFollow = (options: CheckoutFollowOptions = {}): CheckoutFollow => {
    const leaseMs = options.leaseMs ?? FOLLOW_LEASE_MS;
    const maxDirs = options.maxDirs ?? MAX_FOLLOWED_DIRS;
    const watchDir = options.watchDir ?? watchDirNatively;
    const listeners = new Set<CheckoutChangeListener>();
    const followed = new Map<string, Followed>();
    // One window for every folder, as the shared watcher has: a burst across folders goes out once per conversation.
    const batcher = new Coalescer<string>(options.debounceMs ?? DEBOUNCE_MS, (batch) => announce(batch, listeners));

    const keyOf = (agent: string, dir: string): string => `${agent}${SEP}${dir}`;
    const release = (key: string): void => {
        const entry = followed.get(key);
        if (entry === undefined) {
            return;
        }
        followed.delete(key);
        clearTimeout(entry.timer);
        entry.stop();
    };
    const leaseTimer = (key: string): ReturnType<typeof setTimeout> => {
        const timer = setTimeout(() => release(key), leaseMs);
        timer.unref();
        return timer;
    };

    const start = (agent: string, root: string, dir: string): void => {
        const key = keyOf(agent, dir);
        const abs = dir === "" ? root : join(root, dir);
        let ended = false;
        const events: DirWatchEvents = {
            changed: (name) => {
                if (ended) {
                    return;
                }
                // A nameless event says something in the folder moved without saying what: the folder itself stands for it.
                const path = name === undefined || name === "" ? dir : dir === "" ? name : posix.join(dir, name);
                if (path !== "" && !isWatchIgnored(root, join(root, path))) {
                    batcher.add(`${agent}${SEP}${path}`);
                }
            },
            ended: () => {
                ended = true;
                release(key);
            },
        };
        try {
            const stop = watchDir(abs, events);
            followed.set(key, { stop, timer: leaseTimer(key) });
        } catch (err) {
            // A folder not there yet is followed by the reader's next renewal, once it is.
            options.logger?.debug({ err, dir }, "checkout follow: folder not watched");
        }
    };

    return {
        follow: (agent, root, dirs) => {
            for (const dir of new Set(dirs)) {
                const key = keyOf(agent, dir);
                const held = followed.get(key);
                if (held !== undefined) {
                    clearTimeout(held.timer);
                    held.timer = leaseTimer(key);
                    continue;
                }
                if (followed.size >= maxDirs) {
                    options.logger?.warn({ agent, dir, max: maxDirs }, "checkout follow: too many folders watched, this one is not");
                    continue;
                }
                start(agent, root, dir);
            }
            return leaseMs;
        },
        subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        watched: () => followed.size,
        close: () => {
            // Deleting the entry being visited is safe: a Map's iterator carries on past it.
            for (const key of followed.keys()) {
                release(key);
            }
            batcher.dispose();
            listeners.clear();
        },
    };
};

// The daemon's one registry, made on first use so a daemon nobody follows a checkout in holds no watch at all.
// Subscribers register into a set that outlives it, as workspace-watch.ts's do, so the /events handler can subscribe
// before anyone has followed anything.
const subscribers = new Set<CheckoutChangeListener>();
let instance: CheckoutFollow | undefined;

export const checkoutFollow = (logger?: Logger): CheckoutFollow => {
    if (instance === undefined) {
        const made = createCheckoutFollow(logger === undefined ? {} : { logger });
        made.subscribe((agent, paths) => {
            for (const listener of subscribers) {
                listener(agent, paths);
            }
        });
        instance = made;
    }
    return instance;
};

export const subscribeCheckoutChanges = (listener: CheckoutChangeListener): (() => void) => {
    subscribers.add(listener);
    return () => subscribers.delete(listener);
};

// Shutdown: every folder let go.
export const closeCheckoutFollow = (): void => {
    instance?.close();
    instance = undefined;
};
