import type { PersistedClient } from "@tanstack/query-persist-client-core";
import { persistQueryClient } from "@tanstack/query-persist-client-core";
import { defaultShouldDehydrateQuery, QueryClient } from "@tanstack/vue-query";
import { del, get, set } from "idb-keyval";

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

// Called from requireAuth AFTER the user resolves and BEFORE any route mounts, so hydration never races a
// fetch. buster = user id: a different account on the same browser busts the previous user's cache.
export const restorePersistedQueries = async (userId: string): Promise<void> => {
    if (uninstall !== undefined) {
        return;
    }
    const [unsubscribe, restored] = persistQueryClient({
        queryClient,
        persister: {
            // ponytail: writes the whole dehydrated cache on every cache event, unthrottled — writes are
            // async and small; wrap persistClient in a trailing throttle if profiling ever shows jank.
            persistClient: (client: PersistedClient) => set(IDB_KEY, client),
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
