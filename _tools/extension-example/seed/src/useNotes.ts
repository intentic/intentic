import { useQuery } from "@tanstack/vue-query";
import { computed } from "vue";
import { host } from "./host";
import { type Note, readNotes } from "./notes";

/* The view's read. Two things here are the extension contract rather than style:
 *
 * The key's FIRST part is `example-notes`, which is the string the manifest's `contributes.files` entry names in
 * `invalidates`. That is the whole wiring: the agent's CLI writes `.intentic/example-notes.json`, the daemon's
 * watcher matches the declared path prefix, and this query refetches. No poll, no subscribe, nothing to
 * unsubscribe, and the owner saw at install which file this extension reads.
 *
 * The key is minted by `api.sandbox.key(...)`, which suffixes the active sandbox id, so a cache entry cannot
 * bleed across a sandbox switch. `enabled` gates on reachability the same way, a query that fires at an
 * unreachable daemon just produces an error the user can do nothing about. */
export const useNotes = () => {
    const api = host();
    const query = useQuery({
        queryKey: api.sandbox.key(`example-notes`),
        queryFn: readNotes,
        enabled: computed(() => api.sandbox.reachable()),
    });
    // The owner's own setting, read synchronously, the host loads declared settings before activate() runs.
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
