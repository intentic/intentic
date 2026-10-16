import "@intentic/testing/dom";
import type { Workflow, WorkflowRun, WorkflowStep, WorkflowStepRun } from "@intentic/sandbox-contract/schemas/workflows";
import { stepSubtitle, toneFor, workflowDag } from "./workflowDag";

// The chat's own picture of a run, kept now that the Workflows page is an installed extension rather than compiled in:
// what the edges say about handoff and stalls, and what a node says about its step.

const step = (id: string, over: Partial<WorkflowStep> = {}): WorkflowStep => ({
    id,
    title: id,
    prompt: `do ${id}`,
    needs: [],
    handoff: `fresh`,
    output: { kind: `claim` },
    checks: [],
    context: `fresh`,
    ...over,
});

const workflow = (steps: readonly WorkflowStep[]): Workflow => ({ id: `wf`, name: `a workflow`, steps: [...steps], maxParallel: 2 });

const runOf = (wf: Workflow, states: Readonly<Record<string, WorkflowStepRun["state"]>>): WorkflowRun => ({
    runId: `r1`,
    workflow: wf,
    repos: [{ repo: `root`, base: `1111111111111111111111111111111111111111` }],
    state: `running`,
    startedAt: 0,
    resumed: 0,
    steps: Object.entries(states).map(([stepId, state]) => ({ stepId, state, conversationId: `wf-r1-${stepId}`, iterations: 0 })),
});

test(`a continued handoff draws solid and tinted, a fresh one dashed`, () => {
    const wf = workflow([step(`a`), step(`b`, { needs: [`a`], handoff: `continue` }), step(`c`, { needs: [`a`] })]);
    expect(workflowDag(wf).edges).toEqual([
        { from: `a`, to: `b`, dashed: false, dimmed: false, accent: `text-link` },
        { from: `a`, to: `c`, dashed: true, dimmed: false },
    ]);
});

test(`edges past a failed or skipped step are dimmed, and a dangling or self need is not drawn`, () => {
    const wf = workflow([step(`a`), step(`b`, { needs: [`a`, `gone`, `b`] })]);
    expect(workflowDag(wf, runOf(wf, { a: `failed`, b: `skipped` })).edges).toEqual([{ from: `a`, to: `b`, dashed: true, dimmed: true }]);
});

test(`a node carries its 1-based index, its run, and its goal as the tooltip only when it has one`, () => {
    const wf = workflow([step(`a`, { goal: `a is done` }), step(`b`)]);
    const { nodes } = workflowDag(wf, runOf(wf, { a: `done` }));
    expect(nodes.map((node) => [node.id, node.data.index, node.data.run?.state, node.tooltip])).toEqual([
        [`a`, 1, `done`, `a is done`],
        [`b`, 2, undefined, undefined],
    ]);
    expect(`tooltip` in (nodes[1] ?? {})).toBe(false);
});

test(`a step with no run is neutral, a failed one reads as danger`, () => {
    const wf = workflow([step(`a`)]);
    const [unrun] = workflowDag(wf).nodes;
    const [failed] = workflowDag(wf, runOf(wf, { a: `failed` })).nodes;
    expect(unrun && toneFor(unrun.data).icon).toBe(`sitemap`);
    expect(failed && toneFor(failed.data).text).toBe(`text-danger`);
});

test(`the subtitle names a pinned provider, the output and each check`, () => {
    const line = stepSubtitle(
        step(`a`, {
            output: { kind: `json`, fields: [{ name: `x`, type: `string`, description: `the answer`, required: true }] },
            checks: [{ kind: `command`, command: `pnpm test` }],
        }),
    );
    expect(line.split(` · `)).toHaveLength(2);
});
