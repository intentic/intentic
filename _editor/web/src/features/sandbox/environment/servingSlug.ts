import { sandboxSlugOf } from "@intentic/sandbox-run";
import { computed, type ComputedRef } from "vue";
import { useSandbox } from "../client/useSandbox";
import { useEnvironment } from "./useEnvironment";

// THE NAME `ic` KNOWS THIS SANDBOX BY on the machine that runs it, which every command printed for that machine has to
// carry: `ic sandbox update` alone fails on a machine with several sandboxes. Needed most while the daemon is down (the
// recovery panel), so it never waits on the daemon:
//   1. the container name the daemon itself reported (`/environment`): exact, and kept in the query cache, which a
//      reload restores from disk for as long as the same build and account are signed in;
//   2. the first label of the daemon's address on the platform's own row: `ic sandbox connect` takes its slug from the
//      hostname it was handed (connect.rs), and the platform answers whether the daemon is up or not.

/** The slug in a daemon URL: its hostname's first label, the same key `ic` derived the container's name from. */
export const slugOfDaemonUrl = (daemonUrl: string | null | undefined): string | undefined => {
    // Read off the authority by hand: this runs inside a render, where a URL that fails to parse must not throw.
    const host = /^[a-z][a-z\d+.-]*:\/\/(?:[^@/?#]*@)?([^:/?#]+)/i.exec(daemonUrl ?? ``)?.[1];
    const label = host?.split(`.`)[0]?.toLowerCase();
    return label === undefined || label === `` ? undefined : label;
};

/** The container's own name first, then the address's; undefined when neither is known. */
export const servingSlug = (container: string | undefined, daemonUrl: string | null | undefined): string | undefined =>
    sandboxSlugOf(container) ?? slugOfDaemonUrl(daemonUrl);

export function useServingSlug(): ComputedRef<string | undefined> {
    // Held as a query observer too: while it is mounted the cached answer is not collected, even with the daemon gone.
    const { state } = useEnvironment();
    const { daemonUrl } = useSandbox();
    return computed(() => servingSlug(state.value?.container, daemonUrl.value));
}
