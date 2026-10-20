import { readFile } from "node:fs/promises";
import { anySignal, sleep } from "@intentic/base/async";
import {
    COST_BYTES,
    costBytesOf,
    freeBytesOf,
    judge,
    type MemoryReading,
    PERSON_RESERVE_BYTES,
    READING_FILES,
    readingFrom,
    RESERVATION_MS,
    type RoomJudgement,
    type RoomSize,
    type ShortMemory,
    STALL_PERCENT,
    STALL_SUSTAINED_PERCENT,
} from "@intentic/constants/memory-room";
import type { WorkloadClass } from "./workload-class.js";

// The one place this daemon decides whether there is room for more work. One sampler reads the sandbox's memory by the
// formula in @intentic/constants/memory-room (limit memory.high → memory.max → the machine; used = working set + swap,
// counted against the limit by its resident part until swap is full; stall = PSI full over ten seconds and a minute), and every consumer reads that one snapshot: the turn door, a child waiting for room, the
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
// Held work is woken by `changed` (something let memory go) and by each sampler reading; this interval is only the floor
// under those, for a release no event reports (2026-10-20).
const WAIT_INTERVAL_MS = 5_000;
// While work is held, how often the processes named by reservations are checked, so a holder that died frees its room
// within about a second rather than at its next look (2026-10-20).
const HOLDER_CHECK_MS = 1_000;
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
    // What a person's turn needs free, and the stalls (ten seconds, a minute) past which nothing is admitted unasked:
    // the gauge warns on these.
    readonly personNeedBytes: number;
    readonly stallLimitPercent: number;
    readonly stallSustainedLimitPercent: number;
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
    // A toolchain command aimed at named files, priced below its class (TARGETED_RUN_BYTES).
    readonly size?: RoomSize | undefined;
    // The process the admitted work runs as: its reservation is handed back the moment it exits, rather than held for
    // RESERVATION_MS by a one-second test that has long finished (measured: 5 GiB held that way on a quiet sandbox).
    readonly pid?: number | undefined;
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
    // Since when (ms) every reading has had room for a person's turn, unbroken up to one taken now; undefined while that
    // one has none. How long memory has stayed free, which a hold waiting for room reads before it lets anything go
    // (turn-resume.ts, releaseRoomHolds): one good sample between two short ones is not memory calming down.
    readonly roomSince: () => Promise<number | undefined>;
    // Something that held memory let it go (a turn settled, a job or child ended): held work looks again now rather than
    // at its next interval. Cheap when nothing is held.
    readonly changed: () => void;
    readonly stop: () => void;
}

// What a person deciding whether to go ahead is risking; the sentence states the stakes and leaves the choice to them.
const STAKES = "Starting another agent now can slow the running ones down, and if memory runs out, the system kills processes to free it.";

interface Reservation {
    readonly owner: string | undefined;
    readonly place: WorkPlace;
    readonly bytes: number;
    readonly at: number;
    readonly pid: number | undefined;
    // Kept for the door's own admission of the same owner, which takes it instead of judging.
    ticket: boolean;
}

// Work held for room, in the order it asked. Every look judges the whole queue on one reading, oldest first, so a
// waiter whose timer happens to fire first cannot take room from one that has waited longer (2026-10-20).
interface Waiter {
    readonly request: AdmitRequest;
    // The latest verdict on it.
    judged: RoomJudgement;
    // Ends its current nap early: set while it naps.
    wake: (() => void) | undefined;
}

// The reading, by the formula, off files read without blocking; `readText` answers one path with its text or undefined.
export const readMemoryReading = async (
    readText: (path: string) => Promise<string | undefined> = (path) =>
        readFile(path, "utf8")
            // allow(silent-catch): a file this kernel or platform does not have is the absent reading the formula handles
            .catch(() => undefined),
): Promise<MemoryReading> => {
    const texts = new Map(await Promise.all(READING_FILES.map(async (path) => [path, await readText(path)] as const)));
    return readingFrom((path) => texts.get(path));
};

// Whether a process is still running here; one this daemon may not signal still counts as running.
const processAlive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error instanceof Error && "code" in error && error.code === "EPERM";
    }
};

type Taken = { readonly at: number; readonly reading: MemoryReading };

