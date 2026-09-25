import { readFile } from "node:fs/promises";
import {
    COST_BYTES,
    freeBytesOf,
    judge,
    type MemoryReading,
    PERSON_RESERVE_BYTES,
    READING_FILES,
    readingFrom,
    RESERVATION_MS,
    type RoomJudgement,
    type ShortMemory,
    STALL_PERCENT,
} from "@intentic/constants/memory-room";
import type { WorkloadClass } from "./workload-class.js";

// The one place this daemon decides whether there is room for more work. One sampler reads the sandbox's memory by the
// formula in @intentic/constants/memory-room (limit memory.high → memory.max → the machine; used = working set + swap;
// stall = PSI full), and every consumer reads that one snapshot: the turn door, a child waiting for room, the
// heavy-command queue through the room socket (room-socket.ts), the editor's gauge (live-metrics.ts), and a child's
// death certificate (child-death.ts). What admitted work holds before the reading shows it is kept in one ledger, keyed
// by where the work runs, so work sent to a runner holds nothing here.

// The cost of each class is the formula module's table; this line is where the daemon checks it covers every class.
export const WORKLOAD_COST_BYTES: Readonly<Record<WorkloadClass, number>> = COST_BYTES;

const SAMPLE_MS = 10_000;
// Readings asked for closer together than this share one, so a burst of admissions costs one read.
const REUSE_MS = 1_000;
// How far back a death certificate may look for a short spell.
const RECENT_MS = 5 * 60_000;
const WAIT_INTERVAL_MS = 5_000;
// How long work nobody is waiting on is held for room before it is turned away.
export const WAIT_DEADLINE_MS = 10 * 60_000;

// Where admitted work runs: this sandbox, or a runner by id, which holds nothing here.
export type WorkPlace = "local" | { readonly runner: string };

export interface BudgetSnapshot {
    // Epoch milliseconds.
    readonly at: number;
    readonly reading: MemoryReading;
    // What admitted work on this sandbox still holds off the reading.
    readonly reservedBytes: number;
    // limit − used (never more than the machine has available) − reserved; undefined where nothing measures it.
    readonly freeBytes: number | undefined;
    // What a person's turn needs free, and the stall past which nothing is admitted unasked: the gauge warns on these.
    readonly personNeedBytes: number;
    readonly stallLimitPercent: number;
}

export interface AdmitRequest {
    readonly workload: WorkloadClass;
    // A person is waiting on it: short memory then warns them (once a spell) instead of holding it.
    readonly attended: boolean;
    // The conversation it is for; its own reservation never counts against it.
    readonly owner?: string | undefined;
    // Who is asking, for the once-a-spell warning; "" when the daemon cannot name them.
    readonly actor?: string | undefined;
    readonly where?: WorkPlace;
    // Hold work nobody is waiting on until there is room, instead of answering `wait`.
    readonly wait?: {
        readonly deadlineMs?: number;
        readonly intervalMs?: number;
        readonly signal?: AbortSignal | undefined;
        // Told once, on the first short reading, with what is short.
        readonly onShort?: (diagnosis: string) => void;
    };
    // The door will be asked again for this owner (a child admitted before its turn is started): the admission is kept
    // for it, and the door's own admission takes it instead of judging a second time.
    readonly forTurn?: boolean;
}

export type Admission =
    | { readonly verdict: "run"; readonly waitedMs: number }
    | { readonly verdict: "wait"; readonly message: string; readonly waitedMs: number }
    | { readonly verdict: "refuse"; readonly message: string; readonly memory?: ShortMemory; readonly waitedMs: number };

export interface ResourceBudget {
    // The shared reading, no older than `maxAgeMs` (a second by default); 0 for a reading taken now.
    readonly snapshot: (maxAgeMs?: number) => Promise<BudgetSnapshot>;
    // The only verdict: run, wait (nobody waiting on it, no `wait` asked) or refuse. Never admits and then refuses the
    // same request: an admission a later door would judge again is kept for it (`forTurn`).
    readonly admit: (request: AdmitRequest) => Promise<Admission>;
    // Whether any reading in the last few minutes had no room for work nobody waits on: why a runtime died, read off
    // what the sampler already saw rather than a verdict taken now.
    readonly shortRecently: (windowMs?: number) => Promise<boolean>;
    readonly stop: () => void;
}

