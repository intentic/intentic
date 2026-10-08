import type { RunTargetsList } from "@intentic/sandbox-contract";
import { useMutation } from "@tanstack/vue-query";
import { computed } from "vue";
import { rpcQuery } from "../../../client/sandbox/rpcQuery";
import { sandboxRpc } from "../../../client/sandbox/sandboxRpc";
import { useSandboxQuery } from "../../../client/sandbox/useSandboxQuery";
import { queryClient } from "../../../lib/queryPersistence";
import { useTerminalPanel } from "../../terminal/useTerminalPanel";

// What each repository can run on the owner's own computers (its `.intentic/run.json`), and the button that runs one.
// A run is `devices run` in a terminal the daemon opens, so starting one opens that terminal: the build, the push and
// the start are watched there, the same lines an agent reads.

export function useRunTargets() {
    const { query, error } = useSandboxQuery(rpcQuery(`runs.targets`));
    const { openFocused } = useTerminalPanel();

    const start = useMutation(
        {
            mutationFn: (run: { repo: string; target: string; device: string }) => sandboxRpc.runs.start(run),
            onSuccess: ({ session }, run) => openFocused(session, { title: `${run.target} on ${run.device}` }),
        },
        queryClient,
    );

    // Undefined while unread, so a row can tell "declares nothing" from "not read yet".
    const repos = computed<RunTargetsList[`repos`] | undefined>(() => query.data.value?.repos);
    const devices = computed<RunTargetsList[`devices`]>(() => query.data.value?.devices ?? []);

    return {
        repos,
        devices,
        error,
        refetch: () => query.refetch(),
        // The run being started, so only its button goes quiet.
        pending: computed(() => (start.isPending.value ? start.variables.value : undefined)),
        failure: computed(() => (start.error.value === null ? undefined : start.error.value.message)),
        run: (repo: string, target: string, device: string): void => start.mutate({ repo, target, device }),
    };
}
