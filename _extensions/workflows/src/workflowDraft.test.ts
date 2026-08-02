import { expect, test } from "vitest";
import { reactive, ref, shallowRef } from "vue";
import { WORKFLOW_TEMPLATES } from "./templates";
import { editableCopy } from "./workflowDraft";

/* THE REGRESSION THIS FILE EXISTS FOR.
 *
 * The designer took its draft with `structuredClone`, which throws `DataCloneError` on a Vue reactive proxy —
 * and a reactive proxy is what it is handed on every single path into it. The throw was inside `setup()`, so
 * the dialog never mounted: New, every template card and the edit pencil were all a crash, and the feature
 * read as broken rather than one control in it.
 *
 * Nothing caught it because every test was of PURE DATA and the crash needed a value that had been through
 * Vue. So these tests put the value through Vue — three ways, because the three doors into the designer wrap
 * it differently — and assert the copy comes out equal and detached. No DOM and no component: the fault was
 * never in the rendering, it was in cloning something reactive, and that is testable on its own.
 */

const template = () => WORKFLOW_TEMPLATES[0]?.workflow ?? (undefined as never);

test("a draft can be taken from a value held in a deep ref — what the parent used to hand over", () => {
    const held = ref(template());
    // `ref(.value)` is a proxy; this is the exact expression that threw.
    expect(() => editableCopy(held.value)).not.toThrow();
    expect(editableCopy(held.value)).toEqual(template());
});

test("a draft can be taken from query data — what the edit button hands over", () => {
    // The list's workflows come out of a reactive store, so an edit passes a proxy whatever the parent does.
    const fromQuery = reactive({ ...template(), runs: [] });
    expect(() => editableCopy(fromQuery)).not.toThrow();
    expect(editableCopy(fromQuery).steps).toEqual(template().steps);
});

test("a draft can be taken from a shallowRef and from a plain object alike", () => {
    const held = shallowRef(template());
    expect(editableCopy(held.value)).toEqual(template());
    expect(editableCopy(template())).toEqual(template());
});

test("the copy is detached — editing a draft must not write through to the saved workflow", () => {
    const original = template();
    const held = ref(original);
    const draft = editableCopy(held.value);
    draft.name = `renamed`;
    const firstStep = draft.steps[0];
    if (firstStep !== undefined) {
        firstStep.goal = `changed`;
    }
    // Nested too: a shallow copy would have let the step edit through, which is the failure that would make
    // "Cancel" not actually cancel.
    expect(original.name).not.toBe(`renamed`);
    expect(original.steps[0]?.goal).not.toBe(`changed`);
});

test("every template survives the round trip unchanged — the copy is not allowed to quietly drop a field", () => {
    for (const { workflow } of WORKFLOW_TEMPLATES) {
        expect(editableCopy(reactive(workflow)), workflow.id).toEqual(workflow);
    }
});
