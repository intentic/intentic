import type { WorkflowRun } from "@intentic/sandbox-contract";
import { messageOr } from "@intentic/ui/async";
import { t } from "@intentic/ui/i18n";
import { ref, type Ref, watch } from "vue";
import type { Router } from "vue-router";
import { runPress } from "../../../chat/run/chatRun";
import type { Strip } from "../../../chat/tabs/tabFacts";
import { synthesizeSessions } from "../../fleet/synthesizeSessions";

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
    const stoppingRuns = ref(new Set<string>());
    const forgetStopping = (runId: string): void => {
        const rest = new Set(stoppingRuns.value);
        rest.delete(runId);
        stoppingRuns.value = rest;
    };
    // The daemon answers a stop on an ended run as done, so a refusal means the run may still be spending.
    const stopRun = async (run: WorkflowRun): Promise<void> => {
        stoppingRuns.value = new Set([...stoppingRuns.value, run.runId]);
        try {
            await workflows.stop.mutateAsync(run.runId);
        } catch (error) {
            forgetStopping(run.runId);
            agents.notice.value = messageOr(error, t(`agents.boardPresses.couldntStopRun`));
        }
    };
    // Held until the ledger says the run stopped, not until the request returns: steps keep finishing for minutes after.
    watch(workflows.runs, (list) => {
        for (const runId of stoppingRuns.value) {
            if (list.find((run) => run.runId === runId)?.state !== `running`) {
                forgetStopping(runId);
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
