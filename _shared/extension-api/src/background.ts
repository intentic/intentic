import {
    at,
    carryUnknown,
    type Conversion,
    convertDocument,
    drop,
    dropAll,
    fold,
    type Granularity,
    mapValue,
    nested,
    pinDefault,
    rename,
    retireEntries,
    retype,
    transform,
} from "@intentic/sandbox-contract/documents";
import type { Ref } from "vue";
import type { Disposable, IntenticApi } from "./api.js";
import { sandboxRef, sandboxScopeGuard } from "./scope.js";

// Sandbox-scoped background polling for a badge that needs an answer before its tile opens: state lives at module
// scope, refreshed by a coalesced interval and a file-change wake. A failed read keeps the last value; a read is
// dropped if the sandbox switched while it was in flight.

export interface SandboxPoll<T> {
    // Sandbox-scoped state (scope.ts); write directly to fold in a local change like "mark as seen".
    readonly state: Ref<T>;
    // Begins reading on the interval and on the extension's own file writes; push onto context.subscriptions.
    start(): Disposable;
    // Reads immediately, off-cycle, for a moment that should not wait for the interval.
    refresh(): void;
}

export interface SandboxPollOptions<T> {
    // A function, not the api itself: nothing is bound until activate() runs.
    readonly host: () => IntenticApi;
    // No default: choose an interval that reflects how fast the answer actually changes.
    readonly everyMs: number;
    // The value before anything has been read, rebuilt on every sandbox switch (sandboxRef).
    readonly initial: () => T;
    // Gets the api and the value held (for an accumulating poll); throwing means nothing changed, value kept.
    readonly read: (api: IntenticApi, previous: T) => Promise<T>;
    // Defaults to reading immediately too; set false when there's nothing to ask until told (detect()).
    readonly immediate?: boolean;
    // For a value that owns something the garbage collector will not take back.
    readonly dispose?: (previous: T) => void;
}

// How long a burst of writes may coalesce before the wake reads; trailing, since the last write wins.
const WAKE_MS = 400;

// One shared read lane for the whole window, so simultaneous per-extension timers don't burst the daemon at once.
// Per-poll: a wake mid-queue is redundant, a wake mid-run earns exactly one trailing pass, requeued at the back.
interface ScheduledRead {
    queued: boolean;
    running: boolean;
    trailing: boolean;
    readonly read: () => Promise<void>;
}

const scheduledReads: ScheduledRead[] = [];
let drainingReads = false;

const drainScheduledReads = async (): Promise<void> => {
    if (drainingReads) {
        return;
    }
    drainingReads = true;
    try {
        for (;;) {
            const scheduled = scheduledReads.shift();
            if (scheduled === undefined) {
                return;
            }
            scheduled.queued = false;
            scheduled.running = true;
            try {
                await scheduled.read();
            } finally {
                scheduled.running = false;
            }
            if (scheduled.trailing) {
                scheduled.trailing = false;
                scheduled.queued = true;
                scheduledReads.push(scheduled);
            }
        }
    } finally {
        drainingReads = false;
    }
};

const scheduleRead = (scheduled: ScheduledRead): void => {
    if (scheduled.running) {
        scheduled.trailing = true;
        return;
    }
    if (scheduled.queued) {
        return;
    }
    scheduled.queued = true;
    scheduledReads.push(scheduled);
    void drainScheduledReads();
};

// Re-reads when the extension's declared files change. Wrapped in try/catch: host() throws before activate(), and an
// older host may lack onDidChangeFiles; either way it falls back to the timer alone.
const wakeOnFiles = (host: () => IntenticApi, read: () => void): Disposable => {
    let pending: ReturnType<typeof setTimeout> | undefined;
    let subscription: Disposable | undefined;
    try {
        subscription = host().workspace.onDidChangeFiles(() => {
            pending ??= setTimeout(() => {
                pending = undefined;
                read();
            }, WAKE_MS);
        });
    } catch {
        subscription = undefined;
    }
    return {
        dispose: (): void => {
            if (pending !== undefined) {
                clearTimeout(pending);
                pending = undefined;
            }
            subscription?.dispose();
        },
    };
};

