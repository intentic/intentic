import { type Persona, PersonasListSchema } from "@intentic/sandbox-contract";
import { useMutation, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { jsonBody } from "../client/jsonBody";
import { sandboxJson } from "../client/sandboxClient";
import { PERSONAS } from "../../../lib/queryKeys";
import { useSandboxQuery } from "../client/useSandboxQuery";

// Named personas (`.intentic/config/personas.json`) via the daemon's `/personas` routes; saving or removing is a
// plain mutation plus refetch, no apply or stream. `connected` lists which named accounts this sandbox is actually
// signed into, separate from the cards.

const QUERY_KEY = PERSONAS.of();

const fetchPersonas = async (): Promise<{ personas: Persona[]; connected: string[] }> => PersonasListSchema.parse(await sandboxJson(`/personas`));

export function usePersonas() {
    const queryClient = useQueryClient();
    const { query, error } = useSandboxQuery({ queryKey: QUERY_KEY, queryFn: fetchPersonas });

    // Invalidates only this list; capabilities, environment and panels are unaffected.
    const invalidate = (): Promise<void> => queryClient.invalidateQueries({ queryKey: QUERY_KEY });

    // Upsert by id: saving an existing id edits that card.
    const save = useMutation({
        mutationFn: (persona: Persona) => sandboxJson(`/personas`, jsonBody(`POST`, persona)),
        onSuccess: invalidate,
    });
    const remove = useMutation({
        mutationFn: (id: string) => sandboxJson(`/personas/${encodeURIComponent(id)}`, { method: `DELETE` }),
        onSuccess: invalidate,
    });

    const personas = computed<Persona[]>(() => query.data.value?.personas ?? []);
    const connected = computed<string[]>(() => query.data.value?.connected ?? []);
    return {
        personas,
        connected,
        // Checked per account id, not per persona: a card naming three accounts needs only one connected.
        isConnected: (capabilityId: string): boolean => connected.value.includes(capabilityId),
        error,
        isLoading: query.isLoading,
        save,
        remove,
    };
}
