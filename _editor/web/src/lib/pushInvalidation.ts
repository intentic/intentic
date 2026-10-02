import { nextTick } from "vue";
import type { InvalidateQueryFilters, Query, QueryClient } from "@tanstack/vue-query";

interface Refresh {
    dirty: boolean;
}

// Track actual cache entries: broad and narrow prefixes can name the same read. A second push must let that read
// finish, then ask once more because its snapshot may predate the push. Removed/recreated entries never share state.
const refreshes = new WeakMap<Query, Refresh>();

export const invalidatePushedQueries = (client: QueryClient, filters: InvalidateQueryFilters = {}): Promise<void> => {
    const started: (() => void)[] = [];
    const type = filters.refetchType ?? filters.type ?? `active`;
    for (const query of client.getQueryCache().findAll(filters)) {
        if (
            query.state.fetchStatus === `idle` &&
            (type === `none` || query.isDisabled() || (type === `active` && !query.isActive()) || (type === `inactive` && query.isActive()))
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
    const reading = client.invalidateQueries(filters, { cancelRefetch: false });
    // Vue Query starts refetches on nextTick. Bind each catch-up to its own read after that tick, so a slow sibling
    // matched by the same prefix cannot hold back a query whose snapshot has already landed.
    void nextTick().then(() => {
        for (const start of started) {
            start();
        }
    });
    return reading;
};
