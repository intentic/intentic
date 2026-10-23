// Per-caller rate window, the per-minute half of a public door's limits (daily-budget.ts is the day half). In-memory
// per daemon: a restart forgetting the last minute costs less than a counter file written per request.

// Caller ids can be chosen by a stranger. Bound their total state, not only the timestamps under each id: without this
// ceiling, a public route that rotates ids can grow the daemon until it runs out of memory.
const MAX_KEYS_DEFAULT = 10_000;

export interface RateWindow {
    // Counts one arrival against `key`; true means refused (not counted), false means admitted and counted.
    // Check-and-count in one call so two same-tick arrivals can't both slip under the limit.
    readonly limited: (key: string, max: number, now: number) => boolean;
    // Live caller entries, including expired ones awaiting the next sweep; tests read the bound directly.
    readonly size: () => number;
}

export const rateWindow = (windowMs: number, maxKeys = MAX_KEYS_DEFAULT): RateWindow => {
    // Map order is least-recently-used first. Existing keys are deleted before being reinserted to refresh their place.
    const hits = new Map<string, number[]>();
    let nextSweepAt = 0;
    const sweep = (now: number): void => {
        for (const [key, times] of hits) {
            const recent = times.filter((at) => at > now - windowMs);
            if (recent.length === 0) {
                hits.delete(key);
            } else if (recent.length !== times.length) {
                hits.set(key, recent);
            }
        }
        nextSweepAt = now + windowMs;
    };
    return {
        size: () => hits.size,
        limited: (key, max, now) => {
            // A full sweep is amortized over a window. The hard ceiling still applies between sweeps, so expired ids
            // may be evicted early, but a burst of fresh ids can never grow the map without bound.
            if (now >= nextSweepAt) {
                sweep(now);
            }
            const existing = hits.has(key);
            const recent = (hits.get(key) ?? []).filter((at) => at > now - windowMs);
            hits.delete(key);
            if (!existing && hits.size >= maxKeys) {
                const oldest = hits.keys().next().value;
                if (oldest !== undefined) {
                    hits.delete(oldest);
                }
            }
            if (recent.length >= max) {
                hits.set(key, recent);
                return true;
            }
            recent.push(now);
            hits.set(key, recent);
            return false;
        },
    };
};
