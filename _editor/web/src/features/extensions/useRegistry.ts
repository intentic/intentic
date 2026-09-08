import type { Marketplace } from "@intentic/api-contract";
import { OFFICIAL_REGISTRY_URL, type RegistryEntry } from "@intentic/registry";
import { computed, type MaybeRefOrGetter, ref, toValue } from "vue";
import { REGISTRY } from "../../lib/queryKeys";
import { useSandboxQuery } from "../sandbox/client/useSandboxQuery";
import { browseMarketplace } from "../capabilities/connect/useCapabilities";

// Registry browsing as a cached query keyed on the URL, not an imperative action, so Discover opens with a list already
// showing. A browse is a daemon-side clone, so it's cached hard (5-minute stale, no refetch on mount); the URL is
// module state, not per-caller, since Discover and the hub's newer-commit badge must share one registry.

// Session-scoped, not URL-based: a token in the address bar ends up in browser history.
const registryUrl = ref(OFFICIAL_REGISTRY_URL);
const registryToken = ref(``);

/** True while the surface is reading the registry it ships with rather than one somebody typed. */
const isOfficialRegistry = computed(() => registryUrl.value.trim() === OFFICIAL_REGISTRY_URL);

// `read: false` lets a caller (the hub's newer-commit badge) observe the cached registry without triggering its clone.
// Takes a getter, not a boolean, since the Extensions section switches between reading and not.
export function useRegistry({ read = true }: { read?: MaybeRefOrGetter<boolean> } = {}) {
    const url = computed(() => registryUrl.value.trim());
    const token = computed(() => registryToken.value.trim());

    const { query, error } = useSandboxQuery<Marketplace>({
        // Token isn't in the key: it's a credential, not a different registry, and the key persists in the cache.
        queryKey: computed(() => REGISTRY.of(url.value)),
        queryFn: () => browseMarketplace(url.value, token.value === `` ? undefined : token.value),
        enabled: computed(() => toValue(read) && url.value.length > 0),
        staleTime: 5 * 60_000,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
        // One retry: a registry that can't clone won't start working on the second attempt either.
        retry: 1,
    });

    // Extensions only; a plugin is agent configuration and has its own install surface on the Capabilities page.
    const entries = computed<readonly RegistryEntry[]>(() => (query.data.value?.plugins ?? []).filter((entry) => entry.kind === `extension`));

    return {
        entries,
        // What the registry calls itself, for the source line. Undefined until the first read lands.
        registryName: computed<string | undefined>(() => query.data.value?.name),
        url: registryUrl,
        token: registryToken,
        isOfficial: isOfficialRegistry,
        // True only for the first fetch; a background refresh over a list already on screen must not blank it.
        isLoading: computed(() => query.isFetching.value && entries.value.length === 0),
        isFetching: computed(() => query.isFetching.value),
        error,
        refetch: (): void => void query.refetch(),
        /** Points the surface at a different registry; clears the token, since it belonged to the old one. */
        useRegistryAt: (next: string, nextToken: string): void => {
            registryUrl.value = next.trim();
            registryToken.value = nextToken.trim();
        },
        resetRegistry: (): void => {
            registryUrl.value = OFFICIAL_REGISTRY_URL;
            registryToken.value = ``;
        },
    };
}
