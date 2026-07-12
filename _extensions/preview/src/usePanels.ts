import { type PanelSummary, PanelsListSchema } from "@intentic/sandbox-contract";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { host } from "./host";

/* The workspace repositories' dev-server panels, via the daemon's /panels routes — runtime status
 * (running/healthy/previewUrl/port) plus start/stop. Polls while anything runs so `start → healthy` flips
 * without a reload. All daemon access goes through the host api. */

const POLL_MS = 4000;

export function usePanels() {
    const api = host();
    const queryClient = useQueryClient();
    const queryKey = api.sandbox.key(`panels`);

    const query = useQuery({
        queryKey,
        queryFn: async () => PanelsListSchema.parse(await api.sandbox.json(`/panels`)),
        enabled: computed(() => api.sandbox.reachable()),
        refetchInterval: (state) => (state.state.data?.panels.some((panel) => panel.running) ? POLL_MS : false),
    });

    const invalidate = (): Promise<void> => queryClient.invalidateQueries({ queryKey });
    const start = async (repo: string): Promise<void> => {
        await api.sandbox.json(`/panels/${encodeURIComponent(repo)}/start`, { method: `POST` });
        await invalidate();
    };
    const stop = async (repo: string): Promise<void> => {
        await api.sandbox.json(`/panels/${encodeURIComponent(repo)}/stop`, { method: `POST` });
        await invalidate();
    };

    return {
        panels: computed<PanelSummary[]>(() => query.data.value?.panels ?? []),
        error: computed(() => query.error.value?.message),
        isLoading: query.isLoading,
        start,
        stop,
    };
}
