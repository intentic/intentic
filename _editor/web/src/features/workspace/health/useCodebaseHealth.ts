import type { WorkspaceHealth } from "@intentic/api-contract";
import { computed, type Ref } from "vue";
import { sandboxJson } from "../../sandbox/client/sandboxClient";
import { WORKSPACE_HEALTH } from "../../../lib/queryKeys";
import { useSandboxQuery } from "../../sandbox/client/useSandboxQuery";
import type { ChurnWindow } from "./codebaseHealth";

/* Codebase health reads churn and complexity from the resident iq index. */

export function useCodebaseHealth(repo: Ref<string>, window: Ref<ChurnWindow>) {
    const { query, error } = useSandboxQuery({
        queryKey: computed(() => WORKSPACE_HEALTH.of(repo.value, window.value)),
        queryFn: ({ signal }) =>
            sandboxJson<WorkspaceHealth>(
                `/workspace/health?repo=${encodeURIComponent(repo.value)}${window.value === `all` ? `` : `&since=${window.value}`}`,
                { signal },
            ),
    });
    return {
        health: computed(() => query.data.value),
        // Fetching with data already on screen is a refresh, not a load, the panel keeps the numbers visible.
        loading: computed(() => query.isFetching.value),
        error,
        refresh: query.refetch,
    };
}
