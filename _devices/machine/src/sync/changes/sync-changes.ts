import { errorMessage } from "@intentic/base/errors";
import type { Log } from "@intentic/local-agent";
import { type SyncChanges, SyncChangesSchema } from "@intentic/sandbox-contract/schemas/devices";

/* A CHANGE IN THE SANDBOX ASKS FOR A CYCLE, rather than waiting for Mutagen's next scan of /work (2026-11-24). The
   sandbox endpoint has no recursive watcher, so its own scan was the only thing that noticed an agent's edit: every
   2 seconds, all of /work, idle or not (mutagen.ts SANDBOX_POLL_SECONDS). A sandbox new enough holds
   GET /system/sync/changes open until a path the workspace session carries changes (sandbox hosts/sync-changes.ts), and
   this follows it, one held request per sandbox, asking Mutagen to flush that sandbox's workspace sessions when it
   moves. Its scan then only backs that up, at SIGNALLED_POLL_SECONDS, and only on a sandbox that has answered here: an
   older one answers this route 403 (its sync token reaches no route it never declared) or 404, keeps the 2-second scan,
   and is asked again every UNSUPPORTED_RECHECK_MS in case it was updated. */

// How long the daemon is asked to hold; it holds 25 s itself, so this is only an upper bound on the wait.
const HOLD_TIMEOUT_MS = 40_000;

// An older sandbox, asked again this often: an update brings it the route without this agent restarting.
const UNSUPPORTED_RECHECK_MS = 10 * 60_000;

// A failed ask (the sandbox restarting, a network blip) tries again on a short ladder: an outage costs latency, not CPU,
// since the backstop scan still runs, and the first answer after one asks for a cycle to catch what it missed.
export const retryDelayMs = (failures: number): number => Math.min(30_000, 1000 * 2 ** Math.max(0, failures - 1));

export type ChangesAnswer = { readonly kind: "changes"; readonly changes: SyncChanges } | { readonly kind: "unsupported" };

