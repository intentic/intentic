// Ceiling on a public, no-identity endpoint's day, counted in memory against the UTC day; a per-minute window bounds
// the rate, not the day, and every call is billed to the owner. Deliberately not persisted, a restart resetting it
// beats a counter file written per request; swap for a shared store only if this ever runs multi-process.

const dayOf = (now: number): number => Math.floor(now / 86_400_000);

export interface DailyBudget {
    // Spends one against `key`'s allowance; true means refused and nothing spent, false means admitted and counted.
    // Check-and-increment in one call, since a gap between read and write would leak the ceiling under concurrency.
    readonly spend: (key: string, max: number, now: number) => boolean;
}

export const dailyBudget = (): DailyBudget => {
    const counts = new Map<string, { day: number; count: number }>();
    return {
        spend: (key, max, now) => {
            const day = dayOf(now);
            const current = counts.get(key);
            const count = current !== undefined && current.day === day ? current.count : 0;
            if (count >= max) {
                return true;
            }
            counts.set(key, { day, count: count + 1 });
            return false;
        },
    };
};
