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

import { runColumns } from "./chatRun";

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
    expect(columns.get(`a`)?.conversationIds).toEqual([`wf-r1-a`, `wf-r1-b`]);
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
    expect(columns.get(`carry`)?.conversationIds).toEqual([`wf-r1-first`]);
});

/* A step that has not started names a conversation the daemon has not opened. Offering it would put an empty
 * chat on screen that explains neither itself nor the run — so the column knows it has nothing to show, which
 * is what lets the graph say so instead of swallowing the click.
 */
test("steps that never started contribute no session", () => {
    const columns = runColumns(run([step(`brief`), step(`later`, { needs: [`brief`] })], [{}, { state: `pending`, iterations: 0 }]));
    expect(columns.get(`brief`)?.conversationIds).toEqual([`wf-r1-brief`]);
    expect(columns.get(`later`)?.conversationIds).toEqual([]);
});
