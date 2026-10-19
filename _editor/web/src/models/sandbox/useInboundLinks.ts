import { type MaybeRefOrGetter, computed, toValue } from "vue";
import { sandboxRaw } from "../../client/sandbox/sandboxRaw";
import { useSandboxQuery } from "../../client/sandbox/useSandboxQuery";
import { INBOUND_LINKS } from "../../lib/queryKeys";
import { queryClient } from "../../lib/queryPersistence";

// The other sandboxes' links into this one (GET /system/links), as one shared cache entry: Sandbox ▸ Map draws them, and
// Access counts the tasks on them that wait for the owner's yes on its Programs tab. The Linked sandboxes section keeps
// its own list, the one it mints into and revokes, and marks this one stale after each change it makes.

/** The links, read only for a reader the daemon answers them to (maintainer and up). */
export const useInboundLinks = (enabled: MaybeRefOrGetter<boolean>) =>
    useSandboxQuery({
        queryKey: INBOUND_LINKS.of(),
        queryFn: async () => (await sandboxRaw(`GET /system/links`)).links,
        enabled: computed(() => toValue(enabled)),
    });

/** How many tasks wait on every link together: what the owner has to answer before any of them starts. */
export const useWaitingLinkTasks = (enabled: MaybeRefOrGetter<boolean>) => {
    const { query } = useInboundLinks(enabled);
    return computed(() => (query.data.value ?? []).reduce((sum, link) => sum + link.requests.length, 0));
};

/** After a link was minted, revoked, re-termed or a task on it answered: read again by whoever draws them. */
export const inboundLinksChanged = (): Promise<void> => queryClient.invalidateQueries({ queryKey: INBOUND_LINKS.of() });
