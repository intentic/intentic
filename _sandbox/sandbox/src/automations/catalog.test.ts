import { CHORES } from "@intentic/sandbox-contract/chores";
import { describe, expect, test } from "vitest";
import { CORE_AUTOMATION_TEMPLATES } from "./catalog.js";

/* THE SEAM BETWEEN THE TWO WAYS A CHORE IS CONSUMED. The Maintenance panel offers a turn against a finding you
 * can read first; an automation wakes on a clock with nobody watching. Both come from
 * @intentic/sandbox-contract/chores, and these tests exist to keep it that way: the failure they guard against
 * is somebody adding a fourth code chore here by hand, after which the panel and the nightly sweep slowly stop
 * agreeing about what the chore is for.
 *
 * They moved here with the templates themselves: the book is core data, so the templates generated from it are
 * served by the daemon rather than written into the surface that draws them. */

describe(`code chores come from the book`, () => {
    const shelf = CORE_AUTOMATION_TEMPLATES.filter((template) => template.chore === true);
    const scheduled = CHORES.filter((chore) => chore.automation !== undefined);

    test(`every chore the book says is worth running unattended has a template`, () => {
        for (const chore of scheduled) {
            const template = shelf.find((entry) => entry.id === chore.id);
            expect(template, chore.id).toBeDefined();
            expect(template?.title).toBe(chore.title);
            expect(template?.description).toBe(chore.description);
            expect(template?.guard).toBe(chore.automation?.guard);
            expect(template?.trigger).toEqual({ kind: `schedule`, cron: chore.automation?.cron });
        }
    });

    /* Two shelf entries stand apart from the measurement book, and neither is an oversight: they are REFLEXES,
     * not chores. Each fires on a workspace event, has no standing evidence to accumulate, and would be
     * meaningless as a row in a panel about what a codebase is owed. The split is the point: the book holds
     * chores that have a measurement, this file holds triggers. The fix chore's definition lives beside the
     * book in fix-deps.ts so its template metadata and prompt stay one unit; this catalogue only dresses that
     * definition for the shelf. */
    test(`the only hand-written chores are the reflexes, with no standing evidence`, () => {
        const handWritten = shelf.filter((template) => !scheduled.some((chore) => chore.id === template.id));
        expect(handWritten.map((template) => template.id)).toEqual([`fix-dependency-breakage`, `review-agent-work`]);
        for (const reflex of handWritten) {
            expect(reflex.trigger.kind).toBe(`workspace`);
        }
    });

    test(`a scheduled chore's prompt tells the woken turn where the guard left its findings`, () => {
        for (const chore of scheduled) {
            const template = shelf.find((entry) => entry.id === chore.id);
            expect(template?.prompt, chore.id).toContain(chore.automation?.report);
            // The guard has to write to the same place the prompt reads from, or the turn wakes to an empty file.
            expect(chore.automation?.guard, chore.id).toContain(chore.automation?.report);
        }
    });

    /* Every tool-driven chore says this, because the failure mode is the same for all of them: a tool reporting N
     * findings is not reporting N problems, and a chore that mechanically actions the whole list makes noisy,
     * confident, wrong changes at three in the morning. */
    test(`every scheduled chore triages before it acts`, () => {
        for (const chore of scheduled) {
            expect(shelf.find((entry) => entry.id === chore.id)?.prompt, chore.id).toContain(`did not decide anything`);
        }
    });

    test(`core template ids are unique, so none can shadow another`, () => {
        const ids = CORE_AUTOMATION_TEMPLATES.map((template) => template.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    /* A shelved template makes an automation in ONE CLICK, with no form in between, so everything the created
     * row needs has to already be on it. A `create` offer that reached the composer instead would be the
     * suggestion strip quietly turning into a second way to open the form. */
    test(`every shelved template carries a prompt and a trigger the one-click path can save`, () => {
        for (const template of CORE_AUTOMATION_TEMPLATES.filter((entry) => entry.offer === `create`)) {
            expect(template.prompt, template.id).not.toBe(``);
            expect([`workspace`, `schedule`], template.id).toContain(template.trigger.kind);
        }
    });
});
