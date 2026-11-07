import { errorMessage } from "@intentic/base/errors";
import { t } from "@intentic/ui/i18n";
import { computed, type InjectionKey, ref, type Ref } from "vue";
import type { Router } from "vue-router";
import type { AgentFix } from "../../models/fixes/agentFix";
import type { PreviewTarget } from "../../models/preview/previewModel";
import { startRefusedFix } from "../../models/runs/runFixes";
import { useRunLog, useRunPresses } from "../../models/runs/useRunTargets";
import { openPreviewBeside } from "../../workbench/browsers/browsersSurface";
import type { RunItem, RunLane } from "./runLanes";
import type { RunRow } from "./runRows";
import { SANDBOX } from "./runRows";

/* WHAT THE RUN VIEW'S ROWS PRESS, made once by the view and handed to every row: the computers' presses kept in the
   operations ledger (useRunPresses), a sandbox start and its refusal, the one row open at a time and the log it follows.
   One owner, so a refusal is said once at the top of the view however many rows could have caused it, and opening a
   row closes the one open on another lane. */

interface Live {
    readonly start: (target: PreviewTarget) => Promise<void>;
    readonly stop: (target: PreviewTarget) => Promise<void>;
}

// The row open now: its lane's place and its key there.
interface OpenRow {
    readonly place: string;
    readonly key: string;
}

export function useRunActions(router: Router, live: Live, lanes: Ref<readonly RunLane[]>, visible: Ref<boolean>) {
    const presses = useRunPresses();

    // A sandbox start in flight (the item's key), and the last one refused with what an agent would be asked about it.
    const starting = ref<string | undefined>(undefined);
    const sandboxFailure = ref<{ readonly text: string; readonly fix: AgentFix } | undefined>(undefined);

    const show = (row: RunRow): void => {
        if (row.sandboxId !== undefined) {
            openPreviewBeside(router, row.sandboxId);
        }
    };

    const runInSandbox = async (repo: string, item: RunItem): Promise<void> => {
        const target = item.row?.sandbox;
        if (target === undefined || item.row === undefined) {
            return;
        }
        starting.value = item.key;
        sandboxFailure.value = undefined;
        try {
            await live.start(target);
            show(item.row);
        } catch (error) {
            const reason = errorMessage(error);
            const name = item.row.name;
            sandboxFailure.value = {
                text: t(`run.view.couldntStart`, { target: name, reason }),
                fix: startRefusedFix({ repo, target: name, reason, title: t(`run.view.couldntStart`, { target: name, reason: `` }) }),
            };
        } finally {
            starting.value = undefined;
        }
    };

    const stopInSandbox = async (row: RunRow): Promise<void> => {
        if (row.sandbox !== undefined) {
            await live.stop(row.sandbox);
        }
    };

    const open = ref<OpenRow | undefined>(undefined);
    const isOpen = (place: string, item: RunItem): boolean => open.value?.place === place && open.value.key === item.key;
    const setOpen = (place: string, item: RunItem, opened: boolean): void => {
        open.value = opened ? { place, key: item.key } : undefined;
    };

    // The open row's newest run on its computer, read off the lanes as they are now (a Restart makes a new run), and
    // followed while the row is open.
    const logDevice = computed(() => (open.value === undefined || open.value.place === SANDBOX ? undefined : open.value.place));
    const logRun = computed(() => {
        const opened = open.value;
        const lane = opened === undefined ? undefined : lanes.value.find((candidate) => candidate.place === opened.place);
        return [...(lane?.active ?? []), ...(lane?.idle ?? [])].find((item) => item.key === opened?.key)?.run?.id;
    });
    const log = useRunLog(
        logDevice,
        logRun,
        computed(() => visible.value && logRun.value !== undefined),
    );

    return { ...presses, starting, sandboxFailure, show, runInSandbox, stopInSandbox, isOpen, setOpen, logRun, log };
}

export type RunActions = ReturnType<typeof useRunActions>;

export const RUN_ACTIONS: InjectionKey<RunActions> = Symbol(`runActions`);
