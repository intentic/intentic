import type { Marketplace } from "@intentic-app/api-contract";
import { OFFICIAL_REGISTRY_URL, type RegistryEntry } from "@intentic/registry";
import { computed, ref } from "vue";
import { REGISTRY } from "../queryKeys";
import { useSandboxQuery } from "../sandbox/useSandboxQuery";
import { browseMarketplace } from "./useCapabilities";

/* BROWSING A REGISTRY, as a read rather than as a button.
 *
 * The Capabilities page treats this as an action: type a URL, press Browse, get a list. That is the right shape
 * for a field somebody fills in and the wrong one for a surface whose whole job is to already be showing
 * something. Discover opens on the official registry and has a list before anyone touches it, which is only
 * possible if the browse is a QUERY keyed on the registry rather than an imperative call with a result ref.
 *
 * IT IS A CLONE, so it is cached hard. The daemon answers this by cloning the registry repository and reading
 * two JSON files out of it; the curated file changes when somebody merges a pull request and the facts file
 * changes nightly, so a five-minute stale window is generous rather than stingy, and remounting the tab (which
 * the hub does on every section change) must not re-clone. Refetch-on-mount is off for the same reason.
 *
 * THE URL IS MODULE STATE, not per-caller. Two things read it, the Discover surface and the hub row that
 * badges how many installed extensions have a newer listed commit, and a caller-local ref would give the badge
 * a different registry from the list it is counting against the moment somebody pointed the field elsewhere. */

// Both live for the session rather than in the URL: a registry a company points at is a preference, not a
// location, and putting a token in an address is how it ends up in a history entry.
const registryUrl = ref(OFFICIAL_REGISTRY_URL);
const registryToken = ref(``);

/** True while the surface is reading the registry it ships with rather than one somebody typed. */
const isOfficialRegistry = computed(() => registryUrl.value.trim() === OFFICIAL_REGISTRY_URL);

/* `read: false` is for a caller that wants the ANSWER but must not cause the question, the hub row that
 * badges how many installed extensions have a newer listed commit. Browsing a registry is a git clone on the
 * daemon, and doing one every time somebody opens the Sandbox screen, to decorate a row they may not be going
 * to, is invisible work charged to the wrong person. So the badge observes the same cached query without
 * enabling it: it is free, it is live the moment anything else has read the registry, and the cache is
 * persisted across reloads, so in practice it is populated from the last visit rather than from nothing. */
export function useRegistry({ read = true }: { read?: boolean } = {}) {
    const url = computed(() => registryUrl.value.trim());
    const token = computed(() => registryToken.value.trim());

    const { query, error } = useSandboxQuery<Marketplace>({
        // The token is deliberately NOT in the key: it is a credential for the same registry, not a different
        // one, and keying on it would put it in the query cache's index, which is persisted.
        queryKey: computed(() => REGISTRY.of(url.value)),
        queryFn: () => browseMarketplace(url.value, token.value === `` ? undefined : token.value),
        enabled: computed(() => read && url.value.length > 0),
        staleTime: 5 * 60_000,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
        // A registry that cannot be cloned will not start working on the second attempt, and each try is a
        // clone: one retry, then say so and offer the manual path.
        retry: 1,
    });

    // Extensions only. A registry serves plugins and intentic extensions out of one file, and a plugin is agent
    // configuration rather than something that runs in this browser, it keeps its own surface on the
    // Capabilities page, where its install form lives.
    const entries = computed<readonly RegistryEntry[]>(() => (query.data.value?.plugins ?? []).filter((entry) => entry.kind === `extension`));

    return {
        entries,
        // What the registry calls itself, for the source line. Undefined until the first read lands.
        registryName: computed<string | undefined>(() => query.data.value?.name),
        url: registryUrl,
        token: registryToken,
        isOfficial: isOfficialRegistry,
        // Fetching with nothing to show yet, the first read. A background refresh over a list that is already
        // on screen is not "loading" and must not blank it (the useEnvironmentContents precedent).
        isLoading: computed(() => query.isFetching.value && entries.value.length === 0),
        isFetching: computed(() => query.isFetching.value),
        error,
        refetch: (): void => void query.refetch(),
        /** Point the surface at a different registry. Clears the token with it, it belonged to the old one. */
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
