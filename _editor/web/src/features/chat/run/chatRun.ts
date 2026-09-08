import type { AgentHarness, WorkflowRun } from "@intentic/sandbox-contract";
import { ref } from "vue";

// A workflow run's view state inside the chat panel: sessions are chats, so a live run's panes move with it instead of
// sending the reader to a separate page. `graph` is the diagram (back arrow); `pinned` is a chosen band; neither moves.
// Only the run's id is held; the run itself is polled elsewhere (useWorkflowRuns).

export type ChatRunMode = "graph" | "live" | "pinned";

export interface ChatRunView {
    readonly runId: string;
    readonly mode: ChatRunMode;
}

export const chatRun = ref<ChatRunView | undefined>();

export const showRun = (runId: string, mode: ChatRunMode): void => {
    chatRun.value = { runId, mode };
};

export const closeRun = (): void => {
    chatRun.value = undefined;
};

// Every conversation this run drives; smaller than the step count since a `continue` step shares its predecessor's.
const runHolds = (run: WorkflowRun, conversationId: string): boolean => run.steps.some((step) => step.conversationId === conversationId);

// Whether the panes hold any of this run's own chats — a better test than "is anything live", since that's equally true
// (for opposite reasons) at a run's start and its end.
export const paneShowsRun = (run: WorkflowRun, showing: readonly string[]): boolean => showing.some((id) => runHolds(run, id));

// Whether the panel is drawing the diagram; also read by the board's selection ring, since the two disagreeing is the
// failure itself. True for `graph` outright, or for `live` only until the panes hold this run's own chats.
export const showingRunGraph = (run: WorkflowRun | undefined, view: ChatRunView | undefined, showing: readonly string[]): boolean =>
    run !== undefined && (view?.mode === `graph` || (view?.mode === `live` && !paneShowsRun(run, showing)));

// Any focus change exits the diagram; a picture that doesn't move under it read as a frozen panel. A chat belonging to
// this run pins it (not `live`); any other chat, or a run the ledger can't currently confirm, drops it — better a
// re-press than a panel stuck following forever.
export const runOnFocus = (run: WorkflowRun | undefined, conversationId: string, mode: ChatRunMode): ChatRunView | undefined =>
    run !== undefined && runHolds(run, conversationId) ? { runId: run.runId, mode: mode === `graph` ? `pinned` : mode } : undefined;

export interface RunSession {
    readonly conversationId: string;
    // What the step's design pinned, for opening a session the fleet no longer lists; the daemon supplies the rest.
    readonly agent: string | undefined;
    readonly harness: AgentHarness | undefined;
}

export interface RunColumn {
    // Steps dagre placed at this depth: one vertical band of the diagram.
    readonly stepIds: readonly string[];
    // Sessions behind them, deduped, in column order; empty means the band never ran, so a click has nothing to open.
    readonly sessions: readonly RunSession[];
}

// One step run, as a session to open; shared by every caller turning part of a run into panes.
export const sessionOf = (run: WorkflowRun, stepId: string, conversationId: string): RunSession => {
    const design = run.workflow.steps.find((step) => step.id === stepId);
    return { conversationId, agent: design?.agent, harness: design?.harness };
};

// Sessions actually running, deduped since a `continue` step shares its predecessor's conversation; what "open this
// run" lands on before any column is picked.
export const liveSessions = (run: WorkflowRun): RunSession[] => {
    const seen = new Set<string>();
    return run.steps.flatMap((step) => {
        if (step.state !== `running` || seen.has(step.conversationId)) {
            return [];
        }
        seen.add(step.conversationId);
        return [sessionOf(run, step.stepId, step.conversationId)];
    });
};

// What's running, or — while nothing is yet, right after the press, before the scheduler has caught up — what's about
// to: the run's ready roots, derived and written before any turn starts. Only while the run is actually going; a
// finished run's pending steps are pending forever.
const frontSessions = (run: WorkflowRun): RunSession[] => {
    const live = liveSessions(run);
    if (live.length > 0 || run.state !== `running`) {
        return live;
    }
    const stateOf = new Map(run.steps.map((step) => [step.stepId, step.state]));
    const needsOf = new Map(run.workflow.steps.map((step) => [step.id, step.needs]));
    const seen = new Set<string>();
    return run.steps.flatMap((step) => {
        const ready = (needsOf.get(step.stepId) ?? []).every((need) => stateOf.get(need) === `done`);
        if (step.state !== `pending` || !ready || seen.has(step.conversationId)) {
            return [];
        }
        seen.add(step.conversationId);
        return [sessionOf(run, step.stepId, step.conversationId)];
    });
};

// Same chats regardless of order; neither caller cares which order dagre put a band in.
const sameChats = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((id) => b.includes(id));

// What a following panel should show. Follows the front, not merely what's running, so the first steps appear at the
// press instead of an empty diagram. Undefined means leave the panes alone: between bands, at the run's end, or when
// the front already matches what's showing.
export const runToFollow = (run: WorkflowRun, showing: readonly string[]): RunSession[] | undefined => {
    // Fills from the front only while the panes hold none of this run yet; once they do, only actually-running work
    // moves them.
    const front = paneShowsRun(run, showing) ? liveSessions(run) : frontSessions(run);
    // Not narrowed as members land one at a time: the question is whether anything live isn't yet showing, not whether
    // everything showing is live.
    // Vacuously true for an empty front too: nothing live has nothing to move the panes to.
    if (front.every((session) => showing.includes(session.conversationId))) {
        return undefined;
    }
    return front;
};

// Whether these chats are still following the run, or a deliberate look at something specific — decided from what was
// pressed, not a second gesture. The live band stays `live`; any other (finished, failed) band is `pinned`.
export const modeForSessions = (run: WorkflowRun, conversationIds: readonly string[]): ChatRunMode =>
    sameChats(
        conversationIds,
        frontSessions(run).map((session) => session.conversationId),
    )
        ? `live`
        : `pinned`;
