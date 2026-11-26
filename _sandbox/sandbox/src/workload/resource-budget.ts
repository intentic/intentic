import { readFile } from "node:fs/promises";
import {
    COST_BYTES,
    costBytesOf,
    countedBytesOf,
    freeBytesOf,
    judge,
    type HostRoom,
    type MemoryReading,
    PERSON_RESERVE_BYTES,
    type RoomWorkload,
    READING_FILES,
    readingFrom,
    RESERVATION_MS,
    type RoomJudgement,
    type RoomSize,
    type ShortMemory,
    STALL_PERCENT,
    STALL_SUSTAINED_PERCENT,
} from "@intentic/constants/memory-room";
import { type AgentRoom, type Lease, type LeaseSource, agentRoomOf, leasedTurn, leaseFor, leaseWords, steadyHostOf } from "./leases/agent-leases.js";
import { createHolds, holdFor, type Holds, type Taken } from "./room-wait-queue.js";
import type { WorkloadClass } from "./workload-class.js";

// The one place this daemon decides whether there is room for more work. One sampler reads the sandbox's memory by the
// formula in @intentic/constants/memory-room (limit memory.high → memory.max → the machine, and never above the workload
// leaf's wall plus what runs outside the leaf, since everything admitted runs in it; used = working set + swap,
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

/* AN AGENT TURN ANSWERS TO THE MACHINE UNDER THE SANDBOX ONLY DOWN TO ITS FLOOR (2026-11-19). Work nobody waits on waits
   while starting it would take the host below its reserve line (memory-room.mjs `hostShortOf`): a tenth of its memory,
   3.2 GiB on a 32 GB laptop. That line is for heavy work (a cargo build is priced at 7 GiB); an agent turn's own runtime
   is a few hundred megabytes, and its heavy commands each queue for the host on their own (the room socket). Held to the
   reserve, the shinobi-society sandbox's subagents waited ten minutes and failed, again and again, while the laptop's
   other sandboxes left 1.5 to 3.7 GiB of its 31.4 GiB, which no waiting in here could change. So an agent turn nobody
   waits on is judged on the sandbox's own room, which its own work frees, and on the host only down to that host's hard
   floor, the 1.5 GiB under which Windows thrashed (hosts.ts hostMemoryLowBytes), after the turn's own cost and what was
   admitted just before it: two turns at most start into a host with 3.5 GiB available. Heavy work keeps the reserve. */
const AGENT_HOST_FLOOR_BYTES = 1.5 * 1024 ** 3;

type Asked = Parameters<typeof judge>[1] & { readonly reservedBytes: number };

// The formula's verdict on one request, but for an agent turn the host's reserve line alone holds: judged without the
// host while the host keeps its floor (above), and held as the formula said otherwise.
const hostFloored = (request: AdmitRequest, reading: MemoryReading, asked: Asked): RoomJudgement => {
    const held = judge(reading, asked);
    const { host } = reading;
    if (held.verdict !== "wait" || request.workload !== "agentRuntime" || request.attended || host === undefined) {
        return held;
    }
    if (host.availableBytes - asked.reservedBytes < AGENT_HOST_FLOOR_BYTES + (asked.costBytes ?? costBytesOf(request.workload, request.size))) {
        return held;
    }
    const sandboxOnly = judge({ ...reading, host: undefined }, asked);
    return sandboxOnly.verdict === "run" ? sandboxOnly : held;
};

// The verdict, and for an agent turn with leases, the sandbox's own room judged with them held, named as theirs where
// they are what holds it. Never the host's: what agents here grow into is first the cache their VM already holds (WSL,
// Docker Desktop), which the host's figure does not count as its own, and held to it the host's floor would stop them.
const verdictOf = (request: AdmitRequest, reading: MemoryReading, reservedBytes: number, lease?: Lease): RoomJudgement => {
    const asked = { workload: request.workload, attended: request.attended, size: request.size, costBytes: lease?.costBytes, reservedBytes };
    const judged = hostFloored(request, reading, asked);
    if (judged.verdict !== "run" || lease === undefined || lease.heldBytes === 0) {
        return judged;
    }
    const leased = judge({ ...reading, host: undefined }, { ...asked, reservedBytes: reservedBytes + lease.heldBytes });
    return leased.verdict === "run" ? judged : { ...leased, diagnosis: leaseWords(lease, leased) };
};

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
    // The agent turns holding leases and how many more fit now (agent-leases.ts); absent until leases are handed over.
    readonly agents?: AgentRoom;
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
    // A toolchain command priced by its named shape (SIZE_BYTES in @intentic/constants/memory-room) instead of its class.
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
        // Give the wait up before its deadline once waiting cannot help (memory-room.mjs `stuckWait`): for a caller that
        // starts its work anyway when the wait ends (the room socket's heavy commands), not one that would not start.
        readonly giveUpWhenStuck?: boolean;
    };
    // The door will be asked again for this owner (a child admitted before its turn is started): the admission is kept
    // for it, and the door's own admission takes it instead of judging a second time.
    readonly forTurn?: boolean;
    // Whose fan-out it is part of (a child's parent): held work of different groups takes turns for room, so one parent's
    // wide fan-out cannot keep another's first child waiting behind all of its own (room-wait-queue.ts fairOrder).
    readonly group?: string | undefined;
}

