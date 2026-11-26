import type {
    PackageModules,
    WorkspaceComponent,
    WorkspaceDepEdge,
    WorkspaceGraph,
    WorkspacePackage,
} from "@intentic/sandbox-contract/schemas/workspace/workspace-graph";
import { computed, type Ref } from "vue";
import { backendRead } from "./backendRead";
import { GRAPH_ROUTE, graphPath, LAYERS_ROUTE, layersPath } from "./backendRoutes";
import { host } from "./host";

// Where a daemon from before this extension's backend answered the same two reads (backendRead.ts).
// allow(route-literal): a daemon route that only an older daemon still serves, not an address in the app.
const legacyRepoPath = (repo: string, read: string): string => `/workspace/repos/${encodeURIComponent(repo)}/${read}`;

/* The monorepo's workspace package graph (nodes, typed dep edges with what the dependent does with each, and the
   repository map's components when it has one), read by this extension's backend. */

export function useWorkspaceGraph(repo: Ref<string>) {
    const api = host();
    const { query, error, loaded } = api.sandbox.query({
        queryKey: computed(() => api.sandbox.key(`repo-apps`, GRAPH_ROUTE, repo.value)),
        queryFn: () => backendRead<WorkspaceGraph>(api, graphPath(repo.value), legacyRepoPath(repo.value, `graph`)),
    });
    return {
        packages: computed<WorkspacePackage[]>(() => query.data.value?.packages ?? []),
        edges: computed<WorkspaceDepEdge[]>(() => query.data.value?.edges ?? []),
        components: computed<WorkspaceComponent[]>(() => query.data.value?.components ?? []),
        error,
        loaded,
    };
}

/* One package's units and the imports between them, placed in its layers.json, read by the same backend. Idle until a
   package is named. */
export function usePackageModules(repo: Ref<string>, name: Ref<string | undefined>) {
    const api = host();
    const { query, error, loaded } = api.sandbox.query({
        queryKey: computed(() => api.sandbox.key(`repo-apps`, LAYERS_ROUTE, repo.value, name.value ?? ``)),
        queryFn: () =>
            backendRead<PackageModules>(
                api,
                layersPath(repo.value, name.value ?? ``),
                `${legacyRepoPath(repo.value, `layers`)}?${new URLSearchParams({ package: name.value ?? `` }).toString()}`,
            ),
        enabled: computed(() => name.value !== undefined),
    });
    return {
        modules: computed<PackageModules | undefined>(() => query.data.value),
        error,
        loaded,
    };
}