// One ask. Throws on anything that is neither an answer nor the daemon's "not a route of mine".
export const fetchSyncChanges = async (
    base: string,
    syncToken: string,
    last: SyncChanges | undefined,
    signal: AbortSignal,
    fetchImpl: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<ChangesAnswer> => {
    const query = last === undefined ? "" : `?after=${last.generation}&epoch=${encodeURIComponent(last.epoch)}`;
    const response = await fetchImpl(`${base.replace(/\/$/, "")}/system/sync/changes${query}`, {
        headers: { "x-intentic-sync": syncToken },
        signal: AbortSignal.any([signal, AbortSignal.timeout(HOLD_TIMEOUT_MS)]),
    });
    if (response.status === 403 || response.status === 404) {
        return { kind: "unsupported" };
    }
    if (!response.ok) {
        throw new Error(`the sandbox's change signal answered ${response.status}`);
    }
    return { kind: "changes", changes: SyncChangesSchema.parse(await response.json()) };
};

// Whether an answer says the sandbox moved since `last` (or restarted, or this is the first answer of a connection).
export const movedSince = (last: SyncChanges | undefined, next: SyncChanges): boolean =>
    last === undefined || last.epoch !== next.epoch || last.generation !== next.generation;

/* THE FLUSH: debounced, one in flight, and spaced. A burst of signals is one flush, asked `debounceMs` after the first;
   one asked while another runs waits for it and runs once more after it, however many came meanwhile; and two flushes
   start at least `minGapMs` apart, so a file in the sandbox written without pause costs at most what the 2-second
   scan cost before it. */
export interface Flusher {
    readonly request: () => void;
    readonly stop: () => void;
}

export interface FlusherTiming {
    readonly debounceMs: number;
    readonly minGapMs: number;
    readonly now?: () => number;
}

export const FLUSH_TIMING: FlusherTiming = { debounceMs: 100, minGapMs: 2000 };

export const createFlusher = (flush: () => Promise<void>, timing: FlusherTiming = FLUSH_TIMING, log?: Log): Flusher => {
    const now = timing.now ?? Date.now;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    let wanted = false;
    let stopped = false;
    let lastStart = Number.NEGATIVE_INFINITY;
    const schedule = (): void => {
        if (stopped || running || timer !== undefined || !wanted) {
            return;
        }
        const wait = Math.max(timing.debounceMs, lastStart + timing.minGapMs - now());
        timer = setTimeout(() => void run(), wait);
    };
    const run = async (): Promise<void> => {
        timer = undefined;
        if (stopped) {
            return;
        }
        wanted = false;
        running = true;
        lastStart = now();
        try {
            await flush();
        } catch (error) {
            log?.(`  the sandbox changed, but asking file sync for a cycle failed (${errorMessage(error)}); its own scan picks it up`);
        } finally {
            running = false;
            schedule();
        }
    };
    return {
        request: () => {
            wanted = true;
            schedule();
        },
        stop: () => {
            stopped = true;
            if (timer !== undefined) {
                clearTimeout(timer);
                timer = undefined;
            }
        },
    };
};

// What the follower needs of the world, so a test drives it without a sandbox or a Mutagen.
export interface FollowSeams {
    // Where the sandbox is dialled and with what token right now; undefined while there is nothing to ask (held, gone).
    readonly target: () => { readonly base: string; readonly syncToken: string } | undefined;
    readonly ask: (base: string, syncToken: string, last: SyncChanges | undefined, signal: AbortSignal) => Promise<ChangesAnswer>;
    readonly changed: () => void;
    // Said on every answer, so the caller records a sandbox that started or stopped pushing.
    readonly supported: (pushes: boolean) => void;
    readonly wait: (ms: number, signal: AbortSignal) => Promise<void>;
}

// A rest the follow's own end may cut short, which is the one rejection it expects: the loop's condition then stops it.
const rest = async (seams: FollowSeams, ms: number, signal: AbortSignal): Promise<void> => {
    try {
        await seams.wait(ms, signal);
    } catch (error) {
        // allow(silent-catch): an abort ending the rest is the follow being stopped, which the loop reads off `signal`.
        if (!signal.aborted) {
            throw error;
        }
    }
};

// One sandbox's follow, until `signal` aborts.
export const followSyncChanges = async (seams: FollowSeams, signal: AbortSignal): Promise<void> => {
    let last: SyncChanges | undefined;
    let failures = 0;
    while (!signal.aborted) {
        const target = seams.target();
        if (target === undefined) {
            last = undefined;
            await rest(seams, 5000, signal);
            continue;
        }
        let answer: ChangesAnswer;
        try {
            // one held request at a time, by design
            answer = await seams.ask(target.base, target.syncToken, last, signal);
        } catch {
            // allow(silent-catch): a failed ask is an outage the backstop scan covers; the next answer catches up.
            if (signal.aborted) {
                return;
            }
            failures += 1;
            last = undefined;
            await rest(seams, retryDelayMs(failures), signal);
            continue;
        }
        failures = 0;
        if (answer.kind === "unsupported") {
            last = undefined;
            seams.supported(false);
            await rest(seams, UNSUPPORTED_RECHECK_MS, signal);
            continue;
        }
        seams.supported(true);
        if (movedSince(last, answer.changes)) {
            seams.changed();
        }
        last = answer.changes;
    }
};

// Every sandbox's follow, reconciled to the sandboxes that sync files each pass. `start` makes one sandbox's follow;
// what it answers stops it.
export interface Followers {
    readonly reconcile: (sandboxIds: readonly string[]) => void;
    readonly stopAll: () => void;
}

export const createFollowers = (start: (sandboxId: string, signal: AbortSignal) => () => void): Followers => {
    const running = new Map<string, { readonly abort: AbortController; readonly stop: () => void }>();
    const end = (sandboxId: string): void => {
        const held = running.get(sandboxId);
        held?.abort.abort();
        held?.stop();
        running.delete(sandboxId);
    };
    return {
        reconcile: (sandboxIds) => {
            const wanted = new Set(sandboxIds);
            for (const sandboxId of running.keys()) {
                if (!wanted.has(sandboxId)) {
                    end(sandboxId);
                }
            }
            for (const sandboxId of wanted) {
                if (!running.has(sandboxId)) {
                    const abort = new AbortController();
                    running.set(sandboxId, { abort, stop: start(sandboxId, abort.signal) });
                }
            }
        },
        stopAll: () => {
            for (const sandboxId of running.keys()) {
                end(sandboxId);
            }
        },
    };
};
