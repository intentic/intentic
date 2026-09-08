import type { HostedBuildState, HostedBuildStatus } from "@intentic/api-contract";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed, watch } from "vue";
import { apiClient } from "../../../lib/useApi";
import { ENVIRONMENT_KEY } from "../environment/useEnvironment";

// A hosted sandbox's environment build, as followed by the Environment card: the platform builds the overlay
// since there is no local host to run `ic sandbox rebuild`. Polls every 5s only while a build is in flight; keyed under
// `sandbox` so the persisted cache never retains a build log.
const POLL_MS = 5_000;

export const hostedBuildKey = (sandboxId: string): unknown[] => [`sandbox`, `build`, sandboxId];

export function useHostedBuild(sandboxId: () => string | undefined) {
    const queryClient = useQueryClient();
    const key = computed(() => hostedBuildKey(sandboxId() ?? ``));
    const query = useQuery({
        queryKey: key,
        queryFn: async (): Promise<HostedBuildStatus> => apiClient.sandbox.hostedBuildStatus({ sandboxId: sandboxId() ?? `` }),
        enabled: computed(() => sandboxId() !== undefined),
        refetchInterval: (current) => (current.state.data?.build?.state === `building` ? POLL_MS : false),
    });
    const build = computed(() => query.data.value?.build ?? undefined);
    const applied = computed(() => query.data.value?.applied ?? undefined);

    // Re-fetches the environment query when a build finishes, since `applied` comes from the daemon, not this build
    // status.
    watch(
        () => build.value?.state,
        (state, previous) => {
            if (previous === `building` && state !== `building`) {
                void queryClient.invalidateQueries({ queryKey: ENVIRONMENT_KEY });
            }
        },
    );

    // Sends the content as shown; the platform recomputes the hash itself.
    const rebuild = async (hash: string, content: string): Promise<HostedBuildState> => {
        const id = sandboxId();
        if (id === undefined) {
            throw new Error(`no sandbox is active`);
        }
        const state = await apiClient.sandbox.hostedRebuild({ sandboxId: id, hash, content });
        queryClient.setQueryData<HostedBuildStatus>(hostedBuildKey(id), (current) => ({ build: state, applied: current?.applied ?? null }));
        return state;
    };

    return { build, applied, rebuild, isLoading: computed(() => query.isLoading.value) };
}
