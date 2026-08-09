import { PROVIDERS, type WorkflowStep, workflowFaults, WorkflowSchema } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { WORKFLOW_TEMPLATES } from "./templates";

/* Every template must be a workflow the daemon would actually accept. This is the whole test, and it earns its
 * place because a template is the one thing here that is never exercised before a user picks it: a broken one
 * is not a failing build, it is somebody's first impression of the feature refusing to save.
 */

test("every template parses as a workflow and has no faults", () => {
    for (const template of WORKFLOW_TEMPLATES) {
        const parsed = WorkflowSchema.safeParse(template.workflow);
        expect(parsed.success, `${template.workflow.id}: ${parsed.error?.issues[0]?.message ?? ``}`).toBe(true);
        expect(workflowFaults(template.workflow), template.workflow.id).toEqual([]);
    }
});

test("template ids are unique — the gallery hides one already saved under its id", () => {
    const ids = WORKFLOW_TEMPLATES.map((template) => template.workflow.id);
    expect(new Set(ids).size).toBe(ids.length);
});

/* THE GALLERY IS TWO CARDS OF THE SAME SHAPE, and every one of them has to keep it — that is what this asserts.
 * Five templates that were all straight chains would have looked like a full gallery and taught nothing; a
 * template that quietly loses its fan-in is the same failure, and the second card is no excuse for it. Nothing
 * else in the build would notice.
 *
 * The CONTINUED handoff is not among these any more: the template's last two steps were one session made to
 * stop and hand itself a summary, and collapsing them into a single synthesis took the only `continue` in the
 * gallery with it. The shape is still in the contract and still drawn by the canvas; it is simply no longer
 * something this card teaches, and asserting it here would be asserting a step that exists to be asserted.
 */
test("the template teaches every shape", () => {
    for (const { workflow } of WORKFLOW_TEMPLATES) {
        const { steps } = workflow;
        // Branching by the same definition the page's own shape line uses: several steps starting at once,
        // whether they fan out from one predecessor or from the run itself. Both draw as a fork, which is what
        // a reader is actually recognizing when they read a template by its shape.
        const fansOut =
            steps.filter((step) => step.needs.length === 0).length > 1 ||
            steps.some((step) => steps.filter((other) => other.needs.includes(step.id)).length > 1);
        expect(fansOut, `${workflow.id}: nothing runs beside anything else`).toBe(true);
        expect(
            steps.some((step) => step.needs.length > 1),
            `${workflow.id}: nothing fans back in`,
        ).toBe(true);
        // Two steps on two different providers, which is the one thing a workflow does that talking to a single
        // agent for longer cannot get you. Without it this template is a chain with extra steps.
        expect(
            new Set(steps.flatMap((step) => (step.agent === undefined ? [] : [step.agent]))).size > 1,
            `${workflow.id}: nothing runs on a second model`,
        ).toBe(true);
    }
});

/* Candidate authors carry no completion paperwork, in either template, and are named after nothing.
 *
 * A declared output is a COMPLETION GATE — the step fails unless it writes a valid document, so an attempt that
 * built the thing and described it imperfectly takes the rest of the graph down with it — and it drags the whole
 * output contract into a prompt that is meant to be the user's own sentence. The neutral titles are the other
 * half: every downstream step is handed its predecessors under `### From "<title>"`, so "Claude's attempt" leaks
 * the authorship the comparison exists to hold blind.
 */
test("the attempts are unburdened and anonymous in every template", () => {
    for (const { workflow } of WORKFLOW_TEMPLATES) {
        const attempts = workflow.steps.filter((step) => step.id.startsWith(`attempt-`));
        expect(
            attempts.every((step) => step.output.kind === `none` && step.checks.length === 0),
            workflow.id,
        ).toBe(true);
        expect(new Set(attempts.map((step) => step.title)), workflow.id).toEqual(new Set([`Attempt A`, `Attempt B`]));
    }
});

/* THE CARD PEOPLE CLICK FIRST SHIPS NO SCAFFOLDING AT ALL — the assertion that was deleted once already, and
 * with it the default grew a fourth session, a six-field rubric and a judge.
 *
 * Both of those controls are real and both are demonstrated on the second card. Neither belongs in the thing a
 * person opens before they understand what either does: a scoring pass costs a whole extra model call before
 * anything lands, and a completion gate is a way for a run that built the thing correctly to report failure.
 */
test("the default template is three steps and no completion scaffolding", () => {
    const simple = WORKFLOW_TEMPLATES[0]?.workflow;
    expect(simple?.id).toBe(`two-models-one-task`);
    expect(simple?.steps.map((step) => step.id)).toEqual([`attempt-a`, `attempt-b`, `synthesise`]);
    for (const step of simple?.steps ?? []) {
        expect(step.output.kind, `${step.id} declares an output, which gates its completion`).toBe(`none`);
        expect(step.checks, `${step.id} declares a check against a tree the template cannot see`).toEqual([]);
    }
});

/* THE SECOND CARD IS THE ONE THAT TEACHES THE MACHINERY, and it is the only reason those code paths are
 * exercised by anything a user can click. Evaluation must be structured so synthesis receives evidence rather
 * than another essay, blind to authorship on a provider that wrote neither attempt, and synthesis must have an
 * independent check so a clean turn or an unverified test claim cannot finish the graph by itself. */
