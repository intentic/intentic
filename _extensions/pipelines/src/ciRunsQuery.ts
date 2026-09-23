import type { CiRunsResponse } from "@intentic/sandbox-contract";
import type { HostQuery } from "@intentic/extension-api";
import { host } from "./host";

// Shared read model for the CI board (`ci.runs`): the view, the rail badge and the background loader read one HostQuery
// (one key, one parser), so any fills the entry the others consume. `CI_RUNS_STALE_MS` matches the daemon's sweep freshness: within
// it a mount reuses the cache; after it, vue-query refreshes in the background instead of a skeleton.
export const CI_RUNS_STALE_MS = 20_000;

export const ciRunsQuery = (): HostQuery<CiRunsResponse> => {
    const api = host();
    return {
        queryKey: api.sandbox.key(`ci-runs`),
        queryFn: (): Promise<CiRunsResponse> => api.sandbox.rpc.ci.runs(),
        staleTime: CI_RUNS_STALE_MS,
    };
};
