import { useQuery } from "@tanstack/vue-query";
import { computed, type ComputedRef } from "vue";
import { host } from "./host";

// What a capability catalog entry tells a draft row: the platform's display name and brand slug, including
// the detail nothing here could guess (X's mark is black, so its entry forces a light one).
export interface PlatformCatalogEntry {
    readonly name: string;
    readonly logo?: string | undefined;
}

/* WHO POSTS IT, from the manifest that owns that fact. */
export function usePlatformCatalog(): ComputedRef<Map<string, PlatformCatalogEntry>> {
    const api = host();
    const query = useQuery({
        queryKey: api.sandbox.key(`extensions`),
        queryFn: () => api.sandbox.rpc.extensions.list(),
        enabled: computed(() => api.sandbox.reachable()),
    });
    return computed(
        () =>
            new Map(
                (query.data.value?.extensions ?? [])
                    .filter((extension) => extension.enabled)
                    .flatMap((extension) => extension.manifest.contributes?.capabilities ?? [])
                    .map((contribution) => [contribution.id, { name: contribution.catalog.name, logo: contribution.catalog.logo }] as const),
            ),
    );
}
