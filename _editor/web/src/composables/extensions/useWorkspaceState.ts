import type { WorkspaceState } from "@intentic-app/api-contract";
import { computed } from "vue";
import { sandboxRequest } from "../sandbox/sandboxClient";
import { WORKSPACE_STATE } from "../queryKeys";
import { useSandboxQuery } from "../sandbox/useSandboxQuery";
import { projectWorkspaceState } from "./workspaceStateProjection";

/* The infrastructure read-model: the sandbox's desired-state graph joined with the last reconcile result,
 * read DIRECTLY from the daemon (desired-state.json + status.json via its git file routes) and shaped locally
 * (see workspaceStateProjection). Shared by the infrastructure + live-status extensions — one sandbox-scoped
 * query, so a provision from one tab refreshes the other through the shared cache. */

// Read + parse one JSON file from the desired-state repo via the daemon; undefined when absent (the daemon
// answers a missing/denylisted file with a non-200 or an { error } body — both mean "not resolved yet").
const readJson = async (path: string): Promise<unknown> => {
    const response = await sandboxRequest(`/git/desired-state/file?path=${encodeURIComponent(path)}`);
    if (!response.ok) {
        return undefined;
    }
    const body = (await response.json().catch(() => undefined)) as { content?: unknown } | undefined;
    if (body === undefined || typeof body.content !== `string`) {
        return undefined;
    }
    try {
        return JSON.parse(body.content);
    } catch {
        return undefined;
    }
};

export function useWorkspaceState() {
    const { query, error } = useSandboxQuery({
        queryKey: WORKSPACE_STATE.of(),
        queryFn: async (): Promise<WorkspaceState> => {
            const [graph, status] = await Promise.all([readJson(`desired-state.json`), readJson(`status.json`)]);
            return projectWorkspaceState(graph, status);
        },
    });

    return {
        state: computed(() => query.data.value),
        error,
        isLoading: query.isLoading,
        refetch: query.refetch,
    };
}
