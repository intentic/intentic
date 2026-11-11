import { errorMessage } from "@intentic/base/errors";
import type { PersistedClient } from "@tanstack/query-persist-client-core";
import { persistQueryClientRestore, persistQueryClientSave } from "@tanstack/query-persist-client-core";
import { defaultShouldDehydrateQuery, QueryCache, QueryClient } from "@tanstack/vue-query";
import { del, get, keys, set } from "idb-keyval";
import { accountPartition } from "@intentic/ui/storage";
import { buildId } from "../app/buildEpoch";
import { reportClient } from "../app/clientDiagnostics";
import { recordPerf } from "../app/perf/perf";
import { throttleTrailing } from "./throttleTrailing";
import { whenIdle } from "./whenIdle";
import { markBoot } from "../app/perf/boot";
import { windowRole } from "./windows/windowRole";
import { reloadOnHotUpdate } from "../app/hotReload";

// Persists the vue-query cache to IndexedDB so a reload paints the last-known workspace instantly, instead of blocking
// on the daemon tunnel. Hydrated data is distrusted when the stream says so rather than permanently: applyHello
// invalidates on every (re)connect. `sandbox.list` and auth state stay out of the persisted cache.

// One snapshot per account, beside each other's in the one store: `intentic-query-cache:<account>`, the open account's
// (@intentic/ui/storage `accountPartition`), so switching back to an account paints its workspace at once rather than
// starting cold. The bare name is the snapshot from before accounts had their own, cleared with the next account.
const IDB_BASE = `intentic-query-cache`;
const idbKey = (account: string | undefined = accountPartition()): string => (account === undefined ? IDB_BASE : `${IDB_BASE}:${account}`);

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

// How many times a read that failed is tried again before it is drawn as failed: vue-query's own default.
const READ_RETRIES = 3;

// Whether a failed read was the person's access rather than a failure: `foreseen`, refused by the editor before it was
// sent; `refused`, refused by the daemon on access grounds the editor did not foresee. Read by the sandbox client, which
// knows what an access refusal looks like and registers its reading when it loads (client/sandbox/access/accessReason.ts).
export type RefusalKind = `foreseen` | `refused`;
// allow(module-state): the one reading of refusals, registered once by the sandbox client
let refusalKindOf: (error: Error) => RefusalKind | undefined = () => undefined;
export const readRefusalsWith = (read: (error: Error) => RefusalKind | undefined): void => {
    refusalKindOf = read;
};

// Every read that finally failed is logged here, the one place all of them pass: a view that draws only `data` shows
// a failure as an empty list, and without this line nothing anywhere would say it happened. A read the person's access
// refuses did not fail (`refusalKindOf`, above): one the editor foresaw is never logged, one the daemon refused that the
// editor did not foresee is reported under its own name, the trace of a route whose handler holds a tier its
// declaration does not, and neither is tried again, since its answer cannot change by asking.
export const queryClient = new QueryClient({
    queryCache: new QueryCache({
        onError: (error, query) => {
            const key = JSON.stringify(query.queryKey);
            const refusal = refusalKindOf(error);
            if (refusal === `foreseen`) {
                return;
            }
            if (refusal === `refused`) {
                reportClient("query.refused", errorMessage(error), { level: `warn`, fields: { key: key.slice(0, 300) } });
                return;
            }
            console.warn(`query ${key} failed`, error);
            // Also durable: a read that failed in the owner's tab is otherwise invisible to whoever investigates it.
            reportClient("query.failed", errorMessage(error), { fields: { key: key.slice(0, 300) } });
        },
    }),
    defaultOptions: {
        queries: {
            staleTime: NAVIGATION_STALE_MS,
            retry: (failures, error) => refusalKindOf(error) === undefined && failures < READ_RETRIES,
        },
    },
});

let uninstall: (() => void) | undefined;

// A change is snapshotted once the cache has settled this long and the page is idle (`snapshot`, below).
const PERSIST_WINDOW_MS = 2000;
// AT MOST ONE WRITE IN THIS LONG. A write clones the whole mirror and stores it as one value, so it costs what everything
// mirrored weighs rather than how many queries there are: ~41 queries took 1.0 s a write at the median and 12.6 s at worst
// (`query.persist`, 2026-11-01..06), and at one write per settle a busy agents board kept IndexedDB writing nearly back to
// back. The mirror only paints a reload before the live reads answer, so a snapshot this much older costs nothing; the
// first change after a quiet spell is still written as soon as it settles. Dropped on tab close costs nothing either.
const MIRROR_EVERY_MS = 15_000;
// One write in flight at a time, and only the newest cache after it. Writes that each started on their own piled up
// behind a frozen page's IndexedDB, and on wake-up all finished at once: 942 slow-write warnings in one second.
let latestClient: PersistedClient | undefined;
let persisting: Promise<void> | undefined;
// The write is timed at most once a minute: enough to show the mirror has grown too big, without a warning per write.
const TIMED_EVERY_MS = 60_000;
let lastTimedAt = Number.NEGATIVE_INFINITY;

