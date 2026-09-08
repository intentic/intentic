// @vitest-environment jsdom
import type { Workflow, WorkflowRun, WorkflowStep, WorkflowStepRun } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";

// Needs jsdom: pure arithmetic still reaches dagre through @intentic/ui's index. Real modules, not mocks, since the
// layout itself is what's under test.
import { modeForSessions, paneShowsRun, runOnFocus, runToFollow, showingRunGraph } from "./chatRun";
import { runColumns } from "./runColumns";

// Which sessions a column opens: the arithmetic between a diagram click and a pane set, wrong in a way that only shows
// as right-numbered panes holding the wrong chats.

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
        repos: [{ repo: `root`, base: `1111111111111111111111111111111111111111` }],
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

test("steps that fan out from one predecessor share a column", () => {
    const columns = runColumns(
        run([step(`brief`), step(`a`, { needs: [`brief`] }), step(`b`, { needs: [`brief`] }), step(`merge`, { needs: [`a`, `b`] })], []),
    );
    expect(columns.get(`a`)?.stepIds).toEqual(columns.get(`b`)?.stepIds);
    expect([...(columns.get(`a`)?.stepIds ?? [])].toSorted()).toEqual([`a`, `b`]);
    expect(columns.get(`a`)?.sessions.map((session) => session.conversationId)).toEqual([`wf-r1-a`, `wf-r1-b`]);
    // A column is one band, not the whole run: brief and merge stand alone.
    expect(columns.get(`brief`)?.stepIds).toEqual([`brief`]);
    expect(columns.get(`merge`)?.stepIds).toEqual([`merge`]);
});

// One pane, not two: the column dedupes itself rather than leaving `setPanes` to do it silently.
test("a column holding a continued step opens one conversation, not two", () => {
    const columns = runColumns(
        run([step(`first`), step(`carry`, { needs: [`first`], handoff: `continue` })], [{}, { conversationId: `wf-r1-first` }]),
    );
    expect(columns.get(`carry`)?.sessions.map((session) => session.conversationId)).toEqual([`wf-r1-first`]);
});

test("a skipped step has no session, it never started", () => {
    const columns = runColumns(
        run(
            [step(`brief`), step(`a`, { needs: [`brief`] }), step(`b`, { needs: [`brief`] })],
            [{ state: `stopped` }, { state: `skipped`, iterations: 0 }, { state: `skipped`, iterations: 0 }],
        ),
    );
    expect(columns.get(`a`)?.sessions).toEqual([]);
    expect(columns.get(`brief`)?.sessions.map((session) => session.conversationId)).toEqual([`wf-r1-brief`]);
});

test("a column carries the provider its step was pinned to", () => {
    const columns = runColumns(run([step(`a`, { agent: `codex` })], []));
    expect(columns.get(`a`)?.sessions[0]?.agent).toBe(`codex`);
});

test("focusing a chat of this run leaves the diagram for its sessions", () => {
    const design = run([step(`brief`), step(`a`, { needs: [`brief`] })], []);
    expect(runOnFocus(design, `wf-r1-a`, `graph`)).toEqual({ runId: `r1`, mode: `pinned` });
});

test("focusing a chat of this run does not put the panel back on the run's tail", () => {
    const design = run([step(`a`), step(`b`)], [{ state: `done` }, {}]);
    expect(runOnFocus(design, `wf-r1-a`, `graph`)?.mode).toBe(`pinned`);
});

test("focusing inside the run from a pane mode changes nothing about the mode", () => {
    const design = run([step(`a`), step(`b`)], []);
    expect(runOnFocus(design, `wf-r1-a`, `live`)?.mode).toBe(`live`);
    expect(runOnFocus(design, `wf-r1-a`, `pinned`)?.mode).toBe(`pinned`);
});

test("focusing a chat outside the run leaves the run", () => {
    const design = run([step(`brief`)], []);
    expect(runOnFocus(design, `some-other-conversation`, `live`)).toBeUndefined();
});

test("steps that never started contribute no session", () => {
    const columns = runColumns(run([step(`brief`), step(`later`, { needs: [`brief`] })], [{}, { state: `pending`, iterations: 0 }]));
    expect(columns.get(`brief`)?.sessions.map((session) => session.conversationId)).toEqual([`wf-r1-brief`]);
    expect(columns.get(`later`)?.sessions).toEqual([]);
});

