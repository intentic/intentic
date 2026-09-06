import { expect, test } from "vitest";
import { MODEL_ROLE_BLOCKS, MODEL_ROLES, type ModelRoleSpec } from "./model-roles.js";

/* THE CATALOG DRAWS THE SETTINGS PAGE, so the properties the page relies on have to be true of the TABLE rather
 * than remembered by whoever last added a row. Eighteen jobs in one unbroken list is what the blocks exist to
 * break up, and the failure they replace is a silent one: a role that belongs to no block is simply missing
 * from Sandbox ▸ Agent ▸ Models, with no error anywhere and a page that looks completely normal. */

// The table at its declared width rather than as the literal tuple: `trigger` is absent from a helper's literal
// type, and what is under test is exactly whether it is absent where it should be.
const roles: readonly ModelRoleSpec[] = MODEL_ROLES;

/* WHAT STARTS A RUN IS THE BLOCK IT IS READ IN, and asserting the two against each other is what stops them
 * drifting: a run whose trigger says one thing while the page draws it under the other heading is a row telling
 * an owner that a session nobody is watching is one they start. A helper answers with its own kind, because it
 * has no trigger and its block is the kind itself. */
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

/* THE BLOCKS PARTITION THE TABLE: every role in exactly one, nothing invented. Asserted as a partition rather
 * than block by block, because the two ways to get this wrong are opposites and only one of them is visible —
 * a role in no block vanishes from the page, a role in two is drawn twice and would be caught by eye. */
test("the blocks hold every role once, in the table's own order", () => {
    const blocked = MODEL_ROLE_BLOCKS.flatMap((block) => block.roles.map((role) => role.id));

    expect(blocked.toSorted()).toEqual(MODEL_ROLES.map((role) => role.id).toSorted());
    /* AND THE ORDER SURVIVES THE SPLIT. Reading the blocks in order is reading the table in order: the table
     * argues its sequence is REACH (jobs nobody picked a model for, then sessions a click starts, then sessions
     * that start without one), and a block re-sorted here would leave that argument describing a page it no
     * longer matches. */
    expect(blocked).toEqual(MODEL_ROLES.map((role) => role.id));
});

/* A BLOCK IS A HEADING AND THE ROLES UNDER IT. It also has to hold MORE THAN ONE, which is a load-bearing
 * claim rather than a tidiness one now: the settings page collapses a block into a single shared list, and a
 * block of one would draw that as "one list for all 1 jobs" over the row it is already drawing. */
test("each block says what it is, so the page keeps no headings of its own", () => {
    for (const block of MODEL_ROLE_BLOCKS) {
        expect(block.label, block.id).toMatch(/\S/);
        // A block with nothing in it would draw a heading over an empty surface.
        expect(block.roles.length, block.id).toBeGreaterThan(1);
    }
});
