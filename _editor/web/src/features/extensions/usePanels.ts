import { PanelsListSchema, type PanelSummary } from "@intentic/api-contract";
import { useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { sandboxJson } from "../sandbox/client/sandboxClient";
import { PANELS } from "../../lib/queryKeys";
import { useSandboxQuery } from "../sandbox/client/useSandboxQuery";

// Workspace repos' runtime status and content facts, via the daemon's /panels routes; list/start/stop only, since
// discovery is convention-only and panel lifecycle lives in the daemon (no clock here). Source for the rail's extension
// activations and every extension view.

const QUERY_KEY = PANELS.of();

// Named for the background loader (composables/prefetch), so a rail tile opens already filled in.
export const panelsKey = QUERY_KEY;
export const fetchPanels = async () => PanelsListSchema.parse(await sandboxJson(`/panels`));

export function usePanels() {
    const queryClient = useQueryClient();

    const { query, error } = useSandboxQuery({ queryKey: QUERY_KEY, queryFn: fetchPanels });

    const invalidate = async (): Promise<void> => {
        await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    };
    const start = async (repo: string): Promise<void> => {
        await sandboxJson(`/panels/${encodeURIComponent(repo)}/start`, { method: `POST` });
        await invalidate();
    };
    const stop = async (repo: string): Promise<void> => {
        await sandboxJson(`/panels/${encodeURIComponent(repo)}/stop`, { method: `POST` });
        await invalidate();
    };

    return {
        panels: computed<PanelSummary[]>(() => query.data.value?.panels ?? []),
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
