import type { JsonFile } from "../store/json-file.js";

/* THE PICKER'S CATALOG, ONCE. Five providers (Claude, Codex, Gemini, Cursor, Kimi) answer "what can a turn on
 * me run" through the same ladder, and each used to carry its own copy of it beside its own copy of the
 * persist-to-disk cycle, four of them with a different idea of how to validate the file:
 *
 *   1. the LIVE source, whatever the provider publishes for the connected account;
 *   2. the persisted last-known-good list, rewritten on every successful discovery;
 *   3. the compile-time seed floor.
 *
 * ALWAYS non-empty, so the picker is never blank and a turn always resolves a concrete model. ONLY REAL ANSWERS
 * ARE CACHED: a read that fell to the file or the floor stays uncached, so the very next read retries a source
 * that may since have come up (the translator finished booting, the user connected the account), which is the
 * difference between a sandbox that recovers a second after sign-in and one that shows one row for a minute.
 *
 * What differs per provider is exactly what the options name: how to discover, what to keep on disk (Claude
 * keeps whole records so a version that postdates the build survives a restart with its name; Codex and Cursor
 * keep ids, having nothing else), the floor, and how each rung renders. Cursor keeps its raw items too (`live`),
 * because a turn needs the vendor's parameter definitions to translate an effort tier and must not spend a
 * round-trip re-fetching a list already in memory. Codex records the ids a turn proved (`record`), its self-heal.
 *
 * The file is a `jsonFile`, so it is written atomically and read through the caller's schema: a truncated write
 * or a record from another build reads as absent rather than reaching the picker half-formed. */
export interface DiscoveredCatalogOptions<Item, Stored, Value, Args extends unknown[]> {
    readonly ttlMs: number;
    // The live source. Empty means nothing usable right now; nothing is cached and the next read asks again.
    readonly discover: (...args: Args) => Promise<readonly Item[]>;
    // The last-known-good file. Absent for a provider with nothing worth keeping across restarts.
    readonly store?: JsonFile<Stored[]> | undefined;
    readonly toStored: (items: readonly Item[]) => Stored[];
    readonly seed: readonly Stored[];
    readonly fromLive: (items: readonly Item[]) => Value;
    // Renders the persisted list, or the seed when nothing is persisted. Never called with an empty list.
    readonly fromStored: (stored: readonly Stored[]) => Value;
}

export interface DiscoveredCatalog<Item, Value, Args extends unknown[]> {
    // The catalog (+ default id), never empty.
    readonly models: (...args: Args) => Promise<Value>;
    /* The live items behind the current answer, warming the cache through the same path a picker would so the
     * two can never disagree about what is current. Undefined when only the file or the floor is in hand, and
     * the last live list when a re-discovery just came back empty. */
    readonly live: (...args: Args) => Promise<readonly Item[] | undefined>;
    // Persist items proved some other way (a turn's self-heal) as the last-known-good, and cache them.
    readonly record: (items: readonly Item[]) => Promise<void>;
}

export const discoveredCatalog = <Item, Stored, Value, Args extends unknown[] = []>(
    options: DiscoveredCatalogOptions<Item, Stored, Value, Args>,
): DiscoveredCatalog<Item, Value, Args> => {
    let cache: { readonly items: readonly Item[]; readonly value: Value; readonly expiresAt: number } | undefined;

    const adopt = (items: readonly Item[]): NonNullable<typeof cache> => {
        cache = { items, value: options.fromLive(items), expiresAt: Date.now() + options.ttlMs };
        return cache;
    };
    const persist = async (items: readonly Item[]): Promise<void> => {
        await options.store?.update(() => options.toStored(items));
    };
    // The cached answer while it is fresh, else a discovery, adopted and persisted when it says anything.
    const current = async (...args: Args): Promise<NonNullable<typeof cache> | undefined> => {
        if (cache !== undefined && Date.now() < cache.expiresAt) {
            return cache;
        }
        const items = await options.discover(...args);
        if (items.length === 0) {
            return undefined;
        }
        await persist(items);
        return adopt(items);
    };

    return {
        models: async (...args) => {
            const live = await current(...args);
            if (live !== undefined) {
                return live.value;
            }
            const stored = options.store === undefined ? [] : await options.store.read();
            return options.fromStored(stored.length > 0 ? stored : options.seed);
        },
        live: async (...args) => (await current(...args))?.items ?? cache?.items,
        record: async (items) => {
            await persist(items);
            adopt(items);
        },
    };
};