// What a person deciding whether to go ahead is risking; the sentence states the stakes and leaves the choice to them.
const STAKES = "Starting another agent now can slow the running ones down, and if memory runs out, the system kills processes to free it.";

interface Reservation {
    readonly owner: string | undefined;
    readonly place: WorkPlace;
    readonly bytes: number;
    readonly at: number;
    // Kept for the door's own admission of the same owner, which takes it instead of judging.
    ticket: boolean;
}

// The reading, by the formula, off files read without blocking; `readText` answers one path with its text or undefined.
export const readMemoryReading = async (
    readText: (path: string) => Promise<string | undefined> = (path) =>
        readFile(path, "utf8")
            // silent-catch: a file this kernel or platform does not have is the absent reading the formula handles
            .catch(() => undefined),
): Promise<MemoryReading> => {
    const texts = new Map(await Promise.all(READING_FILES.map(async (path) => [path, await readText(path)] as const)));
    return readingFrom((path) => texts.get(path));
};

const sleep = (ms: number, signal: AbortSignal | undefined): Promise<void> =>
    new Promise((resolve) => {
        const timer = setTimeout(done, ms);
        function done(): void {
            clearTimeout(timer);
            signal?.removeEventListener("abort", done);
            resolve();
        }
        signal?.addEventListener("abort", done, { once: true });
    });

