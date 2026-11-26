import type { CiRunsResponse } from "@intentic/sandbox-contract/schemas/ci";
import type { HostQuery } from "@intentic/extension-api";
import { backendCall } from "./backendCall";
import { RUNS_ROUTE } from "./backendRoutes";
import { host } from "./host";

// Shared read model for the CI board (`ci.runs`): the view, the rail badge and the background loader read one HostQuery
// (one key, one parser), so any fills the entry the others consume. (2026-11-26) Answered by this extension's backend, with
// main's failures and the fix agents' owner steps, else by an older daemon's own GET /ci/runs (backendCall.ts). `CI_RUNS_STALE_MS` matches the daemon's sweep freshness: within
// it a mount reuses the cache; after it, vue-query refreshes in the background instead of a skeleton.
export const CI_RUNS_STALE_MS = 20_000;

export const ciRunsQuery = (): HostQuery<CiRunsResponse> => {
    const api = host();
    return {
        queryKey: api.sandbox.readKey(`ci.runs`),
        queryFn: (): Promise<CiRunsResponse> => backendCall<CiRunsResponse>(api, RUNS_ROUTE, () => api.sandbox.rpc.ci.runs()),
        staleTime: CI_RUNS_STALE_MS,
    };
};
