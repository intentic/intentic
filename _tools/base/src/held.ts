// A READING HELD BETWEEN ASKS STATES TWO THINGS: the change feed that says when it went stale, and how old it may grow
// when that feed misses something. The feed is how it stays cheap; the bound is how late a missed change may show. A
// cache with only the first serves a missed event's answer forever, and one with only the second is a timer guessing.

/** One reading's freshness: fresh until the feed reports a change, or `maxAgeMs` pass since it was taken. */
export interface Freshness {
    /** Whether the last reading still stands: taken, no change reported since, and not older than the bound. */
    readonly fresh: () => boolean;
    /** A reading was just taken. */
    readonly taken: () => void;
    /** The feed reported a change: the next ask reads again. */
    readonly changed: () => void;
}

export interface FeedBound {
    /** How long a reading stands when the feed says nothing about it. */
    readonly maxAgeMs: number;
    readonly now?: () => number;
}

export const freshness = ({ maxAgeMs, now = Date.now }: FeedBound): Freshness => {
    let at: number | undefined;
    return {
        fresh: () => at !== undefined && now() - at <= maxAgeMs,
        taken: () => {
            at = now();
        },
        changed: () => {
            at = undefined;
        },
    };
};

/** Readings by key, each held until the feed names its key (or reports an unnamed change) or the bound passes. */
export interface Held<K, V> {
    /** The held reading for `key`, or `read()`'s, held from now. */
    readonly get: (key: K, read: () => V) => V;
    /** The feed named `key`. */
    readonly drop: (key: K) => void;
    /** An unnamed change: nothing held can be trusted. */
    readonly clear: () => void;
    readonly size: () => number;
}

export const held = <K, V>({ maxAgeMs, now = Date.now }: FeedBound): Held<K, V> => {
    const readings = new Map<K, { readonly at: number; readonly value: V }>();
    let swept = now();
    // A key never asked for again (a folder that vanished, a rule file rewritten) would otherwise sit here for good.
    const sweep = (at: number): void => {
        if (at - swept <= maxAgeMs) {
            return;
        }
        swept = at;
        for (const [key, reading] of readings) {
            if (at - reading.at > maxAgeMs) {
                readings.delete(key);
            }
        }
    };
    return {
        get: (key, read) => {
            const at = now();
            sweep(at);
            const kept = readings.get(key);
            if (kept !== undefined && at - kept.at <= maxAgeMs) {
                return kept.value;
            }
            const value = read();
            readings.set(key, { at, value });
            return value;
        },
        drop: (key) => {
            readings.delete(key);
            sweep(now());
        },
        clear: () => {
            readings.clear();
        },
        size: () => readings.size,
    };
};
