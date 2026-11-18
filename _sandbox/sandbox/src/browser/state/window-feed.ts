import { publishRuntimeChange, publishRuntimeMilestone } from "../../seams/runtime-feed.js";

// Every change to a browser window goes two ways: to the browsers list, which the editor refetches on the runtime
// feed's beat (a second, or 250 ms for a milestone), and at once to whoever watches that window by name, its view
// sockets, which send the window whole as `state` (browser-wire). Both copies carry the window's `seq`, so a viewer
// holding both shows the newer.

// Starts at the clock and only rises, so a window's seq after a daemon restart is still above any it had before:
// a viewer comparing an old copy with a new one never takes the old for the newer.
let lastSeq = Date.now();

export const nextSeq = (): number => {
    lastSeq = Math.max(lastSeq + 1, Date.now());
    return lastSeq;
};

const watchers = new Map<string, Set<() => void>>();

// Calls `listener` after every change to the window named `name`, including one replacing it under the same name;
// answers how to stop.
export const watchWindow = (name: string, listener: () => void): (() => void) => {
    const set = watchers.get(name) ?? new Set();
    set.add(listener);
    watchers.set(name, set);
    return () => {
        set.delete(listener);
        if (set.size === 0 && watchers.get(name) === set) {
            watchers.delete(name);
        }
    };
};

export const windowWatched = (name: string): boolean => (watchers.get(name)?.size ?? 0) > 0;

// A window changed: its seq rises, its watchers hear at once, and the list is refreshed on the feed's beat. A milestone
// (a tab in front, a navigation setting off or arriving) is what a viewer is waiting on, so the list goes sooner too.
export const windowChanged = (record: { readonly name: string; seq: number }, milestone = false): void => {
    record.seq = nextSeq();
    for (const listener of watchers.get(record.name) ?? []) {
        listener();
    }
    if (milestone) {
        publishRuntimeMilestone("browsers");
    } else {
        publishRuntimeChange("browsers");
    }
};

// At most this often a socket is sent the window, however fast it changes: a page loading fires a burst of changes,
// and the viewer only draws the last.
const STATE_EVERY_MS = 100;

// Sends the window named `name` as it is now, then again after each change, at most every STATE_EVERY_MS and never the
// same seq twice; `read` answers the window, undefined once it is gone. Answers how to stop.
export const streamWindow = <W extends { readonly seq?: number | undefined }>(
    name: string,
    read: () => W | undefined,
    send: (window: W) => void,
    everyMs: number = STATE_EVERY_MS,
): (() => void) => {
    let sentSeq: number | undefined;
    let sentAt = 0;
    let timer: NodeJS.Timeout | undefined;
    let stopped = false;
    const flush = (): void => {
        timer = undefined;
        const window = stopped ? undefined : read();
        if (window === undefined || (window.seq !== undefined && window.seq === sentSeq)) {
            return;
        }
        sentSeq = window.seq;
        sentAt = Date.now();
        send(window);
    };
    const changed = (): void => {
        if (timer !== undefined || stopped) {
            return;
        }
        const wait = sentAt + everyMs - Date.now();
        if (wait <= 0) {
            flush();
            return;
        }
        timer = setTimeout(flush, wait);
    };
    const unwatch = watchWindow(name, changed);
    flush();
    return () => {
        stopped = true;
        unwatch();
        if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
        }
    };
};
