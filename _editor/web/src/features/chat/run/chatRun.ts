import type { AgentHarness, WorkflowRun } from "@intentic/sandbox-contract";
import { ref } from "vue";

/* A WORKFLOW RUN, INSIDE THE CHAT PANEL, the state behind "show me what this run is doing".
 *
 * WHY IT IS NOT A NAVIGATION. Opening a run used to send the main view to the workflows extension, which is
 * the wrong half of the screen: what a person wants from a live run is the SESSIONS, and sessions are chats.
 * Sending them to a page elsewhere meant leaving the panel that can show four transcripts at once in order to
 * look at a picture of them. So the run rides in the chat panel, which already knows how to put N conversations
 * side by side, and the picture is a mode of that panel rather than a different address.
 *
 * THREE MODES, AND ONLY ONE OF THEM MOVES.
 *
 * `live` is where every run lands and where it stays until the reader says otherwise: the panes show whatever
 * the run has going, and they MOVE WITH IT, when both attempts of a fan-out finish and the merge starts, the
 * merge is what is on screen. A run has no single moment worth freezing on, so following it is the only mode
 * that describes what the reader actually asked for ("show me my workflow"), and it is the reason the other two
 * are defined against it rather than the other way round. It renders the DIAGRAM while nothing is live, which
 * covers both ends: the seconds after a start, before the first step has opened its conversation, and a
 * finished run, which has nothing to follow and whose map is the right thing to land on.
 *
 * `graph` is the diagram because the reader pressed the back arrow. It does not promote itself when a step
 * starts, that press said "show me the map", and a map that jumps back to the panes underneath it is a map you
 * cannot read.
 *
 * `pinned` is the panes the reader chose out of that map. It does not move either, for the same reason: they
 * named a band, and following would yank them off it mid-read.
 *
 * The run itself is NOT held here, only its id: the ledger is polled (useWorkflowRuns) and a snapshot taken at
 * click time would freeze the graph at the moment it was opened, every node still `pending`, forever.
 */

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

// Every conversation this run drives, whether or not the step has started. A `continue` step shares its
// predecessor's, so this set is smaller than the step count.
const runHolds = (run: WorkflowRun, conversationId: string): boolean => run.steps.some((step) => step.conversationId === conversationId);

/* Whether the panes are showing any of this run's own chats, which is how a FOLLOWING panel decides between
 * the diagram and the columns, and it is a better question than "is anything live".
 *
 * "Nothing live" is true at both ends of a run and wants opposite answers. At the start the panes hold whatever
 * the reader was on when they pressed send, the composer they typed into, an unrelated chat, and none of it
 * is about the run, so the diagram is the only honest thing to draw. At the end the panes hold the last band,
 * which is the work itself, and replacing it with a picture would take the transcripts away at the moment they
 * finally have the answer in them. Asking what the panes CONTAIN separates the two without a flag.
 */
export const paneShowsRun = (run: WorkflowRun, showing: readonly string[]): boolean => showing.some((id) => runHolds(run, id));

/* WHETHER THE DIAGRAM IS WHAT THE PANEL IS DRAWING. Two surfaces ask it: the panel, which draws it, and the
 * fleet board, which has to take the selection ring off every card while it is up, a ring says "that chat is
 * what you are looking at", and over a panel showing a picture of a graph that is simply false.
 *
 * ONE FUNCTION, because the two disagreeing is the failure itself and neither side can detect it alone: a board
 * ringing a card the panel is not showing looks, from the board, exactly like a board that is right.
 *
 * `graph` is the mode that says so outright. `live` says it only while the panes have nothing of this run in
 * them, which is the window between pressing send and the first step opening its conversation, see
 * paneShowsRun for why that is asked of the PANES rather than of the run's own state.
 */
export const showingRunGraph = (run: WorkflowRun | undefined, view: ChatRunView | undefined, showing: readonly string[]): boolean =>
    run !== undefined && (view?.mode === `graph` || (view?.mode === `live` && !paneShowsRun(run, showing)));

