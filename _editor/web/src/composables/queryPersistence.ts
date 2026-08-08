import type { PersistedClient } from "@tanstack/query-persist-client-core";
import { persistQueryClient } from "@tanstack/query-persist-client-core";
import { defaultShouldDehydrateQuery, QueryClient } from "@tanstack/vue-query";
import { del, get, set } from "idb-keyval";
import { buildId } from "./buildEpoch";
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

/* THE SEGMENT A QUERY KEY CARRIES WHEN ITS VALUE MUST STAY IN MEMORY. The mirror is structured-cloned WHOLE, on
 * the main thread, once per window (see the throttle below) — so its cost is set by everything the app has ever
 * cached, and a single query measured in megabytes is charged to every write of every other cached thing for the
 * rest of the session.
 *
 * WHICH IS THE WHOLE STORAGE RULE, and it is worth stating as one now that a background loader fills this cache
 * on the app's behalf rather than only the screen in front of the user (composables/prefetch). Three classes:
 *
 *   · SMALL AND SHAPE-STABLE — rosters, lists, trees, view contents. Memory AND this mirror. They are what makes
 *     a reload paint the last-known workspace instead of a blank one, and they are small enough that mirroring
 *     all of them costs less than the blank frame does.
 *   · LARGE AND DISPOSABLE — a file diff is two complete file texts, and both reviews read one per changed file
 *     ahead of the reader. Memory only, bounded by gcTime. Marked here.
 *   · LARGE AND WORTH KEEPING — a conversation's transcript, which runs to megabytes and IS worth surviving a
 *     reload. Marked here too, and kept instead in a store of its own where it is written ONE RECORD AT A TIME
 *     (chat/transcriptCache.ts). That is the point: its size is charged to itself rather than to every other
 *     write in the app.
 *
 * Marking the key rather than listing the queries down in the exclusion is what keeps this honest as more of
 * them appear — the query that knows it is heavy says so, where it is impossible to forget while writing it.
 * Such a query still lives in the in-memory cache, which is where the speed comes from. */
export const UNPERSISTED = `unpersisted`;

/* MAY THIS KEY'S VALUE GO TO DISK? Two exclusions, for opposite reasons: `sandbox` rows carry per-sandbox
 * connect tokens (the tunnel secret), and an UNPERSISTED-marked key carries more bytes than the mirror can
 * afford (above). Every other daemon query — workspace, info, capabilities, the agent roster — still persists.
 *
 * Split out from the persister below so it can be asserted directly: the rule is one line, and the cost of
 * getting it wrong (a megabyte re-cloned every two seconds for the rest of the session, or a connect token on
 * disk) is not something to discover by watching the app stutter. */
export const mirrors = (queryKey: readonly unknown[]): boolean => queryKey[0] !== `sandbox` && !queryKey.includes(UNPERSISTED);

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
// fetch. buster = user id + build id: a different account on the same browser busts the previous user's cache,
// and a new build of the app busts what the previous build shaped. The build half used to be a hand-bumped
// SCHEMA_VERSION, which held exactly until someone changed a cached entry's shape (workspace/search becoming a
// PAGED query — vue-query read `data.pages.length` off the old shape before any code of ours ran) and forgot
// the bump; buildId() is that bump made automatic (see buildEpoch.ts).
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
