import type { PackageModules, WorkspaceComponent, WorkspaceDepEdge, WorkspacePackage } from "@intentic/sandbox-contract";
import { useQuery } from "@tanstack/vue-query";
import { computed, type Ref } from "vue";
import { host } from "./host";

/* The monorepo's workspace package graph (nodes, typed dep edges with what the dependent does with each, and the
   repository map's components when it has one), the daemon's `workspace.packageGraph`. */

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
        components: computed<WorkspaceComponent[]>(() => query.data.value?.components ?? []),
        error: computed(() => query.error.value?.message),
        isLoading: query.isLoading,
    };
}

/* One package's units and the imports between them, placed in its layers.json: `workspace.packageModules`. Idle until
   a package is named. */
export function usePackageModules(repo: Ref<string>, name: Ref<string | undefined>) {
    const api = host();
    const query = useQuery({
        queryKey: computed(() => api.sandbox.key(`package-modules`, repo.value, name.value ?? ``)),
        queryFn: () => api.sandbox.rpc.workspace.packageModules({ repo: repo.value, package: name.value ?? `` }),
        enabled: computed(() => api.sandbox.reachable() && name.value !== undefined),
    });
    return {
        modules: computed<PackageModules | undefined>(() => query.data.value),
        error: computed(() => query.error.value?.message),
        isLoading: query.isLoading,
    };
}
