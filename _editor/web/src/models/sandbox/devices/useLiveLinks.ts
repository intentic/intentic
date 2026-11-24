import type { ForticlientConnection, VpnLink } from "@intentic/sandbox-contract/schemas/vpn";
import type { NetdiskLink } from "@intentic/sandbox-contract/schemas/netdisk";
import { useQueryClient } from "@tanstack/vue-query";
import { computed, type ComputedRef } from "vue";
import { untilResult } from "../../../lib/intenticStream";
import { rpcKey } from "../../../lib/queryKeys";
import { rpcQuery } from "../../../client/sandbox/rpcQuery";
import { SandboxHttpError } from "../../../client/sandbox/sandboxHttpError";
import { sandboxRpc } from "../../../client/sandbox/sandboxRpc";
import { useSandboxQuery } from "../../../client/sandbox/useSandboxQuery";
import { t } from "@intentic/ui/i18n";

// Live tunnels and disks: state is read back from the OS, so a link the agent opens or drops outside the UI shows up.

export interface LinkOf {
    readonly vpn: VpnLink;
    readonly netdisk: NetdiskLink;
}
export type LinkKind = keyof LinkOf;

// Fast while a tunnel dials; the slow poll still catches a link dropped from a shell.
const TRANSIENT_POLL_MS = 2000;
const STEADY_POLL_MS = 15_000;

// Each kind's own daemon calls and words, so a link kind is one entry here. Words are built when read, so they follow
// the language on screen.
interface LinkCalls {
    readonly list: ReturnType<typeof rpcQuery<`vpn.list`>> | ReturnType<typeof rpcQuery<`netdisk.list`>>;
    readonly open: (id: string, otp: string | undefined) => ReturnType<typeof sandboxRpc.vpn.connect>;
    readonly close: (id: string) => Promise<void>;
    readonly refused: (status: number | undefined) => string;
    readonly failed: () => string;
}
const LINK_CALLS = {
    vpn: () => ({
        list: rpcQuery(`vpn.list`),
        open: (id, otp) => sandboxRpc.vpn.connect({ id, ...(otp === undefined || otp === `` ? {} : { otp }) }),
        close: async (id) => {
            await sandboxRpc.vpn.disconnect({ id });
        },
        refused: (status) => t(`sandbox.useLiveLinks.vpnRefused`, { status: String(status) }),
        failed: () => t(`sandbox.useLiveLinks.vpnFailed`),
    }),
    netdisk: () => ({
        list: rpcQuery(`netdisk.list`),
        open: (id) => sandboxRpc.netdisk.mount({ id }),
        close: async (id) => {
            await sandboxRpc.netdisk.unmount({ id });
        },
        refused: (status) => t(`sandbox.useLiveLinks.diskRefused`, { status: String(status) }),
        failed: () => t(`sandbox.useLiveLinks.diskFailed`),
    }),
} satisfies { readonly [K in LinkKind]: () => LinkCalls };

// Parses an exported FortiClient config into addable connections; nothing is stored until the capability add.
export const importForticlient = async (xml: string): Promise<ForticlientConnection[]> =>
    (await sandboxRpc.vpn.importForticlient({ xml })).connections;

export function useLiveLinks<K extends LinkKind>(
    kind: K,
): {
    links: ComputedRef<LinkOf[K][]>;
    error: ComputedRef<string | undefined>;
    open: (id: string, onLine?: (message: string) => void, otp?: string) => Promise<void>;
    close: (id: string) => Promise<void>;
} {
    const queryClient = useQueryClient();
    const calls = LINK_CALLS[kind]();
    const { list } = calls;
    const { query, error } = useSandboxQuery<{ links: (VpnLink | NetdiskLink)[] }>({
        ...list,
        refetchInterval: (state) =>
            state.state.data?.links.some((link) => link.state === `connecting`)
                ? TRANSIENT_POLL_MS
                : (state.state.data?.links.length ?? 0) > 0
                  ? STEADY_POLL_MS
                  : false,
    });

    // Both caches, so the Capabilities page and this list never disagree about one link.
    const invalidate = async (): Promise<void> => {
        await Promise.all([
            queryClient.invalidateQueries({ queryKey: rpcKey(`${kind}.list`) }),
            queryClient.invalidateQueries({ queryKey: rpcKey(`capabilities.list`) }),
        ]);
    };

    // Throws the daemon's own message on an error frame: a refused password or certificate needs reading, not a toast.
    const open = async (id: string, onLine?: (message: string) => void, otp?: string): Promise<void> => {
        const opening = calls.open(id, otp);
        const lines = await opening.catch((failure: unknown) => {
            throw failure instanceof SandboxHttpError ? new Error(failure.said.message ?? calls.refused(failure.status)) : failure;
        });
        try {
            await untilResult(lines, {
                failed: calls.failed,
                onLine: (line) => {
                    const message = line[`message`];
                    if (typeof message === `string`) {
                        onLine?.(message);
                    }
                },
            });
        } finally {
            // A failed open can still move the state (a half-negotiated tunnel), so re-read either way.
            await invalidate();
        }
    };

    const close = async (id: string): Promise<void> => {
        await calls.close(id);
        await invalidate();
    };

    return { links: computed(() => (query.data.value?.links ?? []) as LinkOf[K][]), error, open, close };
}
