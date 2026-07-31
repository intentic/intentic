import { expect, test } from "vitest";
import { approvalsFor } from "./catalog";

/* The plan card's approve buttons. Approving a plan is where a conversation's posture is re-chosen, so the
 * order matters: the mode the conversation was ALREADY in has to lead, or an agent that talked itself into
 * planning quietly costs the user the permissions they granted it. */

test("the conversation's own posture leads, and every other posture stays one click away", () => {
    expect(approvalsFor(`bypassPermissions`).map((approval) => approval.mode)).toEqual([`bypassPermissions`, `acceptEdits`, `default`]);
    expect(approvalsFor(`default`).map((approval) => approval.mode)).toEqual([`default`, `acceptEdits`, `bypassPermissions`]);
    expect(approvalsFor(`acceptEdits`)[0]).toEqual({ mode: `acceptEdits`, label: `Yes, and auto-accept edits` });
});

test("a conversation whose own pick is plan has nothing to restore, so auto-accept leads", () => {
    expect(approvalsFor(`plan`).map((approval) => approval.mode)).toEqual([`acceptEdits`, `bypassPermissions`, `default`]);
    // 'plan' is never an approval target — approving IS the exit from planning.
    expect(approvalsFor(`plan`).some((approval) => approval.mode === `plan`)).toBe(false);
});
