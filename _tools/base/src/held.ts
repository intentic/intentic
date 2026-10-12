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

/**
 * A Map that holds at most `limit` entries: setting one past it drops the oldest. A write re-inserts its key, so
 * "oldest" is the least recently written, never one just refreshed. For memory kept by a key the process cannot bound
 * itself (a challenge per request, a notice per conversation), where losing the oldest costs one repeat at worst.
 */
export class BoundedMap<K, V> extends Map<K, V> {
    // Not a constructor parameter property: Map's constructor runs before it is assigned, and nothing is set during it.
    readonly limit: number;

    constructor(limit: number) {
        super();
        this.limit = limit;
    }

    override set(key: K, value: V): this {
        super.delete(key);
        super.set(key, value);
        for (const oldest of this.keys()) {
            if (this.size <= this.limit) {
                break;
            }
            super.delete(oldest);
        }
        return this;
    }
}

export interface CachedAsyncOptions<V> {
    /** How long a loaded value is served before the next ask loads again. */
    readonly ttlMs: number;
    /** At most this many keys are held; the oldest loaded goes first. Unbounded otherwise, though expired keys are swept. */
    readonly maxEntries?: number;
    /**
     * Whether a loaded value is kept. One it refuses still answers the callers that shared its load, and the next ask
     * loads again: an answer that says "could not ask" (a timeout, an empty list from a network that did not answer)
     * must not stand for the whole window.
     */
    readonly keep?: (value: V) => boolean;
    readonly now?: () => number;
}

export interface CachedAsync<K, V> {
    /**
     * The held value for `key` while it stands, else the load already in flight for it, else `load()`'s, held from when
     * it lands. A load that rejects is handed to its callers and never held. `fresh` skips both, for a refresh someone
     * asked for, whose answer must postdate the asking.
     */
    readonly get: (key: K, load: () => Promise<V>, options?: { readonly fresh?: boolean }) => Promise<V>;
    /** The held value for `key` if it still stands, without loading. */
    readonly peek: (key: K) => V | undefined;
    /** Holds `value` for `key` from now, as a load that landed would. */
    readonly set: (key: K, value: V) => void;
    /** Forgets `key`, a load in flight for it included: what it lands with is handed to its callers, not held. */
    readonly drop: (key: K) => void;
    readonly clear: () => void;
    readonly size: () => number;
}

/**
 * The async sibling of `held`, for a reading that costs a round trip (a version probe, a registry fetch): concurrent
 * askers share the one load in flight, a failure is never held, and the time bound is the only staleness signal.
 */
export const cachedAsync = <K, V>({ ttlMs, maxEntries, keep = () => true, now = Date.now }: CachedAsyncOptions<V>): CachedAsync<K, V> => {
    const kept: Map<K, { readonly at: number; readonly value: V }> = maxEntries === undefined ? new Map() : new BoundedMap(maxEntries);
    const loading = new Map<K, Promise<V>>();
    let swept = now();
    // A key never asked for again would otherwise sit here for good.
    const sweep = (at: number): void => {
        if (at - swept <= ttlMs) {
            return;
        }
        swept = at;
        for (const [key, entry] of kept) {
            if (at - entry.at >= ttlMs) {
                kept.delete(key);
            }
        }
    };
    const standing = (key: K, at: number): { readonly value: V } | undefined => {
        const entry = kept.get(key);
        return entry !== undefined && at - entry.at < ttlMs ? entry : undefined;
    };
    const set = (key: K, value: V): void => {
        kept.set(key, { at: now(), value });
    };
    return {
        get: (key, load, options) => {
            const at = now();
            sweep(at);
            if (options?.fresh !== true) {
                const entry = standing(key, at);
                if (entry !== undefined) {
                    return Promise.resolve(entry.value);
                }
                const running = loading.get(key);
                if (running !== undefined) {
                    return running;
                }
            }
            // A load that throws before returning its promise is a rejection like any other.
            const started = Promise.resolve().then(load);
            loading.set(key, started);
            // Only its own entry: a drop, or a fresh load started since, has taken the key from it.
            const settled = (): boolean => {
                const own = loading.get(key) === started;
                if (own) {
                    loading.delete(key);
                }
                return own;
            };
            started.then((value) => {
                if (settled() && keep(value)) {
                    set(key, value);
                }
            }, settled);
            return started;
        },
        peek: (key) => standing(key, now())?.value,
        set,
        drop: (key) => {
            kept.delete(key);
            loading.delete(key);
        },
        clear: () => {
            kept.clear();
            loading.clear();
        },
        size: () => kept.size,
    };
};
