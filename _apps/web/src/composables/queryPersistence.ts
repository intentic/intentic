import type { PersistedClient } from "@tanstack/query-persist-client-core";
import { persistQueryClient } from "@tanstack/query-persist-client-core";
import { defaultShouldDehydrateQuery, QueryClient } from "@tanstack/vue-query";
import { del, get, set } from "idb-keyval";
import { trackPerf } from "./perf";
import { throttleTrailing } from "./throttleTrailing";

/* Persists the vue-query cache to IndexedDB so a reload paints the last-known workspace (tree, history,
 * panels, capabilities, environment) instantly instead of blocking on the daemon tunnel. Freshness is
 * untouched: staleTime stays 0, so hydrated data refetches the moment the SSE stream connects, and every
 * (re)connect already fires a full tree invalidate (useSandboxLiveness) — cached state is only ever a
 * stale-while-revalidate paint. The token-bearing sandbox.list now lives in the in-memory cache too (for
 * dedup + SWR), but is EXCLUDED from IndexedDB via dehydrateOptions below — its rows carry connect tokens.
 * Session/auth state stays ref-only (useAuth), never in vue-query. */

const IDB_KEY = `intentic-query-cache`;
// Bump when daemon response shapes change: a mismatched buster drops the old cache on restore.
const SCHEMA_VERSION = 1;

export const queryClient = new QueryClient();

let uninstall: (() => void) | undefined;

// The cache fires an event per query settle, and each persist call structured-clones + writes the ENTIRE
// dehydrated cache — with a busy workspace's Changes payload in it, an unthrottled persist meant a multi-MB
// IndexedDB write for every refetch in a refetch-per-second storm. Latest-wins through one throttle window:
// the first event writes immediately (a lone update persists instantly), the storm collapses to one write per
// window. A write the window drops on tab close loses nothing that matters — the cache is a stale-while-
// revalidate paint, refetched the moment the next session connects.
const PERSIST_WINDOW_MS = 2000;
let latestClient: PersistedClient | undefined;
const flushPersist = throttleTrailing(() => {
    if (latestClient === undefined) {
        return;
    }
    // Timed because this is the one background write big enough to be felt: idb-keyval structured-clones the
    // whole dehydrated cache on the MAIN THREAD before it ever reaches IndexedDB, so its cost scales with
    // everything the app has ever cached — a busy workspace's Changes payload and file tree included. If the
    // UI stutters every couple of seconds while nothing is obviously happening, this is the first row to look
    // at, and `queries` says whether the cache has simply grown too big to keep mirroring whole.
    const client = latestClient;
    void trackPerf(`query.persist`, { queries: client.clientState.queries.length }, () => set(IDB_KEY, client));
}, PERSIST_WINDOW_MS);

// Called from requireAuth AFTER the user resolves and BEFORE any route mounts, so hydration never races a
// fetch. buster = user id: a different account on the same browser busts the previous user's cache.
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
        buster: `${userId}:${SCHEMA_VERSION}`,
        // A Monday-morning open after Friday still paints; anything older restores as empty.
        maxAge: 7 * 24 * 60 * 60 * 1000,
        // sandbox.list carries per-sandbox connect tokens (the tunnel secret) — keep it out of IndexedDB.
        // Every daemon query (workspace/info/capabilities/… keys) and billing.plan still persist; only the
        // `sandbox`-prefixed list is excluded. Composed with the default so non-success queries stay out too.
        dehydrateOptions: {
            shouldDehydrateQuery: (query) => query.queryKey[0] !== `sandbox` && defaultShouldDehydrateQuery(query),
        },
    });
    uninstall = unsubscribe;
    // The cache is an optimization: a failed restore (IndexedDB unavailable/corrupt) degrades to an empty
    // cache and must never block the navigation awaiting it in requireAuth.
    await restored.catch(() => undefined);
};

// Logout / account deletion: stop persisting, drop memory + disk so the next login starts clean. A failed
// delete means IndexedDB never worked, so nothing was persisted — don't let it abort the sign-out.
export const clearPersistedQueries = async (): Promise<void> => {
    uninstall?.();
    uninstall = undefined;
    queryClient.clear();
    await del(IDB_KEY).catch(() => undefined);
};
