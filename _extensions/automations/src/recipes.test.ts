import { CHORES } from "@intentic/sandbox-contract/chores";
import { describe, expect, test } from "vitest";
import { AUTOMATION_RECIPES } from "./recipes";

/* The seam between the two ways a chore is consumed. The Maintenance panel offers a turn against a finding you
 * can read first; an automation wakes on a clock with nobody watching. Both come from @intentic/sandbox-contract/chores, and
 * these tests exist to keep it that way — the failure this guards against is somebody adding a fourth code chore
 * here by hand, after which the panel and the nightly sweep slowly stop agreeing about what the chore is for. */

describe(`code chores come from the book`, () => {
    const shelf = AUTOMATION_RECIPES.filter((recipe) => recipe.chore === true);
    const scheduled = CHORES.filter((chore) => chore.automation !== undefined);

    test(`every chore the book says is worth running unattended has a recipe`, () => {
        for (const chore of scheduled) {
            const recipe = shelf.find((entry) => entry.id === chore.id);
            expect(recipe, chore.id).toBeDefined();
            expect(recipe?.title).toBe(chore.title);
            expect(recipe?.description).toBe(chore.description);
            expect(recipe?.guard).toBe(chore.automation?.guard);
            expect(recipe?.trigger).toEqual({ kind: `schedule`, cron: chore.automation?.cron });
        }
    });

    /* Two shelf entries stand apart from the measurement book, and neither is an oversight: they are REFLEXES,
     * not chores. Each fires on a workspace event, has no standing evidence to accumulate, and would be
     * meaningless as a row in a panel about what a codebase is owed. The split is the point — the book holds
     * chores that have a measurement, this file holds triggers. The fix chore's definition still lives in the
     * book's package (fix-deps.ts) because the daemon SEEDS it and two copies of a prompt drift; this file only
     * dresses it as a recipe for whoever deleted the seed. */
    test(`the only hand-written chores are the reflexes, with no standing evidence`, () => {
        const handWritten = shelf.filter((recipe) => !scheduled.some((chore) => chore.id === recipe.id));
        expect(handWritten.map((recipe) => recipe.id)).toEqual([`fix-dependency-breakage`, `review-agent-work`]);
        for (const reflex of handWritten) {
            expect(reflex.trigger.kind).toBe(`workspace`);
        }
    });

    test(`a scheduled chore's prompt tells the woken turn where the guard left its findings`, () => {
        for (const chore of scheduled) {
            const recipe = shelf.find((entry) => entry.id === chore.id);
            expect(recipe?.prompt, chore.id).toContain(chore.automation?.report);
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

    test(`shelf ids are unique, so no recipe can shadow another`, () => {
        const ids = AUTOMATION_RECIPES.map((recipe) => recipe.id);
        expect(new Set(ids).size).toBe(ids.length);
    });
});
