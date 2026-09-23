import { describe, expect, it } from "bun:test";
import { groupKey, selects, NO_SELECTION, type SelectionEvent, type StripSelection, stepSelection } from "./stripSelection";

// Pins every move the strip's selection makes, as values: Shift ranges from the anchor (else the active group, else
// the pressed one), Ctrl toggles and re-anchors, a plain press clears, a right-click inside the selection keeps it and
// one outside retargets it, and a mass action clears the keys but not the anchor.

const groups = [[`a`], [`b`, `b2`], [`c`], [`d`]];
const picked = (keys: string[], anchor: number | undefined): StripSelection => ({ keys, anchor });

describe(`the strip's selection`, () => {
    it.each<[string, StripSelection, SelectionEvent, StripSelection]>([
        [`ranges from the anchor`, picked([], 3), { kind: `extend`, groups, at: 1, active: 0 }, picked([`b`, `c`, `d`], 3)],
        [
            `ranges from the active group with no anchor`,
            NO_SELECTION,
            { kind: `extend`, groups, at: 3, active: 1 },
            picked([`b`, `c`, `d`], undefined),
        ],
        [`ranges over the pressed group alone with neither`, NO_SELECTION, { kind: `extend`, groups, at: 2, active: -1 }, picked([`c`], undefined)],
        [`adds a group on a toggle, anchoring there`, picked([`a`], 0), { kind: `toggle`, groups, at: 1 }, picked([`a`, `b`], 1)],
        [`drops a selected group on a toggle`, picked([`a`, `b`], 0), { kind: `toggle`, groups, at: 1 }, picked([`a`], 1)],
        [`clears on a plain press, anchoring there`, picked([`a`, `b`], 0), { kind: `activate`, at: 2 }, picked([], 2)],
        [`retargets a right-click outside the selection`, picked([`a`, `b`], 0), { kind: `retarget`, groups, at: 3 }, picked([`d`], 3)],
        [`clears the keys after a mass action, keeping the anchor`, picked([`a`, `b`], 1), { kind: `clear` }, picked([], 1)],
    ])(`%s`, (_, selection, event, next) => {
        expect(stepSelection(selection, event)).toEqual(next);
    });

    it(`keeps the selection a right-click lands inside`, () => {
        const selection = picked([`a`, `b`], 0);
        expect(stepSelection(selection, { kind: `retarget`, groups, at: 1 })).toBe(selection);
    });

    it(`keys a group by its first session, and an empty group by nothing`, () => {
        expect([groupKey([`b`, `b2`]), groupKey([])]).toEqual([`b`, ``]);
        expect([selects(picked([`b`], 0), [`b`, `b2`]), selects(picked([`b`], 0), [`b2`])]).toEqual([true, false]);
    });
});
