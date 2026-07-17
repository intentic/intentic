import { type WorkspaceDepEdge, WorkspaceGraphSchema, type WorkspacePackage } from "@intentic/sandbox-contract";
import { useQuery } from "@tanstack/vue-query";
import { computed, type Ref } from "vue";
import { host } from "./host";

/* The monorepo's workspace package graph (nodes + typed dep edges) via GET /workspace/repos/{repo}/graph.
 * package.jsons change rarely — no polling; the default refetch-on-focus keeps it fresh enough. */

export function useWorkspaceGraph(repo: Ref<string>) {
    const api = host();
    const query = useQuery({
        queryKey: computed(() => api.sandbox.key(`package-graph`, repo.value)),
        queryFn: async () => WorkspaceGraphSchema.parse(await api.sandbox.json(`/workspace/repos/${encodeURIComponent(repo.value)}/graph`)),
        enabled: computed(() => api.sandbox.reachable()),
    });
    return {
        packages: computed<WorkspacePackage[]>(() => query.data.value?.packages ?? []),
        edges: computed<WorkspaceDepEdge[]>(() => query.data.value?.edges ?? []),
        error: computed(() => query.error.value?.message),
        isLoading: query.isLoading,
    };
}
