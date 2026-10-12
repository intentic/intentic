import { z } from "zod";

// WHAT `ic sandbox swaps --json` ANSWERS, one row per sandbox whose channel record names a swap in flight or on
// probation. `ic` is the one reader of its own swap records: `cutoverInProgress` is its verdict (a live ic run's
// heartbeat, `swap_alive`, is fresh), and every other process asks for it here instead of judging the record again. The
// command reads ic's home and not Docker, so it answers while Docker is down. golden/swap-verdicts.json holds each
// record's row, and ic's Rust test and the machine agent's tests both read it.

// Read loosely: a `phase` a newer ic adds is still a swap going on, and a field of an unexpected shape is a field that
// is not there. A row that lacks its identity or its verdict is no row at all (the caller falls back to the records).
export const DeviceSwapSchema = z.looseObject({
    slug: z.string().min(1),
    // ic's word: `cutover` (the old container is parked, the new one not yet proven) or `probation` (it is being watched).
    phase: z.string().min(1),
    // When the cutover began, epoch milliseconds.
    at: z.number().int().nonnegative(),
    // The last heartbeat of the ic run doing the cutover.
    alive: z.number().int().nonnegative().optional().catch(undefined),
    // When a probation ends and the parked container is let go.
    probationUntil: z.number().int().nonnegative().optional().catch(undefined),
    // ic's verdict at the moment it answered: this cutover is being done right now by a live ic run.
    cutoverInProgress: z.boolean(),
});
export type DeviceSwap = z.infer<typeof DeviceSwapSchema>;

export const DeviceSwapsSchema = z.array(DeviceSwapSchema);
