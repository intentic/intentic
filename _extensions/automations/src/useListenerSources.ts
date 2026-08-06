import { ExtensionsListSchema } from "@intentic/sandbox-contract";
import { useQuery } from "@tanstack/vue-query";
import { computed } from "vue";
import { host } from "./host";
import { listenerSourcesOf } from "./listenerSources";

/* Installed listener contributions through the same `extensions` cache the shell uses. The daemon's file push
 * invalidates that key when a workspace extension changes, and capability facts are already reactive host state,
 * so installing, switching or connecting a provider updates the picker without a reload or a second catalog. */
export function useListenerSources() {
    const api = host();
    const query = useQuery({
        queryKey: api.sandbox.key("extensions"),
        queryFn: async () => ExtensionsListSchema.parse(await api.sandbox.json("/extensions")),
        enabled: computed(() => api.sandbox.reachable()),
    });
    return {
        sources: computed(() => listenerSourcesOf(query.data.value?.extensions ?? [], api.workspace.capabilities())),
        error: computed(() => query.error.value?.message),
    };
}