export const sandboxPoll = <T>(options: SandboxPollOptions<T>): SandboxPoll<T> => {
    const state = sandboxRef(options.initial, options.dispose);

    const once = async (): Promise<void> => {
        try {
            const api = options.host();
            if (!api.sandbox.reachable()) {
                return;
            }
            const current = sandboxScopeGuard();
            const next = await options.read(api, state.value);
            if (!current()) {
                return;
            }
            state.value = next;
        } catch {
            // Leave the last value standing; "could not ask" is not "nothing there".
        }
    };
    const scheduled: ScheduledRead = { queued: false, running: false, trailing: false, read: once };

    return {
        state,
        refresh: () => scheduleRead(scheduled),
        start: () => {
            if (options.immediate !== false) {
                scheduleRead(scheduled);
            }
            const timer = setInterval(() => scheduleRead(scheduled), options.everyMs);
            const wake = wakeOnFiles(options.host, () => scheduleRead(scheduled));
            return {
                dispose: () => {
                    clearInterval(timer);
                    wake.dispose();
                },
            };
        },
    };
};

// Key → mark map of what the owner has already seen, stored as JSON under `.intentic`. Missing or unparseable reads as
// nothing acknowledged; a write's `false` return means only that the sandbox scope moved mid-write, and a write over a
// ledger that could not be read at all (refused, unreachable) rejects rather than dropping every acknowledgement in it.
export interface SandboxLedger {
    // Everything acknowledged so far. Absent, unparseable or not-an-object all read as nothing.
    read(): Promise<Readonly<Record<string, string>>>;
    // Records these, leaving every other entry alone; no write happens when nothing moved.
    mark(entries: Readonly<Record<string, string>>): Promise<boolean>;
    // Makes these the whole ledger, dropping anything not named; same no-op-when-unchanged rule as mark.
    replace(entries: Readonly<Record<string, string>>): Promise<boolean>;
}

const sameEntries = (left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean =>
    Object.keys(left).length === Object.keys(right).length && Object.entries(left).every(([key, mark]) => right[key] === mark);

export const sandboxLedger = (host: () => IntenticApi, path: string): SandboxLedger => {
    // Non-string values are dropped, not coerced: a mark is always a string.
    const marksOf = (parsed: unknown): Readonly<Record<string, string>> =>
        typeof parsed === `object` && parsed !== null && !Array.isArray(parsed)
            ? Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === `string`))
            : {};

    const read = async (): Promise<Readonly<Record<string, string>>> => marksOf(await host().workspace.readJson<Record<string, unknown>>(path));

    // Through the contract's own read, which throws for a refused or unreachable read where `readJson` answers absent:
    // a write computed from that absence would drop every acknowledgement the file really holds.
    const readToWrite = async (): Promise<Readonly<Record<string, string>>> => {
        const answer = await host().sandbox.rpc.workspace.file({ path });
        if (!answer.present) {
            return {};
        }
        try {
            return marksOf(JSON.parse(answer.content));
        } catch {
            // allow(silent-catch): an unparseable ledger holds nothing acknowledged, the contract `read` states.
            return {};
        }
    };

    // One writer for both mark and replace; the scope guard lives here, not at the call site, since a sandbox switch
    // mid-write would file the acknowledgement into the workspace the owner just left.
    const settle = async (next: (seen: Readonly<Record<string, string>>) => Readonly<Record<string, string>>): Promise<boolean> => {
        const current = sandboxScopeGuard();
        const seen = await readToWrite();
        const wanted = next(seen);
        // Already saying it: nothing to write, and the caller's fold stays correct.
        if (sameEntries(seen, wanted)) {
            return true;
        }
        if (!current()) {
            return false;
        }
        await host().workspace.write(path, `${JSON.stringify(wanted, undefined, 2)}\n`);
        return true;
    };

    return {
        read,
        mark: async (entries) => settle((seen) => ({ ...seen, ...entries })),
        replace: async (entries) => settle(() => entries),
    };
};

