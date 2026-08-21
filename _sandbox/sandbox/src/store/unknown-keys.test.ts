import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ManifestProblem } from "./manifest-problems.js";
import { nearestKey, objectParse, unknownKeyProblems } from "./unknown-keys.js";

const SETTINGS = [`stableSystemPrompt`, `skills`, `hashlineEdits`, `terseOutput`, `terseHoldout`, `iqSearch`, `systemPromptMode`];

describe(`nearestKey`, () => {
    it(`names the key a one-character slip was meant to be`, () => {
        expect(nearestKey(`terseOutpt`, SETTINGS)).toBe(`terseOutput`);
        expect(nearestKey(`iqSerch`, SETTINGS)).toBe(`iqSearch`);
    });

    it(`forgives a wrong case`, () => {
        expect(nearestKey(`TerseOutput`, SETTINGS)).toBe(`terseOutput`);
    });

    it(`guesses nothing when nothing is close`, () => {
        // A key from a NEWER build looks exactly like this, and "did you mean skills?" would send someone to
        // edit a line that was never the problem.
        expect(nearestKey(`someFutureFeature`, SETTINGS)).toBeUndefined();
        expect(nearestKey(`completelyUnrelated`, SETTINGS)).toBeUndefined();
    });

    it(`will not turn one short key into a different short key`, () => {
        // Two edits out of three characters is a different word, not a typo. The budget scales with length
        // precisely so that short names are held to a stricter standard than long ones.
        expect(nearestKey(`abc`, [`xyz`])).toBeUndefined();
    });

    it(`picks the closest when several are near`, () => {
        expect(nearestKey(`terseOutpu`, [`terseOutput`, `terseHoldout`])).toBe(`terseOutput`);
    });
});

describe(`unknownKeyProblems`, () => {
    it(`reports nothing for a file using only known keys`, () => {
        expect(unknownKeyProblems({ terseOutput: true, skills: [`lsp`] }, SETTINGS)).toEqual([]);
    });

    it(`names a stray key and its likely intent`, () => {
        expect(unknownKeyProblems({ terseOutpt: true }, SETTINGS)).toEqual([{ kind: `unknownKey`, detail: `terseOutpt`, suggestion: `terseOutput` }]);
    });

    it(`omits the suggestion rather than guessing`, () => {
        expect(unknownKeyProblems({ somethingElse: 1 }, SETTINGS)).toEqual([{ kind: `unknownKey`, detail: `somethingElse` }]);
    });

    it(`says nothing about a value that is not an object at all`, () => {
        // That is a file of the wrong shape, which the schema rejects whole and json-file reports as unreadable.
        expect(unknownKeyProblems([1, 2], SETTINGS)).toEqual([]);
        expect(unknownKeyProblems(`nope`, SETTINGS)).toEqual([]);
        expect(unknownKeyProblems(null, SETTINGS)).toEqual([]);
    });
});

describe(`objectParse`, () => {
    const Schema = z.object({ terseOutput: z.boolean().default(false), skills: z.array(z.string()).default([]) });
    const run = (raw: unknown): { value: unknown; problems: ManifestProblem[] } => {
        const problems: ManifestProblem[] = [];
        const value = objectParse(Schema)(raw, (problem) => problems.push(problem));
        return { value, problems };
    };

    it(`parses a good file and reports nothing`, () => {
        const { value, problems } = run({ terseOutput: true });
        expect(value).toEqual({ terseOutput: true, skills: [] });
        expect(problems).toEqual([]);
    });

    it(`still parses a file with a typo, and reports the key it dropped`, () => {
        // The whole point: the parse must NOT get stricter. A stray key costs itself and nothing else, the
        // rest of the file keeps applying, which is also what makes a manifest from a newer build readable.
        const { value, problems } = run({ terseOutput: true, terseOutpt: false });
        expect(value).toEqual({ terseOutput: true, skills: [] });
        expect(problems).toEqual([{ kind: `unknownKey`, detail: `terseOutpt`, suggestion: `terseOutput` }]);
    });

    it(`returns undefined when the schema rejects the file outright`, () => {
        expect(run({ terseOutput: `not a boolean` }).value).toBeUndefined();
    });
});
