import { useQuery } from "@tanstack/vue-query";
import { computed } from "vue";
import { host } from "./host";
import { type Note, readNotes } from "./notes";

// queryKey's first segment (`example-notes`) must match the manifest's `contributes.files` invalidates name: the whole
// push wiring. api.sandbox.key() suffixes the sandbox id so cache can't bleed across a switch.
export const useNotes = () => {
    const api = host();
    const query = useQuery({
        queryKey: api.sandbox.key(`example-notes`),
        queryFn: readNotes,
        enabled: computed(() => api.sandbox.reachable()),
    });
    // Read synchronously: the host loads declared settings before activate() runs.
    const limit = computed(() => Number(api.settings.get(`limit`) ?? 5));
    const all = computed<readonly Note[]>(() => query.data.value ?? []);
    return {
        all,
        shown: computed(() => all.value.slice(0, limit.value)),
        limit,
        isLoading: computed(() => query.isLoading.value),
        refetch: query.refetch,
    };
};
