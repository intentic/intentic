import { cachedAsync } from "@intentic/base/held";

/* (2026-11-24) ONE ANSWER FOR EVERY READER OF A SLOW `ic` READING. `ic sandbox list --json` cost 182 ms of CPU and 4.7 s
   of wall time on a Windows laptop (rog), and the keeper, the rounds, the resident check, the egress and move flows and
   every linked sandbox's Devices pull each asked it on their own: four listings in 45 s. So a reading is shared: callers
   who ask while one is in flight share it, an answer stands for a short while, and every `ic` run of this agent that can
   change what the reading says drops it, so this agent never shows itself a listing from before its own start, stop or
   move. A change nobody here made (a person's `ic` in a terminal, the desktop app) shows within the hold. A caller that
   must see the machine as it is now asks `fresh`. The alternative, a longer poll in each caller, still had them all
   asking at different moments. */

// The `ic` verbs that only read, by their leading words: running one changes nothing a reading holds. Everything else
// (start, stop, sleep, fix, swaps of an image, move, remove, egress, shape, watch, wakes, runners) drops what is held.
// `engine disk --json` is the disk round's own per-minute read, and dropping the listing on it would undo the sharing;
// its act form (`--consumers`) may stop sandboxes and drops everything like any other run.
const READ_VERBS: readonly (readonly string[])[] = [
    ["sandbox", "list"],
    ["sandbox", "swaps"],
    ["sandbox", "logs"],
    ["sandbox", "doctor"],
    ["sandbox", "inspect"],
    ["features"],
    ["--version"],
];
// Reads only as spelled whole.
const READ_ARGVS: ReadonlySet<string> = new Set([["engine", "disk", "--json"].join("\0")]);

/** Whether an `ic` run with these arguments can change what a held reading says. Pure. */
export const icRunChanges = (args: readonly string[]): boolean =>
    !READ_ARGVS.has(args.join("\0")) && !READ_VERBS.some((verb) => verb.every((word, at) => args[at] === word));

const listeners = new Set<() => void>();

/** Called with nothing whenever this agent runs an `ic` that changes something, before it starts and once it ends. */
const onIcChange = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
};

/** Says an `ic` run is starting or has ended; readers drop what they hold when it can change their answer. */
export const noteIcRun = (args: readonly string[]): void => {
    if (!icRunChanges(args)) {
        return;
    }
    for (const listener of listeners) {
        listener();
    }
};

/**
 * Runs `run`, an `ic` run with `args`, with what it changes dropped both before it starts (so a reading begun earlier is
 * not held over it) and once it ends, however it ends (so the next reader sees what it did).
 */
export const aroundIcRun = async <T>(args: readonly string[], run: () => Promise<T>): Promise<T> => {
    noteIcRun(args);
    try {
        return await run();
    } finally {
        noteIcRun(args);
    }
};

export interface SharedReading<V> {
    /** The held answer while it stands, else the read in flight, else a new read. `fresh` always reads again. */
    readonly get: (options?: { readonly fresh?: boolean }) => Promise<V>;
    /** Forgets the held answer and any read in flight: their callers still get it, the next asker reads again. */
    readonly drop: () => void;
}

export interface SharedReadingOptions {
    readonly heldMs: number;
    /** A change stamp read before each ask (a file's mtime): a different stamp is a different reading. */
    readonly stamp?: () => Promise<string>;
    /** Drop on every changing `ic` run of this agent (onIcChange). On unless a test says otherwise. */
    readonly dropOnIcChange?: boolean;
    readonly now?: () => number;
}

/** One reading shared by every caller, held `heldMs` (and while its stamp stays the same), never holding a failure. */
export const sharedReading = <V>(read: () => Promise<V>, { heldMs, stamp, dropOnIcChange = true, now = Date.now }: SharedReadingOptions): SharedReading<V> => {
    const cache = cachedAsync<string, V>({ ttlMs: heldMs, maxEntries: 4, now });
    const drop = (): void => cache.clear();
    if (dropOnIcChange) {
        onIcChange(drop);
    }
    return {
        get: async (options) => {
            const key = stamp === undefined ? "" : await stamp();
            return await cache.get(key, read, options);
        },
        drop,
    };
};
