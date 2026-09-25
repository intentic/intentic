import { totalmem } from "node:os";
import { sleep } from "@intentic/base/async";
import { type CgroupReading, readCgroup } from "./cgroup.js";

// Decides what a turn meets on a sandbox short of memory: reads live cgroup files instead of the periodic sampler
// snapshot, and returns a hold as a value rather than throwing. A person is warned, never stopped; background work waits.

export interface MemoryHeadroom {
    // The ceiling a turn is measured against: memory.high, where the kernel starts throttling, else memory.max, else the
    // machine's memory, never past the machine's. Undefined only when nothing bounds it; the gate then has no opinion.
    readonly limitBytes: number | undefined;
    // Working set plus swapped: a sandbox may swap past its cap, and a paged-out page leaves memory.current, so paging must not read as relief.
    readonly usedBytes: number | undefined;
    // The swapped half of `usedBytes`, kept apart only so a hold can name it; 0 when swap is off or unaccounted.
    readonly swapBytes: number;
    readonly freeBytes: number | undefined;
    // Memory PSI `full avg10`: percent of the last 10s every task was stalled on memory; 0 when healthy.
    readonly stalledPercent: number;
    // memory.events `oom_kill`: processes the kernel's OOM killer has taken in this cgroup, cumulative since it began.
    readonly oomKills: number | undefined;
}

// Pure, so the arithmetic swap broke is testable without a cgroup; a cap past the machine's memory never binds. Past
// memory.high the kernel throttles the whole cgroup into reclaim, so room above it is room nobody can use at speed: on a
// cap above 10 GiB, a gibibyte short of memory.max already sits past it.
export const headroomFrom = (
    {
        workingSetBytes,
        memoryLimitBytes,
        memoryHighBytes,
        swapBytes,
        memoryEvents,
        pressure,
    }: Pick<CgroupReading, "workingSetBytes" | "memoryLimitBytes" | "memoryHighBytes" | "swapBytes" | "memoryEvents" | "pressure">,
    machineBytes: number,
): MemoryHeadroom => {
    // Unaccounted swap (cgroup v1, swapaccount off) is none, never unknown: it must not blank a measurable ceiling.
    const swapped = swapBytes ?? 0;
    const usedBytes = workingSetBytes === undefined ? undefined : workingSetBytes + swapped;
    const bound = Math.min(memoryHighBytes ?? Number.POSITIVE_INFINITY, memoryLimitBytes ?? Number.POSITIVE_INFINITY, machineBytes);
    const ceiling = Number.isFinite(bound) ? bound : undefined;
    return {
        limitBytes: ceiling,
        usedBytes,
        swapBytes: swapped,
        freeBytes: ceiling === undefined || usedBytes === undefined ? undefined : Math.max(0, ceiling - usedBytes),
        stalledPercent: pressure.memory?.full ?? 0,
        oomKills: memoryEvents["oom_kill"],
    };
};

export const readMemoryHeadroom = async (): Promise<MemoryHeadroom> => headroomFrom(await readCgroup(), totalmem());

const GIB = 1024 ** 3;

// Free bytes a turn needs to start unasked; unattended turns need double, losing ties to interactive ones.
const TURN_RESERVE_BYTES = GIB;
const UNATTENDED_RESERVE_BYTES = 2 * GIB;

// Held off free memory for each turn admitted within FRESH_TURN_MS: a runtime and its MCP servers, about a quarter GiB
// each here, before the cgroup reading shows them. What a burst of spawns would otherwise all pass on one reading.
const FRESH_TURN_BYTES = 512 * 1024 ** 2;
const FRESH_TURN_MS = 90_000;

// Percent of full avg10 PSI at which a box counts as grinding, regardless of freeBytes.
const STALL_PERCENT = 20;

const gib = (bytes: number): string => `${(bytes / GIB).toFixed(1)} GiB`;

// The reading a hold was decided on, so a client can offer to raise the cap. Absent on a stall: PSI says the box is
// grinding, not that its ceiling is the thing to move.
export interface ShortMemory {
    readonly limitBytes: number;
    readonly residentBytes: number;
    readonly swapBytes: number;
}

