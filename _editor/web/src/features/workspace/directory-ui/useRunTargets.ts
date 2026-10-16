import type { RunTargetsList } from "@intentic/sandbox-contract/schemas/run-targets";
import { t } from "@intentic/ui/i18n";
import { computed } from "vue";
import { rpcQuery } from "../../../client/sandbox/rpcQuery";
import { sandboxRpc } from "../../../client/sandbox/sandboxRpc";
import { useSandboxQuery } from "../../../client/sandbox/useSandboxQuery";
import { useOperations } from "../../../workbench/operations/operations";
import { useTerminalPanel } from "../../../models/terminal/useTerminalPanel";

// What each repository can run on the owner's own computers (its `.intentic/run.json`), and the button that runs one.
// A run is `devices run` in a terminal the daemon opens, so starting one opens that terminal: the build, the push and
// the start are watched there, the same lines an agent reads.

export function useRunTargets() {
    const { query, error } = useSandboxQuery(rpcQuery(`runs.targets`));

    // Undefined while unread, so a row can tell "declares nothing" from "not read yet".
    const repos = computed<RunTargetsList[`repos`] | undefined>(() => query.data.value?.repos);
    const devices = computed<RunTargetsList[`devices`]>(() => query.data.value?.devices ?? []);

    return {
        repos,
        devices,
        error,
        refetch: () => query.refetch(),
    };
}

// Where the operations ledger keeps the presses that start a run: the workspace's, not the dialog's.
export const RUN_STARTS = `workspace/runs`;
const runKey = (repo: string, target: string, device: string): string => `${repo}/${target}@${device}`;

// The Run buttons' presses, kept in the operations ledger rather than the dialog that made them: closing the dialog
// while a run is being asked for leaves it asked, a dialog opened again shows that run's button still busy, and a
// refusal that came back meanwhile waits there (or is said as a receipt, when nothing showing runs is open). Apart from
// `useRunTargets`, so only a surface that shows the presses is counted as watching them.
export function useRunPresses() {
    const { openFocused } = useTerminalPanel();
    const starts = useOperations(RUN_STARTS);

    return {
        // Whether this target's run on this computer is being started, so only its button goes quiet.
        pending: (repo: string, target: string, device: string): boolean => starts.at(runKey(repo, target, device))?.state === `running`,
        // The newest press's refusal, the dialog's one error line.
        failure: computed(() => {
            const failure = starts.all.value.at(-1)?.failure;
            return failure === undefined ? undefined : (failure.detail ?? failure.title);
        }),
        run: (repo: string, target: string, device: string): void => {
            const title = t(`workspace.directoryRuns.runOn`, { target, device });
            void starts.run(runKey(repo, target, device), {
                what: title,
                failed: t(`workspace.directoryRuns.couldntRun`, { target, device }),
                // The terminal it opens is the answer; a receipt is for a refusal, or a start nobody stayed for.
                task: async () => {
                    const { session } = await sandboxRpc.runs.start({ repo, target, device });
                    openFocused(session, { title: `${target} on ${device}` });
                },
            });
        },
    };
}
