import type {
    PackageModules,
    WorkspaceComponent,
    WorkspaceDepEdge,
    WorkspacePackage,
} from "@intentic/sandbox-contract/schemas/workspace/workspace-graph";
import { computed, type Ref } from "vue";
import { host } from "./host";

/* The monorepo's workspace package graph (nodes, typed dep edges with what the dependent does with each, and the
   repository map's components when it has one), the daemon's `workspace.packageGraph`. */

export function useWorkspaceGraph(repo: Ref<string>) {
    const api = host();
    const { query, error } = api.sandbox.query({
        queryKey: computed(() => api.sandbox.readKey(`workspace.packageGraph`, { repo: repo.value })),
        queryFn: () => api.sandbox.rpc.workspace.packageGraph({ repo: repo.value }),
    });
    return {
        packages: computed<WorkspacePackage[]>(() => query.data.value?.packages ?? []),
        edges: computed<WorkspaceDepEdge[]>(() => query.data.value?.edges ?? []),
        components: computed<WorkspaceComponent[]>(() => query.data.value?.components ?? []),
        error,
        isLoading: query.isLoading,
    };
}

/* One package's units and the imports between them, placed in its layers.json: `workspace.packageModules`. Idle until
   a package is named. */
export function usePackageModules(repo: Ref<string>, name: Ref<string | undefined>) {
    const api = host();
    const { query, error } = api.sandbox.query({
        queryKey: computed(() => api.sandbox.readKey(`workspace.packageModules`, { repo: repo.value, package: name.value ?? `` })),
        queryFn: () => api.sandbox.rpc.workspace.packageModules({ repo: repo.value, package: name.value ?? `` }),
        enabled: computed(() => name.value !== undefined),
    });
    return {
        modules: computed<PackageModules | undefined>(() => query.data.value),
        error,
        isLoading: query.isLoading,
    };
}
