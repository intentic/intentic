import { type AddInventoryInput, type InventoryEntry, InventoryEntrySchema } from "@intentic-app/api-contract";
import { useMutation, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { sandboxError, sandboxRequest } from "../sandbox/sandboxClient";
import { jsonBody } from "../sandbox/jsonBody";
import { INVENTORY } from "../queryKeys";
import { useSandboxQuery } from "../sandbox/useSandboxQuery";

/* The sandbox's inventory — the i.have.* / i.want.service entries in its intent repo deploy.config.ts. Read +
 * rewritten DIRECTLY in the sandbox via the daemon's /inventory routes (the daemon owns the file + commits the
 * edits — the repo is the source of truth). Read via vue-query; add / remove are mutations that seed the cache
 * with the fresh entries the daemon returns. Drives the infrastructure extension. */

// Call a daemon /inventory route and validate the `{ entries }` it returns at the boundary (the daemon
// produces the shape this contract mirrors — validated here so a cross-repo drift fails loudly).
const fetchEntries = async (path: string, init?: RequestInit): Promise<InventoryEntry[]> => {
    const response = await sandboxRequest(path, init);
    if (!response.ok) {
        throw await sandboxError(response, { method: init?.method ?? `GET`, path });
    }
    const body = (await response.json()) as { entries?: unknown };
    return InventoryEntrySchema.array().parse(body.entries ?? []);
};

export function useInventory() {
    const queryClient = useQueryClient();
    const queryKey = INVENTORY.of();

    const { query, error } = useSandboxQuery({
        queryKey,
        queryFn: () => fetchEntries(`/inventory`),
    });

    const add = useMutation({
        mutationFn: (input: AddInventoryInput) => fetchEntries(`/inventory`, jsonBody(`POST`, input)),
        onSuccess: (entries) => queryClient.setQueryData(queryKey, entries),
    });

    const remove = useMutation({
        mutationFn: (name: string) => fetchEntries(`/inventory/${encodeURIComponent(name)}`, { method: `DELETE` }),
        onSuccess: (entries) => queryClient.setQueryData(queryKey, entries),
    });

    return {
        entries: computed<InventoryEntry[]>(() => query.data.value ?? []),
        error,
        isLoading: query.isLoading,
        refetch: query.refetch,
        add,
        remove,
    };
}
