import type { SandboxKeyring } from "@intentic/sandbox-contract";
import { useMutation, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { rpcQuery } from "../../../../client/sandbox/rpcQuery";
import { sandboxRpc } from "../../../../client/sandbox/sandboxRpc";
import { useSandboxQuery } from "../../../../client/sandbox/useSandboxQuery";
import { rpcKey } from "../../../../lib/queryKeys";

// The keyrings on the owner's computers this sandbox can reach: where a secret can be kept instead of here, and where
// one can be typed. Names and counts only. A read that fails leaves the list empty, so a daemon older than these routes
// draws a Secrets view and a need card with no keyring in them rather than an error about a feature it never had.

export function useKeyrings() {
    const queryClient = useQueryClient();
    const { query, error } = useSandboxQuery(rpcQuery(`secrets.keyrings`));
    const keyrings = computed<readonly SandboxKeyring[]>(() => query.data.value?.keyrings ?? []);
    const refresh = (): void => void queryClient.invalidateQueries({ queryKey: rpcKey(`secrets.keyrings`) });
    // Waits on a yes at both computers, which can take a person minutes: no headers deadline.
    const pair = useMutation({
        mutationFn: (input: { a: string; b: string }) => sandboxRpc.secrets.keyringPair(input, { context: { deadline: false } }),
        onSuccess: refresh,
    });
    return {
        keyrings,
        /** The ones that answer now: the only ones a value can be typed on or sent to. */
        online: computed(() => keyrings.value.filter((keyring) => keyring.online)),
        keyringsPending: computed(() => query.isPending.value),
        keyringsError: error,
        refreshKeyrings: refresh,
        pair,
    };
}

// The owner's Type into…: one secret typed into whatever has focus on one of their computers. Its last use moves, so the
// inventory is read again however it ended.
export function useTypeInto() {
    const queryClient = useQueryClient();
    const typeInto = useMutation({
        // The keyring there may wait on Windows Hello or its passphrase for up to two minutes: no headers deadline.
        mutationFn: (input: { key: string; device: string; countdownSeconds: number }) =>
            sandboxRpc.secrets.typeInto(input, { context: { deadline: false } }),
        onSettled: () => void queryClient.invalidateQueries({ queryKey: rpcKey(`secrets.inventory`) }),
    });
    return { typeInto };
}
