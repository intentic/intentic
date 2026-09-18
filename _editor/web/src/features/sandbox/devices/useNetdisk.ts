import { type NetdiskLink, NetdiskListSchema } from "@intentic/sandbox-contract";
import { useQueryClient } from "@tanstack/vue-query";
import { computed, type ComputedRef, type Ref } from "vue";
import { readIntenticLines } from "../../../lib/intenticStream";
import { sandboxJson, sandboxRequest } from "../client/sandboxClient";
import { CAPABILITIES, NETDISK } from "../../../lib/queryKeys";
import { useSandboxQuery } from "../client/useSandboxQuery";

// Live network disks from the daemon's /netdisk routes. A disk is added as a capability but mounted here, since a
// mount returns more than a capability's {state, detail}: where it is and whether it takes writes. State always comes
// from the kernel, so disks the agent mounts or unmounts outside the UI show up too.

const QUERY_KEY = NETDISK.of();
// Slow poll only: a mount is synchronous, so the only thing to catch is a disk dropped from a shell.
const STEADY_POLL_MS = 15_000;

export function useNetdisk(): {
    links: ComputedRef<NetdiskLink[]>;
    isLoading: Ref<boolean>;
    error: ComputedRef<string | undefined>;
    mount: (id: string, onLine?: (message: string) => void) => Promise<void>;
    unmount: (id: string) => Promise<void>;
    refetch: () => Promise<unknown>;
} {
    const queryClient = useQueryClient();
    const { query, error } = useSandboxQuery({
        queryKey: QUERY_KEY,
        queryFn: async () => NetdiskListSchema.parse(await sandboxJson(`/netdisk`)),
        refetchInterval: (state) => ((state.state.data?.links.length ?? 0) > 0 ? STEADY_POLL_MS : false),
    });

    const invalidate = async (): Promise<void> => {
        // Refreshes both caches so the Capabilities page and the disk card never disagree about one disk.
        await Promise.all([queryClient.invalidateQueries({ queryKey: QUERY_KEY }), queryClient.invalidateQueries({ queryKey: CAPABILITIES.of() })]);
    };

    // Streams the mount, calling onLine per frame; throws the daemon's message on an error frame, since a refused
    // password or an unreachable server needs to be read, not toasted.
    const mount = async (id: string, onLine?: (message: string) => void): Promise<void> => {
        const response = await sandboxRequest(`/netdisk/${encodeURIComponent(id)}/mount`, { method: `POST` });
        if (!response.ok || !response.body) {
            const detail = (await response.json().catch(() => null)) as { message?: string } | null;
            throw new Error(detail?.message ?? `Could not mount the disk (${response.status}).`);
        }
        try {
            for await (const line of readIntenticLines(response.body)) {
                const message = line[`message`];
                if (typeof message === `string`) {
                    onLine?.(message);
                }
                if (line[`kind`] === `error`) {
                    throw new Error(typeof message === `string` ? message : `The disk could not be mounted.`);
                }
            }
        } finally {
            await invalidate();
        }
    };

    const unmount = async (id: string): Promise<void> => {
        await sandboxJson(`/netdisk/${encodeURIComponent(id)}/unmount`, { method: `POST` });
        await invalidate();
    };

    return {
        links: computed<NetdiskLink[]>(() => query.data.value?.links ?? []),
        isLoading: query.isLoading,
        error,
        mount,
        unmount,
        refetch: query.refetch,
    };
}
