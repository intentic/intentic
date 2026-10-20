import { rebuildPending } from "@intentic/sandbox-contract/state/sandbox-build";
import { ORIGIN_HOST, sandboxSlugOf } from "@intentic/sandbox-run";
import { computed } from "vue";
import { sandboxRaw } from "../../../client/sandbox/sandboxRaw";
import { ENVIRONMENT } from "../../../lib/queryKeys";
import { useSandboxQuery } from "../../../client/sandbox/useSandboxQuery";

// The sandbox's environment overlay as composed on this read, and the one its container was built from, via /environment.
// Shared by the Environment card, the shell's rebuild banner and the capabilities page, so they derive from one deduped
// query.

export const ENVIRONMENT_KEY = ENVIRONMENT.of();

export function useEnvironment() {
    const { query, loaded } = useSandboxQuery({
        queryKey: ENVIRONMENT_KEY,
        queryFn: () => sandboxRaw(`GET /environment`),
    });
    const state = computed(() => query.data.value);

    // A boolean, not the ref: a template binding through vue-query's object doesn't unwrap and reads as always-truthy.
    const isFetching = computed(() => query.isFetching.value);

    // A proposal awaiting review: present and not the custom-section content already approved.
    const proposal = computed(() => {
        const current = state.value;
        return current?.proposal !== undefined && current.proposal.hash !== current.custom?.hash ? current.proposal : undefined;
    });
    // The approved overlay, as the one a rebuild would build or the one the running container was built from.
    const waiting = computed(() => rebuildPending(state.value?.approved?.hash, state.value?.appliedHash));
    const pending = computed(() => (waiting.value ? state.value?.approved : undefined));
    const applied = computed(() => (waiting.value ? undefined : state.value?.approved));

    // Installs worth the owner's eye: recurring across sessions, or live in the container and doomed with it.
    const recurring = computed(() => state.value?.recurring ?? []);

    // True for the provider's fixed container name; its rebuild rides `intentic deploy apply`, not a local one-liner.
    const serverManaged = computed(() => state.value?.container === ORIGIN_HOST);
    // The sandbox name a rebuild would target, read off its container name by the same contract that writes it.
    const slug = computed(() => sandboxSlugOf(state.value?.container));
    // Set only on a sandbox whose base was compiled from a checkout: what a newer image comes from is that checkout,
    // not the registry, so every "update" surface offers the rebuild instead.
    const localImage = computed(() => state.value?.localImage);

    return { state, query, loaded, isFetching, proposal, pending, applied, recurring, serverManaged, slug, localImage };
}
