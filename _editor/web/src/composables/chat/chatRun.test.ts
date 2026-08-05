// @vitest-environment jsdom
import type { Workflow, WorkflowRun, WorkflowStep, WorkflowStepRun } from "@intentic/sandbox-contract";
import { expect, test, vi } from "vitest";

/* The arithmetic under test is pure, but it reaches dagre through `@intentic/ui`'s index — and that module
 * graph includes components whose `useDevice` reads `window.matchMedia` as they load, which jsdom does not
 * implement. Stubbed rather than `vi.mock`ed away, because the LAYOUT is the thing being tested: mocking the
 * module out would leave these assertions checking a stand-in's idea of where the columns are.
 */
vi.hoisted(() => {
    Object.defineProperty(globalThis, `matchMedia`, {
        writable: true,
        value: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
    });
});

import { modeForSessions, paneShowsRun, runColumns, runOnFocus, runToFollow, showingRunGraph } from "./chatRun";

/* WHICH SESSIONS A COLUMN OPENS. The graph's one gesture is "click a step, get its whole column", so this is
 * the arithmetic between a click and a pane set — and it is the part that cannot be checked by looking, since
 * being wrong shows up as the right number of panes holding the wrong chats.
 */

const step = (id: string, over: Partial<WorkflowStep> = {}): WorkflowStep => ({
    id,
    title: id,
    goal: `${id} is done`,
    prompt: `do ${id}`,
    needs: [],
    handoff: `fresh`,
    output: { kind: `claim` },
    checks: [],
    context: `fresh`,
    ...over,
});

const run = (steps: readonly WorkflowStep[], runs: readonly Partial<WorkflowStepRun>[]): WorkflowRun => {
    const workflow: Workflow = { id: `wf`, name: `a workflow`, steps: [...steps], maxParallel: 2 };
    return {
        runId: `r1`,
        workflow,
        state: `running`,
        startedAt: 0,
        resumed: 0,
        steps: steps.map((one, at) => ({
            stepId: one.id,
            state: `running`,
            conversationId: `wf-r1-${one.id}`,
            iterations: 1,
            ...runs[at],
        })),
    };
};

/* THE FAN-OUT IS THE CASE THIS EXISTS FOR: two attempts at one brief are drawn as one band, and clicking
 * either of them has to open BOTH — that comparison is the whole reason somebody designed the workflow.
 */
test("steps that fan out from one predecessor share a column", () => {
    const columns = runColumns(
        run([step(`brief`), step(`a`, { needs: [`brief`] }), step(`b`, { needs: [`brief`] }), step(`merge`, { needs: [`a`, `b`] })], []),
    );
    expect(columns.get(`a`)?.stepIds).toEqual(columns.get(`b`)?.stepIds);
    expect([...(columns.get(`a`)?.stepIds ?? [])].toSorted()).toEqual([`a`, `b`]);
    expect(columns.get(`a`)?.sessions.map((session) => session.conversationId)).toEqual([`wf-r1-a`, `wf-r1-b`]);
    // The brief and the merge are their own bands — a column is what is drawn side by side, not the whole run.
    expect(columns.get(`brief`)?.stepIds).toEqual([`brief`]);
    expect(columns.get(`merge`)?.stepIds).toEqual([`merge`]);
});

// A `continue` step runs ON its predecessor's conversation. Two panes of one chat is one pane, so the column
// has to say so itself rather than leaving `setPanes` to quietly dedupe a set the caller thought was two.
test("a column holding a continued step opens one conversation, not two", () => {
    const columns = runColumns(
        run([step(`first`), step(`carry`, { needs: [`first`], handoff: `continue` })], [{}, { conversationId: `wf-r1-first` }]),
    );
    expect(columns.get(`carry`)?.sessions.map((session) => session.conversationId)).toEqual([`wf-r1-first`]);
});

/* THE REGRESSION THE USER HIT: clicking most of a failed run's diagram did nothing at all.
 *
 * `skipped` reads like a state that ran, and it is the opposite — the step never started, because something
 * upstream did not finish. Its conversation id was written into the record before the run began and nothing
 * ever opened it, so every one of those nodes offered a chat that had never existed: no fleet card, no
 * transcript, and a click that resolved to an empty set in silence. A workflow that fails early is mostly made
 * of these, which is exactly when someone opens the diagram to find out why.
 */
test("a skipped step has no session — it never started", () => {
    const columns = runColumns(
        run(
            [step(`brief`), step(`a`, { needs: [`brief`] }), step(`b`, { needs: [`brief`] })],
            [{ state: `stopped` }, { state: `skipped`, iterations: 0 }, { state: `skipped`, iterations: 0 }],
        ),
    );
    expect(columns.get(`a`)?.sessions).toEqual([]);
    // The step that actually ran still opens, which is what keeps a failed run readable at all.
    expect(columns.get(`brief`)?.sessions.map((session) => session.conversationId)).toEqual([`wf-r1-brief`]);
});

