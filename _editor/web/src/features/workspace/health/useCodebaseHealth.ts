import type { WorkspaceHealth } from "@intentic/api-contract";
import { computed, type Ref } from "vue";
import { sandboxRpc } from "../../sandbox/client/sandboxRpc";
import { rpcKey } from "../../../lib/queryKeys";
import { useSandboxQuery } from "../../sandbox/client/useSandboxQuery";
import type { ChurnWindow } from "./codebaseHealth";

/* Codebase health reads churn and complexity from the resident iq index. */

export function useCodebaseHealth(repo: Ref<string>, window: Ref<ChurnWindow>) {
    // `all` sends no window: the whole history is the daemon's default.
    const input = computed(() => ({ repo: repo.value, since: window.value === `all` ? undefined : window.value }));
    // Built by hand rather than with rpcQuery, which drops the query's signal: a repo or window switched mid-read
    // aborts the read it replaced.
    const { query, error } = useSandboxQuery({
        queryKey: computed(() => rpcKey(`workspace.health`, input.value)),
        queryFn: ({ signal }): Promise<WorkspaceHealth> => sandboxRpc.workspace.health(input.value, { signal }),
    });
    return {
        health: computed(() => query.data.value),
        // Fetching with data already on screen is a refresh, not a load, the panel keeps the numbers visible.
        loading: computed(() => query.isFetching.value),
        error,
        refresh: query.refetch,
    };
}