export type Admission =
    | { readonly verdict: "run"; readonly waitedMs: number }
    | { readonly verdict: "wait"; readonly message: string; readonly waitedMs: number }
    | {
          readonly verdict: "refuse";
          readonly message: string;
          readonly memory?: ShortMemory;
          readonly waitedMs: number;
          // Held work only: what was still short when its hold ended, without the sentence around it, and whether the hold
          // was given up early because waiting could not help (`giveUpWhenStuck`).
          readonly diagnosis?: string;
          readonly stuck?: boolean;
      };

export interface ResourceBudget {
    // The shared reading, no older than `maxAgeMs` (a second by default); 0 for a reading taken now.
    readonly snapshot: (maxAgeMs?: number) => Promise<BudgetSnapshot>;
    // The only verdict: run, wait (nobody waiting on it, no `wait` asked) or refuse. Never admits and then refuses the
    // same request: an admission a later door would judge again is kept for it (`forTurn`).
    readonly admit: (request: AdmitRequest) => Promise<Admission>;
    // Whether any reading in the last few minutes had no room for work nobody waits on: why a runtime died, read off
    // what the sampler already saw rather than a verdict taken now. The sandbox's own room only: a death in here is not
    // the host machine's to explain.
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
    // An agent turn's reservation stands only until its lease does (`localHeld`).
    readonly workload: RoomWorkload;
    readonly place: WorkPlace;
    readonly bytes: number;
    readonly at: number;
    readonly pid: number | undefined;
    // What counted against the limit in the reading it was admitted on: how far the reading has grown since is the work
    // it was for showing up, which it stops holding (`localHeld`). Undefined where no reading measured it.
    readonly countedAt: number | undefined;
    // Kept for the door's own admission of the same owner, which takes it instead of judging.
    ticket: boolean;
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

// What `held` reservations still hold off a reading that counts `counted` against the limit: their bytes, less what the
// reading has grown by since the oldest of them was admitted.
// 2026-11-17, the shinobi-society audit: a reservation was held whole for RESERVATION_MS while the work it was for already
// showed in the reading, so a cargo build counted twice and a second one within 90 s needed ~15 GiB free, not 8. The
// reading's growth is the sandbox's, not one process's, so it may be some other work's: that is still counted in the
// reading, so free memory stays what is really there. Growth from the oldest admission's reading is the most any of them
// can have grown; a reading that fell since (something else let go) shrinks nothing.
export const heldOff = (held: readonly Pick<Reservation, "bytes" | "countedAt">[], counted: number | undefined): number => {
    const whole = held.reduce((sum, reserved) => sum + reserved.bytes, 0);
    const bases = held.flatMap((reserved) => (reserved.countedAt === undefined ? [] : [reserved.countedAt]));
    if (counted === undefined || bases.length === 0) {
        return whole;
    }
    const grown = Math.max(0, counted - Math.min(...bases));
    const shrinkable = held.reduce((sum, reserved) => sum + (reserved.countedAt === undefined ? 0 : reserved.bytes), 0);
    return whole - shrinkable + Math.max(0, shrinkable - grown);
};

// An agent turn's reservation is done once its lease stands for it: the scan has seen the turn, so the reading shows what
// it holds and the lease what it may still grow into. Gone for good, so a turn that ends inside RESERVATION_MS does not
// bring it back once its lease is.
const supersede = (reservations: Map<string, Reservation>, leased: ReadonlySet<string> | undefined): void => {
    for (const [id, held] of reservations) {
        if (held.workload === "agentRuntime" && held.owner !== undefined && leased?.has(held.owner) === true) {
            reservations.delete(id);
        }
    }
};

// The snapshot of one reading with what admitted work still holds off it.
const snapshotFrom = (taken: Taken, reservedBytes: number): BudgetSnapshot => {
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

// Whether a process is still running here; one this daemon may not signal still counts as running.
const processAlive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error instanceof Error && "code" in error && error.code === "EPERM";
    }
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


// (2026-11-02) The sandbox's reading with the machine it runs on beside it, so work nobody waits on also waits for that
// machine (memory-room.mjs `hostShortOf`). Where the host part comes from is handed over at boot, once the device hub
// exists (`answerToHost`, from hosts/host-memory.ts); until then, and whenever it answers undefined or fails, the reading
// is the sandbox's own: no host constraint, never no room. `fresh` asks the machine now rather than reading its last
// heartbeat (up to HOST_HEARTBEAT_MS old): what a person's "Free memory" measures before and after by
// (hosts/reclaim/host-reclaim.ts).
export type HostSource = (options?: { readonly fresh?: boolean }) => Promise<HostRoom | undefined>;
interface HostAwareReading {
    readonly read: () => Promise<MemoryReading>;
    readonly answerToHost: (host: HostSource) => void;
}
export const hostAwareReading = (readSandbox: () => Promise<MemoryReading> = () => readMemoryReading()): HostAwareReading => {
    let host: HostSource | undefined;
    return {
        read: async () => {
            const [reading, room] = await Promise.all([
                readSandbox(),
                // allow(silent-catch): a host part that cannot be read is no host constraint, never no room
                host?.().catch(() => undefined),
            ]);
            return room === undefined ? reading : { ...reading, host: room };
        },
        answerToHost: (source) => {
            host = source;
        },
    };
};

export const createResourceBudget = ({
    read = () => readMemoryReading(),
    now = Date.now,
    alive = processAlive,
    sampleMs = SAMPLE_MS,
    leases = () => undefined,
    waitIntervalMs = WAIT_INTERVAL_MS,
    waitDeadlineMs = WAIT_DEADLINE_MS,
    holderCheckMs = HOLDER_CHECK_MS,
}: {
    // The sandbox's reading; `hostAwareReading` adds the machine it runs on.
    readonly read?: () => Promise<MemoryReading>;
    readonly now?: () => number;
    // Whether the process an admission named is still running.
    readonly alive?: (pid: number) => boolean;
    // 0 takes no timed samples: readings are taken only when asked for.
    readonly sampleMs?: number;
    // The agent turns running here and their envelope (`leaseSlot`); none, and agent turns are judged as before leases.
    readonly leases?: LeaseSource;
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
    const localHeld = (taken: Taken, except?: string): number =>
        heldOff(
            live(taken.at).filter((reserved) => reserved.place === "local" && (except === undefined || reserved.owner !== except)),
            countedBytesOf(taken.reading),
        );

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
        const held = leases();
        supersede(reservations, held === undefined ? undefined : new Set(held.agents.keys()));
        const snapshot = snapshotFrom(taken, localHeld(taken));
        const agents = agentRoomOf(held, freeBytesOf(taken.reading), snapshot.reservedBytes);
        return agents === undefined ? snapshot : { ...snapshot, agents };
    };

    // `taken` is the reading the admission was judged on, or only its time where none was (work sent to a runner);
    // `costBytes` what it was priced at where that is not its class's price (an agent turn's envelope).
    const claim = (request: AdmitRequest, taken: Taken | { readonly at: number; readonly reading?: undefined }, costBytes?: number): void => {
        const { at } = taken;
        nextId += 1;
        reservations.set(String(nextId), {
            owner: request.owner,
            workload: request.workload,
            place: request.where ?? "local",
            bytes: costBytes ?? (request.size === undefined ? WORKLOAD_COST_BYTES[request.workload] : costBytesOf(request.workload, request.size)),
            at,
            // A pid this daemon cannot see (another pid namespace) would read as exited at once: the timed hold stands.
            pid: request.pid !== undefined && alive(request.pid) ? request.pid : undefined,
            countedAt: taken.reading === undefined ? undefined : countedBytesOf(taken.reading),
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
        const lease = leaseFor(request, leases());
        supersede(reservations, lease?.owners);
        const judgedOn = leasedTurn(request) ? steadyHostOf(taken, recent) : taken.reading;
        const judged = verdictOf(request, judgedOn, localHeld(taken, request.owner), lease);
        if (judged.verdict === "run") {
            claim(request, taken, lease?.costBytes);
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

    const personHasRoom = (taken: { readonly at: number; readonly reading: MemoryReading }, reservedBytes = localHeld(taken)): boolean =>
        judge(taken.reading, { workload: "agentRuntime", attended: true, reservedBytes }).verdict === "run";

    const admit = async (request: AdmitRequest): Promise<Admission> => {
        const startedAt = now();
        // Work that runs on a runner takes nothing from this sandbox, so this sandbox has no say in it.
        if (request.where !== undefined && request.where !== "local") {
            claim(request, { at: startedAt });
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
                claim(request, taken);
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
                    judge({ ...taken.reading, host: undefined }, { workload: "agentRuntime", attended: false, reservedBytes: 0 }).verdict !== "run",
            );
        },
        // Every reading is judged against what admitted work holds now, so work let go a moment ago counts against the
        // whole run of readings rather than only the newest.
        roomSince: async () => {
            const taken = await reading();
            const reserved = localHeld(taken);
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
