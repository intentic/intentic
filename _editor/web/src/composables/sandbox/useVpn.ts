import { type ForticlientConnection, ForticlientImportSchema, type VpnLink, VpnListSchema } from "@intentic/sandbox-contract";
import { useQueryClient } from "@tanstack/vue-query";
import { computed, type ComputedRef, type Ref } from "vue";
import { readIntenticLines } from "../intenticStream";
import { sandboxJson, sandboxRequest } from "./sandboxClient";
import { jsonBody } from "./jsonBody";
import { CAPABILITIES, VPN } from "../queryKeys";
import { useSandboxQuery } from "./useSandboxQuery";

/* The sandbox's VPN tunnels, live, from the daemon's /vpn routes. A VPN is ADDED as a capability (credentials,
 * auto-connect — the Capabilities page); it is DIALLED here, which is why this is its own composable rather
 * than a slice of useCapabilities: connecting is a repeated runtime action with a much richer result than a
 * capability's {state, detail}.
 *
 * The daemon reads every field back from the OS, so this is also how the UI stays truthful about tunnels the
 * AGENT dialled or dropped through its own `vpn` command — there is one state, not two. */

const QUERY_KEY = VPN.of();
// A dial takes seconds and passes through "connecting"; poll while anything is mid-flight so the card settles
// on its own. A steady list still refreshes on the slower default so an externally-dropped tunnel shows up.
const TRANSIENT_POLL_MS = 2000;
const STEADY_POLL_MS = 15_000;

// Parse an exported FortiClient config into addable connections. Read-only and cache-free — nothing is stored
// until the user picks one and submits the ordinary capability add — so it lives outside the composable.
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
        // A VPN's capability row carries the same state under a different shape — refresh both so the
        // Capabilities page and the Status card never disagree about one tunnel.
        await Promise.all([queryClient.invalidateQueries({ queryKey: QUERY_KEY }), queryClient.invalidateQueries({ queryKey: CAPABILITIES.of() })]);
    };

    // POST + read the streamed dial, calling onLine per frame; throws with the daemon's message on an error
    // frame — a rejected password or an untrusted certificate is something the user must read, not a toast.
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
            // Even a failed dial can have moved the tunnel (a half-negotiated IPsec SA) — re-read either way.
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
