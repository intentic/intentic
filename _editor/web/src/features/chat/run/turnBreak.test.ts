import { TURN_BREAK_POLICIES } from "@intentic/sandbox-contract";
import { describe, it, expect } from "bun:test";
import { breakAnswers, breakLabel, effectivePolicy, sandboxPolicy } from "./turnBreak";

// One question per ending, in one vocabulary. These pin the two things every surface depends on: which answer is in
// force for a conversation, and which answers an ending may even be asked.

describe(`effectivePolicy`, () => {
    it(`lets a conversation's own answer override the sandbox's, for every ending`, () => {
        expect(effectivePolicy(`limit`, { limitPolicy: `move` }, { limitPolicy: `wait` })).toBe(`move`);
        expect(effectivePolicy(`outage`, { outagePolicy: `wait` }, { outagePolicy: `retry` })).toBe(`wait`);
        expect(effectivePolicy(`stopped`, { stopPolicy: `retry` }, { stopPolicy: `wait` })).toBe(`retry`);
    });

    it(`falls through to the sandbox's answer, and to waiting when neither has one`, () => {
        expect(effectivePolicy(`limit`, undefined, { limitPolicy: `resend` })).toBe(`resend`);
        expect(effectivePolicy(`limit`, {}, {})).toBe(`wait`);
        expect(effectivePolicy(`outage`, undefined, undefined)).toBe(`wait`);
    });

    // The distinction a three-state override exists for: the card writing the sandbox's own value CLEARS the override
    // rather than freezing a copy of a default the conversation would then quietly stop following.
    it(`reads the sandbox's answer alone, so a writer can tell an override from a match`, () => {
        expect(sandboxPolicy(`limit`, { limitPolicy: `resend` })).toBe(`resend`);
        expect(sandboxPolicy(`limit`, undefined)).toBe(`wait`);
    });
});

describe(`breakAnswers`, () => {
    // Mutually exclusive by construction: before this, four independent booleans could all be armed over the same wall.
    it(`offers exactly the answers the contract allows that ending`, () => {
        expect(breakAnswers(`outage`).map((answer) => answer.value)).toEqual([...TURN_BREAK_POLICIES.outage]);
        expect(breakAnswers(`stopped`).map((answer) => answer.value)).toEqual([...TURN_BREAK_POLICIES.stopped]);
    });

    // An answer nothing can act on is worse than one fewer: with no sibling account, there is nowhere to move to.
    it(`withholds the move until an account with room is named, and names it when there is one`, () => {
        expect(breakAnswers(`limit`).map((answer) => answer.value)).toEqual([`wait`, `resend`]);
        const withRoom = breakAnswers(`limit`, `second@b.c`);
        expect(withRoom.map((answer) => answer.value)).toEqual([...TURN_BREAK_POLICIES.limit]);
        expect(withRoom.at(-1)?.label).toContain(`second@b.c`);
    });

    it(`explains the same wait differently for the two ladders that share its name`, () => {
        const outage = breakAnswers(`outage`).find((answer) => answer.value === `retry`)?.note;
        const stopped = breakAnswers(`stopped`).find((answer) => answer.value === `retry`)?.note;
        expect(outage).not.toBe(stopped);
        expect(stopped).toContain(`three`);
    });
});

it(`names every ending, so the settings rows and the card's menu ask in the chat's words`, () => {
    expect([breakLabel(`limit`), breakLabel(`outage`), breakLabel(`stopped`)]).toEqual([
        `Usage limit spent`,
        `Provider outage`,
        `Turn stopped short`,
    ]);
});
