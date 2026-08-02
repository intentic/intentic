import { describe, expect, test } from "vitest";
import { sessionCategory } from "./sessionCategory";

describe(`sessionCategory`, () => {
    test(`the naming pass's tagged titles land on their family's hue and glyph`, () => {
        expect(sessionCategory(`Extensions marketplace strategy · audit`)).toEqual({ type: `chore`, hue: 210, icon: `search` });
        expect(sessionCategory(`/agents view · redesign`)).toEqual({ type: `refactor`, hue: 280, icon: `arrows-h` });
        expect(sessionCategory(`Workflow orchestration · design`)).toEqual({ type: `feat`, hue: 130, icon: `plus` });
        expect(sessionCategory(`Sandbox freezes · fix`)).toEqual({ type: `fix`, hue: 350, icon: `wrench` });
    });

    test(`a derived title's leading verb reads the same as a tag`, () => {
        expect(sessionCategory(`Redesign the acceptance run flow`)).toEqual(sessionCategory(`Acceptance run flow · redesign`));
        expect(sessionCategory(`fix: pnpm lock`)?.icon).toBe(`wrench`);
    });

    test(`a title that reads as nothing wears no category — neutral is information, not a fallback guess`, () => {
        expect(sessionCategory(`New chat`)).toBeUndefined();
        expect(sessionCategory(`Why is the tree red?`)).toBeUndefined();
        // A tag in no verb table is the title's last noun, not an action.
        expect(sessionCategory(`Deployments Komodo · view`)).toBeUndefined();
        expect(sessionCategory(undefined)).toBeUndefined();
    });
});
