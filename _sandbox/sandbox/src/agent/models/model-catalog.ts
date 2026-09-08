import type { JsonFile } from "../../store/json-file.js";

// Shared 3-rung catalog ladder for every provider's model picker: the live source, the persisted last-known-good list,
// and the compile-time seed floor — always non-empty. Only a live answer is cached, so a read that fell back to the
// file or the seed retries the live source next time. Stored as a `jsonFile`, written atomically and read through the
// caller's schema.
export interface DiscoveredCatalogOptions<Item, Stored, Value, Args extends unknown[]> {
    readonly ttlMs: number;
    // Live source; empty means nothing usable now, so nothing is cached and the next read asks again.
    readonly discover: (...args: Args) => Promise<readonly Item[]>;
    // The id a row is known by, for the grace window below; the same id a pin names.
    readonly idOf: (item: Item) => string;
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
    // Live items behind the current answer, warmed through the same path a picker uses so the two can't disagree.
    // Undefined when only the file/seed is in hand; the last live list if a re-discovery just came back empty.
    readonly live: (...args: Args) => Promise<readonly Item[] | undefined>;
    // Persist items proved some other way (a turn's self-heal) as the last-known-good, and cache them.
    readonly record: (items: readonly Item[]) => Promise<void>;
    // Forgets the cached answer, for a provider whose account can disconnect while the daemon runs; the file remains
    // the caller's to remove. Without this, a signed-out account's models would keep serving until the TTL expired.
    readonly forget: () => void;
}

// How long a row the live source has stopped listing is still served. A provider that drops a model it served minutes
// ago is out of capacity or quota for it far more often than it has retired it: Google's channel de-lists a model for
// exactly as long as it will not serve it. Serving the shrunk list instead moves every chat pinned to that model onto
// the catalog's default and files the shrunk list as last-known-good, so the pin is held here and the provider is left
// to answer for its own model. Long enough to ride out a capacity dip, short enough that a genuinely retired id is
// gone within the hour.
export const ABSENT_FOR_MS = 30 * 60_000;

export const discoveredCatalog = <Item, Stored, Value, Args extends unknown[] = []>(
    options: DiscoveredCatalogOptions<Item, Stored, Value, Args>,
): DiscoveredCatalog<Item, Value, Args> => {
    let cache: { readonly items: readonly Item[]; readonly value: Value; readonly expiresAt: number } | undefined;

    // Every id this source has published, as it last published it; the grace window is measured off `at`.
    const published = new Map<string, { readonly item: Item; readonly at: number }>();

    // Stamps what the source just published and hands back that list plus any row still inside the grace window that
    // this answer has dropped. Graced rows go last, so one can never outrank a row the source still serves.
    const graced = (items: readonly Item[], now: number): readonly Item[] => {
        for (const item of items) {
            published.set(options.idOf(item), { item, at: now });
        }
        const live = new Set(items.map(options.idOf));
        const kept: Item[] = [];
        for (const [id, held] of published) {
            if (now - held.at > ABSENT_FOR_MS) {
                published.delete(id);
                continue;
            }
            if (!live.has(id)) {
                kept.push(held.item);
            }
        }
        return kept.length === 0 ? items : [...items, ...kept];
    };

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
        // Persisted as served, graced rows included: the file is what a restart opens on, and dropping them there would
        // undo the window on the next boot.
        const served = graced(items, Date.now());
        await persist(served);
        return adopt(served);
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
        // Replaces the list rather than adding to it, so a proved set is the whole answer; the ids are stamped as
        // published all the same, so a discovery that omits one next is graced like any other drop.
        record: async (items) => {
            const now = Date.now();
            for (const item of items) {
                published.set(options.idOf(item), { item, at: now });
            }
            await persist(items);
            adopt(items);
        },
        forget: () => {
            cache = undefined;
        },
    };
};
