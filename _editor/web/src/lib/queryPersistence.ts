import type { PersistedClient } from "@tanstack/query-persist-client-core";
import { persistQueryClientRestore, persistQueryClientSave } from "@tanstack/query-persist-client-core";
import { defaultShouldDehydrateQuery, QueryCache, QueryClient } from "@tanstack/vue-query";
import { del, get, set } from "idb-keyval";
import { buildId } from "../app/buildEpoch";
import { trackPerf } from "../app/perf";
import { throttleTrailing } from "./throttleTrailing";
import { whenIdle } from "./whenIdle";

// Persists the vue-query cache to IndexedDB so a reload paints the last-known workspace instantly, instead of blocking
// on the daemon tunnel. Hydrated data is distrusted when the stream says so rather than permanently: applyHello
// invalidates on every (re)connect. `sandbox.list` and auth state stay out of the persisted cache.

const IDB_KEY = `intentic-query-cache`;

// Marks a key whose value must stay only in memory, since the cache mirrors to disk as one whole clone.
// - small, shape-stable (rosters): mirror it too, cheap and worth the reload paint.
// - large, disposable (a file diff): memory only, bounded by gcTime.
// - large, worth keeping (a transcript): memory only here, persisted separately, one record at a time.
export const UNPERSISTED = `unpersisted`;

// Whether a key's value may reach disk: excludes `sandbox` (connect tokens) and any key marked UNPERSISTED (too large
// to mirror). Split out so the rule is directly assertable rather than buried in the persister.
export const mirrors = (queryKey: readonly unknown[]): boolean => queryKey[0] !== `sandbox` && !queryKey.includes(UNPERSISTED);

// The daemon's /events stream is what keeps a cached read true (systemEvents.ts invalidates per contract-bound key,
// and applyHello distrusts everything on a reconnect), so mounting a view again is not itself evidence that its reads
// went stale. At 0 it was: one session's rail round trips cost ten /capabilities reads, the worst 4.9s, and fourteen
// file-diffs. Long enough to cover leaving a view and coming back, short enough that an invalidation nobody sent
// heals on the next visit.
const NAVIGATION_STALE_MS = 30_000;

// Every read that finally failed is logged here, the one place all of them pass: a view that draws only `data` shows
// a failure as an empty list, and without this line nothing anywhere would say it happened.
export const queryClient = new QueryClient({
    queryCache: new QueryCache({ onError: (error, query) => console.warn(`query ${JSON.stringify(query.queryKey)} failed`, error) }),
    defaultOptions: { queries: { staleTime: NAVIGATION_STALE_MS } },
});

let uninstall: (() => void) | undefined;

// Every settle structured-clones and writes the whole cache; throttled to one write per window (latest wins). Dropped
// on tab close costs nothing, the cache is only a stale-while-revalidate paint.
const PERSIST_WINDOW_MS = 2000;
// One write in flight at a time, and only the newest cache after it. Writes that each started on their own piled up
// behind a frozen page's IndexedDB, and on wake-up all finished at once: 942 slow-write warnings in one second.
let latestClient: PersistedClient | undefined;
let persisting: Promise<void> | undefined;
// Bumped by clearPersistedQueries, so a write already queued for the account signing out stops there.
let generation = 0;
// The write is timed at most once a minute: enough to show the mirror has grown too big, without a warning per write.
const TIMED_EVERY_MS = 60_000;
let lastTimedAt = Number.NEGATIVE_INFINITY;

const write = async (client: PersistedClient): Promise<void> => {
    const now = Date.now();
    if (now - lastTimedAt < TIMED_EVERY_MS) {
        await set(IDB_KEY, client);
        return;
    }
    lastTimedAt = now;
    // Timed since this write scales with everything cached; `queries` shows if the mirror has grown too big.
    await trackPerf(`query.persist`, { queries: client.clientState.queries.length }, () => set(IDB_KEY, client));
};