// The design's pin rides along, so a session the fleet has swept off the roster can still be opened on the
// provider it actually ran — the seed for a composer whose transcript comes from the daemon either way.
test("a column carries the provider its step was pinned to", () => {
    const columns = runColumns(run([step(`a`, { agent: `codex` })], []));
    expect(columns.get(`a`)?.sessions[0]?.agent).toBe(`codex`);
});

/* THE REGRESSION THE TWO TESTS BELOW EXIST FOR: the diagram was a trap.
 *
 * It covers the panes, so with it up every other way of choosing a chat moved the focus under a picture that
 * did not move — the rail's cards, the board's cards, New agent. Every one of those clicks landed and none of
 * them reached the screen, which reads as the whole panel having frozen.
 */
test("focusing a chat of this run leaves the diagram for its sessions", () => {
    const design = run([step(`brief`), step(`a`, { needs: [`brief`] })], []);
    expect(runOnFocus(design, `wf-r1-a`, `graph`)).toEqual({ runId: `r1`, mode: `pinned` });
});

/* IT LANDS ON `pinned` AND NOT ON `live`, which is the difference between naming a chat and asking to be kept
 * up to date. The reader picked one session out of the run; a panel that then followed the run off it the next
 * time a step settled would be overruling the only instruction it was given.
 */
test("focusing a chat of this run does not put the panel back on the run's tail", () => {
    const design = run([step(`a`), step(`b`)], [{ state: `done` }, {}]);
    expect(runOnFocus(design, `wf-r1-a`, `graph`)?.mode).toBe(`pinned`);
});

// Already on the panes, a focus moving between the columns of the band being followed is not a decision about
// the run at all — so the mode is left exactly where it was, in either direction.
test("focusing inside the run from a pane mode changes nothing about the mode", () => {
    const design = run([step(`a`), step(`b`)], []);
    expect(runOnFocus(design, `wf-r1-a`, `live`)?.mode).toBe(`live`);
    expect(runOnFocus(design, `wf-r1-a`, `pinned`)?.mode).toBe(`pinned`);
});

// Focusing anything else means the reader has left: a run bar hanging over an unrelated transcript would be
// naming a run that has nothing to do with what is on screen.
test("focusing a chat outside the run leaves the run", () => {
    const design = run([step(`brief`)], []);
    expect(runOnFocus(design, `some-other-conversation`, `live`)).toBeUndefined();
});

/* A step that has not started names a conversation the daemon has not opened. Offering it would put an empty
 * chat on screen that explains neither itself nor the run — so the column knows it has nothing to show, which
 * is what lets the graph say so instead of swallowing the click.
 */
test("steps that never started contribute no session", () => {
    const columns = runColumns(run([step(`brief`), step(`later`, { needs: [`brief`] })], [{}, { state: `pending`, iterations: 0 }]));
    expect(columns.get(`brief`)?.sessions.map((session) => session.conversationId)).toEqual([`wf-r1-brief`]);
    expect(columns.get(`later`)?.sessions).toEqual([]);
});

/* FOLLOWING A RUN — the rule behind `live`, and the regression it exists for.
 *
 * The panel used to read the run's live sessions ONCE, at the press, and fall back to the diagram when there
 * were none. That is every run started from a composer: the daemon acks with every step still `pending`, so the
 * answer at that instant is always "nothing", and nothing afterwards moved the panel. The user pressed send,
 * got a picture, and watched two nodes go green on it while the transcripts they wanted stayed one unprompted
 * click away. So the reading is per-POLL rather than per-press, and these are the polls it has to act on.
 */
/* THE PRESS ITSELF, which is the case the whole thing exists for. The daemon acks with every step `pending`, so
 * "what is running" is empty at exactly the moment the reader is looking hardest — and answering that with the
 * diagram is what put a picture of two sessions on screen instead of the two sessions.
 */
test("a run that has only just been acked opens on its first steps", () => {
    const design = run(
        [step(`a`), step(`b`), step(`after`, { needs: [`a`, `b`] })],
        [
            { state: `pending`, iterations: 0 },
            { state: `pending`, iterations: 0 },
            { state: `pending`, iterations: 0 },
        ],
    );
    // The roots, and only the roots: `after` is pending too, but it is waiting on both of them and putting it
    // on screen would show the merge beside the attempts it has not been handed yet.
    expect(runToFollow(design, [`the-composer-they-typed-into`])?.map((session) => session.conversationId)).toEqual([`wf-r1-a`, `wf-r1-b`]);
});

// Once the turns actually begin, the same sessions are what is live — so the set does not change and the panes
// are not disturbed. The press and the first poll must agree, or the panel would reshuffle a second later.
test("the first poll after the turns begin changes nothing", () => {
    const design = run([step(`a`), step(`b`)], [{}, {}]);
    expect(runToFollow(design, [`wf-r1-a`, `wf-r1-b`])).toBeUndefined();
});

