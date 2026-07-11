import { PanelsListSchema, type PanelSummary } from "@intentic-app/api-contract";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { sandboxJson } from "../sandboxClient";
import { sandboxKey, useSandbox } from "../useSandbox";

/* The workspace's repositories: runtime status (running/healthy/previewUrl) + the content facts the extension
 * registry detects on, read via the daemon's /panels routes. Discovery is convention-only — no manifest — so
 * there are just list, start, and stop; a panel's lifecycle lives in the daemon and the list poll reflects it.
 * This is the source for the rail's extension activations and every extension view. */

const QUERY_KEY = sandboxKey(`panels`);
// While any panel is running, keep the status fresh (start → healthy flips without a reload).
const POLL_MS = 4000;

export function usePanels() {
    const { reachable } = useSandbox();
    const queryClient = useQueryClient();

    const query = useQuery({
        queryKey: QUERY_KEY,
        queryFn: async () => PanelsListSchema.parse(await sandboxJson(`/panels`)),
        enabled: reachable,
        refetchInterval: (state) => (state.state.data?.panels.some((panel) => panel.running) ? POLL_MS : false),
    });

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
        error: computed(() => (query.error.value ? query.error.value.message : null)),
        isLoading: query.isLoading,
        start,
        stop,
    };
}
