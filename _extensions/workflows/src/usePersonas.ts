import type { Persona } from "@intentic/sandbox-contract";
import { useQuery } from "@tanstack/vue-query";
import { computed } from "vue";
import { host } from "./host";

/* The workspace's persona cards, for the step inspector's "acts as" pin. */
export function usePersonas() {
    const api = host();
    const query = useQuery({
        // The procedure's whole answer under its own key, shared with every other reader of the persona list.
        queryKey: api.sandbox.readKey(`personas.list`),
        queryFn: () => api.sandbox.rpc.personas.list(),
        select: (answer): Persona[] => answer.personas,
        enabled: computed(() => api.sandbox.reachable()),
    });
    return { personas: computed<Persona[]>(() => query.data.value ?? []) };
}
