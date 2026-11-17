import { anySignal, sleep } from "@intentic/base/async";
import { type MemoryReading, type RoomJudgement, stuckWait } from "@intentic/constants/memory-room";
import type { Admission, AdmitRequest } from "./resource-budget.js";

// The queue of work the resource budget (resource-budget.ts) holds for room: each waiter naps, every look judges the
// whole queue on one reading, and a hold ends once a look admits it, its deadline passes, or (for a caller that starts
// anyway) waiting has stopped helping.

// Work held for room, in the order it asked. Every look judges the whole queue on one reading, oldest first, so a
// waiter whose timer happens to fire first cannot take room from one that has waited longer (2026-10-20).
interface Waiter {
    readonly request: AdmitRequest;
    // The latest verdict on it.
    judged: RoomJudgement;
    // Ends its current nap early: set while it naps.
    wake: (() => void) | undefined;
}

export type Taken = { readonly at: number; readonly reading: MemoryReading };

export interface Holds {
    // Holds `request`, judged short once already (`first`), until a look admits it, `expired()` says its time is up, or
    // `signal` aborts; answers the last verdict.
    readonly hold: (
        request: AdmitRequest,
        first: RoomJudgement,
        until: { readonly expired: (judged: RoomJudgement) => boolean; readonly intervalMs: number; readonly signal: AbortSignal | undefined },
    ) => Promise<RoomJudgement>;
    // Lets the work already held judge the newest reading first; at once when nothing is held.
    readonly settle: () => Promise<void>;
    // Look again now; `fresh` asks a new reading, for a change the last reading cannot show (a process exited).
    readonly look: (fresh: boolean) => void;
    readonly stop: () => void;
}

// A held waiter's sleep until its next look: `ms`, cut short by an abort or by a look that admitted it.
const nap = async (waiter: Waiter, ms: number, signal: AbortSignal | undefined): Promise<void> => {
    const woken = new AbortController();
    waiter.wake = () => woken.abort();
    await sleep(ms, { signal: anySignal(signal, woken.signal) });
    waiter.wake = undefined;
};

// What held work is answered once its hold ends; `stuck` when it was given up early, waiting being no help.
const heldAdmission = (judged: RoomJudgement, diagnosis: string, waitedMs: number, stuck: boolean): Admission => {
    if (judged.verdict === "run") {
        return { verdict: "run", waitedMs };
    }
    const minutes = Math.max(1, Math.round(waitedMs / 60_000));
    const still = judged.diagnosis ?? diagnosis;
    const message = `${still}. This background work waited ${minutes} minute${minutes === 1 ? "" : "s"} for room and did not start: work people send gets the room first.`;
    const refused = { verdict: "refuse", message, waitedMs, diagnosis: still, stuck } as const;
    return judged.memory === undefined ? refused : { ...refused, memory: judged.memory };
};

// Holds work nobody waits on, told once what is short, until a look admits it or its deadline passes.
export const holdFor = async (
    holds: Holds,
    request: AdmitRequest,
    { judged, diagnosis }: { readonly judged: RoomJudgement; readonly diagnosis: string },
    defaults: { readonly startedAt: number; readonly now: () => number; readonly deadlineMs: number; readonly intervalMs: number },
): Promise<Admission> => {
    const { startedAt, now } = defaults;
    const wait = request.wait ?? {};
    wait.onShort?.(diagnosis);
    const deadlineMs = wait.deadlineMs ?? defaults.deadlineMs;
    const stuck = stuckWait();
    let gaveUp = false;
    const last = await holds.hold(request, judged, {
        expired: (latest) => {
            if (now() - startedAt >= deadlineMs) {
                return true;
            }
            gaveUp = wait.giveUpWhenStuck === true && stuck.observe(latest, now());
            return gaveUp;
        },
        intervalMs: wait.intervalMs ?? defaults.intervalMs,
        signal: wait.signal,
    });
    return heldAdmission(last, diagnosis, now() - startedAt, gaveUp);
};

// The queue of held work. `take` reads (fresh, or one a second old), `decide` judges and claims, `dropGone` forgets
// reservations whose holder exited or aged out and says whether any went.
export const createHolds = ({
    take,
    decide,
    dropGone,
    holderCheckMs,
}: {
    readonly take: (fresh: boolean) => Promise<Taken>;
    readonly decide: (request: AdmitRequest, taken: Taken) => RoomJudgement;
    readonly dropGone: () => boolean;
    readonly holderCheckMs: number;
}): Holds => {
    const queue: Waiter[] = [];
    let passing: Promise<void> | undefined;
    let again = false;
    let fresh = false;
    let holderTimer: ReturnType<typeof setInterval> | undefined;

    const judgeQueue = async (): Promise<void> => {
        do {
            again = false;
            // Taken before the read, so a change told during it asks the next read fresh rather than being cleared.
            const wantFresh = fresh;
            fresh = false;
            const taken = await take(wantFresh);
            for (const waiter of queue) {
                if (waiter.judged.verdict !== "run") {
                    waiter.judged = decide(waiter.request, taken);
                    if (waiter.judged.verdict === "run") {
                        waiter.wake?.();
                    }
                }
            }
        } while (again && queue.some((waiter) => waiter.judged.verdict !== "run"));
    };
    // One look at a time; a look asked during one runs once more after it, on a reading of its own.
    const pass = (): Promise<void> => {
        if (passing !== undefined) {
            again = true;
            return passing;
        }
        const running = judgeQueue().finally(() => {
            passing = undefined;
        });
        passing = running;
        return running;
    };
    const look = (wantFresh: boolean): void => {
        if (queue.length === 0) {
            return;
        }
        fresh ||= wantFresh;
        void pass()
            // allow(silent-catch): a failed look is the waiter's own next look, which rethrows to its caller
            .catch(() => undefined);
    };
    const watchHolders = (): void => {
        if (holderTimer === undefined && holderCheckMs > 0) {
            holderTimer = setInterval(() => {
                if (dropGone()) {
                    look(true);
                }
            }, holderCheckMs);
            holderTimer.unref();
        }
    };
    const leave = (waiter: Waiter): void => {
        queue.splice(queue.indexOf(waiter), 1);
        if (queue.length === 0) {
            clearInterval(holderTimer);
            holderTimer = undefined;
        }
    };

    const hold: Holds["hold"] = async (request, first, { expired, intervalMs, signal }) => {
        const waiter: Waiter = { request, judged: first, wake: undefined };
        const over = (): boolean => expired(waiter.judged) || signal?.aborted === true;
        queue.push(waiter);
        watchHolders();
        try {
            while (waiter.judged.verdict !== "run" && !over()) {
                await nap(waiter, intervalMs, signal);
                await pass();
            }
            return waiter.judged;
        } finally {
            leave(waiter);
        }
    };

    return {
        hold,
        settle: () => (queue.length === 0 ? Promise.resolve() : pass()),
        look,
        stop: () => clearInterval(holderTimer),
    };
};