// WHAT THE DISK HOLDS: each mirrored query's data, by reference, in the snapshot last sent to be written (or restored).
// Vue-query keeps a refetched answer that equals the cached one as the very same object (structural sharing), so a
// snapshot whose every query still holds the object last written has nothing new for the disk, whatever its timestamps
// say: a reconnect's refetch of everything, or a poll answering the same, rewrote the whole mirror for nothing.
interface Mirrored {
    readonly key: string;
    readonly client: PersistedClient;
    readonly data: ReadonlyMap<string, unknown>;
}
let mirrored: Mirrored | undefined;
// Written again this long after anyway, so a window whose data never changes does not let its snapshot age out (maxAge).
const REWRITE_AFTER_MS = 6 * 60 * 60 * 1000;
const mirrorOf = (client: PersistedClient, key: string): Mirrored => ({
    key,
    client,
    data: new Map(client.clientState.queries.map((query) => [query.queryHash, query.state.data])),
});
const alreadyMirrored = (client: PersistedClient, key: string): boolean => {
    const last = mirrored;
    if (last === undefined || last.key !== key || client.timestamp - last.client.timestamp > REWRITE_AFTER_MS || client.clientState.mutations.length > 0) {
        return false;
    }
    const { queries } = client.clientState;
    return queries.length === last.data.size && queries.every((query) => last.data.has(query.queryHash) && last.data.get(query.queryHash) === query.state.data);
};

// The heaviest few entries, by procedure: what a slow write's report names, so whoever reads it knows which entry to
// keep out of the mirror (UNPERSISTED) rather than guessing. Weighed only past query.persist's own slow budget (perf.ts),
// and once the page is idle: serializing everything mirrored once more is not free either.
const WEIGH_PAST_MS = 500;
const heaviest = (client: PersistedClient): string =>
    client.clientState.queries
        // Its length as JSON: a rough weight, enough to rank by. Every answer here arrived as JSON.
        .map((query) => ({ name: String(query.queryKey[0]), weight: JSON.stringify(query.state.data)?.length ?? 0 }))
        .toSorted((one, other) => other.weight - one.weight)
        .slice(0, 3)
        .map(({ name, weight }) => `${name} ${Math.round(weight / 1024)}kB`)
        .join(`, `);

const write = async (client: PersistedClient): Promise<void> => {
    const now = Date.now();
    if (now - lastTimedAt < TIMED_EVERY_MS) {
        await set(idbKey(), client);
        return;
    }
    lastTimedAt = now;
    // Timed since this write scales with everything cached; `queries` shows if the mirror has grown too big, and a slow
    // one names its heaviest entries.
    const from = performance.now();
    await set(idbKey(), client);
    const ms = performance.now() - from;
    const queries = client.clientState.queries.length;
    if (ms < WEIGH_PAST_MS) {
        recordPerf(`query.persist`, ms, { queries });
        return;
    }
    whenIdle(() => recordPerf(`query.persist`, ms, { queries, heaviest: heaviest(client) }));
};

const drainPersist = (): void => {
    const client = latestClient;
    if (persisting !== undefined || client === undefined) {
        return;
    }
    latestClient = undefined;
    persisting = write(client)
        .catch(() => {
            // A refused write (a full or disabled IndexedDB) costs only the next reload's instant paint; the next snapshot
            // tries again rather than taking the disk to hold this one.
            if (mirrored?.client === client) {
                mirrored = undefined;
            }
        })
        .finally(() => {
            persisting = undefined;
            // A cache that arrived while this write was in flight waits for the next interval, not straight after it.
            if (latestClient !== undefined) {
                flushPersist();
            }
        });
};
const flushPersist = throttleTrailing(drainPersist, MIRROR_EVERY_MS);

// THE DISK READ, STARTED AT BOOT. Reading the snapshot back is a structured clone of megabytes out of IndexedDB, and it
// used to begin only once the platform had answered the session check, one after the other on the first page's path.
// main.ts starts it as soon as stored state is known good (after the self-heal purge), on a browser that had a sandbox
// open; the guard's restore below then takes this read instead of starting its own. Taken once: the restore runs once per
// window, and the buster and age checks are applied to it exactly as to a read made then.
let earlyRead: Promise<PersistedClient | undefined> | undefined;
export const readPersistedQueriesEarly = (): void => {
    // allow(silent-catch): an unreadable store restores as empty, which is what the restore itself does with a failed read.
    earlyRead ??= get<PersistedClient>(idbKey()).catch(() => undefined);
};
const takeEarlyRead = (): Promise<PersistedClient | undefined> => {
    const read = earlyRead ?? get<PersistedClient>(idbKey());
    earlyRead = undefined;
    return read;
};

