import { expect, test } from "vitest";
import { MODEL_ROLE_BLOCKS, MODEL_ROLES, type ModelRoleSpec } from "./model-roles.js";

// The catalog draws the settings page directly, so its properties (every role in one block) must hold of the table
// itself, not be remembered by whoever adds a row.

// Typed at its declared width, not the literal tuple: trigger is absent from a helper's type, under test here.
const roles: readonly ModelRoleSpec[] = MODEL_ROLES;

test("every whole session says what starts it, and it is the block it is drawn in", () => {
    const blockOf = new Map(MODEL_ROLE_BLOCKS.flatMap((block) => block.roles.map((role) => [role.id, block.id] as const)));

    for (const role of roles) {
        expect(role.kind === `run` ? role.trigger : role.kind, role.id).toBe(blockOf.get(role.id));
    }
});

test("a one-shot declares no trigger at all: nothing presses a commit subject into being", () => {
    for (const helper of roles.filter((role) => role.kind === `helper`)) {
        expect(Object.keys(helper), helper.id).not.toContain(`trigger`);
    }
});

test("the blocks hold every role once, in the table's own order", () => {
    const blocked = MODEL_ROLE_BLOCKS.flatMap((block) => block.roles.map((role) => role.id));

    expect(blocked.toSorted()).toEqual(MODEL_ROLES.map((role) => role.id).toSorted());
    // The block order mirrors reach ordering (unpicked jobs, then click-started sessions, then auto-started ones).
    expect(blocked).toEqual(MODEL_ROLES.map((role) => role.id));
});

test("each block says what it is, so the page keeps no headings of its own", () => {
    for (const block of MODEL_ROLE_BLOCKS) {
        expect(block.label, block.id).toMatch(/\S/);
        // A block with nothing in it would draw a heading over an empty surface.
        expect(block.roles.length, block.id).toBeGreaterThan(1);
    }
});
