import type { TrashedSandbox } from "@intentic/api-contract";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days left on a deleted sandbox's recovery window, rounded UP: an hour to go still reads "1 day", never "0". */
export const daysLeft = (purgeAfter: string, now: number = Date.now()): number =>
    Math.max(0, Math.ceil((new Date(purgeAfter).getTime() - now) / DAY_MS));

/** What the Recently deleted page draws. */
type TrashState = `reading` | `error` | `empty` | `rows`;

/** Rows win over a failed re-read: what was read is still restorable, and the failure is said above it. */
export const trashState = (state: { readonly rows: number; readonly read: boolean; readonly readError: boolean }): TrashState => {
    if (state.rows > 0) {
        return `rows`;
    }
    if (state.readError) {
        return `error`;
    }
    return state.read ? `empty` : `reading`;
};

/** Where a deleted sandbox ran, which decides what a restore brings back: a hosted machine keeps its disk, an own one only its name. */
type TrashLane = `cloud` | `own`;

/**
 * The rows split by what a restore promises, so the promise is said once over each list rather than under every row.
 * Intentic's cloud first, the lane that comes back whole; each lane keeps the platform's order, newest deletion first.
 */
export const trashLanes = (rows: readonly TrashedSandbox[]): { readonly lane: TrashLane; readonly rows: readonly TrashedSandbox[] }[] =>
    ([`cloud`, `own`] as const)
        .map((lane) => ({ lane, rows: rows.filter((row) => row.hosted === (lane === `cloud`)) }))
        .filter((group) => group.rows.length > 0);
