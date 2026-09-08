import { describe, expect, it } from "vitest";
import { CHORE_KINDS, CHORES } from "./chores.js";

// Pins the chore book's order, derived from `kind`: no interleaving, no chore lost, no kind mistagged.

describe(`the chore book's order`, () => {
    it(`groups the book by kind, in CHORE_KINDS order`, () => {
        const ranks = CHORES.map((chore) => CHORE_KINDS.findIndex((spec) => spec.kind === chore.kind));
        // -1 would sort to the front, outranking security silently.
        expect(ranks).not.toContain(-1);
        expect(ranks).toEqual(ranks.toSorted((left, right) => left - right));
    });

    it(`keeps every chore in the book`, () => {
        // Counted by id, not just length, so a dropped chore says which one.
        expect(new Set(CHORES.map((chore) => chore.id)).size).toBe(CHORES.length);
        expect(CHORES.length).toBe(18);
    });

    it(`says "surveying" exactly when a chore is a survey`, () => {
        // A survey has no measurement, so "due because it's been that long" is the surveying kind.
        for (const chore of CHORES) {
            expect(chore.survey === true).toBe(chore.kind === `surveying`);
        }
    });
});
