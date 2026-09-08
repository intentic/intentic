import { expect, test } from "vitest";
import { reactive, ref, shallowRef } from "vue";
import { WORKFLOW_TEMPLATES } from "./templates";
import { editableCopy } from "./workflowDraft";

// Pins the fix for `structuredClone` throwing `DataCloneError` on a Vue reactive proxy, which crashed `setup()`. Values
// here are put through real Vue refs, since pure-data tests never caught it.

const template = () => WORKFLOW_TEMPLATES[0]?.workflow ?? (undefined as never);

test("a draft can be taken from a value held in a deep ref: what the parent used to hand over", () => {
    const held = ref(template());
    // `ref(.value)` is a proxy: the shape that throws under `structuredClone`.
    expect(() => editableCopy(held.value)).not.toThrow();
    expect(editableCopy(held.value)).toEqual(template());
});

test("a draft can be taken from query data: what the edit button hands over", () => {
    // Mimics the list's reactive store, which is what an edit actually hands the designer.
    const fromQuery = reactive({ ...template(), runs: [] });
    expect(() => editableCopy(fromQuery)).not.toThrow();
    expect(editableCopy(fromQuery).steps).toEqual(template().steps);
});

test("a draft can be taken from a shallowRef and from a plain object alike", () => {
    const held = shallowRef(template());
    expect(editableCopy(held.value)).toEqual(template());
    expect(editableCopy(template())).toEqual(template());
});

test("the copy is detached: editing a draft must not write through to the saved workflow", () => {
    const original = template();
    const held = ref(original);
    const draft = editableCopy(held.value);
    draft.name = `renamed`;
    const firstStep = draft.steps[0];
    if (firstStep !== undefined) {
        firstStep.goal = `changed`;
    }
    // Nested field, too: a shallow copy would let this edit through and break Cancel.
    expect(original.name).not.toBe(`renamed`);
    expect(original.steps[0]?.goal).not.toBe(`changed`);
});

test("every template survives the round trip unchanged: the copy is not allowed to quietly drop a field", () => {
    for (const { workflow } of WORKFLOW_TEMPLATES) {
        expect(editableCopy(reactive(workflow)), workflow.id).toEqual(workflow);
    }
});