// What is short about a box, in words and as the reading behind them; undefined when it has the reserve free.
interface Shortfall {
    readonly diagnosis: string;
    readonly memory?: ShortMemory;
}

// An unknown ceiling has no opinion: only a measured box can come up short. `heldBytes` is already off `freeBytes`.
const shortfallOf = (headroom: MemoryHeadroom, reserveBytes: number, heldBytes = 0): Shortfall | undefined => {
    const { freeBytes, limitBytes, usedBytes, swapBytes } = headroom;
    if (freeBytes === undefined || limitBytes === undefined || usedBytes === undefined) {
        return undefined;
    }
    // Inside the measured branch: at the root cgroup, PSI belongs to the whole machine, not this sandbox.
    if (headroom.stalledPercent >= STALL_PERCENT) {
        return {
            diagnosis: `The sandbox is short of memory: for ${Math.round(headroom.stalledPercent)}% of the last ten seconds, everything in it was waiting on memory`,
        };
    }
    if (freeBytes >= reserveBytes) {
        return undefined;
    }
    // Resident and swapped are named apart once paging starts: the cap bounds resident pages only, so their sum can
    // exceed it, and "19.2 GiB of 16.0 GiB used" reads as a bug.
    const used =
        swapBytes > 0
            ? `${gib(usedBytes - swapBytes)} resident + ${gib(swapBytes)} swapped, against ${gib(limitBytes)}`
            : `${gib(usedBytes)} of ${gib(limitBytes)} used`;
    // Named, or a box reading 3 GiB free would seem to refuse a turn that needs 2.
    const held = heldBytes > 0 ? `, and ${gib(heldBytes)} held for agents that just started` : "";
    return {
        diagnosis: `Sandbox memory is low: ${used}${held}`,
        memory: { limitBytes, residentBytes: usedBytes - swapBytes, swapBytes },
    };
};

// The reading with `heldBytes` taken off what is free.
const lessHeld = (headroom: MemoryHeadroom, heldBytes: number): MemoryHeadroom =>
    headroom.freeBytes === undefined || heldBytes === 0 ? headroom : { ...headroom, freeBytes: Math.max(0, headroom.freeBytes - heldBytes) };

export type TurnAdmission = { readonly admit: true } | { readonly admit: false; readonly message: string; readonly memory?: ShortMemory };

// What the person deciding whether to go ahead is risking; the sentence states the stakes and leaves the choice to them.
const STAKES = "Starting another agent now can slow the running ones down, and if memory runs out, the system kills processes to free it.";

// The box's own verdict for one audience, pure so the policy is testable without a cgroup. Whether a person is asked
// at all is MemoryWarnings' call, not this one's.
export const admitTurn = (headroom: MemoryHeadroom, unattended: boolean = false, heldBytes = 0): TurnAdmission => {
    const short = shortfallOf(lessHeld(headroom, heldBytes), unattended ? UNATTENDED_RESERVE_BYTES : TURN_RESERVE_BYTES, heldBytes);
    if (short === undefined) {
        return { admit: true };
    }
    return {
        admit: false,
        message: unattended
            ? `${short.diagnosis}. This background turn did not start: turns people send get the room first.`
            : `${short.diagnosis}. ${STAKES}`,
        ...(short.memory === undefined ? {} : { memory: short.memory }),
    };
};

// Holds queued work until the box has room instead of refusing it outright; on an exhausted deadline it runs anyway.
// `read` is injectable for testing without a cgroup.
export interface HeadroomWait {
    readonly admitted: boolean;
    readonly waitedMs: number;
    // What was still short at the deadline, for the log line when the run starts anyway.
    readonly message?: string;
}

const WAIT_INTERVAL_MS = 5_000;
const WAIT_DEADLINE_MS = 5 * 60_000;

export interface HeadroomWaitOptions {
    readonly signal?: AbortSignal;
    readonly intervalMs?: number;
    readonly deadlineMs?: number;
    // Told once, on the first reading that comes up short, with what is short.
    readonly onShort?: (diagnosis: string) => void;
}

