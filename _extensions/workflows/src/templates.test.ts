import { workflowFaults, WorkflowSchema } from "@intentic/sandbox-contract";
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

/* The gallery's promise is that it teaches SHAPES, so the set has to contain more than one. Asserted rather
 * than left to review: five templates that are all straight chains would look like a full gallery and teach
 * nothing, and nothing else in the build would notice.
 */
test("the gallery covers more than one shape", () => {
    // Branching by the same definition the page's own shape line uses: several steps starting at once, whether
    // they fan out from one predecessor or from the run itself. Both draw as a fork, which is what a reader is
    // actually recognizing when they pick a template by its shape.
    const branching = WORKFLOW_TEMPLATES.filter(
        (template) =>
            template.workflow.steps.filter((step) => step.needs.length === 0).length > 1 ||
            template.workflow.steps.some((step) => template.workflow.steps.filter((other) => other.needs.includes(step.id)).length > 1),
    );
    const fanIn = WORKFLOW_TEMPLATES.filter((template) => template.workflow.steps.some((step) => step.needs.length > 1));
    const continued = WORKFLOW_TEMPLATES.filter((template) => template.workflow.steps.some((step) => step.handoff === `continue`));
    const structured = WORKFLOW_TEMPLATES.filter((template) => template.workflow.steps.some((step) => step.output.kind === `json`));
    const commanded = WORKFLOW_TEMPLATES.filter((template) =>
        template.workflow.steps.some((step) => step.checks.some((check) => check.kind === `command`)),
    );

    expect(branching.length).toBeGreaterThan(0);
    expect(fanIn.length).toBeGreaterThan(0);
    expect(continued.length).toBeGreaterThan(0);
    expect(structured.length).toBeGreaterThan(0);
    expect(commanded.length).toBeGreaterThan(0);
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
