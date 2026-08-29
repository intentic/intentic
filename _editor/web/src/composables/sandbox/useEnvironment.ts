import { EnvironmentSchema } from "@intentic-app/api-contract";
import { computed } from "vue";
import { sandboxJson } from "./sandboxClient";
import { ENVIRONMENT } from "../queryKeys";
import { useSandboxQuery } from "./useSandboxQuery";

/* The sandbox's composed environment overlay (.intentic/local/environment.approved.Dockerfile), read via the daemon's
 * /environment route. Shared by the Environment card, the shell's rebuild banner, and the capabilities page so
 * "a rebuild is pending" / "a proposal awaits review" derives from ONE query (vue-query dedupes on the key). */

export const ENVIRONMENT_KEY = ENVIRONMENT.of();

export function useEnvironment() {
    const { query } = useSandboxQuery({
        queryKey: ENVIRONMENT_KEY,
        queryFn: async () => EnvironmentSchema.parse(await sandboxJson(`/environment`)),
    });
    const state = computed(() => query.data.value);

    /* IS A READ IN THE AIR, as a derived boolean rather than left for a caller to pull off `query`. Reaching
     * through that object in a template does NOT unwrap: only a top-level setup binding does, so the Environment
     * card's `:spin="query.isFetching"` handed <Icon> the ref itself, which is an object and therefore always
     * truthy — its refresh button span for the life of the page. Exposed here the way useUsage and useRegistry
     * already expose theirs, so the binding is a plain boolean at every call site and cannot be got wrong. */
    const isFetching = computed(() => query.isFetching.value);

    // A proposal awaiting review: present and not the custom-section content already approved.
    const proposal = computed(() => {
        const current = state.value;
        return current?.proposal !== undefined && current.proposal.hash !== current.custom?.hash ? current.proposal : undefined;
    });
    // Approved but not what the running container was built from, a rebuild is pending.
    const pending = computed(() => {
        const current = state.value;
        return current?.approved !== undefined && current.approved.hash !== current.appliedHash ? current.approved : undefined;
    });
    const applied = computed(() => {
        const current = state.value;
        return current?.approved !== undefined && current.approved.hash === current.appliedHash ? current.approved : undefined;
    });

    // Runtime installs worth the owner's eye: recurring across sessions, or present in the live container and
    // doomed with it. The daemon auto-drafts the mechanically fixable ones into the proposal; this list is the
    // memory behind that, plus the entries only a person can route (a pip package, a shell installer).
    const recurring = computed(() => state.value?.recurring ?? []);

    // Server-managed sandboxes use the provider's fixed container name; their rebuild rides `intentic deploy apply`
    // (the overlay content is git-reviewed in desired-state), not a local one-liner.
    const serverManaged = computed(() => state.value?.container === `intentic-sandbox-workspace`);
    // Which sandbox a rebuild would name. HostRecreate pairs it with the approved overlay's hash, a button in
    // the desktop app, the equivalent one-liner in a browser.
    const slug = computed(() => state.value?.container?.replace(/^intentic-sandbox-/, ``));

    return { state, query, isFetching, proposal, pending, applied, recurring, serverManaged, slug };
}
