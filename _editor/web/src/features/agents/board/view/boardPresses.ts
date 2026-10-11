import type { WorkflowRun } from "@intentic/sandbox-contract";
import { messageOr } from "@intentic/ui/async";
import { t } from "@intentic/ui/i18n";
import { computed, type Ref, watch } from "vue";
import type { Router } from "vue-router";
import { runPress } from "../../../chat/run/chatRun";
import type { Strip } from "../../../chat/tabs/tabFacts";
import { synthesizeSessions } from "../../fleet/synthesizeSessions";
import { useOperations } from "../../../../workbench/operations/operations";

// The board's presses that land on no agent card: a workflow run's row (a run is not an agent, see WorkflowRunCard), a
// held wake's approve or reject, and the header's Synthesize.

// One write on a run, as the ledger's mutations take it (useWorkflowRuns).
interface RunWrite {
    readonly mutateAsync: (runId: string) => Promise<unknown>;
}

export interface PressesHost {
    readonly workflows: {
        readonly runs: Readonly<Ref<readonly WorkflowRun[]>>;
        readonly stop: RunWrite;
        readonly archive: RunWrite;
        readonly unarchive: RunWrite;
    };
    // The fleet store: a held wake's release, a re-read, and the board's must-read strip.
    readonly agents: {
        readonly releaseHeld: (id: string, verb: `approve` | `reject`) => Promise<void>;
        readonly refresh: () => Promise<void>;
        readonly notice: Ref<string | undefined>;
    };
    readonly router: Router;
    // The chat a run's row points: what it shows (the app-wide strip, the floating window's included), whether it can
    // draw a run's diagram, and the two ways a press reaches it (openRun.ts: openRunInChat, pointAtChat).
    readonly chat: {
        readonly strip: Readonly<Ref<Strip>>;
        readonly diagram: Readonly<Ref<boolean>>;
        readonly mobile: Readonly<Ref<boolean>>;
        readonly follow: (run: WorkflowRun) => void;
        readonly point: () => void;
    };
}

export const useBoardPresses = (host: PressesHost) => {
    const { workflows, agents } = host;
    // Runs asked to stop: the ledger confirms only once each step unwinds, on a poll, and unmarked a stop looks ignored.
    // The daemon has no `stopping` of its own (a run reads `running` until it winds down), so the asks are kept in the
    // operations ledger rather than this board: one that leaves and comes back finds the run still marked, where it used
    // to offer Stop again. An ask that went is kept until the ledger says its run stopped, not until the request returns:
    // steps keep finishing for minutes after.
    const stops = useOperations(`workflows/stop`);
    const stillRunning = (runId: string): boolean => workflows.runs.value.find((run) => run.runId === runId)?.state === `running`;
    const stoppingRuns = computed(
        () =>
            new Set(
                stops.all.value
                    .filter((stop) => stop.tag !== undefined && (stop.state === `running` || (stop.state === `done` && stillRunning(stop.tag))))
                    .map((stop) => stop.tag!),
            ),
    );
    // The daemon answers a stop on an ended run as done, so a refusal means the run may still be spending. Its reason
    // goes on the board's notice strip, which outlives the board, so it waits for a reader who left.
    const stopRun = async (run: WorkflowRun): Promise<void> => {
        if (stoppingRuns.value.has(run.runId)) {
            return;
        }
        const outcome = await stops.run(run.runId, {
            what: t(`agents.boardPresses.stoppingRun`, { name: run.workflow.name }),
            tag: run.runId,
            failed: t(`agents.boardPresses.couldntStopRun`),
            // The row says it, and keeps saying it until the run has wound down.
            quiet: true,
            keep: true,
            task: async () => {
                await workflows.stop.mutateAsync(run.runId);
            },
        });
        if (outcome?.state === `failed`) {
            stops.dismiss(run.runId);
            agents.notice.value = outcome.failure?.detail ?? outcome.failure?.title;
        }
    };
    // Put away once the ledger says the run stopped.
    watch(workflows.runs, () => {
        for (const stop of stops.all.value) {
            if (stop.tag !== undefined && stop.state === `done` && !stillRunning(stop.tag)) {
                stops.dismiss(stop.tag);
            }
        }
    });
    // Files an ended run away, sessions and all, unasked: archiving is lossless and the archive itself is the way back.
    // A refusal puts the row back (useWorkflowRuns), so the strip is what says why it moved twice.
    const archiveRun = async (run: WorkflowRun): Promise<void> => {
        await workflows.archive.mutateAsync(run.runId).catch((error: unknown) => {
            agents.notice.value = messageOr(error, t(`agents.boardPresses.couldntArchiveRun`));
        });
    };
    const restoreRun = async (run: WorkflowRun): Promise<void> => {
        await workflows.unarchive.mutateAsync(run.runId).catch((error: unknown) => {
            agents.notice.value = messageOr(error, t(`agents.boardPresses.couldntRestoreRun`));
        });
    };
    // A run's design and its history live on the workflows page; this board only answers what it is doing.
    const openRunGraph = (run: WorkflowRun): void => {
        void host.router.push({ name: `extension`, params: { ext: `workflows` }, query: { run: run.runId } });
    };
    // The row's own press: the run's sessions in the chat, and never nothing, which is what twenty presses on one card
    // got from a chat already showing that run. Already shown, the chat is pointed at instead; with nothing of the run
    // to show (an ended run beside a docked chat, which has no room for the diagram) the press opens the diagram
    // itself. A phone has no chat beside the board, so its press is the diagram, every run's sessions one tap away there.
    const openRun = (run: WorkflowRun): void => {
        const { chat } = host;
        const press = chat.mobile.value ? `graph` : runPress(run, chat.strip.value.run, chat.strip.value.panes, chat.diagram.value);
        if (press === `graph`) {
            openRunGraph(run);
            return;
        }
        chat.follow(run);
        if (press === `shown`) {
            chat.point();
        }
    };
    // A held wake's row leaves on its own press (releaseHeld), so it cannot collect a second, and comes back only if the
    // daemon refused it.
    const releaseWake = async (id: string, verb: `approve` | `reject`): Promise<void> => {
        try {
            await agents.releaseHeld(id, verb);
        } catch {
            // Usually the countdown or another device beat this press to it; refresh repaints the truth either way.
            void agents.refresh();
        }
    };
    // Opens a draft composed from the chats side by side, never sent; a refusal lands on the notice strip, since a press
    // with no visible effect reads as broken.
    const synthesize = async (): Promise<void> => {
        const result = await synthesizeSessions();
        if (!result.started) {
            agents.notice.value = result.why;
        }
    };
    return { stoppingRuns, stopRun, archiveRun, restoreRun, openRun, openRunGraph, releaseWake, synthesize };
};
