import type { PanelSummary } from "@intentic/api-contract";
import { useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { withinScope } from "../../app/projectScope";
import { rpcKey } from "../../lib/queryKeys";
import { rpcQuery } from "../sandbox/client/rpcQuery";
import { sandboxRpc } from "../sandbox/client/sandboxRpc";
import { useSandboxQuery } from "../sandbox/client/useSandboxQuery";

// Workspace repos' runtime status and content facts, via the daemon's /panels routes; list/start/stop only, since
// discovery is convention-only and panel lifecycle lives in the daemon (no clock here). Source for the rail's extension
// activations and every extension view.

export function usePanels() {
    const queryClient = useQueryClient();

    const { query, error } = useSandboxQuery(rpcQuery(`panels.list`));

    const invalidate = async (): Promise<void> => {
        await queryClient.invalidateQueries({ queryKey: rpcKey(`panels.list`) });
    };
    const start = async (repo: string): Promise<void> => {
        await sandboxRpc.panels.start({ repo });
        await invalidate();
    };
    const stop = async (repo: string): Promise<void> => {
        await sandboxRpc.panels.stop({ repo });
        await invalidate();
    };

    const allPanels = computed<PanelSummary[]>(() => query.data.value?.panels ?? []);
    return {
        // The open project's repositories only (app/projectScope.ts): what the rail, every extension view and the
        // preview read, so opening a project narrows all of them at once.
        panels: computed<PanelSummary[]>(() => allPanels.value.filter((panel) => withinScope(panel.repo))),
        // Every repository, for the surfaces about the sandbox itself rather than the work in it.
        allPanels,
        // List has arrived or failed for good; the rail waits on this before calling a tile absent rather than late.
        settled: computed(() => query.isFetched.value || query.isError.value),
        error,
        isLoading: query.isLoading,
        start,
        stop,
        // Re-fetch on demand, for PreviewPanel.vue's wait on a start whose push notification got dropped.
        invalidate,
    };
}