// runToFollow decides which sessions the panel should follow, re-evaluated on every poll rather than once at the press:
// a run acked with every step pending must not freeze the panel on "nothing".
test("a run that has only just been acked opens on its first steps", () => {
    const design = run(
        [step(`a`), step(`b`), step(`after`, { needs: [`a`, `b`] })],
        [
            { state: `pending`, iterations: 0 },
            { state: `pending`, iterations: 0 },
            { state: `pending`, iterations: 0 },
        ],
    );
    // Only the roots: `after` needs both `a` and `b`, so it isn't ready yet even though it's pending too.
    expect(runToFollow(design, [`the-composer-they-typed-into`])?.map((session) => session.conversationId)).toEqual([`wf-r1-a`, `wf-r1-b`]);
});

test("the first poll after the turns begin changes nothing", () => {
    const design = run([step(`a`), step(`b`)], [{}, {}]);
    expect(runToFollow(design, [`wf-r1-a`, `wf-r1-b`])).toBeUndefined();
});

test("a run that ended before starting anything offers nothing", () => {
    const design = run([step(`a`)], [{ state: `pending`, iterations: 0 }]);
    expect(runToFollow({ ...design, state: `stopped` }, [])).toBeUndefined();
});

test("a band giving way to the next moves the panes on", () => {
    const design = run([step(`a`), step(`b`), step(`after`, { needs: [`a`, `b`] })], [{ state: `done` }, { state: `done` }, { state: `running` }]);
    expect(runToFollow(design, [`wf-r1-a`, `wf-r1-b`])?.map((session) => session.conversationId)).toEqual([`wf-r1-after`]);
});

test("a live band already on screen is left alone, whatever order it is in", () => {
    const design = run([step(`a`), step(`b`)], [{}, {}]);
    expect(runToFollow(design, [`wf-r1-a`, `wf-r1-b`])).toBeUndefined();
    expect(runToFollow(design, [`wf-r1-b`, `wf-r1-a`])).toBeUndefined();
});

// The merge goes `ready` seconds before the scheduler actually starts it; following ready too early would swap two
// transcripts for an empty pane.
test("a band that has finished is kept until the step after it is really working", () => {
    const design = run(
        [step(`a`), step(`b`), step(`after`, { needs: [`a`, `b`] })],
        [{ state: `done` }, { state: `done` }, { state: `pending`, iterations: 0 }],
    );
    expect(runToFollow(design, [`wf-r1-a`, `wf-r1-b`])).toBeUndefined();
    expect(runToFollow(design, [`the-composer-they-typed-into`])?.map((session) => session.conversationId)).toEqual([`wf-r1-after`]);
});

test("the pane of an attempt that has landed stays open while its partner finishes", () => {
    const design = run([step(`a`), step(`b`)], [{ state: `done` }, { state: `running` }]);
    expect(runToFollow(design, [`wf-r1-a`, `wf-r1-b`])).toBeUndefined();
});

// "Nothing live" happens at both ends of a run for opposite reasons: empty at the start, and finished (with the answer
// in them) at the end.
test("a finished run does not clear the panes that hold its work", () => {
    const design = run([step(`a`), step(`b`)], [{ state: `done` }, { state: `done` }]);
    expect(runToFollow(design, [`wf-r1-a`, `wf-r1-b`])).toBeUndefined();
    // The diagram's visibility is decided from the panes, not from whether anything is live.
    expect(paneShowsRun(design, [`wf-r1-a`])).toBe(true);
    expect(showingRunGraph(design, { runId: `r1`, mode: `live` }, [`wf-r1-a`])).toBe(false);
    expect(showingRunGraph(design, { runId: `r1`, mode: `live` }, [`an-unrelated-chat`])).toBe(true);
});

test("opening the live band keeps following, opening a settled one pins", () => {
    const design = run([step(`a`), step(`b`), step(`after`, { needs: [`a`, `b`] })], [{ state: `done` }, { state: `done` }, { state: `running` }]);
    expect(modeForSessions(design, [`wf-r1-after`])).toBe(`live`);
    expect(modeForSessions(design, [`wf-r1-a`, `wf-r1-b`])).toBe(`pinned`);
});

test("the diagram asked for outright stays up whatever the run does", () => {
    const design = run([step(`a`)], [{}]);
    expect(showingRunGraph(design, { runId: `r1`, mode: `graph` }, [`wf-r1-a`])).toBe(true);
});