/* WHAT A FOCUS CHANGE DOES TO THE RUN ON SCREEN, the rule that keeps the diagram from being a trap.
 *
 * The diagram covers the panes, so while it is up every other way of choosing a chat, a card on the rail, a
 * card on the board, New agent, a deep link, moved the focus under a picture that did not move. The panel
 * looked frozen: the click landed, the panes behind it were reconciled, and none of it reached the screen.
 * Anything that moves the focus is therefore an exit from the diagram.
 *
 * WHERE IT EXITS TO is the honest reading of the gesture. A chat that belongs to this run means "show me this
 * part of it", so the run stays and the back arrow with it. Any other chat means the reader has left, and the
 * run goes with them rather than hanging a stale run's name over an unrelated transcript.
 *
 * IT LANDS ON `pinned`, NOT ON `live`, and only out of `graph`. The reader named ONE chat, so the panel must
 * not then follow the run off it, which is exactly what `live` would do the next time a step settled. Out of
 * either pane mode the answer is to change nothing: the panes are already showing the run, and a focus moving
 * between the columns of a band it is following is not a decision to stop following it.
 *
 * A RUN NOBODY CAN SHOW US IS A RUN WE LET GO OF, which is why this takes an optional run rather than being
 * skipped when the ledger has no reading. The ledger is a cache with real gaps, it is emptied and refetched
 * whenever the daemon is rebuilt or the workspace replaced, and a read can simply not have landed yet, and
 * the caller used to return early through every one of them, dropping the release on the floor. What that
 * cost was not a missed frame: the run stayed held at `live`, so the next ledger push moved the panes back to
 * its step, and the one after that did it again. Every click the reader made afterwards was undone within the
 * second, by a run whose bar they could not see, and the only ways out were popping the panel out or
 * reloading. "The chat window is stuck on one session" is this, and nothing else in the panel can produce it.
 *
 * So the answer with no run in hand is the SAFE one rather than the silent one: we cannot show that this chat
 * belongs to the run, so the run stops driving what is on screen. The cost of being wrong that way is one
 * reader who has to press the run's card again; the cost of the other way is a panel that will not stay where
 * it is put.
 *
 * A function rather than eight lines inside a watcher because this is the whole rule, and a rule that only
 * exists inside an SFC is one no test can reach.
 */
export const runOnFocus = (run: WorkflowRun | undefined, conversationId: string, mode: ChatRunMode): ChatRunView | undefined =>
    run !== undefined && runHolds(run, conversationId) ? { runId: run.runId, mode: mode === `graph` ? `pinned` : mode } : undefined;

export interface RunSession {
    readonly conversationId: string;
    /* What the step's design pinned, for opening a conversation the fleet no longer lists. A step that ran
     * days ago has been swept off the roster, and its transcript is still there, so the seed only decides
     * which provider the composer opens on, and the daemon supplies everything that matters. Absent when the
     * step pinned nothing, which is most of them.
     */
    readonly agent: string | undefined;
    readonly harness: AgentHarness | undefined;
}

export interface RunColumn {
    // The steps dagre put at this depth, what the reader sees as one vertical band of the diagram.
    readonly stepIds: readonly string[];
    // The sessions behind them, deduped and in column order. Empty ⇒ nothing in this band ever ran, which is
    // what lets the diagram decline the click instead of swallowing it.
    readonly sessions: readonly RunSession[];
}

// One step run, as a session to open. Shared by every caller that turns part of a run into panes, the
// diagram's column module included (runColumns.ts).
export const sessionOf = (run: WorkflowRun, stepId: string, conversationId: string): RunSession => {
    const design = run.workflow.steps.find((step) => step.id === stepId);
    return { conversationId, agent: design?.agent, harness: design?.harness };
};

/* The sessions a run has ALIVE, where "open this run" lands before anyone has picked a column, and the count
 * its card reads "2 live" from. Deduped, because a `continue` step runs on its predecessor's conversation and
 * a run with two steps on one chat is showing one thing, not two.
 */
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