interface Holds {
    // Holds `request`, judged short once already (`first`), until a look admits it, `expired()` says its time is up, or
    // `signal` aborts; answers the last verdict.
    readonly hold: (
        request: AdmitRequest,
        first: RoomJudgement,
        until: { readonly expired: () => boolean; readonly intervalMs: number; readonly signal: AbortSignal | undefined },
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

// What held work is answered once its hold ends.
const heldAdmission = (judged: RoomJudgement, diagnosis: string, waitedMs: number): Admission => {
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

// Holds work nobody waits on, told once what is short, until a look admits it or its deadline passes.
const holdFor = async (
    holds: Holds,
    request: AdmitRequest,
    { judged, diagnosis }: { readonly judged: RoomJudgement; readonly diagnosis: string },
    defaults: { readonly startedAt: number; readonly now: () => number; readonly deadlineMs: number; readonly intervalMs: number },
): Promise<Admission> => {
    const { startedAt, now } = defaults;
    const wait = request.wait ?? {};
    wait.onShort?.(diagnosis);
    const deadlineMs = wait.deadlineMs ?? defaults.deadlineMs;
    const last = await holds.hold(request, judged, {
        expired: () => now() - startedAt >= deadlineMs,
        intervalMs: wait.intervalMs ?? defaults.intervalMs,
        signal: wait.signal,
    });
    return heldAdmission(last, diagnosis, now() - startedAt);
};

// The sampler: a reading every `sampleMs`, each also a look for held work so room it sees is taken at once.
const startSampler = (sampleMs: number, reading: () => Promise<Taken>, holds: Pick<Holds, "look">): ReturnType<typeof setInterval> | undefined => {
    if (sampleMs <= 0) {
        return undefined;
    }
    const timer = setInterval(
        () =>
            void reading()
                .then(() => holds.look(false))
                // allow(silent-catch): the files are read with their own failures absorbed; a tick that still fails takes the next
                .catch(() => undefined),
        sampleMs,
    );
    timer.unref();
    return timer;
};

// The queue of held work. `take` reads (fresh, or one a second old), `decide` judges and claims, `dropGone` forgets
// reservations whose holder exited or aged out and says whether any went.
const createHolds = ({
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
        const over = (): boolean => expired() || signal?.aborted === true;
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

export const createResourceBudget = ({
    read = () => readMemoryReading(),
    now = Date.now,
    alive = processAlive,
    sampleMs = SAMPLE_MS,
    waitIntervalMs = WAIT_INTERVAL_MS,
    waitDeadlineMs = WAIT_DEADLINE_MS,
    holderCheckMs = HOLDER_CHECK_MS,
}: {
    readonly read?: () => Promise<MemoryReading>;
    readonly now?: () => number;
    // Whether the process an admission named is still running.
    readonly alive?: (pid: number) => boolean;
    // 0 takes no timed samples: readings are taken only when asked for.
    readonly sampleMs?: number;
    // How often held work looks again, and how long it is held before it is turned away, unless a request says.
    readonly waitIntervalMs?: number;
    readonly waitDeadlineMs?: number;
    // How often, while work is held, the processes reservations name are checked; 0 never checks on a timer.
    readonly holderCheckMs?: number;
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
            if (at - held.at >= RESERVATION_MS || (held.pid !== undefined && !alive(held.pid))) {
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
            stallSustainedLimitPercent: STALL_SUSTAINED_PERCENT,
        };
    };

    const claim = (request: AdmitRequest, at: number): void => {
        nextId += 1;
        reservations.set(String(nextId), {
            owner: request.owner,
            place: request.where ?? "local",
            bytes: request.size === undefined ? WORKLOAD_COST_BYTES[request.workload] : costBytesOf(request.workload, request.size),
            at,
            // A pid this daemon cannot see (another pid namespace) would read as exited at once: the timed hold stands.
            pid: request.pid !== undefined && alive(request.pid) ? request.pid : undefined,
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
            size: request.size,
        });
        if (judged.verdict === "run") {
            claim(request, taken.at);
        }
        return judged;
    };

    const holds = createHolds({
        take: (fresh) => reading(fresh ? 0 : REUSE_MS),
        decide,
        dropGone: () => {
            const before = reservations.size;
            live(now());
            return reservations.size < before;
        },
        holderCheckMs,
    });

    const personHasRoom = (taken: { readonly at: number; readonly reading: MemoryReading }, reservedBytes = localHeld(taken.at)): boolean =>
        judge(taken.reading, { workload: "agentRuntime", attended: true, reservedBytes }).verdict === "run";

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
        // Work willing to wait lets work already waiting judge this reading first, rather than going past it (2026-10-20).
        if (request.wait !== undefined) {
            await holds.settle();
        }
        const taken = await reading();
        if (personHasRoom(taken)) {
            warned.clear();
        }
        const judged = decide(request, taken);
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
        if (request.wait === undefined) {
            return { verdict: "wait", message: diagnosis, waitedMs: 0 };
        }
        return holdFor(holds, request, { judged, diagnosis }, { startedAt, now, deadlineMs: waitDeadlineMs, intervalMs: waitIntervalMs });
    };

    const timer = startSampler(sampleMs, () => reading(), holds);

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
        // Every reading is judged against what admitted work holds now, so work let go a moment ago counts against the
        // whole run of readings rather than only the newest.
        roomSince: async () => {
            const taken = await reading();
            const reserved = localHeld(taken.at);
            if (!personHasRoom(taken, reserved)) {
                return undefined;
            }
            let since = taken.at;
            for (let index = recent.length - 1; index >= 0; index -= 1) {
                const earlier = recent[index];
                if (earlier === undefined || !personHasRoom(earlier, reserved)) {
                    break;
                }
                since = Math.min(since, earlier.at);
            }
            return since;
        },
        changed: () => holds.look(true),
        stop: () => {
            clearInterval(timer);
            holds.stop();
        },
    };
};
