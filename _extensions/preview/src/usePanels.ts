import { type PanelSummary, PanelsListSchema } from "@intentic/sandbox-contract";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { host } from "./host";

/* The workspace repositories' dev-server panels, via the daemon's /panels routes — runtime status
 * (running/healthy/previewUrl/port) plus start/stop. All daemon access goes through the host api.
 *
 * Unpolled, under the same key core's panel list uses: the process manager pushes when it launches or reaps a
 * session, and the daemon's port sampler pushes when the dev server actually binds — which is `start → healthy`
 * flipping, the thing this used to poll four seconds at a time to catch. */

export function usePanels() {
    const api = host();
    const queryClient = useQueryClient();
    const queryKey = api.sandbox.key(`panels`);

    const query = useQuery({
        queryKey,
        queryFn: async () => PanelsListSchema.parse(await api.sandbox.json(`/panels`)),
        enabled: computed(() => api.sandbox.reachable()),
    });

    const invalidate = (): Promise<void> => queryClient.invalidateQueries({ queryKey });
    const start = async (repo: string): Promise<void> => {
        await api.sandbox.json(`/panels/${encodeURIComponent(repo)}/start`, { method: `POST` });
        // Fire-and-forget: the refetch (which also kicks the running-panel poll) needn't gate the caller's
        // busy state — panel health flows through the reactive query either way.
        void invalidate();
    };
    const stop = async (repo: string): Promise<void> => {
        await api.sandbox.json(`/panels/${encodeURIComponent(repo)}/stop`, { method: `POST` });
        void invalidate();
    };

    return {
        panels: computed<PanelSummary[]>(() => query.data.value?.panels ?? []),
        error: computed(() => query.error.value?.message),
        isLoading: query.isLoading,
        start,
        stop,
    };
}