// A run that ENDED without starting a step has pending steps that will never open. Offering them would be
// offering chats that do not exist and never will.
test("a run that ended before starting anything offers nothing", () => {
    const design = run([step(`a`)], [{ state: `pending`, iterations: 0 }]);
    expect(runToFollow({ ...design, state: `stopped` }, [])).toBeUndefined();
});

// The poll on the far side of a band: both attempts have settled and the merge is up, so the panes move on
// without the reader pressing anything. This is "when both finish, they get to the next step", on screen.
test("a band giving way to the next moves the panes on", () => {
    const design = run([step(`a`), step(`b`), step(`after`, { needs: [`a`, `b`] })], [{ state: `done` }, { state: `done` }, { state: `running` }]);
    expect(runToFollow(design, [`wf-r1-a`, `wf-r1-b`])?.map((session) => session.conversationId)).toEqual([`wf-r1-after`]);
});

// Most polls. The set is already up, so there is nothing to do — and doing it anyway would reset the panes
// (and the focus with them) every few seconds for the entire length of a run.
test("a live band already on screen is left alone, whatever order it is in", () => {
    const design = run([step(`a`), step(`b`)], [{}, {}]);
    expect(runToFollow(design, [`wf-r1-a`, `wf-r1-b`])).toBeUndefined();
    expect(runToFollow(design, [`wf-r1-b`, `wf-r1-a`])).toBeUndefined();
});

/* THE BAND ON SCREEN IS HELD UNTIL THE NEXT ONE ACTUALLY STARTS. The merge becomes READY the instant the second
 * attempt lands, which is seconds before the scheduler picks it up — and following the ready-set there took two
 * transcripts a reader was comparing away and replaced them with an empty pane. */
test("a band that has finished is kept until the step after it is really working", () => {
    const design = run(
        [step(`a`), step(`b`), step(`after`, { needs: [`a`, `b`] })],
        [{ state: `done` }, { state: `done` }, { state: `pending`, iterations: 0 }],
    );
    expect(runToFollow(design, [`wf-r1-a`, `wf-r1-b`])).toBeUndefined();
    // Nothing of the run on screen is the other case, and it still fills from the ready set — that is what puts
    // the first sessions up on the press instead of a diagram.
    expect(runToFollow(design, [`the-composer-they-typed-into`])?.map((session) => session.conversationId)).toEqual([`wf-r1-after`]);
});

// Two attempts never land together, and the one still going is not a new band — narrowing the panes to it
// would close the finished transcript out from under whoever was reading it.
test("the pane of an attempt that has landed stays open while its partner finishes", () => {
    const design = run([step(`a`), step(`b`)], [{ state: `done` }, { state: `running` }]);
    expect(runToFollow(design, [`wf-r1-a`, `wf-r1-b`])).toBeUndefined();
});

/* A RUN THAT HAS ENDED KEEPS ITS LAST BAND ON SCREEN. "Nothing live" is true at both ends of a run and wants
 * opposite answers: at the start the panes hold chats that are not about the run, and at the end they hold the
 * work itself — which is exactly when the transcripts finally have the answer in them.
 */
test("a finished run does not clear the panes that hold its work", () => {
    const design = run([step(`a`), step(`b`)], [{ state: `done` }, { state: `done` }]);
    expect(runToFollow(design, [`wf-r1-a`, `wf-r1-b`])).toBeUndefined();
    // ...and that is why the diagram is decided from the PANES rather than from "is anything live".
    expect(paneShowsRun(design, [`wf-r1-a`])).toBe(true);
    expect(showingRunGraph(design, { runId: `r1`, mode: `live` }, [`wf-r1-a`])).toBe(false);
    expect(showingRunGraph(design, { runId: `r1`, mode: `live` }, [`an-unrelated-chat`])).toBe(true);
});

/* PRESSING A BAND ON THE DIAGRAM: the live one is a request to keep watching, anything else is a request to
 * stand still. Decided from what was pressed, because a reader who wanted the difference expressed as a second
 * gesture would have to know the mode existed.
 */
test("opening the live band keeps following, opening a settled one pins", () => {
    const design = run([step(`a`), step(`b`), step(`after`, { needs: [`a`, `b`] })], [{ state: `done` }, { state: `done` }, { state: `running` }]);
    expect(modeForSessions(design, [`wf-r1-after`])).toBe(`live`);
    expect(modeForSessions(design, [`wf-r1-a`, `wf-r1-b`])).toBe(`pinned`);
});

// The back arrow said "show me the map", so a step starting must not throw the reader back at the panes.
test("the diagram asked for outright stays up whatever the run does", () => {
    const design = run([step(`a`)], [{}]);
    expect(showingRunGraph(design, { runId: `r1`, mode: `graph` }, [`wf-r1-a`])).toBe(true);
});
