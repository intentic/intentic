import type { Persona } from "@intentic/sandbox-contract";
import { useMutation, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { rpcQuery } from "../client/rpcQuery";
import { sandboxRpc } from "../client/sandboxRpc";
import { rpcKey } from "../../../lib/queryKeys";
import { useSandboxQuery } from "../client/useSandboxQuery";

// Named personas (`.intentic/config/personas.json`) via the daemon's personas routes; saving or removing is a
// plain mutation plus refetch, no apply or stream. `connected` lists which named accounts this sandbox is actually
// signed into, separate from the personas.

export function usePersonas() {
    const queryClient = useQueryClient();
    const { query, error } = useSandboxQuery(rpcQuery(`personas.list`));

    // Invalidates only this list; capabilities, environment and panels are unaffected.
    const invalidate = (): Promise<void> => queryClient.invalidateQueries({ queryKey: rpcKey(`personas.list`) });

    // Upsert by id: saving an existing id edits that persona.
    const save = useMutation({
        mutationFn: (persona: Persona) => sandboxRpc.personas.save(persona),
        onSuccess: invalidate,
    });
    const remove = useMutation({
        mutationFn: (id: string) => sandboxRpc.personas.remove({ id }),
        onSuccess: invalidate,
    });

    const personas = computed<Persona[]>(() => query.data.value?.personas ?? []);
    const connected = computed<string[]>(() => query.data.value?.connected ?? []);
    return {
        personas,
        connected,
        // Checked per account id, not per persona: a persona naming three accounts needs only one connected.
        isConnected: (capabilityId: string): boolean => connected.value.includes(capabilityId),
        error,
        isLoading: query.isLoading,
        save,
        remove,
    };
}
