import type { WorkspaceState } from "@intentic/api-contract";
import { computed } from "vue";
import { orRefusal, SandboxHttpError } from "../sandbox/client/sandboxHttpError";
import { sandboxRpc } from "../sandbox/client/sandboxRpc";
import { WORKSPACE_STATE } from "../../lib/queryKeys";
import { useSandboxQuery } from "../sandbox/client/useSandboxQuery";
import { projectWorkspaceState } from "./workspaceStateProjection";

/* The infrastructure read-model: the sandbox's desired-state graph joined with the last reconcile result. */

// Read + parse one JSON file from the desired-state repo via the daemon; undefined when absent (the daemon refuses a
// missing or denylisted file, which means "not resolved yet").
const readJson = async (path: string): Promise<unknown> => {
    const file = await orRefusal(sandboxRpc.git.readFile({ repo: `desired-state`, path }));
    if (file instanceof SandboxHttpError) {
        return undefined;
    }
    try {
        return JSON.parse(file.content);
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