// The vocabulary an extension's stored file evolves by, the same the daemon's own stores use: each a guarded, pure
// rewrite of the raw JSON, a no-op on a file already past it, so a file from any earlier version of the extension reads
// as today's shape. One namespace rather than ten loose names, since `rename` and `drop` are an author's words too.
export const conversions = { at, drop, dropAll, fold, mapValue, nested, pinDefault, rename, retireEntries, retype, transform } as const;

// A file an extension keeps under the workspace (its own record, cache or settings), read through the conversions its
// shape has had, and written with everything a NEWER version of the extension put in it kept in place, so switching an
// extension back never deletes what the later version recorded. A file that exists but cannot be read is left alone:
// `update` rejects rather than writing its fallback over it.
export interface SandboxDocument<T> {
    // Today's value: the file converted and parsed; the fallback when it is absent or this version cannot read it.
    read(): Promise<T>;
    // Read-change-write, serialized through this handle. Returning `current` unchanged writes nothing; `false` means only
    // that the sandbox changed mid-write, and nothing was written.
    update(change: (current: T) => T): Promise<boolean>;
}

export interface SandboxDocumentOptions<T> {
    // Today's shape, or undefined for a file this version cannot read.
    readonly parse: (raw: unknown) => T | undefined;
    readonly fallback: () => T;
    // Append-only: a conversion is never edited or removed once shipped, only followed by another.
    readonly history?: readonly Conversion[];
    // Where the conversions apply: the document, each entry of a top-level array, or each value of an object keyed by id.
    readonly granularity?: Granularity;
}

export const sandboxDocument = <T>(host: () => IntenticApi, path: string, options: SandboxDocumentOptions<T>): SandboxDocument<T> => {
    const convert = (raw: unknown): unknown => convertDocument(options.history ?? [], options.granularity ?? `object`, raw).value;
    // Absent is undefined; present but unreadable throws, so no caller mistakes it for absent.
    const readRaw = async (): Promise<unknown> => {
        // Through the contract's own read, which throws for a refused or unreachable read where `readJson` answers absent.
        const answer = await host().sandbox.rpc.workspace.file({ path });
        if (!answer.present) {
            return undefined;
        }
        return convert(JSON.parse(answer.content));
    };
    const read = async (): Promise<T> => {
        try {
            const raw = await readRaw();
            return (raw === undefined ? undefined : options.parse(raw)) ?? options.fallback();
        } catch {
            // allow(silent-catch): a file this version cannot read reads as the fallback, the contract `read` states.
            return options.fallback();
        }
    };
    let queue: Promise<unknown> = Promise.resolve();
    const update = (change: (current: T) => T): Promise<boolean> => {
        const run = async (): Promise<boolean> => {
            const current = sandboxScopeGuard();
            const raw = await readRaw();
            const parsed = raw === undefined ? undefined : options.parse(raw);
            if (raw !== undefined && parsed === undefined) {
                throw new Error(`${path} holds what this version of the extension cannot read; it is left as it is`);
            }
            const before = parsed ?? options.fallback();
            const after = change(before);
            if (after === before) {
                return true;
            }
            if (!current()) {
                return false;
            }
            const written = raw === undefined ? after : carryUnknown(raw, parsed, after);
            await host().workspace.write(path, `${JSON.stringify(written, undefined, 2)}\n`);
            return true;
        };
        const next = queue.then(run, run);
        // allow(silent-catch): the queue only orders the next update behind this one; this one's caller still gets its rejection
        queue = next.catch(() => undefined);
        return next;
    };
    return { read, update };
};
