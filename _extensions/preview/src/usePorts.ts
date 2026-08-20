import { type PortForwardResult, PortsListSchema, type PortSummary } from "@intentic/sandbox-contract";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { host } from "./host";

/* The sandbox's listening TCP ports, via the daemon's /ports routes, the generic complement to panels:
 * anything run in a terminal (a turbo TUI's dev servers, an ad-hoc `python -m http.server`) shows up here,
 * and `forward` exposes one at its port-<slot> preview hostname. All daemon access goes through the host api.
 *
 * Unpolled: the daemon watches its own listening sockets and pushes the `ports` domain when the set changes, and
 * this query asks under the key that push names (api.sandbox.key("ports") IS the core shell's key), so the open
 * view and the shell's forwarded-port indicator refresh together off one frame. A port appearing as a dev server
 * boots now shows up in about two seconds instead of up to four, while a view left open on a quiet sandbox costs
 * nothing at all. */

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
        // The caller navigates on the returned previewUrl, the list refresh must not gate it (the poll
        // reconverges anyway), so fire-and-forget.
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
