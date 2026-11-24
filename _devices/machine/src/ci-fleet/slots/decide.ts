import type { SlotsConfig } from "./slots-config.js";

/* WHAT THE SLOT HOLDER DECIDES, pure over its inputs: how many of CI's test-memory slots this host keeps from CI, which
   ones, and when a smaller need is believed. The round (slots.ts) only measures, holds and reports. */

// One slot is one GiB, as test-memory-pool.mjs counts it.
export const SLOT_BYTES = 1024 ** 3;
// How long the need must stay lower before slots go back to CI: a sandbox that idles for a moment between two builds
// would otherwise hand its memory to a job and want it back seconds later.
export const SHRINK_AFTER_MS = 120_000;

// Slots kept from CI whatever the sandboxes use: what `usable` leaves of the pool (z440: 16 − 9 = 7).
export const floorOf = (config: SlotsConfig): number => (config.usable === undefined ? 0 : Math.max(0, config.total - config.usable));

// The most the holder may keep: never one of the gate band 1..reserved, which only the gating verify jobs may draw on.
export const ceilingOf = (config: SlotsConfig): number => Math.max(0, config.total - config.reserved);

// How many slots the sandboxes' memory and the floor come to, whole GiBs rounded up.
export const targetOf = (config: SlotsConfig, sandboxBytes: number): number =>
    Math.min(ceilingOf(config), floorOf(config) + Math.ceil(Math.max(0, sandboxBytes) / SLOT_BYTES));

// How many slots the holder wants now. `lowerSince` is when the target first fell below `wanted`, and `lowerPeak` the
// highest it has been since: after SHRINK_AFTER_MS of a lower target the holder shrinks to that peak, never below what
// the window still asked for.
export interface Hysteresis {
    readonly wanted: number;
    readonly lowerSince?: number;
    readonly lowerPeak?: number;
}

export const nextWanted = (before: Hysteresis, target: number, now: number): Hysteresis => {
    if (target >= before.wanted) {
        return { wanted: target };
    }
    if (before.lowerSince === undefined) {
        return { wanted: before.wanted, lowerSince: now, lowerPeak: target };
    }
    const peak = Math.max(before.lowerPeak ?? target, target);
    if (now - before.lowerSince >= SHRINK_AFTER_MS) {
        return { wanted: peak };
    }
    return { wanted: before.wanted, lowerSince: before.lowerSince, lowerPeak: peak };
};

// The slots `wanted` names, from the top of the pool down: the end CI's own runs reach last, since a non-gate run tries
// reserved+1 upward. Capped at the ceiling, so the gate band is never among them.
export const wantedSlots = (config: SlotsConfig, wanted: number): number[] => {
    const count = Math.max(0, Math.min(wanted, ceilingOf(config)));
    return Array.from({ length: count }, (_, index) => config.total - index);
};

export interface SlotPlan {
    // Slots to take, top down. One that CI holds now fails to take and is tried again next look.
    readonly take: number[];
    // Slots to hand back, lowest first.
    readonly release: number[];
}

export const planSlots = (held: ReadonlySet<number>, wanted: readonly number[]): SlotPlan => ({
    take: wanted.filter((slot) => !held.has(slot)).toSorted((a, b) => b - a),
    release: [...held].filter((slot) => !wanted.includes(slot)).toSorted((a, b) => a - b),
});
