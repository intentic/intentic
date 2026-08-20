import { type Persona, PersonasListSchema } from "@intentic/sandbox-contract";
import { useMutation, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { jsonBody } from "./jsonBody";
import { sandboxJson } from "./sandboxClient";
import { PERSONAS } from "../queryKeys";
import { useSandboxQuery } from "./useSandboxQuery";

/* The sandbox's named personas (.intentic/config/personas.json), read/written via the daemon's /personas routes.
 * Unlike a capability there is no apply and no stream to follow: saving a card provisions nothing and removing
 * one disconnects nothing, so both are plain mutations that end in a refetch.
 *
 * The list carries `connected` alongside the cards, which of the accounts they name this sandbox is actually
 * signed into, because a card that cannot act yet is the ordinary state of a freshly cloned workspace, and a
 * surface that showed only the cards would present a persona as working when it is one login short. */

const QUERY_KEY = PERSONAS.of();

const fetchPersonas = async (): Promise<{ personas: Persona[]; connected: string[] }> => PersonasListSchema.parse(await sandboxJson(`/personas`));

export function usePersonas() {
    const queryClient = useQueryClient();
    const { query, error } = useSandboxQuery({ queryKey: QUERY_KEY, queryFn: fetchPersonas });

    /* Only this list moves. A card names capabilities but owns none of them, so nothing about the capability
     * manifest, the environment or the panels can have changed, invalidating them here would refetch three
     * caches to observe that they are identical. */
    const invalidate = (): Promise<void> => queryClient.invalidateQueries({ queryKey: QUERY_KEY });

    // Upsert by id: re-saving an existing id edits that card, which is what the routes' whole-card `save` is for.
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
        // Whether a given account id is signed in far enough to act. Asked per account rather than per card,
        // because a persona naming three accounts with one connected is still useful, it simply reaches the one.
        isConnected: (capabilityId: string): boolean => connected.value.includes(capabilityId),
        error,
        isLoading: query.isLoading,
        save,
        remove,
    };
}
