import { t } from "@intentic/ui/i18n";
import { formatAge, formatRemaining, formatReset, type PlanHeadroom, type PlanLimitPool } from "./usageStatus";

// The words a plan-limit reading is read out in, beside its meters: when each pool moves, and the whole reading as one
// sentence for a screen reader.

// The line under a pool saying when it moves: its reset, or, for a pool whose window closed since it was read, that it
// reset then and has not been read since. Undefined when the plan publishes neither.
// A pool the provider stopped reporting says so first: its figure is the last one given, not a reading.
export const poolResetNote = (pool: Pick<PlanLimitPool, `resetsAt` | `lapsedAt` | `missingSince`>): string | undefined => {
    if (pool.missingSince !== undefined) {
        return t(`common.usageRing.missing`, { since: formatReset(pool.missingSince) });
    }
    if (pool.lapsedAt !== undefined) {
        return t(`common.usageRing.lapsed`, { resetsAt: formatReset(pool.lapsedAt) });
    }
    return pool.resetsAt === undefined ? undefined : t(`common.usageRing.resets`, { resetsAt: formatReset(pool.resetsAt) });
};

// Same breakdown as one sentence: the ring's accessible name, since a screen reader has no hover to reach the
// card. Lists every pool (a single number can't say which is binding), reset in parens.
export const usageDetail = (headroom: PlanHeadroom): string =>
    [
        ...headroom.pools.map(
            (pool) => {
                const note = poolResetNote(pool);
                return `${pool.label} ${formatRemaining(pool.percent, headroom.stale)}${note === undefined ? `` : ` (${note})`}`;
            },
        ),
        ...(headroom.uncovered.length > 0 ? [t(`common.usageRing.uncovered`, { models: headroom.uncovered.join(`, `) })] : []),
        ...(headroom.contradicted === undefined ? [] : [t(`common.usageRing.contradicted`, { model: headroom.contradicted })]),
        t(`chat.usageStatus.measured`, { age: formatAge(headroom.measuredAt) }),
    ].join(` · `);
