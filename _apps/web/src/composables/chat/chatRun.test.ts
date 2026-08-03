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

import { runColumns, runOnFocus, sessionsToOpen } from "./chatRun";

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
    maxIterations: 2,
    stallLimit: 2,
    ...over,
});

const run = (steps: readonly WorkflowStep[], runs: readonly Partial<WorkflowStepRun>[]): WorkflowRun => {
    const workflow: Workflow = { id: `wf`, name: `a workflow`, steps: [...steps], isolated: true, maxParallel: 2 };
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
test("focusing a chat of this run keeps the run and drops back to its sessions", () => {
    const design = run([step(`brief`), step(`a`, { needs: [`brief`] })], []);
    expect(runOnFocus(design, `wf-r1-a`)).toEqual({ runId: `r1`, mode: `sessions` });
});

// Focusing anything else means the reader has left: a run bar hanging over an unrelated transcript would be
// naming a run that has nothing to do with what is on screen.
test("focusing a chat outside the run leaves the run", () => {
    const design = run([step(`brief`)], []);
    expect(runOnFocus(design, `some-other-conversation`)).toBeUndefined();
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

/* WHAT "OPEN THIS RUN" LANDS ON — the sessions that are going, and only those.
 *
 * It briefly also offered the ROOTS of a just-started run, so the press would land in a chat rather than on a
 * picture. What it actually landed on was an empty composer under a "start a new Claude session" placeholder:
 * the daemon acks a run before any step has opened its conversation, so those tabs had nothing in them and
 * nothing to say about the run.
 */
test("a run whose steps have not started yet offers nothing to open", () => {
    const design = run(
        [step(`a`), step(`b`)],
        [
            { state: `pending`, iterations: 0 },
            { state: `pending`, iterations: 0 },
        ],
    );
    expect(sessionsToOpen(design)).toEqual([]);
});

// Once a step is going, that is what to show.
test("a run with something live opens on the live sessions", () => {
    const design = run([step(`a`), step(`b`), step(`after`, { needs: [`a`, `b`] })], [{ state: `done` }, { state: `done` }, { state: `running` }]);
    expect(sessionsToOpen(design).map((session) => session.conversationId)).toEqual([`wf-r1-after`]);
});
