import { EnvironmentSchema } from "@intentic/api-contract";
import { ORIGIN_HOST, sandboxSlugOf } from "@intentic/sandbox-run";
import { computed } from "vue";
import { sandboxJson } from "../client/sandboxClient";
import { ENVIRONMENT } from "../../../lib/queryKeys";
import { useSandboxQuery } from "../client/useSandboxQuery";

// The sandbox's composed environment overlay (.intentic/local/environment.approved.Dockerfile), read via /environment.
// Shared by the Environment card, the shell's rebuild banner and the capabilities page, so they derive from one deduped
// query.

export const ENVIRONMENT_KEY = ENVIRONMENT.of();

export function useEnvironment() {
    const { query } = useSandboxQuery({
        queryKey: ENVIRONMENT_KEY,
        queryFn: async () => EnvironmentSchema.parse(await sandboxJson(`/environment`)),
    });
    const state = computed(() => query.data.value);

    // A boolean, not the ref: a template binding through vue-query's object doesn't unwrap and reads as always-truthy.
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

    // Installs worth the owner's eye: recurring across sessions, or live in the container and doomed with it.
    const recurring = computed(() => state.value?.recurring ?? []);

    // True for the provider's fixed container name; its rebuild rides `intentic deploy apply`, not a local one-liner.
    const serverManaged = computed(() => state.value?.container === ORIGIN_HOST);
    // The sandbox name a rebuild would target, read off its container name by the same contract that writes it.
    const slug = computed(() => sandboxSlugOf(state.value?.container));
    // Set only on a sandbox whose base was compiled from a checkout: what a newer image comes from is that checkout,
    // not the registry, so every "update" surface offers the rebuild instead.
    const localImage = computed(() => state.value?.localImage);

    return { state, query, isFetching, proposal, pending, applied, recurring, serverManaged, slug, localImage };
}
