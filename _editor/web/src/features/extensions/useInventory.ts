import type { AddInventoryInput, InventoryEntry } from "@intentic/api-contract";
import { useMutation, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { rpcKey } from "../../lib/queryKeys";
import { rpcQuery } from "../sandbox/client/rpcQuery";
import { sandboxRpc } from "../sandbox/client/sandboxRpc";
import { useSandboxQuery } from "../sandbox/client/useSandboxQuery";

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
