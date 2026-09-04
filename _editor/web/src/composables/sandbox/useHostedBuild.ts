import type { HostedBuildState, HostedBuildStatus } from "@intentic-app/api-contract";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed, watch } from "vue";
import { apiClient } from "../useApi";
import { ENVIRONMENT_KEY } from "./useEnvironment";

/* A HOSTED SANDBOX'S ENVIRONMENT BUILD, as the Environment card follows it. On a docker host the owner runs
 * `ic sandbox rebuild` and watches a terminal; a hosted sandbox has no host, so the platform builds the
 * approved overlay on a machine of its own and this is the browser's window onto that build: one call to
 * start it, one poll while it runs, and the environment query invalidated when it ends, because the daemon
 * coming back with the hash as applied is the last word, not anything the platform says.
 *
 * Polled only while a build is in flight, five seconds apart: a build is minutes long and the state changes
 * once. Keyed under `sandbox` so the persisted cache never keeps a build log on disk. */
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

    // The card derives "applied" from the daemon's /environment, so when a build ends that read is asked
    // again; the wake reflex reconnects to the restarted daemon and the query refetches on its own after.
    watch(
        () => build.value?.state,
        (state, previous) => {
            if (previous === `building` && state !== `building`) {
                void queryClient.invalidateQueries({ queryKey: ENVIRONMENT_KEY });
            }
        },
    );

    // Start one. The platform re-hashes the content, so what is sent is exactly what the card showed.
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
