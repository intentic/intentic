import { describe, expect, test } from "vitest";
import { toggleTaskCheckbox } from "./markdownTasks";

describe(`toggleTaskCheckbox`, () => {
    const plan = `# Plan\n\n- [ ] first\n- [x] second\n- [ ] third\n`;

    test(`ticks and unticks the box that was clicked`, () => {
        expect(toggleTaskCheckbox(plan, 0)).toBe(`# Plan\n\n- [x] first\n- [x] second\n- [ ] third\n`);
        expect(toggleTaskCheckbox(plan, 1)).toBe(`# Plan\n\n- [ ] first\n- [ ] second\n- [ ] third\n`);
        expect(toggleTaskCheckbox(plan, 2)).toBe(`# Plan\n\n- [ ] first\n- [x] second\n- [x] third\n`);
    });

    test(`counts nested and ordered task items, since the rendered list does too`, () => {
        const nested = `- [ ] top\n    - [ ] nested\n\n1. [ ] numbered\n`;
        expect(toggleTaskCheckbox(nested, 1)).toBe(`- [ ] top\n    - [x] nested\n\n1. [ ] numbered\n`);
        expect(toggleTaskCheckbox(nested, 2)).toBe(`- [ ] top\n    - [ ] nested\n\n1. [x] numbered\n`);
    });

    test(`leaves brackets that are prose alone`, () => {
        // Not a task item: no bullet in front of it, so the renderer draws no checkbox either.
        const prose = `An array literal like [ ] is not a checkbox.\n\n- [ ] but this is\n`;
        expect(toggleTaskCheckbox(prose, 0)).toBe(`An array literal like [ ] is not a checkbox.\n\n- [x] but this is\n`);
    });

    test(`says nothing rather than guessing when the box is not there`, () => {
        expect(toggleTaskCheckbox(plan, 9)).toBeUndefined();
        expect(toggleTaskCheckbox(plan, -1)).toBeUndefined();
    });
});