/* THE RUN'S FRONT, what is going, or when nothing is going yet, what is ABOUT to. This is what the panel
 * follows, and the difference from `liveSessions` is the whole of "I pressed send and got a diagram".
 *
 * The daemon acks a run with every step still `pending`, the scheduler has not run a line by the time the
 * press returns, so "what is running" is empty at exactly the moment the reader is looking hardest. Answering
 * with the diagram there was defensible and wrong: it is a picture of two sessions, shown instead of the two
 * sessions, and it makes starting a workflow feel like filing a request rather than starting an agent. The
 * conversation ids are DERIVED (`wf-<run>-<step>`) and written into the record before anything starts, so the
 * chats can be opened the instant the run exists; they fill a second later when the turns begin.
 *
 * READY, not merely pending: a step whose dependencies are still working is not about to do anything, and
 * opening it would put the merge on screen beside the attempts it is waiting for. At ack that leaves exactly
 * the roots, which is what "the first steps" means.
 *
 * Only while the run is GOING. A finished run's pending steps are pending forever, they were skipped or the
 * run was stopped, and offering them would be offering chats that will never exist.
 */
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

// Two pane sets naming the same chats, order-insensitive. Both rules below ask this, and neither of them has
// any business caring which order dagre happened to put a band in.
const sameChats = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((id) => b.includes(id));

/* WHAT A FOLLOWING PANEL SHOULD BE SHOWING, the rule behind `live`, and the one that makes starting a workflow
 * feel like starting an agent instead of like filing a request.
 *
 * IT FOLLOWS THE FRONT, NOT THE RUNNING SET (frontSessions), and that is what puts the first steps on screen at
 * the moment of the press. Following "what is running" meant following nothing at all for the first seconds of
 * every run, the daemon acks with every step `pending`, so the panel drew the diagram and the reader watched
 * a picture of two sessions instead of the two sessions.
 *
 * `undefined` ⇒ leave the panes alone, and it is the answer in the two cases that look like they want action. A
 * run between bands is one: the front is empty for as long as it takes the next step to be picked up, and the
 * panes still hold the work that just finished. A run that has ENDED is the other, and there the last band is
 * exactly what the reader came to read, clearing it would take the transcripts away at the moment they finally
 * have the answer in them. The third is a set already on screen, which is most polls; this runs on all of them.
 */
export const runToFollow = (run: WorkflowRun, showing: readonly string[]): RunSession[] | undefined => {
    /* THE BAND ON SCREEN IS NOT GIVEN UP FOR ONE THAT HAS NOT STARTED, which is the difference between a panel
     * that follows a run and one that snatches. `frontSessions` answers with steps that are merely READY the
     * moment their dependencies land, so the two attempts a reader was in the middle of comparing were
     * replaced by an empty merge pane the instant the second one finished, seconds before that merge had a
     * word in it. Once the panes hold this run's work, only a step that is actually RUNNING takes them.
     *
     * The ready-set still answers at the START, where the panes hold nothing of the run: the daemon acks with
     * every step pending, and waiting for `running` there is what used to leave a diagram on screen instead of
     * the sessions. So: fill from the front, move on live work. */
    const front = paneShowsRun(run, showing) ? liveSessions(run) : frontSessions(run);
    /* AND A BAND IS NOT NARROWED AS ITS MEMBERS LAND, which is the same rule one step finer. Two attempts do
     * not finish together: the first one to land takes itself out of the live set, and a panel that followed
     * that closed the pane out from under a reader mid-sentence. So the question is not "is the live set what
     * is showing" but "is there anything live that is NOT showing", which is true exactly when a new band has
     * started, and false for every poll in between. */
    // `every` answers true for the empty set too, which is the same answer for the same reason: a run with
    // nothing live has nothing to move the panes to.
    if (front.every((session) => showing.includes(session.conversationId))) {
        return undefined;
    }
    return front;
};

/* Whether putting these chats on screen is still FOLLOWING the run or is the reader going to look at something
 * specific, the whole difference between `live` and `pinned`, decided from what was pressed rather than from a
 * second gesture nobody would think to make.
 *
 * Pressing the band that is live means "show me what is happening now", which is what `live` already does and
 * must keep doing when this band gives way to the next. Pressing any other band, a finished attempt, a step
 * that failed an hour ago, is a decision to stand still, and a panel that followed the run out of it would be
 * answering a question the reader did not ask.
 */
export const modeForSessions = (run: WorkflowRun, conversationIds: readonly string[]): ChatRunMode =>
    sameChats(
        conversationIds,
        frontSessions(run).map((session) => session.conversationId),
    )
        ? `live`
        : `pinned`;
