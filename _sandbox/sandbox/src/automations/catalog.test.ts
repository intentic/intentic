import { FIELD_NOTES_FILE } from "@intentic/constants";
import { CHORES } from "@intentic/sandbox-contract/chores";
import { Cron } from "croner";
import { CORE_AUTOMATION_TEMPLATES, FIELD_NOTES_AUTOMATION_ID } from "./catalog.js";

// Pins that scheduled chore templates come from `@intentic/sandbox-contract/chores`, not hand-written here.

// Asked of the scheduler the daemon actually runs (croner) rather than of the expression's text: a calendar month
// apart, not a fixed 30 days, which is the difference a "monthly" schedule is chosen for.
const monthlyShapeOf = (expression: string): { readonly day: number; readonly hour: number; readonly monthsApart: number } => {
    const cron = new Cron(expression);
    const first = cron.nextRun(new Date(Date.UTC(2026, 0, 15))) ?? new Date(0);
    const second = cron.nextRun(first) ?? new Date(0);
    return { day: first.getDate(), hour: first.getHours(), monthsApart: (second.getMonth() - first.getMonth() + 12) % 12 };
};

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

    // fix-dependency-breakage and review-agent-work are event-triggered reflexes with no accumulated evidence;
    // dreaming-session and field-notes both measure the fleet's own session history, not a repo.
    test(`the only hand-written chores are the ones the book cannot measure`, () => {
        const handWritten = shelf.filter((template) => !scheduled.some((chore) => chore.id === template.id));
        expect(handWritten.map((template) => [template.id, template.trigger.kind])).toEqual([
            [`fix-dependency-breakage`, `workspace`],
            [`review-agent-work`, `workspace`],
            [`dreaming-session`, `schedule`],
            [`field-notes`, `schedule`],
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

    // The other half of the fieldNotes setting: the switch composes the brief into every turn, this rewrites it. Monthly
    // and unguarded, because a quiet month is itself a finding and the brief going unexamined is what this prevents.
    test(`the field notes are rewritten monthly, and the prompt names the file it must write`, () => {
        const notes = shelf.find((template) => template.id === FIELD_NOTES_AUTOMATION_ID);
        expect(notes?.trigger).toEqual({ kind: `schedule`, cron: `0 4 1 * *` });
        expect(monthlyShapeOf(`0 4 1 * *`)).toEqual({ day: 1, hour: 4, monthsApart: 1 });
        expect(notes?.guard).toBeUndefined();
        expect(notes?.prompt).toContain(FIELD_NOTES_FILE);
        // The division of labour with the project map is the reason this file exists at all; losing that line from the
        // prompt is how it fills up with things a scan of the tree already says.
        expect(notes?.prompt).toContain(`belongs in the map and not in your file`);
        expect(notes?.prompt).toContain(`VERIFY EVERY FACT AGAINST THIS SANDBOX`);
        // The shape field-notes.ts reads it back by; a rewrite that loses the index sends nothing at all.
        expect(notes?.prompt).toContain(`priority`);
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
