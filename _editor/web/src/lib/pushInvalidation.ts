import { nextTick, ref, type Ref, watch, type WatchStopHandle } from "vue";
import type { InvalidateQueryFilters, Query, QueryClient } from "@tanstack/vue-query";

interface Refresh {
    dirty: boolean;
}

// Track actual cache entries: broad and narrow prefixes can name the same read. A second push must let that read
// finish, then ask once more because its snapshot may predate the push. Removed/recreated entries never share state.
const refreshes = new WeakMap<Query, Refresh>();

/* A WINDOW NOBODY CAN SEE READS NOTHING A PUSH NAMES. Out of sight (a background tab, a minimised window, one the desktop
   app hid), a push only marks what it names stale, and the window reads back what is on screen the moment it is seen
   again: every push used to cost every open window a read, hidden ones included, and the reads each push sets off were
   most of an editor's ~57 daemon requests a minute (2026-11-06). Vue Query refetches a stale observed read on a
   visibility change by itself, but not one that opted out of refetchOnWindowFocus, nor on the desktop app's word alone,
   so the reads held back are named here and read once more unless one is already under way. */
const heldBack = new Map<QueryClient, Set<Query>>();

const holdBack = (client: QueryClient, query: Query): void => {
    const held = heldBack.get(client) ?? new Set<Query>();
    held.add(query);
    heldBack.set(client, held);
};

// Whether this window is seen, as the workbench says it (workbench/window/onScreen.ts hands its signal in here, since this
// layer sits below it). Until it does, and in a window nothing tells, every window reads as seen: the old behaviour.
// allow(module-state): this window's one visibility source
let seen: Readonly<Ref<boolean>> = ref(true);
// allow(module-state): the watch on that source, replaced when another is handed in
let following: WatchStopHandle | undefined;

const readHeldBack = (): void => {
    const due = [...heldBack];
    heldBack.clear();
    for (const [client, queries] of due) {
        const cache = client.getQueryCache();
        for (const query of queries) {
            if (cache.get(query.queryHash) === query && query.state.isInvalidated && query.state.fetchStatus === `idle` && query.isActive()) {
                void client.refetchQueries({ queryKey: query.queryKey, exact: true, type: `active` }, { cancelRefetch: false });
            }
        }
    }
};

/** Takes the window's visibility from `source`: while it reads false a push only marks queries stale, and what was held
 *  back is read once it reads true again. */
export const followPushVisibility = (source: Readonly<Ref<boolean>>): void => {
    following?.();
    seen = source;
    following = watch(source, (now) => {
        if (now) {
            readHeldBack();
        }
    });
};

export const invalidatePushedQueries = (client: QueryClient, filters: InvalidateQueryFilters = {}): Promise<void> => {
    const started: (() => void)[] = [];
    const type = filters.refetchType ?? filters.type ?? `active`;
    const hidden = type !== `none` && !seen.value;
    // What this call reads now: nothing while hidden. `type` stays as asked, so a catch-up that lands once the window is
    // seen again reads as the push wanted.
    const reads = hidden ? `none` : type;
    for (const query of client.getQueryCache().findAll(filters)) {
        if (hidden && type !== `inactive` && query.isActive()) {
            holdBack(client, query);
        }
        if (
            query.state.fetchStatus === `idle` &&
            (reads === `none` || query.isDisabled() || (reads === `active` && !query.isActive()) || (reads === `inactive` && query.isActive()))
        ) {
            continue;
        }
        const existing = refreshes.get(query);
        if (existing !== undefined) {
            existing.dirty = true;
            continue;
        }
        // A mounting or prefetch read can predate the push. An inactive one is marked stale after it lands,
        // without fetching it again until someone mounts it.
        const refresh = { dirty: query.state.fetchStatus !== `idle` };
        refreshes.set(query, refresh);
        started.push(() => {
            const settled = (): void => {
                refreshes.delete(query);
                if (refresh.dirty && client.getQueryCache().get(query.queryHash) === query) {
                    void invalidatePushedQueries(client, { queryKey: query.queryKey, exact: true, refetchType: type });
                }
            };
            void (query.promise ?? Promise.resolve()).then(settled, settled);
        });
    }
    const reading = client.invalidateQueries(hidden ? { ...filters, refetchType: `none` } : filters, { cancelRefetch: false });
    // Vue Query starts refetches on nextTick. Bind each catch-up to its own read after that tick, so a slow sibling
    // matched by the same prefix cannot hold back a query whose snapshot has already landed.
    void nextTick().then(() => {
        for (const start of started) {
            start();
        }
    });
    return reading;
};
