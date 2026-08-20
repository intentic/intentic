import { type Persona, PersonasListSchema } from "@intentic/sandbox-contract";
import { useQuery } from "@tanstack/vue-query";
import { computed } from "vue";
import { host } from "./host";

/* The workspace's persona cards, for the step inspector's "acts as" pin. Read-only here, the cards are
 * authored on the Personas page; this extension only ever points a step at one by id. Cached under the host's
 * sandbox-scoped key like every other read, so the inspector and the designer share one fetch. */
export function usePersonas() {
    const api = host();
    const query = useQuery({
        queryKey: api.sandbox.key(`personas`),
        queryFn: async (): Promise<Persona[]> => PersonasListSchema.parse(await api.sandbox.json(`/personas`)).personas,
        enabled: computed(() => api.sandbox.reachable()),
    });
    return { personas: computed<Persona[]>(() => query.data.value ?? []) };
}
