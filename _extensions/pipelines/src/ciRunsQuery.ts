import { type CiRunsResponse, CiRunsResponseSchema } from "@intentic/sandbox-contract";
import type { HostQuery } from "@intentic/extension-api";
import { host } from "./host";

/* THE PIPELINES READ MODEL, named once for every reader of it.
 *
 * The view, its rail badge and the host's background loader all want the same `/ci/runs` answer. Keeping the
 * route call beside each reader made the badge's minute-by-minute fetch private: it warmed the daemon's short
 * cache, but the view's vue-query entry still started empty and rendered a skeleton on open. A HostQuery is the
 * common filing instruction, one sandbox-scoped key and one parser, so any of the three readers fills the
 * entry the other two consume.
 *
 * Twenty seconds is the daemon sweep's own freshness window (ci/runs-cache.ts). Within it, mounting the view
 * should use the answer already in hand rather than immediately refetching it; after it, vue-query may refresh
 * in the background while still painting the cached board instead of returning to the first-load skeleton. */
export const CI_RUNS_STALE_MS = 20_000;

export const ciRunsQuery = (): HostQuery<CiRunsResponse> => {
    const api = host();
    return {
        queryKey: api.sandbox.key(`ci-runs`),
        queryFn: async (): Promise<CiRunsResponse> => CiRunsResponseSchema.parse(await api.sandbox.json(`/ci/runs`)),
        staleTime: CI_RUNS_STALE_MS,
    };
};
