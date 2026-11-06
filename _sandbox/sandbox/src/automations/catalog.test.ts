import { CHORES } from "@intentic/sandbox-contract/chores";
import { CORE_AUTOMATION_TEMPLATES } from "./catalog.js";

// Pins that scheduled chore templates come from `@intentic/sandbox-contract/chores`, not hand-written here.

describe(`code chores come from the book`, () => {
    const shelf = CORE_AUTOMATION_TEMPLATES.filter((template) => template.chore === true);
    const scheduled = CHORES.flatMap((chore) => (chore.automation === undefined ? [] : [{ ...chore, automation: chore.automation }]));

    test(`every chore the book says is worth running unattended has a template`, () => {
        for (const chore of scheduled) {
            const template = shelf.find((entry) => entry.id === chore.id);
            expect(template).toMatchObject({ title: chore.title });
            expect(template?.description).toBe(chore.description);
            expect(template?.guard).toBe(chore.automation.guard);
            expect(template?.trigger).toEqual({ kind: `schedule`, cron: chore.automation.cron });
        }
    });

    // review-agent-work is an event-triggered reflex with no accumulated evidence (main's failing CI is its one fix agent's
    // to answer, ci/main-fixer.ts, so no chore wakes on one);
    // dreaming-session measures the fleet's own session history, not a repo.
    test(`the only hand-written chores are the ones the book cannot measure`, () => {
        const handWritten = shelf.filter((template) => !scheduled.some((chore) => chore.id === template.id));
        expect(handWritten.map((template) => [template.id, template.trigger.kind])).toEqual([
            [`review-agent-work`, `workspace`],
            [`dreaming-session`, `schedule`],
        ]);
    });

    // The session count is a trigger field (`afterSessions`), not a guard script; the daemon counts sessions itself and
    // hands the list to the fired turn.
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
            expect(chore.automation?.guard, chore.id).toContain(chore.automation?.report);
        }
    });

    test(`every scheduled chore triages before it acts`, () => {
        for (const chore of scheduled) {
            expect(shelf.find((entry) => entry.id === chore.id)?.prompt, chore.id).toContain(`did not decide anything`);
        }
    });

    test(`core template ids are unique, so none can shadow another`, () => {
        const ids = CORE_AUTOMATION_TEMPLATES.map((template) => template.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    test(`every shelved template carries a prompt and a trigger the one-click path can save`, () => {
        for (const template of CORE_AUTOMATION_TEMPLATES.filter((entry) => entry.offer === `create`)) {
            expect(template.prompt, template.id).not.toBe(``);
            expect([`workspace`, `schedule`], template.id).toContain(template.trigger.kind);
        }
    });
});
