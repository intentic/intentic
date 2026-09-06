import { describe, expect, it } from "vitest";
import { shortBranch } from "./sessionChip";

describe(`shortBranch`, () => {
    it(`drops the prefix every session branch shares`, () => {
        expect(shortBranch(`agent/sharp-mesa-pj3v`)).toBe(`sharp-mesa-pj3v`);
    });

    it(`leaves a name the app generated alone — the budget is set above it on purpose`, () => {
        expect(shortBranch(`agent/wise-summit-ebeg`)).toBe(`wise-summit-ebeg`);
        expect(shortBranch(`agent/rich-otter-boe1`)).toBe(`rich-otter-boe1`);
    });

    it(`elides the MIDDLE of a name raised from an outside id, keeping both ends`, () => {
        const shown = shortBranch(`agent/ci-fix-32458072655-mt2mi4z21`);
        expect(shown).toBe(`ci-fix-324…mt2mi4z21`);
        // The head says what it is for and the tail is what makes it unique — both survive.
        expect(shown.startsWith(`ci-fix`)).toBe(true);
        expect(shown.endsWith(`mt2mi4z21`)).toBe(true);
    });

    it(`keeps two long branches that differ only at the end apart, which tail truncation would not`, () => {
        const one = shortBranch(`agent/ci-fix-32458072655-aaaaaaaaa`);
        const two = shortBranch(`agent/ci-fix-32458072655-bbbbbbbbb`);
        expect(one).not.toBe(two);
    });

    it(`never exceeds the budget once the ellipsis is counted`, () => {
        expect(shortBranch(`agent/${`x`.repeat(200)}`)).toHaveLength(20);
    });

    it(`leaves a name that does not carry the prefix untouched`, () => {
        expect(shortBranch(`main`)).toBe(`main`);
    });
});