// Called after auth resolves and before any route mounts, so hydration never races a fetch. `buster` combines the user
// id and buildId(), so a different account or a new build starts from a clean cache.
// The cache events a snapshot answers to, as the persistence library itself counts them: a query or mutation added,
// removed or updated, never one that only gained or lost an observer.
const CACHE_CHANGES = new Set([`added`, `removed`, `updated`]);

// ONE WINDOW WRITES THE MIRROR. It is one record per browser, and every open window snapshotted its whole cache into
// it on its own changes, each over the last: two windows side by side wrote it twice as often, and the one written last
// decided what the next load painted. A popped-out panel's window never writes, since its cache holds what its panel
// reads and a mirror of that would paint the next main window with a fraction of the workspace. Among main windows the
// first holds a Web Lock for its life and the others queue on it, the next taking over the moment it closes. Without
// Web Locks (a plain-http origin) every main window writes, as before.
const MIRROR_LOCK = `intentic.query-mirror`;
let writesMirror = false;
const claimMirror = (): void => {
    if (windowRole !== `main`) {
        return;
    }
    const locks = globalThis.navigator?.locks;
    if (locks === undefined) {
        writesMirror = true;
        return;
    }
    locks
        .request(MIRROR_LOCK, () => {
            writesMirror = true;
            // Held for the page's life: the browser lets go of it with the page.
            return new Promise<void>(() => undefined);
        })
        // allow(silent-catch): a refused lock leaves this window writing, as every window did before the lock.
        .catch(() => {
            writesMirror = true;
        });
};

export const restorePersistedQueries = async (userId: string): Promise<void> => {
    if (uninstall !== undefined) {
        return;
    }
    claimMirror();
    const options = {
        queryClient,
        persister: {
            persistClient: (client: PersistedClient) => {
                const key = idbKey();
                if (alreadyMirrored(client, key)) {
                    return;
                }
                mirrored = mirrorOf(client, key);
                latestClient = client;
                flushPersist();
            },
            // What came back is what the disk holds: the restored queries keep these very objects until an answer
            // differs, so the reconnect's refetch of everything rewrites only what came back changed.
            restoreClient: async () => {
                const restored = await takeEarlyRead();
                mirrored = restored === undefined ? undefined : mirrorOf(restored, idbKey());
                return restored;
            },
            removeClient: () => {
                mirrored = undefined;
                return del(idbKey());
            },
        },
        buster: `${userId}:${buildId()}`,
        // A Monday-morning open after Friday still paints; anything older restores as empty.
        maxAge: 7 * 24 * 60 * 60 * 1000,
        // The storage rule (`mirrors`, above), composed with the default so non-success queries stay out too.
        dehydrateOptions: {
            shouldDehydrateQuery: (query: Parameters<typeof defaultShouldDehydrateQuery>[0]) =>
                mirrors(query.queryKey) && defaultShouldDehydrateQuery(query),
        },
    };
    // THE SNAPSHOT IS TAKEN ONCE PER WINDOW, AT IDLE. The persistence library dehydrates the whole cache on every cache
    // event, before the write's throttle ever sees it: a reconnect's hello invalidates every query at once, and each of
    // the hundreds of events that follow walked every query again, on the main thread of a phone that was trying to draw
    // them. Here an event only marks the cache changed; one snapshot is taken when the window closes and the page is
    // idle, which also leaves the cache a restore just filled alone rather than writing it straight back.
    let stopped = false;
    let owed = false;
    const snapshot = (): void => {
        if (owed || stopped || !writesMirror) {
            return;
        }
        owed = true;
        setTimeout(
            () =>
                whenIdle(() => {
                    owed = false;
                    if (!stopped) {
                        // allow(silent-catch): Persisting the query cache is optional; current in-memory data remains usable.
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
    // allow(silent-catch): A failed cache restore must not block navigation; live queries fill the empty cache.
    await persistQueryClientRestore(options).catch(() => undefined);
    markBoot(`restore`);
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

// Logout / account deletion: stop persisting, drop memory and disk so the next login starts clean: this account's
// snapshot (the open one's by default) with the one from before accounts had their own, or every account's. A failed
// delete means IndexedDB never worked, so nothing was persisted; do not let it abort the sign-out.
export const clearPersistedQueries = async (which: { readonly account?: string } | `every` = {}): Promise<void> => {
    uninstall?.();
    uninstall = undefined;
    earlyRead = undefined;
    latestClient = undefined;
    mirrored = undefined;
    await persisting;
    queryClient.clear();
    try {
        const doomed =
            which === `every`
                ? (await keys()).filter((key): key is string => typeof key === `string` && (key === IDB_BASE || key.startsWith(`${IDB_BASE}:`)))
                : [...new Set([idbKey(which.account ?? accountPartition()), IDB_BASE])];
        await Promise.all(doomed.map(async (key) => del(key)));
    } catch (cause) {
        console.warn("Could not remove the persisted query cache", cause);
    }
};

// One query cache per window: a re-run copy would start empty beside the one every subscriber already holds
// (hotReload.ts).
reloadOnHotUpdate(import.meta);