test("the scored template separates blind evaluation from checked synthesis", () => {
    const scored = WORKFLOW_TEMPLATES.find(({ workflow }) => workflow.id === `two-models-scored`)?.workflow;
    expect(scored, `the gallery lost the template that demonstrates outputs and checks`).toBeDefined();
    const attempts = scored?.steps.filter((step) => step.id.startsWith(`attempt-`)) ?? [];

    const evaluation = scored?.steps.find((step) => step.id === `evaluate`);
    expect(evaluation?.output.kind).toBe(`json`);
    expect(evaluation?.agent).toBeDefined();
    expect(evaluation?.agent).not.toBe(attempts[0]?.agent);
    expect(evaluation?.agent).not.toBe(attempts[1]?.agent);

    const synthesis = scored?.steps.find((step) => step.id === `synthesise`);
    expect(synthesis?.agent).toBeDefined();
    expect(synthesis?.output.kind).not.toBe(`none`);
    expect(synthesis?.checks.length).toBeGreaterThan(0);
    expect(synthesis?.needs).toEqual(expect.arrayContaining([`attempt-a`, `attempt-b`, `evaluate`]));
});

/* THE ROOTS ARE HANDED THE USER'S SENTENCE AND NOTHING ELSE — the property the whole default rests on, and the
 * one that silently rots. Every step that starts the run must declare no prompt and no goal, so what reaches
 * the model is the request verbatim (workflow-brief). Writing "build what the request above asks for" into one
 * of them would look like helpful prefill and would be the wrapper, retyped by hand.
 */
test("the steps that start a run add nothing to what the user typed", () => {
    for (const { workflow } of WORKFLOW_TEMPLATES) {
        for (const root of workflow.steps.filter((step) => step.needs.length === 0)) {
            expect(root.prompt, `${workflow.id}/${root.id} paraphrases the request instead of taking it`).toBeUndefined();
            expect(root.goal, `${workflow.id}/${root.id} declares a goal the request should be`).toBeUndefined();
        }
    }
});

// Two steps that wait for exactly the same thing and run on different models: the arms of a comparison.
const sameNeeds = (first: WorkflowStep, second: WorkflowStep): boolean =>
    first.needs.length === second.needs.length && first.needs.every((need) => second.needs.includes(need));

const racingPairs = (steps: readonly WorkflowStep[]): [WorkflowStep, WorkflowStep][] =>
    steps.flatMap((first, at) =>
        steps
            .slice(at + 1)
            .filter((second) => sameNeeds(first, second) && first.agent !== undefined && second.agent !== undefined && first.agent !== second.agent)
            .map((second): [WorkflowStep, WorkflowStep] => [first, second]),
    );

/* THE PROPERTY THE TEMPLATE'S WHOLE POINT RESTS ON: racing attempts differ ONLY by model.
 *
 * A comparison measures whatever differs between its arms. Let one arm's prompt drift by a sentence and the run
 * quietly stops being about the models and starts being about the prompt — which is invisible on the graph,
 * invisible in the run view, and only ever noticed by someone who reads both transcripts and wonders why one
 * of them built something else. Asserted rather than trusted to review, because the two step literals sit forty
 * lines apart and editing one of them is exactly how this breaks.
 */
test("attempts that race each other are given the identical task — only the model differs", () => {
    const pairs = WORKFLOW_TEMPLATES.flatMap(({ workflow }) => racingPairs(workflow.steps).map((pair) => ({ id: workflow.id, pair })));
    // Vacuously true is the one way this test could pass while the gallery lost the shape it is here for.
    expect(pairs.length, `no template runs two models against one brief`).toBeGreaterThan(0);
    for (const { id, pair } of pairs) {
        const [first, second] = pair;
        const task = (step: WorkflowStep) => ({ prompt: step.prompt, goal: step.goal, output: step.output, checks: step.checks });
        expect(task(first), `${id}: "${first.title}" and "${second.title}" were not given the same task`).toEqual(task(second));
    }
});

// A template can only pin a provider the app itself offers: an id from an installed ACP capability is legal on
// the wire and useless as prefill, since the user picking the template may not have that capability at all.
test("every pinned provider is one the picker offers", () => {
    const known = PROVIDERS.map((provider) => provider.value);
    for (const { workflow } of WORKFLOW_TEMPLATES) {
        for (const pinned of workflow.steps.filter((step) => step.agent !== undefined)) {
            expect(known, `${workflow.id}/${pinned.id}`).toContain(pinned.agent);
        }
    }
});

// A step whose description is empty gets you the model's guess at what the field means, which is the one
// failure mode declared outputs exist to prevent.
test("every declared field says what it is for", () => {
    for (const template of WORKFLOW_TEMPLATES) {
        for (const step of template.workflow.steps) {
            if (step.output.kind !== `json`) {
                continue;
            }
            for (const field of step.output.fields) {
                expect(field.description.trim(), `${template.workflow.id}/${step.id}/${field.name}`).not.toBe(``);
            }
        }
    }
});
