/* A FIXED RATE WINDOW PER CALLER, the per-minute half of what every public door needs (the daily ceiling,
 * store/daily-budget.ts, is the other half: a rate bounds the minute, a budget bounds the day, and a door with
 * only one of them is open along the other axis).
 *
 * In memory, per daemon, like the budget and for the same reason: its job is to slow a runaway caller down, and
 * a restart forgetting the last minute is a smaller problem than a counter file written on every request.
 * ponytail: swap for a shared store only if the sandbox ever runs multi-process. */

export interface RateWindow {
    /* Count one arrival against `key` and say whether it was over the line. True ⇒ refused and NOT counted;
     * false ⇒ admitted and counted. Check-and-count in one call, so two arrivals in the same tick cannot both
     * read "one short of the limit" and both pass. */
    readonly limited: (key: string, max: number, now: number) => boolean;
}

export const rateWindow = (windowMs: number): RateWindow => {
    const hits = new Map<string, number[]>();
    return {
        limited: (key, max, now) => {
            const recent = (hits.get(key) ?? []).filter((at) => at > now - windowMs);
            hits.set(key, recent);
            if (recent.length >= max) {
                return true;
            }
            recent.push(now);
            return false;
        },
    };
};
