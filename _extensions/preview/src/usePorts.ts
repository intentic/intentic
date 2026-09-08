import { type PortForwardResult, PortsListSchema, type PortSummary } from "@intentic/sandbox-contract";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { host } from "./host";

// Sandbox's listening TCP ports via the daemon's /ports routes, the generic complement to panels; `forward` exposes one
// at its port-<slot> hostname. Unpolled: shares the daemon's push key (`ports`) with the shell's own indicator, so both
// refresh off one frame.

const jsonPost = (body: unknown): RequestInit => ({ method: `POST`, headers: { "content-type": `application/json` }, body: JSON.stringify(body) });

export function usePorts() {
    const api = host();
    const queryClient = useQueryClient();
    const queryKey = api.sandbox.key(`ports`);

    const query = useQuery({
        queryKey,
        queryFn: async () => PortsListSchema.parse(await api.sandbox.json(`/ports`)),
        enabled: computed(() => api.sandbox.reachable()),
    });

    const invalidate = (): Promise<void> => queryClient.invalidateQueries({ queryKey });
    const forward = async (port: number): Promise<string | undefined> => {
        const result = await api.sandbox.json<PortForwardResult>(`/ports/forward`, jsonPost({ port }));
        // Fire-and-forget: the caller navigates on previewUrl immediately, so refresh must not gate it.
        void invalidate();
        return result.previewUrl;
    };
    const unforward = async (port: number): Promise<void> => {
        await api.sandbox.json(`/ports/unforward`, jsonPost({ port }));
        void invalidate();
    };

    return {
        ports: computed<PortSummary[]>(() => query.data.value?.ports ?? []),
        error: computed(() => query.error.value?.message),
        isLoading: query.isLoading,
        forward,
        unforward,
    };
}
