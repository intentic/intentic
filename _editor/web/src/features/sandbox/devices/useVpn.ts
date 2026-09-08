import { type ForticlientConnection, ForticlientImportSchema, type VpnLink, VpnListSchema } from "@intentic/sandbox-contract";
import { useQueryClient } from "@tanstack/vue-query";
import { computed, type ComputedRef, type Ref } from "vue";
import { readIntenticLines } from "../../../lib/intenticStream";
import { sandboxJson, sandboxRequest } from "../client/sandboxClient";
import { jsonBody } from "../client/jsonBody";
import { CAPABILITIES, VPN } from "../../../lib/queryKeys";
import { useSandboxQuery } from "../client/useSandboxQuery";

// Live VPN tunnels from the daemon's /vpn routes. A VPN is added as a capability but dialled here, since
// connecting returns far more than a capability's {state, detail}. State always comes from the OS, so
// tunnels the agent dials or drops outside the UI show up too.

const QUERY_KEY = VPN.of();
// Fast poll while a link is connecting; slow poll otherwise still catches externally-dropped tunnels.
const TRANSIENT_POLL_MS = 2000;
const STEADY_POLL_MS = 15_000;

// Parses an exported FortiClient config into addable connections. Read-only and cache-free; nothing is
// stored until the user submits the ordinary capability add.
export const importForticlient = async (xml: string): Promise<ForticlientConnection[]> =>
    ForticlientImportSchema.parse(await sandboxJson(`/vpn/import-forticlient`, jsonBody(`POST`, { xml }))).connections;

export function useVpn(): {
    links: ComputedRef<VpnLink[]>;
    connected: ComputedRef<VpnLink[]>;
    isLoading: Ref<boolean>;
    error: ComputedRef<string | undefined>;
    connect: (id: string, otp?: string, onLine?: (message: string) => void) => Promise<void>;
    disconnect: (id: string) => Promise<void>;
    refetch: () => Promise<unknown>;
} {
    const queryClient = useQueryClient();
    const { query, error } = useSandboxQuery({
        queryKey: QUERY_KEY,
        queryFn: async () => VpnListSchema.parse(await sandboxJson(`/vpn`)),
        refetchInterval: (state) =>
            state.state.data?.links.some((link) => link.state === `connecting`)
                ? TRANSIENT_POLL_MS
                : (state.state.data?.links.length ?? 0) > 0
                  ? STEADY_POLL_MS
                  : false,
    });

    const invalidate = async (): Promise<void> => {
        // Refreshes both caches so the Capabilities page and the VPN card never disagree about one tunnel.
        await Promise.all([queryClient.invalidateQueries({ queryKey: QUERY_KEY }), queryClient.invalidateQueries({ queryKey: CAPABILITIES.of() })]);
    };

    // Streams the dial, calling onLine per frame; throws the daemon's message on an error frame, since a
    // rejected password or untrusted certificate needs to be read, not toasted.
    const connect = async (id: string, otp?: string, onLine?: (message: string) => void): Promise<void> => {
        const response = await sandboxRequest(
            `/vpn/${encodeURIComponent(id)}/connect`,
            jsonBody(`POST`, otp === undefined || otp === `` ? {} : { otp }),
        );
        if (!response.ok || !response.body) {
            const detail = (await response.json().catch(() => null)) as { message?: string } | null;
            throw new Error(detail?.message ?? `Could not connect the VPN (${response.status}).`);
        }
        try {
            for await (const line of readIntenticLines(response.body)) {
                const message = line[`message`];
                if (typeof message === `string`) {
                    onLine?.(message);
                }
                if (line[`kind`] === `error`) {
                    throw new Error(typeof message === `string` ? message : `The VPN could not connect.`);
                }
            }
        } finally {
            // A failed dial can still move the tunnel state (a half-negotiated SA), so re-read either way.
            await invalidate();
        }
    };

    const disconnect = async (id: string): Promise<void> => {
        await sandboxJson(`/vpn/${encodeURIComponent(id)}/disconnect`, { method: `POST` });
        await invalidate();
    };

    const links = computed<VpnLink[]>(() => query.data.value?.links ?? []);
    return {
        links,
        connected: computed(() => links.value.filter((link) => link.state === `connected`)),
        isLoading: query.isLoading,
        error,
        connect,
        disconnect,
        refetch: query.refetch,
    };
}
