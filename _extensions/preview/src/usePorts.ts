import type { PortSummary } from "@intentic/sandbox-contract";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { host } from "./host";

// Sandbox's listening TCP ports via the daemon's `ports` procedures, the generic complement to panels; `forward`
// exposes one at its port-<slot> hostname. Unpolled: shares the daemon's push key (`ports`) with the shell's own
// indicator, so both refresh off one frame.

export function usePorts() {
    const api = host();
    const queryClient = useQueryClient();
    const queryKey = api.sandbox.key(`ports`);

    const query = useQuery({
        queryKey,
        queryFn: () => api.sandbox.rpc.ports.list(),
        enabled: computed(() => api.sandbox.reachable()),
    });

    const invalidate = (): Promise<void> => queryClient.invalidateQueries({ queryKey });
    const forward = async (port: number): Promise<string | undefined> => {
        const result = await api.sandbox.rpc.ports.forward({ port });
        // Fire-and-forget: the caller navigates on previewUrl immediately, so refresh must not gate it.
        void invalidate();
        return result.previewUrl;
    };
    const unforward = async (port: number): Promise<void> => {
        await api.sandbox.rpc.ports.unforward({ port });
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
