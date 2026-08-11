import { ExtensionsListSchema } from "@intentic/sandbox-contract";
import { useQuery } from "@tanstack/vue-query";
import { computed, type ComputedRef } from "vue";
import { host } from "./host";

// What a capability catalog entry tells a draft row: the platform's display name and brand slug — including
// the detail nothing here could guess (X's mark is black, so its entry forces a light one).
export interface PlatformCatalogEntry {
    readonly name: string;
    readonly logo?: string | undefined;
}

/* WHO POSTS IT, from the manifest that owns that fact. A draft's `platform` is a bare string by contract (a
 * new platform needs no contract change) and it is the id of the capability whose skill does the posting — so
 * the enabled packs' own catalog entries already hold its display name and brand. Read through the same
 * `extensions` cache key the shell uses, which the daemon's file push invalidates when a pack changes.
 *
 * A platform with no installed connector still renders (BrandMark falls through to a monogram), and that is
 * the case that has to keep working: a draft can be proposed for somewhere this sandbox cannot yet post. */
export function usePlatformCatalog(): ComputedRef<Map<string, PlatformCatalogEntry>> {
    const api = host();
    const query = useQuery({
        queryKey: api.sandbox.key(`extensions`),
        queryFn: async () => ExtensionsListSchema.parse(await api.sandbox.json(`/extensions`)),
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
