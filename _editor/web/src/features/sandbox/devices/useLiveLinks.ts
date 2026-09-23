import type { ForticlientConnection, NetdiskLink, VpnLink } from "@intentic/sandbox-contract";
import { useQueryClient } from "@tanstack/vue-query";
import { computed, type ComputedRef } from "vue";
import { readIntenticLines } from "../../../lib/intenticStream";
import { rpcKey } from "../../../lib/queryKeys";
import { rpcQuery } from "../client/rpcQuery";
import { SandboxHttpError } from "../client/sandboxHttpError";
import { sandboxRpc } from "../client/sandboxRpc";
import { useSandboxQuery } from "../client/useSandboxQuery";

// Live tunnels and disks: state is read back from the OS, so a link the agent opens or drops outside the UI shows up.

export interface LinkOf {
    readonly vpn: VpnLink;
    readonly netdisk: NetdiskLink;
}
export type LinkKind = keyof LinkOf;

// Fast while a tunnel dials; the slow poll still catches a link dropped from a shell.
const TRANSIENT_POLL_MS = 2000;
const STEADY_POLL_MS = 15_000;

const OPENING: { readonly [K in LinkKind]: { readonly refused: string; readonly failed: string } } = {
    vpn: { refused: `Could not connect the VPN`, failed: `The VPN could not connect.` },
    netdisk: { refused: `Could not mount the disk`, failed: `The disk could not be mounted.` },
};

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
    const list = kind === `vpn` ? rpcQuery(`vpn.list`) : rpcQuery(`netdisk.list`);
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
        const words = OPENING[kind];
        const opening = kind === `vpn` ? sandboxRpc.vpn.connect({ id, ...(otp === undefined || otp === `` ? {} : { otp }) }) : sandboxRpc.netdisk.mount({ id });
        const lines = await opening.catch((failure: unknown) => {
            throw failure instanceof SandboxHttpError ? new Error(failure.said.message ?? `${words.refused} (${failure.status}).`) : failure;
        });
        try {
            for await (const line of readIntenticLines(lines)) {
                const message = line[`message`];
                if (typeof message === `string`) {
                    onLine?.(message);
                }
                if (line[`kind`] === `error`) {
                    throw new Error(typeof message === `string` ? message : words.failed);
                }
            }
        } finally {
            // A failed open can still move the state (a half-negotiated tunnel), so re-read either way.
            await invalidate();
        }
    };

    const close = async (id: string): Promise<void> => {
        await (kind === `vpn` ? sandboxRpc.vpn.disconnect({ id }) : sandboxRpc.netdisk.unmount({ id }));
        await invalidate();
    };

    return { links: computed(() => (query.data.value?.links ?? []) as LinkOf[K][]), error, open, close };
}