// Polls `judge` until it finds nothing short, the deadline passes or the signal fires; whatever `judge` admits, it claims.
const pollForRoom = async (
    judge: () => Promise<Shortfall | undefined>,
    { signal, intervalMs = WAIT_INTERVAL_MS, deadlineMs = WAIT_DEADLINE_MS, onShort }: HeadroomWaitOptions,
): Promise<HeadroomWait> => {
    const startedAt = Date.now();
    let short = await judge();
    if (short === undefined) {
        // First reading admits without touching the interval.
        return { admitted: true, waitedMs: 0 };
    }
    onShort?.(short.diagnosis);
    // oxlint-disable-next-line no-unmodified-loop-condition -- AbortController changes signal.aborted.
    while (short !== undefined && Date.now() - startedAt < deadlineMs && signal?.aborted !== true) {
        await sleep(intervalMs, { signal });
        short = await judge();
    }
    const waitedMs = Date.now() - startedAt;
    return short === undefined ? { admitted: true, waitedMs } : { admitted: false, waitedMs, message: short.diagnosis };
};

// Held to the unattended reserve: queued work loses ties to whoever is typing.
export const waitForMemoryHeadroom = async (
    options: HeadroomWaitOptions & { readonly read?: () => Promise<MemoryHeadroom> } = {},
): Promise<HeadroomWait> => {
    const { read = readMemoryHeadroom } = options;
    return pollForRoom(async () => shortfallOf(await read(), UNATTENDED_RESERVE_BYTES), options);
};

// A person's turn on a short box is held once per spell, so they can decide, and admitted from then on, because the
// decision is theirs. The spell ends at the first reading with room for a person's turn. Every admission holds its share
// off free memory for other conversations while it grows into it. Held in memory only: a restart is a fresh spell.
export interface MemoryWarnings {
    readonly admit: (
        headroom: MemoryHeadroom,
        turn: { readonly unattended: boolean; readonly actor: string | undefined; readonly conversationId: string | undefined },
    ) => TurnAdmission;
    // Parks until an unattended turn on this conversation would be admitted, claiming its share the moment it would, so
    // two waiters never pass on one reading.
    readonly waitForRoom: (
        conversationId: string,
        options: HeadroomWaitOptions & { readonly read: () => Promise<MemoryHeadroom> },
    ) => Promise<HeadroomWait>;
}

export const createMemoryWarnings = (now: () => number = Date.now): MemoryWarnings => {
    // Who has been told this spell, by actor; "" is a caller the daemon could not name.
    const warned = new Set<string>();
    // When each conversation last claimed its share; a claim ages out after FRESH_TURN_MS.
    const claims = new Map<string, number>();
    // What every other conversation's fresh claim holds off free memory.
    const heldFor = (conversationId: string | undefined): number => {
        const at = now();
        let held = 0;
        for (const [id, claimedAt] of claims) {
            if (at - claimedAt >= FRESH_TURN_MS) {
                claims.delete(id);
            } else if (id !== conversationId) {
                held += FRESH_TURN_BYTES;
            }
        }
        return held;
    };
    const claim = (conversationId: string | undefined): void => {
        if (conversationId !== undefined) {
            claims.set(conversationId, now());
        }
    };
    return {
        admit: (headroom, { unattended, actor, conversationId }) => {
            const held = heldFor(conversationId);
            const person = admitTurn(headroom, false, held);
            if (person.admit) {
                warned.clear();
            }
            // Nobody is there to be told, so background work is refused on every short reading, and never warns anyone.
            if (unattended) {
                const verdict = admitTurn(headroom, true, held);
                if (verdict.admit) {
                    claim(conversationId);
                }
                return verdict;
            }
            // Keyed by person: one member's choice to go ahead does not answer for another who has not been told.
            const who = actor ?? "";
            if (person.admit || warned.has(who)) {
                claim(conversationId);
                return { admit: true };
            }
            warned.add(who);
            return person;
        },
        waitForRoom: (conversationId, options) =>
            pollForRoom(async () => {
                const reading = await options.read();
                // No await between the verdict and the claim: the next waiter's verdict already counts this one.
                const held = heldFor(conversationId);
                const short = shortfallOf(lessHeld(reading, held), UNATTENDED_RESERVE_BYTES, held);
                if (short === undefined) {
                    claim(conversationId);
                }
                return short;
            }, options),
    };
};
