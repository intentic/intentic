import { join } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import { type Rounds, startRounds } from "../../device/sandbox-rounds/ic-rounds.js";
import type { FleetContext } from "../context.js";
import type { FleetStatus } from "../protocol.js";
import { lockedSlots } from "./ci-locks.js";
import { floorOf, type Hysteresis, nextWanted, planSlots, SLOT_BYTES, targetOf, wantedSlots } from "./decide.js";
import { measureSandboxBytes } from "./sandbox-memory.js";
import { ensureSlotFile, type SlotLock, type TakeLock, takeLock } from "./slot-lock.js";

/* THE SLOT HOLDER: this host's one holder in CI's own test-memory pool. Every look it measures what the Intentic
   sandboxes on this engine use and holds that many one-GiB slots on top of the host's floor, from the top of the pool
   down, so the CI jobs sharing this memory size their workers around the sandboxes instead of into them. It grows at
   once and shrinks only after the need has stayed lower for a while (decide.ts), and never takes a slot of the gate
   band. Its children hold the locks and die with it. What it sees goes to the status as `slots`. */

const SLOTS_LOOK_MS = 15_000;
const FIRST_LOOK_MS = 1_000;

export interface SlotHolder {
    // One look: measure, take and hand back, report. A round runs these one at a time.
    readonly look: () => Promise<void>;
    // The slots held now, highest first.
    readonly held: () => number[];
    readonly pidOf: (slot: number) => number | undefined;
    // Hands every slot back and takes no more; resolves once every child is gone.
    readonly stop: () => Promise<void>;
}

interface HolderState {
    readonly locks: Map<number, SlotLock>;
    hysteresis: Hysteresis;
    sandboxBytes: number;
    dockerFailing: boolean;
    stopped: boolean;
    said: string;
}

const slotPath = (context: FleetContext, slot: number): string => join(context.config.slots.dir, `slot-${slot}`);

// Children that died took their locks with them: forgotten, so the plan takes those slots again.
const forgetDead = (context: FleetContext, state: HolderState): void => {
    for (const [slot, lock] of state.locks) {
        if (!lock.alive()) {
            state.locks.delete(slot);
            context.log(`ci-fleet slots: the holder of slot ${slot} died; taking it again`);
        }
    }
};

// The sandboxes' memory, or what it was last time when Docker does not answer, said once until it answers again.
const measure = async (context: FleetContext, state: HolderState): Promise<boolean> => {
    try {
        state.sandboxBytes = await measureSandboxBytes(context.sys);
        if (state.dockerFailing) {
            context.log("ci-fleet slots: docker answers again");
        }
        state.dockerFailing = false;
        return true;
    } catch (error) {
        if (!state.dockerFailing) {
            context.log(`ci-fleet slots: could not measure the sandboxes, holding what is held — ${errorMessage(error)}`);
        }
        state.dockerFailing = true;
        return false;
    }
};

const take = async (context: FleetContext, state: HolderState, takeOne: TakeLock, slot: number): Promise<void> => {
    await ensureSlotFile(context.config.slots.dir, slotPath(context, slot));
    const lock = await takeOne(slotPath(context, slot));
    if (lock === undefined) {
        return;
    }
    if (state.stopped) {
        await lock.release();
        return;
    }
    state.locks.set(slot, lock);
};

const apply = async (context: FleetContext, state: HolderState, takeOne: TakeLock): Promise<void> => {
    const plan = planSlots(new Set(state.locks.keys()), wantedSlots(context.config.slots, state.hysteresis.wanted));
    for (const slot of plan.release) {
        const lock = state.locks.get(slot);
        state.locks.delete(slot);
        // in order, lowest first
        await lock?.release();
    }
    for (const slot of plan.take) {
        // top down, one child at a time
        await take(context, state, takeOne, slot);
    }
};

const held = (state: HolderState): number[] => [...state.locks.keys()].toSorted((a, b) => b - a);

const report = async (context: FleetContext, state: HolderState): Promise<void> => {
    const { dir, total, reserved } = context.config.slots;
    const mine = new Set(state.locks.keys());
    const heldByCi = [...(await lockedSlots(context.sys, dir, total))].filter((slot) => !mine.has(slot)).length;
    const slots: NonNullable<FleetStatus["slots"]> = {
        dir,
        total,
        reserved,
        floor: floorOf(context.config.slots),
        heldForSandboxes: mine.size,
        sandboxBytes: state.sandboxBytes,
        heldByCi,
        free: Math.max(0, total - mine.size - heldByCi),
        at: new Date(context.sys.now()).toISOString(),
    };
    await context.status.update({ slots });
};

// A line when what is held changes, not every look.
const sayHeld = (context: FleetContext, state: HolderState): void => {
    const now = held(state);
    const said = `holding ${now.length} (${now.length === 0 ? "none" : `slot ${now.at(-1)}..${now[0]}`}) for ${(state.sandboxBytes / SLOT_BYTES).toFixed(1)} GiB of sandboxes, ${state.hysteresis.wanted} wanted`;
    if (now.join(",") !== state.said) {
        state.said = now.join(",");
        context.log(`ci-fleet slots: ${said}`);
    }
};

export const createSlotHolder = (context: FleetContext, takeOne: TakeLock = takeLock): SlotHolder => {
    const state: HolderState = { locks: new Map(), hysteresis: { wanted: 0 }, sandboxBytes: 0, dockerFailing: false, stopped: false, said: "" };
    return {
        look: async () => {
            if (state.stopped) {
                return;
            }
            forgetDead(context, state);
            if (await measure(context, state)) {
                state.hysteresis = nextWanted(state.hysteresis, targetOf(context.config.slots, state.sandboxBytes), context.sys.now());
            }
            await apply(context, state, takeOne);
            sayHeld(context, state);
            await report(context, state);
        },
        held: () => held(state),
        pidOf: (slot) => state.locks.get(slot)?.pid,
        stop: async () => {
            state.stopped = true;
            const locks = [...state.locks.values()];
            state.locks.clear();
            await Promise.all(locks.map(async (lock) => await lock.release()));
        },
    };
};

// The round: a look every SLOTS_LOOK_MS, and on stop every slot handed back, so no slot outlives the service.
export const startSlots = (context: FleetContext, takeOne: TakeLock = takeLock): Rounds => {
    if (!context.config.slots.enabled) {
        return { stop: () => undefined, running: () => false };
    }
    const holder = createSlotHolder(context, takeOne);
    const rounds = startRounds("ci-fleet slots", context.log, FIRST_LOOK_MS, () => SLOTS_LOOK_MS, holder.look);
    return {
        stop: () => {
            rounds.stop();
            holder.stop().catch((error: Error) => context.log(`ci-fleet slots: could not hand every slot back — ${errorMessage(error)}`));
        },
        running: rounds.running,
    };
};
