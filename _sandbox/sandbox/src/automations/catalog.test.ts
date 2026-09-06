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
            expect(template).toMatchObject({ title: chore.title });
            expect(template?.description).toBe(chore.description);
            expect(template?.guard).toBe(chore.automation?.guard);
            expect(template?.trigger).toEqual({ kind: `schedule`, cron: chore.automation?.cron });
        }
    });

    /* Three shelf entries stand apart from the measurement book, and none of them is an oversight. Two are
     * REFLEXES: they fire on a workspace event, have no standing evidence to accumulate, and would be
     * meaningless as a row in a panel about what a codebase is owed. The third is the dreaming session, which
     * is not about a codebase at all — its evidence is the fleet's own history, which no probe measures and no
     * repository has, so `assess` would have nothing to read and the panel nothing to show.
     *
     * The split is the point: the book holds chores that have a measurement, this file holds the ones whose
     * trigger IS the measurement. The fix chore's definition lives beside the book in fix-deps.ts so its
     * template metadata and prompt stay one unit; this catalogue only dresses that definition for the shelf. */
    test(`the only hand-written chores are the ones the book cannot measure`, () => {
        const handWritten = shelf.filter((template) => !scheduled.some((chore) => chore.id === template.id));
        expect(handWritten.map((template) => [template.id, template.trigger.kind])).toEqual([
            [`fix-dependency-breakage`, `workspace`],
            [`review-agent-work`, `workspace`],
            [`dreaming-session`, `schedule`],
        ]);
    });

    /* The book's chores wake on a guard's findings; the dreaming session wakes on the fleet's. Its bar is a field
     * of its trigger rather than a line of shell, which is what lets the row show it and the owner move it, and
     * there is no guard for the same reason: the daemon's own count is the check, and the list it counted
     * reaches the turn as the fire's payload rather than through a file a guard would have to write. */
    test(`the dreaming session waits for sessions through its trigger, not through a guard`, () => {
        const dream = shelf.find((template) => template.id === `dreaming-session`);
        expect(dream?.trigger).toEqual({ kind: `schedule`, cron: `0 5 * * *`, afterSessions: 30 });
        expect(dream?.guard).toBeUndefined();
        expect(dream?.note).toContain(`30`);
        expect(dream?.prompt).toContain(`Under this brief is the list of sessions`);
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
