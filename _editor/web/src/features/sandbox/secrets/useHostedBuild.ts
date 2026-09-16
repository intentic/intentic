import type { HostedBuildState, HostedBuildStatus } from "@intentic/api-contract";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed, onScopeDispose, watch } from "vue";
import { apiClient } from "../../../lib/useApi";
import { ENVIRONMENT_KEY } from "../environment/useEnvironment";
import { expectRestart, type RestartWork } from "../live/sandboxRestart";

// A hosted sandbox's environment build, as followed by the Environment card: the platform builds the overlay
// since there is no local host to run `ic sandbox rebuild`. Polls every 5s only while a build is in flight; keyed under
// `sandbox` so the persisted cache never retains a build log.
const POLL_MS = 5_000;

// A hosted build ends with the platform swapping this sandbox onto the image it made — a restart nothing in this
// browser is told has begun, and one no promise here resolves on. Both halves go on the restart ledger: the build,
// which interrupts nothing, and the swap, which is over only when the sandbox answers again.
const buildingWork = (sandbox: string): Omit<RestartWork, "startedAt"> => ({
    sandbox,
    id: `hosted-build`,
    what: `Building your environment`,
    quiet: {
        title: `Building your environment`,
        detail: `Your sandbox restarts onto the new image once the build is done — about half a minute of quiet, then this page reconnects on its own. Your files in /work are kept.`,
    },
});

const switchingWork = (sandbox: string): Omit<RestartWork, "startedAt"> => ({
    sandbox,
    id: `hosted-build`,
    what: `Restarting onto your new environment`,
    quiet: {
        title: `Restarting onto your new environment`,
        detail: `The build is done and your sandbox is being swapped onto it — about half a minute, then this page reconnects on its own. Your files in /work are kept.`,
    },
    untilAnswered: true,
});

// How long after a build finishes its swap is still the explanation for a quiet sandbox. `built` is a resting state,
// true of the last successful build for as long as it stands; without a window, opening this screen a week later
// would announce a restart that happened a week ago.
const SWAP_WINDOW_MS = 5 * 60_000;

const swapping = (state: HostedBuildState | undefined, applied: string | null | undefined): boolean => {
    if (state?.state !== `built` || applied !== state.hash || state.finishedAt === undefined) {
        return false;
    }
    const finished = Date.parse(state.finishedAt);
    return Number.isFinite(finished) && Date.now() - finished < SWAP_WINDOW_MS;
};

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

    // One claim on the ledger, moved as the build moves; every surface holding this composable declares the same
    // work, and the ledger counts them rather than replacing.
    let release: (() => void) | undefined;
    const expect = (work: Omit<RestartWork, "startedAt"> | undefined): void => {
        release?.();
        release = work === undefined ? undefined : expectRestart(work);
    };
    watch(
        [build, applied, () => sandboxId()],
        ([state, appliedHash, id]) => {
            if (id === undefined) {
                expect(undefined);
                return;
            }
            if (state?.state === `building`) {
                expect(buildingWork(id));
                return;
            }
            expect(swapping(state, appliedHash) ? switchingWork(id) : undefined);
        },
        { immediate: true },
    );
    // A surface letting go of the build is not the build stopping: the ledger keeps the record while any other holder
    // remains, and the root follow is one.
    onScopeDispose(() => expect(undefined));

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
