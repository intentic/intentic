import type { DeviceRun, RunOutputQuery, RunStop, RunTargetsList, RunTerminal } from "@intentic/sandbox-contract/schemas/run-targets";
import { errorMessage } from "@intentic/base/errors";
import { t } from "@intentic/ui/i18n";
import { useQueryClient } from "@tanstack/vue-query";
import { computed, onScopeDispose, type Ref, ref, watch } from "vue";
import { rpcQuery } from "../../client/sandbox/rpcQuery";
import { rpcPrefix } from "../../lib/queryKeys";
import { sandboxRpc } from "../../client/sandbox/sandboxRpc";
import { useSandboxQuery } from "../../client/sandbox/useSandboxQuery";
import { useOperations } from "../../workbench/operations/operations";
import { useTerminalPanel } from "../terminal/useTerminalPanel";

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
    const queryClient = useQueryClient();
    const relist = (): Promise<void> => queryClient.invalidateQueries({ queryKey: rpcPrefix(`runs.active`) });

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
                    await relist();
                },
            });
        },
        // Brings a run's terminal back into the panel, focused.
        reopen: (session: string, target: string, device: string): void => openFocused(session, { title: `${target} on ${device}` }),
        // Whether this target's run on this computer is being stopped.
        stopping: (repo: string, target: string, device: string): boolean => starts.at(stopKey(repo, target, device))?.state === `running`,
        // Stops the target's terminal and its program there (by id when known), with the ports opened for it.
        stop: (repo: string, target: string, device: string, id?: string): void => {
            void starts.run(stopKey(repo, target, device), {
                what: t(`workspace.directoryRuns.stopOn`, { target, device }),
                failed: t(`workspace.directoryRuns.couldntStop`, { target, device }),
                task: async () => {
                    const input: RunStop = { repo, target, device };
                    if (id !== undefined) {
                        input.id = id;
                    }
                    await sandboxRpc.runs.stop(input);
                    await relist();
                },
            });
        },
    };
}

const stopKey = (repo: string, target: string, device: string): string => `stop:${runKey(repo, target, device)}`;

// How often what runs on the chosen computer is asked again while the Run dialog shows it, and a log open there.
const RUNS_POLL_MS = 4000;
const LOG_POLL_MS = 1500;
// The most of a log kept on screen.
const LOG_KEEP_LINES = 500;

// What runs on one computer (the programs this sandbox started there, running and ended), while `active`. Asked again on
// a clock: a program ending on the computer says so to nobody.
export function useDeviceRuns(device: Ref<string | undefined>, active: Ref<boolean>) {
    const { query } = useSandboxQuery({
        ...rpcQuery(`runs.active`, () => ({ device: device.value ?? `` })),
        enabled: computed(() => active.value && device.value !== undefined),
        refetchInterval: RUNS_POLL_MS,
    });
    const runs = computed<readonly DeviceRun[]>(() => query.data.value?.runs ?? []);
    const terminals = computed<readonly RunTerminal[]>(() => query.data.value?.terminals ?? []);
    return {
        runs,
        // A target's newest run there: the machine lists newest first.
        runOf: (name: string): DeviceRun | undefined => runs.value.find((run) => run.name === name),
        // The terminal a repository's target is still building, pushing or following in there.
        terminalOf: (repo: string, target: string): RunTerminal | undefined =>
            terminals.value.find((terminal) => terminal.repo === repo && terminal.target === target),
    };
}

// One run's output while `open`: its last lines, then what it prints after them, read every so often.
export function useRunLog(device: Ref<string | undefined>, id: Ref<string | undefined>, open: Ref<boolean>) {
    const lines = ref<string[]>([]);
    const failure = ref<string | undefined>(undefined);
    let since: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let generation = 0;

    const read = async (mine: number): Promise<void> => {
        const where = device.value;
        const run = id.value;
        if (where === undefined || run === undefined) {
            return;
        }
        try {
            const ask: RunOutputQuery = { device: where, id: run, lines: 200 };
            if (since !== undefined) {
                ask.since = since;
            }
            const output = await sandboxRpc.runs.output(ask);
            if (mine !== generation) {
                return;
            }
            failure.value = undefined;
            since = output.total;
            lines.value = [...lines.value, ...output.lines].slice(-LOG_KEEP_LINES);
            if (output.run?.state === `ended`) {
                return;
            }
        } catch (error) {
            if (mine !== generation) {
                return;
            }
            failure.value = errorMessage(error);
        }
        timer = setTimeout(() => void read(mine), LOG_POLL_MS);
    };

    const stop = (): void => {
        generation += 1;
        clearTimeout(timer);
    };

    watch(
        [device, id, open],
        () => {
            stop();
            lines.value = [];
            failure.value = undefined;
            since = undefined;
            if (open.value) {
                void read(generation);
            }
        },
        { immediate: true },
    );
    onScopeDispose(stop);

    return { lines, failure };
}
