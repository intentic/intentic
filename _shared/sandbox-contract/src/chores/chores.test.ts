import { describe, expect, it } from "vitest";
import { CHORE_KINDS, CHORES } from "./chores.js";

/* THE BOOK'S ORDER, checked. The reading order used to be a paragraph of prose above a hand-sorted array, which
 * is the one kind of claim this file cannot make: English cannot be compiled, and the array it described was
 * maintained by whoever added the last chore. Now the order is derived from `kind`, and these are the three
 * things that derivation is only worth anything if they hold. */

describe(`the chore book's order`, () => {
    it(`groups the book by kind, in CHORE_KINDS order`, () => {
        const ranks = CHORES.map((chore) => CHORE_KINDS.findIndex((spec) => spec.kind === chore.kind));
        // Every chore's kind is one CHORE_KINDS names (-1 would sort it to the front and silently outrank
        // security), and no kind is interleaved with another.
        expect(ranks).not.toContain(-1);
        expect(ranks).toEqual(ranks.toSorted((left, right) => left - right));
    });

    it(`keeps every chore in the book`, () => {
        // The sort cannot drop an entry, but a future refactor to a filter-into-groups could, so the count is
        // pinned to the ids rather than to a number, which says which one went missing.
        expect(new Set(CHORES.map((chore) => chore.id)).size).toBe(CHORES.length);
        expect(CHORES.length).toBe(18);
    });

    it(`says "surveying" exactly when a chore is a survey`, () => {
        // The two are the same claim: a survey has no measurement, so "due because it has been that long" IS the
        // surveying kind. Checked in both directions, because either half drifting makes the grouping a lie.
        for (const chore of CHORES) {
            expect(chore.survey === true).toBe(chore.kind === `surveying`);
        }
    });
});
