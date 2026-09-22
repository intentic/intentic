import { describe, test, expect } from "bun:test";
import { RuleSchema } from "./settings.js";

// A rule that saves cleanly and silently does nothing is the failure this schema exists to refuse: an action, and a
// built-in's name, are checked against the moment they are written at.

const rule = (moment: string, action: unknown) => RuleSchema.safeParse({ id: `r`, label: `r`, moment, action });

describe(`which built-in stands at which moment`, () => {
    test(`the versioner stands at the landed moment and nowhere else`, () => {
        expect(rule(`agent.landed`, { kind: `builtin`, name: `version-landed` }).success).toBe(true);
        expect(rule(`turn.ending`, { kind: `builtin`, name: `version-landed` }).success).toBe(false);
    });

    test(`the verifiers stand at the turn's end and not at the landing`, () => {
        expect(rule(`turn.ending`, { kind: `builtin`, name: `verify-edits` }).success).toBe(true);
        expect(rule(`agent.landed`, { kind: `builtin`, name: `verify-edits` }).success).toBe(false);
    });

    test(`the landed moment takes no verdict, command or instruction: the work is already in the tree`, () => {
        expect(rule(`agent.landed`, { kind: `verdict`, verdict: `allow` }).success).toBe(false);
        expect(rule(`agent.landed`, { kind: `command`, command: `pnpm test` }).success).toBe(false);
        expect(rule(`agent.landed`, { kind: `instruct`, text: `well done` }).success).toBe(false);
    });
});
