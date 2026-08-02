import { describe, expect, test } from "vitest";
import { categoryHue, categoryLabel } from "./categoryHue";

describe(`categoryHue`, () => {
    test(`the naming pass's tagged titles land on their family's hue`, () => {
        expect(categoryHue(`Extensions marketplace strategy · audit`)).toBe(210); // chore — investigation
        expect(categoryHue(`/agents view · redesign`)).toBe(280); // refactor — reshaping
        expect(categoryHue(`Workflow orchestration · design`)).toBe(130); // feat — new work
        expect(categoryHue(`Sandbox freezes · fix`)).toBe(350);
    });

    test(`a derived title's leading verb reads the same as a tag`, () => {
        expect(categoryHue(`Redesign the acceptance run flow`)).toBe(categoryHue(`Acceptance run flow · redesign`));
        expect(categoryHue(`fix: pnpm lock`)).toBe(350);
    });

    test(`a title that reads as nothing wears no hue — neutral is information, not a fallback guess`, () => {
        expect(categoryHue(`New chat`)).toBeUndefined();
        expect(categoryHue(`Why is the tree red?`)).toBeUndefined();
        // A tag in no verb table is the title's last noun, not an action.
        expect(categoryHue(`Deployments Komodo · view`)).toBeUndefined();
        expect(categoryHue(undefined)).toBeUndefined();
    });

    test(`the label is the legend for the tint`, () => {
        expect(categoryLabel(`Syntax highlighting · audit`)).toBe(`chore`);
        expect(categoryLabel(`New chat`)).toBeUndefined();
    });
});
