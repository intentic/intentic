import { SPENT_UTILIZATION } from "@intentic/sandbox-contract/models/plan-pools";
import { sandboxNow } from "../../agent-status/sandboxClock";
import { type PlanLimitPool, poolPeriod } from "../usageStatus";
import { verdictNow } from "./verdictClock";

// PACE: where an even spend across the window would leave a pool by now, so a bar reads against the clock and not only
// against itself. "40% left" is plenty two days before a weekly reset and trouble six days before it; the bar alone
// can't say which. Drawn as a tick on the track at the share of the window still to run: a fill reaching past it is
// spending slower than the window allows, one falling short of it is spending ahead. Words come only when the rate so
// far would empty the pool before it resets, since that is the one case a reader must act on.
export interface PoolPace {
    // Percent of the allowance an even spend would have left now, on the meter's own scale (0 to 100, the fill's).
    readonly mark: number;
    // When the pool runs dry at the rate spent so far (epoch seconds), when that comes before it resets.
    readonly runsOutAt: number | undefined;
}

// Too early in a window for the rate to mean anything: one heavy first turn would project the whole week gone.
const PACE_SETTLES_AT = 0.05;

/** A pool's pace against its window, as of `now` (the sandbox's clock); undefined when there is no clock to read it
 * against (no reset or no length published), when the reading is not live (lapsed, no longer reported), when the pool
 * is spent (its reset is all that matters then), or so early in the window that the tick would sit on the bar's end. */
export const poolPace = (
    pool: Pick<PlanLimitPool, `kind` | `name` | `periodSeconds` | `percent` | `resetsAt` | `lapsedAt` | `missingSince`>,
    now: number = sandboxNow(verdictNow()),
): PoolPace | undefined => {
    const period = poolPeriod(pool);
    if (
        pool.resetsAt === undefined ||
        period === undefined ||
        pool.lapsedAt !== undefined ||
        pool.missingSince !== undefined ||
        pool.percent >= SPENT_UTILIZATION
    ) {
        return undefined;
    }
    const windowMs = period.seconds * 1000;
    const resetMs = pool.resetsAt * 1000;
    const elapsedMs = windowMs - (resetMs - now);
    // A reset further off than one window means the length was misread; past the reset, the reading has lapsed.
    if (elapsedMs < 0 || elapsedMs >= windowMs) {
        return undefined;
    }
    const share = elapsedMs / windowMs;
    if (share < PACE_SETTLES_AT / 2) {
        return undefined;
    }
    const used = Math.max(0, pool.percent);
    const emptyAt = share >= PACE_SETTLES_AT && used > 0 ? now + ((SPENT_UTILIZATION - used) * elapsedMs) / used : undefined;
    return { mark: 100 * (1 - share), runsOutAt: emptyAt !== undefined && emptyAt < resetMs ? Math.floor(emptyAt / 1000) : undefined };
};
