import type { WorkspaceDepEdge, WorkspacePackage } from "@intentic/sandbox-contract";
import { useQuery } from "@tanstack/vue-query";
import { computed, type Ref } from "vue";
import { host } from "./host";

/* The monorepo's workspace package graph (nodes + typed dep edges), the daemon's `workspace.packageGraph`. */

export function useWorkspaceGraph(repo: Ref<string>) {
    const api = host();
    const query = useQuery({
        queryKey: computed(() => api.sandbox.key(`package-graph`, repo.value)),
        queryFn: () => api.sandbox.rpc.workspace.packageGraph({ repo: repo.value }),
        enabled: computed(() => api.sandbox.reachable()),
    });
    return {
        packages: computed<WorkspacePackage[]>(() => query.data.value?.packages ?? []),
        edges: computed<WorkspaceDepEdge[]>(() => query.data.value?.edges ?? []),
        error: computed(() => query.error.value?.message),
        isLoading: query.isLoading,
    };
}
