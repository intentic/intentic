import type { PersistedClient } from "@tanstack/query-persist-client-core";
import { persistQueryClient } from "@tanstack/query-persist-client-core";
import { defaultShouldDehydrateQuery, QueryCache, QueryClient } from "@tanstack/vue-query";
import { del, get, set } from "idb-keyval";
import { buildId } from "../app/buildEpoch";
import { trackPerf } from "../app/perf";
import { throttleTrailing } from "./throttleTrailing";

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
let latestClient: PersistedClient | undefined;
const flushPersist = throttleTrailing(() => {
    if (latestClient === undefined) {
        return;
    }
    // Timed since this write scales with everything cached; `queries` shows if the mirror has grown too big.
    const client = latestClient;
    // A refused write (a full or disabled IndexedDB) costs only the next reload's instant paint.
    void trackPerf(`query.persist`, { queries: client.clientState.queries.length }, () => set(IDB_KEY, client)).catch(() => undefined);
}, PERSIST_WINDOW_MS);

// Called after auth resolves and before any route mounts, so hydration never races a fetch. `buster` combines the user
// id and buildId(), so a different account or a new build starts from a clean cache.
export const restorePersistedQueries = async (userId: string): Promise<void> => {
    if (uninstall !== undefined) {
        return;
    }
    const [unsubscribe, restored] = persistQueryClient({
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
        dehydrateOptions: { shouldDehydrateQuery: (query) => mirrors(query.queryKey) && defaultShouldDehydrateQuery(query) },
    });
    uninstall = unsubscribe;
    // The cache is only an optimization; a failed restore is empty and must never block the awaited navigation.
    await restored.catch(() => undefined);
};

// Logout / account deletion: stop persisting, drop memory and disk so the next login starts clean. A failed delete
// means IndexedDB never worked, so nothing was persisted; do not let it abort the sign-out.
export const clearPersistedQueries = async (): Promise<void> => {
    uninstall?.();
    uninstall = undefined;
    queryClient.clear();
    await del(IDB_KEY).catch(() => undefined);
};
