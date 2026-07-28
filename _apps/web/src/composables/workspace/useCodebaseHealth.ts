import type { WorkspaceHealth } from "@intentic-app/api-contract";
import { computed, type Ref } from "vue";
import { sandboxJson } from "../sandbox/sandboxClient";
import { sandboxKey } from "../sandbox/useSandbox";
import { useSandboxQuery } from "../sandbox/useSandboxQuery";
import type { ChurnWindow } from "../../pages/workspace/codebaseHealth";

/* One repo's codebase health, read straight from the daemon's resident iq engine (GET /workspace/health) —
 * churn × complexity per file, what the index holds, and the import graph's key modules. Parameterized by a
 * reactive repo + churn window so the panel's switchers re-key the query, the same shape as useGitLog. */

export function useCodebaseHealth(repo: Ref<string>, window: Ref<ChurnWindow>) {
    const { query, error } = useSandboxQuery({
        queryKey: computed(() => sandboxKey(`workspace`, `health`, repo.value, window.value)),
        queryFn: ({ signal }) =>
            sandboxJson<WorkspaceHealth>(
                `/workspace/health?repo=${encodeURIComponent(repo.value)}${window.value === `all` ? `` : `&since=${window.value}`}`,
                { signal },
            ),
    });
    return {
        health: computed(() => query.data.value),
        // Fetching with data already on screen is a refresh, not a load — the panel keeps the numbers visible.
        loading: computed(() => query.isFetching.value),
        error,
        refresh: query.refetch,
    };
}
