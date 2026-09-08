// Per-caller rate window, the per-minute half of a public door's limits (daily-budget.ts is the day half). In-memory
// per daemon: a restart forgetting the last minute costs less than a counter file written per request.

export interface RateWindow {
    // Counts one arrival against `key`; true means refused (not counted), false means admitted and counted.
    // Check-and-count in one call so two same-tick arrivals can't both slip under the limit.
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
