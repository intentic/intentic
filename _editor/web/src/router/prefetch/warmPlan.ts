// Collects wish lists from the surfaces that know their own data (board, review, rail) into one plan;
// the loader itself knows none of it. A wish isn't a request: `have` answers from cache, so a satisfied
// wish costs nothing. Bands are the only priority mechanism — four named positions, not an arbitrary number.

// Where a wish sits relative to the user's screen; drained `now` first, then `near`, `work`, `rail`.
// Within a band, order follows registration, then each source's own return order (its render order).
export type WarmBand = "now" | "near" | "work" | "rail";

const BAND_ORDER: readonly WarmBand[] = [`now`, `near`, `work`, `rail`];

export interface WarmTask {
    // Dedupe key across sources; a stringified query key is already the app's cache identity.
    readonly key: string;
    readonly band: WarmBand;
    // True when already in hand, answered from the cache alone; no network touched.
    readonly have: () => boolean;
    // Resolves once in hand, rejects if it could not be; nothing here retries.
    readonly read: () => Promise<unknown>;
}

export type WarmSource = () => readonly WarmTask[];

// Ceiling on the whole plan, not per source; the tail past it is simply left cold.
export const PLAN_LIMIT = 400;

const sources = new Set<WarmSource>();

/**
 * Registers a wish list. Returns a disposer; an unmounted surface that skips calling it leaves its list
 * warming a screen nobody can reach.
 */
export const registerWarmSource = (source: WarmSource): (() => void) => {
    sources.add(source);
    return () => void sources.delete(source);
};

// Forgets every contributor; used by tests and the sandbox switch, so no source outlives the workspace it describes.
export const clearWarmSources = (): void => sources.clear();

// Assembled fresh every beat rather than cached behind reactivity: what's worth warming depends on live
// fetch and invalidation state no dependency graph covers, and sources are computed-backed, so re-asking is cheap.
export const warmPlan = (): readonly WarmTask[] => {
    const byKey = new Map<string, WarmTask>();
    for (const source of sources) {
        // A source that throws contributes nothing this beat; it must not stop the others.
        let wishes: readonly WarmTask[] = [];
        try {
            wishes = source();
        } catch {
            continue;
        }
        for (const wish of wishes) {
            // First declaration wins; sources walk in registration order, so the closer surface's claim sticks.
            if (!byKey.has(wish.key)) {
                byKey.set(wish.key, wish);
            }
        }
    }
    const plan = [...byKey.values()].sort((left, right) => BAND_ORDER.indexOf(left.band) - BAND_ORDER.indexOf(right.band));
    return plan.length > PLAN_LIMIT ? plan.slice(0, PLAN_LIMIT) : plan;
};