const drainPersist = (): void => {
    if (persisting !== undefined || latestClient === undefined) {
        return;
    }
    const started = generation;
    persisting = (async () => {
        while (latestClient !== undefined) {
            if (started !== generation) {
                break;
            }
            const client = latestClient;
            latestClient = undefined;
            // A refused write (a full or disabled IndexedDB) costs only the next reload's instant paint.
            await write(client).catch(() => undefined);
        }
    })().finally(() => {
        persisting = undefined;
        // A cache that arrived after the loop's last look, while this write was still counted as in flight.
        if (started === generation) {
            drainPersist();
        }
    });
};
const flushPersist = throttleTrailing(drainPersist, PERSIST_WINDOW_MS);

// Called after auth resolves and before any route mounts, so hydration never races a fetch. `buster` combines the user
// id and buildId(), so a different account or a new build starts from a clean cache.
// The cache events a snapshot answers to, as the persistence library itself counts them: a query or mutation added,
// removed or updated, never one that only gained or lost an observer.
const CACHE_CHANGES = new Set([`added`, `removed`, `updated`]);

export const restorePersistedQueries = async (userId: string): Promise<void> => {
    if (uninstall !== undefined) {
        return;
    }
    const options = {
        queryClient,
        persister: {
            persistClient: (client: PersistedClient) => {
                latestClient = client;
                flushPersist();
            },
            restoreClient: () => get<PersistedClient>(IDB_KEY),
            removeClient: () => del(IDB_KEY),
        },
        buster: `${userId}:${buildId()}`,
        // A Monday-morning open after Friday still paints; anything older restores as empty.
        maxAge: 7 * 24 * 60 * 60 * 1000,
        // The storage rule (`mirrors`, above), composed with the default so non-success queries stay out too.
        dehydrateOptions: { shouldDehydrateQuery: (query: Parameters<typeof defaultShouldDehydrateQuery>[0]) => mirrors(query.queryKey) && defaultShouldDehydrateQuery(query) },
    };
    // THE SNAPSHOT IS TAKEN ONCE PER WINDOW, AT IDLE. The persistence library dehydrates the whole cache on every cache
    // event, before the write's throttle ever sees it: a reconnect's hello invalidates every query at once, and each of
    // the hundreds of events that follow walked every query again, on the main thread of a phone that was trying to draw
    // them. Here an event only marks the cache changed; one snapshot is taken when the window closes and the page is
    // idle, which also leaves the cache a restore just filled alone rather than writing it straight back.
    let stopped = false;
    let owed = false;
    const snapshot = (): void => {
        if (owed || stopped) {
            return;
        }
        owed = true;
        setTimeout(
            () =>
                whenIdle(() => {
                    owed = false;
                    if (!stopped) {
                        void persistQueryClientSave(options).catch(() => undefined);
                    }
                }),
            PERSIST_WINDOW_MS,
        );
    };
    // Filled once the restore lands and the cache is followed; a sign-out before then has nothing to unsubscribe.
    const following: (() => void)[] = [];
    uninstall = () => {
        stopped = true;
        for (const stop of following.splice(0)) {
            stop();
        }
    };
    // The cache is only an optimization; a failed restore is empty and must never block the awaited navigation.
    await persistQueryClientRestore(options).catch(() => undefined);
    if (stopped) {
        return;
    }
    const onChange = (event: { readonly type: string }): void => {
        if (CACHE_CHANGES.has(event.type)) {
            snapshot();
        }
    };
    following.push(queryClient.getQueryCache().subscribe(onChange), queryClient.getMutationCache().subscribe(onChange));
};

// Logout / account deletion: stop persisting, drop memory and disk so the next login starts clean. A failed delete
// means IndexedDB never worked, so nothing was persisted; do not let it abort the sign-out.
export const clearPersistedQueries = async (): Promise<void> => {
    uninstall?.();
    uninstall = undefined;
    generation += 1;
    latestClient = undefined;
    await persisting;
    queryClient.clear();
    await del(IDB_KEY).catch(() => undefined);
    // The boards' stored rosters (useAgents-registry.ts) belong to the account signing out as much as the cache does.
    try {
        for (const key of Object.keys(localStorage).filter((name) => name.startsWith(`intentic.roster.`))) {
            localStorage.removeItem(key);
        }
    } catch {
        // No storage, then nothing was stored.
    }
};
