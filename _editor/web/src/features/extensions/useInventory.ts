import type { AddInventoryInput, InventoryEntry } from "@intentic/sandbox-contract";
import { useMutation, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { rpcKey } from "../../lib/queryKeys";
import { rpcQuery } from "../../client/sandbox/rpcQuery";
import { sandboxRpc } from "../../client/sandbox/sandboxRpc";
import { useSandboxQuery } from "../../client/sandbox/useSandboxQuery";

/* The sandbox's inventory, the i.have.* / i.want.service entries in its intent repo deploy.config.ts. Every write
   answers with the whole updated list, which replaces the cached one. */

export function useInventory() {
    const queryClient = useQueryClient();

    const { query, error } = useSandboxQuery(rpcQuery(`inventory.list`));

    const add = useMutation({
        mutationFn: (input: AddInventoryInput) => sandboxRpc.inventory.add(input),
        onSuccess: (list) => queryClient.setQueryData(rpcKey(`inventory.list`), list),
    });

    const remove = useMutation({
        mutationFn: (name: string) => sandboxRpc.inventory.remove({ name }),
        onSuccess: (list) => queryClient.setQueryData(rpcKey(`inventory.list`), list),
    });

    return {
        entries: computed<InventoryEntry[]>(() => query.data.value?.entries ?? []),
        error,
        isLoading: query.isLoading,
        refetch: query.refetch,
        add,
        remove,
    };
}