export const createResourceBudget = ({
    read = () => readMemoryReading(),
    now = Date.now,
    sampleMs = SAMPLE_MS,
    waitIntervalMs = WAIT_INTERVAL_MS,
    waitDeadlineMs = WAIT_DEADLINE_MS,
}: {
    readonly read?: () => Promise<MemoryReading>;
    readonly now?: () => number;
    // 0 takes no timed samples: readings are taken only when asked for.
    readonly sampleMs?: number;
    // How often held work looks again, and how long it is held before it is turned away, unless a request says.
    readonly waitIntervalMs?: number;
    readonly waitDeadlineMs?: number;
} = {}): ResourceBudget => {
    const reservations = new Map<string, Reservation>();
    let nextId = 0;
    // Readings the sampler kept, newest last.
    const recent: { readonly at: number; readonly reading: MemoryReading }[] = [];
    let inFlight: Promise<MemoryReading> | undefined;
    // Who has been warned this spell; a spell ends at the first reading with room for a person's turn.
    const warned = new Set<string>();

    const live = (at: number): Reservation[] => {
        for (const [id, held] of reservations) {
            if (at - held.at >= RESERVATION_MS) {
                reservations.delete(id);
            }
        }
        return [...reservations.values()];
    };
    const localHeld = (at: number, except?: string): number =>
        live(at)
            .filter((held) => held.place === "local" && (except === undefined || held.owner !== except))
            .reduce((sum, held) => sum + held.bytes, 0);

    const reading = async (maxAgeMs = REUSE_MS): Promise<{ readonly at: number; readonly reading: MemoryReading }> => {
        const last = recent.at(-1);
        if (last !== undefined && now() - last.at < maxAgeMs) {
            return last;
        }
        if (inFlight === undefined) {
            const pending = read();
            inFlight = pending;
            // Cleared beside the awaiting chain rather than in it, so a caller is not held a tick longer for it.
            const clear = (): void => {
                if (inFlight === pending) {
                    inFlight = undefined;
                }
            };
            void pending.then(clear, clear);
        }
        const taken = { at: now(), reading: await inFlight };
        recent.push(taken);
        while (recent.length > 0 && (recent[0]?.at ?? 0) < taken.at - RECENT_MS) {
            recent.shift();
        }
        return taken;
    };

    const snapshotOf = (taken: { readonly at: number; readonly reading: MemoryReading }): BudgetSnapshot => {
        const reservedBytes = localHeld(taken.at);
        const free = freeBytesOf(taken.reading);
        return {
            at: taken.at,
            reading: taken.reading,
            reservedBytes,
            freeBytes: free === undefined ? undefined : Math.max(0, free - reservedBytes),
            personNeedBytes: PERSON_RESERVE_BYTES,
            stallLimitPercent: STALL_PERCENT,
        };
    };

    const claim = (request: AdmitRequest, at: number): void => {
        nextId += 1;
        reservations.set(String(nextId), {
            owner: request.owner,
            place: request.where ?? "local",
            bytes: WORKLOAD_COST_BYTES[request.workload],
            at,
            ticket: request.forTurn === true && request.owner !== undefined,
        });
    };

    // A kept admission for this owner, taken once: the door's answer for a child admitted before its turn began.
    const redeem = (owner: string | undefined, at: number): boolean => {
        const kept = owner === undefined ? undefined : live(at).find((held) => held.owner === owner && held.ticket);
        if (kept === undefined) {
            return false;
        }
        kept.ticket = false;
        return true;
    };

    // One verdict on one reading, with no await between it and the claim, so the next request's verdict counts this one.
    const decide = (request: AdmitRequest, taken: { readonly at: number; readonly reading: MemoryReading }): RoomJudgement => {
        const judged = judge(taken.reading, {
            workload: request.workload,
            attended: request.attended,
            reservedBytes: localHeld(taken.at, request.owner),
        });
        if (judged.verdict === "run") {
            claim(request, taken.at);
        }
        return judged;
    };

    const personHasRoom = (taken: { readonly at: number; readonly reading: MemoryReading }): boolean =>
        judge(taken.reading, { workload: "agentRuntime", attended: true, reservedBytes: localHeld(taken.at) }).verdict === "run";

    const admit = async (request: AdmitRequest): Promise<Admission> => {
        const startedAt = now();
        // Work that runs on a runner takes nothing from this sandbox, so this sandbox has no say in it.
        if (request.where !== undefined && request.where !== "local") {
            claim(request, startedAt);
            return { verdict: "run", waitedMs: 0 };
        }
        if (redeem(request.owner, startedAt)) {
            return { verdict: "run", waitedMs: 0 };
        }
        let taken = await reading();
        if (personHasRoom(taken)) {
            warned.clear();
        }
        let judged = decide(request, taken);
        if (judged.verdict === "run") {
            return { verdict: "run", waitedMs: 0 };
        }
        const diagnosis = judged.diagnosis ?? "Sandbox memory is low";
        if (judged.verdict === "refuse") {
            // Keyed by person: one member's choice to go ahead does not answer for another who has not been told.
            const who = request.actor ?? "";
            if (warned.has(who)) {
                claim(request, taken.at);
                return { verdict: "run", waitedMs: 0 };
            }
            warned.add(who);
            return { verdict: "refuse", message: `${diagnosis}. ${STAKES}`, ...(judged.memory === undefined ? {} : { memory: judged.memory }), waitedMs: 0 };
        }
        const wait = request.wait;
        if (wait === undefined) {
            return { verdict: "wait", message: diagnosis, waitedMs: 0 };
        }
        wait.onShort?.(diagnosis);
        const deadlineMs = wait.deadlineMs ?? waitDeadlineMs;
        while (judged.verdict !== "run" && now() - startedAt < deadlineMs && wait.signal?.aborted !== true) {
            await sleep(wait.intervalMs ?? waitIntervalMs, wait.signal);
            taken = await reading();
            judged = decide(request, taken);
        }
        const waitedMs = now() - startedAt;
        if (judged.verdict === "run") {
            return { verdict: "run", waitedMs };
        }
        const minutes = Math.max(1, Math.round(waitedMs / 60_000));
        return {
            verdict: "refuse",
            message: `${judged.diagnosis ?? diagnosis}. This background work waited ${minutes} minute${minutes === 1 ? "" : "s"} for room and did not start: work people send gets the room first.`,
            ...(judged.memory === undefined ? {} : { memory: judged.memory }),
            waitedMs,
        };
    };

    const timer =
        sampleMs > 0
            ? setInterval(
                  () =>
                      void reading()
                          // silent-catch: the files are read with their own failures absorbed; a tick that still fails takes the next
                          .catch(() => undefined),
                  sampleMs,
              )
            : undefined;
    timer?.unref();

    return {
        snapshot: async (maxAgeMs) => snapshotOf(await reading(maxAgeMs)),
        admit,
        shortRecently: async (windowMs = RECENT_MS) => {
            const at = (await reading(0)).at;
            return recent.some(
                (taken) =>
                    taken.at >= at - windowMs &&
                    judge(taken.reading, { workload: "agentRuntime", attended: false, reservedBytes: 0 }).verdict !== "run",
            );
        },
        stop: () => clearInterval(timer),
    };
};
